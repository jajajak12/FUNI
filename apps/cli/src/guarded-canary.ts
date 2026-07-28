import {
  decodeEventLog,
  keccak256,
  type Address,
  type Hash,
  type WalletClient,
} from 'viem';
import {
  auditRobinhoodV3Deployments,
  auditRobinhoodV3PinnedTestSnapshot,
  erc20Abi,
  FallbackRpc,
  inspectV3Pool,
  type PinnedSnapshotVerificationInput,
} from '@robin/core';
import {
  buildApproval,
  buildMint,
  presentPool,
  resolveSingleSidedRoles,
  singleSidedDownsideQuote,
  simulateBuiltTransaction,
} from '@robin/v3';
import { SqliteLedgerRepository } from '@robin/ledger';

const events = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: true, name: 'tokenId', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'IncreaseLiquidity',
    inputs: [
      { indexed: true, name: 'tokenId', type: 'uint256' },
      { indexed: false, name: 'liquidity', type: 'uint128' },
      { indexed: false, name: 'amount0', type: 'uint256' },
      { indexed: false, name: 'amount1', type: 'uint256' },
    ],
  },
] as const;

export type CanaryGateInput = {
  executionEnabled: boolean;
  dryRun: boolean;
  emergencyPause: boolean;
  liveCanaryEnabled: boolean;
  allowlisted: boolean;
  signerConfigured: boolean;
  chainId: number;
  deploymentVerified: boolean;
  positionUsd: number;
  approvalUsd: number;
  maxPositionUsd: number;
  maxApprovalUsd: number;
  pendingExecutions: number;
  budgetAvailable: boolean;
  openPositions: number;
  maxOpenPositions: number;
};

export function canaryGate(x: CanaryGateInput): string | undefined {
  if (!x.executionEnabled) return 'EXECUTION_ENABLED is false';
  if (x.dryRun) return 'DRY_RUN is true';
  if (x.emergencyPause) return 'EMERGENCY_PAUSE is true';
  if (!x.liveCanaryEnabled) return 'LIVE_CANARY_ENABLED is false';
  if (!x.allowlisted) return 'operator is not allowlisted';
  if (!x.signerConfigured) return 'protected signer is not configured';
  if (x.chainId !== 4663) return 'wrong chain';
  if (!x.deploymentVerified) return 'deployment registry is not verified';
  if (x.positionUsd > x.maxPositionUsd) return 'position value cap exceeded';
  if (x.approvalUsd > x.maxApprovalUsd) return 'approval value cap exceeded';
  if (x.pendingExecutions > 0) return 'pending execution exists';
  if (!x.budgetAvailable) return 'persistent canary budget is unavailable';
  if (x.openPositions >= x.maxOpenPositions) return 'LIVE_CANARY_MAX_OPEN_POSITIONS reached';
}

export type CanaryRangeSnapshot = {
  tick: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  calldataHash: Hash;
};

export type GuardedCanaryHookContext = {
  intentId: string;
  client: any;
  walletClient: WalletClient;
  pool: Address;
  preview: CanaryRangeSnapshot;
  approvalHash?: Hash;
  refreshed?: CanaryRangeSnapshot;
  mintHash?: Hash;
};

export type GuardedCanaryHooks = {
  afterApprovalConfirmed?: (context: GuardedCanaryHookContext) => Promise<void> | void;
  beforeApprovalReceiptWait?: (context: GuardedCanaryHookContext) => Promise<void> | void;
  beforeMintReceiptWait?: (context: GuardedCanaryHookContext) => Promise<void> | void;
  beforeFinalMintSimulation?: (context: GuardedCanaryHookContext) => Promise<void> | void;
};

export type GuardedCanaryInput = {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  walletClient: WalletClient;
  wallet: Address;
  owner: string;
  pool: Address;
  target: { address: Address; symbol: string; decimals: number };
  funding: { address: Address; symbol: string; decimals: number };
  fundingAmount: bigint;
  upperDropPct: number;
  lowerDropPct: number;
  slippageBps: number;
  deadlineSeconds: number;
  maxGasUsd: number;
  gasUsdPerNative: number;
  intentId: string;
  notify: (message: string) => Promise<void>;
  hooks?: GuardedCanaryHooks;
  /** Dependency-injected only by isolated fork harnesses; never populated by runtime or Telegram configuration. */
  pinnedDeploymentSnapshot?: PinnedSnapshotVerificationInput;
};

export class ReceiptWaitInterrupted extends Error {
  constructor(readonly phase: 'APPROVAL' | 'MINT', message = 'deterministic receipt wait interruption') {
    super(message);
    this.name = 'ReceiptWaitInterrupted';
  }
}

type FreshMint = Awaited<ReturnType<typeof prepareFreshMint>>;

function verifyDeployments(input:GuardedCanaryInput){
 return input.pinnedDeploymentSnapshot
  ? auditRobinhoodV3PinnedTestSnapshot(input.rpc,input.pinnedDeploymentSnapshot)
  : auditRobinhoodV3Deployments(input.rpc);
}

async function prepareFreshMint(
  input: GuardedCanaryInput,
  client: any,
  deployments: any,
) {
  const raw = await inspectV3Pool(input.rpc, input.pool);
  if (raw.status === 'unavailable') throw new Error(raw.reason);
  const shown = await presentPool(input.rpc, raw.value);
  if (shown.status === 'unavailable') throw new Error(shown.reason);
  const view = shown.value;
  if (view.pool.factory.toLowerCase() !== deployments.factory.toLowerCase()) throw new Error('POOL_SELECTION_MISMATCH');
  if (!view.pool.initialized) throw new Error('STALE_POOL_SELECTION');
  if (view.pool.liquidity <= 0n) throw new Error('POOL_ZERO_ACTIVE_LIQUIDITY');
  const roles = resolveSingleSidedRoles({
    target: input.target,
    funding: input.funding,
    token0: view.token0,
    token1: view.token1,
  });
  const price = roles.targetIndex === 0
    ? view.priceToken1PerToken0
    : 1 / view.priceToken1PerToken0;
  const quote = singleSidedDownsideQuote(view.pool, roles, input.fundingAmount, {
    currentDisplayedPrice: price,
    upperDropPct: input.upperDropPct,
    lowerDropPct: input.lowerDropPct,
  });
  const targetDesired = roles.targetIndex === 0
    ? quote.amount0Desired
    : quote.amount1Desired;
  if (
    quote.liquidity <= 0n
    || targetDesired !== 0n
    || quote.amount0Desired + quote.amount1Desired !== input.fundingAmount
  ) throw new Error('RANGE_NOT_STRICTLY_SINGLE_SIDED');
  const block = await client.getBlock();
  const slippage = BigInt(input.slippageBps);
  const mint = buildMint(deployments, {
    token0: view.token0.address,
    token1: view.token1.address,
    fee: view.pool.fee,
    tickLower: quote.tickLower,
    tickUpper: quote.tickUpper,
    amount0Desired: quote.amount0Desired,
    amount1Desired: quote.amount1Desired,
    amount0Min: quote.amount0Desired * (10_000n - slippage) / 10_000n,
    amount1Min: quote.amount1Desired * (10_000n - slippage) / 10_000n,
    recipient: input.wallet,
    deadline: block.timestamp + BigInt(input.deadlineSeconds),
  });
  const snapshot: CanaryRangeSnapshot = {
    tick: view.pool.tick,
    tickLower: quote.tickLower,
    tickUpper: quote.tickUpper,
    amount0Desired: quote.amount0Desired,
    amount1Desired: quote.amount1Desired,
    calldataHash: keccak256(mint.data),
  };
  return { view, quote, mint, snapshot };
}

function stop(repo: SqliteLedgerRepository, id: string, phase: string, error: unknown) {
  const reason = `${phase}: ${error instanceof Error ? error.message : String(error)}`;
  repo.transitionCanaryIntent(id, 'FAILED', { failureReason: reason });
  return reason;
}

function parseMintReceipt(receipt: any, positionManager: Address) {
  let tokenId: bigint | undefined;
  let amount0: bigint | undefined;
  let amount1: bigint | undefined;
  for (const log of receipt.logs as any[]) {
    if (log.address.toLowerCase() !== positionManager.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: events, data: log.data, topics: log.topics as any });
      if (event.eventName === 'Transfer') tokenId = event.args.tokenId;
      if (event.eventName === 'IncreaseLiquidity') {
        amount0 = event.args.amount0;
        amount1 = event.args.amount1;
      }
    } catch {
      // Other Position Manager events are deliberately ignored.
    }
  }
  return { tokenId, amount0, amount1 };
}

async function enrollMint(
  input: GuardedCanaryInput,
  deployments: any,
  fresh: FreshMint,
  simulationGas: bigint,
  mintHash: Hash,
  receipt: any,
) {
  const parsed = parseMintReceipt(receipt, deployments.positionManager);
  if (
    !parsed.tokenId
    || parsed.amount0 !== fresh.quote.amount0Desired
    || parsed.amount1 !== fresh.quote.amount1Desired
  ) throw new Error('mint receipt violates funding-only invariant');
  const positionId = `live:${parsed.tokenId}`;
  input.repo.ensurePosition(positionId, parsed.tokenId.toString(), input.pool);
  input.repo.persistStrategyPosition({
    positionId,
    strategyMode: 'SINGLE_SIDED_DOWNSIDE',
    targetToken: input.target.address,
    fundingToken: input.funding.address,
    upperDropPct: input.upperDropPct,
    lowerDropPct: input.lowerDropPct,
    requestedUpperPrice: fresh.quote.requestedUpperPrice,
    requestedLowerPrice: fresh.quote.requestedLowerPrice,
    actualUpperPrice: fresh.quote.actualUpperPrice,
    actualLowerPrice: fresh.quote.actualLowerPrice,
    tickLower: fresh.quote.tickLower,
    tickUpper: fresh.quote.tickUpper,
    initialFundingRaw: input.fundingAmount,
    targetDesiredRaw: 0n,
    fundingDesiredRaw: input.fundingAmount,
    benchmarkAsset: input.funding.address,
    intent: { intentId: input.intentId },
    simulation: { gas: simulationGas },
  });
  input.repo.ingestDeposit({
    id: `mint:${mintHash}`,
    positionId,
    txHash: mintHash,
    logIndex: 0,
    amounts: { token0: parsed.amount0, token1: parsed.amount1 },
    blockNumber: receipt.blockNumber,
    blockTimestamp: new Date().toISOString(),
  });
  input.repo.transitionCanaryIntent(input.intentId, 'MINT_CONFIRMED', {
    mintHash,
    tokenId: parsed.tokenId.toString(),
  });
  input.repo.recordReconciliation(`canary:${input.intentId}`, positionId, {
    mintHash,
    tokenId: parsed.tokenId.toString(),
    source: 'mint receipt',
  });
  input.repo.transitionCanaryIntent(input.intentId, 'POSITION_RECONCILED', {
    tokenId: parsed.tokenId.toString(),
  });
  return { tokenId: parsed.tokenId, positionId };
}

/**
 * Live writes are reachable only after the caller's gate/budget checks. The same
 * state machine resumes persisted submitted hashes after a process restart.
 */
export async function executeGuardedSingleSidedCanary(input: GuardedCanaryInput) {
  const { repo, rpc, wallet } = input;
  const sender = input.walletClient as any;
  repo.persistIntent(input.intentId, `canary-receipt:${input.intentId}`, {
    kind: 'GUARDED_CANARY',
  });

  const initial = repo.canaryIntent(input.intentId);
  if (!initial) return { ok: false as const, status: 'NOT_FOUND' as const, reason: 'intent not found' };
  if (initial.state === 'POSITION_RECONCILED') {
    return {
      ok: true as const,
      status: 'ALREADY_COMPLETED' as const,
      tokenId: BigInt(String(initial.token_id)),
      mintHash: initial.mint_hash as Hash,
    };
  }
  if (initial.state === 'FAILED' || initial.state === 'CANCELLED') {
    return { ok: false as const, status: 'TERMINAL' as const, reason: String(initial.failure_reason ?? initial.state) };
  }
  const recoveryState = String(initial.state);
  if (recoveryState === 'PREVIEWED') {
    if (!repo.claimCanaryIntent(input.intentId)) {
      return { ok: false as const, status: 'ALREADY_PROCESSING' as const, reason: 'intent already claimed' };
    }
  } else if (recoveryState !== 'APPROVAL_SUBMITTED' && recoveryState !== 'MINT_SUBMITTED') {
    return { ok: false as const, status: 'ALREADY_PROCESSING' as const, reason: `intent is ${recoveryState}` };
  }

  try {
    return await rpc.withClient(async client => {
      if (await client.getChainId() !== 4663) throw new Error('wrong chain');
      const audited = await verifyDeployments(input);
      if (audited.status === 'unavailable') throw new Error(audited.reason);
      const deployments = audited.value;
      const preview = await prepareFreshMint(input, client, deployments);
      const hookContext = (patch: Partial<GuardedCanaryHookContext> = {}): GuardedCanaryHookContext => ({
        intentId: input.intentId,
        client,
        walletClient: input.walletClient,
        pool: input.pool,
        preview: preview.snapshot,
        ...patch,
      });
      const [balance, allowance, nonce] = await Promise.all([
        client.readContract({ address: input.funding.address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
        client.readContract({ address: input.funding.address, abi: erc20Abi, functionName: 'allowance', args: [wallet, deployments.positionManager] }),
        client.getTransactionCount({ address: wallet, blockTag: 'pending' }),
      ]);
      if (balance < input.fundingAmount) throw new Error('funding balance changed');
      if (!repo.acquireNonceMutex(wallet, BigInt(nonce))) {
        return { ok: false as const, status: 'ALREADY_PROCESSING' as const, reason: 'nonce mutex is held' };
      }

      try {
        await input.notify(`CANARY_STARTED\nFunding: ${input.fundingAmount} raw ${input.funding.symbol}\nTarget: ${input.target.symbol}\nRange: current → −${input.lowerDropPct}%`);
        let currentState = String(repo.canaryIntent(input.intentId)?.state);
        let approvalHash = repo.canaryIntent(input.intentId)?.approval_hash as Hash | undefined;

        if (currentState === 'APPROVAL_SUBMITTED') {
          if (!approvalHash) throw new Error('APPROVAL_SUBMITTED is missing approval hash');
          const receipt = await client.waitForTransactionReceipt({ hash: approvalHash });
          repo.persistReceipt(approvalHash, input.intentId, receipt);
          if (receipt.status !== 'success') throw new Error('approval reverted');
          const verified = await client.readContract({ address: input.funding.address, abi: erc20Abi, functionName: 'allowance', args: [wallet, deployments.positionManager] });
          if (verified < input.fundingAmount) throw new Error('allowance verification failed');
          repo.transitionCanaryIntent(input.intentId, 'APPROVAL_CONFIRMED');
          await input.notify('APPROVAL CONFIRMED');
          currentState = 'APPROVAL_CONFIRMED';
        } else if (currentState === 'MINT_SUBMITTED') {
          const mintHash = repo.canaryIntent(input.intentId)?.mint_hash as Hash | undefined;
          if (!mintHash) throw new Error('MINT_SUBMITTED is missing mint hash');
          const receipt = await client.waitForTransactionReceipt({ hash: mintHash });
          repo.persistReceipt(mintHash, input.intentId, receipt);
          if (receipt.status !== 'success') throw new Error('mint reverted');
          const recovered = await enrollMint(input, deployments, preview, 0n, mintHash, receipt);
          repo.finalizeCanaryBudget(input.intentId, true);
          await input.notify('CANARY_LOCKED_AFTER_ATTEMPT');
          await input.notify(`POSITION OPENED\nNFT ID: ${recovered.tokenId}\nTransaction: ${mintHash}\n\nPnL tracking enrolled.`);
          return { ok: true as const, status: 'RECOVERED' as const, tokenId: recovered.tokenId, mintHash };
        } else if (allowance < input.fundingAmount) {
          repo.transitionCanaryIntent(input.intentId, 'APPROVAL_REQUIRED');
          const approval = buildApproval(input.funding.address, deployments.positionManager, input.fundingAmount);
          const simulation = await simulateBuiltTransaction(rpc, wallet, approval);
          if (simulation.status === 'unavailable') throw new Error(simulation.reason);
          const gasUsd = Number(simulation.value.gas * (await client.getGasPrice())) / 1e18 * input.gasUsdPerNative;
          if (gasUsd > input.maxGasUsd) throw new Error('approval gas cap exceeded');
          const submittedApprovalHash = await sender.sendTransaction(approval) as Hash;
          approvalHash = submittedApprovalHash;
          repo.transitionCanaryIntent(input.intentId, 'APPROVAL_SUBMITTED', { approvalHash: submittedApprovalHash });
          repo.updateCanaryBudgetState('APPROVAL_SUBMITTED', input.intentId);
          await input.notify('APPROVAL SUBMITTED');
          await input.hooks?.beforeApprovalReceiptWait?.(hookContext({ approvalHash: submittedApprovalHash }));
          const receipt = await client.waitForTransactionReceipt({ hash: submittedApprovalHash });
          repo.persistReceipt(submittedApprovalHash, input.intentId, receipt);
          if (receipt.status !== 'success') throw new Error('approval reverted');
          const verified = await client.readContract({ address: input.funding.address, abi: erc20Abi, functionName: 'allowance', args: [wallet, deployments.positionManager] });
          if (verified < input.fundingAmount) throw new Error('allowance verification failed');
          repo.transitionCanaryIntent(input.intentId, 'APPROVAL_CONFIRMED');
          await input.notify('APPROVAL CONFIRMED');
          currentState = 'APPROVAL_CONFIRMED';
        }

        if (currentState === 'APPROVAL_CONFIRMED') {
          await input.hooks?.afterApprovalConfirmed?.(hookContext({ approvalHash }));
        }
        const refreshed = await prepareFreshMint(input, client, deployments);
        repo.transitionCanaryIntent(input.intentId, 'RANGE_REFRESHED');
        await input.notify(`POOL STATE REFRESHED\nOld tick: ${preview.view.pool.tick}\nNew tick: ${refreshed.view.pool.tick}\nFinal range: ${refreshed.quote.tickLower}–${refreshed.quote.tickUpper}`);
        if (await client.readContract({ address: input.funding.address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }) < input.fundingAmount) {
          throw new Error('funding balance changed after approval');
        }
        await input.hooks?.beforeFinalMintSimulation?.(hookContext({ approvalHash, refreshed: refreshed.snapshot }));
        const simulation = await simulateBuiltTransaction(rpc, wallet, refreshed.mint);
        if (simulation.status === 'unavailable') throw new Error(`final mint simulation failed: ${simulation.reason}`);
        if (Number(simulation.value.gas * (await client.getGasPrice())) / 1e18 * input.gasUsdPerNative > input.maxGasUsd) {
          throw new Error('mint gas cap exceeded');
        }
        repo.transitionCanaryIntent(input.intentId, 'MINT_SIMULATION_PASSED');
        await input.notify('MINT_SIMULATION_PASSED');
        const mintHash = await sender.sendTransaction(refreshed.mint);
        repo.transitionCanaryIntent(input.intentId, 'MINT_SUBMITTED', { mintHash });
        repo.updateCanaryBudgetState('MINT_SUBMITTED', input.intentId);
        await input.notify('MINT SUBMITTED');
        await input.hooks?.beforeMintReceiptWait?.(hookContext({ approvalHash, refreshed: refreshed.snapshot, mintHash }));
        const receipt = await client.waitForTransactionReceipt({ hash: mintHash });
        repo.persistReceipt(mintHash, input.intentId, receipt);
        if (receipt.status !== 'success') throw new Error('mint reverted');
        const enrolled = await enrollMint(input, deployments, refreshed, simulation.value.gas, mintHash, receipt);
        repo.finalizeCanaryBudget(input.intentId, true);
        await input.notify('CANARY_LOCKED_AFTER_ATTEMPT');
        await input.notify(`POSITION_RECONCILED\nPOSITION OPENED\nNFT ID: ${enrolled.tokenId}\nTransaction: ${mintHash}\n\nInitial composition:\n${input.target.symbol}: 0\n${input.funding.symbol}: ${input.fundingAmount}\n\nPnL tracking enrolled.`);
        return {
          ok: true as const,
          status: 'COMPLETED' as const,
          tokenId: enrolled.tokenId,
          mintHash,
          preview: preview.snapshot,
          refreshed: refreshed.snapshot,
          approvalHash,
        };
      } finally {
        repo.releaseNonceMutex(wallet);
      }
    });
  } catch (error) {
    if (error instanceof ReceiptWaitInterrupted) {
      return {
        ok: false as const,
        status: 'RECOVERY_REQUIRED' as const,
        reason: error.message,
        phase: error.phase,
      };
    }
    const state = String(repo.canaryIntent(input.intentId)?.state);
    const phase = state === 'RANGE_REFRESHED' ? 'FINAL_MINT_SIMULATION' : 'CANARY FAILED';
    const reason = stop(repo, input.intentId, phase, error);
    let remainingAllowance: bigint | undefined;
    try {
      const audited = await verifyDeployments(input);
      if (audited.status === 'available') remainingAllowance = await rpc.withClient(client => client.readContract({ address: input.funding.address, abi: erc20Abi, functionName: 'allowance', args: [wallet, audited.value.positionManager] }));
    } catch { /* Failure reporting must not conceal the original stopped phase. */ }
    repo.finalizeCanaryBudget(input.intentId, false, { failureReason: reason, remainingAllowanceRaw: remainingAllowance });
    await input.notify(`CANARY_LOCKED_AFTER_ATTEMPT\nRemaining capped allowance: ${remainingAllowance?.toString() ?? 'unavailable'} raw ${input.funding.symbol}`);
    await input.notify(`CANARY FAILED\n${reason}\nApproval or mint may have been sent; inspect the persisted intent before any retry.`);
    return { ok: false as const, status: 'FAILED' as const, reason };
  }
}

/** Restart entry point; it intentionally delegates to the same production executor. */
export async function recoverGuardedSingleSidedCanary(input: GuardedCanaryInput) {
  return executeGuardedSingleSidedCanary({ ...input, hooks: undefined });
}
