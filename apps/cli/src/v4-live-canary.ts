import { randomUUID } from "node:crypto";
import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  parseAbiItem,
  zeroAddress,
  type Address,
  type Hash,
  type WalletClient,
} from "viem";
import { FallbackRpc, robinhoodMainnet } from "@funi/core";
import { SqliteLedgerRepository } from "@funi/ledger";
import {
  V4_ROBINHOOD_DEPLOYMENTS,
  auditRobinhoodV4Deployments,
  buildGenericV4SingleSidedDownsidePlan,
  inspectV4Pool,
  inspectV4Position,
  parseV4MintTokenId,
  permit2Allowance,
  permit2ApproveAbi,
  poolId,
  positionManagerAbi,
  v4ExecutionBlockers,
  type V4DownsideRangeRequest,
  type V4PoolKey,
} from "@funi/v4";
import { executeV4Lifecycle } from "./v4-lifecycle.js";
import { runtimeEnv } from "./runtime.js";

export const V4_LIVE_POOL_ID =
  "0xfcfae8fa0bd6da961bcf5d990f27690932deac4f093e99bf3e871691c6586593" as const;
export const V4_LIVE_POOL_KEY: V4PoolKey = Object.freeze({
  currency0: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  currency1: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  fee: 500,
  tickSpacing: 10,
  hooks: zeroAddress,
});
export const V4_LIVE_AMOUNT = 5_000_000n;
const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const activeOpenIntents = new Set<string>();
export const isLoopbackRpc = (url: string) => {
  try {
    const h = new URL(url).hostname;
    return (
      h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]"
    );
  } catch {
    return false;
  }
};
export type V4LiveGateInput = {
  operation: "open" | "close";
  executionEnabled: boolean;
  dryRun: boolean;
  emergencyPause: boolean;
  v4LiveCanaryEnabled: boolean;
  signerConfigured: boolean;
  allowlisted: boolean;
  chainId: number;
  deploymentVerified: boolean;
  state: string;
  tokenId?: string;
  requestedTokenId?: string;
  amountRaw?: bigint;
  fundingBalance?: bigint;
  nativeBalance?: bigint;
  poolValid: boolean;
  pendingIntent: boolean;
  openPositionCount: number;
};
export function evaluateV4LiveGates(i: V4LiveGateInput) {
  const reasons: string[] = [];
  if (!i.executionEnabled) reasons.push("EXECUTION_DISABLED");
  if (i.dryRun) reasons.push("DRY_RUN_ENABLED");
  if (i.emergencyPause) reasons.push("EMERGENCY_PAUSE");
  if (!i.v4LiveCanaryEnabled) reasons.push("V4_LIVE_CANARY_DISABLED");
  if (!i.signerConfigured) reasons.push("PROTECTED_SIGNER_REQUIRED");
  if (!i.allowlisted) reasons.push("OPERATOR_NOT_ALLOWLISTED");
  if (i.chainId !== 4663) reasons.push("WRONG_CHAIN");
  if (!i.deploymentVerified) reasons.push("V4_DEPLOYMENT_UNVERIFIED");
  if (!i.poolValid) reasons.push("V4_POOL_BINDING_INVALID");
  if (i.pendingIntent) reasons.push("V4_PENDING_INTENT");
  if (i.operation === "open") {
    if (i.state !== "AVAILABLE_FOR_OPEN")
      reasons.push("V4_CANARY_OPEN_UNAVAILABLE");
    if (i.amountRaw !== V4_LIVE_AMOUNT)
      reasons.push("V4_CANARY_AMOUNT_MUST_BE_EXACTLY_5_USDG");
    if ((i.fundingBalance ?? 0n) < V4_LIVE_AMOUNT)
      reasons.push("FUNDING_ASSET_BALANCE_INSUFFICIENT");
    if ((i.nativeBalance ?? 0n) <= 0n) reasons.push("GAS_BALANCE_INSUFFICIENT");
    if (i.openPositionCount !== 0)
      reasons.push("V4_CANARY_POSITION_ALREADY_EXISTS");
  } else {
    if (i.state !== "OPENED") reasons.push("V4_CANARY_NOT_OPENED");
    if (!i.tokenId || i.tokenId !== i.requestedTokenId)
      reasons.push("V4_CANARY_TOKEN_ID_MISMATCH");
  }
  return {
    executionReachable: reasons.length === 0,
    reasons,
    operation: i.operation,
    executor:
      i.operation === "open"
        ? "executeV4LiveCanaryOpen"
        : "executeV4LiveCanaryClose",
  };
}
export type V4LiveLimits = {
  maxTxGasUsd: number;
  totalGasUsd: number;
  nativeUsd?: number;
};
export const defaultV4LiveLimits: V4LiveLimits = {
  maxTxGasUsd: 0.25,
  totalGasUsd: 1,
};
function price1Per0(sqrt: bigint) {
  return (Number(sqrt * sqrt) / Number(2n ** 192n)) * 1e12;
}
function gasQuote(gas: bigint, gasPrice: bigint, nativeUsd: number) {
  const eth = gas * gasPrice;
  return { gas, gasPrice, eth, usd: (Number(eth) / 1e18) * nativeUsd };
}
export function enforceV4GasBudget<T extends { usd: number }>(
  repo: SqliteLedgerRepository,
  quote: T,
  limits: V4LiveLimits,
): T & { spent: number; remaining: number } {
  if (!Number.isFinite(quote.usd)) throw new Error("GAS_ESTIMATE_UNAVAILABLE");
  if (quote.usd > limits.maxTxGasUsd)
    throw new Error(
      `TX_GAS_CAP_EXCEEDED: estimated $${quote.usd.toFixed(6)} > $${limits.maxTxGasUsd}`,
    );
  const spent = Number(repo.v4LiveCanary().gas_spent_usd ?? 0);
  if (spent + quote.usd > limits.totalGasUsd)
    throw new Error(
      `LIFECYCLE_GAS_BUDGET_EXCEEDED: spent $${spent.toFixed(6)} + estimate $${quote.usd.toFixed(6)} > $${limits.totalGasUsd}`,
    );
  return { ...quote, spent, remaining: limits.totalGasUsd - spent - quote.usd };
}
async function receipt(client: any, hash: Hash) {
  return client.waitForTransactionReceipt({ hash, timeout: 60_000 });
}
function assertSelectedPool(
  key: V4PoolKey,
  id: string,
  selected: { poolId: string; key: V4PoolKey },
) {
  if (
    id.toLowerCase() !== selected.poolId.toLowerCase() ||
    poolId(key).toLowerCase() !== selected.poolId.toLowerCase() ||
    JSON.stringify(key).toLowerCase() !==
      JSON.stringify(selected.key).toLowerCase()
  )
    throw new Error("V4_POOL_KEY_MISMATCH");
}
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from,address indexed to,uint256 value)",
);
function fundingSpentFromReceipt(
  logs: readonly any[],
  owner: Address,
  funding: Address,
) {
  let spent = 0n;
  for (const log of logs) {
    if (!same(String(log.address), funding)) continue;
    try {
      const e = decodeEventLog({
        abi: [transferEvent],
        data: log.data,
        topics: log.topics,
      });
      if (e.eventName === "Transfer" && same(e.args.from, owner))
        spent += e.args.value;
    } catch {}
  }
  return spent;
}
export type V4LiveRuntime = {
  executionEnabled: boolean;
  dryRun: boolean;
  emergencyPause: boolean;
  v4LiveCanaryEnabled: boolean;
  signerConfigured: boolean;
  allowlisted: boolean;
};
export type GenericV4OpenSelection = {
  poolId: string;
  key: V4PoolKey;
  target: Address;
  funding: Address;
  targetIndex: 0 | 1;
  fundingIndex: 0 | 1;
  amount: bigint;
  targetSymbol?: string;
  fundingSymbol?: string;
  targetDecimals?: number;
  fundingDecimals?: number;
  feeSemantics?: unknown;
  hookStatus?: unknown;
  valuationProvenance?: unknown;
  selectionId?: string;
};
export type V4OpenInput = {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  walletClient: WalletClient;
  wallet: Address;
  runtime: V4LiveRuntime;
  idempotencyKey: string;
  userId?: string;
  chatId?: string;
  range?: V4DownsideRangeRequest;
  limits?: V4LiveLimits;
  notify?: (state: string, details?: unknown) => void | Promise<void>;
  allowLocalTest?: boolean;
  selection?: GenericV4OpenSelection;
};
export type V4ApprovalDecision = {
  alreadySufficient: boolean;
  alreadyExact: boolean;
  exactApprovalRequired: boolean;
  approvalTransactionRequired: boolean;
  revocationRequired: boolean;
  status:
    | "ALREADY_SUFFICIENT_EXACT"
    | "EXACT_APPROVAL_REQUIRED"
    | "APPROVAL_TRANSACTION_REQUIRED";
};
/** This canary deliberately normalizes usable over-allowances down to the exact five-USDG cap. */
export function v4ExactApprovalDecision(
  current: bigint,
  required: bigint,
  usable = true,
): V4ApprovalDecision {
  const alreadySufficient = usable && current >= required,
    alreadyExact = usable && current === required,
    revocationRequired = usable && current > required,
    approvalTransactionRequired = !alreadyExact;
  return {
    alreadySufficient,
    alreadyExact,
    exactApprovalRequired: approvalTransactionRequired,
    approvalTransactionRequired,
    revocationRequired,
    status: alreadyExact
      ? "ALREADY_SUFFICIENT_EXACT"
      : revocationRequired
        ? "EXACT_APPROVAL_REQUIRED"
        : "APPROVAL_TRANSACTION_REQUIRED",
  };
}
function selected(
  input: Pick<V4OpenInput, "selection">,
): GenericV4OpenSelection {
  return (
    input.selection ?? {
      poolId: V4_LIVE_POOL_ID,
      key: V4_LIVE_POOL_KEY,
      target: V4_LIVE_POOL_KEY.currency0,
      funding: V4_LIVE_POOL_KEY.currency1,
      targetIndex: 0,
      fundingIndex: 1,
      amount: V4_LIVE_AMOUNT,
      targetSymbol: "WETH",
      fundingSymbol: "USDG",
      targetDecimals: 18,
      fundingDecimals: 6,
    }
  );
}
async function baseState(
  input: Pick<V4OpenInput, "repo" | "rpc" | "wallet" | "runtime" | "selection">,
  operation: "open" | "close",
  requestedTokenId?: string,
) {
  const s = selected(input),
    inspected = await inspectV4Pool(input.rpc, s.key),
    audit = await auditRobinhoodV4Deployments(input.rpc),
    canary = input.repo.v4LiveCanary();
  const pool = inspected.status === "available" ? inspected.value : undefined;
  if (pool) assertSelectedPool(pool.key, pool.id, s);
  const [chainId, fundingBalance, nativeBalance] = await input.rpc.withClient(
    (c) =>
      Promise.all([
        c.getChainId(),
        c.readContract({
          address: s.funding,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [input.wallet],
        }),
        c.getBalance({ address: input.wallet }),
      ]),
  );
  const pending =
    Number(
      (
        input.repo.db
          .prepare(
            "SELECT COUNT(*) count FROM v4_live_open_intents WHERE state NOT IN ('PREVIEWED','POSITION_RECONCILED','FAILED')",
          )
          .get() as { count: number }
      ).count,
    ) > 0 && operation === "open";
  const gate = evaluateV4LiveGates({
    operation,
    ...input.runtime,
    chainId,
    deploymentVerified: audit.status === "available",
    state: String(canary.state),
    tokenId: canary.token_id ? String(canary.token_id) : undefined,
    requestedTokenId,
    amountRaw: operation === "open" ? s.amount : undefined,
    fundingBalance,
    nativeBalance,
    poolValid: Boolean(
      pool?.initialized &&
      pool.liquidity > 0n &&
      !v4ExecutionBlockers(pool).length,
    ),
    pendingIntent: pending,
    openPositionCount: input.repo
      .listV4Positions()
      .filter((x) => x.status !== "burned" && x.status !== "closed").length,
  });
  if (operation === "open") {
    gate.reasons = gate.reasons.filter(
      (x) =>
        x !== "V4_CANARY_AMOUNT_MUST_BE_EXACTLY_5_USDG" &&
        x !== "FUNDING_ASSET_BALANCE_INSUFFICIENT",
    );
    if (s.amount <= 0n) gate.reasons.push("V4_FUNDING_AMOUNT_INVALID");
    if (fundingBalance < s.amount)
      gate.reasons.push("FUNDING_ASSET_BALANCE_INSUFFICIENT");
    gate.executionReachable = gate.reasons.length === 0;
  }
  return {
    pool,
    audit,
    chainId,
    fundingBalance,
    nativeBalance,
    canary,
    selection: s,
    gate,
  };
}
export async function v4LiveOpenPreflight(
  input: Pick<
    V4OpenInput,
    "repo" | "rpc" | "wallet" | "runtime" | "limits" | "range" | "selection"
  >,
): Promise<any> {
  const b = await baseState(input, "open"),
    limits = input.limits ?? defaultV4LiveLimits;
  if (!b.pool)
    return {
      status: "BLOCKED",
      ...b.gate,
      reason: "V4_POOL_UNAVAILABLE",
      mainnetTransactionsSent: 0,
    };
  const s = b.selection,
    block = await input.rpc.withClient((c) => c.getBlock()),
    range = input.range ?? { upperDropPct: 0, lowerDropPct: 10 },
    plan = buildGenericV4SingleSidedDownsidePlan({
      pool: b.pool,
      target: s.target,
      funding: s.funding,
      fundingAmount: s.amount,
      owner: input.wallet,
      deadline: block.timestamp + 600n,
      range,
    });
  const [erc20, permit, gasPrice] = await Promise.all([
    input.rpc.withClient((c) =>
      c.readContract({
        address: s.funding,
        abi: erc20Abi,
        functionName: "allowance",
        args: [input.wallet, V4_ROBINHOOD_DEPLOYMENTS.permit2],
      }),
    ),
    permit2Allowance(
      input.rpc,
      input.wallet,
      s.funding,
      V4_ROBINHOOD_DEPLOYMENTS.positionManager,
    ),
    input.rpc.withClient((c) => c.getGasPrice()),
  ]);
  const nativeUsd =
      limits.nativeUsd ??
      (same(s.target, robinhoodMainnet.assets.WETH) &&
      same(s.funding, robinhoodMainnet.assets.USDG)
        ? price1Per0(b.pool.sqrtPriceX96)
        : NaN),
    expiration = block.timestamp + 3600n,
    erc20Data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [V4_ROBINHOOD_DEPLOYMENTS.permit2, s.amount],
    }),
    permitData = encodeFunctionData({
      abi: permit2ApproveAbi,
      functionName: "approve",
      args: [
        s.funding,
        V4_ROBINHOOD_DEPLOYMENTS.positionManager,
        s.amount,
        Number(expiration),
      ],
    });
  let gas: any, gasBlocker: string | undefined;
  const erc20Decision = v4ExactApprovalDecision(erc20, s.amount),
    permitDecision = v4ExactApprovalDecision(
      permit[0],
      s.amount,
      BigInt(permit[1]) > block.timestamp,
    );
  try {
    const approvalMissing =
        erc20Decision.approvalTransactionRequired ||
        permitDecision.approvalTransactionRequired,
      estimates = await input.rpc.withClient(async (c) => ({
        erc20ToPermit2: await c.estimateGas({
          account: input.wallet,
          to: s.funding,
          data: erc20Data,
        }),
        permit2ToPositionManager: await c.estimateGas({
          account: input.wallet,
          to: V4_ROBINHOOD_DEPLOYMENTS.permit2,
          data: permitData,
        }),
        mint: await c
          .estimateGas({
            account: input.wallet,
            to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
            data: plan.calldata,
            value: 0n,
          })
          .catch((error) => {
            if (approvalMissing) return 400_000n;
            throw error;
          }),
        fullClose: 180_000n,
        burn: 70_000n,
      }));
    const quotes = Object.fromEntries(
        Object.entries(estimates).map(([phase, value]) => [
          phase,
          gasQuote(value as bigint, gasPrice, nativeUsd),
        ]),
      ),
      required = [
        "mint",
        "fullClose",
        "burn",
        ...(erc20Decision.approvalTransactionRequired
          ? ["erc20ToPermit2"]
          : []),
        ...(permitDecision.approvalTransactionRequired
          ? ["permit2ToPositionManager"]
          : []),
      ],
      projectedUsd = required.reduce(
        (sum, k) => sum + (quotes[k] as any).usd,
        Number(b.canary.gas_spent_usd),
      );
    for (const k of required)
      if ((quotes[k] as any).usd > limits.maxTxGasUsd)
        throw new Error(`TX_GAS_CAP_EXCEEDED:${k}`);
    if (projectedUsd > limits.totalGasUsd)
      throw new Error(
        `LIFECYCLE_GAS_BUDGET_EXCEEDED:projected $${projectedUsd}`,
      );
    gas = {
      gasPrice,
      nativeUsd,
      estimates,
      quotes,
      required,
      projectedLifecycleUsd: projectedUsd,
      mintEstimateSource: approvalMissing
        ? "conservative pre-approval estimate; exact live estimate required after authorizations"
        : "live eth_estimateGas",
      perTransactionCapUsd: limits.maxTxGasUsd,
      lifecycleBudgetUsd: limits.totalGasUsd,
      spentUsd: Number(b.canary.gas_spent_usd),
      closeAndBurnEstimateSource:
        "conservative units calibrated by pinned v4 lifecycle proof; re-estimated from live position before signing",
    };
  } catch (error) {
    gasBlocker = error instanceof Error ? error.message : String(error);
    gas = {
      gasPrice,
      nativeUsd,
      perTransactionCapUsd: limits.maxTxGasUsd,
      lifecycleBudgetUsd: limits.totalGasUsd,
      spentUsd: Number(b.canary.gas_spent_usd),
      error: gasBlocker,
    };
  }
  const gate = gasBlocker
    ? {
        ...b.gate,
        executionReachable: false,
        reasons: [
          ...b.gate.reasons,
          gasBlocker.startsWith("TX_GAS_CAP_EXCEEDED")
            ? "TX_GAS_CAP_EXCEEDED"
            : gasBlocker.startsWith("LIFECYCLE_GAS_BUDGET_EXCEEDED")
              ? "LIFECYCLE_GAS_BUDGET_EXCEEDED"
              : "GAS_ESTIMATE_UNAVAILABLE",
        ],
      }
    : b.gate;
  gate.executionReachable = gate.reasons.length === 0;
  return {
    status: gate.executionReachable
      ? "V4 READY — awaiting final confirmation"
      : "BLOCKED",
    gate,
    deploymentVerification:
      b.audit.status === "available"
        ? b.audit.value.verification
        : (b.audit.details as { verification?: unknown } | undefined)
            ?.verification,
    poolId: b.pool.id,
    poolKey: b.pool.key,
    currentTick: b.pool.tick,
    liquidity: b.pool.liquidity,
    range: {
      requested: plan.requestedRange,
      effective: plan.effectiveRange,
      tickLower: plan.tickLower,
      tickUpper: plan.tickUpper,
    },
    target: {
      address: s.target,
      symbol: s.targetSymbol ?? "TARGET",
      amountRequired: 0n,
      index: s.targetIndex,
    },
    funding: {
      address: s.funding,
      symbol: s.fundingSymbol ?? "FUNDING",
      amount: s.amount,
      balance: b.fundingBalance,
      index: s.fundingIndex,
    },
    approvals: {
      erc20ToPermit2: { current: erc20, required: s.amount, ...erc20Decision },
      permit2ToPositionManager: {
        current: permit[0],
        expiration: permit[1],
        nonce: permit[2],
        required: s.amount,
        ...permitDecision,
      },
    },
    gas,
    calldataHash: plan.calldataHash,
    mainnetTransactionsSent: 0,
  };
}
async function confirmGas(
  repo: SqliteLedgerRepository,
  intentId: string,
  phase: string,
  hash: Hash,
  r: any,
  nativeUsd: number,
) {
  const gas = BigInt(r.gasUsed),
    price = BigInt(r.effectiveGasPrice),
    eth = gas * price,
    usd = (Number(eth) / 1e18) * nativeUsd;
  repo.addV4LiveGasEstimate({ txHash: hash, intentId, phase, gas, eth, usd });
  repo.confirmV4LiveGas({ txHash: hash, gas, eth, usd });
}
function persistOpenedPosition(input: {
  repo: SqliteLedgerRepository;
  wallet: Address;
  selection: GenericV4OpenSelection;
  tokenId: bigint;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  fundingSpent: bigint;
  mintHash: Hash;
  blockNumber: bigint;
  intentId: string;
}) {
  const {
      repo,
      wallet,
      selection: s,
      tokenId,
      liquidity,
      tickLower,
      tickUpper,
      fundingSpent,
      mintHash,
      blockNumber,
      intentId,
    } = input,
    positionId = `v4:${tokenId}`,
    amounts = {
      token0: s.fundingIndex === 0 ? fundingSpent : 0n,
      token1: s.fundingIndex === 1 ? fundingSpent : 0n,
    };
  repo.ensurePosition(positionId, tokenId.toString(), s.poolId);
  repo.upsertV4Position({
    tokenId,
    owner: wallet,
    poolId: s.poolId,
    poolKey: s.key,
    currency0: s.key.currency0,
    currency1: s.key.currency1,
    fee: s.key.fee,
    tickSpacing: s.key.tickSpacing,
    hooks: s.key.hooks,
    tickLower,
    tickUpper,
    liquidity,
    initialAmount0: amounts.token0,
    initialAmount1: amounts.token1,
    mintHash,
    targetToken: s.target,
    fundingToken: s.funding,
    targetSymbol: s.targetSymbol,
    fundingSymbol: s.fundingSymbol,
    targetDecimals: s.targetDecimals,
    fundingDecimals: s.fundingDecimals,
    targetIndex: s.targetIndex,
    fundingIndex: s.fundingIndex,
    feeSemantics: s.feeSemantics,
    hookStatus: s.hookStatus,
    valuationProvenance: s.valuationProvenance,
    openIntentId: intentId,
    openEvidence: { mintHash, blockNumber, selectionId: s.selectionId },
  });
  repo.ingestDeposit({
    id: `v4-open:${mintHash}`,
    positionId,
    txHash: mintHash,
    logIndex: 0,
    amounts,
    blockNumber,
    blockTimestamp: new Date().toISOString(),
  });
  return positionId;
}
export async function executeV4LiveCanaryOpen(
  input: V4OpenInput,
): Promise<any> {
  const local = input.rpc.config.rpcUrls.every(isLoopbackRpc);
  if (input.allowLocalTest && !local)
    throw new Error("V4_LOCAL_TEST_MODE_REQUIRES_LOOPBACK");
  if (!input.allowLocalTest)
    throw new Error("V4_LEGACY_LIVE_OPEN_DISABLED_USE_OPERATIONAL_EXECUTOR");
  const txStarted = Date.now(),
    preflightStarted = Date.now(),
    fallbackBefore = input.rpc.metrics.fallbackUses;
  const existing = input.repo.db
    .prepare("SELECT * FROM v4_live_open_intents WHERE idempotency_key=?")
    .get(input.idempotencyKey) as Record<string, unknown> | undefined;
  if (existing && String(existing.state) === "POSITION_RECONCILED")
    return {
      status: "ALREADY_COMPLETED",
      intentId: existing.id,
      tokenId: existing.token_id,
      hash: existing.mint_hash,
    };
  if (existing && String(existing.state) === "FAILED")
    return {
      status: "ALREADY_COMPLETED",
      intentId: existing.id,
      reason: existing.failure_reason,
    };
  const recovering = Boolean(
      existing && String(existing.state) !== "PREVIEWED",
    ),
    b = await baseState(input, "open"),
    preflightMs = Date.now() - preflightStarted;
  input.repo.recordLatency("selectedPoolPreflightMs", preflightMs, {
    provider: "alchemy",
    fallbackUsed: input.rpc.metrics.fallbackUses > fallbackBefore,
    context: { poolId: b.selection.poolId },
  });
  const blocking = recovering
    ? b.gate.reasons.filter(
        (x) => x !== "V4_CANARY_OPEN_UNAVAILABLE" && x !== "V4_PENDING_INTENT",
      )
    : b.gate.reasons;
  if (blocking.length && !input.allowLocalTest)
    throw new Error(`V4_LIVE_GATES_BLOCKED:${blocking.join(",")}`);
  if (!b.pool) throw new Error("V4_POOL_UNAVAILABLE");
  const s = b.selection,
    requestedRange = input.range ?? { upperDropPct: 0, lowerDropPct: 10 },
    row =
      existing ??
      input.repo.createV4LiveOpenIntent({
        idempotencyKey: input.idempotencyKey,
        owner: input.wallet,
        userId: input.userId,
        chatId: input.chatId,
        poolId: b.pool.id,
        poolKey: b.pool.key,
        amount: s.amount,
        payload: {
          rangeRequest: requestedRange,
          poolBlock: b.pool.blockNumber,
          selection: s,
        },
      }),
    intentId = String(row.id),
    persistedPayload = JSON.parse(String(row.payload_json)) as any,
    range: V4DownsideRangeRequest =
      persistedPayload.rangeRequest ??
      persistedPayload.preflight?.range?.requested ??
      requestedRange;
  assertSelectedPool(
    JSON.parse(String(row.pool_key_json)) as V4PoolKey,
    String(row.pool_id),
    s,
  );
  if (
    BigInt(String(row.amount_raw)) !== s.amount ||
    !same(String(row.owner), input.wallet)
  )
    throw new Error("V4_PERSISTED_INTENT_MISMATCH");
  if (!recovering && !input.repo.claimV4LiveOpen({ intentId }))
    return { status: "ALREADY_PROCESSING", intentId };
  if (activeOpenIntents.has(intentId))
    return { status: "ALREADY_PROCESSING", intentId };
  activeOpenIntents.add(intentId);
  const limits = input.limits ?? defaultV4LiveLimits,
    nativeUsd =
      limits.nativeUsd ??
      (same(s.target, robinhoodMainnet.assets.WETH) &&
      same(s.funding, robinhoodMainnet.assets.USDG)
        ? price1Per0(b.pool.sqrtPriceX96)
        : NaN);
  const send = async (phase: string, to: Address, data: `0x${string}`) =>
    input.rpc.withClient(async (client) => {
      let gas: bigint;
      try {
        gas = await client.estimateGas({
          account: input.wallet,
          to,
          data,
          value: 0n,
        });
      } catch (e) {
        throw new Error(
          `GAS_ESTIMATE_UNAVAILABLE:${phase}:${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const price = await client.getGasPrice(),
        q = enforceV4GasBudget(
          input.repo,
          gasQuote(gas, price, nativeUsd),
          limits,
        ),
        signStarted = Date.now(),
        hash = (await (input.walletClient as any).sendTransaction({
          to,
          data,
          value: 0n,
          gas: (gas * 12n) / 10n,
        })) as Hash,
        signAndBroadcastMs = Date.now() - signStarted;
      input.repo.recordLatency("signMs", signAndBroadcastMs, {
        provider: "alchemy",
        context: { phase },
      });
      input.repo.recordLatency("broadcastMs", signAndBroadcastMs, {
        provider: "alchemy",
        context: { phase },
      });
      input.repo.recordLatency("txHashTotalMs", Date.now() - txStarted, {
        provider: "alchemy",
        fallbackUsed: input.rpc.metrics.fallbackUses > fallbackBefore,
        context: { phase },
      });
      input.repo.addV4LiveGasEstimate({
        txHash: hash,
        intentId,
        phase,
        gas: q.gas,
        eth: q.eth,
        usd: q.usd,
      });
      return hash;
    });
  try {
    await input.notify?.("V4_POSITION_STARTED", {
      amount: s.amount.toString(),
      funding: s.fundingSymbol ?? s.funding,
      poolId: s.poolId,
    });
    const resume = input.repo.v4LiveOpenIntent(intentId)!;
    if (
      resume.erc20_approval_hash &&
      String(resume.state) === "ERC20_PERMIT2_SUBMITTED"
    ) {
      const hash = resume.erc20_approval_hash as Hash,
        r: any = await input.rpc.withClient((c) => receipt(c, hash));
      if (r.status !== "success") throw new Error("ERC20_TO_PERMIT2_REVERTED");
      await confirmGas(
        input.repo,
        intentId,
        "ERC20_TO_PERMIT2",
        hash,
        r,
        nativeUsd,
      );
      input.repo.transitionV4LiveOpenIntent(
        intentId,
        "ERC20_PERMIT2_CONFIRMED",
      );
      await input.notify?.("ERC20_PERMIT2_CONFIRMED", {
        hash,
        recovered: true,
      });
    }
    const afterErc20 = input.repo.v4LiveOpenIntent(intentId)!;
    if (
      afterErc20.permit2_approval_hash &&
      String(afterErc20.state) === "PERMIT2_POSITION_MANAGER_SUBMITTED"
    ) {
      const hash = afterErc20.permit2_approval_hash as Hash,
        r: any = await input.rpc.withClient((c) => receipt(c, hash));
      if (r.status !== "success")
        throw new Error("PERMIT2_TO_POSITION_MANAGER_REVERTED");
      await confirmGas(
        input.repo,
        intentId,
        "PERMIT2_TO_POSITION_MANAGER",
        hash,
        r,
        nativeUsd,
      );
      input.repo.transitionV4LiveOpenIntent(
        intentId,
        "PERMIT2_POSITION_MANAGER_CONFIRMED",
      );
      await input.notify?.("PERMIT2_POSITION_MANAGER_CONFIRMED", {
        hash,
        recovered: true,
      });
    }
    const erc20Current = await input.rpc.withClient((c) =>
      c.readContract({
        address: s.funding,
        abi: erc20Abi,
        functionName: "allowance",
        args: [input.wallet, V4_ROBINHOOD_DEPLOYMENTS.permit2],
      }),
    );
    if (
      v4ExactApprovalDecision(erc20Current, s.amount)
        .approvalTransactionRequired
    ) {
      const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [V4_ROBINHOOD_DEPLOYMENTS.permit2, s.amount],
        }),
        hash = await send("ERC20_TO_PERMIT2", s.funding, data);
      input.repo.transitionV4LiveOpenIntent(
        intentId,
        "ERC20_PERMIT2_SUBMITTED",
        { erc20Hash: hash },
      );
      await input.notify?.("ERC20_PERMIT2_SUBMITTED", { hash });
      const r = await input.rpc.withClient((c) => receipt(c, hash));
      if (r.status !== "success") throw new Error("ERC20_TO_PERMIT2_REVERTED");
      await confirmGas(
        input.repo,
        intentId,
        "ERC20_TO_PERMIT2",
        hash,
        r,
        nativeUsd,
      );
      input.repo.transitionV4LiveOpenIntent(
        intentId,
        "ERC20_PERMIT2_CONFIRMED",
      );
      await input.notify?.("ERC20_PERMIT2_CONFIRMED", { hash });
    }
    const block = await input.rpc.withClient((c) => c.getBlock()),
      p = await permit2Allowance(
        input.rpc,
        input.wallet,
        s.funding,
        V4_ROBINHOOD_DEPLOYMENTS.positionManager,
      );
    if (
      v4ExactApprovalDecision(p[0], s.amount, BigInt(p[1]) > block.timestamp)
        .approvalTransactionRequired
    ) {
      const expiration = block.timestamp + 3600n,
        data = encodeFunctionData({
          abi: permit2ApproveAbi,
          functionName: "approve",
          args: [
            s.funding,
            V4_ROBINHOOD_DEPLOYMENTS.positionManager,
            s.amount,
            Number(expiration),
          ],
        }),
        hash = await send(
          "PERMIT2_TO_POSITION_MANAGER",
          V4_ROBINHOOD_DEPLOYMENTS.permit2,
          data,
        );
      input.repo.transitionV4LiveOpenIntent(
        intentId,
        "PERMIT2_POSITION_MANAGER_SUBMITTED",
        { permit2Hash: hash },
      );
      await input.notify?.("PERMIT2_POSITION_MANAGER_SUBMITTED", { hash });
      const r = await input.rpc.withClient((c) => receipt(c, hash));
      if (r.status !== "success")
        throw new Error("PERMIT2_TO_POSITION_MANAGER_REVERTED");
      await confirmGas(
        input.repo,
        intentId,
        "PERMIT2_TO_POSITION_MANAGER",
        hash,
        r,
        nativeUsd,
      );
      input.repo.transitionV4LiveOpenIntent(
        intentId,
        "PERMIT2_POSITION_MANAGER_CONFIRMED",
      );
      await input.notify?.("PERMIT2_POSITION_MANAGER_CONFIRMED", { hash });
    }
    const allowance = await permit2Allowance(
      input.rpc,
      input.wallet,
      s.funding,
      V4_ROBINHOOD_DEPLOYMENTS.positionManager,
    );
    if (allowance[0] !== s.amount)
      throw new Error("PERMIT2_ALLOWANCE_VERIFICATION_FAILED");
    const refreshed = await inspectV4Pool(input.rpc, s.key);
    if (
      refreshed.status === "unavailable" ||
      !refreshed.value.initialized ||
      refreshed.value.liquidity <= 0n ||
      v4ExecutionBlockers(refreshed.value).length
    )
      throw new Error("V4_POOL_EXECUTION_INELIGIBLE");
    assertSelectedPool(refreshed.value.key, refreshed.value.id, s);
    const deadline =
        (await input.rpc.withClient((c) => c.getBlock())).timestamp + 600n,
      plan = buildGenericV4SingleSidedDownsidePlan({
        pool: refreshed.value,
        target: s.target,
        funding: s.funding,
        fundingAmount: s.amount,
        owner: input.wallet,
        deadline,
        range,
      });
    if (
      (s.targetIndex === 0 ? plan.amount0Expected : plan.amount1Expected) !==
        0n ||
      (s.fundingIndex === 0 ? plan.amount0Expected : plan.amount1Expected) <= 0n
    )
      throw new Error("V4_SINGLE_SIDED_INVARIANT_FAILED");
    input.repo.transitionV4LiveOpenIntent(intentId, "RANGE_REFRESHED", {
      details: {
        tick: refreshed.value.tick,
        tickLower: plan.tickLower,
        tickUpper: plan.tickUpper,
        requestedRange: plan.requestedRange,
        effectiveRange: plan.effectiveRange,
        calldataHash: plan.calldataHash,
      },
    });
    await input.notify?.("RANGE_REFRESHED", {
      tick: refreshed.value.tick,
      tickLower: plan.tickLower,
      tickUpper: plan.tickUpper,
    });
    const submitted = input.repo.v4LiveOpenIntent(intentId)!;
    if (submitted.mint_hash) {
      const mintHash = submitted.mint_hash as Hash,
        mintReceipt: any = await input.rpc.withClient((c) =>
          receipt(c, mintHash),
        );
      if (mintReceipt.status !== "success") throw new Error("V4_MINT_REVERTED");
      await confirmGas(
        input.repo,
        intentId,
        "MINT",
        mintHash,
        mintReceipt,
        nativeUsd,
      );
      const tokenId = parseV4MintTokenId(mintReceipt.logs, input.wallet),
        onchain = await inspectV4Position(input.rpc, tokenId),
        fundingSpent = fundingSpentFromReceipt(
          mintReceipt.logs,
          input.wallet,
          s.funding,
        );
      if (
        fundingSpent <= 0n ||
        fundingSpent > s.amount ||
        onchain.liquidity <= 0n
      )
        throw new Error("V4_MINT_ACCOUNTING_INVARIANT_FAILED");
      input.repo.transitionV4LiveOpenIntent(intentId, "MINT_CONFIRMED", {
        tokenId: tokenId.toString(),
        details: {
          fundingSpent,
          liquidity: onchain.liquidity,
          recovered: true,
        },
      });
      persistOpenedPosition({
        repo: input.repo,
        wallet: input.wallet,
        selection: s,
        tokenId,
        liquidity: onchain.liquidity,
        tickLower: onchain.tickLower,
        tickUpper: onchain.tickUpper,
        fundingSpent,
        mintHash,
        blockNumber: mintReceipt.blockNumber,
        intentId,
      });
      input.repo.transitionV4LiveOpenIntent(intentId, "POSITION_RECONCILED", {
        tokenId: tokenId.toString(),
        details: { recovered: true },
      });
      input.repo.transitionV4LiveCanary("OPENED", {
        tokenId: tokenId.toString(),
      });
      return {
        status: "POSITION_RECONCILED",
        intentId,
        mintHash,
        tokenId,
        fundingSpent,
        plan,
        recovered: true,
      };
    }
    let mintGas: bigint;
    try {
      mintGas = await input.rpc.withClient((c) =>
        c.estimateGas({
          account: input.wallet,
          to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
          data: plan.calldata,
          value: 0n,
        }),
      );
    } catch (e) {
      throw new Error(
        `GAS_ESTIMATE_UNAVAILABLE:MINT:${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const gasPrice = await input.rpc.withClient((c) => c.getGasPrice()),
      q = enforceV4GasBudget(
        input.repo,
        gasQuote(mintGas, gasPrice, nativeUsd),
        limits,
      );
    input.repo.transitionV4LiveOpenIntent(intentId, "MINT_SIMULATION_PASSED", {
      details: { gas: mintGas, calldataHash: plan.calldataHash },
    });
    await input.notify?.("MINT_SIMULATION_PASSED", { gas: mintGas });
    const before = await input.rpc.withClient((c) =>
        c.readContract({
          address: s.funding,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [input.wallet],
        }),
      ),
      mintHash = (await (input.walletClient as any).sendTransaction({
        to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
        data: plan.calldata,
        value: 0n,
        gas: (mintGas * 12n) / 10n,
      })) as Hash;
    input.repo.addV4LiveGasEstimate({
      txHash: mintHash,
      intentId,
      phase: "MINT",
      gas: q.gas,
      eth: q.eth,
      usd: q.usd,
    });
    input.repo.transitionV4LiveOpenIntent(intentId, "MINT_SUBMITTED", {
      mintHash,
    });
    await input.notify?.("MINT_SUBMITTED", { hash: mintHash });
    const mintReceipt: any = await input.rpc.withClient((c) =>
      receipt(c, mintHash),
    );
    if (mintReceipt.status !== "success") throw new Error("V4_MINT_REVERTED");
    await confirmGas(
      input.repo,
      intentId,
      "MINT",
      mintHash,
      mintReceipt,
      nativeUsd,
    );
    const tokenId = parseV4MintTokenId(mintReceipt.logs, input.wallet),
      onchain = await inspectV4Position(input.rpc, tokenId),
      after = await input.rpc.withClient((c) =>
        c.readContract({
          address: s.funding,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [input.wallet],
        }),
      ),
      fundingSpent = before - after;
    if (
      fundingSpent <= 0n ||
      fundingSpent > s.amount ||
      onchain.liquidity <= 0n
    )
      throw new Error("V4_MINT_ACCOUNTING_INVARIANT_FAILED");
    input.repo.transitionV4LiveOpenIntent(intentId, "MINT_CONFIRMED", {
      tokenId: tokenId.toString(),
      details: { fundingSpent, liquidity: onchain.liquidity },
    });
    await input.notify?.("MINT_CONFIRMED", { hash: mintHash, tokenId });
    const positionId = persistOpenedPosition({
      repo: input.repo,
      wallet: input.wallet,
      selection: s,
      tokenId,
      liquidity: onchain.liquidity,
      tickLower: plan.tickLower,
      tickUpper: plan.tickUpper,
      fundingSpent,
      mintHash,
      blockNumber: mintReceipt.blockNumber,
      intentId,
    });
    for (const gasRow of input.repo
      .v4LiveGas()
      .filter(
        (x) => String(x.intent_id) === intentId && x.actual_eth_raw !== null,
      )) {
      input.repo.ingestGas(
        positionId,
        String(gasRow.tx_hash),
        BigInt(String(gasRow.actual_eth_raw)),
      );
      input.repo.db
        .prepare("UPDATE gas_costs SET usd_value=? WHERE tx_hash=?")
        .run(Number(gasRow.actual_usd), String(gasRow.tx_hash));
    }
    input.repo.transitionV4LiveOpenIntent(intentId, "POSITION_RECONCILED", {
      tokenId: tokenId.toString(),
    });
    input.repo.transitionV4LiveCanary("OPENED", {
      tokenId: tokenId.toString(),
    });
    await input.notify?.("POSITION_RECONCILED", { tokenId });
    return {
      status: "POSITION_RECONCILED",
      intentId,
      mintHash,
      tokenId,
      fundingSpent,
      plan,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error),
      remaining = await permit2Allowance(
        input.rpc,
        input.wallet,
        s.funding,
        V4_ROBINHOOD_DEPLOYMENTS.positionManager,
      )
        .then((x) => x[0])
        .catch(() => undefined);
    input.repo.transitionV4LiveOpenIntent(intentId, "FAILED", {
      failureReason: reason,
      details: { remainingAllowance: remaining },
    });
    input.repo.transitionV4LiveCanary("FAILED", {
      failureReason: reason,
      remainingAllowance: remaining,
    });
    throw error;
  } finally {
    activeOpenIntents.delete(intentId);
  }
}
export type V4CloseInput = Omit<
  V4OpenInput,
  "idempotencyKey" | "userId" | "chatId"
> & { tokenId: bigint; idempotencyKey: string };
export async function executeV4LiveCanaryClose(input: V4CloseInput) {
  const position = input.repo.v4Position(input.tokenId);
  if (!position) throw new Error("V4_POSITION_NOT_FOUND");
  const key = JSON.parse(String(position.pool_key_json)) as V4PoolKey,
    funding = getAddress(String(position.funding_token ?? position.currency1)),
    target = getAddress(String(position.target_token ?? position.currency0)),
    selection: GenericV4OpenSelection = input.selection ?? {
      poolId: String(position.pool_id),
      key,
      target,
      funding,
      targetIndex: Number(position.target_index ?? 0) as 0 | 1,
      fundingIndex: Number(position.funding_index ?? 1) as 0 | 1,
      amount: BigInt(
        String(
          Number(position.funding_index ?? 1) === 0
            ? position.initial_amount0_raw
            : position.initial_amount1_raw,
        ),
      ),
      targetSymbol: position.target_symbol
        ? String(position.target_symbol)
        : undefined,
      fundingSymbol: position.funding_symbol
        ? String(position.funding_symbol)
        : undefined,
      targetDecimals:
        position.target_decimals === null
          ? undefined
          : Number(position.target_decimals),
      fundingDecimals:
        position.funding_decimals === null
          ? undefined
          : Number(position.funding_decimals),
    };
  const effective = { ...input, selection },
    prior = input.repo.v4LiveCanary();
  if (
    String(prior.state) === "CLOSED" &&
    String(prior.token_id) === input.tokenId.toString()
  )
    return { status: "ALREADY_COMPLETED" };
  const recovery =
      (String(prior.state) === "CLOSING" || String(prior.state) === "FAILED") &&
      String(prior.token_id) === input.tokenId.toString(),
    b = await baseState(effective, "close", input.tokenId.toString()),
    blocking = recovery
      ? b.gate.reasons.filter((x) => x !== "V4_CANARY_NOT_OPENED")
      : b.gate.reasons;
  if (blocking.length && !input.allowLocalTest)
    throw new Error(`V4_LIVE_CLOSE_GATES_BLOCKED:${blocking.join(",")}`);
  const claimId = String(prior.close_intent_id ?? randomUUID());
  if (
    !recovery &&
    !input.repo.claimV4LiveClose({
      intentId: claimId,
      tokenId: input.tokenId.toString(),
    })
  )
    return { status: "ALREADY_PROCESSING" };
  const limits = input.limits ?? defaultV4LiveLimits,
    nativeUsd =
      limits.nativeUsd ??
      (same(target, robinhoodMainnet.assets.WETH) &&
      same(funding, robinhoodMainnet.assets.USDG)
        ? price1Per0(b.pool!.sqrtPriceX96)
        : NaN),
    gasPolicy = {
      beforeSigning: ({ estimatedGas, gasPrice }: any) => {
        enforceV4GasBudget(
          input.repo,
          gasQuote(estimatedGas, gasPrice, nativeUsd),
          limits,
        );
      },
      afterConfirmation: ({
        intentId,
        action,
        hash,
        gasUsed,
        effectiveGasPrice,
      }: any) => {
        const before = Number(input.repo.v4LiveCanary().gas_spent_usd),
          q = gasQuote(gasUsed, effectiveGasPrice, nativeUsd),
          priced = Number.isFinite(q.usd) ? q.usd : 0,
          breaches: string[] = [];
        if (!Number.isFinite(q.usd))
          breaches.push("ACTUAL_GAS_USD_VALUATION_UNAVAILABLE");
        else {
          if (q.usd > limits.maxTxGasUsd)
            breaches.push("ACTUAL_TX_GAS_CAP_EXCEEDED");
          if (before + q.usd > limits.totalGasUsd)
            breaches.push("ACTUAL_LIFECYCLE_GAS_CAP_EXCEEDED");
        }
        input.repo.addV4LiveGasEstimate({
          txHash: hash,
          intentId,
          phase: String(action).toUpperCase(),
          gas: gasUsed,
          eth: q.eth,
          usd: priced,
        });
        input.repo.confirmV4LiveGas({
          txHash: hash,
          gas: gasUsed,
          eth: q.eth,
          usd: priced,
        });
        return breaches.length
          ? { breach: `ACTUAL_GAS_POLICY_BREACH:${breaches.join(",")}` }
          : undefined;
      },
    };
  try {
    const common = {
      repo: input.repo,
      rpc: input.rpc,
      walletClient: input.walletClient,
      wallet: input.wallet,
      tokenId: input.tokenId,
      slippageBps: runtimeEnv.MAX_SLIPPAGE_BPS,
      deadlineSeconds: 600,
      receiptTimeoutMs: 60_000,
      allowPublicWrites: !input.allowLocalTest,
      gasPolicy,
    };
    const close = await executeV4Lifecycle({
      ...common,
      action: "full_close",
      idempotencyKey: `${input.idempotencyKey}:close`,
    });
    if (!close.ok && !close.closeConfirmed)
      throw new Error(`V4_FULL_CLOSE_FAILED:${close.reason ?? close.status}`);
    if (close.gasPolicyBreach)
      throw new Error(
        `V4_GAS_POLICY_PAUSED_AFTER_CONFIRMED_STAGE:FULL_CLOSE:${close.gasPolicyBreach}`,
      );
    const burn = await executeV4Lifecycle({
      ...common,
      action: "burn",
      idempotencyKey: `${input.idempotencyKey}:burn`,
    });
    if (!burn.ok)
      throw new Error(`V4_BURN_FAILED:${burn.reason ?? burn.status}`);
    const [erc20, permit] = await Promise.all([
        input.rpc.withClient((c) =>
          c.readContract({
            address: funding,
            abi: erc20Abi,
            functionName: "allowance",
            args: [input.wallet, V4_ROBINHOOD_DEPLOYMENTS.permit2],
          }),
        ),
        permit2Allowance(
          input.rpc,
          input.wallet,
          funding,
          V4_ROBINHOOD_DEPLOYMENTS.positionManager,
        ),
      ]),
      block = await input.rpc.withClient((c) => c.getBlock()),
      allowanceAudit = {
        fundingToken: funding,
        erc20ToPermit2: erc20,
        permit2ToPositionManager: {
          amount: permit[0],
          expiration: permit[1],
          nonce: permit[2],
          usable: permit[0] > 0n && BigInt(permit[1]) > block.timestamp,
        },
      },
      terminalAccounting = input.repo.finalizeV4TerminalAccounting(
        input.tokenId,
      );
    if (!close.ok) {
      input.repo.transitionV4LiveCanary("FAILED", {
        failureReason: String(close.status),
      });
      return {
        status: "CLOSE_RECOVERY_REQUIRED",
        close,
        burn,
        terminalAccounting,
        allowanceAudit,
      };
    }
    input.repo.transitionV4LiveCanary("CLOSED", {
      remainingAllowance: permit[0],
    });
    return {
      status: "CLOSED",
      close,
      burn,
      terminalAccounting,
      allowanceAudit,
      gasPolicyBreach: burn.gasPolicyBreach,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.repo.transitionV4LiveCanary("FAILED", { failureReason: reason });
    throw error;
  }
}
