import { createHash, randomUUID } from "node:crypto";
import {
  getAddress,
  parseAbiItem,
  type Address,
  type Hex,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { erc20Abi, inspectErc20, priceFromSqrtX96, robinhoodMainnet, type FallbackRpc } from "@funi/core";
import {
  amountsForLiquidity,
  decodeV4BatchFullDecrease,
  inspectV4ClaimableFeesBatch,
  inspectV4Pool,
  inspectV4Position,
  poolId,
  reconcileV4BatchFullDecreaseReceipt,
  v4ExecutionBlockers,
  V4_ROBINHOOD_DEPLOYMENTS,
  type V4PoolKey,
  type V4PoolState,
} from "@funi/v4";
import {
  type SqliteLedgerRepository,
  type V4BidLadderUsdResetPhase,
} from "@funi/ledger";
import {
  createV4BidLadderLive,
  estimateV4BidLadderMarketCapRange,
  previewV4BidLadder,
  type BidLadderToken,
  type V4BidLadderMarketCapEvidence,
} from "./v4-bid-ladder-operator.js";
import { orientPoolPriceFundingPerTarget } from "./lp-entry-price-guard.js";
import {
  executeV4BidLadderLiveOpen,
  executeV4BidLadderManualClose,
  v4BidLadderFundingAllowanceReadiness,
  type LadderLiveContext,
} from "./v4-bid-ladder-live.js";
import { convergeTerminalV4BidLadder } from "./v4-bid-ladder-terminal-convergence.js";

const CHAIN_ID = 4663;
export const V4_REPOSITION_MAX_JIT_REMATERIALIZATIONS = 3;
const same = (a: unknown, b: unknown) =>
  String(a).toLowerCase() === String(b).toLowerCase();
export function sameV4PoolKey(a: V4PoolKey, b: V4PoolKey) {
  return (
    same(a.currency0, b.currency0) &&
    same(a.currency1, b.currency1) &&
    a.fee === b.fee &&
    a.tickSpacing === b.tickSpacing &&
    same(a.hooks, b.hooks)
  );
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isV4PoolKey = (value: unknown): value is V4PoolKey =>
  isRecord(value) &&
  typeof value.currency0 === "string" &&
  typeof value.currency1 === "string" &&
  Number.isInteger(value.fee) &&
  Number.isInteger(value.tickSpacing) &&
  typeof value.hooks === "string";
export function validateV4BidLadderRepositionPreviewEvidence(input: {
  evidence: unknown;
  parent: Record<string, unknown>;
  legs: Record<string, unknown>[];
  nowMs?: number;
}) {
  if (!isRecord(input.evidence)) return false;
  const evidence = input.evidence;
  if (
    typeof evidence.block !== "string" ||
    typeof evidence.timestamp_ms !== "number" ||
    !Number.isFinite(evidence.timestamp_ms) ||
    typeof evidence.revision !== "number" ||
    !isV4PoolKey(evidence.pool_key) ||
    !Array.isArray(evidence.token_ids) ||
    typeof evidence.fingerprint !== "string"
  )
    return false;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        block: evidence.block,
        timestamp_ms: evidence.timestamp_ms,
        revision: evidence.revision,
        pool_key: evidence.pool_key,
        token_ids: evidence.token_ids,
      }),
    )
    .digest("hex");
  const parentPoolKey: V4PoolKey = {
    currency0: String(input.parent.currency0) as Address,
    currency1: String(input.parent.currency1) as Address,
    fee: Number(input.parent.fee),
    tickSpacing: Number(input.parent.tick_spacing),
    hooks: String(input.parent.hooks) as Address,
  };
  return (
    fingerprint === evidence.fingerprint &&
    evidence.revision === Number(input.parent.revision) &&
    (input.nowMs ?? Date.now()) - evidence.timestamp_ms <= 120_000 &&
    evidence.token_ids.length === 5 &&
    evidence.token_ids.every(
      (id, index) =>
        typeof id === "string" && id === String(input.legs[index]?.token_id),
    ) &&
    sameV4PoolKey(evidence.pool_key, parentPoolKey)
  );
}
const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
);
const receiptJson = (value: unknown) =>
  JSON.parse(String(value), (key, item) =>
    [
      "blockNumber",
      "cumulativeGasUsed",
      "effectiveGasPrice",
      "gasUsed",
      "blobGasPrice",
      "blobGasUsed",
    ].includes(key) && typeof item === "string"
      ? BigInt(item)
      : item,
  ) as TransactionReceipt;
const manualAuthorization = (value: unknown): value is string =>
  typeof value === "string" &&
  /^manual-reposition:[^:]+:[0-9a-f-]{36}$/i.test(value);

export type V4BidLadderParentStatus = "PLANNED" | "OPEN" | "CLOSED" | "CANCELLED";

export const V4_BID_LADDER_USDG_RESET_PARENT_STATUS_MATRIX = Object.freeze({
  OPEN_PENDING: ["PLANNED", "OPEN"],
  WATCHING: ["OPEN"],
  CLOSE_PREPARED: ["OPEN"],
  CLOSE_SUBMITTED: ["OPEN", "CLOSED"],
  CLOSE_CONFIRMED: ["CLOSED"],
  PRINCIPAL_RECONCILED: ["CLOSED"],
  REOPEN_PLANNED: ["CLOSED"],
  REOPEN_PREPARED: ["CLOSED"],
  REOPEN_SUBMITTED: ["CLOSED"],
  COMPLETED: ["CLOSED"],
  BLOCKED: ["PLANNED", "OPEN", "CLOSED", "CANCELLED"],
  OPERATOR_CLOSED: ["CLOSED"],
} satisfies Record<V4BidLadderUsdResetPhase, readonly V4BidLadderParentStatus[]>);

export function v4BidLadderUsdResetParentStatePolicy(
  phase: V4BidLadderUsdResetPhase,
  parentStatus: string,
) {
  const allowedParentStatuses = V4_BID_LADDER_USDG_RESET_PARENT_STATUS_MATRIX[phase];
  return {
    phase,
    parentStatus,
    allowedParentStatuses,
    valid: (allowedParentStatuses as readonly string[]).includes(parentStatus),
  };
}

export type V4BidLadderResetLegTruth = {
  tokenId: bigint;
  owner: Address;
  poolId: Hex;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  principal: { token0: bigint; token1: bigint };
  fees: { token0: bigint; token1: bigint };
  blockNumber: bigint;
};

export function evaluateV4BidLadderUsdResetEligibility(input: {
  wallet: Address;
  expectedPoolId: string;
  fundingIndex: 0 | 1;
  targetIndex: 0 | 1;
  expectedLegs: readonly {
    tokenId: bigint;
    tickLower: number;
    tickUpper: number;
  }[];
  legs: readonly V4BidLadderResetLegTruth[];
  unresolvedTransactions: number;
  nonceAmbiguous: boolean;
}) {
  const blockers: string[] = [],
    block = input.legs[0]?.blockNumber;
  if (input.expectedLegs.length !== 5 || input.legs.length !== 5)
    blockers.push("REPOSITION_LEG_SET_INVALID");
  if (input.unresolvedTransactions)
    blockers.push("REPOSITION_UNRESOLVED_TRANSACTION");
  if (input.nonceAmbiguous) blockers.push("REPOSITION_NONCE_AMBIGUOUS");
  for (let index = 0; index < Math.min(5, input.legs.length); index++) {
    const expected = input.expectedLegs[index]!,
      leg = input.legs[index]!,
      funding = input.fundingIndex === 0 ? leg.principal.token0 : leg.principal.token1,
      target = input.targetIndex === 0 ? leg.principal.token0 : leg.principal.token1;
    if (
      leg.tokenId !== expected.tokenId ||
      !same(leg.owner, input.wallet) ||
      !same(leg.poolId, input.expectedPoolId) ||
      leg.tickLower !== expected.tickLower ||
      leg.tickUpper !== expected.tickUpper
    )
      blockers.push(`REPOSITION_LEG_IDENTITY_MISMATCH:${index}`);
    if (leg.blockNumber !== block)
      blockers.push("REPOSITION_STATE_NOT_COHERENT");
    if (leg.liquidity <= 0n)
      blockers.push(`REPOSITION_LIQUIDITY_NOT_POSITIVE:${index}`);
    if (target !== 0n)
      blockers.push(`REPOSITION_TARGET_PRINCIPAL_NONZERO:${index}`);
    if (funding <= 0n)
      blockers.push(`REPOSITION_USDG_PRINCIPAL_NOT_POSITIVE:${index}`);
  }
  return {
    eligible: blockers.length === 0,
    blockers: [...new Set(blockers)],
    blockNumber: block,
    usdgPrincipal: input.legs.reduce(
      (sum, leg) =>
        sum +
        (input.fundingIndex === 0 ? leg.principal.token0 : leg.principal.token1),
      0n,
    ),
    targetPrincipal: input.legs.reduce(
      (sum, leg) =>
        sum +
        (input.targetIndex === 0 ? leg.principal.token0 : leg.principal.token1),
      0n,
    ),
  };
}

export function classifyV4BidLadderUsdResetOutputs(input: {
  principal: { token0: bigint; token1: bigint };
  transfers: { token0: bigint; token1: bigint };
  fundingIndex: 0 | 1;
  targetIndex: 0 | 1;
}) {
  if (
    input.transfers.token0 < input.principal.token0 ||
    input.transfers.token1 < input.principal.token1
  )
    throw new Error("REPOSITION_PRINCIPAL_EXCEEDS_RECEIPT_TRANSFER");
  const fees = {
      token0: input.transfers.token0 - input.principal.token0,
      token1: input.transfers.token1 - input.principal.token1,
    },
    values = {
      returnedUsdgPrincipal:
        input.fundingIndex === 0
          ? input.principal.token0
          : input.principal.token1,
      returnedTargetPrincipal:
        input.targetIndex === 0
          ? input.principal.token0
          : input.principal.token1,
      returnedUsdgFee:
        input.fundingIndex === 0 ? fees.token0 : fees.token1,
      returnedTargetFee:
        input.targetIndex === 0 ? fees.token0 : fees.token1,
    };
  return { ...values, principal: input.principal, fees, transfers: input.transfers };
}

function ladderRows(repo: SqliteLedgerRepository, ladderId: string) {
  const parent = repo.loadBidLadder(ladderId),
    legs = repo.listBidLadderLegs(ladderId);
  if (!parent) throw new Error("V4_BID_LADDER_NOT_FOUND");
  if (legs.length !== 5 || legs.some((leg, index) => Number(leg.leg_index) !== index))
    throw new Error("REPOSITION_LEG_SET_INVALID");
  const key: V4PoolKey = {
    currency0: getAddress(String(parent.currency0)),
    currency1: getAddress(String(parent.currency1)),
    fee: Number(parent.fee),
    tickSpacing: Number(parent.tick_spacing),
    hooks: getAddress(String(parent.hooks)),
  };
  if (!same(poolId(key), parent.pool_id))
    throw new Error("REPOSITION_POOL_IDENTITY_MISMATCH");
  if (!same(parent.funding_token, robinhoodMainnet.assets.USDG))
    throw new Error("REPOSITION_FUNDING_NOT_USDG");
  return { parent, legs, key };
}

async function nonceTruth(
  repo: SqliteLedgerRepository,
  rpc: FallbackRpc,
  wallet: Address,
  nowMs: number,
) {
  const [latest, pending] = await rpc.withClient((client) =>
      Promise.all([
        client.getTransactionCount({ address: wallet, blockTag: "latest" }),
        client.getTransactionCount({ address: wallet, blockTag: "pending" }),
      ]),
    ),
    unresolved = Number(
      (
        repo.db
          .prepare(
            "SELECT COUNT(*) count FROM chain_transaction_journal WHERE chain_id=? AND lower(wallet_address)=? AND status IN ('PREPARED','SUBMITTED')",
          )
          .get(CHAIN_ID, wallet.toLowerCase()) as { count: number }
      ).count,
    ),
    mutex = Boolean(
      repo.db
        .prepare(
          "SELECT 1 FROM chain_nonce_mutex WHERE chain_id=? AND lower(wallet_address)=? AND expires_at>?",
        )
        .get(CHAIN_ID, wallet.toLowerCase(), new Date(nowMs).toISOString()),
    );
  return {
    latest,
    pending,
    unresolved,
    mutex,
    ambiguous: latest !== pending || unresolved > 0 || mutex,
  };
}

export async function readV4BidLadderUsdResetTruth(input: {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  ladderId: string;
  wallet: Address;
  nowMs?: number;
}) {
  const state = ladderRows(input.repo, input.ladderId);
  if (String(state.parent.status) !== "OPEN" || state.legs.some((leg) => String(leg.status) !== "OPEN" || !leg.token_id))
    throw new Error("REPOSITION_LADDER_NOT_OPEN");
  const expected = state.legs.map((leg) => ({
      tokenId: BigInt(String(leg.token_id)),
      tickLower: Number(leg.tick_lower),
      tickUpper: Number(leg.tick_upper),
    })),
    positions = await Promise.all(expected.map((leg) => inspectV4Position(input.rpc, leg.tokenId)));
  const registry=input.repo.v4RegistryPool(String(state.parent.pool_id)),observedAt=registry?.last_refreshed_at?Date.parse(String(registry.last_refreshed_at)):0,cacheStale=!observedAt||(input.nowMs??Date.now())-observedAt>120_000,rpcStartedAtMs=Date.now();
  if(cacheStale)input.repo.recordLatency('v4_bid_ladder_reposition_pool_refresh_requested',0,{cacheAgeMs:observedAt?Math.max(0,(input.nowMs??Date.now())-observedAt):undefined,context:{ladderId:input.ladderId,poolId:String(state.parent.pool_id),reason:'REPOSITION_ON_DEMAND_POOL_FRESHNESS',rpcStartedAtMs}});
  let fees:Awaited<ReturnType<typeof inspectV4ClaimableFeesBatch>>;
  try{fees=await inspectV4ClaimableFeesBatch(
      input.rpc, positions.map((position) => ({
        tokenId: position.tokenId,
        key: position.key,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: position.liquidity,
      })));
  }catch(error){if(cacheStale)throw new Error(`FRESH_STATE_UNAVAILABLE:${error instanceof Error?error.message:'UNKNOWN'}`);throw error;}
  if(cacheStale){if(!same(fees.pool.id,state.parent.pool_id)||!same(poolId(fees.pool.key),state.parent.pool_id))throw new Error('FRESH_STATE_UNAVAILABLE:EXACT_POOL_IDENTITY_MISMATCH');const blockers=v4ExecutionBlockers(fees.pool),persistStartedAtMs=Date.now();input.repo.refreshV4RegistryPool({poolId:String(state.parent.pool_id),sqrtPriceX96:fees.pool.sqrtPriceX96,tick:fees.pool.tick,liquidity:fees.pool.liquidity,protocolFee:fees.pool.protocolFee??0,lpFeePips:fees.pool.lpFee??fees.pool.key.fee,initialized:fees.pool.initialized,refreshBlock:fees.pool.blockNumber,validationStatus:blockers.length?'BLOCKED':'ELIGIBLE',blockers});input.repo.recordLatency('v4_bid_ladder_reposition_pool_refresh_completed',Date.now()-rpcStartedAtMs,{cacheAgeMs:0,context:{ladderId:input.ladderId,poolId:String(state.parent.pool_id),refreshBlock:fees.pool.blockNumber,rpcDurationMs:persistStartedAtMs-rpcStartedAtMs,persistenceDurationMs:Date.now()-persistStartedAtMs,poolFreshPersisted:true,queuedObligationPreserved:true}});}
  const truth = positions.map((position, index): V4BidLadderResetLegTruth => ({
      tokenId: position.tokenId,
      owner: position.owner,
      poolId: poolId(position.key),
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      liquidity: position.liquidity,
      principal: amountsForLiquidity(
        fees.pool.sqrtPriceX96,
        position.tickLower,
        position.tickUpper,
        position.liquidity,
      ),
      fees: {
        token0: fees.positions[index]!.token0,
        token1: fees.positions[index]!.token1,
      },
      blockNumber: fees.pool.blockNumber,
    })),
    nonce = await nonceTruth(input.repo, input.rpc, input.wallet, input.nowMs ?? Date.now()),
    evaluation = evaluateV4BidLadderUsdResetEligibility({
      wallet: input.wallet,
      expectedPoolId: String(state.parent.pool_id),
      fundingIndex: Number(state.parent.funding_index) as 0 | 1,
      targetIndex: Number(state.parent.target_index) as 0 | 1,
      expectedLegs: expected,
      legs: truth,
      unresolvedTransactions: nonce.unresolved,
      nonceAmbiguous: nonce.ambiguous,
    });
  return { ...evaluation, state, legs: truth, fees, nonce };
}

function confirmedCloseJournal(repo: SqliteLedgerRepository, ladderId: string) {
  const row = repo.db
    .prepare(
      "SELECT * FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='CLOSE_BATCH' ORDER BY attempt DESC LIMIT 1",
    )
    .get(CHAIN_ID, ladderId) as Record<string, unknown> | undefined;
  if (!row || String(row.status) !== "CONFIRMED" || !row.receipt_json)
    throw new Error("REPOSITION_CLOSE_RECEIPT_NOT_CONFIRMED");
  const prepared = JSON.parse(String(row.provider_evidence_json ?? "{}")).prepared;
  if (!prepared?.request?.data)
    throw new Error("REPOSITION_CLOSE_PREPARED_EVIDENCE_MISSING");
  const receipt = receiptJson(row.receipt_json);
  if (receipt.status !== "success" || !same(receipt.transactionHash, row.expected_hash))
    throw new Error("REPOSITION_CLOSE_RECEIPT_INVALID");
  return { row, prepared, receipt };
}

export async function readV4BidLadderCloseExecutionPool(
  rpc: FallbackRpc,
  key: V4PoolKey,
  receipt: TransactionReceipt,
) {
  const index = receipt.transactionIndex;
  if (!Number.isSafeInteger(index))
    throw new Error("REPOSITION_RECEIPT_TRANSACTION_INDEX_MISSING");
  let swaps: Array<{ transactionIndex: number | null }>;
  try {
    swaps = await rpc.withClient((client) =>
      client.getLogs({
        address: V4_ROBINHOOD_DEPLOYMENTS.poolManager,
        event: swapEvent,
        args: { id: poolId(key) },
        // Deliberately inspect only the execution block. Future blocks cannot
        // alter a historical eth_call pinned to receipt.blockNumber.
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      }),
    );
  } catch {
    throw new Error("REPOSITION_EXECUTION_PRICE_EVIDENCE_RPC_UNAVAILABLE");
  }
  if (swaps.some((log) => log.transactionIndex === null))
    throw new Error("REPOSITION_EXECUTION_PRICE_EVIDENCE_MISMATCH");
  if (swaps.some((log) => log.transactionIndex! > index))
    throw new Error("REPOSITION_SAME_BLOCK_LATER_SWAP_AMBIGUOUS");
  if (swaps.some((log) => log.transactionIndex === index))
    throw new Error("REPOSITION_EXECUTION_PRICE_EVIDENCE_MISMATCH");
  let executionPool: Awaited<ReturnType<typeof inspectV4Pool>>;
  try {
    executionPool = await inspectV4Pool(rpc, key, receipt.blockNumber);
  } catch {
    throw new Error("REPOSITION_HISTORICAL_STATE_RPC_UNAVAILABLE");
  }
  if (executionPool.status === "unavailable")
    throw new Error("REPOSITION_HISTORICAL_STATE_UNAVAILABLE");
  return executionPool.value;
}

export async function proveV4BidLadderUsdResetPrincipal(input: {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  ladderId: string;
  wallet: Address;
}) {
  const state = ladderRows(input.repo, input.ladderId),
    evidence = confirmedCloseJournal(input.repo, input.ladderId),
    decoded = decodeV4BatchFullDecrease(evidence.prepared.request.data as Hex, {
      key: state.key,
      recipient: input.wallet,
    });
  if (decoded.legs.length !== 5)
    throw new Error("REPOSITION_CLOSE_NOT_FIVE_LEGS");
  const executionPool = await readV4BidLadderCloseExecutionPool(
    input.rpc,
    state.key,
    evidence.receipt,
  );
  const expected = decoded.legs.map((leg, index) => ({
      key: state.key,
      tokenId: leg.tokenId,
      liquidity: leg.liquidity,
      owner: input.wallet,
      tickLower: Number(state.legs[index]!.tick_lower),
      tickUpper: Number(state.legs[index]!.tick_upper),
    })),
    receipt = {
      status: "success" as const,
      transactionHash: evidence.receipt.transactionHash,
      logs: evidence.receipt.logs.map((log) => ({
        address: log.address,
        data: log.data,
        topics: log.topics,
        logIndex: log.logIndex,
        transactionHash: evidence.receipt.transactionHash,
      })),
    },
    reconciled = await reconcileV4BatchFullDecreaseReceipt({
      receipt,
      expectedLegs: expected,
      recipient: input.wallet,
      inspectPosition: (tokenId) => inspectV4Position(input.rpc, tokenId),
    }),
    principal = expected.reduce(
      (sum, leg) => {
        const amounts = amountsForLiquidity(
          executionPool.sqrtPriceX96,
          leg.tickLower,
          leg.tickUpper,
          leg.liquidity,
        );
        return { token0: sum.token0 + amounts.token0, token1: sum.token1 + amounts.token1 };
      },
      { token0: 0n, token1: 0n },
    ),
    transfers = reconciled.aggregateTransfers;
  if (transfers.token0 === null || transfers.token1 === null)
    throw new Error("REPOSITION_NATIVE_TRANSFER_UNSUPPORTED");
  const verifiedTransfers = { token0: transfers.token0, token1: transfers.token1 };
  const classified = classifyV4BidLadderUsdResetOutputs({
      principal,
      transfers: verifiedTransfers,
      fundingIndex: Number(state.parent.funding_index) as 0 | 1,
      targetIndex: Number(state.parent.target_index) as 0 | 1,
    }),
    values = {
      returnedUsdgPrincipal: classified.returnedUsdgPrincipal,
      returnedTargetPrincipal: classified.returnedTargetPrincipal,
      returnedUsdgFee: classified.returnedUsdgFee,
      returnedTargetFee: classified.returnedTargetFee,
    };
  return { ...classified, ...values, receipt: evidence.receipt, executionPool };
}

export async function reconcileV4BidLadderUsdResetPrincipal(input: {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  ladderId: string;
  wallet: Address;
}) {
  const proof = await proveV4BidLadderUsdResetPrincipal(input),
    values = {
      returnedUsdgPrincipal: proof.returnedUsdgPrincipal,
      returnedTargetPrincipal: proof.returnedTargetPrincipal,
      returnedUsdgFee: proof.returnedUsdgFee,
      returnedTargetFee: proof.returnedTargetFee,
    };
  let transitionResult: "APPLIED" | "ALREADY_ADVANCED" | "CONFLICT" = "CONFLICT";
  input.repo.db.transaction(() => {
    const current = input.repo.loadBidLadderUsdReset(input.ladderId);
    if (String(current?.phase) === "CLOSE_CONFIRMED") {
      input.repo.transitionBidLadderUsdReset({
        ladderId: input.ladderId,
        from: "CLOSE_CONFIRMED",
        to: "PRINCIPAL_RECONCILED",
        ...values,
      });
      transitionResult = "APPLIED";
    } else if (["PRINCIPAL_RECONCILED", "REOPEN_PLANNED", "REOPEN_PREPARED", "REOPEN_SUBMITTED", "COMPLETED"].includes(String(current?.phase))) {
      transitionResult = "ALREADY_ADVANCED";
    }
    if (values.returnedTargetPrincipal > 0n) {
      const row = input.repo.loadBidLadderUsdReset(input.ladderId);
      if (String(row?.phase) === "PRINCIPAL_RECONCILED")
        input.repo.transitionBidLadderUsdReset({
          ladderId: input.ladderId,
          from: "PRINCIPAL_RECONCILED",
          to: "BLOCKED",
          blockReason: "REPOSITION_BLOCKED_NON_USDG_PRINCIPAL",
        });
    }
  })();
  return { ...proof, transitionResult };
}

function tokenFromParent(
  repo: SqliteLedgerRepository,
  parent: Record<string, unknown>,
  kind: "funding" | "target",
): BidLadderToken {
  const address = getAddress(String(parent[`${kind}_token`])),
    metadata = repo.tokenMetadata(address),
    position = repo.db
      .prepare("SELECT * FROM v4_positions WHERE open_intent_id=? ORDER BY token_id LIMIT 1")
      .get(parent.ladder_id) as Record<string, unknown> | undefined,
    decimals = Number(metadata?.decimals ?? position?.[`${kind}_decimals`] ?? (same(address, robinhoodMainnet.assets.USDG) ? 6 : 18)),
    symbol = String(metadata?.symbol ?? position?.[`${kind}_symbol`] ?? (same(address, robinhoodMainnet.assets.USDG) ? "USDG" : "TOKEN"));
  if (!Number.isInteger(decimals) || decimals < 0)
    throw new Error("REPOSITION_TOKEN_METADATA_INVALID");
  return { address, decimals, symbol };
}

async function planChild(input: {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  ladderId: string;
  wallet: Address;
  nowMs: number;
}) {
  const reset = input.repo.loadBidLadderUsdReset(input.ladderId),
    state = ladderRows(input.repo, input.ladderId);
  if (!reset || String(reset.phase) !== "PRINCIPAL_RECONCILED")
    throw new Error("REPOSITION_PRINCIPAL_NOT_RECONCILED");
  if (BigInt(String(reset.returned_target_principal_raw ?? "-1")) !== 0n)
    throw new Error("REPOSITION_BLOCKED_NON_USDG_PRINCIPAL");
  const capital = BigInt(String(reset.returned_usdg_principal_raw ?? "0"));
  if (capital <= 0n) throw new Error("REPOSITION_RETURNED_USDG_PRINCIPAL_ZERO");
  if (reset.next_ladder_id) return String(reset.next_ladder_id);
  const current = await inspectV4Pool(input.rpc, state.key);
  if (current.status === "unavailable") throw new Error("REPOSITION_FRESH_POOL_STATE_UNAVAILABLE");
  const funding = tokenFromParent(input.repo, state.parent, "funding"),
    target = tokenFromParent(input.repo, state.parent, "target"),
    depth = input.repo.v4BidLadderStrategyDepthBps(input.ladderId),
    preview = previewV4BidLadder({
      pool: current.value,
      funding,
      target,
      totalFundingAmount: capital,
      maxDownsideBps: depth,
      owner: input.wallet,
      deadline: BigInt(Math.floor(input.nowMs / 1000) + 600),
      nowMs: input.nowMs,
    }),
    entryUsd = Number(capital) / 10 ** funding.decimals;
  if (!Number.isFinite(entryUsd) || entryUsd <= 0)
    throw new Error("REPOSITION_CHILD_CAPITAL_INVALID");
  createV4BidLadderLive(input.repo, preview, entryUsd, {
    rootLadderId: String(reset.root_ladder_id),
    previousLadderId: input.ladderId,
    generation: Number(reset.generation) + 1,
    creationReason: "USDG_RESET_REPOSITION",
  });
  const latest = input.repo.loadBidLadderUsdReset(input.ladderId)!;
  if (String(latest.phase) === "PRINCIPAL_RECONCILED")
    input.repo.transitionBidLadderUsdReset({
      ladderId: input.ladderId,
      from: "PRINCIPAL_RECONCILED",
      to: "REOPEN_PLANNED",
      reopenWorkflowIdentity: preview.plan.ladderId,
    });
  return preview.plan.ladderId;
}

async function childFundingOnlyDrift(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;childId:string}){
  const child=ladderRows(input.repo,input.childId),current=await inspectV4Pool(input.rpc,child.key);
  if(current.status==='unavailable')throw new Error('REPOSITION_FRESH_POOL_STATE_UNAVAILABLE');
  const fundingIndex=Number(child.parent.funding_index) as 0|1,targetIndex=Number(child.parent.target_index) as 0|1,
    drifted=child.legs.some(leg=>{const amounts=amountsForLiquidity(current.value.sqrtPriceX96,Number(leg.tick_lower),Number(leg.tick_upper),BigInt(String(leg.planned_liquidity_raw)));return (targetIndex===0?amounts.token0:amounts.token1)>0n||(fundingIndex===0?amounts.token0:amounts.token1)<=0n;});
  return {drifted,pool:current.value};
}

export async function rematerializeV4BidLadderRepositionChildOnce(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;ladderId:string;childId:string;wallet:Address;nowMs:number;failureCode?:'V4_BID_LADDER_LEG_NOT_FUNDING_ONLY'|'V4_BID_LADDER_MINT_ESTIMATE_FAILED';pool?:V4PoolState;metadata?:{funding:{address:Address;decimals:number};target:{address:Address;decimals:number}}}){
  const reset=input.repo.loadBidLadderUsdReset(input.ladderId),source=ladderRows(input.repo,input.ladderId),child=ladderRows(input.repo,input.childId);
  const childReset=input.repo.loadBidLadderUsdReset(input.childId),activeChild=String(reset?.reopen_workflow_identity??reset?.next_ladder_id??'');
  if(!reset||activeChild!==input.childId||String(reset.phase)!=='REOPEN_PLANNED')throw new Error('REPOSITION_JIT_REMATERIALIZATION_AUTHORITY_INVALID');
  if(String(child.parent.status)!=='PLANNED'||String(childReset?.phase)!=='OPEN_PENDING')throw new Error('REPOSITION_JIT_REMATERIALIZATION_OPEN_AUTHORITY_EXISTS');
  const priorAttempts=Number(childReset?.jit_rematerialization_attempts??0);
  if(!Number.isSafeInteger(priorAttempts)||priorAttempts<0||priorAttempts>=V4_REPOSITION_MAX_JIT_REMATERIALIZATIONS)throw new Error('REPOSITION_JIT_REMATERIALIZATION_LIMIT_EXHAUSTED');
  const journal=input.repo.db.prepare("SELECT 1 FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='OPEN_BATCH' LIMIT 1").get(CHAIN_ID,input.childId);
  if(journal||child.legs.some(leg=>leg.open_batch_id||leg.token_id||String(leg.status)!=='PLANNED'))throw new Error('REPOSITION_JIT_REMATERIALIZATION_OPEN_AUTHORITY_EXISTS');
  const capital=BigInt(String(reset.returned_usdg_principal_raw??'0')),targetPrincipal=BigInt(String(reset.returned_target_principal_raw??'-1')),depth=input.repo.v4BidLadderStrategyDepthBps(input.ladderId),inspected=input.pool?undefined:await inspectV4Pool(input.rpc,source.key),current=input.pool??(inspected?.status==='available'?inspected.value:undefined);
  if(!current)throw new Error('REPOSITION_FRESH_POOL_STATE_UNAVAILABLE');
  if(capital<=0n||targetPrincipal!==0n||!sameV4PoolKey(current.key,source.key)||!same(current.id,source.parent.pool_id))throw new Error('REPOSITION_JIT_STRATEGY_INTENT_MISMATCH');
  const funding=tokenFromParent(input.repo,source.parent,'funding'),target=tokenFromParent(input.repo,source.parent,'target'),metadata=input.metadata??await (async()=>{const [fundingEvidence,targetEvidence]=await Promise.all([inspectErc20(input.rpc,funding.address),inspectErc20(input.rpc,target.address)]);if(fundingEvidence.status!=='available'||targetEvidence.status!=='available')throw new Error('REPOSITION_FRESH_TOKEN_METADATA_UNAVAILABLE');return {funding:fundingEvidence.value,target:targetEvidence.value};})();
  if(!same(metadata.funding.address,funding.address)||metadata.funding.decimals!==funding.decimals||!same(metadata.target.address,target.address)||metadata.target.decimals!==target.decimals||!same(funding.address,robinhoodMainnet.assets.USDG)||!same(current.key.currency0,source.parent.currency0)||!same(current.key.currency1,source.parent.currency1)||Number(source.parent.funding_index)!==(same(funding.address,current.key.currency0)?0:1)||Number(source.parent.target_index)!==(same(target.address,current.key.currency0)?0:1))throw new Error('REPOSITION_JIT_STRATEGY_INTENT_MISMATCH');
  const fresh=previewV4BidLadder({pool:current,funding,target,totalFundingAmount:capital,maxDownsideBps:depth,owner:input.wallet,deadline:BigInt(Math.floor(input.nowMs/1000)+600),nowMs:input.nowMs}),plan={...fresh.plan,ladderId:input.childId,legs:fresh.plan.legs.map(leg=>({...leg,identity:`${input.childId}:${leg.index}:${leg.upperDropBps}:${leg.lowerDropBps}:${leg.tickLower}:${leg.tickUpper}`}))};
  if(plan.totalFundingAmount!==capital||plan.maxDownsideBps!==depth||plan.legs.length!==5||plan.legs.some((leg,index)=>leg.index!==index||leg.targetIndex!==Number(source.parent.target_index)||leg.fundingIndex!==Number(source.parent.funding_index)||(leg.targetIndex===0?leg.mint.amount0Expected:leg.mint.amount1Expected)!==0n)||plan.legs.reduce((sum,leg)=>sum+leg.fundingAmount,0n)!==capital)throw new Error('REPOSITION_JIT_STRATEGY_INTENT_MISMATCH');
  const expectedParentRevision=Number(child.parent.revision),expectedResetRevision=Number(childReset!.revision),attempt=priorAttempts+1,failureCode=input.failureCode??'V4_BID_LADDER_LEG_NOT_FUNDING_ONLY';
  input.repo.db.transaction(()=>{const parentChanged=input.repo.db.prepare("UPDATE v4_bid_ladders SET reference_tick=?,reference_block=?,reference_block_hash=?,total_funding_amount_raw=?,updated_at_ms=?,revision=revision+1 WHERE ladder_id=? AND status='PLANNED' AND revision=?").run(plan.referenceTick,plan.referenceBlock.toString(),plan.referenceBlockHash??null,capital.toString(),input.nowMs,input.childId,expectedParentRevision).changes;if(parentChanged!==1)throw new Error('REPOSITION_JIT_REMATERIALIZATION_CONFLICT');const update=input.repo.db.prepare("UPDATE v4_bid_ladder_legs SET upper_drop_bps=?,lower_drop_bps=?,capital_weight_bps=?,tick_lower=?,tick_upper=?,funding_amount_raw=?,planned_liquidity_raw=?,funding_index=?,target_index=?,updated_at_ms=? WHERE ladder_id=? AND leg_index=? AND status='PLANNED' AND token_id IS NULL AND open_batch_id IS NULL");for(const leg of plan.legs)if(update.run(leg.upperDropBps,leg.lowerDropBps,leg.weightBps,leg.tickLower,leg.tickUpper,leg.fundingAmount.toString(),leg.mint.liquidity.toString(),leg.fundingIndex,leg.targetIndex,input.nowMs,input.childId,leg.index).changes!==1)throw new Error('REPOSITION_JIT_REMATERIALIZATION_CONFLICT');if(input.repo.db.prepare("UPDATE v4_bid_ladder_usdg_reset_v1 SET jit_rematerialization_attempts=?,jit_last_failure_code=?,jit_last_reference_tick=?,jit_last_reference_block=?,jit_last_attempt_at_ms=?,revision=revision+1,updated_at_ms=? WHERE ladder_id=? AND phase='OPEN_PENDING' AND revision=? AND jit_rematerialization_attempts=?").run(attempt,failureCode,plan.referenceTick,plan.referenceBlock.toString(),input.nowMs,input.nowMs,input.childId,expectedResetRevision,priorAttempts).changes!==1)throw new Error('REPOSITION_JIT_REMATERIALIZATION_CONFLICT');})();
  return {childId:input.childId,referenceTick:plan.referenceTick,referenceBlock:plan.referenceBlock,rematerializations:attempt};
}

export async function previewV4BidLadderUsdReset(input: {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  ladderId: string;
  wallet: Address;
  nowMs?: number;
  marketCapEvidence?: V4BidLadderMarketCapEvidence;
  allowanceReadiness?: Awaited<ReturnType<typeof v4BidLadderFundingAllowanceReadiness>>;
}) {
  const now = input.nowMs ?? Date.now(),
    truth = await readV4BidLadderUsdResetTruth({ ...input, nowMs: now }),
    reset = input.repo.loadBidLadderUsdReset(input.ladderId);
  if (!reset || String(reset.phase) !== "WATCHING")
    throw new Error("REPOSITION_MANUAL_PREVIEW_PHASE_INVALID");
  const funding = tokenFromParent(input.repo, truth.state.parent, "funding"),
    target = tokenFromParent(input.repo, truth.state.parent, "target"),
    depth = input.repo.v4BidLadderStrategyDepthBps(input.ladderId),
    child = previewV4BidLadder({
      pool: truth.fees.pool,
      funding,
      target,
      totalFundingAmount: truth.usdgPrincipal,
      maxDownsideBps: depth,
      owner: input.wallet,
      deadline: BigInt(Math.floor(now / 1000) + 600),
      nowMs: now,
    }),
    token0Decimals = same(funding.address, truth.state.key.currency0)
      ? funding.decimals
      : target.decimals,
    token1Decimals = same(funding.address, truth.state.key.currency1)
      ? funding.decimals
      : target.decimals,
    poolPriceFundingPerTarget = orientPoolPriceFundingPerTarget({
      priceToken1PerToken0: priceFromSqrtX96(
        truth.fees.pool.sqrtPriceX96,
        token0Decimals,
        token1Decimals,
      ),
      token0: truth.state.key.currency0,
      token1: truth.state.key.currency1,
      target: target.address,
      funding: funding.address,
    });
  return {
    eligible: truth.eligible,
    blockers: truth.blockers,
    truth,
    reset,
    child,
    depth,
    funding,
    target,
    poolPriceFundingPerTarget,
    marketCapEvidence: input.marketCapEvidence,
    allowanceReadiness: input.allowanceReadiness,
  };
}

export function formatV4BidLadderUsdResetPreview(
  preview: Awaited<ReturnType<typeof previewV4BidLadderUsdReset>>,
) {
  const range = estimateV4BidLadderMarketCapRange({
      parent: {
        ...preview.truth.state.parent,
        reference_tick: preview.child.plan.referenceTick,
      },
      legs: preview.child.plan.legs.map((leg) => ({
        tick_lower: leg.tickLower,
        tick_upper: leg.tickUpper,
      })),
      funding: preview.funding,
      target: preview.target,
      evidence: preview.marketCapEvidence,
    }),
    currentMc = preview.marketCapEvidence?.marketCapUsd;
  return [
    "V4 BID Ladder · MANUAL REPOSITION PREVIEW",
    `Status: ${preview.eligible ? "ELIGIBLE" : "BLOCKED"}`,
    `Ladder: ${String(preview.reset.ladder_id)}`,
    `Current generation: ${String(preview.reset.generation)}`,
    `Current strategy depth: -${preview.depth / 100}%`,
    "Slices: 8% / 12% / 18% / 25% / 37%",
    "",
    "Fresh reference",
    `Block: ${preview.child.plan.referenceBlock}`,
    `Tick: ${preview.child.plan.referenceTick}`,
    `Pool price: ${preview.poolPriceFundingPerTarget} ${preview.funding.symbol}/${preview.target.symbol}`,
    `Current MC: ${currentMc && currentMc > 0 ? `$${currentMc}` : "Unavailable"}`,
    `Expected fresh target range: ${range ? `$${range.startUsd} → $${range.deepestUsd}` : `ticks ${preview.child.plan.legs[0]!.tickLower}/${preview.child.plan.legs[0]!.tickUpper} → ${preview.child.plan.legs.at(-1)!.tickLower}/${preview.child.plan.legs.at(-1)!.tickUpper}`}`,
    ...preview.child.plan.legs.map(
      (leg) =>
        `#${leg.index + 1} · ${leg.weightBps / 100}% · -${leg.upperDropBps / 100}% → -${leg.lowerDropBps / 100}% · ticks ${leg.tickLower}/${leg.tickUpper}`,
    ),
    "",
    `Estimated returned USDG principal: ${preview.truth.usdgPrincipal} raw`,
    `Current target principal: ${preview.truth.targetPrincipal} raw`,
    `Replacement allowance: ${preview.allowanceReadiness?.ready ? "READY · exact bounded allowance" : "PREPARATION REQUIRED before Confirm"}`,
    "Only receipt-reconciled returned USDG PRINCIPAL funds the child.",
    "USDG and target fees remain wallet profit and are not compounded.",
    "NO SWAP",
    "NO BURN",
    "This preview does not close, sign, broadcast, or create a child.",
    preview.blockers.length
      ? `BLOCKED: ${preview.blockers.join(", ")}`
      : "Explicit confirmation authorizes one bounded close/reopen workflow.",
  ].join("\n");
}

export type V4BidLadderUsdResetCycleInput = {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  wallet: Address;
  walletClient: () => WalletClient;
  context: (ladderId: string) => Promise<LadderLiveContext>;
  manualAuthorizationIdentity?: string;
  readTruth?: typeof readV4BidLadderUsdResetTruth;
  reconcilePrincipal?: typeof reconcileV4BidLadderUsdResetPrincipal;
  planChild?: typeof planChild;
  readAllowanceReadiness?: typeof v4BidLadderFundingAllowanceReadiness;
  executeOpen?: typeof executeV4BidLadderLiveOpen;
  executeClose?: typeof executeV4BidLadderManualClose;
  nowMs?: () => number;
  /** Millisecond timestamp captured when the operator confirmation is consumed. */
  confirmAtMs?: number;
  notify?: (message: string) => Promise<unknown> | unknown;
  /** Recovery/testing escape hatch. Normal confirmation continues directly. */
  returnAfterCloseReceipt?: boolean;
  callerSource?: RepositionCallerSource;
  executionOwnerId?: string;
  executionLeaseMs?: number;
  telemetry?: (event: Record<string, unknown>) => void;
  executionLease?: { ownerId: string; leaseMs: number };
};

export type RepositionCallerSource =
  | "USER_CONFIRM"
  | "IMMEDIATE_RECOVERY"
  | "PERIODIC_RECOVERY";

const REPOSITION_EXECUTION_LEASE_MS = 30_000;

function repositionTelemetry(
  input: V4BidLadderUsdResetCycleInput,
  event: Record<string, unknown>,
) {
  try {
    input.telemetry?.({ event: "v4_bid_ladder_reposition_single_flight", ...event });
  } catch {}
}

export function acquireV4BidLadderRepositionLease(input: {
  repo: SqliteLedgerRepository;
  ladderId: string;
  ownerId: string;
  callerSource: RepositionCallerSource;
  nowMs?: number;
  leaseMs?: number;
}) {
  const now = input.nowMs ?? Date.now(),
    leaseMs = input.leaseMs ?? REPOSITION_EXECUTION_LEASE_MS,
    reset = input.repo.loadBidLadderUsdReset(input.ladderId);
  if (!reset) return { result: "NOT_FOUND" as const };
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1)
    throw new Error("REPOSITION_SINGLE_FLIGHT_LEASE_INPUT_INVALID");
  const changed = input.repo.db.prepare(`
    INSERT INTO v4_bid_ladder_usdg_reset_execution_leases(
      ladder_id,owner_id,caller_source,generation,phase_at_acquire,
      acquired_at_ms,lease_until_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(ladder_id) DO UPDATE SET
      owner_id=excluded.owner_id,
      caller_source=excluded.caller_source,
      generation=excluded.generation,
      phase_at_acquire=excluded.phase_at_acquire,
      acquired_at_ms=excluded.acquired_at_ms,
      lease_until_ms=excluded.lease_until_ms,
      updated_at_ms=excluded.updated_at_ms
    WHERE v4_bid_ladder_usdg_reset_execution_leases.lease_until_ms<=excluded.acquired_at_ms
       OR v4_bid_ladder_usdg_reset_execution_leases.owner_id=excluded.owner_id
  `).run(
    input.ladderId,
    input.ownerId,
    input.callerSource,
    Number(reset.generation),
    String(reset.phase),
    now,
    now + leaseMs,
    now,
  ).changes;
  const current = input.repo.db.prepare(
    "SELECT * FROM v4_bid_ladder_usdg_reset_execution_leases WHERE ladder_id=?",
  ).get(input.ladderId) as Record<string, unknown> | undefined;
  return changed === 1
    ? {
        result: "ACQUIRED" as const,
        acquiredAt: Number(current?.acquired_at_ms ?? now),
        leaseUntil: Number(current?.lease_until_ms ?? now + leaseMs),
        phaseAtAcquire: String(current?.phase_at_acquire ?? reset.phase),
        generation: Number(current?.generation ?? reset.generation),
      }
    : {
        result: "ALREADY_PROGRESSING" as const,
        currentOwnerId: String(current?.owner_id ?? "UNKNOWN"),
        currentCallerSource: String(current?.caller_source ?? "UNKNOWN"),
        acquiredAt: Number(current?.acquired_at_ms ?? 0),
        leaseUntil: Number(current?.lease_until_ms ?? 0),
        phaseAtAcquire: String(current?.phase_at_acquire ?? reset.phase),
        generation: Number(current?.generation ?? reset.generation),
      };
}

export function renewV4BidLadderRepositionLease(input: {
  repo: SqliteLedgerRepository;
  ladderId: string;
  ownerId: string;
  nowMs?: number;
  leaseMs?: number;
}) {
  const now = input.nowMs ?? Date.now(), leaseMs = input.leaseMs ?? REPOSITION_EXECUTION_LEASE_MS;
  return input.repo.db.prepare(
    "UPDATE v4_bid_ladder_usdg_reset_execution_leases SET lease_until_ms=?,updated_at_ms=? WHERE ladder_id=? AND owner_id=? AND lease_until_ms>?",
  ).run(now + leaseMs, now, input.ladderId, input.ownerId, now).changes === 1;
}

export function releaseV4BidLadderRepositionLease(input: {
  repo: SqliteLedgerRepository;
  ladderId: string;
  ownerId: string;
}) {
  return input.repo.db.prepare(
    "DELETE FROM v4_bid_ladder_usdg_reset_execution_leases WHERE ladder_id=? AND owner_id=?",
  ).run(input.ladderId, input.ownerId).changes === 1;
}

function assertV4BidLadderRepositionLease(
  input: V4BidLadderUsdResetCycleInput,
  ladderId: string,
) {
  if (!input.executionLease) return;
  if (!renewV4BidLadderRepositionLease({
    repo: input.repo,
    ladderId,
    ownerId: input.executionLease.ownerId,
    nowMs: (input.nowMs ?? Date.now)(),
    leaseMs: input.executionLease.leaseMs,
  })) throw new Error("REPOSITION_SINGLE_FLIGHT_LEASE_LOST");
}

function transitionV4BidLadderUsdResetOnce(input: {
  repo: SqliteLedgerRepository;
  ladderId: string;
  from: V4BidLadderUsdResetPhase | readonly V4BidLadderUsdResetPhase[];
  to: V4BidLadderUsdResetPhase;
  reopenWorkflowIdentity?: string;
  blockReason?: string;
  nowMs?: number;
}) {
  try {
    const row = input.repo.transitionBidLadderUsdReset(input);
    return { result: "APPLIED" as const, row };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "V4_BID_LADDER_USDG_RESET_TRANSITION_CONFLICT")
      throw error;
    const row = input.repo.loadBidLadderUsdReset(input.ladderId),
      from = Array.isArray(input.from) ? input.from : [input.from];
    return from.includes(String(row?.phase) as V4BidLadderUsdResetPhase)
      ? { result: "CONFLICT" as const, row }
      : { result: "ALREADY_ADVANCED" as const, row };
  }
}

export function classifyV4BidLadderRepositionExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error),
    code = (message.split(":", 1)[0] || "REPOSITION_UNKNOWN_ERROR").slice(0, 160),
    nativeCode = isRecord(error) && typeof error.code === "string" ? error.code : "",
    signature = `${code}:${nativeCode}:${message}`,
    retryable = /(?:DURABLE_TRANSACTION_NONCE_MUTEX_HELD|REPOSITION_SINGLE_FLIGHT_LEASE_LOST|RPC|PROVIDER|TIMEOUT|SQLITE_BUSY|SQLITE_LOCKED|database is (?:busy|locked)|FRESH_(?:POOL_)?STATE_UNAVAILABLE|STATE_CACHE|TEMPORARY)/i.test(signature),
    terminal = /(?:CHILD_OPEN_FAILED|FUNDING_ONLY|MINT_ESTIMATE_FAILED|JIT_(?:STRATEGY_INTENT_MISMATCH|REMATERIALIZATION_LIMIT_EXHAUSTED)|POOL_IDENTITY_MISMATCH|PRINCIPAL_(?:MISMATCH|EXCEEDS_RECEIPT_TRANSFER)|NON_USDG_PRINCIPAL|SAME_BLOCK_LATER_SWAP_AMBIGUOUS|EXECUTION_PRICE_EVIDENCE_MISMATCH|ADMISSION|SAFETY|CANCELLED|REPLACEMENT_OPEN_STOPPED|NONCE_(?:DIVERGENCE|MISMATCH|AMBIGUOUS))/.test(signature);
  return {
    classification: retryable || !terminal ? "RETRYABLE" as const : "DETERMINISTIC_TERMINAL" as const,
    code,
    message: message.slice(0, 300),
  };
}

function notifyWithoutBlocking(input:V4BidLadderUsdResetCycleInput,message:string){
  try{void Promise.resolve(input.notify?.(message)).catch(()=>undefined);}catch{}
}

export function cancelV4BidLadderRepositionPreClose(input:{repo:SqliteLedgerRepository;ladderId:string;nowMs?:number}){
  const ownerId=`reposition-cancel:${process.pid}:${randomUUID()}`,now=input.nowMs??Date.now(),lease=acquireV4BidLadderRepositionLease({repo:input.repo,ladderId:input.ladderId,ownerId,callerSource:'USER_CONFIRM',nowMs:now});
  if(lease.result!=='ACQUIRED')throw new Error('REPOSITION_ALREADY_PROGRESSING');
  try{const reset=input.repo.loadBidLadderUsdReset(input.ladderId),journal=input.repo.db.prepare("SELECT status FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='CLOSE_BATCH' ORDER BY attempt DESC LIMIT 1").get(CHAIN_ID,input.ladderId);if(!reset||String(reset.phase)!=='WATCHING'||journal)throw new Error(journal?'REPOSITION_CANCEL_TOO_LATE_TRANSACTION_AUTHORITY_EXISTS':'REPOSITION_CANCEL_TOO_LATE_PHASE_CHANGED');return input.repo.transitionBidLadderUsdReset({ladderId:input.ladderId,from:'WATCHING',to:'BLOCKED',blockReason:'REPOSITION_CANCELLED_PRE_CLOSE',nowMs:now});}finally{releaseV4BidLadderRepositionLease({repo:input.repo,ladderId:input.ladderId,ownerId});}
}

export function stopV4BidLadderReplacementOpen(input:{repo:SqliteLedgerRepository;ladderId:string;expectedRevision:number;nowMs?:number}){
  const ownerId=`reposition-stop:${process.pid}:${randomUUID()}`,now=input.nowMs??Date.now(),lease=acquireV4BidLadderRepositionLease({repo:input.repo,ladderId:input.ladderId,ownerId,callerSource:'USER_CONFIRM',nowMs:now});
  if(lease.result!=='ACQUIRED')throw new Error('REPOSITION_ALREADY_PROGRESSING');
  try{const reset=input.repo.loadBidLadderUsdReset(input.ladderId),phase=String(reset?.phase??'MISSING'),child=reset?.next_ladder_id?String(reset.next_ladder_id):undefined,openAuthority=child?input.repo.db.prepare("SELECT 1 FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='OPEN_BATCH' LIMIT 1").get(CHAIN_ID,child):undefined;if(!reset||Number(reset.revision)!==input.expectedRevision)throw new Error('REPOSITION_STOP_AUTHORIZATION_STALE_REVISION');if(!['CLOSE_CONFIRMED','PRINCIPAL_RECONCILED'].includes(phase)||child||openAuthority)throw new Error('REPOSITION_STOP_TOO_LATE_REPLACEMENT_AUTHORITY_EXISTS');return input.repo.transitionBidLadderUsdReset({ladderId:input.ladderId,from:phase as V4BidLadderUsdResetPhase,to:'BLOCKED',blockReason:'REPOSITION_REPLACEMENT_OPEN_STOPPED',nowMs:now});}finally{releaseV4BidLadderRepositionLease({repo:input.repo,ladderId:input.ladderId,ownerId});}
}

function confirmedCloseReceiptExists(repo: SqliteLedgerRepository, ladderId: string) {
  return Boolean(repo.db.prepare(
    "SELECT 1 FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='CLOSE_BATCH' AND status='CONFIRMED' AND receipt_json IS NOT NULL LIMIT 1",
  ).get(CHAIN_ID, ladderId));
}

const activeRepositionChildId=(reset:Record<string,unknown>|undefined)=>reset?.reopen_workflow_identity?String(reset.reopen_workflow_identity):reset?.next_ladder_id?String(reset.next_ladder_id):undefined;

export async function v4BidLadderRepositionResumeEligibility(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;ladderId:string;wallet:Address;nowMs?:number;leaseOwnerId?:string;context?:()=>Promise<LadderLiveContext>;readWalletBalance?:()=>Promise<bigint>;readAllowanceReadiness?:()=>Promise<{ready:boolean;blockers:readonly string[]}>}){
  const now=input.nowMs??Date.now(),source=input.repo.loadBidLadder(input.ladderId),reset=input.repo.loadBidLadderUsdReset(input.ladderId),priorChildId=reset?.next_ladder_id?String(reset.next_ladder_id):undefined,priorChild=priorChildId?input.repo.loadBidLadder(priorChildId):undefined,priorReset=priorChildId?input.repo.loadBidLadderUsdReset(priorChildId):undefined,legs=priorChildId?input.repo.listBidLadderLegs(priorChildId):[],blockers:string[]=[];
  if(String(source?.status)!=='CLOSED'||String(source?.close_provenance)!=='FUNI_EXECUTED')blockers.push('REPOSITION_RESUME_SOURCE_NOT_CANONICALLY_CLOSED');
  if(String(reset?.phase)!=='BLOCKED')blockers.push('REPOSITION_RESUME_SOURCE_NOT_BLOCKED');
  if(String(reset?.block_reason)!=='REPOSITION_JIT_REMATERIALIZATION_LIMIT_EXHAUSTED')blockers.push('REPOSITION_RESUME_BLOCK_REASON_NOT_JIT_EXHAUSTED');
  const closeRows=input.repo.db.prepare("SELECT status,receipt_json,expected_hash FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='CLOSE_BATCH' ORDER BY attempt").all(CHAIN_ID,input.ladderId) as Array<Record<string,unknown>>;
  if(closeRows.length!==1||String(closeRows[0]?.status)!=='CONFIRMED'||!closeRows[0]?.receipt_json)blockers.push('REPOSITION_RESUME_CLOSE_RECEIPT_NOT_EXACTLY_ONCE');
  const principal=BigInt(String(reset?.returned_usdg_principal_raw??'0')),targetPrincipal=BigInt(String(reset?.returned_target_principal_raw??'-1'));
  if(principal<=0n)blockers.push('REPOSITION_RESUME_PRINCIPAL_MISSING');
  if(targetPrincipal!==0n)blockers.push('REPOSITION_RESUME_TARGET_PRINCIPAL_CONVERSION_REQUIRED');
  if(!priorChildId||!priorChild||!priorReset)blockers.push('REPOSITION_RESUME_PRIOR_CHILD_MISSING');
  else{
    if(String(priorChild.status)!=='CANCELLED'||String(priorReset.phase)!=='BLOCKED')blockers.push('REPOSITION_RESUME_PRIOR_CHILD_NOT_TERMINAL');
    if(String(priorReset.root_ladder_id)!==String(reset?.root_ladder_id)||String(priorReset.previous_ladder_id)!==input.ladderId||Number(priorReset.generation)!==Number(reset?.generation)+1)blockers.push('REPOSITION_RESUME_PRIOR_CHILD_LINEAGE_INVALID');
    if(priorReset.next_ladder_id)blockers.push('REPOSITION_RESUME_ALTERNATE_CHILD_EXISTS');
    if(legs.length!==5||legs.some(leg=>String(leg.status)!=='CANCELLED'||leg.token_id!==null||leg.open_batch_id!==null))blockers.push('REPOSITION_RESUME_PRIOR_CHILD_NOT_EMPTY');
    if(input.repo.db.prepare("SELECT 1 FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='OPEN_BATCH' LIMIT 1").get(CHAIN_ID,priorChildId))blockers.push('REPOSITION_RESUME_PRIOR_CHILD_OPEN_AUTHORITY_EXISTS');
    if(input.repo.db.prepare("SELECT 1 FROM v4_positions WHERE open_intent_id=? LIMIT 1").get(priorChildId))blockers.push('REPOSITION_RESUME_PRIOR_CHILD_ALREADY_MINTED');
  }
  const unresolved=Number((input.repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal WHERE chain_id=? AND lower(wallet_address)=? AND status IN ('PREPARED','SUBMITTED')").get(CHAIN_ID,input.wallet.toLowerCase()) as {count:number}).count);
  if(unresolved)blockers.push('REPOSITION_RESUME_UNRESOLVED_WALLET_TRANSACTION');
  if(input.repo.db.prepare("SELECT 1 FROM chain_nonce_mutex WHERE chain_id=? AND lower(wallet_address)=? AND expires_at>?").get(CHAIN_ID,input.wallet.toLowerCase(),new Date(now).toISOString())||input.repo.db.prepare("SELECT 1 FROM nonce_mutex WHERE lower(wallet)=? AND expires_at>?").get(input.wallet.toLowerCase(),new Date(now).toISOString()))blockers.push('REPOSITION_RESUME_NONCE_MUTEX_HELD');
  const lease=input.repo.db.prepare("SELECT owner_id,lease_until_ms FROM v4_bid_ladder_usdg_reset_execution_leases WHERE ladder_id=? AND lease_until_ms>?").get(input.ladderId,now) as {owner_id:string;lease_until_ms:number}|undefined;
  if(lease&&lease.owner_id!==input.leaseOwnerId)blockers.push('REPOSITION_RESUME_ACTIVE_LEASE');
  let nonce:{latest:number;pending:number}|undefined;
  try{const truth=await nonceTruth(input.repo,input.rpc,input.wallet,now);nonce={latest:truth.latest,pending:truth.pending};if(truth.latest!==truth.pending)blockers.push('REPOSITION_RESUME_NONCE_AMBIGUOUS');}catch{blockers.push('REPOSITION_RESUME_NONCE_EVIDENCE_UNAVAILABLE');}
  let walletBalance=0n;
  try{walletBalance=input.readWalletBalance?await input.readWalletBalance():await input.rpc.withClient(client=>client.readContract({address:getAddress(String(source?.funding_token)),abi:erc20Abi,functionName:'balanceOf',args:[input.wallet]}),{stage:'reposition_resume_eligibility',method:'ERC20.balanceOf'});if(walletBalance<principal)blockers.push('REPOSITION_RESUME_PRINCIPAL_BALANCE_INSUFFICIENT');}catch{blockers.push('REPOSITION_RESUME_PRINCIPAL_BALANCE_UNAVAILABLE');}
  let allowance:{ready:boolean;blockers:readonly string[]}|undefined;
  try{allowance=input.readAllowanceReadiness?await input.readAllowanceReadiness():input.context?await v4BidLadderFundingAllowanceReadiness({...(await input.context()),fundingAmount:principal}):undefined;if(!allowance?.ready)blockers.push(...(allowance?.blockers??['REPOSITION_RESUME_ALLOWANCE_EVIDENCE_UNAVAILABLE']));}catch{blockers.push('REPOSITION_RESUME_ALLOWANCE_EVIDENCE_UNAVAILABLE');}
  return {eligible:blockers.length===0,ladderId:input.ladderId,rootLadderId:String(reset?.root_ladder_id??''),sourceGeneration:Number(reset?.generation??-1),priorChildId,priorChildGeneration:Number(priorReset?.generation??-1),nextGeneration:Number(priorReset?.generation??Number(reset?.generation??0))+1,principalRaw:principal.toString(),walletBalanceRaw:walletBalance.toString(),allowanceReady:Boolean(allowance?.ready),nonce,blockers:[...new Set(blockers)],signingCount:0,broadcastCount:0};
}

export async function resumeV4BidLadderReposition(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;ladderId:string;wallet:Address;context:()=>Promise<LadderLiveContext>;nowMs?:number;readWalletBalance?:()=>Promise<bigint>;readAllowanceReadiness?:()=>Promise<{ready:boolean;blockers:readonly string[]}>}){
  const now=input.nowMs??Date.now(),ownerId=`reposition-resume:${process.pid}:${randomUUID()}`,lease=acquireV4BidLadderRepositionLease({repo:input.repo,ladderId:input.ladderId,ownerId,callerSource:'USER_CONFIRM',nowMs:now});
  if(lease.result!=='ACQUIRED')throw new Error('REPOSITION_RESUME_ALREADY_PROGRESSING');
  try{
    const eligibility=await v4BidLadderRepositionResumeEligibility({...input,nowMs:now,leaseOwnerId:ownerId});if(!eligibility.eligible)throw new Error(`REPOSITION_RESUME_NOT_ELIGIBLE:${eligibility.blockers.join(',')}`);
    const sourceReset=input.repo.loadBidLadderUsdReset(input.ladderId)!,source=ladderRows(input.repo,input.ladderId),priorChildId=String(sourceReset.next_ladder_id),priorReset=input.repo.loadBidLadderUsdReset(priorChildId)!,capital=BigInt(String(sourceReset.returned_usdg_principal_raw)),depth=input.repo.v4BidLadderStrategyDepthBps(input.ladderId),pool=await inspectV4Pool(input.rpc,source.key);
    if(pool.status==='unavailable')throw new Error('REPOSITION_RESUME_FRESH_POOL_STATE_UNAVAILABLE');
    const funding=tokenFromParent(input.repo,source.parent,'funding'),target=tokenFromParent(input.repo,source.parent,'target'),[fundingEvidence,targetEvidence]=await Promise.all([inspectErc20(input.rpc,funding.address),inspectErc20(input.rpc,target.address)]);
    if(fundingEvidence.status!=='available'||targetEvidence.status!=='available'||fundingEvidence.value.decimals!==funding.decimals||targetEvidence.value.decimals!==target.decimals||!sameV4PoolKey(pool.value.key,source.key)||!same(pool.value.id,source.parent.pool_id))throw new Error('REPOSITION_RESUME_FRESH_CANONICAL_STATE_INVALID');
    const preview=previewV4BidLadder({pool:pool.value,funding,target,totalFundingAmount:capital,maxDownsideBps:depth,owner:input.wallet,deadline:BigInt(Math.floor(now/1000)+600),nowMs:now}),generation=Number(priorReset.generation)+1;
    input.repo.db.transaction(()=>{
      const current=input.repo.loadBidLadderUsdReset(input.ladderId),old=input.repo.loadBidLadder(priorChildId),oldReset=input.repo.loadBidLadderUsdReset(priorChildId);if(String(current?.phase)!=='BLOCKED'||String(current?.block_reason)!=='REPOSITION_JIT_REMATERIALIZATION_LIMIT_EXHAUSTED'||String(old?.status)!=='CANCELLED'||String(oldReset?.phase)!=='BLOCKED'||oldReset?.next_ladder_id)throw new Error('REPOSITION_RESUME_STATE_CHANGED');
      createV4BidLadderLive(input.repo,preview,Number(capital)/10**funding.decimals,{rootLadderId:String(current!.root_ladder_id),previousLadderId:priorChildId,generation,creationReason:'USDG_RESET_REPOSITION'});
      input.repo.transitionBidLadderUsdReset({ladderId:input.ladderId,from:'BLOCKED',to:'REOPEN_PLANNED',reopenWorkflowIdentity:preview.plan.ladderId,blockReason:null,nowMs:now});
    })();
    return {status:'RESUMED_REOPEN_PLANNED' as const,ladderId:input.ladderId,previousChildId:priorChildId,childId:preview.plan.ladderId,rootLadderId:String(sourceReset.root_ladder_id),generation,principalRaw:capital.toString(),depthBps:depth,jitAttemptsUsed:0,maxJitAttempts:V4_REPOSITION_MAX_JIT_REMATERIALIZATIONS,signingCount:0,broadcastCount:0};
  }finally{releaseV4BidLadderRepositionLease({repo:input.repo,ladderId:input.ladderId,ownerId});}
}

export function convergeBlockedRepositionOrphanChild(input:{repo:SqliteLedgerRepository;sourceLadderId:string;nowMs?:number}){
  const source=input.repo.loadBidLadderUsdReset(input.sourceLadderId),childId=source?activeRepositionChildId(source):undefined;
  if(!source||String(source.phase)!=='BLOCKED'||!childId)return {status:'NOT_ELIGIBLE' as const,sourceLadderId:input.sourceLadderId};
  const child=input.repo.loadBidLadder(childId),childReset=input.repo.loadBidLadderUsdReset(childId),legs=input.repo.listBidLadderLegs(childId),openBatch=input.repo.db.prepare("SELECT 1 FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='OPEN_BATCH' LIMIT 1").get(CHAIN_ID,childId),pending=input.repo.db.prepare("SELECT 1 FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND status IN ('PREPARED','SUBMITTED') LIMIT 1").get(CHAIN_ID,childId);
  if(String(child?.status)==='CANCELLED'&&String(childReset?.phase)==='BLOCKED')return {status:'ALREADY_CONVERGED' as const,sourceLadderId:input.sourceLadderId,childId};
  if(!child||String(child.status)!=='PLANNED'||String(childReset?.phase)!=='OPEN_PENDING'||legs.length!==5||legs.some(leg=>String(leg.status)!=='PLANNED'||leg.token_id||leg.open_batch_id)||openBatch||pending)return {status:'UNSAFE_TO_CONVERGE' as const,sourceLadderId:input.sourceLadderId,childId};
  const now=input.nowMs??Date.now(),reason=`REPOSITION_SOURCE_BLOCKED_PRE_OPEN:${String(source.root_ladder_id)}:${String(childReset?.generation)}:${String(source.block_reason??'UNKNOWN')}`;
  input.repo.db.transaction(()=>{if(input.repo.db.prepare("UPDATE v4_bid_ladders SET status='CANCELLED',terminal_reason=?,terminal_at_ms=?,updated_at_ms=?,revision=revision+1 WHERE ladder_id=? AND status='PLANNED'").run(reason,now,now,childId).changes!==1)throw new Error('REPOSITION_ORPHAN_CHILD_CONVERGENCE_CONFLICT');if(input.repo.db.prepare("UPDATE v4_bid_ladder_legs SET status='CANCELLED',updated_at_ms=? WHERE ladder_id=? AND status='PLANNED' AND token_id IS NULL AND open_batch_id IS NULL").run(now,childId).changes!==5)throw new Error('REPOSITION_ORPHAN_CHILD_CONVERGENCE_CONFLICT');input.repo.transitionBidLadderUsdReset({ladderId:childId,from:'OPEN_PENDING',to:'BLOCKED',blockReason:reason,nowMs:now});})();
  return {status:'CONVERGED' as const,sourceLadderId:input.sourceLadderId,childId,rootLadderId:String(source.root_ladder_id),generation:Number(childReset?.generation),blockReason:String(source.block_reason??'UNKNOWN')};
}

function convergeInvalidV4BidLadderUsdResetParentState(
  input: V4BidLadderUsdResetCycleInput,
  ladderId: string,
  nowMs: number,
) {
  const reset = input.repo.loadBidLadderUsdReset(ladderId),
    parent = input.repo.loadBidLadder(ladderId);
  if (!reset || !parent) return undefined;
  const phase = String(reset.phase) as V4BidLadderUsdResetPhase,
    parentStatus = String(parent.status),
    policy = v4BidLadderUsdResetParentStatePolicy(phase, parentStatus);
  if (policy.valid) return undefined;

  const block = (reason: string) => {
    input.repo.transitionBidLadderUsdReset({
      ladderId,
      from: phase,
      to: "BLOCKED",
      blockReason: reason,
      nowMs,
    });
    return { status: "BLOCKED" as const, ladderId, reason, parentState: policy };
  };

  if (parentStatus === "CANCELLED")
    return block(`REPOSITION_SOURCE_LADDER_CANCELLED:${phase}`);

  if (parentStatus === "CLOSED" && phase === "CLOSE_PREPARED") {
    try {
      confirmedCloseJournal(input.repo, ladderId);
      if (!manualAuthorization(reset.close_workflow_identity))
        return block("REPOSITION_DURABLE_MANUAL_AUTHORIZATION_MISSING");
      input.repo.transitionBidLadderUsdReset({
        ladderId,
        from: "CLOSE_PREPARED",
        to: "CLOSE_CONFIRMED",
        closeReason: "USDG_RESET_REPOSITION",
        closeWorkflowIdentity: String(reset.close_workflow_identity),
        nowMs,
      });
      return undefined;
    } catch (error) {
      return block(
        `REPOSITION_CLOSED_PREPARED_AUTHORITY_INVALID:${error instanceof Error ? error.message : "UNKNOWN"}`,
      );
    }
  }

  if (parentStatus === "CLOSED" && ["OPEN_PENDING", "WATCHING"].includes(phase)) {
    const provenance = String(parent.close_provenance ?? "");
    if (
      provenance === "EXTERNAL_OPERATOR_CLOSE" ||
      (provenance === "FUNI_EXECUTED" && !manualAuthorization(reset.close_workflow_identity))
    ) {
      input.repo.transitionBidLadderUsdReset({
        ladderId,
        from: phase,
        to: "OPERATOR_CLOSED",
        closeReason: "NORMAL_OPERATOR_CLOSE",
        closeWorkflowIdentity: ladderId,
        nowMs,
      });
      return {
        status: "OPERATOR_CLOSED" as const,
        ladderId,
        reason: "REPOSITION_SOURCE_OPERATOR_CLOSED",
        parentState: policy,
      };
    }
    if (provenance === "UNKNOWN_EXTERNAL")
      return block("EXTERNAL_OR_UNKNOWN_TERMINAL_ACCOUNTING_RECONCILIATION_REQUIRED");
  }

  if (
    parentStatus === "OPEN" &&
    ["CLOSE_CONFIRMED", "PRINCIPAL_RECONCILED", "REOPEN_PLANNED", "REOPEN_PREPARED", "REOPEN_SUBMITTED"].includes(phase)
  ) {
    try {
      confirmedCloseJournal(input.repo, ladderId);
      convergeTerminalV4BidLadder({
        repo: input.repo,
        ladderId,
        provenance: "FUNI_CLOSE_CONFIRMED",
        nowMs,
      });
      const converged = input.repo.loadBidLadder(ladderId);
      if (String(converged?.status) === "CLOSED") return undefined;
    } catch (error) {
      return block(
        `REPOSITION_POST_CLOSE_PARENT_CONVERGENCE_FAILED:${error instanceof Error ? error.message : "UNKNOWN"}`,
      );
    }
  }

  return block(`REPOSITION_PARENT_STATE_INVALID:${phase}:${parentStatus}`);
}

export async function processV4BidLadderUsdReset(
  input: V4BidLadderUsdResetCycleInput,
  ladderId: string,
) {
  const reset = input.repo.loadBidLadderUsdReset(ladderId),
    phase = String(reset?.phase ?? "MISSING"),
    terminal = ["COMPLETED", "BLOCKED", "OPERATOR_CLOSED"].includes(phase),
    needsOwnership = Boolean(input.manualAuthorizationIdentity) || [
      "CLOSE_PREPARED",
      "CLOSE_SUBMITTED",
      "CLOSE_CONFIRMED",
      "PRINCIPAL_RECONCILED",
      "REOPEN_PLANNED",
      "REOPEN_PREPARED",
      "REOPEN_SUBMITTED",
    ].includes(phase);
  if (!reset || terminal || !needsOwnership)
    return processV4BidLadderUsdResetOwned(input, ladderId);
  const ownerId = input.executionOwnerId ?? `reposition:${process.pid}:${randomUUID()}`,
    callerSource = input.callerSource ?? (input.manualAuthorizationIdentity ? "USER_CONFIRM" : "PERIODIC_RECOVERY"),
    leaseMs = input.executionLeaseMs ?? REPOSITION_EXECUTION_LEASE_MS,
    now = (input.nowMs ?? Date.now)(),
    acquired = acquireV4BidLadderRepositionLease({
      repo: input.repo,
      ladderId,
      ownerId,
      callerSource,
      nowMs: now,
      leaseMs,
    });
  repositionTelemetry(input, {
    ladderId,
    generation: Number(reset.generation),
    ownerId,
    callerSource,
    phaseAtAcquire: phase,
    leaseAcquireResult: acquired.result,
    leaseAcquiredAt: "acquiredAt" in acquired ? acquired.acquiredAt : null,
    leaseUntil: "leaseUntil" in acquired ? acquired.leaseUntil : null,
    activeOwnerId: "currentOwnerId" in acquired ? acquired.currentOwnerId : ownerId,
    activeCallerSource: "currentCallerSource" in acquired ? acquired.currentCallerSource : callerSource,
    concurrentConsumerSuppressed: acquired.result === "ALREADY_PROGRESSING",
  });
  if (acquired.result !== "ACQUIRED")
    return {
      status: acquired.result === "NOT_FOUND" ? "DISABLED" as const : "ALREADY_PROGRESSING" as const,
      ladderId,
      ownerId: acquired.result === "ALREADY_PROGRESSING" ? acquired.currentOwnerId : undefined,
      leaseUntil: "leaseUntil" in acquired ? acquired.leaseUntil : undefined,
      concurrentConsumerSuppressed: acquired.result === "ALREADY_PROGRESSING",
    };
  const ownedInput: V4BidLadderUsdResetCycleInput = {
      ...input,
      callerSource,
      executionOwnerId: ownerId,
      executionLease: { ownerId, leaseMs },
    },
    heartbeatMs = Math.max(10, Math.floor(leaseMs / 3)),
    heartbeat = setInterval(() => {
      const renewed = renewV4BidLadderRepositionLease({
        repo: input.repo,
        ladderId,
        ownerId,
        nowMs: (input.nowMs ?? Date.now)(),
        leaseMs,
      });
      if (!renewed) clearInterval(heartbeat);
    }, heartbeatMs);
  heartbeat.unref?.();
  try {
    return await processV4BidLadderUsdResetOwned(ownedInput, ladderId);
  } finally {
    clearInterval(heartbeat);
    releaseV4BidLadderRepositionLease({ repo: input.repo, ladderId, ownerId });
  }
}

async function processV4BidLadderUsdResetOwned(
  input: V4BidLadderUsdResetCycleInput,
  ladderId: string,
) {
  const now = (input.nowMs ?? Date.now)();
  const confirmAtMs=input.confirmAtMs??now,componentStartedAtMs=Date.now();
  let preflightEndedAtMs:number|undefined,closeConfirmedAtMs:number|undefined,principalReconciledAtMs:number|undefined,childPlannedAtMs:number|undefined;
  let reset = input.repo.loadBidLadderUsdReset(ladderId);
  if (!reset) return { status: "DISABLED" as const, ladderId };
  if (["COMPLETED", "BLOCKED", "OPERATOR_CLOSED"].includes(String(reset.phase))) {
    const orphan=String(reset.phase)==='BLOCKED'?convergeBlockedRepositionOrphanChild({repo:input.repo,sourceLadderId:ladderId,nowMs:now}):undefined;
    return { status: String(reset.phase), ladderId, ...(orphan?{orphan}: {}) };
  }
  assertV4BidLadderRepositionLease(input, ladderId);
  const parentConvergence = convergeInvalidV4BidLadderUsdResetParentState(
    input,
    ladderId,
    now,
  );
  if (parentConvergence) return parentConvergence;
  reset = input.repo.loadBidLadderUsdReset(ladderId);
  if (!reset) return { status: "DISABLED" as const, ladderId };
  if (String(reset.phase) === "OPEN_PENDING")
    return { status: "OPEN_PENDING" as const, ladderId };
  if (String(reset.phase) === "WATCHING") {
    const inspect = input.readTruth ?? readV4BidLadderUsdResetTruth,
      first = await inspect({ ...input, ladderId, nowMs: now });
    preflightEndedAtMs=Date.now();
    if (!first.eligible) return input.manualAuthorizationIdentity
      ? { status: "ABORTED_PRE_SIGN" as const, ladderId, blockers: first.blockers, signingUsed: false, broadcastUsed: false }
      : { status: "WATCHING" as const, ladderId, blockers: first.blockers };
    if (!input.manualAuthorizationIdentity)
      return {
        status: "ELIGIBLE" as const,
        ladderId,
        usdgPrincipal: first.usdgPrincipal,
        signingUsed: false,
        broadcastUsed: false,
      };
    if (!manualAuthorization(input.manualAuthorizationIdentity))
      throw new Error("REPOSITION_MANUAL_AUTHORIZATION_INVALID");
    const sourceContext=await input.context(ladderId),allowance=await (input.readAllowanceReadiness??v4BidLadderFundingAllowanceReadiness)({...sourceContext,fundingAmount:first.usdgPrincipal});
    if(!allowance.ready)return {status:'PREPARE_ALLOWANCE_REQUIRED' as const,ladderId,blockers:allowance.blockers,signingUsed:false,broadcastUsed:false};
    notifyWithoutBlocking(input,`USDG Reset Reposition · READY\nOld ladder: ${ladderId}\nPrincipal: USDG-only\nDepth retained: -${input.repo.v4BidLadderStrategyDepthBps(ladderId) / 100}%`);
    assertV4BidLadderRepositionLease(input, ladderId);
    await (input.executeClose ?? executeV4BidLadderManualClose)({
      ...sourceContext,
      walletClient: input.walletClient(),
      closeReason: "USDG_RESET_REPOSITION",
      manualRepositionAuthorization: input.manualAuthorizationIdentity,
    });
    const closeJournal=input.repo.db.prepare("SELECT confirmed_at FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='CLOSE_BATCH' AND status='CONFIRMED' ORDER BY attempt DESC LIMIT 1").get(CHAIN_ID,ladderId) as {confirmed_at:string}|undefined;
    closeConfirmedAtMs=closeJournal?.confirmed_at?Date.parse(closeJournal.confirmed_at):Date.now();
    reset = input.repo.loadBidLadderUsdReset(ladderId);
    if (input.returnAfterCloseReceipt && confirmedCloseReceiptExists(input.repo, ladderId))
      return { status: "CLOSE_CONFIRMED_PREPARING_REPLACEMENT" as const, ladderId, durableContinuation: true as const };
  }
  if (
    [
      "CLOSE_PREPARED",
      "CLOSE_SUBMITTED",
      "CLOSE_CONFIRMED",
      "PRINCIPAL_RECONCILED",
      "REOPEN_PLANNED",
      "REOPEN_PREPARED",
      "REOPEN_SUBMITTED",
    ].includes(String(reset?.phase)) &&
    !manualAuthorization(reset?.close_workflow_identity)
  )
    throw new Error("REPOSITION_DURABLE_MANUAL_AUTHORIZATION_MISSING");
  if (["CLOSE_PREPARED", "CLOSE_SUBMITTED"].includes(String(reset?.phase))) {
    const failed = input.repo.db
      .prepare(
        "SELECT status,receipt_json FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='CLOSE_BATCH' ORDER BY attempt DESC LIMIT 1",
      )
      .get(CHAIN_ID, ladderId) as Record<string, unknown> | undefined;
    if (String(failed?.status) === "FAILED") {
      input.repo.transitionBidLadderUsdReset({
        ladderId,
        from: String(reset!.phase) as V4BidLadderUsdResetPhase,
        to: "BLOCKED",
        blockReason: failed?.receipt_json
          ? "REPOSITION_CLOSE_CONFIRMED_REVERT"
          : "REPOSITION_CLOSE_FAILED_WITHOUT_FINAL_RECEIPT",
      });
      return {
        status: "BLOCKED" as const,
        ladderId,
        reason: failed?.receipt_json
          ? "REPOSITION_CLOSE_CONFIRMED_REVERT"
          : "REPOSITION_CLOSE_FAILED_WITHOUT_FINAL_RECEIPT",
      };
    }
    assertV4BidLadderRepositionLease(input, ladderId);
    await (input.executeClose ?? executeV4BidLadderManualClose)({
      ...(await input.context(ladderId)),
      walletClient: input.walletClient(),
      closeReason: "USDG_RESET_REPOSITION",
    });
    reset = input.repo.loadBidLadderUsdReset(ladderId);
    if (input.returnAfterCloseReceipt && confirmedCloseReceiptExists(input.repo, ladderId))
      return { status: "CLOSE_CONFIRMED_PREPARING_REPLACEMENT" as const, ladderId, durableContinuation: true as const };
  }
  if (String(reset?.phase) === "CLOSE_CONFIRMED") {
    assertV4BidLadderRepositionLease(input, ladderId);
    const reconcilePrincipal = input.reconcilePrincipal ?? reconcileV4BidLadderUsdResetPrincipal,
      amounts = await reconcilePrincipal({ ...input, ladderId });
    principalReconciledAtMs=Date.now();
    const principalTransitionResult = "transitionResult" in amounts
      ? amounts.transitionResult
      : "APPLIED";
    repositionTelemetry(input, {
      ladderId,
      generation: Number(reset?.generation ?? 0),
      ownerId: input.executionLease?.ownerId ?? null,
      callerSource: input.callerSource ?? null,
      phaseAtAcquire: "CLOSE_CONFIRMED",
      transition: "CLOSE_CONFIRMED_TO_PRINCIPAL_RECONCILED",
      transitionResult: principalTransitionResult,
      duplicateNotificationSuppressed: principalTransitionResult !== "APPLIED",
    });
    if (principalTransitionResult === "APPLIED")
      notifyWithoutBlocking(input,`USDG Reset Reposition · CLOSED\nReturned principal: ${amounts.returnedUsdgPrincipal} raw USDG\nFees excluded from redeploy.`);
    reset = input.repo.loadBidLadderUsdReset(ladderId);
  }
  if (String(reset?.phase) === "BLOCKED")
    return { status: "BLOCKED" as const, ladderId, reason: reset?.block_reason };
  let childId = activeRepositionChildId(reset);
  if(String(reset?.phase)==='PRINCIPAL_RECONCILED'){
    if(!reset) throw new Error('REPOSITION_RESET_NOT_FOUND');
    if(BigInt(String(reset.returned_target_principal_raw??'-1'))!==0n){input.repo.transitionBidLadderUsdReset({ladderId,from:'PRINCIPAL_RECONCILED',to:'BLOCKED',blockReason:'REPOSITION_BLOCKED_NON_USDG_PRINCIPAL'});return {status:'BLOCKED' as const,ladderId,reason:'REPOSITION_BLOCKED_NON_USDG_PRINCIPAL'};}
    const returned=BigInt(String(reset.returned_usdg_principal_raw??'0')),sourceContext=await input.context(ladderId),allowance=await (input.readAllowanceReadiness??v4BidLadderFundingAllowanceReadiness)({...sourceContext,fundingAmount:returned});
    if(!allowance.ready){input.repo.transitionBidLadderUsdReset({ladderId,from:'PRINCIPAL_RECONCILED',to:'BLOCKED',blockReason:'REPOSITION_POST_CONFIRM_APPROVAL_REQUIRED'});return {status:'BLOCKED' as const,ladderId,reason:'REPOSITION_POST_CONFIRM_APPROVAL_REQUIRED'};}
  }
  if (String(reset?.phase) === "PRINCIPAL_RECONCILED") {
    try {
      assertV4BidLadderRepositionLease(input, ladderId);
      const createChild = input.planChild ?? planChild;
      childId = await createChild({ ...input, ladderId, nowMs: (input.nowMs ?? Date.now)() });
      childPlannedAtMs=Date.now();
    } catch (error) {
      const failure = classifyV4BidLadderRepositionExecutionError(error);
      repositionTelemetry(input, {
        ladderId,
        generation: Number(reset?.generation ?? 0),
        ownerId: input.executionLease?.ownerId ?? null,
        callerSource: input.callerSource ?? null,
        phaseAtAcquire: "PRINCIPAL_RECONCILED",
        classification: failure.classification,
        errorCode: failure.code,
      });
      if (failure.classification === "RETRYABLE")
        return { status: "RECOVERY_REQUIRED" as const, ladderId, reason: failure.code };
      const blocked = transitionV4BidLadderUsdResetOnce({
        repo: input.repo,
        ladderId,
        from: "PRINCIPAL_RECONCILED",
        to: "BLOCKED",
        blockReason: failure.code,
      });
      return blocked.result === "APPLIED"
        ? { status: "BLOCKED" as const, ladderId, reason: failure.code }
        : { status: "ALREADY_PROGRESSING" as const, ladderId, concurrentConsumerSuppressed: true };
    }
    reset = input.repo.loadBidLadderUsdReset(ladderId);
  }
  if (["REOPEN_PLANNED", "REOPEN_PREPARED", "REOPEN_SUBMITTED"].includes(String(reset?.phase))) {
    childId = childId ?? activeRepositionChildId(reset) ?? "";
    if (!childId) throw new Error("REPOSITION_CHILD_MISSING");
    try {
      assertV4BidLadderRepositionLease(input, ladderId);
      const executeOpen = input.executeOpen ?? executeV4BidLadderLiveOpen,jitStartedAtMs=(input.nowMs??Date.now)();
      let opened;
      for(;;){
        try{opened=await executeOpen({...(await input.context(childId)),walletClient:input.walletClient(),requirePreapprovedFunding:true});break;}
        catch(error){
          const message=error instanceof Error?error.message:String(error),failureCode=message.startsWith('V4_BID_LADDER_LEG_NOT_FUNDING_ONLY')?'V4_BID_LADDER_LEG_NOT_FUNDING_ONLY' as const:message.startsWith('V4_BID_LADDER_MINT_ESTIMATE_FAILED')?'V4_BID_LADDER_MINT_ESTIMATE_FAILED' as const:undefined;
          if(!failureCode)throw error;
          const drift=await childFundingOnlyDrift({repo:input.repo,rpc:input.rpc,childId});if(!drift.drifted)throw error;
          assertV4BidLadderRepositionLease(input,ladderId);
          try{
            const rematerialized=await rematerializeV4BidLadderRepositionChildOnce({repo:input.repo,rpc:input.rpc,ladderId,childId,wallet:input.wallet,nowMs:(input.nowMs??Date.now)(),failureCode,pool:drift.pool});
            repositionTelemetry(input,{ladderId,childId,generation:Number(input.repo.loadBidLadderUsdReset(childId)?.generation),ownerId:input.executionLease?.ownerId??null,callerSource:input.callerSource??null,jitAttempt:rematerialized.rematerializations,maxJitAttempts:V4_REPOSITION_MAX_JIT_REMATERIALIZATIONS,freshReferenceTick:rematerialized.referenceTick,freshReferenceBlock:rematerialized.referenceBlock.toString(),preflightFailureClass:failureCode,elapsedMs:(input.nowMs??Date.now)()-jitStartedAtMs});
          }catch(rematerializationError){
            if(rematerializationError instanceof Error&&rematerializationError.message==='REPOSITION_JIT_REMATERIALIZATION_LIMIT_EXHAUSTED')repositionTelemetry(input,{ladderId,childId,generation:Number(input.repo.loadBidLadderUsdReset(childId)?.generation),ownerId:input.executionLease?.ownerId??null,callerSource:input.callerSource??null,jitAttempt:Number(input.repo.loadBidLadderUsdReset(childId)?.jit_rematerialization_attempts??0),maxJitAttempts:V4_REPOSITION_MAX_JIT_REMATERIALIZATIONS,preflightFailureClass:failureCode,jitBudgetExhausted:true,elapsedMs:(input.nowMs??Date.now)()-jitStartedAtMs});
            throw rematerializationError;
          }
        }
      }
      const latest = input.repo.loadBidLadderUsdReset(ladderId)!;
      const completion = ["REOPEN_PLANNED", "REOPEN_PREPARED", "REOPEN_SUBMITTED"].includes(String(latest.phase))
        ? transitionV4BidLadderUsdResetOnce({
          repo: input.repo,
          ladderId,
          from: String(latest.phase) as V4BidLadderUsdResetPhase,
          to: "COMPLETED",
          reopenWorkflowIdentity: childId,
        })
        : { result: "ALREADY_ADVANCED" as const, row: latest };
      repositionTelemetry(input, {
        ladderId,
        generation: Number(latest.generation),
        ownerId: input.executionLease?.ownerId ?? null,
        callerSource: input.callerSource ?? null,
        phaseAtAcquire: String(latest.phase),
        transition: "REOPEN_TO_COMPLETED",
        transitionResult: completion.result,
        duplicateNotificationSuppressed: completion.result !== "APPLIED",
      });
      const child = input.repo.loadBidLadderUsdReset(childId);
      const completedAtMs=Date.now(),journalRows=input.repo.db.prepare("SELECT semantic_stage,created_at,submitted_at,confirmed_at FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity IN (?,?) AND semantic_stage IN ('CLOSE_BATCH','OPEN_ERC20_APPROVAL','OPEN_PERMIT2_APPROVAL','OPEN_BATCH') ORDER BY created_at").all(CHAIN_ID,ladderId,childId) as Array<{semantic_stage:string;created_at:string;submitted_at:string|null;confirmed_at:string|null}>,stage=(name:string)=>journalRows.find(row=>row.semantic_stage===name),close=stage('CLOSE_BATCH'),erc20=stage('OPEN_ERC20_APPROVAL'),permit2=stage('OPEN_PERMIT2_APPROVAL'),open=stage('OPEN_BATCH'),childOpenConfirmedAtMs=open?.confirmed_at?Date.parse(open.confirmed_at):completedAtMs,context={ladderId,childId,confirm_at:confirmAtMs,close_prepare_at:close?.created_at?Date.parse(close.created_at):null,close_submit_at:close?.submitted_at?Date.parse(close.submitted_at):null,close_confirmed_at:closeConfirmedAtMs??(close?.confirmed_at?Date.parse(close.confirmed_at):null),principal_reconciled_at:principalReconciledAtMs??null,child_planned_at:childPlannedAtMs??null,erc20_approval_prepare_at:erc20?.created_at?Date.parse(erc20.created_at):null,erc20_approval_confirmed_at:erc20?.confirmed_at?Date.parse(erc20.confirmed_at):null,permit2_prepare_at:permit2?.created_at?Date.parse(permit2.created_at):null,permit2_confirmed_at:permit2?.confirmed_at?Date.parse(permit2.confirmed_at):null,child_open_prepare_at:open?.created_at?Date.parse(open.created_at):null,child_open_submit_at:open?.submitted_at?Date.parse(open.submitted_at):null,child_open_confirmed_at:childOpenConfirmedAtMs,completed_at:completedAtMs,total_ms:childOpenConfirmedAtMs-confirmAtMs,sla:childOpenConfirmedAtMs-confirmAtMs<10_000?'PASS':'FAIL',preflight_ms:(preflightEndedAtMs??componentStartedAtMs)-componentStartedAtMs,close_ms:(closeConfirmedAtMs??componentStartedAtMs)-(preflightEndedAtMs??componentStartedAtMs),principal_ms:(principalReconciledAtMs??closeConfirmedAtMs??componentStartedAtMs)-(closeConfirmedAtMs??componentStartedAtMs),child_plan_ms:(childPlannedAtMs??principalReconciledAtMs??componentStartedAtMs)-(principalReconciledAtMs??componentStartedAtMs),child_open_ms:childOpenConfirmedAtMs-(childPlannedAtMs??childOpenConfirmedAtMs),internal_orchestration_ms:completedAtMs-componentStartedAtMs};
      if(input.confirmAtMs!==undefined)try{input.repo.recordLatency('v4_bid_ladder_reposition_sla',context.total_ms,{context});}catch{}
      if (completion.result === "APPLIED")
        notifyWithoutBlocking(input,`USDG Reset Reposition · OPEN\nNew ladder: ${childId}\nDepth: -${input.repo.v4BidLadderStrategyDepthBps(childId) / 100}%\nGeneration: ${child?.generation}`);
      return { status: "COMPLETED" as const, ladderId, childId, opened };
    } catch (error) {
      const journal = input.repo.db
        .prepare("SELECT status FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND status IN ('PREPARED','SUBMITTED') LIMIT 1")
        .get(CHAIN_ID, childId);
      if (journal) return { status: "RECOVERY_REQUIRED" as const, ladderId, childId };
      const confirmed = input.repo.db
        .prepare("SELECT 1 FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='OPEN_BATCH' AND status='CONFIRMED' LIMIT 1")
        .get(CHAIN_ID, childId);
      if (confirmed)
        return { status: "RECOVERY_REQUIRED" as const, ladderId, childId };
      const failure = classifyV4BidLadderRepositionExecutionError(error),
        latest = input.repo.loadBidLadderUsdReset(ladderId)!;
      repositionTelemetry(input, {
        ladderId,
        generation: Number(latest.generation),
        ownerId: input.executionLease?.ownerId ?? null,
        callerSource: input.callerSource ?? null,
        phaseAtAcquire: String(latest.phase),
        classification: failure.classification,
        errorCode: failure.code,
      });
      if (failure.classification === "RETRYABLE")
        return { status: "RECOVERY_REQUIRED" as const, ladderId, childId, reason: failure.code };
      const blocked = ["REOPEN_PLANNED", "REOPEN_PREPARED", "REOPEN_SUBMITTED"].includes(String(latest.phase))
        ? transitionV4BidLadderUsdResetOnce({
          repo: input.repo,
          ladderId,
          from: String(latest.phase) as V4BidLadderUsdResetPhase,
          to: "BLOCKED",
          blockReason: failure.code,
        })
        : { result: "ALREADY_ADVANCED" as const, row: latest };
      if (blocked.result !== "APPLIED")
        return { status: "ALREADY_PROGRESSING" as const, ladderId, childId, concurrentConsumerSuppressed: true };
      const orphan=convergeBlockedRepositionOrphanChild({repo:input.repo,sourceLadderId:ladderId,nowMs:(input.nowMs??Date.now)()});
      await input.notify?.(`USDG Reset Reposition · BLOCKED\nReason: ${failure.code}`);
      return { status: "BLOCKED" as const, ladderId, childId, reason: failure.code, orphan };
    }
  }
  return { status: String(input.repo.loadBidLadderUsdReset(ladderId)?.phase), ladderId, childId };
}

const terminalResetPhases = new Set(["COMPLETED", "BLOCKED", "OPERATOR_CLOSED"]);

export function classifyV4BidLadderUsdResetCandidateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error),
    code = (message.split(":", 1)[0] || "REPOSITION_CANDIDATE_UNKNOWN_ERROR").slice(0, 160),
    deterministic = /(?:DURABLE_MANUAL_AUTHORIZATION|PARENT_STATE_INVALID|SOURCE_LADDER_CANCELLED|POOL_IDENTITY_MISMATCH|FUNDING_NOT_USDG|LEG_SET_INVALID|TOKEN_METADATA_INVALID|PRINCIPAL_EXCEEDS_RECEIPT_TRANSFER|CLOSE_PREPARED_EVIDENCE_MISSING|CLOSE_RECEIPT_INVALID|CLOSE_NOT_FIVE_LEGS|NATIVE_TRANSFER_UNSUPPORTED|CHILD_MISSING|SAME_BLOCK_LATER_SWAP_AMBIGUOUS|EXECUTION_PRICE_EVIDENCE_MISMATCH)/.test(
      code,
    );
  return {
    classification: deterministic ? ("DETERMINISTIC_TERMINAL" as const) : ("RETRYABLE" as const),
    code,
    message: message.slice(0, 300),
  };
}

function rotateV4BidLadderUsdResetCandidate(
  repo: SqliteLedgerRepository,
  ladderId: string,
  updatedAtMs: number,
  retryReason: string | null,
) {
  return repo.db
    .prepare(
      "UPDATE v4_bid_ladder_usdg_reset_v1 SET block_reason=?,revision=revision+1,updated_at_ms=? WHERE ladder_id=? AND phase NOT IN ('COMPLETED','BLOCKED','OPERATOR_CLOSED')",
    )
    .run(retryReason, updatedAtMs, ladderId).changes;
}

/** The existing updated_at ordering is the durable round-robin cursor. Every
 * attempted nonterminal row moves behind the current population, including
 * passive and retryable rows, so no fixed LIMIT window can monopolize service. */
export async function runV4BidLadderUsdResetCycle(input: V4BidLadderUsdResetCycleInput) {
  const cycleNow=(input.nowMs??Date.now)(),orphanRows=input.repo.db.prepare("SELECT ladder_id FROM v4_bid_ladder_usdg_reset_v1 WHERE phase='BLOCKED' AND next_ladder_id IS NOT NULL ORDER BY updated_at_ms LIMIT 4").all() as Array<{ladder_id:string}>,orphanConvergence=orphanRows.map(row=>convergeBlockedRepositionOrphanChild({repo:input.repo,sourceLadderId:row.ladder_id,nowMs:cycleNow})),
    rows = input.repo.listBidLadderUsdResetCandidates(8).filter(row=>!input.repo.db.prepare("SELECT 1 FROM v4_bid_ladder_usdg_reset_execution_leases WHERE ladder_id=? AND lease_until_ms>?").get(row.ladder_id,cycleNow)).slice(0,4),
    maximum = input.repo.db
      .prepare("SELECT COALESCE(MAX(updated_at_ms),0) value FROM v4_bid_ladder_usdg_reset_v1")
      .get() as { value: number },
    tail = Math.max(cycleNow, Number(maximum.value) + 1),
    results: Record<string, unknown>[] = orphanConvergence.map(result=>({...result,cycleOutcome:'ORPHAN_CONVERGENCE'}));
  for (let index = 0; index < rows.length; index++) {
    const ladderId = String(rows[index]!.ladder_id);
    try {
      const result = await processV4BidLadderUsdReset(input, ladderId),
        latest = input.repo.loadBidLadderUsdReset(ladderId),
        nonterminal = latest && !terminalResetPhases.has(String(latest.phase)),
        retryReason = String(result.status) === "RECOVERY_REQUIRED"
          ? "REPOSITION_RECOVERY_REQUIRED"
          : null,
        rotated = nonterminal
          ? rotateV4BidLadderUsdResetCandidate(input.repo, ladderId, tail + index, retryReason)
          : 0;
      results.push({ ...result, cycleOutcome: "PROCESSED", fairnessRotated: rotated === 1 });
    } catch (error) {
      const failure = classifyV4BidLadderUsdResetCandidateError(error),
        latest = input.repo.loadBidLadderUsdReset(ladderId),
        phase = String(latest?.phase ?? "MISSING");
      if (latest && !terminalResetPhases.has(phase) && failure.classification === "DETERMINISTIC_TERMINAL") {
        try {
          input.repo.transitionBidLadderUsdReset({
            ladderId,
            from: phase as V4BidLadderUsdResetPhase,
            to: "BLOCKED",
            blockReason: failure.code,
            nowMs: tail + index,
          });
          results.push({
            status: "FAILED_TERMINAL",
            ladderId,
            phase,
            ...failure,
            durableOutcome: "BLOCKED",
          });
          continue;
        } catch (convergenceError) {
          results.push({
            status: "FAILED_RETRYABLE",
            ladderId,
            phase,
            ...failure,
            classification: "RETRYABLE",
            convergenceError: convergenceError instanceof Error ? convergenceError.message.slice(0, 300) : String(convergenceError),
          });
          continue;
        }
      }
      const rotated = latest && !terminalResetPhases.has(phase)
        ? rotateV4BidLadderUsdResetCandidate(input.repo, ladderId, tail + index, `RETRYABLE:${failure.code}`)
        : 0;
      results.push({
        status: "FAILED_RETRYABLE",
        ladderId,
        phase,
        ...failure,
        fairnessRotated: rotated === 1,
      });
    }
  }
  return results;
}
