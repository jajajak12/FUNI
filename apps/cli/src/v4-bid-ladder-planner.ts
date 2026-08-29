import type { Address, Hex } from 'viem';
import { amountsForLiquidity, buildGenericV4SingleSidedPlanAtTicks, classifyV4RangeState, V4_MAX_TICK, V4_MIN_TICK, type V4MintPlan, type V4PoolState, v4ExecutionBlockers } from '@funi/v4';
import type { V4BidLadderPersistencePlan } from '@funi/ledger';

export const V4_BID_LADDER_V1 = 'V4_BID_LADDER_V1' as const;
export const V4_BID_LADDER_NORMALIZED_BOUNDARIES_BPS = Object.freeze([100, 500, 1200, 2200, 3500, 5000] as const);
export const V4_BID_LADDER_WEIGHTS_BPS = Object.freeze([800, 1200, 1800, 2500, 3700] as const);
export const V4_BID_LADDER_SLICES = Object.freeze([
  { upperDropBps: 100, lowerDropBps: 500, weightBps: 800 },
  { upperDropBps: 500, lowerDropBps: 1200, weightBps: 1200 },
  { upperDropBps: 1200, lowerDropBps: 2200, weightBps: 1800 },
  { upperDropBps: 2200, lowerDropBps: 3500, weightBps: 2500 },
  { upperDropBps: 3500, lowerDropBps: 5000, weightBps: 3700 },
] as const);
export const V4_BID_LADDER_WEIGHT_TOTAL_BPS = 10_000n;

export type V4BidLadderPlanInput = {
  ladderId: string;
  pool: V4PoolState;
  fundingToken: Address;
  targetToken: Address;
  totalFundingAmount: bigint;
  fundingDecimals: number;
  targetDecimals: number;
  owner: Address;
  deadline: bigint;
  referenceBlockHash?: Hex;
  entryUsdSnapshot?: number;
  nowMs?: number;
  maxDownsideBps?: number;
};

type V4BidLadderSingleSidedMint = V4MintPlan & {
  targetIndex: 0|1;
  fundingIndex: 0|1;
  amount0Expected: bigint;
  amount1Expected: bigint;
};

export type V4BidLadderLegPlan = {
  index: 0|1|2|3|4;
  identity: string;
  upperDropBps: number;
  lowerDropBps: number;
  weightBps: number;
  tickLower: number;
  tickUpper: number;
  fundingAmount: bigint;
  fundingAmountRequired: bigint;
  fundingIndex: 0|1;
  targetIndex: 0|1;
  mint: V4BidLadderSingleSidedMint;
};

export type V4BidLadderPlan = {
  ladderId: string;
  strategyVersion: typeof V4_BID_LADDER_V1;
  executionMode: 'DRY_RUN';
  pool: V4PoolState;
  fundingToken: Address;
  targetToken: Address;
  fundingDecimals: number;
  targetDecimals: number;
  fundingIndex: 0|1;
  targetIndex: 0|1;
  referenceTick: number;
  referenceBlock: bigint;
  referenceBlockHash?: Hex;
  totalFundingAmount: bigint;
  entryUsdSnapshot?: number;
  createdAtMs: number;
  maxDownsideBps: number;
  legs: readonly V4BidLadderLegPlan[];
};

/** Floor-scaled integer BPS boundaries; the terminal boundary is exactly M. */
export function v4BidLadderSlices(maxDownsideBps=5000) {
  if (!Number.isSafeInteger(maxDownsideBps) || maxDownsideBps <= 0 || maxDownsideBps >= 10_000) throw new Error('V4_BID_LADDER_MAX_DOWNSIDE_INVALID');
  const boundaries = V4_BID_LADDER_NORMALIZED_BOUNDARIES_BPS.map((value, index) => index === V4_BID_LADDER_NORMALIZED_BOUNDARIES_BPS.length - 1 ? maxDownsideBps : Math.floor(value * maxDownsideBps / 5000));
  if (boundaries.some((value, index) => value <= 0 || (index > 0 && value <= boundaries[index - 1]!))) throw new Error('V4_BID_LADDER_SCALED_BOUNDARY_COLLAPSE');
  return V4_BID_LADDER_WEIGHTS_BPS.map((weightBps, index) => ({ upperDropBps: boundaries[index]!, lowerDropBps: boundaries[index + 1]!, weightBps }));
}

export type V4BidLadderGeometry = {
  representable: boolean;
  reason?: 'V4_BID_LADDER_DEPTH_NOT_REPRESENTABLE';
  maxDownsideBps: number;
  targetIndex: 0|1;
  fundingIndex: 0|1;
  desiredBps: readonly number[];
  rawTicks: readonly number[];
  desiredSnappedTicks: readonly number[];
  capTick: number;
  boundaries?: readonly number[];
  effectiveMaxDownsideBps?: number;
};

const alignedFloor = (tick: number, spacing: number) => Math.floor(tick / spacing) * spacing;
const alignedCeil = (tick: number, spacing: number) => Math.ceil(tick / spacing) * spacing;
const clamp = (value: number, lower: number, upper: number) => Math.max(lower, Math.min(upper, value));

/**
 * Resolves the percentage target ladder onto the pool's executable tick grid.
 * The terminal boundary is snapped inward, so the effective downside never
 * exceeds the operator-selected maximum. Inner boundaries are then projected
 * locally onto the nearest ordered, one-spacing-apart sequence.
 */
export function v4BidLadderGeometry(input: Pick<V4BidLadderPlanInput, 'pool'|'fundingToken'|'targetToken'|'maxDownsideBps'>): V4BidLadderGeometry {
  const { pool, fundingToken, targetToken } = input;
  const spacing = pool.key.tickSpacing;
  const targetIs0 = targetToken.toLowerCase() === pool.key.currency0.toLowerCase();
  const targetIs1 = targetToken.toLowerCase() === pool.key.currency1.toLowerCase();
  const fundingIs0 = fundingToken.toLowerCase() === pool.key.currency0.toLowerCase();
  const fundingIs1 = fundingToken.toLowerCase() === pool.key.currency1.toLowerCase();
  if (!Number.isSafeInteger(spacing) || spacing <= 0 || (!targetIs0 && !targetIs1) || (!fundingIs0 && !fundingIs1) || targetIs0 === fundingIs0) throw new Error('V4_BID_LADDER_ORIENTATION_INVALID');
  const targetIndex: 0|1 = targetIs0 ? 0 : 1;
  const fundingIndex: 0|1 = fundingIs0 ? 0 : 1;
  const slices = v4BidLadderSlices(input.maxDownsideBps);
  const desiredBps = [slices[0]!.upperDropBps, ...slices.map(slice => slice.lowerDropBps)];
  const direction = targetIndex === 0 ? -1 : 1;
  const rawTicks = desiredBps.map(bps => pool.tick + (targetIndex === 0 ? 1 : -1) * Math.log(1 - bps / 10_000) / Math.log(1.0001));
  const desiredSnappedTicks = rawTicks.map(tick => targetIndex === 0 ? alignedFloor(tick, spacing) : alignedCeil(tick, spacing));
  // Inward terminal snap is the hard selected-depth cap. A floor for a
  // decreasing ladder or ceil for an increasing ladder could deepen it.
  const capTick = targetIndex === 0 ? alignedCeil(rawTicks[5]!, spacing) : alignedFloor(rawTicks[5]!, spacing);
  const base = desiredSnappedTicks[0]!;
  const maxDownsideBps = desiredBps[5]!;
  const incompatible = (): V4BidLadderGeometry => ({ representable: false, reason: 'V4_BID_LADDER_DEPTH_NOT_REPRESENTABLE', maxDownsideBps, targetIndex, fundingIndex, desiredBps, rawTicks, desiredSnappedTicks, capTick });
  if (!Number.isInteger(base) || !Number.isInteger(capTick) || base <= V4_MIN_TICK || base > V4_MAX_TICK || capTick <= V4_MIN_TICK || capTick > V4_MAX_TICK) return incompatible();
  const boundaries = [base];
  for (let index = 1; index < 5; index++) {
    const lower = targetIndex === 0 ? capTick + (5 - index) * spacing : boundaries[index - 1]! + spacing;
    const upper = targetIndex === 0 ? boundaries[index - 1]! - spacing : capTick - (5 - index) * spacing;
    if (lower > upper) return incompatible();
    boundaries.push(clamp(desiredSnappedTicks[index]!, lower, upper));
  }
  boundaries.push(capTick);
  const ordered = boundaries.every((tick, index) => index === 0 || (targetIndex === 0 ? tick <= boundaries[index - 1]! - spacing : tick >= boundaries[index - 1]! + spacing));
  const inBounds = boundaries.every(tick => Number.isInteger(tick) && tick % spacing === 0 && tick > V4_MIN_TICK && tick <= V4_MAX_TICK);
  const effectiveMaxDownsideBps = (1 - Math.pow(1.0001, targetIndex === 0 ? capTick - pool.tick : pool.tick - capTick)) * 10_000;
  if (!ordered || !inBounds || effectiveMaxDownsideBps > maxDownsideBps + 1e-7) return incompatible();
  return { representable: true, maxDownsideBps, targetIndex, fundingIndex, desiredBps, rawTicks, desiredSnappedTicks, capTick, boundaries, effectiveMaxDownsideBps };
}

export function v4BidLadderPersistencePlan(plan: V4BidLadderPlan): V4BidLadderPersistencePlan {
  return {
    ladderId: plan.ladderId, strategyVersion: plan.strategyVersion, executionMode: plan.executionMode,
    pool: { id: plan.pool.id, key: plan.pool.key, tick: plan.referenceTick, blockNumber: plan.referenceBlock },
    fundingToken: plan.fundingToken, targetToken: plan.targetToken, fundingIndex: plan.fundingIndex, targetIndex: plan.targetIndex,
    referenceBlockHash: plan.referenceBlockHash, totalFundingAmount: plan.totalFundingAmount, entryUsdSnapshot: plan.entryUsdSnapshot, createdAtMs: plan.createdAtMs,
    legs: plan.legs.map(leg => ({ legIndex: leg.index, upperDropBps: leg.upperDropBps, lowerDropBps: leg.lowerDropBps, weightBps: leg.weightBps, tickLower: leg.tickLower, tickUpper: leg.tickUpper, fundingAmount: leg.fundingAmount, plannedLiquidity: leg.mint.liquidity, fundingIndex: leg.fundingIndex, targetIndex: leg.targetIndex })),
  };
}

const assertPlanInput = (input: V4BidLadderPlanInput) => {
  if (!input.ladderId.trim()) throw new Error('V4_BID_LADDER_ID_REQUIRED');
  if (input.totalFundingAmount <= 0n) throw new Error('V4_BID_LADDER_FUNDING_INVALID');
  if (!Number.isInteger(input.fundingDecimals) || input.fundingDecimals < 0 || !Number.isInteger(input.targetDecimals) || input.targetDecimals < 0) throw new Error('V4_BID_LADDER_DECIMALS_INVALID');
  if (!Number.isSafeInteger(input.nowMs ?? Date.now()) || (input.nowMs ?? Date.now()) < 0) throw new Error('V4_BID_LADDER_CLOCK_INVALID');
  if (input.entryUsdSnapshot !== undefined && (!Number.isFinite(input.entryUsdSnapshot) || input.entryUsdSnapshot < 0)) throw new Error('V4_BID_LADDER_ENTRY_USD_INVALID');
  const blockers = v4ExecutionBlockers(input.pool);
  if (blockers.length) throw new Error(`V4_BID_LADDER_POOL_BLOCKED:${blockers.join(',')}`);
  if (!input.pool.initialized || input.pool.liquidity <= 0n || input.pool.blockNumber < 0n) throw new Error('V4_BID_LADDER_REFERENCE_STATE_INVALID');
};

export function splitV4BidLadderFunding(totalFundingAmount: bigint): readonly bigint[] {
  if (totalFundingAmount <= 0n) throw new Error('V4_BID_LADDER_FUNDING_INVALID');
  const first = V4_BID_LADDER_SLICES.slice(0, 4).map(slice => totalFundingAmount * BigInt(slice.weightBps) / V4_BID_LADDER_WEIGHT_TOTAL_BPS);
  const final = totalFundingAmount - first.reduce((sum, amount) => sum + amount, 0n);
  const amounts = [...first, final];
  if (amounts.some(amount => amount <= 0n)) throw new Error('V4_BID_LADDER_CAPITAL_TOO_SMALL');
  return amounts;
}

const expectedFunding = (mint: V4MintPlan, fundingIndex: 0|1) => fundingIndex === 0 ? mint.amount0Max : mint.amount1Max;

/** Pure V1 planner. It creates no intents, journal rows, signatures, or RPC calls. */
export function planV4BidLadderV1(input: V4BidLadderPlanInput): V4BidLadderPlan {
  assertPlanInput(input);
  const slices = v4BidLadderSlices(input.maxDownsideBps);
  const geometry = v4BidLadderGeometry(input);
  if (!geometry.representable || !geometry.boundaries) throw new Error('V4_BID_LADDER_DEPTH_NOT_REPRESENTABLE');
  const boundaries = geometry.boundaries;
  if (slices.reduce((sum, slice) => sum + slice.weightBps, 0) !== Number(V4_BID_LADDER_WEIGHT_TOTAL_BPS)) throw new Error('V4_BID_LADDER_WEIGHT_INVARIANT');
  const amounts = splitV4BidLadderFunding(input.totalFundingAmount);
  const legs = slices.map((slice, ordinal) => {
    const tickLower = geometry.targetIndex === 0 ? boundaries[ordinal + 1]! : boundaries[ordinal]!;
    const tickUpper = geometry.targetIndex === 0 ? boundaries[ordinal]! : boundaries[ordinal + 1]!;
    const mint = buildGenericV4SingleSidedPlanAtTicks({
      pool: input.pool,
      target: input.targetToken,
      funding: input.fundingToken,
      fundingAmount: amounts[ordinal]!,
      owner: input.owner,
      deadline: input.deadline,
      range: { upperDropPct: slice.upperDropBps / 100, lowerDropPct: slice.lowerDropBps / 100 },
      tickLower,
      tickUpper,
    });
    const targetAmount = mint.targetIndex === 0 ? mint.amount0Expected : mint.amount1Expected;
    if (targetAmount !== 0n || expectedFunding(mint, mint.fundingIndex) <= 0n || mint.tickLower >= mint.tickUpper) throw new Error('V4_BID_LADDER_NOT_STRICTLY_ONE_SIDED');
    return {
      index: ordinal as 0|1|2|3|4,
      identity: `${input.ladderId}:${ordinal}:${slice.upperDropBps}:${slice.lowerDropBps}:${mint.tickLower}:${mint.tickUpper}`,
      upperDropBps: slice.upperDropBps,
      lowerDropBps: slice.lowerDropBps,
      weightBps: slice.weightBps,
      tickLower: mint.tickLower,
      tickUpper: mint.tickUpper,
      fundingAmount: amounts[ordinal]!,
      fundingAmountRequired: expectedFunding(mint, mint.fundingIndex),
      fundingIndex: mint.fundingIndex,
      targetIndex: mint.targetIndex,
      mint,
    };
  });
  const first = legs[0]!;
  if (legs.some(leg => leg.fundingIndex !== first.fundingIndex || leg.targetIndex !== first.targetIndex || leg.tickLower % input.pool.key.tickSpacing !== 0 || leg.tickUpper % input.pool.key.tickSpacing !== 0)) throw new Error('V4_BID_LADDER_ORIENTATION_OR_SPACING_INVALID');
  for (let index = 0; index < legs.length - 1; index++) {
    const near = legs[index]!, deep = legs[index + 1]!;
    const contiguous = first.targetIndex === 0 ? near.tickLower === deep.tickUpper : near.tickUpper === deep.tickLower;
    if (!contiguous) throw new Error('V4_BID_LADDER_TICK_ROUNDING_GAP_OR_OVERLAP');
  }
  if (legs.reduce((sum, leg) => sum + leg.fundingAmount, 0n) !== input.totalFundingAmount) throw new Error('V4_BID_LADDER_FUNDING_CONSERVATION_FAILED');
  return {
    ladderId: input.ladderId,
    strategyVersion: V4_BID_LADDER_V1,
    executionMode: 'DRY_RUN',
    pool: input.pool,
    fundingToken: input.fundingToken,
    targetToken: input.targetToken,
    fundingDecimals: input.fundingDecimals,
    targetDecimals: input.targetDecimals,
    fundingIndex: first.fundingIndex,
    targetIndex: first.targetIndex,
    referenceTick: input.pool.tick,
    referenceBlock: input.pool.blockNumber,
    referenceBlockHash: input.referenceBlockHash,
    totalFundingAmount: input.totalFundingAmount,
    entryUsdSnapshot: input.entryUsdSnapshot,
    createdAtMs: input.nowMs ?? Date.now(),
    maxDownsideBps: slices[4]!.lowerDropBps,
    legs,
  };
}

export type V4BidLadderPriceEvidence = { fundingUsdPerToken: number; targetUsdPerToken: number };
export type V4BidLadderEvaluation = {
  feeAccountingMode: 'NOT_MODELED_PHASE1';
  pnlMode: 'PRINCIPAL_INVENTORY_ONLY_NOT_PNL';
  legs: readonly { index: number; rangeState: 'ABOVE_RANGE'|'IN_RANGE'|'BELOW_RANGE'; token0Amount: bigint; token1Amount: bigint; fundingAmount: bigint; targetAmount: bigint; fundingConvertedBps: bigint|null }[];
  totalFundingInitiallyAllocated: bigint;
  aggregateFundingTokenAmount: bigint;
  aggregateTargetTokenAmount: bigint;
  rangeCounts: { above: number; in: number; below: number };
  principalConversionProgressBps: bigint|null;
  navUsd: number|null;
};

export function evaluateV4BidLadderV1(plan: V4BidLadderPlan, currentPoolState: Pick<V4PoolState, 'sqrtPriceX96'|'tick'>, priceEvidence?: V4BidLadderPriceEvidence): V4BidLadderEvaluation {
  const legs = plan.legs.map(leg => {
    const amounts = amountsForLiquidity(currentPoolState.sqrtPriceX96, leg.tickLower, leg.tickUpper, leg.mint.liquidity);
    const rawState = classifyV4RangeState(currentPoolState.tick, leg.tickLower, leg.tickUpper);
    const rangeState:V4BidLadderEvaluation['legs'][number]['rangeState'] = rawState === 'above_range' ? 'ABOVE_RANGE' : rawState === 'in_range' ? 'IN_RANGE' : 'BELOW_RANGE';
    const fundingAmount = leg.fundingIndex === 0 ? amounts.token0 : amounts.token1;
    const targetAmount = leg.targetIndex === 0 ? amounts.token0 : amounts.token1;
    const converted = fundingAmount <= leg.fundingAmountRequired ? (leg.fundingAmountRequired - fundingAmount) * V4_BID_LADDER_WEIGHT_TOTAL_BPS / leg.fundingAmountRequired : null;
    return { index: leg.index, rangeState, token0Amount: amounts.token0, token1Amount: amounts.token1, fundingAmount, targetAmount, fundingConvertedBps: converted };
  });
  const aggregateFundingTokenAmount = legs.reduce((sum, leg) => sum + leg.fundingAmount, 0n);
  const aggregateTargetTokenAmount = legs.reduce((sum, leg) => sum + leg.targetAmount, 0n);
  const rangeCounts = legs.reduce((counts, leg) => ({ ...counts, [leg.rangeState === 'ABOVE_RANGE' ? 'above' : leg.rangeState === 'IN_RANGE' ? 'in' : 'below']: counts[leg.rangeState === 'ABOVE_RANGE' ? 'above' : leg.rangeState === 'IN_RANGE' ? 'in' : 'below'] + 1 }), { above: 0, in: 0, below: 0 });
  const principalConversionProgressBps = legs.every(leg => leg.fundingConvertedBps !== null) ? legs.reduce((sum, leg) => sum + BigInt(plan.legs[leg.index]!.weightBps) * leg.fundingConvertedBps! / V4_BID_LADDER_WEIGHT_TOTAL_BPS, 0n) : null;
  const validPrices = priceEvidence && Number.isFinite(priceEvidence.fundingUsdPerToken) && priceEvidence.fundingUsdPerToken >= 0 && Number.isFinite(priceEvidence.targetUsdPerToken) && priceEvidence.targetUsdPerToken >= 0;
  const navUsd = validPrices ? Number(aggregateFundingTokenAmount) / 10 ** plan.fundingDecimals * priceEvidence!.fundingUsdPerToken + Number(aggregateTargetTokenAmount) / 10 ** plan.targetDecimals * priceEvidence!.targetUsdPerToken : null;
  return { feeAccountingMode: 'NOT_MODELED_PHASE1', pnlMode: 'PRINCIPAL_INVENTORY_ONLY_NOT_PNL', legs, totalFundingInitiallyAllocated: plan.totalFundingAmount, aggregateFundingTokenAmount, aggregateTargetTokenAmount, rangeCounts, principalConversionProgressBps, navUsd };
}
