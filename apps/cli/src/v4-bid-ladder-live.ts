import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  parseAbiItem,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import {
  erc20Abi,
  inspectErc20,
  priceFromSqrtX96,
  robinhoodMainnet,
  type FallbackRpc,
} from "@funi/core";
import {
  sqliteTransientCode,
  withEconomicForegroundPersistenceSync,
  withSqliteTransientRetrySync,
  type SqliteLedgerRepository,
} from "@funi/ledger";
import {
  amountsForLiquidity,
  buildPermit2Approval,
  buildV4BatchCollect,
  buildV4BatchFullDecrease,
  buildV4BatchMint,
  classifyV4Hooks,
  decodeV4BatchFullDecrease,
  decodeV4BatchCollect,
  decodeV4BatchMint,
  decodeV4Fee,
  inspectV4Pool,
  inspectV4Position,
  inspectV4ClaimableFeesBatch,
  permit2Abi,
  permit2Allowance,
  poolId,
  reconcileV4BatchFullDecreaseReceipt,
  reconcileV4BatchCollectReceipt,
  reconcileV4BatchMintReceipt,
  V4_ROBINHOOD_DEPLOYMENTS,
  v4StateViewAbi,
  v4ExecutionBlockers,
  type V4PoolKey,
  type V4PoolState,
} from "@funi/v4";
import {
  broadcastDurableTransaction,
  bufferedBroadcastGasPrice,
  DurableTransactionReconciliationPendingError,
  type DurablePreparedTransaction,
} from "./transaction-boundary.js";
import { expireAbandonedPlannedV4BidLadders } from "./v4-bid-ladder-cancellation.js";
import {
  fetchCanonicalGmgnEntryPrice,
  freshLpEntryPriceGuard,
  LP_ENTRY_PRICE_PREVIEW_TTL_MS,
  orientPoolPriceFundingPerTarget,
  type GmgnEntryPriceEvidence,
} from "./lp-entry-price-guard.js";
import { enqueuePortfolioRefresh, enqueueTargetedPositionReconciliation, markOperationalPositionOpenConfirming, persistPortfolioSnapshot } from "./active-position-reconciliation.js";
import { trustedV4WethUsdReference } from "./portfolio.js";
import {
  estimateV4BidLadderMarketCapRange,
  type BidLadderToken,
  type V4BidLadderMarketCapEvidence,
} from "./v4-bid-ladder-operator.js";
import { rawUsdMicros, usdMicrosToText, valueV4ReturnsFromSqrtPriceX96 } from "./v4-realized-accounting.js";
import { ensureEconomicReconciliationWork, type EconomicWorkflowKind } from "./economic-reconciliation-work.js";
import { convergeTerminalV4BidLadder } from "./v4-bid-ladder-terminal-convergence.js";
import { assertDurableV4RecoveryStage, isDurableV4ApprovalStage } from "./v4-durable-journal-stages.js";

const CHAIN_ID = 4663,
  CHAIN_KEY = "robinhood",
  PROTOCOL = "uniswap_v4";
const isManualRepositionAuthorization = (value: unknown): value is string =>
  typeof value === "string" &&
  /^manual-reposition:[^:]+:[0-9a-f-]{36}$/i.test(value);
export const V4_BID_LADDER_CLOSE_SLIPPAGE_BPS = 200;
const BPS_DENOMINATOR = 10_000n;
function integerSquareRoot(value: bigint) {
  if (value < 0n) throw new Error("V4_BID_LADDER_CLOSE_PRICE_INVALID");
  if (value < 2n) return value;
  let current = 1n << BigInt((value.toString(2).length + 1) >> 1),
    next = (current + value / current) >> 1n;
  while (next < current) {
    current = next;
    next = (current + value / current) >> 1n;
  }
  return current;
}
/** CLOSE-only price-space protection matching concentrated-liquidity semantics. */
export function v4BidLadderCloseMinimums(input: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}) {
  if (input.sqrtPriceX96 <= 0n)
    throw new Error("V4_BID_LADDER_CLOSE_PRICE_INVALID");
  const bps = BigInt(V4_BID_LADDER_CLOSE_SLIPPAGE_BPS),
    priceSquared = input.sqrtPriceX96 * input.sqrtPriceX96,
    lowerSqrtPriceX96 = integerSquareRoot(
      (priceSquared * (BPS_DENOMINATOR - bps)) / BPS_DENOMINATOR,
    ),
    upperSqrtPriceX96 = integerSquareRoot(
      (priceSquared * (BPS_DENOMINATOR + bps)) / BPS_DENOMINATOR,
    );
  return {
    amount0Min: amountsForLiquidity(
      upperSqrtPriceX96,
      input.tickLower,
      input.tickUpper,
      input.liquidity,
    ).token0,
    amount1Min: amountsForLiquidity(
      lowerSqrtPriceX96,
      input.tickLower,
      input.tickUpper,
      input.liquidity,
    ).token1,
    lowerSqrtPriceX96,
    upperSqrtPriceX96,
  };
}
const json = (value: unknown) =>
  JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
const parse = <T>(value: unknown): T =>
  JSON.parse(String(value), (_, item) =>
    typeof item === "string" && /^\d+$/.test(item) ? item : item,
  ) as T;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const erc20ApprovalAbi = [
  ...erc20Abi,
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from,address indexed to,uint256 value)",
);
const nftTransferEvent=parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 indexed id)");
const zeroAddress="0x0000000000000000000000000000000000000000";
type LadderRows = {
  parent: Record<string, unknown>;
  legs: Record<string, unknown>[];
  key: V4PoolKey;
};
export type LadderLiveRuntime = {
  executionEnabled: boolean;
  dryRun: boolean;
  emergencyPause: boolean;
  signerConfigured: boolean;
  allowlisted: boolean;
  maxPositionUsd: number;
  maxApprovalUsd: number;
  maxGasUsd: number;
  slippageBps: number;
};
export type LadderLiveContext = {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  ladderId: string;
  wallet: Address;
  fundingUsd: number;
  nativeUsd: number;
  nativeUsdSource?: string;
  nativeUsdObservedAtMs?: number;
  runtime: LadderLiveRuntime;
  entryPriceFetch?: Parameters<typeof freshLpEntryPriceGuard>[0]["fetch"];
  marketCapEvidence?: V4BidLadderMarketCapEvidence;
  nowMs?: () => number;
  /** Authority timestamp supplied by an interactive caller when available. */
  operatorAuthorityAtMs?: number;
  canonicalProjectionLane?: "FOREGROUND" | "RECOVERY";
  telemetry?: (event: string, data: Record<string, unknown>) => void;
};
export type V4BidLadderGasProjection = {
  estimatedGas: bigint;
  signedGasLimit: bigint;
  gasLimitInflationFactor: number;
  gasPrice: bigint;
  nativeUsd: number;
  nativeUsdSource: string;
  estimatedExecutionUsd: number;
  maximumProjectedFeeUsd: number;
  capUsd: number;
  exceedsCap: boolean;
};
export function v4BidLadderGasProjection(input:{estimatedGas:bigint;signedGasLimit?:bigint;gasPrice:bigint;gasPriceAlreadyBuffered?:boolean;nativeUsd:number;nativeUsdSource?:string;capUsd:number}):V4BidLadderGasProjection {
  if(input.estimatedGas<=0n||input.gasPrice<=0n||!Number.isFinite(input.nativeUsd)||input.nativeUsd<=0||!Number.isFinite(input.capUsd)||input.capUsd<0)throw new Error("V4_BID_LADDER_GAS_EVIDENCE_INVALID");
  const signedGasLimit=input.signedGasLimit??input.estimatedGas*12n/10n,
    gasPrice=input.gasPriceAlreadyBuffered?input.gasPrice:bufferedBroadcastGasPrice(input.gasPrice),
    estimatedExecutionUsd=Number(input.estimatedGas*gasPrice)/1e18*input.nativeUsd,
    maximumProjectedFeeUsd=Number(signedGasLimit*gasPrice)/1e18*input.nativeUsd;
  return {estimatedGas:input.estimatedGas,signedGasLimit,gasLimitInflationFactor:Number(signedGasLimit)/Number(input.estimatedGas),gasPrice,nativeUsd:input.nativeUsd,nativeUsdSource:input.nativeUsdSource??"canonical V4 WETH/USDG",estimatedExecutionUsd,maximumProjectedFeeUsd,capUsd:input.capUsd,exceedsCap:!Number.isFinite(maximumProjectedFeeUsd)||maximumProjectedFeeUsd>input.capUsd};
}
const gasUsdText=(value:number)=>`$${value.toFixed(3)}`;
export function formatV4BidLadderGasCapExceeded(value:V4BidLadderGasProjection){return ["V4_BID_LADDER_GAS_CAP_EXCEEDED",`Estimated execution: ${gasUsdText(value.estimatedExecutionUsd)}`,`Maximum projected fee: ${gasUsdText(value.maximumProjectedFeeUsd)}`,`Safety cap: $${value.capUsd.toFixed(2)}`,`Gas limit: ${value.signedGasLimit}`,`Gas price: ${(Number(value.gasPrice)/1e9).toFixed(3)} gwei`].join("\n");}
type OpenPostReceiptContext = {
  priorReceiptReuse: boolean;
};
function openReceiptTelemetry(
  input: LadderLiveContext,
  data: {
    executionPhase: string;
    sqliteOperation: string | null;
    retryAttempt: number;
    retryable: boolean;
    priorReceiptReuse: boolean;
    postReceiptRecoveryRequired: boolean;
    userFacingClassification: "OPEN" | "OPEN_REFRESHING";
    duplicateConfirmSuppressed?: boolean;
    sqliteCode?: string;
    retryDisposition?: string;
  },
) {
  try {
    input.telemetry?.("v4_bid_ladder_open_receipt_boundary", {
      ladderId: input.ladderId,
      workflowId: input.ladderId,
      receiptConfirmed: true,
      duplicateConfirmSuppressed: data.duplicateConfirmSuppressed ?? false,
      ...data,
    });
  } catch {}
}
function postReceiptOpenSqliteWrite<T>(
  input: LadderLiveContext,
  operation: string,
  context: OpenPostReceiptContext,
  run: () => T,
) {
  return withSqliteTransientRetrySync({
    operation,
    onEvent: (event) =>
      openReceiptTelemetry(input, {
        executionPhase: "POST_RECEIPT_LOCAL_CONVERGENCE",
        sqliteOperation: operation,
        retryAttempt: event.attempt,
        retryable: event.sqliteCode !== "SQLITE_OK",
        priorReceiptReuse: context.priorReceiptReuse,
        postReceiptRecoveryRequired: event.finalDisposition === "DEFERRED",
        userFacingClassification:
          event.finalDisposition === "DEFERRED" ? "OPEN_REFRESHING" : "OPEN",
        duplicateConfirmSuppressed: context.priorReceiptReuse,
        sqliteCode: event.sqliteCode,
        retryDisposition: event.finalDisposition,
      }),
    run,
  });
}
export async function v4BidLadderNativeUsd(input: {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  reference?: typeof trustedV4WethUsdReference;
  nowMs?: () => number;
}) {
  const price = await (input.reference ?? trustedV4WethUsdReference)({
    rpc: input.rpc,
    repo: input.repo,
  });
  if (price.status !== "available")
    throw new Error(`V4_NATIVE_USD_PRICE_UNAVAILABLE:${price.reason}`);
  const observedAtMs = Date.parse(price.observedAt),
    freshUntilMs = (input.nowMs ?? Date.now)() + 60_000;
  if (
    !Number.isFinite(observedAtMs) ||
    !Number.isFinite(price.value) ||
    price.value <= 0
  )
    throw new Error("V4_NATIVE_USD_PRICE_INVALID");
  return {
    nativeUsd: price.value,
    nativeUsdSource: price.source,
    nativeUsdObservedAtMs: observedAtMs,
    nativeUsdFreshUntilMs: freshUntilMs,
  };
}

function rows(repo: SqliteLedgerRepository, ladderId: string): LadderRows {
  const parent = repo.loadBidLadder(ladderId);
  if (!parent) throw new Error("V4_BID_LADDER_NOT_FOUND");
  if (String(parent.status) === "CANCELLED")
    throw new Error("V4_BID_LADDER_CANCELLED");
  const legs = repo.listBidLadderLegs(ladderId);
  if (
    legs.length !== 5 ||
    legs.some((row, index) => Number(row.leg_index) !== index)
  )
    throw new Error("V4_BID_LADDER_LEG_SET_INVALID");
  const key = {
    currency0: getAddress(String(parent.currency0)),
    currency1: getAddress(String(parent.currency1)),
    fee: Number(parent.fee),
    tickSpacing: Number(parent.tick_spacing),
    hooks: getAddress(String(parent.hooks)),
  } as V4PoolKey;
  if (poolId(key).toLowerCase() !== String(parent.pool_id).toLowerCase())
    throw new Error("V4_BID_LADDER_POOL_KEY_MISMATCH");
  return { parent, legs, key };
}
function tokenDecimals(repo: SqliteLedgerRepository, address: string) {
  const row = repo.tokenMetadata(address);
  if (row) return Number(row.decimals);
  return same(address, robinhoodMainnet.assets.USDG) ? 6 : 18;
}
function positionUsd(
  parent: Record<string, unknown>,
  repo: SqliteLedgerRepository,
  fundingUsd: number,
) {
  return (
    (Number(parent.total_funding_amount_raw) /
      10 ** tokenDecimals(repo, String(parent.funding_token))) *
    fundingUsd
  );
}
function tokenSymbol(
  repo: SqliteLedgerRepository,
  address: string,
  fallback: string,
) {
  const metadata = repo.tokenMetadata(address);
  if (metadata?.symbol) return String(metadata.symbol);
  if (same(address, robinhoodMainnet.assets.USDG)) return "USDG";
  if (same(address, robinhoodMainnet.assets.WETH)) return "WETH";
  return fallback;
}
function displayAmount(raw: bigint, decimals: number) {
  const negative = raw < 0n,
    absolute = negative ? -raw : raw,
    scale = 10n ** BigInt(decimals),
    whole = absolute / scale,
    fraction = (absolute % scale)
      .toString()
      .padStart(decimals, "0")
      .slice(0, Math.min(decimals, 6))
      .replace(/0+$/, ""),
    grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function compactUsd(value: number) {
  const units = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ] as const;
  for (const [unit, label] of units)
    if (value >= unit) {
      const scaled = value / unit;
      return `$${scaled.toLocaleString("en-US", {
        maximumFractionDigits: scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2,
      })}${label}`;
    }
  return `$${value.toLocaleString("en-US", {
    maximumFractionDigits:
      value >= 1
        ? 2
        : Math.min(8, Math.max(2, Math.ceil(-Math.log10(value)) + 2)),
  })}`;
}
function pendingOther(
  repo: SqliteLedgerRepository,
  ladderId: string,
  wallet: string,
) {
  return Number(
    (
      repo.db
        .prepare(
          "SELECT COUNT(*) count FROM chain_transaction_journal WHERE chain_id=? AND lower(wallet_address)=? AND workflow_identity<>? AND status IN ('PREPARED','SUBMITTED')",
        )
        .get(CHAIN_ID, wallet.toLowerCase(), ladderId) as { count: number }
    ).count,
  );
}
function mintPlan(state: LadderRows, wallet: Address, deadline: bigint) {
  const fundingIndex = Number(state.parent.funding_index) as 0 | 1;
  return buildV4BatchMint({
    deadline,
    legs: state.legs.map((leg) => ({
      key: state.key,
      tickLower: Number(leg.tick_lower),
      tickUpper: Number(leg.tick_upper),
      liquidity: BigInt(String(leg.planned_liquidity_raw)),
      amount0Max:
        fundingIndex === 0 ? BigInt(String(leg.funding_amount_raw)) : 0n,
      amount1Max:
        fundingIndex === 1 ? BigInt(String(leg.funding_amount_raw)) : 0n,
      owner: wallet,
      hookData: "0x" as Hex,
      fundingIndex,
    })),
  });
}
function confirmedReceipt(
  row: Record<string, unknown>,
): TransactionReceipt | undefined {
  if (String(row.status) !== "CONFIRMED" || !row.receipt_json) return;
  return JSON.parse(String(row.receipt_json), (key, value) =>
    [
      "blockNumber",
      "cumulativeGasUsed",
      "effectiveGasPrice",
      "gasUsed",
      "blobGasPrice",
      "blobGasUsed",
    ].includes(key) && typeof value === "string"
      ? BigInt(value)
      : value,
  ) as TransactionReceipt;
}
function journalRow(
  repo: SqliteLedgerRepository,
  ladderId: string,
  stage: string,
) {
  return repo.db
    .prepare(
      "SELECT * FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage=? ORDER BY attempt DESC LIMIT 1",
    )
    .get(CHAIN_ID, ladderId, stage) as Record<string, unknown> | undefined;
}

/** Canonical receipt-to-Reposition phase convergence. This is deliberately
 * SQLite-only: callers must release it before principal RPC proof or OPEN work. */
export function convergeConfirmedV4BidLadderRepositionClose(input: {
  repo: SqliteLedgerRepository;
  ladderId: string;
  nowMs?: number;
  correlationId?: string;
  telemetry?: (event: Record<string, unknown>) => void;
}): { result: "APPLIED" | "ALREADY_ADVANCED"; row: Record<string,unknown>; transactionHash: Hash; closeReason: "USDG_RESET_REPOSITION" } {
  return withEconomicForegroundPersistenceSync({
    databasePath: input.repo.path,
    component: "v4-bid-ladder-reposition",
    operation: "v4_bid_ladder_reposition_close_confirmed_cas",
    workflow: input.ladderId,
    semanticStage: "CLOSE_BATCH",
    onTelemetry: (event) => input.telemetry?.({event:"sqlite_write_window",correlationId:input.correlationId??input.ladderId,...event}),
    run: () => input.repo.db.transaction(() => {
      const parent = input.repo.loadBidLadder(input.ladderId),
        reset = input.repo.loadBidLadderUsdReset(input.ladderId),
        phase = String(reset?.phase ?? "MISSING"),
        convergedPhases = new Set(["CLOSE_CONFIRMED","PRINCIPAL_RECONCILED","REOPEN_PLANNED","REOPEN_PREPARED","REOPEN_SUBMITTED","COMPLETED"]);
      if (!parent || !reset) throw new Error("REPOSITION_CLOSE_STATE_MISSING");
      if (!["CLOSE_PREPARED","CLOSE_SUBMITTED"].includes(phase) && !convergedPhases.has(phase))
        throw new Error(`REPOSITION_CLOSE_CONFIRM_PHASE_INVALID:${phase}`);
      if (String(parent.status) !== "CLOSED" || String(parent.close_provenance) !== "FUNI_EXECUTED" || String(parent.terminal_provenance) !== "FUNI_AUTHORED_CLOSE_BATCH")
        throw new Error("REPOSITION_CLOSE_PARENT_NOT_CANONICALLY_CLOSED");
      if (String(reset.policy) !== "USDG_RESET_REPOSITION_V1" || !isManualRepositionAuthorization(reset.close_workflow_identity) || (reset.close_reason !== null && String(reset.close_reason) !== "USDG_RESET_REPOSITION"))
        throw new Error("REPOSITION_DURABLE_MANUAL_AUTHORIZATION_MISSING");
      const rows = input.repo.db.prepare("SELECT * FROM chain_transaction_journal WHERE chain_id=? AND semantic_stage='CLOSE_BATCH' AND (workflow_identity=? OR journal_id LIKE ?) ORDER BY attempt").all(CHAIN_ID,input.ladderId,`${input.ladderId}:CLOSE_BATCH:%`) as Record<string,unknown>[];
      if (rows.length === 0) throw new Error("REPOSITION_CLOSE_JOURNAL_MISSING");
      if (rows.length !== 1) throw new Error("REPOSITION_CLOSE_JOURNAL_CONFLICT");
      const row = rows[0]!;
      if (Number(row.chain_id) !== CHAIN_ID || String(row.workflow_identity) !== input.ladderId || String(row.semantic_stage) !== "CLOSE_BATCH")
        throw new Error("REPOSITION_CLOSE_WORKFLOW_IDENTITY_MISMATCH");
      if (String(row.status) !== "CONFIRMED" || !row.receipt_json)
        throw new Error("REPOSITION_CLOSE_RECEIPT_NOT_CONFIRMED");
      const receipt = confirmedReceipt(row), prepared = preparedFrom(row);
      if (!receipt || receipt.status !== "success") throw new Error("REPOSITION_CLOSE_CONFIRMED_REVERT");
      if (!prepared?.request?.data || !same(prepared.expectedHash,String(row.expected_hash)) || !same(receipt.transactionHash,String(row.expected_hash)) || Number(prepared.request.nonce) !== Number(row.nonce))
        throw new Error("REPOSITION_CLOSE_RECEIPT_HASH_OR_PREPARED_EVIDENCE_MISMATCH");
      if (convergedPhases.has(phase)) {
        if (String(reset.close_reason) !== "USDG_RESET_REPOSITION") throw new Error("REPOSITION_CLOSE_REASON_INVALID");
        return { result: "ALREADY_ADVANCED" as const,row: reset,transactionHash: receipt.transactionHash,closeReason: "USDG_RESET_REPOSITION" as const };
      }
      const nowMs = input.nowMs ?? Date.now(), expectedRevision = Number(reset.revision),
        changed = input.repo.db.prepare("UPDATE v4_bid_ladder_usdg_reset_v1 SET phase='CLOSE_CONFIRMED',close_reason='USDG_RESET_REPOSITION',close_workflow_identity=?,block_reason=NULL,revision=revision+1,updated_at_ms=? WHERE ladder_id=? AND phase=? AND revision=?")
          .run(String(reset.close_workflow_identity),nowMs,input.ladderId,phase,expectedRevision).changes;
      if (changed !== 1) throw new Error("REPOSITION_CLOSE_CONFIRM_TRANSITION_CONFLICT");
      const rowAfter = input.repo.loadBidLadderUsdReset(input.ladderId)!;
      return { result: "APPLIED" as const,row: rowAfter,transactionHash: receipt.transactionHash,closeReason: "USDG_RESET_REPOSITION" as const };
    })(),
  });
}
function confirmedOpenTokenIds(receipt: TransactionReceipt) {
  return receipt.logs.flatMap((log) => {
    if (!same(log.address, V4_ROBINHOOD_DEPLOYMENTS.positionManager)) return [];
    try {
      const event = decodeEventLog({
        abi: [nftTransferEvent],
        data: log.data,
        topics: log.topics,
      });
      return event.eventName === "Transfer" && same(event.args.from, zeroAddress)
        ? [event.args.id]
        : [];
    } catch {
      return [];
    }
  });
}
export function confirmedV4BidLadderOpenTruth(
  repo: SqliteLedgerRepository,
  ladderId: string,
) {
  const receipt = confirmedReceipt(journalRow(repo, ladderId, "OPEN_BATCH") ?? {});
  if (!receipt || receipt.status !== "success") return;
  const closeReceipt = confirmedReceipt(journalRow(repo, ladderId, "CLOSE_BATCH") ?? {}),
    parent = repo.loadBidLadder(ladderId),
    legs = repo.listBidLadderLegs(ladderId),
    persistedIds = legs.length === 5 && legs.every((leg) => leg.token_id)
      ? legs.map((leg) => BigInt(String(leg.token_id)))
      : [],
    receiptIds = confirmedOpenTokenIds(receipt);
  return {
    receiptConfirmed: true as const,
    hash: receipt.transactionHash,
    receipt,
    tokenIds: persistedIds.length === 5 ? persistedIds : receiptIds,
    currentStatus: String(parent?.status ?? "UNKNOWN"),
    supersededByConfirmedClose: closeReceipt?.status === "success",
    projectionComplete:
      String(parent?.status) === "OPEN" &&
      legs.length === 5 &&
      legs.every(
        (leg) =>
          String(leg.status) === "OPEN" &&
          leg.token_id &&
          repo.v4Position(String(leg.token_id)) &&
          repo.db
            .prepare("SELECT 1 FROM active_position_reconciliations WHERE position_id=?")
            .get(`v4:${String(leg.token_id)}`),
      ),
  };
}
export const v4BidLadderCollectStage = (authorizationId: string):`COLLECT_BATCH:${string}` => {
  if (!/^[0-9a-f]{18}$/.test(authorizationId))
    throw new Error("V4_BID_LADDER_COLLECT_AUTHORIZATION_INVALID");
  return `COLLECT_BATCH:${authorizationId}`;
};
function preparedFrom(
  row: Record<string, unknown> | undefined,
): DurablePreparedTransaction | undefined {
  if (!row) return;
  try {
    const raw = JSON.parse(String(row.provider_evidence_json ?? "{}")).prepared;
    if (!raw) return;
    return {
      ...raw,
      request: {
        ...raw.request,
        value: BigInt(raw.request.value),
        gas: BigInt(raw.request.gas),
        gasPrice: BigInt(raw.request.gasPrice),
      },
    };
  } catch {
    throw new Error("V4_BID_LADDER_PREPARED_REQUEST_INVALID");
  }
}
type BoundCloseValuation={contract:"DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V1";poolId:string;poolKey:V4PoolKey;sqrtPriceX96:string;tick:number;activeLiquidity:string;initialized:boolean;observationBlock:string;observedAtMs:number;token0Decimals:number;token1Decimals:number};
function closeValuationFromJournal(repo:SqliteLedgerRepository,ladderId:string):BoundCloseValuation|undefined{const row=journalRow(repo,ladderId,"CLOSE_BATCH");try{const value=JSON.parse(String(row?.provider_evidence_json??"{}")).closeValuation as BoundCloseValuation|undefined;if(!value||value.contract!=="DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V1"||!/^\d+$/.test(value.sqrtPriceX96)||!/^\d+$/.test(value.activeLiquidity)||!/^\d+$/.test(value.observationBlock)||!Number.isInteger(value.tick)||typeof value.initialized!=="boolean"||!Number.isSafeInteger(value.observedAtMs))return;return value;}catch{return;}}
type BoundCollectValuation={contract:"DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V1";status:"AVAILABLE"|"INCOMPLETE";poolId:string;poolKey:V4PoolKey;sqrtPriceX96:string|null;tick:number|null;activeLiquidity:string|null;initialized:boolean|null;observationBlock:string;observedAtMs:number;token0Decimals:number;token1Decimals:number;evidenceSource:"ARCHIVAL_STATEVIEW_BLOCK_END_NO_LATER_POOL_SWAP";receiptTransactionIndex:number|null;sameBlockLaterPoolSwaps:number;reason?:"INCOMPLETE_HISTORICAL_POOL_STATE_UNAVAILABLE"|"INCOMPLETE_SAME_BLOCK_PRICE_AMBIGUITY"};
const v4SwapEvent=parseAbiItem("event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)");
function collectValuationFromJournal(repo:SqliteLedgerRepository,ladderId:string,stage:string):BoundCollectValuation|undefined{const row=journalRow(repo,ladderId,stage);try{const value=JSON.parse(String(row?.provider_evidence_json??"{}")).collectValuation as BoundCollectValuation|undefined;if(!value||value.contract!=="DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V1"||!/^\d+$/.test(value.observationBlock)||!Number.isSafeInteger(value.observedAtMs)||!same(value.poolId,String(poolId(value.poolKey))))return;if(value.status==="AVAILABLE"&&(!value.sqrtPriceX96||!/^\d+$/.test(value.sqrtPriceX96)||!Number.isInteger(value.tick)||!value.activeLiquidity||!/^\d+$/.test(value.activeLiquidity)||typeof value.initialized!=="boolean"))return;return value;}catch{return;}}
function persistCollectValuation(repo:SqliteLedgerRepository,ladderId:string,stage:string,value:BoundCollectValuation){const row=journalRow(repo,ladderId,stage);if(!row)throw new Error("V4_BID_LADDER_COLLECT_JOURNAL_MISSING");let prior:Record<string,unknown>={};try{prior=JSON.parse(String(row.provider_evidence_json??"{}"));}catch{}repo.db.prepare("UPDATE chain_transaction_journal SET provider_evidence_json=?,updated_at=? WHERE chain_id=? AND journal_id=? AND status='CONFIRMED'").run(json({...prior,collectValuation:value}),new Date().toISOString(),CHAIN_ID,String(row.journal_id));return value;}
async function captureCollectValuation(input:LadderLiveContext,state:LadderRows,receipt:TransactionReceipt,stage:string):Promise<BoundCollectValuation>{const existing=collectValuationFromJournal(input.repo,input.ladderId,stage);if(existing?.status==="AVAILABLE")return existing;const observedAtMs=Date.now(),base={contract:"DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V1" as const,poolId:String(state.parent.pool_id),poolKey:state.key,observationBlock:receipt.blockNumber.toString(),observedAtMs,token0Decimals:tokenDecimals(input.repo,state.key.currency0),token1Decimals:tokenDecimals(input.repo,state.key.currency1),evidenceSource:"ARCHIVAL_STATEVIEW_BLOCK_END_NO_LATER_POOL_SWAP" as const,receiptTransactionIndex:Number.isSafeInteger(receipt.transactionIndex)?receipt.transactionIndex:null};let laterPoolSwaps:number|null=null;try{if(base.receiptTransactionIndex===null)throw new Error("RECEIPT_TRANSACTION_INDEX_UNAVAILABLE");const swaps=await input.rpc.withClient(client=>client.getLogs({address:V4_ROBINHOOD_DEPLOYMENTS.poolManager,event:v4SwapEvent,args:{id:base.poolId as Hash},fromBlock:receipt.blockNumber,toBlock:receipt.blockNumber}),{stage:"v4_collect_historical_valuation",method:"PoolManager.Swap"});laterPoolSwaps=swaps.filter(log=>log.transactionIndex===null||Number(log.transactionIndex)>base.receiptTransactionIndex!).length;if(laterPoolSwaps>0)throw new Error("LATER_POOL_SWAP_PRESENT");}catch{return persistCollectValuation(input.repo,input.ladderId,stage,{...base,status:"INCOMPLETE",sqrtPriceX96:null,tick:null,activeLiquidity:null,initialized:null,sameBlockLaterPoolSwaps:laterPoolSwaps??-1,reason:"INCOMPLETE_SAME_BLOCK_PRICE_AMBIGUITY"});}const pool=await inspectV4Pool(input.rpc,state.key,receipt.blockNumber);if(pool.status==="unavailable"||!same(pool.value.id,base.poolId)||pool.value.blockNumber!==receipt.blockNumber)return persistCollectValuation(input.repo,input.ladderId,stage,{...base,status:"INCOMPLETE",sqrtPriceX96:null,tick:null,activeLiquidity:null,initialized:null,sameBlockLaterPoolSwaps:0,reason:"INCOMPLETE_HISTORICAL_POOL_STATE_UNAVAILABLE"});return persistCollectValuation(input.repo,input.ladderId,stage,{...base,status:"AVAILABLE",sqrtPriceX96:pool.value.sqrtPriceX96.toString(),tick:pool.value.tick,activeLiquidity:pool.value.liquidity.toString(),initialized:pool.value.initialized,sameBlockLaterPoolSwaps:0});}
export function captureV4BidLadderCollectValuation(input:LadderLiveContext,receipt:TransactionReceipt,stage:`COLLECT_BATCH:${string}`){return captureCollectValuation(input,rows(input.repo,input.ladderId),receipt,stage);}
type CloseFeeLeg={tokenId:bigint;liquidity:bigint;tickLower:number;tickUpper:number};
type BoundCloseFeeAttribution={
  contract:"V4_BID_LADDER_CLOSE_FEE_ATTRIBUTION_V1";
  status:"AVAILABLE"|"INCOMPLETE";
  poolId:string;
  poolKey:V4PoolKey;
  sqrtPriceX96:string|null;
  tick:number|null;
  activeLiquidity:string|null;
  initialized:boolean|null;
  observationBlock:string;
  observedAtMs:number;
  token0Decimals:number;
  token1Decimals:number;
  evidenceSource:"ARCHIVAL_STATEVIEW_BLOCK_END_NO_LATER_POOL_SWAP";
  receiptBlockNumber:string;
  receiptBlockHash:string;
  receiptTransactionIndex:number|null;
  sameBlockLaterPoolSwaps:number;
  aggregateReturned0Raw:string;
  aggregateReturned1Raw:string;
  aggregatePrincipal0Raw:string|null;
  aggregatePrincipal1Raw:string|null;
  closeFee0Raw:string|null;
  closeFee1Raw:string|null;
  rawInvariantExact:boolean;
  perNft:Array<{tokenId:string;liquidityRaw:string;tickLower:number;tickUpper:number;principal0Raw:string;principal1Raw:string}>;
  reason?:"INCOMPLETE_HISTORICAL_POOL_STATE_UNAVAILABLE"|"INCOMPLETE_SAME_BLOCK_PRICE_AMBIGUITY"|"INCOMPLETE_UNSUPPORTED_POOL"|"INCOMPLETE_CLOSE_PRINCIPAL_EXCEEDS_RETURN";
};
function closeFeeAttributionFromJournal(repo:SqliteLedgerRepository,ladderId:string){const row=journalRow(repo,ladderId,"CLOSE_BATCH");try{const value=JSON.parse(String(row?.provider_evidence_json??"{}")).closeFeeAttribution as BoundCloseFeeAttribution|undefined;if(!value||value.contract!=="V4_BID_LADDER_CLOSE_FEE_ATTRIBUTION_V1"||!/^\d+$/.test(value.observationBlock)||!same(value.poolId,String(poolId(value.poolKey))))return;if(value.status==="AVAILABLE"&&(!value.sqrtPriceX96||!Number.isInteger(value.tick)||!value.activeLiquidity||!/^\d+$/.test(value.activeLiquidity)||typeof value.initialized!=="boolean"))return;return value;}catch{return;}}
function persistCloseFeeAttribution(repo:SqliteLedgerRepository,ladderId:string,value:BoundCloseFeeAttribution){const row=journalRow(repo,ladderId,"CLOSE_BATCH");if(!row)throw new Error("V4_BID_LADDER_CLOSE_JOURNAL_MISSING");let prior:Record<string,unknown>={};try{prior=JSON.parse(String(row.provider_evidence_json??"{}"));}catch{}const next=json({...prior,closeFeeAttribution:value});if(String(row.provider_evidence_json)!==next)repo.db.prepare("UPDATE chain_transaction_journal SET provider_evidence_json=?,updated_at=? WHERE chain_id=? AND journal_id=? AND status='CONFIRMED'").run(next,new Date().toISOString(),CHAIN_ID,String(row.journal_id));return value;}
export function exactV4BidLadderClosePrincipalFeeDecomposition(input:{sqrtPriceX96:bigint;aggregateReturned0Raw:bigint;aggregateReturned1Raw:bigint;legs:readonly CloseFeeLeg[]}){
  const perNft=input.legs.map(leg=>{const principal=amountsForLiquidity(input.sqrtPriceX96,leg.tickLower,leg.tickUpper,leg.liquidity);return {tokenId:leg.tokenId.toString(),liquidityRaw:leg.liquidity.toString(),tickLower:leg.tickLower,tickUpper:leg.tickUpper,principal0Raw:principal.token0.toString(),principal1Raw:principal.token1.toString()};}),principal=perNft.reduce((sum,leg)=>({token0:sum.token0+BigInt(leg.principal0Raw),token1:sum.token1+BigInt(leg.principal1Raw)}),{token0:0n,token1:0n});
  if(input.aggregateReturned0Raw<principal.token0||input.aggregateReturned1Raw<principal.token1)return {status:"INCOMPLETE" as const,reason:"INCOMPLETE_CLOSE_PRINCIPAL_EXCEEDS_RETURN" as const,perNft,principal};
  const fees={token0:input.aggregateReturned0Raw-principal.token0,token1:input.aggregateReturned1Raw-principal.token1};
  if(principal.token0+fees.token0!==input.aggregateReturned0Raw||principal.token1+fees.token1!==input.aggregateReturned1Raw)throw new Error("V4_BID_LADDER_CLOSE_RAW_INVARIANT_FAILED");
  return {status:"AVAILABLE" as const,perNft,principal,fees};
}
async function captureCloseFeeAttribution(input:LadderLiveContext,state:LadderRows,receipt:TransactionReceipt,expected:readonly CloseFeeLeg[],returned:{token0:bigint;token1:bigint}):Promise<BoundCloseFeeAttribution>{
  const existing=closeFeeAttributionFromJournal(input.repo,input.ladderId);if(existing){if(existing.receiptBlockNumber!==receipt.blockNumber.toString()||existing.receiptBlockHash.toLowerCase()!==String(receipt.blockHash).toLowerCase()||existing.aggregateReturned0Raw!==returned.token0.toString()||existing.aggregateReturned1Raw!==returned.token1.toString())throw new Error("V4_BID_LADDER_CLOSE_FEE_EVIDENCE_IDENTITY_CONFLICT");return existing;}
  const observedAtMs=Date.now(),base={contract:"V4_BID_LADDER_CLOSE_FEE_ATTRIBUTION_V1" as const,poolId:String(state.parent.pool_id),poolKey:state.key,observationBlock:receipt.blockNumber.toString(),observedAtMs,token0Decimals:tokenDecimals(input.repo,state.key.currency0),token1Decimals:tokenDecimals(input.repo,state.key.currency1),evidenceSource:"ARCHIVAL_STATEVIEW_BLOCK_END_NO_LATER_POOL_SWAP" as const,receiptBlockNumber:receipt.blockNumber.toString(),receiptBlockHash:String(receipt.blockHash),receiptTransactionIndex:Number.isSafeInteger(receipt.transactionIndex)?receipt.transactionIndex:null,aggregateReturned0Raw:returned.token0.toString(),aggregateReturned1Raw:returned.token1.toString()},empty={aggregatePrincipal0Raw:null,aggregatePrincipal1Raw:null,closeFee0Raw:null,closeFee1Raw:null,rawInvariantExact:false,perNft:[] as BoundCloseFeeAttribution["perNft"]};
  let laterPoolSwaps:number|null=null;
  try{if(base.receiptTransactionIndex===null)throw new Error("RECEIPT_TRANSACTION_INDEX_UNAVAILABLE");const swaps=await input.rpc.withClient(client=>client.getLogs({address:V4_ROBINHOOD_DEPLOYMENTS.poolManager,event:v4SwapEvent,args:{id:base.poolId as Hash},fromBlock:receipt.blockNumber,toBlock:receipt.blockNumber}),{stage:"v4_close_fee_historical_valuation",method:"PoolManager.Swap"});laterPoolSwaps=swaps.filter(log=>log.transactionIndex===null||Number(log.transactionIndex)>base.receiptTransactionIndex!).length;if(laterPoolSwaps>0)throw new Error("LATER_POOL_SWAP_PRESENT");}catch{return persistCloseFeeAttribution(input.repo,input.ladderId,{...base,...empty,status:"INCOMPLETE",sqrtPriceX96:null,tick:null,activeLiquidity:null,initialized:null,sameBlockLaterPoolSwaps:laterPoolSwaps??-1,reason:"INCOMPLETE_SAME_BLOCK_PRICE_AMBIGUITY"});}
  const pool=await inspectV4Pool(input.rpc,state.key,receipt.blockNumber);if(pool.status==="unavailable"||!same(pool.value.id,base.poolId)||pool.value.blockNumber!==receipt.blockNumber)return persistCloseFeeAttribution(input.repo,input.ladderId,{...base,...empty,status:"INCOMPLETE",sqrtPriceX96:null,tick:null,activeLiquidity:null,initialized:null,sameBlockLaterPoolSwaps:0,reason:"INCOMPLETE_HISTORICAL_POOL_STATE_UNAVAILABLE"});
  const poolState={sqrtPriceX96:pool.value.sqrtPriceX96.toString(),tick:pool.value.tick,activeLiquidity:pool.value.liquidity.toString(),initialized:pool.value.initialized};
  if(v4ExecutionBlockers(pool.value).length)return persistCloseFeeAttribution(input.repo,input.ladderId,{...base,...empty,status:"INCOMPLETE",...poolState,sameBlockLaterPoolSwaps:0,reason:"INCOMPLETE_UNSUPPORTED_POOL"});
  const split=exactV4BidLadderClosePrincipalFeeDecomposition({sqrtPriceX96:pool.value.sqrtPriceX96,aggregateReturned0Raw:returned.token0,aggregateReturned1Raw:returned.token1,legs:expected});if(split.status==="INCOMPLETE")return persistCloseFeeAttribution(input.repo,input.ladderId,{...base,status:"INCOMPLETE",...poolState,sameBlockLaterPoolSwaps:0,aggregatePrincipal0Raw:split.principal.token0.toString(),aggregatePrincipal1Raw:split.principal.token1.toString(),closeFee0Raw:null,closeFee1Raw:null,rawInvariantExact:false,perNft:split.perNft,reason:split.reason});
  return persistCloseFeeAttribution(input.repo,input.ladderId,{...base,status:"AVAILABLE",...poolState,sameBlockLaterPoolSwaps:0,aggregatePrincipal0Raw:split.principal.token0.toString(),aggregatePrincipal1Raw:split.principal.token1.toString(),closeFee0Raw:split.fees.token0.toString(),closeFee1Raw:split.fees.token1.toString(),rawInvariantExact:true,perNft:split.perNft});
}
export function captureV4BidLadderCloseFeeAttribution(input:LadderLiveContext,receipt:TransactionReceipt,expected:readonly CloseFeeLeg[],returned:{token0:bigint;token1:bigint}){return captureCloseFeeAttribution(input,rows(input.repo,input.ladderId),receipt,expected,returned);}
export function v4BidLadderClosePairLabel(input:{targetSymbol?:unknown;fundingSymbol?:unknown;targetAddress:unknown;fundingAddress:unknown}){const short=(value:unknown)=>{const text=String(value);return text.length>14?`${text.slice(0,6)}…${text.slice(-4)}`:text;};return `${String(input.targetSymbol??"").trim()||short(input.targetAddress)}/${String(input.fundingSymbol??"").trim()||short(input.fundingAddress)}`;}
function batchId(ladderId: string, stage: string, attempt = 0) {
  return `${ladderId}:${stage}:${attempt}`;
}
function throwPostBroadcastSqlitePending(
  input: LadderLiveContext,
  stage: string,
  error: unknown,
): never {
  if (sqliteTransientCode(error)) {
    const row = journalRow(input.repo, input.ladderId, stage);
    if (
      row &&
      ["PREPARED", "SUBMITTED", "CONFIRMED"].includes(String(row.status))
    )
      throw new DurableTransactionReconciliationPendingError(
        input.ladderId,
        stage,
        String(row.expected_hash) as Hash,
        Number(row.nonce),
        "SQLITE_BUSY_AFTER_POSSIBLE_BROADCAST",
      );
  }
  throw error;
}
async function postBroadcastSqliteBoundary<T>(
  input: LadderLiveContext,
  stage: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throwPostBroadcastSqlitePending(input, stage, error);
  }
}
function receiptShape(receipt: TransactionReceipt) {
  return {
    status: "success" as const,
    transactionHash: receipt.transactionHash,
    logs: receipt.logs.map((log) => ({
      address: log.address,
      data: log.data,
      topics: log.topics,
      logIndex: Number(log.logIndex),
      transactionHash: log.transactionHash!,
    })),
  };
}
function sameKey(a: V4PoolKey, b: V4PoolKey) {
  return (
    same(a.currency0, b.currency0) &&
    same(a.currency1, b.currency1) &&
    a.fee === b.fee &&
    a.tickSpacing === b.tickSpacing &&
    same(a.hooks, b.hooks)
  );
}
function receiptFundingSpent(
  receipt: TransactionReceipt,
  owner: Address,
  funding: Address,
) {
  let total = 0n;
  for (const log of receipt.logs) {
    if (!same(log.address, funding)) continue;
    try {
      const event = decodeEventLog({
        abi: [transferEvent],
        data: log.data,
        topics: log.topics,
      });
      if (event.eventName === "Transfer" && same(event.args.from, owner))
        total += event.args.value;
    } catch {
      /* unrelated funding-token log */
    }
  }
  return total;
}
function openPreparedCalldata(row: Record<string, unknown>) {
  try {
    const data = JSON.parse(String(row.provider_evidence_json ?? "{}")).prepared
      ?.request?.data;
    if (typeof data !== "string" || !/^0x[0-9a-f]+$/i.test(data))
      throw new Error();
    return data as Hex;
  } catch {
    throw new Error("V4_BID_LADDER_OPEN_PREPARED_CALLDATA_MISSING");
  }
}
function assertMirrorIdentity(
  repo: SqliteLedgerRepository,
  input: {
    positionId: string;
    tokenId: bigint;
    owner: Address;
    poolId: string;
    key: V4PoolKey;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    mintHash: Hash;
    ladderId: string;
    target: Address;
    funding: Address;
    targetIndex: 0 | 1;
    fundingIndex: 0 | 1;
    targetDecimals: number;
    fundingDecimals: number;
    depositId: string;
    depositLogIndex: number;
    fundingAmount: bigint;
    blockNumber: bigint;
  },
) {
  const generic = repo.db
    .prepare("SELECT * FROM positions WHERE id=?")
    .get(input.positionId) as Record<string, unknown> | undefined;
  if (
    generic &&
    (!same(String(generic.token_id), input.tokenId.toString()) ||
      !same(String(generic.pool_address), input.poolId) ||
      String(generic.status) !== "open" ||
      Number(generic.chain_id) !== 4663 ||
      String(generic.protocol) !== "uniswap_v4")
  )
    throw new Error("V4_BID_LADDER_CANONICAL_POSITION_CONFLICT");
  const row = repo.v4Position(input.tokenId);
  if (
    row &&
    (!same(String(row.owner), input.owner) ||
      !same(String(row.pool_id), input.poolId) ||
      !sameKey(JSON.parse(String(row.pool_key_json)), input.key) ||
      !same(String(row.currency0), input.key.currency0) ||
      !same(String(row.currency1), input.key.currency1) ||
      Number(row.fee) !== input.key.fee ||
      Number(row.tick_spacing) !== input.key.tickSpacing ||
      !same(String(row.hooks), input.key.hooks) ||
      Number(row.tick_lower) !== input.tickLower ||
      Number(row.tick_upper) !== input.tickUpper ||
      BigInt(String(row.liquidity_raw)) !== input.liquidity ||
      String(row.status) !== "open" ||
      !same(String(row.mint_hash), input.mintHash) ||
      !same(String(row.target_token), input.target) ||
      !same(String(row.funding_token), input.funding) ||
      Number(row.target_index) !== input.targetIndex ||
      Number(row.funding_index) !== input.fundingIndex ||
      Number(row.target_decimals) !== input.targetDecimals ||
      Number(row.funding_decimals) !== input.fundingDecimals ||
      String(row.open_intent_id) !== input.ladderId)
  )
    throw new Error("V4_BID_LADDER_CANONICAL_V4_POSITION_CONFLICT");
  const deposit = repo.db
      .prepare("SELECT * FROM position_deposits WHERE id=?")
      .get(input.depositId) as Record<string, unknown> | undefined,
    amount0 = input.fundingIndex === 0 ? input.fundingAmount : 0n,
    amount1 = input.fundingIndex === 1 ? input.fundingAmount : 0n;
  if (
    deposit &&
    (String(deposit.position_id) !== input.positionId ||
      !same(String(deposit.tx_hash), input.mintHash) ||
      Number(deposit.log_index) !== input.depositLogIndex ||
      BigInt(String(deposit.token0_raw)) !== amount0 ||
      BigInt(String(deposit.token1_raw)) !== amount1 ||
      BigInt(String(deposit.block_number)) !== input.blockNumber)
  )
    throw new Error("V4_BID_LADDER_CANONICAL_DEPOSIT_CONFLICT");
  return { generic, row, deposit };
}

async function submit(
  input: LadderLiveContext & {
    walletClient: WalletClient;
    stage: string;
    to: Address;
    data: Hex;
    estimatedGas: bigint;
    activateOpen?: boolean;
    batchBinding?: "open" | "close";
    closeReason?: "NORMAL_OPERATOR_CLOSE" | "USDG_RESET_REPOSITION";
    manualRepositionAuthorization?: string;
    closeValuation?: BoundCloseValuation;
  },
) {
  const timing: {
    journalPreparedAtMs?: number;
    signedAtMs?: number;
    broadcastAtMs?: number;
    receiptDetectedAtMs?: number;
  } = {};
  assertDurableV4RecoveryStage(input.stage);
  const existing = journalRow(input.repo, input.ladderId, input.stage),
    attempt =
      String(existing?.status) === "FAILED"
        ? Number(existing!.attempt) + 1
        : Number(existing?.attempt ?? 0),
    id = batchId(input.ladderId, input.stage, attempt),
    already = confirmedReceipt(existing ?? {});
  if (already)
    return { hash: already.transactionHash, receipt: already, recovered: true, timing };
  const result = await broadcastDurableTransaction({
    repo: input.repo,
    rpc: input.rpc,
    walletClient: input.walletClient,
    wallet: input.wallet,
    workflowId: input.ladderId,
    semanticStage: input.stage,
    to: input.to,
    data: input.data,
    estimatedGas: input.estimatedGas,
    attempt,
    journal: {
      load: () =>
        (() => {
          const row = journalRow(input.repo, input.ladderId, input.stage);
          return row && ["PREPARED", "SUBMITTED"].includes(String(row.status))
            ? preparedFrom(row)
            : undefined;
        })(),
      persistPrepared: (prepared) => {
        const providerEvidence = json({ prepared, ...(input.closeValuation?{closeValuation:input.closeValuation}:{}) });
        input.repo.db.transaction(() => {
              input.repo.persistChainPreparedTransaction({
                chainId: CHAIN_ID,
                chainKey: CHAIN_KEY,
                protocol: PROTOCOL,
                journalId: id,
                wallet: input.wallet,
                workflowIdentity: input.ladderId,
                semanticStage: input.stage,
                attempt,
                nonce: prepared.request.nonce,
                transactionType: input.stage,
                expectedHash: prepared.expectedHash,
                to: prepared.request.to,
                requestFingerprint: prepared.requestFingerprint,
                feeModel: "legacy",
                projectedGasNative:
                  prepared.request.gas * prepared.request.gasPrice,
              });
              input.repo.db
                .prepare(
                  "UPDATE chain_transaction_journal SET provider_evidence_json=? WHERE chain_id=? AND journal_id=?",
                )
                .run(providerEvidence, CHAIN_ID, id);
              if (input.activateOpen || input.batchBinding === "open") {
                const state = rows(input.repo, input.ladderId),
                  changed = input.repo.db
                    .prepare(
                      "UPDATE v4_bid_ladders SET execution_mode='LIVE',entry_usd_snapshot=COALESCE(entry_usd_snapshot,?),updated_at_ms=?,revision=revision+1 WHERE ladder_id=? AND status='PLANNED' AND execution_mode IN ('DRY_RUN','LIVE') AND revision=?",
                    )
                    .run(
                      positionUsd(state.parent, input.repo, input.fundingUsd),
                      Date.now(),
                      input.ladderId,
                      Number(state.parent.revision),
                    ).changes;
                if (changed !== 1)
                  throw new Error("V4_BID_LADDER_OPEN_ADMISSION_CONFLICT");
              }
              if (input.batchBinding === "open")
                input.repo.db
                  .prepare(
                    "UPDATE v4_bid_ladder_legs SET open_batch_id=?,updated_at_ms=? WHERE ladder_id=?",
                  )
                  .run(id, Date.now(), input.ladderId);
              if (input.batchBinding === "open") {
                const child = input.repo.loadBidLadderUsdReset(input.ladderId),
                  previous = child?.previous_ladder_id
                    ? input.repo.loadBidLadderUsdReset(
                        String(child.previous_ladder_id),
                      )
                    : undefined;
                if (previous && String(previous.phase) === "REOPEN_PLANNED")
                  input.repo.transitionBidLadderUsdReset({
                    ladderId: String(previous.ladder_id),
                    from: "REOPEN_PLANNED",
                    to: "REOPEN_PREPARED",
                    reopenWorkflowIdentity: input.ladderId,
                  });
              }
              if (input.batchBinding === "close")
                input.repo.db
                  .prepare(
                    "UPDATE v4_bid_ladder_legs SET close_batch_id=?,updated_at_ms=? WHERE ladder_id=? AND status='OPEN'",
                  )
                  .run(id, Date.now(), input.ladderId);
              if (
                input.batchBinding === "close" &&
                input.closeReason === "USDG_RESET_REPOSITION"
              ) {
                const reset = input.repo.loadBidLadderUsdReset(input.ladderId);
                if (!reset)
                  throw new Error("V4_BID_LADDER_USDG_RESET_NOT_ENABLED");
                if (String(reset.phase) === "WATCHING") {
                  if (
                    !isManualRepositionAuthorization(
                      input.manualRepositionAuthorization,
                    )
                  )
                    throw new Error("REPOSITION_MANUAL_AUTHORIZATION_REQUIRED");
                  input.repo.transitionBidLadderUsdReset({
                    ladderId: input.ladderId,
                    from: "WATCHING",
                    to: "CLOSE_PREPARED",
                    closeWorkflowIdentity: input.manualRepositionAuthorization,
                  });
                } else if (
                  String(reset.phase) !== "CLOSE_PREPARED" ||
                  !isManualRepositionAuthorization(
                    reset.close_workflow_identity,
                  )
                )
                  throw new Error(
                    "V4_BID_LADDER_USDG_RESET_CLOSE_PHASE_INVALID",
                  );
              }
            })();
        timing.journalPreparedAtMs = Date.now();
      },
      markSubmitted: () => {
        input.repo.db.transaction(() => {
          // Re-read on every canonical retry. Another recovery consumer may
          // already have advanced either journal or workflow state.
          const row = journalRow(input.repo, input.ladderId, input.stage);
          if (!row) return;
          if (String(row.status) === "PREPARED")
            input.repo.transitionChainTransaction({
              chainId: CHAIN_ID,
              journalId: id,
              from: "PREPARED",
              to: "SUBMITTED",
            });
          if (
            input.batchBinding === "close" &&
            input.closeReason === "USDG_RESET_REPOSITION"
          ) {
            const reset = input.repo.loadBidLadderUsdReset(input.ladderId);
            if (String(reset?.phase) === "CLOSE_PREPARED")
              input.repo.transitionBidLadderUsdReset({
                ladderId: input.ladderId,
                from: "CLOSE_PREPARED",
                to: "CLOSE_SUBMITTED",
              });
          }
          if (input.batchBinding === "open") {
            const child = input.repo.loadBidLadderUsdReset(input.ladderId),
              previous = child?.previous_ladder_id
                ? input.repo.loadBidLadderUsdReset(
                    String(child.previous_ladder_id),
                  )
                : undefined;
            if (previous && String(previous.phase) === "REOPEN_PREPARED")
              input.repo.transitionBidLadderUsdReset({
                ladderId: String(previous.ladder_id),
                from: "REOPEN_PREPARED",
                to: "REOPEN_SUBMITTED",
                reopenWorkflowIdentity: input.ladderId,
              });
          }
        })();
        timing.signedAtMs ??= Date.now();
        timing.broadcastAtMs = Date.now();
      },
      handoffRecovery: (prepared) =>
        ensureEconomicReconciliationWork(input.repo, {
          chainId: CHAIN_ID,
          workflowKind: bidLadderWorkKind(input.stage),
          workflowIdentity: input.ladderId,
          semanticStage: input.stage,
          transactionHash: prepared.expectedHash,
          sourceTable: "chain_transaction_journal",
          sourceIdentity: id,
          priority: bidLadderWorkKind(input.stage) === "V4_BID_LADDER_OPEN" ? 1_000 : 500,
        }),
    },
    beforeSigning: ({ gasLimit, gasPrice }) => {
      const projection=v4BidLadderGasProjection({estimatedGas:input.estimatedGas,signedGasLimit:gasLimit,gasPrice,gasPriceAlreadyBuffered:true,nativeUsd:input.nativeUsd,nativeUsdSource:input.nativeUsdSource,capUsd:input.runtime.maxGasUsd});
      try{input.telemetry?.("v4_bid_ladder_gas_cap_validation",{ladderId:input.ladderId,stage:input.stage,outcome:projection.exceedsCap?"BLOCKED":"PASS",estimateGas:projection.estimatedGas.toString(),signedGasLimit:projection.signedGasLimit.toString(),gasLimitInflationFactor:projection.gasLimitInflationFactor,gasPriceWei:projection.gasPrice.toString(),gasPriceGwei:Number(projection.gasPrice)/1e9,nativeUsd:projection.nativeUsd,nativeUsdSource:projection.nativeUsdSource,nativeUsdObservedAtMs:input.nativeUsdObservedAtMs??null,estimatedExecutionUsd:projection.estimatedExecutionUsd,maximumProjectedFeeUsd:projection.maximumProjectedFeeUsd,configuredCapUsd:projection.capUsd,failureStage:projection.exceedsCap?"BEFORE_SIGNING_GAS_CAP":null,signingUsed:false,broadcastUsed:false});}catch{}
      if (projection.exceedsCap) throw new Error(formatV4BidLadderGasCapExceeded(projection));
    },
  });
  const receipt = (result.receipt ??
    (await input.rpc.withClient((client) =>
      client.waitForTransactionReceipt({ hash: result.hash, timeout: 60_000 }),
    ))) as TransactionReceipt;
  timing.receiptDetectedAtMs = Date.now();
  const persistTerminal = <T>(operation: string, run: () => T) =>
    withEconomicForegroundPersistenceSync({
      databasePath: input.repo.path,
      component: "v4-bid-ladder-terminal-journal",
      operation,
      workflow: input.ladderId,
      semanticStage: input.stage,
      run,
      onTelemetry: (event) => input.telemetry?.("sqlite_write_window", event),
    });
  if (receipt.status !== "success") {
    const failed = journalRow(input.repo, input.ladderId, input.stage);
    if (failed && ["PREPARED", "SUBMITTED"].includes(String(failed.status))) {
      const from = String(failed.status) as "PREPARED" | "SUBMITTED";
      persistTerminal(
        `v4_bid_ladder_${input.stage.toLowerCase()}_failed_commit`,
        () =>
          input.repo.transitionChainTransaction({
            chainId: CHAIN_ID,
            journalId: String(failed.journal_id),
            from,
            to: "FAILED",
            receipt,
            confirmationCount: 1,
            actualGasNative: receipt.gasUsed * receipt.effectiveGasPrice,
            failureReason: "TRANSACTION_REVERTED",
          }),
      );
    }
    throw new Error(`${input.stage}_REVERTED`);
  }
  const row = journalRow(input.repo, input.ladderId, input.stage);
  if (row && String(row.status) === "PREPARED")
    persistTerminal(
      `v4_bid_ladder_${input.stage.toLowerCase()}_receipt_submitted_commit`,
      () =>
        input.repo.transitionChainTransaction({
          chainId: CHAIN_ID,
          journalId: id,
          from: "PREPARED",
          to: "SUBMITTED",
        }),
    );
  const latest = journalRow(input.repo, input.ladderId, input.stage);
  if (latest && String(latest.status) === "SUBMITTED")
    persistTerminal(
      `v4_bid_ladder_${input.stage.toLowerCase()}_confirmed_commit`,
      () =>
        input.repo.transitionChainTransaction({
          chainId: CHAIN_ID,
          journalId: id,
          from: "SUBMITTED",
          to: "CONFIRMED",
          receipt,
          confirmationCount: 1,
          actualGasNative: receipt.gasUsed * receipt.effectiveGasPrice,
        }),
    );
  return { hash: result.hash, receipt, recovered: result.recovered, timing };
}

type OpenChainState = {
  pool: V4PoolState;
  balance: bigint;
  erc20Allowance: bigint;
  permit: readonly [bigint, number, number];
  blockNumber: bigint;
  observedAtMs: number;
};
type OpenAttemptPriceMemo = {
  fetch: (target: Address) => Promise<GmgnEntryPriceEvidence>;
  stats: () => { requests: number; sourceFetches: number; cacheHits: number };
};

function openAttemptPriceMemo(input: LadderLiveContext): OpenAttemptPriceMemo {
  const source = input.entryPriceFetch ?? fetchCanonicalGmgnEntryPrice;
  let cached: GmgnEntryPriceEvidence | undefined;
  let requests = 0, sourceFetches = 0, cacheHits = 0;
  const cacheable = (evidence: GmgnEntryPriceEvidence, target: Address, nowMs: number) =>
    typeof evidence?.token === "string" &&
    evidence.token.toLowerCase() === target.toLowerCase() &&
    evidence.source === "gmgn-token-info-price.price" &&
    Number.isSafeInteger(evidence.fetchedAtMs) &&
    Number.isSafeInteger(evidence.freshUntilMs) &&
    evidence.fetchedAtMs <= nowMs &&
    evidence.freshUntilMs > nowMs &&
    evidence.freshUntilMs <= evidence.fetchedAtMs + LP_ENTRY_PRICE_PREVIEW_TTL_MS;
  return {
    fetch: async (target) => {
      requests++;
      const canonicalTarget = getAddress(target), nowMs = Date.now();
      if (cached && cacheable(cached, canonicalTarget, nowMs)) { cacheHits++; return cached; }
      sourceFetches++;
      const evidence = await source(canonicalTarget);
      cached = cacheable(evidence, canonicalTarget, Date.now()) ? evidence : undefined;
      return evidence;
    },
    stats: () => ({ requests, sourceFetches, cacheHits }),
  };
}

async function readOpenChainState(input: LadderLiveContext, state: LadderRows): Promise<OpenChainState> {
  const stageStartedAtMs=Date.now(),timings:Record<string,number>={},measure=async<T>(stage:string,work:()=>Promise<T>)=>{const started=Date.now();try{return await work();}finally{timings[stage]=Date.now()-started;}},
    token = getAddress(String(state.parent.funding_token)),
    blockNumber = await measure("freshBlockMs",()=>input.rpc.withClient((client) => client.getBlockNumber(),{stage:"v4_bid_ladder_preview_block",method:"eth_blockNumber"})),
    observedAtMs = Date.now(),
    [pool, balance, erc20Allowance, permit] = await Promise.all([
      measure("poolStateMs",()=>inspectV4Pool(input.rpc, state.key, blockNumber)),
      measure("balanceMs",()=>input.rpc.withClient((client) =>
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [input.wallet],
          blockNumber,
        }),
      )),
      measure("erc20AllowanceMs",()=>input.rpc.withClient((client) =>
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [input.wallet, V4_ROBINHOOD_DEPLOYMENTS.permit2],
          blockNumber,
        }),
      )),
      measure("permit2AllowanceMs",()=>permit2Allowance(
        input.rpc,
        input.wallet,
        token,
        V4_ROBINHOOD_DEPLOYMENTS.positionManager,
        blockNumber,
      )),
    ]);
  if (pool.status === "unavailable") throw new Error(pool.reason);
  try{input.telemetry?.("v4_bid_ladder_preview_stage",{ladderId:input.ladderId,stage:"PINNED_CHAIN_STATE",startedAtMs:stageStartedAtMs,endedAtMs:Date.now(),elapsedMs:Date.now()-stageStartedAtMs,dbWaitMs:0,rpcWaitMs:Date.now()-stageStartedAtMs,provider:"robinhood-rpc",queueWaitMs:0,cache:"MISS",outcome:"COMPLETE",blockNumber:blockNumber.toString(),...timings});}catch{}
  return { pool: pool.value, balance, erc20Allowance, permit, blockNumber, observedAtMs };
}

async function materializeOpenState(
  input: LadderLiveContext,
  state: LadderRows,
  chain: OpenChainState,
  options: {
    requirePrice: boolean;
    priceMemo?: OpenAttemptPriceMemo;
    requireReadyAllowances?: boolean;
  },
) {
  const blockers: string[] = [], pool = chain.pool;
  if (
    String(state.parent.status) !== "PLANNED" ||
    !["DRY_RUN", "LIVE"].includes(String(state.parent.execution_mode))
  )
    blockers.push("V4_BID_LADDER_OPEN_STATE_INVALID");
  if (input.rpc.config.chainId !== CHAIN_ID)
    blockers.push("V4_BID_LADDER_WRONG_CHAIN");
  if (!pool.initialized || pool.liquidity <= 0n)
    blockers.push("V4_BID_LADDER_POOL_UNINITIALIZED");
  blockers.push(...v4ExecutionBlockers(pool));
  const fundingIndex = Number(state.parent.funding_index) as 0 | 1,
    targetIndex = Number(state.parent.target_index) as 0 | 1;
  for (const leg of state.legs) {
    const amounts = amountsForLiquidity(
        pool.sqrtPriceX96,
        Number(leg.tick_lower),
        Number(leg.tick_upper),
        BigInt(String(leg.planned_liquidity_raw)),
      ),
      funding = fundingIndex === 0 ? amounts.token0 : amounts.token1,
      target = targetIndex === 0 ? amounts.token0 : amounts.token1;
    if (target !== 0n || funding <= 0n)
      blockers.push(`V4_BID_LADDER_LEG_NOT_FUNDING_ONLY:${leg.leg_index}`);
  }
  const total = state.legs.reduce(
    (sum, leg) => sum + BigInt(String(leg.funding_amount_raw)),
    0n,
  );
  if (total !== BigInt(String(state.parent.total_funding_amount_raw)))
    blockers.push("V4_BID_LADDER_CAPITAL_CHANGED");
  if (chain.balance < total)
    blockers.push("V4_BID_LADDER_FUNDING_BALANCE_INSUFFICIENT");
  const now = BigInt(Math.floor(Date.now() / 1000)),
    approval = {
      aggregateRequired: total,
      erc20Required: chain.erc20Allowance < total,
      permit2Required: chain.permit[0] < total || BigInt(chain.permit[1]) <= now,
    };
  if (options.requireReadyAllowances) {
    if (approval.erc20Required)
      blockers.push("V4_BID_LADDER_ERC20_ALLOWANCE_INSUFFICIENT");
    if (approval.permit2Required)
      blockers.push("V4_BID_LADDER_PERMIT2_ALLOWANCE_INSUFFICIENT");
  }
  const usd = positionUsd(state.parent, input.repo, input.fundingUsd);
  if (
    !Number.isFinite(usd) ||
    usd > input.runtime.maxPositionUsd ||
    usd > input.runtime.maxApprovalUsd
  )
    blockers.push("V4_BID_LADDER_POSITION_OR_APPROVAL_CAP_EXCEEDED");
  if (
    !input.runtime.executionEnabled ||
    input.runtime.dryRun ||
    input.runtime.emergencyPause ||
    !input.runtime.signerConfigured ||
    !input.runtime.allowlisted
  )
    blockers.push("V4_BID_LADDER_RUNTIME_BLOCKED");
  if (pendingOther(input.repo, input.ladderId, input.wallet))
    blockers.push("V4_BID_LADDER_UNRESOLVED_TRANSACTION");
  const maxIds = new Set(
    state.legs.map((leg) => String(leg.open_batch_id ?? "")).filter(Boolean),
  );
  if (maxIds.size > 1) blockers.push("V4_BID_LADDER_OPEN_BATCH_AMBIGUOUS");
  const d0 =
      fundingIndex === 0
        ? tokenDecimals(input.repo, String(state.parent.funding_token))
        : tokenDecimals(input.repo, String(state.parent.target_token)),
    d1 =
      fundingIndex === 1
        ? tokenDecimals(input.repo, String(state.parent.funding_token))
        : tokenDecimals(input.repo, String(state.parent.target_token)),
    poolPrice = orientPoolPriceFundingPerTarget({
      priceToken1PerToken0: priceFromSqrtX96(pool.sqrtPriceX96, d0, d1),
      token0: state.key.currency0,
      token1: state.key.currency1,
      target: String(state.parent.target_token),
      funding: String(state.parent.funding_token),
    });
  const fundingToken: BidLadderToken = {
      address: getAddress(String(state.parent.funding_token)),
      symbol: tokenSymbol(input.repo, String(state.parent.funding_token), "FUNDING"),
      decimals: tokenDecimals(input.repo, String(state.parent.funding_token)),
    },
    targetToken: BidLadderToken = {
      address: getAddress(String(state.parent.target_token)),
      symbol: tokenSymbol(input.repo, String(state.parent.target_token), "TOKEN"),
      decimals: tokenDecimals(input.repo, String(state.parent.target_token)),
    },
    plan = mintPlan(state, input.wallet, BigInt(Math.floor(Date.now() / 1000) + 600));
  const materializationStartedAtMs=Date.now(),timings:Record<string,number>={},measure=async<T>(stage:string,work:()=>Promise<T>)=>{const started=Date.now();try{return await work();}finally{timings[stage]=Date.now()-started;}},
    [priceGuard, estimatedGas, observedGasPrice] = await Promise.all([
    options.requirePrice
      ? measure("gmgnMs",()=>freshLpEntryPriceGuard({
          target: getAddress(String(state.parent.target_token)),
          poolPriceFundingPerTarget: poolPrice,
          fundingUsd: input.fundingUsd,
          fetch: options.priceMemo?.fetch ?? input.entryPriceFetch,
        }))
      : Promise.resolve(undefined),
    measure("estimateGasMs",()=>input.rpc.withClient((client) =>
      client.estimateGas({
        account: input.wallet,
        to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
        data: plan.calldata,
        value: 0n,
      }),
      {stage:"v4_bid_ladder_preview_gas",method:"eth_estimateGas"}),
    ).catch(() => null),
    measure("gasPriceMs",()=>input.rpc.withClient(client=>client.getGasPrice(),{stage:"v4_bid_ladder_preview_gas_price",method:"eth_gasPrice"})).catch(()=>null),
  ]);
  if (priceGuard?.status === "BLOCK")
    blockers.push(priceGuard.blocker ?? "V4_BID_LADDER_PRICE_BLOCKED");
  if (
    estimatedGas === null &&
    (options.requireReadyAllowances ||
      (!approval.erc20Required && !approval.permit2Required))
  )
    blockers.push("V4_BID_LADDER_MINT_ESTIMATE_FAILED");
  const gasProjection=estimatedGas!==null&&observedGasPrice!==null?v4BidLadderGasProjection({estimatedGas,gasPrice:observedGasPrice,nativeUsd:input.nativeUsd,nativeUsdSource:input.nativeUsdSource,capUsd:input.runtime.maxGasUsd}):null;
  if(estimatedGas!==null&&observedGasPrice===null)blockers.push("V4_BID_LADDER_GAS_PRICE_UNAVAILABLE");
  if(gasProjection?.exceedsCap)blockers.push("V4_BID_LADDER_GAS_CAP_EXCEEDED");
  try{input.telemetry?.("v4_bid_ladder_preview_stage",{ladderId:input.ladderId,stage:"PRICE_AND_GAS_MATERIALIZATION",startedAtMs:materializationStartedAtMs,endedAtMs:Date.now(),elapsedMs:Date.now()-materializationStartedAtMs,dbWaitMs:0,rpcWaitMs:Math.max(timings.gmgnMs??0,timings.estimateGasMs??0,timings.gasPriceMs??0),provider:"gmgn+robinhood-rpc",queueWaitMs:0,cache:"FRESH",outcome:blockers.length?"BLOCKED":"READY",...timings,estimatedGas:estimatedGas?.toString()??null,signedGasLimit:gasProjection?.signedGasLimit.toString()??null,gasLimitInflationFactor:gasProjection?.gasLimitInflationFactor??null,gasPriceWei:gasProjection?.gasPrice.toString()??null,nativeUsd:input.nativeUsd,nativeUsdSource:input.nativeUsdSource??"canonical V4 WETH/USDG",estimatedExecutionUsd:gasProjection?.estimatedExecutionUsd??null,maximumProjectedFeeUsd:gasProjection?.maximumProjectedFeeUsd??null,configuredCapUsd:input.runtime.maxGasUsd});}catch{}
  return {
    state,
    pool,
    plan,
    total,
    balance: chain.balance,
    approval,
    positionUsd: usd,
    poolPrice,
    priceGuard,
    marketCapEvidence: input.marketCapEvidence,
    marketCapTokens: { funding: fundingToken, target: targetToken },
    estimatedGas,
    gasProjection,
    transactionCount:
      Number(approval.erc20Required) + Number(approval.permit2Required) + 1,
    evidence: {
      blockNumber: chain.blockNumber,
      observedAtMs: chain.observedAtMs,
      gmgnFetchedAtMs: priceGuard?.evidence?.fetchedAtMs ?? null,
      gmgnFreshUntilMs: priceGuard?.evidence?.freshUntilMs ?? null,
    },
    blockers: [...new Set(blockers)],
  };
}

async function openState(
  input: LadderLiveContext,
  requirePrice = true,
  priceMemo?: OpenAttemptPriceMemo,
) {
  withSqliteTransientRetrySync({
    operation: "v4_bid_ladder_live_expiry",
    run: () =>
      expireAbandonedPlannedV4BidLadders(input.repo, {
        nowMs: (input.nowMs ?? Date.now)(),
      }),
  });
  const state = rows(input.repo, input.ladderId),
    chain = await readOpenChainState(input, state);
  return materializeOpenState(input, state, chain, { requirePrice, priceMemo });
}

export async function previewV4BidLadderLive(input: LadderLiveContext) {
  return openState(input, true);
}

type OpenStateSnapshot = Awaited<ReturnType<typeof openState>>;

async function refreshOpenApprovalDelta(
  input: LadderLiveContext,
  preview: OpenStateSnapshot,
  stage: "OPEN_ERC20_APPROVAL" | "OPEN_PERMIT2_APPROVAL",
  receiptBlock: bigint,
) {
  const current = rows(input.repo, input.ladderId),
    token = getAddress(String(preview.state.parent.funding_token)),
    journal = journalRow(input.repo, input.ladderId, stage),
    identityChanged =
      !sameKey(current.key, preview.state.key) ||
      !same(String(current.parent.funding_token), token) ||
      BigInt(String(current.parent.total_funding_amount_raw)) !== preview.total;
  const reads = stage === "OPEN_ERC20_APPROVAL"
    ? await Promise.all([
        input.rpc.withClient((client) =>
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [input.wallet],
            blockNumber: receiptBlock,
          }),
        ),
        input.rpc.withClient((client) =>
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [input.wallet, V4_ROBINHOOD_DEPLOYMENTS.permit2],
            blockNumber: receiptBlock,
          }),
        ),
        permit2Allowance(
          input.rpc,
          input.wallet,
          token,
          V4_ROBINHOOD_DEPLOYMENTS.positionManager,
          receiptBlock,
        ),
      ] as const)
    : await Promise.all([
        input.rpc.withClient((client) =>
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [input.wallet],
            blockNumber: receiptBlock,
          }),
        ),
        permit2Allowance(
          input.rpc,
          input.wallet,
          token,
          V4_ROBINHOOD_DEPLOYMENTS.positionManager,
          receiptBlock,
        ),
      ] as const),
    balance = reads[0],
    erc20Allowance = stage === "OPEN_ERC20_APPROVAL"
      ? reads[1] as bigint
      : preview.approval.erc20Required ? 0n : preview.total,
    permit = stage === "OPEN_ERC20_APPROVAL"
      ? reads[2] as readonly [bigint, number, number]
      : reads[1] as readonly [bigint, number, number],
    now = BigInt(Math.floor(Date.now() / 1000)),
    approval = {
      aggregateRequired: preview.total,
      erc20Required: erc20Allowance < preview.total,
      permit2Required: permit[0] < preview.total || BigInt(permit[1]) <= now,
    },
    blockers = [
      ...(identityChanged ? ["V4_BID_LADDER_OPEN_IDENTITY_CHANGED"] : []),
      ...(!journal || String(journal.status) !== "CONFIRMED"
        ? [`${stage}_JOURNAL_NOT_CONFIRMED`]
        : []),
      ...(balance < preview.total
        ? ["V4_BID_LADDER_FUNDING_BALANCE_INSUFFICIENT"]
        : []),
      ...(stage === "OPEN_ERC20_APPROVAL" && approval.erc20Required
        ? ["V4_BID_LADDER_ERC20_ALLOWANCE_INSUFFICIENT"]
        : []),
      ...(stage === "OPEN_PERMIT2_APPROVAL" && approval.permit2Required
        ? ["V4_BID_LADDER_PERMIT2_ALLOWANCE_INSUFFICIENT"]
        : []),
    ];
  if (blockers.length)
    throw new Error(`V4_BID_LADDER_OPEN_BLOCKED:${blockers.join(",")}`);
  return {
    ...preview,
    state: current,
    balance,
    approval,
    evidence: {
      ...preview.evidence,
      approvalDeltaStage: stage,
      approvalDeltaBlockNumber: receiptBlock,
      approvalDeltaObservedAtMs: Date.now(),
    },
  };
}

type FinalOpenEconomicState = OpenChainState & {
  transportRpcCount: 2;
  multicallMembers: 5;
};

function requiredFinalOpenRead<T>(
  value: { status: "success" | "failure"; result?: unknown },
  label: string,
) {
  if (value.status !== "success")
    throw new Error(`V4_BID_LADDER_FINAL_${label}_UNAVAILABLE`);
  return value.result as T;
}

/** One pinned-block transport read for exactly the mutable economic evidence
 * needed immediately before OPEN_BATCH. No token metadata, historical state,
 * market-cap materialization, or generic OPEN-state reconstruction occurs. */
async function readFinalOpenEconomicState(
  input: LadderLiveContext,
  state: LadderRows,
): Promise<FinalOpenEconomicState> {
  const token = getAddress(String(state.parent.funding_token)), id = poolId(state.key);
  try {
    return await input.rpc.withClient(async (client) => {
      const blockNumber = await client.getBlockNumber(), results = await client.multicall({
        allowFailure: true,
        blockNumber,
        contracts: [
          { address: V4_ROBINHOOD_DEPLOYMENTS.stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [id] },
          { address: V4_ROBINHOOD_DEPLOYMENTS.stateView, abi: v4StateViewAbi, functionName: "getLiquidity", args: [id] },
          { address: token, abi: erc20Abi, functionName: "balanceOf", args: [input.wallet] },
          { address: token, abi: erc20Abi, functionName: "allowance", args: [input.wallet, V4_ROBINHOOD_DEPLOYMENTS.permit2] },
          { address: V4_ROBINHOOD_DEPLOYMENTS.permit2, abi: permit2Abi, functionName: "allowance", args: [input.wallet, token, V4_ROBINHOOD_DEPLOYMENTS.positionManager] },
        ],
      }), slot = requiredFinalOpenRead<readonly [bigint, number, number, number]>(results[0]!, "SLOT0"),
        liquidity = requiredFinalOpenRead<bigint>(results[1]!, "LIQUIDITY"),
        balance = requiredFinalOpenRead<bigint>(results[2]!, "BALANCE"),
        erc20Allowance = requiredFinalOpenRead<bigint>(results[3]!, "ERC20_ALLOWANCE"),
        permit = requiredFinalOpenRead<readonly [bigint, number, number]>(results[4]!, "PERMIT2_ALLOWANCE"),
        protocolFee = Number(slot[2]), lpFee = Number(slot[3]),
        pool: V4PoolState = {
          id, key: state.key, sqrtPriceX96: slot[0], tick: Number(slot[1]), liquidity,
          initialized: slot[0] !== 0n, blockNumber, protocolFee, lpFee,
          feeSemantics: decodeV4Fee(state.key.fee, lpFee, protocolFee),
          hookSemantics: classifyV4Hooks(state.key.hooks),
        };
      return { pool, balance, erc20Allowance, permit, blockNumber, observedAtMs: Date.now(), transportRpcCount: 2, multicallMembers: 5 };
    }, { workflowId: input.ladderId, stage: "v4_open_final_validation", method: "eth_blockNumber+multicall[5]" });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("V4_BID_LADDER_FINAL_")) throw error;
    throw new Error("V4_BID_LADDER_FINAL_ECONOMIC_STATE_UNAVAILABLE", { cause: error });
  }
}

function sameOpenGeometry(current: LadderRows, initial: LadderRows) {
  if (current.legs.length !== initial.legs.length) return false;
  return current.legs.every((leg, index) => {
    const prior = initial.legs[index]!;
    return Number(leg.leg_index) === Number(prior.leg_index) &&
      Number(leg.tick_lower) === Number(prior.tick_lower) &&
      Number(leg.tick_upper) === Number(prior.tick_upper) &&
      BigInt(String(leg.planned_liquidity_raw)) === BigInt(String(prior.planned_liquidity_raw)) &&
      BigInt(String(leg.funding_amount_raw)) === BigInt(String(prior.funding_amount_raw));
  });
}

async function validateFinalOpenAuthority(
  input: LadderLiveContext,
  initial: OpenStateSnapshot,
  priceMemo: OpenAttemptPriceMemo,
) {
  const startedAtMs = Date.now(), memoBefore = priceMemo.stats(), state = rows(input.repo, input.ladderId),
    identityChanged =
      !sameKey(state.key, initial.state.key) ||
      !same(String(state.parent.funding_token), String(initial.state.parent.funding_token)) ||
      !same(String(state.parent.target_token), String(initial.state.parent.target_token)) ||
      BigInt(String(state.parent.total_funding_amount_raw)) !== initial.total ||
      !sameOpenGeometry(state, initial.state),
    chain = await readFinalOpenEconomicState(input, state), pool = chain.pool,
    blockers: string[] = [...(identityChanged ? ["V4_BID_LADDER_OPEN_IDENTITY_CHANGED"] : [])];
  if (String(state.parent.status) !== "PLANNED" || String(state.parent.execution_mode) !== "LIVE")
    blockers.push("V4_BID_LADDER_OPEN_STATE_INVALID");
  if (input.rpc.config.chainId !== CHAIN_ID) blockers.push("V4_BID_LADDER_WRONG_CHAIN");
  if (!pool.initialized || pool.liquidity <= 0n) blockers.push("V4_BID_LADDER_POOL_UNINITIALIZED");
  blockers.push(...v4ExecutionBlockers(pool));
  const fundingIndex = Number(state.parent.funding_index) as 0 | 1,
    targetIndex = Number(state.parent.target_index) as 0 | 1,
    fundingAddress = getAddress(String(state.parent.funding_token)),
    targetAddress = getAddress(String(state.parent.target_token)),
    orientationValid = fundingIndex !== targetIndex &&
      (fundingIndex === 0
        ? same(state.key.currency0, fundingAddress) && same(state.key.currency1, targetAddress)
        : same(state.key.currency1, fundingAddress) && same(state.key.currency0, targetAddress));
  if (!orientationValid) blockers.push("V4_BID_LADDER_OPEN_TOKEN_ORIENTATION_MISMATCH");
  for (const leg of state.legs) {
    const amounts = amountsForLiquidity(pool.sqrtPriceX96, Number(leg.tick_lower), Number(leg.tick_upper), BigInt(String(leg.planned_liquidity_raw))),
      funding = fundingIndex === 0 ? amounts.token0 : amounts.token1,
      target = targetIndex === 0 ? amounts.token0 : amounts.token1;
    if (target !== 0n || funding <= 0n) blockers.push(`V4_BID_LADDER_LEG_NOT_FUNDING_ONLY:${leg.leg_index}`);
  }
  const total = state.legs.reduce((sum, leg) => sum + BigInt(String(leg.funding_amount_raw)), 0n),
    now = BigInt(Math.floor(Date.now() / 1000)), approval = {
      aggregateRequired: initial.total,
      erc20Required: chain.erc20Allowance < initial.total,
      permit2Required: chain.permit[0] < initial.total || BigInt(chain.permit[1]) <= now,
    };
  if (total !== initial.total) blockers.push("V4_BID_LADDER_CAPITAL_CHANGED");
  if (chain.balance < initial.total) blockers.push("V4_BID_LADDER_FUNDING_BALANCE_INSUFFICIENT");
  if (approval.erc20Required) blockers.push("V4_BID_LADDER_ERC20_ALLOWANCE_INSUFFICIENT");
  if (approval.permit2Required) blockers.push("V4_BID_LADDER_PERMIT2_ALLOWANCE_INSUFFICIENT");
  if (!Number.isFinite(initial.positionUsd) || initial.positionUsd > input.runtime.maxPositionUsd || initial.positionUsd > input.runtime.maxApprovalUsd)
    blockers.push("V4_BID_LADDER_POSITION_OR_APPROVAL_CAP_EXCEEDED");
  if (!input.runtime.executionEnabled || input.runtime.dryRun || input.runtime.emergencyPause || !input.runtime.signerConfigured || !input.runtime.allowlisted)
    blockers.push("V4_BID_LADDER_RUNTIME_BLOCKED");
  if (pendingOther(input.repo, input.ladderId, input.wallet)) blockers.push("V4_BID_LADDER_UNRESOLVED_TRANSACTION");
  const batchIds = new Set(state.legs.map((leg) => String(leg.open_batch_id ?? "")).filter(Boolean));
  if (batchIds.size > 1) blockers.push("V4_BID_LADDER_OPEN_BATCH_AMBIGUOUS");
  const fundingToken = initial.marketCapTokens.funding, targetToken = initial.marketCapTokens.target;
  if (!same(fundingToken.address, fundingAddress) || !same(targetToken.address, targetAddress))
    blockers.push("V4_BID_LADDER_OPEN_TOKEN_IDENTITY_CHANGED");
  let poolPrice = Number.NaN;
  if (orientationValid) {
    const d0 = fundingIndex === 0 ? fundingToken.decimals : targetToken.decimals,
      d1 = fundingIndex === 1 ? fundingToken.decimals : targetToken.decimals;
    try { poolPrice = orientPoolPriceFundingPerTarget({ priceToken1PerToken0: priceFromSqrtX96(pool.sqrtPriceX96, d0, d1), token0: state.key.currency0, token1: state.key.currency1, target: targetAddress, funding: fundingAddress }); }
    catch { blockers.push("V4_BID_LADDER_OPEN_TOKEN_ORIENTATION_MISMATCH"); }
  }
  const plan = mintPlan(state, input.wallet, BigInt(Math.floor(Date.now() / 1000) + 600)),
    [priceGuard, estimatedGas] = await Promise.all([
      Number.isFinite(poolPrice) && poolPrice > 0
        ? freshLpEntryPriceGuard({ target: targetAddress, poolPriceFundingPerTarget: poolPrice, fundingUsd: input.fundingUsd, fetch: priceMemo.fetch })
        : Promise.resolve({ status: "BLOCK" as const, poolPriceFundingPerTarget: String(poolPrice), tokenPriceFundingPerTarget: null, deviationBps: null, blocker: "POOL_PRICE_INVALID", evidence: undefined }),
      input.rpc.withClient((client) => client.estimateGas({ account: input.wallet, to: V4_ROBINHOOD_DEPLOYMENTS.positionManager, data: plan.calldata, value: 0n })).catch(error => {
        try { input.telemetry?.("v4_bid_ladder_estimate_gas_failure", {
          ladderId: input.ladderId,
          stage: "FINAL_OPEN_AUTHORITY",
          errorClass: error instanceof Error ? error.name : "NonError",
          errorCode: typeof (error as { code?:unknown })?.code === "string" ? String((error as { code:string }).code) : null,
          message: error instanceof Error ? error.message : String(error),
          outcome: "BLOCKED",
          signingUsed: false,
          broadcastUsed: false,
        }); } catch {}
        return null;
      }),
    ]), memoAfter = priceMemo.stats();
  if (priceGuard.status === "BLOCK") blockers.push(priceGuard.blocker ?? "V4_BID_LADDER_PRICE_BLOCKED");
  if (estimatedGas === null) blockers.push("V4_BID_LADDER_MINT_ESTIMATE_FAILED");
  try { input.telemetry?.("v4_bid_ladder_open_final_validation", {
    ladderId: input.ladderId, outcome: blockers.length ? "BLOCKED" : "READY", durationMs: Date.now() - startedAtMs,
    blockNumber: chain.blockNumber.toString(), observedAtMs: chain.observedAtMs, transportRpcCount: chain.transportRpcCount + 1,
    multicallMembers: chain.multicallMembers, estimateGasRpcCount: 1, gmgnSourceFetches: memoAfter.sourceFetches - memoBefore.sourceFetches,
    gmgnCacheHits: memoAfter.cacheHits - memoBefore.cacheHits, genericMaterialization: false,
  }); } catch {}
  return {
    state, pool, plan, total: initial.total, balance: chain.balance, approval, poolPrice, priceGuard, estimatedGas,
    evidence: { ...initial.evidence, finalBlockNumber: chain.blockNumber, finalObservedAtMs: chain.observedAtMs,
      gmgnFetchedAtMs: priceGuard.evidence?.fetchedAtMs ?? null, gmgnFreshUntilMs: priceGuard.evidence?.freshUntilMs ?? null },
    blockers: [...new Set(blockers)],
  };
}

export async function v4BidLadderFundingAllowanceReadiness(input:LadderLiveContext&{fundingAmount:bigint}){
  const state=rows(input.repo,input.ladderId),token=getAddress(String(state.parent.funding_token)),amount=input.fundingAmount;
  if(amount<=0n)throw new Error('REPOSITION_ALLOWANCE_AMOUNT_INVALID');
  const approvalUsd=Number(amount)/10**tokenDecimals(input.repo,token)*input.fundingUsd;
  if(!Number.isFinite(approvalUsd)||approvalUsd<=0||approvalUsd>input.runtime.maxApprovalUsd)return {ready:false,erc20Ready:false,permit2Ready:false,amount,approvalUsd,blockers:['V4_BID_LADDER_POSITION_OR_APPROVAL_CAP_EXCEEDED']};
  const [erc20Allowance,permit]=await Promise.all([input.rpc.withClient(client=>client.readContract({address:token,abi:erc20Abi,functionName:'allowance',args:[input.wallet,V4_ROBINHOOD_DEPLOYMENTS.permit2]})),permit2Allowance(input.rpc,input.wallet,token,V4_ROBINHOOD_DEPLOYMENTS.positionManager)]),now=BigInt(Math.floor(Date.now()/1000)),erc20Ready=erc20Allowance===amount,permit2Ready=permit[0]===amount&&BigInt(permit[1])>now+600n;
  return {ready:erc20Ready&&permit2Ready,erc20Ready,permit2Ready,erc20Allowance,permit2Amount:permit[0],permit2Expiration:BigInt(permit[1]),amount,approvalUsd,blockers:[...(erc20Ready?[]:['REPOSITION_ERC20_EXACT_ALLOWANCE_REQUIRED']),...(permit2Ready?[]:['REPOSITION_PERMIT2_EXACT_ALLOWANCE_REQUIRED'])]};
}

export async function prepareV4BidLadderFundingAllowance(input:LadderLiveContext&{walletClient:WalletClient;fundingAmount:bigint;approvalIdentity?:string}){
  if(!input.runtime.executionEnabled||input.runtime.dryRun||input.runtime.emergencyPause||!input.runtime.signerConfigured||!input.runtime.allowlisted)throw new Error('V4_BID_LADDER_RUNTIME_BLOCKED');
  let readiness=await v4BidLadderFundingAllowanceReadiness(input),sent=0;
  if(readiness.blockers.includes('V4_BID_LADDER_POSITION_OR_APPROVAL_CAP_EXCEEDED'))throw new Error(readiness.blockers[0]);
  const state=rows(input.repo,input.ladderId),token=getAddress(String(state.parent.funding_token)),approvalIdentity=input.approvalIdentity;
  if(approvalIdentity&&!/^[A-Za-z0-9_-]{1,80}$/.test(approvalIdentity))throw new Error('REPOSITION_APPROVAL_IDENTITY_INVALID');
  const stageSuffix=approvalIdentity?`${approvalIdentity}:${input.fundingAmount}`:input.fundingAmount.toString();
  if(!readiness.erc20Ready){const data=encodeFunctionData({abi:erc20ApprovalAbi,functionName:'approve',args:[V4_ROBINHOOD_DEPLOYMENTS.permit2,input.fundingAmount]}),gas=await input.rpc.withClient(client=>client.estimateGas({account:input.wallet,to:token,data})),result=await submit({...input,stage:`REPOSITION_PREPARE_ERC20_APPROVAL:${stageSuffix}`,to:token,data,estimatedGas:gas});if(!result.recovered)sent++;readiness=await v4BidLadderFundingAllowanceReadiness(input);}
  if(!readiness.permit2Ready){const approval=buildPermit2Approval(token,input.fundingAmount,BigInt(Math.floor(Date.now()/1000)+3600)),gas=await input.rpc.withClient(client=>client.estimateGas({account:input.wallet,to:approval.to,data:approval.data})),result=await submit({...input,stage:`REPOSITION_PREPARE_PERMIT2_APPROVAL:${stageSuffix}`,to:approval.to,data:approval.data,estimatedGas:gas});if(!result.recovered)sent++;readiness=await v4BidLadderFundingAllowanceReadiness(input);}
  if(!readiness.ready)throw new Error(`REPOSITION_ALLOWANCE_PREPARATION_INCOMPLETE:${readiness.blockers.join(',')}`);
  return {status:'READY' as const,readiness,mainnetTransactionsSent:sent};
}

export async function reconcileV4BidLadderOpenReceipt(
  input: LadderLiveContext,
  receipt: TransactionReceipt,
) {
  const state = rows(input.repo, input.ladderId),
    journal = journalRow(input.repo, input.ladderId, "OPEN_BATCH");
  if (
    !journal ||
    String(journal.status) !== "CONFIRMED" ||
    !same(String(journal.expected_hash), receipt.transactionHash)
  )
    throw new Error("V4_BID_LADDER_OPEN_JOURNAL_NOT_CONFIRMED");
  const expected = state.legs.map((leg) => ({
      key: state.key,
      tickLower: Number(leg.tick_lower),
      tickUpper: Number(leg.tick_upper),
      liquidity: BigInt(String(leg.planned_liquidity_raw)),
      owner: input.wallet,
    })),
    result = await reconcileV4BatchMintReceipt({
      receipt: receiptShape(receipt),
      expectedLegs: expected,
      inspectPosition: (id) => inspectV4Position(input.rpc, id),
    }),
    decoded = decodeV4BatchMint(openPreparedCalldata(journal));
  const fundingIndex = Number(state.parent.funding_index) as 0 | 1,
    targetIndex = Number(state.parent.target_index) as 0 | 1,
    total = BigInt(String(state.parent.total_funding_amount_raw)),
    legTotal = state.legs.reduce(
      (sum, leg) => sum + BigInt(String(leg.funding_amount_raw)),
      0n,
    );
  if (
    decoded.legs.length !== state.legs.length ||
    legTotal !== total ||
    receiptFundingSpent(
      receipt,
      input.wallet,
      getAddress(String(state.parent.funding_token)),
    ) !== total
  )
    throw new Error("V4_BID_LADDER_OPEN_FUNDING_EVIDENCE_MISMATCH");
  for (const [index, leg] of decoded.legs.entries()) {
    const persisted = state.legs[index]!,
      fundingAmount = BigInt(String(persisted.funding_amount_raw)),
      fundingMax = fundingIndex === 0 ? leg.amount0Max : leg.amount1Max,
      targetMax = targetIndex === 0 ? leg.amount0Max : leg.amount1Max;
    if (
      !sameKey(leg.key, state.key) ||
      leg.tickLower !== Number(persisted.tick_lower) ||
      leg.tickUpper !== Number(persisted.tick_upper) ||
      leg.liquidity !== BigInt(String(persisted.planned_liquidity_raw)) ||
      !same(leg.owner, input.wallet) ||
      leg.fundingIndex !== fundingIndex ||
      fundingMax !== fundingAmount ||
      targetMax !== 0n ||
      Number(persisted.funding_index) !== fundingIndex ||
      Number(persisted.target_index) !== targetIndex
    )
      throw new Error("V4_BID_LADDER_OPEN_FUNDING_ONLY_PROOF_FAILED");
  }
  const [target, funding, block] = await Promise.all([
    inspectErc20(input.rpc, getAddress(String(state.parent.target_token))),
    inspectErc20(input.rpc, getAddress(String(state.parent.funding_token))),
    input.rpc.withClient((client) =>
      client.getBlock({ blockNumber: receipt.blockNumber }),
    ),
  ]);
  if (target.status === "unavailable" || funding.status === "unavailable")
    throw new Error("V4_BID_LADDER_TOKEN_METADATA_UNAVAILABLE");
  const id = batchId(input.ladderId, "OPEN_BATCH");
  let writes = {
    positions: 0,
    v4Positions: 0,
    deposits: 0,
    reconciliationMarkers: 0,
    legs: 0,
    parent: 0,
  };
  const apply = () => {
    writes = {
      positions: 0,
      v4Positions: 0,
      deposits: 0,
      reconciliationMarkers: 0,
      legs: 0,
      parent: 0,
    };
    input.repo.db.transaction(() => {
      const live = rows(input.repo, input.ladderId);
      if (
        String(live.parent.execution_mode) !== "LIVE" ||
        !["PLANNED", "OPEN"].includes(String(live.parent.status))
      )
        throw new Error("V4_BID_LADDER_OPEN_PARENT_CONFLICT");
      for (const binding of result.bindings) {
        const leg = live.legs[binding.legIndex]!;
        if (
          !["PLANNED", "OPEN"].includes(String(leg.status)) ||
          (leg.token_id &&
            String(leg.token_id) !== binding.tokenId.toString()) ||
          (leg.open_batch_id && String(leg.open_batch_id) !== id)
        )
          throw new Error("V4_BID_LADDER_OPEN_BINDING_CONFLICT");
        const positionId = `v4:${binding.tokenId}`,
          depositId = `v4-bid-ladder-open:${input.ladderId}:${binding.legIndex}`,
          fundingAmount = BigInt(String(leg.funding_amount_raw)),
          mirror = {
            positionId,
            tokenId: binding.tokenId,
            owner: input.wallet,
            poolId: String(live.parent.pool_id),
            key: live.key,
            tickLower: binding.tickLower,
            tickUpper: binding.tickUpper,
            liquidity: binding.liquidity,
            mintHash: receipt.transactionHash,
            ladderId: input.ladderId,
            target: getAddress(String(live.parent.target_token)),
            funding: getAddress(String(live.parent.funding_token)),
            targetIndex,
            fundingIndex,
            targetDecimals: target.value.decimals,
            fundingDecimals: funding.value.decimals,
            depositId,
            depositLogIndex: binding.logIndex,
            fundingAmount,
            blockNumber: receipt.blockNumber,
          },
          prior = assertMirrorIdentity(input.repo, mirror),
          amounts = {
            token0: fundingIndex === 0 ? fundingAmount : 0n,
            token1: fundingIndex === 1 ? fundingAmount : 0n,
          };
        if (!prior.generic) {
          input.repo.ensurePosition(
            positionId,
            binding.tokenId.toString(),
            String(live.parent.pool_id),
          );
          input.repo.db
            .prepare(
              "UPDATE positions SET chain_id=4663,protocol='uniswap_v4' WHERE id=?",
            )
            .run(positionId);
          writes.positions++;
        }
        if (!prior.row) {
          input.repo.upsertV4Position({
            tokenId: binding.tokenId,
            owner: input.wallet,
            poolId: String(live.parent.pool_id),
            poolKey: live.key,
            currency0: live.key.currency0,
            currency1: live.key.currency1,
            fee: live.key.fee,
            tickSpacing: live.key.tickSpacing,
            hooks: live.key.hooks,
            tickLower: binding.tickLower,
            tickUpper: binding.tickUpper,
            liquidity: binding.liquidity,
            initialAmount0: amounts.token0,
            initialAmount1: amounts.token1,
            mintHash: receipt.transactionHash,
            targetToken: getAddress(String(live.parent.target_token)),
            fundingToken: getAddress(String(live.parent.funding_token)),
            targetSymbol: target.value.symbol,
            fundingSymbol: funding.value.symbol,
            targetDecimals: target.value.decimals,
            fundingDecimals: funding.value.decimals,
            targetIndex,
            fundingIndex,
            feeSemantics: decodeV4Fee(live.key.fee),
            hookStatus: classifyV4Hooks(live.key.hooks),
            valuationProvenance: {
              source: "V4_BID_LADDER_CONFIRMED_BATCH_MINT",
              blockNumber: receipt.blockNumber,
              transactionHash: receipt.transactionHash,
            },
            openIntentId: input.ladderId,
            openEvidence: {
              lane: "v4_bid_ladder",
              ladderId: input.ladderId,
              legIndex: binding.legIndex,
              mintHash: receipt.transactionHash,
              blockNumber: receipt.blockNumber,
              receiptConfirmed: true,
              fundingAttribution:
                "PERSISTED_LEG_AMOUNTS_WITH_AGGREGATE_TRANSFER_PROOF",
            },
          });
          writes.v4Positions++;
        }
        if (!prior.deposit) {
          if (
            !input.repo.ingestDeposit({
              id: depositId,
              positionId,
              txHash: receipt.transactionHash,
              logIndex: binding.logIndex,
              amounts,
              blockNumber: receipt.blockNumber,
              blockTimestamp: new Date(
                Number(block.timestamp) * 1000,
              ).toISOString(),
            })
          )
            throw new Error("V4_BID_LADDER_CANONICAL_DEPOSIT_CONFLICT");
          writes.deposits++;
        }
        const reconciliation = input.repo.db
          .prepare(
            "SELECT 1 FROM active_position_reconciliations WHERE position_id=?",
          )
          .get(positionId);
        if (!reconciliation) {
          markOperationalPositionOpenConfirming(input.repo, {
            positionId,
            tokenId: binding.tokenId.toString(),
            intentId: input.ladderId,
            mintHash: receipt.transactionHash,
            blockNumber: receipt.blockNumber,
          });
          writes.reconciliationMarkers++;
        }
        if (String(leg.status) === "PLANNED") {
          const changed = input.repo.db
            .prepare(
              "UPDATE v4_bid_ladder_legs SET token_id=?,open_batch_id=?,status='OPEN',updated_at_ms=? WHERE ladder_id=? AND leg_index=? AND status='PLANNED'",
            )
            .run(
              binding.tokenId.toString(),
              id,
              Date.now(),
              input.ladderId,
              binding.legIndex,
            ).changes;
          if (changed !== 1)
            throw new Error("V4_BID_LADDER_OPEN_BINDING_CONFLICT");
          writes.legs++;
        }
      }
      if (String(live.parent.status) === "PLANNED") {
        const changed = input.repo.db
          .prepare(
            "UPDATE v4_bid_ladders SET status='OPEN',entry_usd_snapshot=COALESCE(entry_usd_snapshot,?),updated_at_ms=?,revision=revision+1 WHERE ladder_id=? AND execution_mode='LIVE' AND status='PLANNED' AND revision=?",
          )
          .run(
            positionUsd(live.parent, input.repo, input.fundingUsd),
            Date.now(),
            input.ladderId,
            Number(state.parent.revision),
          ).changes;
        if (changed !== 1)
          throw new Error("V4_BID_LADDER_OPEN_PARENT_CONFLICT");
        writes.parent++;
      }
    })();
  };
  withSqliteTransientRetrySync({
    operation: "v4_bid_ladder_open_reconciliation",
    run: () => {
      apply();
      return true;
    },
  });
  enqueueV4BidLadderOpenFreshness(input,rows(input.repo,input.ladderId),receipt);
  // The ladder becomes one presentable managed position only after its parent
  // and every leg have committed OPEN. Rebuild locally; this performs no RPC.
  postReceiptOpenSqliteWrite(input,"v4_bid_ladder_open_portfolio_snapshot",{priorReceiptReuse:false},()=>persistPortfolioSnapshot(input.repo));
  return {
    ...result,
    canonicalMirror: {
      writes,
      positionIds: result.bindings.map((binding) => `v4:${binding.tokenId}`),
      fundingTotal: total,
    },
  };
}

function bidLadderWorkKind(stage:string):EconomicWorkflowKind{return isDurableV4ApprovalStage(stage)||stage==='OPEN_BATCH'?'V4_BID_LADDER_OPEN':stage==='CLOSE_BATCH'?'V4_BID_LADDER_CLOSE':'V4_BID_LADDER_CLAIM';}
function handoffBidLadderReceipt(input:LadderLiveContext,stage:'OPEN_BATCH'|'CLOSE_BATCH'|`COLLECT_BATCH:${string}`,receipt:TransactionReceipt,openContext:OpenPostReceiptContext={priorReceiptReuse:false}){
 const journal=journalRow(input.repo,input.ladderId,stage);if(!journal||String(journal.status)!=='CONFIRMED'||!same(String(journal.expected_hash),receipt.transactionHash))throw new Error('V4_BID_LADDER_HANDOFF_RECEIPT_NOT_AUTHORITATIVE');
 if(stage==='OPEN_BATCH'){const existing=input.repo.db.prepare("SELECT * FROM economic_reconciliation_work WHERE chain_id=? AND workflow_kind='V4_BID_LADDER_OPEN' AND workflow_identity=? AND semantic_stage='OPEN_BATCH' AND lower(transaction_hash)=lower(?)").get(CHAIN_ID,input.ladderId,receipt.transactionHash) as Record<string,unknown>|undefined;if(existing)return {durable:true as const,work:existing};}
 try{return {durable:true as const,work:(stage==='OPEN_BATCH'?postReceiptOpenSqliteWrite(input,'v4_bid_ladder_open_economic_handoff',openContext,()=>ensureEconomicReconciliationWork(input.repo,{chainId:CHAIN_ID,workflowKind:bidLadderWorkKind(stage),workflowIdentity:input.ladderId,semanticStage:stage,transactionHash:receipt.transactionHash,sourceTable:'chain_transaction_journal',sourceIdentity:String(journal.journal_id),priority:1_000})):ensureEconomicReconciliationWork(input.repo,{chainId:CHAIN_ID,workflowKind:bidLadderWorkKind(stage),workflowIdentity:input.ladderId,semanticStage:stage,transactionHash:receipt.transactionHash,sourceTable:'chain_transaction_journal',sourceIdentity:String(journal.journal_id),priority:500}))};}
 catch(error){if(sqliteTransientCode(error))return {durable:false as const,work:null};throw error;}
}

/** Receipt-only OPEN projection. It performs no provider read: prepared calldata,
 * exact receipt transfers, persisted token metadata, and mint Transfer order are
 * sufficient to expose one OPEN/refreshing ladder while the worker verifies it. */
function enqueueV4BidLadderOpenFreshness(input:LadderLiveContext,state:LadderRows,receipt:TransactionReceipt,now=Date.now(),openContext:OpenPostReceiptContext={priorReceiptReuse:false}){
 const coverage=(live:LadderRows)=>{const poolIdText=String(live.parent.pool_id),handoff=Boolean(input.repo.db.prepare("SELECT 1 FROM v4_bid_ladder_open_freshness_handoffs WHERE ladder_id=? AND lower(transaction_hash)=lower(?)").get(input.ladderId,receipt.transactionHash)),registry=input.repo.v4RegistryPool(poolIdText),poolPending=Boolean(input.repo.db.prepare("SELECT 1 FROM v4_state_refresh_queue WHERE lower(pool_id)=lower(?) AND lane='urgent'").get(poolIdText)),poolFresh=Boolean(registry?.refresh_block&&BigInt(String(registry.refresh_block))>=receipt.blockNumber),nfts=live.legs.map(leg=>{if(String(leg.status)!=='OPEN'||!leg.token_id)throw new Error('V4_BID_LADDER_OPEN_URGENT_HANDOFF_IDENTITY_INCOMPLETE');const positionId=`v4:${String(leg.token_id)}`,reconciliation=input.repo.db.prepare('SELECT owner_status,confirmed_active,fresh_until_ms FROM active_position_reconciliations WHERE position_id=?').get(positionId) as {owner_status:string;confirmed_active:number;fresh_until_ms:number}|undefined,pending=Boolean(input.repo.db.prepare("SELECT 1 FROM targeted_position_reconciliation_requests WHERE position_id=? AND lane='urgent'").get(positionId)),freshOwned=Boolean(reconciliation?.owner_status==='VERIFIED_OWNED'&&reconciliation.confirmed_active&&Number(reconciliation.fresh_until_ms)>now);return {leg,positionId,pending,freshOwned};});return {poolIdText,handoff,registry,poolPending,poolFresh,nfts,complete:handoff&&(poolPending||poolFresh)&&nfts.every(nft=>nft.pending||nft.freshOwned)};};
 const initial=coverage(state);if(initial.complete)return {poolEnqueued:initial.poolPending,nftEnqueued:0,poolEnqueueAtMs:null,nftEnqueueAtMs:null,alreadyConverged:true as const};
 const outcome=postReceiptOpenSqliteWrite(input,'v4_bid_ladder_open_freshness_handoff',openContext,()=>input.repo.db.transaction(()=>{const live=rows(input.repo,input.ladderId),current=coverage(live);if(current.complete)return {poolEnqueued:current.poolPending,nftEnqueued:0,poolEnqueueAtMs:null,nftEnqueueAtMs:null,alreadyConverged:true as const};if(!current.registry){const fee=decodeV4Fee(live.key.fee),hooks=classifyV4Hooks(live.key.hooks);input.repo.upsertV4RegistryPool({poolId:current.poolIdText,currency0:live.key.currency0,currency1:live.key.currency1,initializeFeeRaw:live.key.fee,tickSpacing:live.key.tickSpacing,hooks:live.key.hooks,initializationBlock:BigInt(String(live.parent.reference_block)),dynamicFee:fee.dynamicFee,staticFeePips:fee.staticFeePips,hookClassification:hooks.classification});}
  if(!current.poolPending&&(!current.handoff||!current.poolFresh))input.repo.enqueueV4StateRefresh(current.poolIdText,900,'OPERATIONAL_OPEN_POOL_FRESHNESS',now);
  let nftEnqueued=0;for(const nft of current.nfts)if(!nft.pending&&(!current.handoff||!nft.freshOwned)){enqueueTargetedPositionReconciliation(input.repo,{positionId:nft.positionId,tokenId:String(nft.leg.token_id),protocol:'v4',reason:'OPERATIONAL_MINT_CONFIRMED',priority:1_000,nowMs:now});nftEnqueued++;}
  input.repo.db.prepare("INSERT OR IGNORE INTO v4_bid_ladder_open_freshness_handoffs(ladder_id,transaction_hash,enqueued_at_ms) VALUES(?,?,?)").run(input.ladderId,receipt.transactionHash,now);
  const poolRow=input.repo.db.prepare("SELECT requested_at_ms FROM v4_state_refresh_queue WHERE lower(pool_id)=lower(?) AND lane='urgent'").get(current.poolIdText) as {requested_at_ms:number}|undefined,nftRow=input.repo.db.prepare("SELECT MIN(requested_at_ms) requested_at_ms FROM targeted_position_reconciliation_requests WHERE lane='urgent' AND position_id IN (SELECT 'v4:'||token_id FROM v4_bid_ladder_legs WHERE ladder_id=?)").get(input.ladderId) as {requested_at_ms:number|null};return {poolEnqueued:Boolean(poolRow),nftEnqueued,poolEnqueueAtMs:poolRow?.requested_at_ms??null,nftEnqueueAtMs:nftRow.requested_at_ms??null,alreadyConverged:false as const};})());
 const poolIdText=String(state.parent.pool_id);
 try{input.repo.recordLatency('v4_bid_ladder_open_freshness_handoff',0,{context:{ladderId:input.ladderId,poolId:poolIdText,openReceiptTimestampMs:now,exactPoolRefreshEnqueuedAtMs:outcome.poolEnqueueAtMs,nftTargetedEnqueuedAtMs:outcome.nftEnqueueAtMs,transactionHash:receipt.transactionHash,generation:Number(input.repo.loadBidLadderUsdReset(input.ladderId)?.generation??0)}});}catch{}
 return outcome;
}
export function persistV4BidLadderOpenReceiptProjection(input:LadderLiveContext,receipt:TransactionReceipt,openContext:OpenPostReceiptContext={priorReceiptReuse:false}){
 const state=rows(input.repo,input.ladderId),journal=journalRow(input.repo,input.ladderId,'OPEN_BATCH');
 if(!journal||String(journal.status)!=='CONFIRMED'||!same(String(journal.expected_hash),receipt.transactionHash))throw new Error('V4_BID_LADDER_OPEN_JOURNAL_NOT_CONFIRMED');
 const completeProjection=state.legs.length===5&&state.legs.every(leg=>String(leg.status)==='OPEN'&&leg.token_id&&input.repo.v4Position(String(leg.token_id))&&input.repo.db.prepare('SELECT 1 FROM active_position_reconciliations WHERE position_id=?').get(`v4:${String(leg.token_id)}`));if(String(state.parent.status)==='OPEN'&&completeProjection){enqueueV4BidLadderOpenFreshness(input,state,receipt,Date.now(),openContext);const bindings=state.legs.map((leg,index)=>({legIndex:index,tokenId:BigInt(String(leg.token_id)),logIndex:index,tickLower:Number(leg.tick_lower),tickUpper:Number(leg.tick_upper),liquidity:BigInt(String(leg.planned_liquidity_raw))}));return {bindings,canonicalMirror:{writes:{positions:0,v4Positions:0,deposits:0,reconciliationMarkers:0,legs:0,parent:0},positionIds:bindings.map(binding=>`v4:${binding.tokenId}`),fundingTotal:BigInt(String(state.parent.total_funding_amount_raw))}};}
 const decoded=decodeV4BatchMint(openPreparedCalldata(journal)),fundingIndex=Number(state.parent.funding_index) as 0|1,targetIndex=Number(state.parent.target_index) as 0|1,total=BigInt(String(state.parent.total_funding_amount_raw));
 if(decoded.legs.length!==state.legs.length||receiptFundingSpent(receipt,input.wallet,getAddress(String(state.parent.funding_token)))!==total)throw new Error('V4_BID_LADDER_OPEN_FUNDING_EVIDENCE_MISMATCH');
 const mints=receipt.logs.flatMap(log=>{if(!same(log.address,V4_ROBINHOOD_DEPLOYMENTS.positionManager))return [];try{const event=decodeEventLog({abi:[nftTransferEvent],data:log.data,topics:log.topics});return event.eventName==='Transfer'&&same(event.args.from,zeroAddress)&&same(event.args.to,input.wallet)?[{tokenId:event.args.id,logIndex:Number(log.logIndex)}]:[];}catch{return [];}});
 if(mints.length!==state.legs.length)throw new Error('V4_BATCH_MINT_TRANSFER_COUNT_AMBIGUOUS');
 const targetDecimals=tokenDecimals(input.repo,String(state.parent.target_token)),fundingDecimals=tokenDecimals(input.repo,String(state.parent.funding_token)),targetSymbol=String(state.parent.target_symbol??'').trim()||tokenSymbol(input.repo,String(state.parent.target_token),'TOKEN'),fundingSymbol=String(state.parent.funding_symbol??'').trim()||tokenSymbol(input.repo,String(state.parent.funding_token),'FUNDING'),batch=batchId(input.ladderId,'OPEN_BATCH'),now=Date.now(),writes={positions:0,v4Positions:0,deposits:0,reconciliationMarkers:0,legs:state.legs.filter(leg=>String(leg.status)==='PLANNED').length,parent:String(state.parent.status)==='PLANNED'?1:0};for(const mint of mints){const positionId=`v4:${mint.tokenId}`;if(!input.repo.db.prepare('SELECT 1 FROM positions WHERE id=?').get(positionId))writes.positions++;if(!input.repo.v4Position(mint.tokenId))writes.v4Positions++;if(!input.repo.db.prepare('SELECT 1 FROM active_position_reconciliations WHERE position_id=?').get(positionId))writes.reconciliationMarkers++;}
 const bindings=postReceiptOpenSqliteWrite(input,'v4_bid_ladder_open_receipt_projection',openContext,()=>input.repo.db.transaction(()=>{const live=rows(input.repo,input.ladderId);for(const [index,mint] of mints.entries()){const leg=live.legs[index]!,plan=decoded.legs[index]!,fundingAmount=BigInt(String(leg.funding_amount_raw));if((leg.token_id&&String(leg.token_id)!==mint.tokenId.toString())||!sameKey(plan.key,live.key)||plan.tickLower!==Number(leg.tick_lower)||plan.tickUpper!==Number(leg.tick_upper)||plan.liquidity!==BigInt(String(leg.planned_liquidity_raw))||!same(plan.owner,input.wallet)||(fundingIndex===0?plan.amount0Max:plan.amount1Max)!==fundingAmount||(targetIndex===0?plan.amount0Max:plan.amount1Max)!==0n)throw new Error('V4_BID_LADDER_OPEN_FUNDING_ONLY_PROOF_FAILED');const positionId=`v4:${mint.tokenId}`;input.repo.ensurePosition(positionId,mint.tokenId.toString(),String(live.parent.pool_id));input.repo.db.prepare("UPDATE positions SET chain_id=4663,protocol='uniswap_v4' WHERE id=?").run(positionId);input.repo.upsertV4Position({tokenId:mint.tokenId,owner:input.wallet,poolId:String(live.parent.pool_id),poolKey:live.key,currency0:live.key.currency0,currency1:live.key.currency1,fee:live.key.fee,tickSpacing:live.key.tickSpacing,hooks:live.key.hooks,tickLower:plan.tickLower,tickUpper:plan.tickUpper,liquidity:plan.liquidity,initialAmount0:fundingIndex===0?fundingAmount:0n,initialAmount1:fundingIndex===1?fundingAmount:0n,mintHash:receipt.transactionHash,targetToken:getAddress(String(live.parent.target_token)),fundingToken:getAddress(String(live.parent.funding_token)),targetSymbol,fundingSymbol,targetDecimals,fundingDecimals,targetIndex,fundingIndex,feeSemantics:decodeV4Fee(live.key.fee),hookStatus:classifyV4Hooks(live.key.hooks),valuationProvenance:{source:'V4_BID_LADDER_CONFIRMED_RECEIPT_PROJECTION',blockNumber:receipt.blockNumber,transactionHash:receipt.transactionHash},openIntentId:input.ladderId,openEvidence:{lane:'v4_bid_ladder',ladderId:input.ladderId,legIndex:index,mintHash:receipt.transactionHash,blockNumber:receipt.blockNumber,receiptConfirmed:true,reconciliationPending:true}});markOperationalPositionOpenConfirming(input.repo,{positionId,tokenId:mint.tokenId.toString(),intentId:input.ladderId,mintHash:receipt.transactionHash,blockNumber:receipt.blockNumber});input.repo.db.prepare("UPDATE v4_bid_ladder_legs SET token_id=?,open_batch_id=?,status='OPEN',updated_at_ms=? WHERE ladder_id=? AND leg_index=? AND status IN ('PLANNED','OPEN')").run(mint.tokenId.toString(),batch,now,input.ladderId,index);}
  input.repo.db.prepare("UPDATE v4_bid_ladders SET status='OPEN',entry_usd_snapshot=COALESCE(entry_usd_snapshot,?),updated_at_ms=?,revision=revision+CASE WHEN status='PLANNED' THEN 1 ELSE 0 END WHERE ladder_id=? AND execution_mode='LIVE' AND status IN ('PLANNED','OPEN')").run(positionUsd(live.parent,input.repo,input.fundingUsd),now,input.ladderId);return mints.map((mint,index)=>({legIndex:index,tokenId:mint.tokenId,logIndex:mint.logIndex,tickLower:decoded.legs[index]!.tickLower,tickUpper:decoded.legs[index]!.tickUpper,liquidity:decoded.legs[index]!.liquidity}));})());
 enqueueV4BidLadderOpenFreshness(input,rows(input.repo,input.ladderId),receipt,now,openContext);
 postReceiptOpenSqliteWrite(input,'v4_bid_ladder_open_portfolio_refresh_handoff',openContext,()=>enqueuePortfolioRefresh(input.repo,'V4_BID_LADDER_OPEN_RECEIPT_CONFIRMED'));return {bindings,canonicalMirror:{writes,positionIds:bindings.map(binding=>`v4:${binding.tokenId}`),fundingTotal:total}};
}
async function finalizeV4BidLadderOpenProjection(input:LadderLiveContext,receipt:TransactionReceipt,openContext:OpenPostReceiptContext={priorReceiptReuse:false}){
 const projection=persistV4BidLadderOpenReceiptProjection(input,receipt,openContext),state=rows(input.repo,input.ladderId),projectionUnchanged=Object.values(projection.canonicalMirror.writes).every(value=>value===0),depositsComplete=projection.bindings.every(binding=>input.repo.db.prepare("SELECT 1 FROM position_deposits WHERE id=?").get(`v4-bid-ladder-open:${input.ladderId}:${binding.legIndex}`));
 if(projectionUnchanged&&depositsComplete)return {...projection,canonicalMirror:{...projection.canonicalMirror,writes:{...projection.canonicalMirror.writes,deposits:0}}};
 const block=await input.rpc.withClient(client=>client.getBlock({blockNumber:receipt.blockNumber}));
 if(!block||block.timestamp===undefined)throw new Error('OPEN_RECEIPT_BLOCK_TIMESTAMP_UNAVAILABLE');
 let deposits=0;
 postReceiptOpenSqliteWrite(input,'v4_bid_ladder_open_deposit_projection',openContext,()=>input.repo.db.transaction(()=>{for(const binding of projection.bindings){const leg=state.legs[binding.legIndex]!,fundingAmount=BigInt(String(leg.funding_amount_raw)),positionId=`v4:${binding.tokenId}`,inserted=input.repo.ingestDeposit({id:`v4-bid-ladder-open:${input.ladderId}:${binding.legIndex}`,positionId,txHash:receipt.transactionHash,logIndex:binding.logIndex,amounts:{token0:Number(state.parent.funding_index)===0?fundingAmount:0n,token1:Number(state.parent.funding_index)===1?fundingAmount:0n},blockNumber:receipt.blockNumber,blockTimestamp:new Date(Number(block.timestamp)*1000).toISOString()});if(inserted)deposits++;}})());
 postReceiptOpenSqliteWrite(input,'v4_bid_ladder_open_portfolio_snapshot',openContext,()=>persistPortfolioSnapshot(input.repo));
 return {...projection,canonicalMirror:{...projection.canonicalMirror,writes:{...projection.canonicalMirror.writes,deposits}}};
}

/** Read-only continuation for a durable batch whose exact receipt is already
 * terminal in the chain journal. This deliberately exposes reconciliation,
 * not the submit path, to the background worker. */
export async function reconcileConfirmedV4BidLadderJournal(
  input: LadderLiveContext & {
    semanticStage: "OPEN_BATCH" | "CLOSE_BATCH" | `COLLECT_BATCH:${string}`;
    receipt: TransactionReceipt;
    openContext?: OpenPostReceiptContext;
  },
) {
  const journal = journalRow(input.repo, input.ladderId, input.semanticStage);
  if (
    !journal ||
    String(journal.status) !== "CONFIRMED" ||
    !same(String(journal.expected_hash), input.receipt.transactionHash) ||
    !same(
      String(journal.to_address),
      V4_ROBINHOOD_DEPLOYMENTS.positionManager,
    ) ||
    !input.receipt.to ||
    !same(input.receipt.to, V4_ROBINHOOD_DEPLOYMENTS.positionManager)
  )
    throw new Error("V4_BID_LADDER_DURABLE_RECEIPT_IDENTITY_MISMATCH");
  if (input.semanticStage === "OPEN_BATCH")
    return finalizeV4BidLadderOpenProjection(input, input.receipt, input.openContext);
  if (input.semanticStage.startsWith("COLLECT_BATCH:")) {
    const expected = collectExpectedFromJournal(input, input.semanticStage),evidence={positions:expected.map(leg=>({tokenId:leg.tokenId,token0:leg.liquidity,token1:leg.liquidity}))};
    return reconcileCollect(input, input.receipt, expected, evidence, input.semanticStage);
  }
  const reset = input.repo.loadBidLadderUsdReset(input.ladderId),
    resetClose = [
      "CLOSE_PREPARED",
      "CLOSE_SUBMITTED",
      "CLOSE_CONFIRMED",
      "PRINCIPAL_RECONCILED",
      "REOPEN_PLANNED",
      "REOPEN_PREPARED",
      "REOPEN_SUBMITTED",
      "COMPLETED",
    ].includes(String(reset?.phase));
  if (
    resetClose &&
    !isManualRepositionAuthorization(reset?.close_workflow_identity)
  )
    throw new Error("REPOSITION_MANUAL_AUTHORIZATION_REQUIRED");
  return reconcileClose(
    input,
    input.receipt,
    closeExpectedFromJournal(input),
    resetClose ? "USDG_RESET_REPOSITION" : "NORMAL_OPERATOR_CLOSE",
  );
}

type EconomicActionSubmitTiming = {
  journalPreparedAtMs?: number;
  signedAtMs?: number;
  broadcastAtMs?: number;
  receiptDetectedAtMs?: number;
};

function canonicalEconomicProjectionCommit<T>(
  input:LadderLiveContext,
  operation:string,
  semanticStage:string,
  run:()=>T,
){
  if(input.canonicalProjectionLane==="FOREGROUND")return withEconomicForegroundPersistenceSync({
    databasePath:input.repo.path,
    component:"v4-bid-ladder-inline-projection",
    operation,
    workflow:input.ladderId,
    semanticStage,
    run,
    onTelemetry:event=>input.telemetry?.("sqlite_write_window",event),
  });
  return withSqliteTransientRetrySync({operation,run});
}

/** Normal confirmed-receipt continuation. The durable row is persisted first,
 * then the exact same idempotent projection engine used by recovery is invoked
 * before the foreground action returns. A confirmed journal remains sufficient
 * for discovery/recovery even if either local step encounters transient SQLite. */
async function inlineCanonicalBidLadderReceipt(
  input: LadderLiveContext,
  semanticStage: "OPEN_BATCH" | "CLOSE_BATCH" | `COLLECT_BATCH:${string}`,
  receipt: TransactionReceipt,
  options: {
    openContext?: OpenPostReceiptContext;
    timing?: EconomicActionSubmitTiming;
  } = {},
) {
  let durableHandoff = false,
    handoffError: unknown;
  try {
    durableHandoff = handoffBidLadderReceipt(
      input,
      semanticStage,
      receipt,
      options.openContext,
    ).durable;
  } catch (error) {
    handoffError = error;
  }
  const inlineReconcileStartAtMs = Date.now(),
    journal = journalRow(input.repo, input.ladderId, semanticStage),
    parsedAt = (value: unknown) => {
      const parsed = value ? Date.parse(String(value)) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : undefined;
    },
    receiptDetectedAtMs =
      options.timing?.receiptDetectedAtMs ??
      parsedAt(journal?.confirmed_at) ??
      inlineReconcileStartAtMs,
    receiptLatencyMeasurable = options.timing?.receiptDetectedAtMs !== undefined,
    timestamp = (value?: number) =>
      value === undefined ? null : new Date(value).toISOString(),
    emit = (
      continuationStatus: "COMPLETED" | "AUTOMATIC_RECOVERY_ACTIVE",
      canonicalProjectionCommittedAtMs?: number,
      error?: unknown,
    ) => {
      const data = {
        ladderId: input.ladderId,
        workflowId: input.ladderId,
        semanticStage,
        continuationStatus,
        operator_authority_at: timestamp(input.operatorAuthorityAtMs),
        journal_prepared_at: timestamp(
          options.timing?.journalPreparedAtMs ?? parsedAt(journal?.created_at),
        ),
        signed_at: timestamp(options.timing?.signedAtMs),
        broadcast_at: timestamp(
          options.timing?.broadcastAtMs ?? parsedAt(journal?.submitted_at),
        ),
        receipt_detected_at: timestamp(receiptDetectedAtMs),
        inline_reconcile_start_at: timestamp(inlineReconcileStartAtMs),
        canonical_projection_committed_at: timestamp(
          canonicalProjectionCommittedAtMs,
        ),
        next_stage_started_at: null,
        terminal_visible_at: null,
        receipt_to_projection_ms:
          canonicalProjectionCommittedAtMs === undefined || !receiptLatencyMeasurable
            ? null
            : canonicalProjectionCommittedAtMs - receiptDetectedAtMs,
        projection_to_next_stage_ms: null,
        durableHandoff,
        durableHandoffError:
          handoffError instanceof Error ? handoffError.message : handoffError ? String(handoffError) : null,
        inlineReconcileError:
          error instanceof Error ? error.message : error ? String(error) : null,
        sqliteCode: error ? sqliteTransientCode(error) : undefined,
      };
      try {
        input.telemetry?.("interactive_economic_action_latency", data);
      } catch {}
      if(data.receipt_to_projection_ms!==null)try {
        input.repo.recordLatency(
          "interactive_economic_receipt_to_projection",
          data.receipt_to_projection_ms,
          { context: data },
        );
      } catch {}
    };
  try {
      const reconciliation = await reconcileConfirmedV4BidLadderJournal({
        ...input,
        semanticStage,
        receipt,
        openContext: options.openContext,
        canonicalProjectionLane:"FOREGROUND",
      }),
      canonicalProjectionCommittedAtMs = Date.now();
    emit("COMPLETED", canonicalProjectionCommittedAtMs);
    return {
      continuationStatus: "COMPLETED" as const,
      reconciliation,
      reconciliationPending: false as const,
      durableHandoff,
      inlineReconcileStartAtMs,
      canonicalProjectionCommittedAtMs,
      receiptDetectedAtMs,
    };
  } catch (error) {
    emit("AUTOMATIC_RECOVERY_ACTIVE", undefined, error);
    return {
      continuationStatus: "AUTOMATIC_RECOVERY_ACTIVE" as const,
      reconciliation: undefined,
      reconciliationPending: true as const,
      durableHandoff,
      recoveryError: error,
      inlineReconcileStartAtMs,
      canonicalProjectionCommittedAtMs: undefined,
      receiptDetectedAtMs,
    };
  }
}

async function confirmedOpenExecutionResult(
  input: LadderLiveContext,
  receipt: TransactionReceipt,
  options: {
    priorReceiptReuse: boolean;
    mainnetTransactionsSent: number;
    timing?: EconomicActionSubmitTiming;
  },
) {
  const openContext = { priorReceiptReuse: options.priorReceiptReuse };
  const inline = await inlineCanonicalBidLadderReceipt(
      input,
      "OPEN_BATCH",
      receipt,
      { openContext, timing: options.timing },
    ),
    reconciliation = inline.reconciliation as
      | Awaited<ReturnType<typeof finalizeV4BidLadderOpenProjection>>
      | undefined,
    durableHandoff = inline.durableHandoff,
    recoveryError = "recoveryError" in inline ? inline.recoveryError : undefined,
    postReceiptRecoveryRequired = inline.continuationStatus === "AUTOMATIC_RECOVERY_ACTIVE",
    retryable = Boolean(recoveryError && sqliteTransientCode(recoveryError)),
    sqliteOperation =
      recoveryError && typeof (recoveryError as { operation?: unknown }).operation === "string"
        ? String((recoveryError as { operation: string }).operation)
        : retryable
          ? "v4_bid_ladder_open_post_receipt_convergence"
          : null,
    userFacingClassification = postReceiptRecoveryRequired
      ? ("OPEN_REFRESHING" as const)
      : ("OPEN" as const);
  openReceiptTelemetry(input, {
    executionPhase: postReceiptRecoveryRequired
      ? "POST_RECEIPT_RECOVERY_REQUIRED"
      : "POST_RECEIPT_CONVERGED",
    sqliteOperation,
    retryAttempt:
      recoveryError &&
      Number.isSafeInteger((recoveryError as { attempts?: unknown }).attempts)
        ? Number((recoveryError as { attempts: number }).attempts)
        : 0,
    retryable,
    priorReceiptReuse: options.priorReceiptReuse,
    postReceiptRecoveryRequired,
    userFacingClassification,
    duplicateConfirmSuppressed: options.priorReceiptReuse,
    sqliteCode: recoveryError ? sqliteTransientCode(recoveryError) : undefined,
  });
  return {
    status: "OPEN" as const,
    openDisposition: options.priorReceiptReuse
      ? ("ALREADY_OPEN_CONFIRMED" as const)
      : ("OPEN_CONFIRMED" as const),
    receiptConfirmed: true as const,
    hash: receipt.transactionHash,
    confirmedTokenIds: reconciliation?.bindings.map((binding) => binding.tokenId) ??
      confirmedOpenTokenIds(receipt),
    reconciliation,
    reconciliationPending: inline.reconciliationPending,
    durableHandoff,
    continuationStatus: inline.continuationStatus,
    executionPhase: postReceiptRecoveryRequired
      ? ("POST_RECEIPT_RECOVERY_REQUIRED" as const)
      : ("POST_RECEIPT_CONVERGED" as const),
    priorReceiptReuse: options.priorReceiptReuse,
    postReceiptRecoveryRequired,
    userFacingClassification,
    duplicateConfirmSuppressed: options.priorReceiptReuse,
    mainnetTransactionsSent: options.mainnetTransactionsSent,
  };
}

export async function executeV4BidLadderLiveOpen(
  input: LadderLiveContext & { walletClient: WalletClient; requirePreapprovedFunding?: boolean },
) {
  const executionStartedAtMs = Date.now();
  try { input.telemetry?.("v4_bid_ladder_open_execution_start", { ladderId: input.ladderId, executionStartedAtMs }); } catch {}
  const prior = journalRow(input.repo, input.ladderId, "OPEN_BATCH"),
    priorReceipt = confirmedReceipt(prior ?? {});
  if (priorReceipt)
    return confirmedOpenExecutionResult(input, priorReceipt, {
      priorReceiptReuse: true,
      mainnetTransactionsSent: 0,
    });
  const priceMemo = openAttemptPriceMemo(input);
  const initialStartedAtMs = Date.now();
  let preview = await openState(input, true, priceMemo);
  try { input.telemetry?.("v4_bid_ladder_open_initial_state", { ladderId: input.ladderId, durationMs: Date.now() - initialStartedAtMs, confirmToInitialStateMs: Date.now() - executionStartedAtMs, blockNumber: preview.evidence.blockNumber.toString() }); } catch {}
  if (preview.blockers.length)
    throw new Error(`V4_BID_LADDER_OPEN_BLOCKED:${preview.blockers.join(",")}`);
  if(input.requirePreapprovedFunding&&(preview.approval.erc20Required||preview.approval.permit2Required))
    throw new Error('REPOSITION_POST_CONFIRM_APPROVAL_REQUIRED');
  const token = getAddress(String(preview.state.parent.funding_token)),
    aggregate = preview.total;
  if (preview.approval.erc20Required) {
    const data = encodeFunctionData({
        abi: erc20ApprovalAbi,
        functionName: "approve",
        args: [V4_ROBINHOOD_DEPLOYMENTS.permit2, aggregate],
      }),
      gas = await input.rpc.withClient((client) =>
        client.estimateGas({ account: input.wallet, to: token, data }),
      );
    const approvalReceipt = await submit({
      ...input,
      stage: "OPEN_ERC20_APPROVAL",
      to: token,
      data,
      estimatedGas: gas,
      activateOpen: true,
    });
    const deltaStartedAtMs = Date.now();
    preview = await refreshOpenApprovalDelta(
      input,
      preview,
      "OPEN_ERC20_APPROVAL",
      approvalReceipt.receipt.blockNumber,
    );
    try { input.telemetry?.("v4_bid_ladder_open_approval_delta", { ladderId: input.ladderId, stage: "OPEN_ERC20_APPROVAL", receiptBlockNumber: approvalReceipt.receipt.blockNumber.toString(), receiptToNextStageMs: Date.now() - deltaStartedAtMs }); } catch {}
  }
  if (preview.approval.permit2Required) {
    const approval = buildPermit2Approval(
        token,
        aggregate,
        BigInt(Math.floor(Date.now() / 1000) + 3600),
      ),
      gas = await input.rpc.withClient((client) =>
        client.estimateGas({
          account: input.wallet,
          to: approval.to,
          data: approval.data,
        }),
      );
    const approvalReceipt = await submit({
      ...input,
      stage: "OPEN_PERMIT2_APPROVAL",
      to: approval.to,
      data: approval.data,
      estimatedGas: gas,
      activateOpen: true,
    });
    const deltaStartedAtMs = Date.now();
    preview = await refreshOpenApprovalDelta(
      input,
      preview,
      "OPEN_PERMIT2_APPROVAL",
      approvalReceipt.receipt.blockNumber,
    );
    try { input.telemetry?.("v4_bid_ladder_open_approval_delta", { ladderId: input.ladderId, stage: "OPEN_PERMIT2_APPROVAL", receiptBlockNumber: approvalReceipt.receipt.blockNumber.toString(), receiptToNextStageMs: Date.now() - deltaStartedAtMs }); } catch {}
  }
  const authority = await validateFinalOpenAuthority(input, preview, priceMemo);
  if (authority.blockers.length)
    throw new Error(`V4_BID_LADDER_OPEN_BLOCKED:${authority.blockers.join(",")}`);
  if (authority.estimatedGas === null)
    throw new Error("V4_BID_LADDER_MINT_ESTIMATE_FAILED");
  try { input.telemetry?.("v4_bid_ladder_open_signer_boundary", { ladderId: input.ladderId, confirmToSignerBoundaryMs: Date.now() - executionStartedAtMs, finalValidationBlockNumber: authority.evidence.finalBlockNumber.toString(), finalValidationObservedAtMs: authority.evidence.finalObservedAtMs }); } catch {}
  const gas = authority.estimatedGas,
    sent = await submit({
      ...input,
      stage: "OPEN_BATCH",
      to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
      data: authority.plan.calldata,
      estimatedGas: gas,
      batchBinding: "open",
    }),
    receipt = sent.receipt;
  try { input.telemetry?.("v4_bid_ladder_open_execution_complete", { ladderId: input.ladderId, confirmToOpenReceiptMs: Date.now() - executionStartedAtMs, recovered: sent.recovered, receiptBlockNumber: receipt.blockNumber.toString(), mainnetTransactionsSent: sent.recovered ? 0 : 1 }); } catch {}
  return confirmedOpenExecutionResult(input, receipt, {
    priorReceiptReuse: sent.recovered,
    mainnetTransactionsSent: sent.recovered ? 0 : 1,
    timing: sent.timing,
  });
}

async function closeState(input: LadderLiveContext) {
  const state = rows(input.repo, input.ladderId),
    blockers: string[] = [];
  if (
    String(state.parent.execution_mode) !== "LIVE" ||
    String(state.parent.status) !== "OPEN"
  )
    blockers.push("V4_BID_LADDER_CLOSE_STATE_INVALID");
  if (pendingOther(input.repo, input.ladderId, input.wallet))
    blockers.push("V4_BID_LADDER_UNRESOLVED_TRANSACTION");
  const inspected = await Promise.all(
      state.legs.map(async (leg) => {
        if (!leg.token_id) throw new Error("V4_BID_LADDER_TOKEN_ID_MISSING");
        const proof = await inspectV4Position(
          input.rpc,
          BigInt(String(leg.token_id)),
        );
        if (
          !same(proof.owner, input.wallet) ||
          poolId(proof.key).toLowerCase() !==
            String(state.parent.pool_id).toLowerCase() ||
          proof.tickLower !== Number(leg.tick_lower) ||
          proof.tickUpper !== Number(leg.tick_upper)
        )
          throw new Error("V4_BID_LADDER_CLOSE_IDENTITY_MISMATCH");
        return { ...proof, leg };
      }),
    ),
    active = inspected.filter((value) => value.liquidity > 0n),
    pool = await inspectV4Pool(input.rpc, state.key);
  if (pool.status === "unavailable") throw new Error(pool.reason);
  const closeValuation:BoundCloseValuation={contract:"DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V1",poolId:String(state.parent.pool_id),poolKey:state.key,sqrtPriceX96:pool.value.sqrtPriceX96.toString(),tick:pool.value.tick,activeLiquidity:pool.value.liquidity.toString(),initialized:pool.value.initialized,observationBlock:pool.value.blockNumber.toString(),observedAtMs:Date.now(),token0Decimals:tokenDecimals(input.repo,state.key.currency0),token1Decimals:tokenDecimals(input.repo,state.key.currency1)};
  const composition = inspected.map((value) => ({
      tokenId: value.tokenId,
      ...amountsForLiquidity(
        pool.value.sqrtPriceX96,
        value.tickLower,
        value.tickUpper,
        value.liquidity,
      ),
    })),
    aggregateExpected = composition.reduce(
      (sum, value) => ({
        token0: sum.token0 + value.token0,
        token1: sum.token1 + value.token1,
      }),
      { token0: 0n, token1: 0n },
    ),
    deadline = BigInt(Math.floor(Date.now() / 1000) + 600),
    plan = active.length
      ? buildV4BatchFullDecrease({
          recipient: input.wallet,
          deadline,
          legs: active.map((value) => {
            const mins = v4BidLadderCloseMinimums({
              sqrtPriceX96: pool.value.sqrtPriceX96,
              tickLower: value.tickLower,
              tickUpper: value.tickUpper,
              liquidity: value.liquidity,
            });
            return {
              key: state.key,
              tokenId: value.tokenId,
              liquidity: value.liquidity,
              amount0Min: mins.amount0Min,
              amount1Min: mins.amount1Min,
              hookData: "0x" as Hex,
            };
          }),
        })
      : null;
  let estimatedGas: bigint | null = null;
  if (plan)
    try {
      estimatedGas = await input.rpc.withClient((client) =>
        client.estimateGas({
          account: input.wallet,
          to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
          data: plan.calldata,
          value: 0n,
        }),
      );
    } catch {
      blockers.push("V4_BID_LADDER_CLOSE_ESTIMATE_FAILED");
    }
  return {
    state,
    pool: pool.value,
    inspected,
    active,
    composition,
    aggregateExpected,
    plan,
    estimatedGas,
    closeValuation,
    blockers,
  };
}

async function collectState(input: LadderLiveContext) {
  const state = rows(input.repo, input.ladderId),
    blockers: string[] = [];
  if (
    String(state.parent.execution_mode) !== "LIVE" ||
    String(state.parent.status) !== "OPEN"
  )
    blockers.push("V4_BID_LADDER_COLLECT_STATE_INVALID");
  if (state.legs.some((leg) => String(leg.status) !== "OPEN" || !leg.token_id))
    blockers.push("V4_BID_LADDER_COLLECT_LEG_STATE_INVALID");
  if (pendingOther(input.repo, input.ladderId, input.wallet))
    blockers.push("V4_BID_LADDER_UNRESOLVED_TRANSACTION");
  const unresolvedCollect = input.repo.db
    .prepare(
      "SELECT 1 FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND status IN ('PREPARED','SUBMITTED') LIMIT 1",
    )
    .get(CHAIN_ID, input.ladderId);
  if (unresolvedCollect)
    blockers.push("V4_BID_LADDER_COLLECT_RECONCILIATION_PENDING");
  const inspected = await Promise.all(
    state.legs.map(async (leg) => {
      const tokenId = BigInt(String(leg.token_id)),
        proof = await inspectV4Position(input.rpc, tokenId),
        mirror = input.repo.v4Position(tokenId);
      if (
        !mirror ||
        !same(proof.owner, input.wallet) ||
        !sameKey(proof.key, state.key) ||
        proof.tickLower !== Number(leg.tick_lower) ||
        proof.tickUpper !== Number(leg.tick_upper) ||
        BigInt(String(mirror.liquidity_raw)) !== proof.liquidity ||
        String(mirror.open_intent_id) !== input.ladderId
      )
        throw new Error("V4_BID_LADDER_COLLECT_IDENTITY_MISMATCH");
      return { ...proof, leg };
    }),
  );
  const fees = await inspectV4ClaimableFeesBatch(
    input.rpc,
    inspected.map((value) => ({
      tokenId: value.tokenId,
      key: state.key,
      tickLower: value.tickLower,
      tickUpper: value.tickUpper,
      liquidity: value.liquidity,
    })),
  );
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600),
    plan =
      fees.token0 + fees.token1 > 0n
        ? buildV4BatchCollect({
            recipient: input.wallet,
            deadline,
            legs: inspected.map((value) => ({
              key: state.key,
              tokenId: value.tokenId,
              hookData: "0x" as Hex,
            })),
          })
        : null;
  let estimatedGas: bigint | null = null;
  if (plan)
    try {
      estimatedGas = await input.rpc.withClient((client) =>
        client.estimateGas({
          account: input.wallet,
          to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
          data: plan.calldata,
          value: 0n,
        }),
      );
    } catch {
      blockers.push("V4_BID_LADDER_COLLECT_ESTIMATE_FAILED");
    }
  const d0 = tokenDecimals(input.repo, state.key.currency0),
    d1 = tokenDecimals(input.repo, state.key.currency1),
    fundingIndex = Number(state.parent.funding_index) as 0 | 1;
  const estimatedUsd = v4BidLadderFeeUsdValue({
    token0Raw: fees.token0,
    token1Raw: fees.token1,
    token0Decimals: d0,
    token1Decimals: d1,
    sqrtPriceX96: fees.pool.sqrtPriceX96,
    fundingIndex,
    fundingUsd: input.fundingUsd,
  });
  return {
    state,
    inspected,
    fees,
    plan,
    estimatedGas,
    estimatedUsd,
    token0: {
      symbol: tokenSymbol(input.repo, state.key.currency0, "TOKEN0"),
      decimals: d0,
    },
    token1: {
      symbol: tokenSymbol(input.repo, state.key.currency1, "TOKEN1"),
      decimals: d1,
    },
    blockers,
  };
}
export async function previewV4BidLadderCollect(input: LadderLiveContext) {
  return collectState(input);
}

export function v4BidLadderFeeUsdValue(input: {
  token0Raw: bigint;
  token1Raw: bigint;
  token0Decimals: number;
  token1Decimals: number;
  sqrtPriceX96: bigint;
  fundingIndex: 0 | 1;
  fundingUsd: number;
}) {
  if (
    ![input.token0Decimals, input.token1Decimals].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    ) ||
    !Number.isFinite(input.fundingUsd) ||
    input.fundingUsd <= 0
  )
    return null;
  try {
    return v4BidLadderFeeUsdFromPrice({
      ...input,
      token1PerToken0: priceFromSqrtX96(
        input.sqrtPriceX96,
        input.token0Decimals,
        input.token1Decimals,
      ),
    });
  } catch {
    return null;
  }
}
export function v4BidLadderFeeUsdFromPrice(input: {
  token0Raw: bigint;
  token1Raw: bigint;
  token0Decimals: number;
  token1Decimals: number;
  token1PerToken0: number;
  fundingIndex: 0 | 1;
  fundingUsd: number;
}) {
  if (
    ![input.token0Decimals, input.token1Decimals].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    ) ||
    !Number.isFinite(input.fundingUsd) ||
    input.fundingUsd <= 0 ||
    !Number.isFinite(input.token1PerToken0) ||
    input.token1PerToken0 <= 0
  )
    return null;
  const token0 = Number(input.token0Raw) / 10 ** input.token0Decimals,
    token1 = Number(input.token1Raw) / 10 ** input.token1Decimals,
    value =
      input.fundingIndex === 0
        ? (token0 + token1 / input.token1PerToken0) * input.fundingUsd
        : (token1 + token0 * input.token1PerToken0) * input.fundingUsd;
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function collectExpectedFromJournal(input: LadderLiveContext, stage: string) {
  const state = rows(input.repo, input.ladderId),
    prepared = preparedFrom(journalRow(input.repo, input.ladderId, stage));
  if (!prepared)
    throw new Error("V4_BID_LADDER_COLLECT_PREPARED_REQUEST_MISSING");
  const decoded = decodeV4BatchCollect(prepared.request.data, {
    key: state.key,
    recipient: input.wallet,
  });
  if (decoded.legs.length !== 5)
    throw new Error("V4_BID_LADDER_COLLECT_LEG_SET_INVALID");
  return decoded.legs.map((action) => {
    const leg = state.legs.find(
      (row) => String(row.token_id) === action.tokenId.toString(),
    );
    if (!leg) throw new Error("V4_BID_LADDER_COLLECT_JOURNAL_TOKEN_MISMATCH");
    return {
      key: state.key,
      tokenId: action.tokenId,
      liquidity: BigInt(
        String(input.repo.v4Position(action.tokenId)?.liquidity_raw ?? "-1"),
      ),
      owner: input.wallet,
      tickLower: Number(leg.tick_lower),
      tickUpper: Number(leg.tick_upper),
    };
  });
}
function allocatedCollect(total: bigint, weights: readonly bigint[]) {
  const denominator = weights.reduce((sum, value) => sum + value, 0n);
  if (denominator === 0n)
    return weights.map((_, index) =>
      index === weights.length - 1 ? total : 0n,
    );
  let used = 0n;
  return weights.map((weight, index) => {
    const amount =
      index === weights.length - 1
        ? total - used
        : (total * weight) / denominator;
    used += amount;
    return amount;
  });
}
async function reconcileCollect(
  input: LadderLiveContext,
  receipt: TransactionReceipt,
  expected: ReturnType<typeof collectExpectedFromJournal>,
  feeEvidence: {
    positions: readonly { tokenId: bigint; token0: bigint; token1: bigint }[];
  },
  stage: string,
) {
  const result = await reconcileV4BatchCollectReceipt({
    receipt: receiptShape(receipt),
    expectedLegs: expected,
    recipient: input.wallet,
    inspectPosition: async (id) => {const leg=expected.find(value=>value.tokenId===id);if(!leg)throw new Error('V4_BID_LADDER_COLLECT_TOKEN_MISMATCH');return {...leg,tokenId:id,liquidity:leg.liquidity};},
  });
  if (
    result.aggregateTransfers.token0 === null ||
    result.aggregateTransfers.token1 === null
  )
    throw new Error(
      "V4_BID_LADDER_COLLECT_NATIVE_RECEIPT_EVIDENCE_UNAVAILABLE",
    );
  const refreshed = {status:'DEFERRED_TO_STATE_CACHE' as const,positions:expected.map(leg=>({tokenId:leg.tokenId}))};
  const state = rows(input.repo, input.ladderId), byId = new Map(
      feeEvidence.positions.map((value) => [value.tokenId.toString(), value]),
    ),
    a0 = allocatedCollect(
      result.aggregateTransfers.token0,
      expected.map((leg) => byId.get(leg.tokenId.toString())?.token0 ?? 0n),
    ),
    a1 = allocatedCollect(
      result.aggregateTransfers.token1,
      expected.map((leg) => byId.get(leg.tokenId.toString())?.token1 ?? 0n),
    );
  const finalBlock = await input.rpc.withClient((client) => client.getBlock({ blockNumber: receipt.blockNumber }));
  if (!finalBlock || finalBlock.timestamp === undefined)
    throw new Error("REALIZED_PNL_RECEIPT_BLOCK_TIMESTAMP_UNAVAILABLE");
  const parent = state.parent,
    bound=await captureCollectValuation(input,state,receipt,stage),
    valuation=bound.status==="AVAILABLE"&&bound.sqrtPriceX96!==null&&bound.tick!==null&&bound.activeLiquidity!==null&&bound.initialized!==null?valueV4ReturnsFromSqrtPriceX96({token0:state.key.currency0,token1:state.key.currency1,decimals0:bound.token0Decimals,decimals1:bound.token1Decimals,amount0:result.aggregateTransfers.token0,amount1:result.aggregateTransfers.token1,sqrtPriceX96:BigInt(bound.sqrtPriceX96),source:{poolId:bound.poolId,poolKey:bound.poolKey,sqrtPriceX96:BigInt(bound.sqrtPriceX96),tick:bound.tick,activeLiquidity:BigInt(bound.activeLiquidity),initialized:bound.initialized,blockNumber:BigInt(bound.observationBlock),token0Decimals:bound.token0Decimals,token1Decimals:bound.token1Decimals}}):{status:"INCOMPLETE" as const,reason:bound.reason??"INCOMPLETE_HISTORICAL_POOL_STATE_UNAVAILABLE"},
    feeUsd = valuation.status==="AVAILABLE" ? usdMicrosToText(valuation.totalUsdMicros) : undefined,
    finalAtMs = Number(finalBlock.timestamp) * 1000;
  canonicalEconomicProjectionCommit(
    input,
    "v4_bid_ladder_collect_reconciliation_commit",
    stage,
    () =>
      input.repo.db.transaction(() => {
        expected.forEach((leg, index) => {
          const positionId = `v4:${leg.tokenId}`;
          input.repo.ingestCollection({
            id: `v4-bid-ladder-collect:${receipt.transactionHash}:${leg.tokenId}`,
            positionId,
            txHash: receipt.transactionHash,
            logIndex: index,
            amounts: { token0: a0[index]!, token1: a1[index]! },
            pending: { token0: 0n, token1: 0n },
          });
          const totals = input.repo.collectionTotals(positionId);
          input.repo.db
            .prepare(
              "UPDATE v4_positions SET liquidity_raw=?,claimed_fee0_raw=?,claimed_fee1_raw=?,withdrawn_principal0_raw=?,withdrawn_principal1_raw=?,updated_at=? WHERE token_id=?",
            )
            .run(
              leg.liquidity.toString(),
              totals.fees.token0.toString(),
              totals.fees.token1.toString(),
              totals.principal.token0.toString(),
              totals.principal.token1.toString(),
              new Date().toISOString(),
              leg.tokenId.toString(),
            );
        });
        input.repo.appendRealizedPnlEvent({
          eventId: `${input.ladderId}:${stage}:${receipt.transactionHash.toLowerCase()}:CLAIM`,
          eventKind: "CLAIM", protocol: "v4", strategyType: "V4_BID_LADDER",
          ladderIdentity: input.ladderId, workflowIdentity: input.ladderId, journalStage: stage,
          transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash, economicFinalAtMs: finalAtMs,
          newlyRealizedFeesUsd: feeUsd, realizedPnlUsd: feeUsd,
          token0Raw: result.aggregateTransfers.token0 ?? undefined, token1Raw: result.aggregateTransfers.token1 ?? undefined,
          token0Decimals: bound.token0Decimals,
          token1Decimals: bound.token1Decimals,
          valuationStatus: valuation.status,
          valuationEvidence: valuation.status==="AVAILABLE"?{...valuation.evidence,poolId:bound.poolId,poolKey:bound.poolKey,observationBlock:bound.observationBlock,observedAtMs:bound.observedAtMs,evidenceSource:bound.evidenceSource,receiptBlockNumber:receipt.blockNumber,receiptBlockHash:receipt.blockHash,receiptTransactionIndex:bound.receiptTransactionIndex,sameBlockLaterPoolSwaps:bound.sameBlockLaterPoolSwaps,totalClaimFeesUsd:feeUsd}:{contract:"DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V1",status:"INCOMPLETE",reason:valuation.reason,poolId:bound.poolId,poolKey:bound.poolKey,observationBlock:bound.observationBlock,observedAtMs:bound.observedAtMs,evidenceSource:bound.evidenceSource,receiptBlockNumber:receipt.blockNumber,receiptBlockHash:receipt.blockHash,receiptTransactionIndex:bound.receiptTransactionIndex,sameBlockLaterPoolSwaps:bound.sameBlockLaterPoolSwaps,token0Raw:result.aggregateTransfers.token0,token1Raw:result.aggregateTransfers.token1},
          presentationMetadata: { pair: `${String(parent.target_token)}/${String(parent.funding_token)}`, strategy: "V4 BID LADDER" },
        });
      })(),
  );
  enqueuePortfolioRefresh(input.repo,'ECONOMIC_CLAIM_RECONCILED');
  return {
    ...result,
    refreshed,
    claimed: {
      token0: result.aggregateTransfers.token0,
      token1: result.aggregateTransfers.token1,
    },
    principalUnchanged: true,
    liquidityUnchanged: true,
  };
}
export async function executeV4BidLadderCollect(
  input: LadderLiveContext & {
    walletClient: WalletClient;
    collectAuthorizationId: string;
    expectedTokenIds: readonly string[];
  },
) {
  const stage = v4BidLadderCollectStage(input.collectAuthorizationId),
    state = rows(input.repo, input.ladderId),
    actualTokenIds = state.legs.map((leg) => String(leg.token_id));
  if (
    input.expectedTokenIds.length !== 5 ||
    input.expectedTokenIds.some((id, index) => id !== actualTokenIds[index])
  )
    throw new Error("V4_BID_LADDER_COLLECT_AUTHORIZATION_NFT_MISMATCH");
  const prior = journalRow(input.repo, input.ladderId, stage),
    receipt = confirmedReceipt(prior ?? {});
  if (receipt) {
    const inline=await inlineCanonicalBidLadderReceipt(input,stage,receipt);
    return {
      status: "COLLECTED" as const,
      hash: receipt.transactionHash,
      reconciliation: inline.reconciliation as Awaited<ReturnType<typeof reconcileCollect>> | undefined,
      reconciliationPending:inline.reconciliationPending,
      durableHandoff:inline.durableHandoff,
      continuationStatus:inline.continuationStatus,
      mainnetTransactionsSent: 0,
      collectAuthorizationId: input.collectAuthorizationId,
    };
  }
  if (prior && ["PREPARED", "SUBMITTED"].includes(String(prior.status)))
    throw new Error("V4_BID_LADDER_COLLECT_RECONCILIATION_PENDING");
  if (prior && String(prior.status) === "FAILED")
    throw new Error("V4_BID_LADDER_COLLECT_AUTHORIZATION_TERMINAL_FAILED");
  const preview = await collectState(input);
  if (preview.blockers.length)
    throw new Error(
      `V4_BID_LADDER_COLLECT_BLOCKED:${preview.blockers.join(",")}`,
    );
  if (!preview.plan)
    return { status: "NO_CLAIMABLE_FEES" as const, mainnetTransactionsSent: 0 };
  const plan = preview.plan,
    estimatedGas = preview.estimatedGas;
  if (estimatedGas === null)
    throw new Error("V4_BID_LADDER_COLLECT_ESTIMATE_REQUIRED");
  return postBroadcastSqliteBoundary(input, stage, async () => {
    const sent = await submit({
      ...input,
      stage,
      to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
      data: plan.calldata,
      estimatedGas,
    });
    const inline=await inlineCanonicalBidLadderReceipt(input,stage,sent.receipt,{timing:sent.timing});
    return {
      status: "COLLECTED" as const,
      hash: sent.hash,
      reconciliation: inline.reconciliation as Awaited<ReturnType<typeof reconcileCollect>> | undefined,
      reconciliationPending:inline.reconciliationPending,
      durableHandoff:inline.durableHandoff,
      continuationStatus:inline.continuationStatus,
      mainnetTransactionsSent: sent.recovered ? 0 : 1,
      collectAuthorizationId: input.collectAuthorizationId,
    };
  });
}
export async function previewV4BidLadderClose(input: LadderLiveContext) {
  return closeState(input);
}
function closeCanonicalMirrors(
  repo: SqliteLedgerRepository,
  state: LadderRows,
  provenance:
    | "FUNI_EXECUTED"
    | "EXTERNAL_OPERATOR_CLOSE"
    | "UNKNOWN_EXTERNAL" = "FUNI_EXECUTED",
) {
  const writes = { positions: 0, v4Positions: 0, legs: 0, parent: 0 },
    now = Date.now();
  for (const leg of state.legs) {
    if (!leg.token_id) throw new Error("V4_BID_LADDER_TOKEN_ID_MISSING");
    const tokenId = String(leg.token_id),
      positionId = `v4:${tokenId}`,
      generic = repo.db
        .prepare("SELECT * FROM positions WHERE id=?")
        .get(positionId) as Record<string, unknown> | undefined,
      row = repo.v4Position(tokenId);
    if (
      !generic ||
      !row ||
      String(row.open_intent_id) !== String(state.parent.ladder_id) ||
      !same(String(row.pool_id), String(state.parent.pool_id)) ||
      Number(row.tick_lower) !== Number(leg.tick_lower) ||
      Number(row.tick_upper) !== Number(leg.tick_upper)
    )
      throw new Error("V4_BID_LADDER_CLOSE_CANONICAL_MIRROR_MISSING");
    if (String(generic.status) !== "closed") {
      repo.db
        .prepare("UPDATE positions SET status='closed' WHERE id=?")
        .run(positionId);
      writes.positions++;
    }
    if (
      String(row.status) !== "closed" ||
      BigInt(String(row.liquidity_raw)) !== 0n
    ) {
      repo.db
        .prepare(
          "UPDATE v4_positions SET status='closed',liquidity_raw='0',updated_at=? WHERE token_id=?",
        )
        .run(new Date(now).toISOString(), tokenId);
      writes.v4Positions++;
    }
    if (String(leg.status) === "OPEN") {
      repo.db
        .prepare(
          "UPDATE v4_bid_ladder_legs SET status='CLOSED',updated_at_ms=? WHERE ladder_id=? AND leg_index=? AND status='OPEN'",
        )
        .run(now, state.parent.ladder_id, leg.leg_index);
      writes.legs++;
    } else if (String(leg.status) !== "CLOSED")
      throw new Error("V4_BID_LADDER_CLOSE_LEG_STATE_CONFLICT");
  }
  if (String(state.parent.status) === "OPEN") {
    const changed = repo.db
      .prepare(
        "UPDATE v4_bid_ladders SET status='CLOSED',close_provenance=?,updated_at_ms=?,revision=revision+1 WHERE ladder_id=? AND execution_mode='LIVE' AND status='OPEN'",
      )
      .run(provenance, now, state.parent.ladder_id).changes;
    if (changed !== 1) throw new Error("V4_BID_LADDER_CLOSE_PARENT_CONFLICT");
    writes.parent++;
  } else if (String(state.parent.status) !== "CLOSED")
    throw new Error("V4_BID_LADDER_CLOSE_PARENT_CONFLICT");
  return writes;
}
function assertCanonicalClosePostcondition(input: {
  repo: SqliteLedgerRepository;
  ladderId: string;
  receipt: TransactionReceipt;
  revisionBefore: number;
  parentWasOpen: boolean;
  mirrorWrites: ReturnType<typeof closeCanonicalMirrors>;
}) {
  const parent = input.repo.loadBidLadder(input.ladderId);
  if (
    !parent ||
    String(parent.status) !== "CLOSED" ||
    String(parent.close_provenance) !== "FUNI_EXECUTED" ||
    String(parent.terminal_provenance) !== "FUNI_AUTHORED_CLOSE_BATCH"
  )
    throw new Error("V4_BID_LADDER_CLOSE_CANONICAL_POSTCONDITION_FAILED");
  if (
    input.mirrorWrites.parent !== 0 ||
    Number(parent.revision) !== input.revisionBefore + (input.parentWasOpen ? 1 : 0)
  )
    throw new Error("V4_BID_LADDER_CLOSE_TERMINAL_TRANSITION_NOT_EXACTLY_ONCE");
  const journal = input.repo.db.prepare(
    "SELECT journal_id,status,expected_hash,receipt_json FROM chain_transaction_journal WHERE chain_id=? AND protocol='uniswap_v4' AND workflow_identity=? AND semantic_stage='CLOSE_BATCH' AND lower(expected_hash)=lower(?)",
  ).get(CHAIN_ID, input.ladderId, input.receipt.transactionHash) as Record<string, unknown> | undefined;
  const journalReceipt = journal ? confirmedReceipt(journal) : undefined;
  if (
    !journal ||
    String(journal.status) !== "CONFIRMED" ||
    !journalReceipt ||
    journalReceipt.status !== "success" ||
    !same(journalReceipt.transactionHash, input.receipt.transactionHash)
  )
    throw new Error("V4_BID_LADDER_CLOSE_JOURNAL_POSTCONDITION_FAILED");
  const mirrors = input.repo.db.prepare(
    `SELECT COUNT(*) count,
      SUM(CASE WHEN leg.status='CLOSED' AND leg.close_batch_id=? THEN 1 ELSE 0 END) closed_legs,
      SUM(CASE WHEN position.status='closed' THEN 1 ELSE 0 END) closed_positions,
      SUM(CASE WHEN v4.status='closed' AND v4.liquidity_raw='0' AND v4.open_intent_id=? THEN 1 ELSE 0 END) closed_v4_positions
     FROM v4_bid_ladder_legs leg
     LEFT JOIN v4_positions v4 ON v4.token_id=leg.token_id
     LEFT JOIN positions position ON position.id='v4:'||leg.token_id
     WHERE leg.ladder_id=?`,
  ).get(String(journal.journal_id), input.ladderId, input.ladderId) as {
    count: number;
    closed_legs: number;
    closed_positions: number;
    closed_v4_positions: number;
  };
  if (
    mirrors.count !== 5 ||
    mirrors.closed_legs !== 5 ||
    mirrors.closed_positions !== 5 ||
    mirrors.closed_v4_positions !== 5
  )
    throw new Error("V4_BID_LADDER_CLOSE_MIRROR_POSTCONDITION_FAILED");
  return {
    status: "PROVEN" as const,
    parentRevision: Number(parent.revision),
    journalId: String(journal.journal_id),
    terminalTransitions: input.parentWasOpen ? 1 : 0,
  };
}
export function reconcileTerminalV4BidLadderParent(input: {
  repo: SqliteLedgerRepository;
  ladderId: string;
  provenance: "FUNI_EXECUTED" | "EXTERNAL_OPERATOR_CLOSE" | "UNKNOWN_EXTERNAL";
}) {
  return convergeTerminalV4BidLadder({repo:input.repo,ladderId:input.ladderId,provenance:input.provenance==='FUNI_EXECUTED'?'FUNI_CLOSE_CONFIRMED':'EXTERNAL_OR_UNKNOWN_TERMINAL'});
}
type V4BidLadderManualCloseReconciliation = {
  aggregateTransfers:
    | Awaited<
        ReturnType<typeof reconcileV4BatchFullDecreaseReceipt>
      >["aggregateTransfers"]
    | undefined;
  canonicalMirror: { writes: ReturnType<typeof closeCanonicalMirrors> };
  atomicPostcondition: ReturnType<typeof assertCanonicalClosePostcondition>;
  perLegCloseAccounting: "UNAVAILABLE_FROM_AGGREGATE_TAKE_PAIR";
};
const pendingCloseReconciliation=()=>({aggregateTransfers:undefined,canonicalMirror:{writes:{positions:0,v4Positions:0,legs:0,parent:0}},atomicPostcondition:undefined,perLegCloseAccounting:"UNAVAILABLE_FROM_AGGREGATE_TAKE_PAIR" as const,reconciliationPending:true as const});
async function reconcileClose(
  input: LadderLiveContext,
  receipt: TransactionReceipt,
  expected: readonly {
    key: V4PoolKey;
    tokenId: bigint;
    liquidity: bigint;
    owner: Address;
    tickLower: number;
    tickUpper: number;
  }[],
  closeReason: "NORMAL_OPERATOR_CLOSE" | "USDG_RESET_REPOSITION",
): Promise<V4BidLadderManualCloseReconciliation> {
  const result = await reconcileV4BatchFullDecreaseReceipt({
      receipt: receiptShape(receipt),
      expectedLegs: expected,
      recipient: input.wallet,
      inspectPosition: async (id) => {const leg=expected.find(value=>value.tokenId===id);if(!leg)throw new Error('V4_BID_LADDER_CLOSE_TOKEN_MISMATCH');return {...leg,tokenId:id,liquidity:0n};},
    }),
    state = rows(input.repo, input.ladderId);
  if (result.aggregateTransfers.token0 === null || result.aggregateTransfers.token1 === null)
    throw new Error("REALIZED_PNL_CLOSE_TRANSFER_EVIDENCE_UNAVAILABLE");
  const finalBlock = await input.rpc.withClient((client) => client.getBlock({ blockNumber: receipt.blockNumber }));
  if (!finalBlock || finalBlock.timestamp === undefined)
    throw new Error("REALIZED_PNL_RECEIPT_BLOCK_TIMESTAMP_UNAVAILABLE");
  const parent = state.parent,
    fundingIndex = Number(parent.funding_index) as 0 | 1,
    fundingDecimals = Number(parent.funding_decimals ?? 6),
    closeFeeAttribution=await captureCloseFeeAttribution(input,state,receipt,expected,{token0:result.aggregateTransfers.token0,token1:result.aggregateTransfers.token1}),
    closeFeeValuation=closeFeeAttribution.status==="AVAILABLE"&&closeFeeAttribution.sqrtPriceX96!==null&&closeFeeAttribution.tick!==null&&closeFeeAttribution.activeLiquidity!==null&&closeFeeAttribution.initialized!==null&&closeFeeAttribution.closeFee0Raw!==null&&closeFeeAttribution.closeFee1Raw!==null?valueV4ReturnsFromSqrtPriceX96({token0:state.key.currency0,token1:state.key.currency1,decimals0:closeFeeAttribution.token0Decimals,decimals1:closeFeeAttribution.token1Decimals,amount0:BigInt(closeFeeAttribution.closeFee0Raw),amount1:BigInt(closeFeeAttribution.closeFee1Raw),sqrtPriceX96:BigInt(closeFeeAttribution.sqrtPriceX96),source:{poolId:closeFeeAttribution.poolId,poolKey:closeFeeAttribution.poolKey,sqrtPriceX96:BigInt(closeFeeAttribution.sqrtPriceX96),tick:closeFeeAttribution.tick,activeLiquidity:BigInt(closeFeeAttribution.activeLiquidity),initialized:closeFeeAttribution.initialized,blockNumber:BigInt(closeFeeAttribution.observationBlock),token0Decimals:closeFeeAttribution.token0Decimals,token1Decimals:closeFeeAttribution.token1Decimals}}):null,
    closeFeeUsd=closeFeeValuation?.status==="AVAILABLE"?usdMicrosToText(closeFeeValuation.totalUsdMicros):undefined,
    bound=closeValuationFromJournal(input.repo,input.ladderId),
    boundValid=Boolean(bound&&same(bound.poolId,String(parent.pool_id))&&sameKey(bound.poolKey,state.key)),
    valuation=boundValid?valueV4ReturnsFromSqrtPriceX96({token0:state.key.currency0,token1:state.key.currency1,decimals0:bound!.token0Decimals,decimals1:bound!.token1Decimals,amount0:result.aggregateTransfers.token0,amount1:result.aggregateTransfers.token1,sqrtPriceX96:BigInt(bound!.sqrtPriceX96),source:{poolId:bound!.poolId,poolKey:bound!.poolKey,sqrtPriceX96:BigInt(bound!.sqrtPriceX96),tick:bound!.tick,activeLiquidity:BigInt(bound!.activeLiquidity),initialized:bound!.initialized,blockNumber:BigInt(bound!.observationBlock),token0Decimals:bound!.token0Decimals,token1Decimals:bound!.token1Decimals}}):{status:"INCOMPLETE" as const,reason:"BOUND_CLOSE_PRICE_EVIDENCE_UNAVAILABLE"},
    returnedMicros = valuation.status==="AVAILABLE"?valuation.totalUsdMicros:null,
    basisMicros = rawUsdMicros(BigInt(String(parent.total_funding_amount_raw)),fundingDecimals,"1"),
    priced = returnedMicros !== null,
    finalAtMs = Number(finalBlock.timestamp) * 1000;
  const firstPosition=input.repo.v4Position(String(state.legs[0]?.token_id??"")),pair=v4BidLadderClosePairLabel({targetSymbol:firstPosition?.target_symbol,fundingSymbol:firstPosition?.funding_symbol,targetAddress:parent.target_token,fundingAddress:parent.funding_token}),opened=input.repo.db.prepare("SELECT MIN(block_timestamp) opened_at FROM position_deposits WHERE position_id IN (SELECT 'v4:'||token_id FROM v4_positions WHERE open_intent_id=?)").get(input.ladderId) as {opened_at:string|null},eventId=`${input.ladderId}:CLOSE_BATCH:${receipt.transactionHash.toLowerCase()}:CLOSE`;
  let mirrorWrites: ReturnType<typeof closeCanonicalMirrors>,
    atomicPostcondition: ReturnType<typeof assertCanonicalClosePostcondition>;
  const apply = input.repo.db.transaction(() => {
    const parentBefore = input.repo.loadBidLadder(input.ladderId);
    if (!parentBefore) throw new Error("V4_BID_LADDER_CLOSE_PARENT_MISSING");
    convergeTerminalV4BidLadder({repo:input.repo,ladderId:input.ladderId,provenance:"FUNI_CLOSE_CONFIRMED",nowMs:finalAtMs});
    mirrorWrites = closeCanonicalMirrors(
      input.repo,
      rows(input.repo, input.ladderId),
    );
    const reset = input.repo.loadBidLadderUsdReset(input.ladderId);
    if (reset) {
      if (closeReason === "USDG_RESET_REPOSITION") {
        if (["CLOSE_PREPARED", "CLOSE_SUBMITTED"].includes(String(reset.phase)))
          convergeConfirmedV4BidLadderRepositionClose({repo:input.repo,ladderId:input.ladderId,nowMs:finalAtMs});
        else if (!["CLOSE_CONFIRMED", "PRINCIPAL_RECONCILED", "REOPEN_PLANNED", "REOPEN_PREPARED", "REOPEN_SUBMITTED", "COMPLETED"].includes(String(reset.phase)))
          throw new Error("V4_BID_LADDER_USDG_RESET_CLOSE_PHASE_INVALID");
      } else if (String(reset.phase) !== "OPERATOR_CLOSED")
        input.repo.transitionBidLadderUsdReset({
          ladderId: input.ladderId,
          from: ["OPEN_PENDING", "WATCHING"],
          to: "OPERATOR_CLOSED",
          closeReason,
          closeWorkflowIdentity: input.ladderId,
        });
    }
    const existing=input.repo.db.prepare("SELECT valuation_evidence_json FROM realized_pnl_events WHERE event_id=?").get(eventId) as {valuation_evidence_json:string}|undefined,
      valuationEvidence=valuation.status==="AVAILABLE"?{...valuation.evidence,poolId:bound!.poolId,poolKey:bound!.poolKey,observationBlock:bound!.observationBlock,observedAtMs:bound!.observedAtMs,receiptBlockNumber:receipt.blockNumber,receiptBlockHash:receipt.blockHash,totalReturnedUsd:usdMicrosToText(valuation.totalUsdMicros),principalFeeSplit:"EXACT_REMOVED_LIQUIDITY_AT_RECEIPT_BLOCK_PRICE",closeFeeAttribution,closeFeeValuation:closeFeeValuation?.status==="AVAILABLE"?closeFeeValuation.evidence:{status:"INCOMPLETE",reason:closeFeeAttribution.reason}}:{contract:"DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V1",reason:valuation.reason,rawEvidencePreserved:true,principalFeeSplit:"EXACT_REMOVED_LIQUIDITY_AT_RECEIPT_BLOCK_PRICE",closeFeeAttribution,closeFeeValuation:closeFeeValuation?.status==="AVAILABLE"?closeFeeValuation.evidence:{status:"INCOMPLETE",reason:closeFeeAttribution.reason}};
    if(!existing) input.repo.appendRealizedPnlEvent({
      eventId,
      eventKind: "CLOSE", protocol: "v4", strategyType: "V4_BID_LADDER",
      ladderIdentity: input.ladderId, workflowIdentity: input.ladderId, journalStage: "CLOSE_BATCH",
      transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      economicFinalAtMs: finalAtMs, capitalBasisUsd: usdMicrosToText(basisMicros),
      // CLOSE PnL remains event-local total returned value less immutable
      // deployed basis.  The fee field is a descriptive split of this same
      // contribution and must never be added to realized PnL again.
      newlyRealizedFeesUsd: closeFeeUsd,
      realizedPnlUsd: priced ? usdMicrosToText(returnedMicros! - basisMicros) : undefined,
      token0Raw: result.aggregateTransfers.token0 ?? undefined, token1Raw: result.aggregateTransfers.token1 ?? undefined,
      token0Decimals: bound?.token0Decimals??(fundingIndex===0?fundingDecimals:Number(parent.target_decimals ?? 18)),
      token1Decimals: bound?.token1Decimals??(fundingIndex===1?fundingDecimals:Number(parent.target_decimals ?? 18)),
      valuationStatus: priced ? "AVAILABLE" : "INCOMPLETE",
      valuationEvidence,
      closeReason, presentationMetadata: { pair, strategy: `V4 BID LADDER · ${state.legs.length} RANGES`, mode: parent.execution_mode, returnedValueUsd:returnedMicros===null?null:usdMicrosToText(returnedMicros), openedAt:opened.opened_at, openedAtSource:opened.opened_at?"OPEN_RECEIPT_BLOCK_TIMESTAMP":null },
    });
    else input.repo.repairCloseRealizedFeeAttribution({eventId,newlyRealizedFeesUsd:closeFeeUsd,valuationEvidence});
    const durableCloseEvent=input.repo.db.prepare("SELECT event_id,created_at_ms FROM realized_pnl_events WHERE event_id=? AND event_kind='CLOSE'").get(eventId) as {event_id:string;created_at_ms:number}|undefined,
      closeCardChatIdentity=process.env.FUNI_TELEGRAM_CHAT_ID?.trim();
    if(!durableCloseEvent)throw new Error("V4_BID_LADDER_CLOSE_REALIZED_EVENT_NOT_DURABLE");
    if(closeCardChatIdentity)input.repo.ensurePnlCardDelivery({
      deliveryId:`close:${durableCloseEvent.event_id}:${closeCardChatIdentity}`,
      cardKind:"CLOSE",
      economicEventId:durableCloseEvent.event_id,
      chatIdentity:closeCardChatIdentity,
      metadata:{automatic:true,eventPersistedAtMs:durableCloseEvent.created_at_ms},
    });
    atomicPostcondition = assertCanonicalClosePostcondition({
      repo: input.repo,
      ladderId: input.ladderId,
      receipt,
      revisionBefore: Number(parentBefore.revision),
      parentWasOpen: String(parentBefore.status) === "OPEN",
      mirrorWrites,
    });
  });
  canonicalEconomicProjectionCommit(input,"v4_bid_ladder_close_reconciliation_commit","CLOSE_BATCH",apply);
  for(const leg of expected)enqueueTargetedPositionReconciliation(input.repo,{positionId:`v4:${leg.tokenId}`,tokenId:leg.tokenId.toString(),protocol:'v4',reason:'ECONOMIC_CLOSE_RECEIPT_CONFIRMED',priority:1_000});
  return {
    ...result,
    canonicalMirror: { writes: mirrorWrites! },
    atomicPostcondition: atomicPostcondition!,
    perLegCloseAccounting: "UNAVAILABLE_FROM_AGGREGATE_TAKE_PAIR",
  };
}
function closeExpectedFromJournal(input: LadderLiveContext) {
  const state = rows(input.repo, input.ladderId),
    prepared = preparedFrom(
      journalRow(input.repo, input.ladderId, "CLOSE_BATCH"),
    );
  if (!prepared)
    throw new Error("V4_BID_LADDER_CLOSE_PREPARED_REQUEST_MISSING");
  const decoded = decodeV4BatchFullDecrease(prepared.request.data, {
    key: state.key,
    recipient: input.wallet,
  });
  return decoded.legs.map((action) => {
    const leg = state.legs.find(
      (row) => String(row.token_id) === action.tokenId.toString(),
    );
    if (!leg) throw new Error("V4_BID_LADDER_CLOSE_JOURNAL_TOKEN_MISMATCH");
    return {
      key: state.key,
      tokenId: action.tokenId,
      liquidity: action.liquidity,
      amount0Min: action.amount0Min,
      amount1Min: action.amount1Min,
      hookData: action.hookData,
      owner: input.wallet,
      tickLower: Number(leg.tick_lower),
      tickUpper: Number(leg.tick_upper),
    };
  });
}
export async function repairHistoricalV4BidLadderCloseFees(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;limit?:number}){
  const limit=input.limit??64;if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw new Error("V4_BID_LADDER_CLOSE_FEE_REPAIR_LIMIT_INVALID");
  const candidates=input.repo.db.prepare(`SELECT journal.*,event.event_id close_event_id,event.valuation_evidence_json close_event_evidence,event.realized_pnl_usd close_realized_pnl_usd,event.token0_raw close_token0_raw,event.token1_raw close_token1_raw
    FROM realized_pnl_events event
    JOIN chain_transaction_journal journal ON journal.chain_id=? AND journal.workflow_identity=event.workflow_identity AND journal.semantic_stage='CLOSE_BATCH' AND lower(journal.expected_hash)=lower(event.transaction_hash)
    WHERE event.event_kind='CLOSE' AND event.protocol='v4' AND event.strategy_type='V4_BID_LADDER' AND event.newly_realized_fees_usd IS NULL
    ORDER BY event.economic_final_at_ms,event.event_id LIMIT ?`).all(CHAIN_ID,limit) as Record<string,unknown>[],results:Array<Record<string,unknown>>=[];
  let changed=0,available=0,incomplete=0;
  for(const candidate of candidates){
    const ladderId=String(candidate.workflow_identity),receipt=confirmedReceipt(candidate),wallet=getAddress(String(candidate.wallet_address));
    if(!receipt){results.push({ladderId,eventId:String(candidate.close_event_id),status:"INCOMPLETE",reason:"INCOMPLETE_CONFIRMED_RECEIPT_UNAVAILABLE",changed:0});incomplete++;continue;}
    try{
      const context={repo:input.repo,rpc:input.rpc,ladderId,wallet} as LadderLiveContext,state=rows(input.repo,ladderId),expected=closeExpectedFromJournal(context),reconciled=await reconcileV4BatchFullDecreaseReceipt({receipt:receiptShape(receipt),expectedLegs:expected,recipient:wallet,inspectPosition:async id=>{const leg=expected.find(value=>value.tokenId===id);if(!leg)throw new Error("V4_BID_LADDER_CLOSE_TOKEN_MISMATCH");return {...leg,tokenId:id,liquidity:0n};}});
      if(reconciled.aggregateTransfers.token0===null||reconciled.aggregateTransfers.token1===null)throw new Error("REALIZED_PNL_CLOSE_TRANSFER_EVIDENCE_UNAVAILABLE");
      if(String(candidate.close_token0_raw)!==reconciled.aggregateTransfers.token0.toString()||String(candidate.close_token1_raw)!==reconciled.aggregateTransfers.token1.toString())throw new Error("V4_BID_LADDER_CLOSE_FEE_REPAIR_RETURNED_RAW_CONFLICT");
      const attribution=await captureCloseFeeAttribution(context,state,receipt,expected,{token0:reconciled.aggregateTransfers.token0,token1:reconciled.aggregateTransfers.token1}),valuation=attribution.status==="AVAILABLE"&&attribution.sqrtPriceX96!==null&&attribution.tick!==null&&attribution.activeLiquidity!==null&&attribution.initialized!==null&&attribution.closeFee0Raw!==null&&attribution.closeFee1Raw!==null?valueV4ReturnsFromSqrtPriceX96({token0:state.key.currency0,token1:state.key.currency1,decimals0:attribution.token0Decimals,decimals1:attribution.token1Decimals,amount0:BigInt(attribution.closeFee0Raw),amount1:BigInt(attribution.closeFee1Raw),sqrtPriceX96:BigInt(attribution.sqrtPriceX96),source:{poolId:attribution.poolId,poolKey:attribution.poolKey,sqrtPriceX96:BigInt(attribution.sqrtPriceX96),tick:attribution.tick,activeLiquidity:BigInt(attribution.activeLiquidity),initialized:attribution.initialized,blockNumber:BigInt(attribution.observationBlock),token0Decimals:attribution.token0Decimals,token1Decimals:attribution.token1Decimals}}):null,feeUsd=valuation?.status==="AVAILABLE"?usdMicrosToText(valuation.totalUsdMicros):undefined;
      let prior:Record<string,unknown>={};try{prior=JSON.parse(String(candidate.close_event_evidence??"{}"));}catch{}
      const repaired=input.repo.repairCloseRealizedFeeAttribution({eventId:String(candidate.close_event_id),newlyRealizedFeesUsd:feeUsd,valuationEvidence:{...prior,principalFeeSplit:"EXACT_REMOVED_LIQUIDITY_AT_RECEIPT_BLOCK_PRICE",closeFeeAttribution:attribution,closeFeeValuation:valuation?.status==="AVAILABLE"?valuation.evidence:{status:"INCOMPLETE",reason:attribution.reason??(valuation?.status==="INCOMPLETE"?valuation.reason:"DIRECT_USDG_PAIR_PRICE_UNAVAILABLE")}}});
      changed+=repaired.changed;if(feeUsd===undefined)incomplete++;else available++;
      results.push({ladderId,eventId:String(candidate.close_event_id),transactionHash:String(candidate.expected_hash),status:feeUsd===undefined?"INCOMPLETE":"AVAILABLE",reason:feeUsd===undefined?attribution.reason:undefined,newlyRealizedFeesUsd:feeUsd,realizedPnlUsdPreserved:String(candidate.close_realized_pnl_usd??""),changed:repaired.changed,attribution});
    }catch(error){incomplete++;results.push({ladderId,eventId:String(candidate.close_event_id),transactionHash:String(candidate.expected_hash),status:"INCOMPLETE",reason:error instanceof Error?error.message:String(error),changed:0});}
  }
  return {scanned:candidates.length,available,incomplete,changed,signingAttempts:0 as const,broadcasts:0 as const,mainnetTransactionsSent:0 as const,results};
}
export async function executeV4BidLadderManualClose(
  input: LadderLiveContext & {
    walletClient: WalletClient;
    closeReason?: "NORMAL_OPERATOR_CLOSE" | "USDG_RESET_REPOSITION";
    manualRepositionAuthorization?: string;
  },
) {
  const closeReason = input.closeReason ?? "NORMAL_OPERATOR_CLOSE";
  if (closeReason === "USDG_RESET_REPOSITION") {
    const reset = input.repo.loadBidLadderUsdReset(input.ladderId);
    if (
      !reset ||
      (String(reset.phase) === "WATCHING"
        ? !isManualRepositionAuthorization(input.manualRepositionAuthorization)
        : !isManualRepositionAuthorization(reset.close_workflow_identity))
    )
      throw new Error("REPOSITION_MANUAL_AUTHORIZATION_REQUIRED");
  }
  const prior = journalRow(input.repo, input.ladderId, "CLOSE_BATCH"),
    priorReceipt = confirmedReceipt(prior ?? {});
  if (priorReceipt) {
    const inline=await inlineCanonicalBidLadderReceipt(input,"CLOSE_BATCH",priorReceipt);
    return {
      status: "CLOSED" as const,
      hash: priorReceipt.transactionHash,
      reconciliation: (inline.reconciliation as V4BidLadderManualCloseReconciliation | undefined) ?? pendingCloseReconciliation(),
      reconciliationPending:inline.reconciliationPending,
      durableHandoff:inline.durableHandoff,
      continuationStatus:inline.continuationStatus,
      mainnetTransactionsSent: 0,
    };
  }
  let recoveredRevert = false;
  const unresolved =
    prior && ["PREPARED", "SUBMITTED"].includes(String(prior.status))
      ? preparedFrom(prior)
      : undefined;
  if (unresolved) {
    try {
      return await postBroadcastSqliteBoundary(
        input,
        "CLOSE_BATCH",
        async () => {
          const recovered = await submit({
            ...input,
            stage: "CLOSE_BATCH",
            to: unresolved.request.to,
            data: unresolved.request.data,
            estimatedGas: unresolved.request.gas,
            batchBinding: "close",
            closeReason,
            manualRepositionAuthorization: input.manualRepositionAuthorization,
          });
          const inline=await inlineCanonicalBidLadderReceipt(input,"CLOSE_BATCH",recovered.receipt,{timing:recovered.timing});
          return {
            status: "CLOSED" as const,
            hash: recovered.hash,
            reconciliation: (inline.reconciliation as V4BidLadderManualCloseReconciliation | undefined) ?? pendingCloseReconciliation(),
            reconciliationPending:inline.reconciliationPending,
            durableHandoff:inline.durableHandoff,
            continuationStatus:inline.continuationStatus,
            mainnetTransactionsSent: recovered.recovered ? 0 : 1,
          };
        },
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "CLOSE_BATCH_REVERTED")
        throw error;
      recoveredRevert = true;
    }
  }
  const preview = await closeState(input);
  if (preview.blockers.length)
    throw new Error(
      `V4_BID_LADDER_CLOSE_BLOCKED:${preview.blockers.join(",")}`,
    );
  if (recoveredRevert && preview.active.length)
    throw new Error("CLOSE_BATCH_REVERTED");
  if (!preview.active.length) {
    let writes: ReturnType<typeof closeCanonicalMirrors>;
    const apply = input.repo.db.transaction(() => {
      writes = closeCanonicalMirrors(
        input.repo,
        rows(input.repo, input.ladderId),
      );
      const reset = input.repo.loadBidLadderUsdReset(input.ladderId);
      if (
        reset &&
        closeReason === "NORMAL_OPERATOR_CLOSE" &&
        ["OPEN_PENDING", "WATCHING"].includes(String(reset.phase))
      )
        input.repo.transitionBidLadderUsdReset({
          ladderId: input.ladderId,
          from: ["OPEN_PENDING", "WATCHING"],
          to: "OPERATOR_CLOSED",
          closeReason,
          closeWorkflowIdentity: input.ladderId,
        });
    });
    apply();
    return {
      status: "CLOSED" as const,
      hash: null,
      reconciliation: {
        aggregateTransfers: undefined,
        canonicalMirror: { writes: writes! },
        atomicPostcondition: undefined,
        perLegCloseAccounting: "UNAVAILABLE_FROM_AGGREGATE_TAKE_PAIR",
      },
      mainnetTransactionsSent: 0,
    };
  }
  const plan = preview.plan,
    estimatedGas = preview.estimatedGas;
  if (!plan) throw new Error("V4_BID_LADDER_CLOSE_PLAN_REQUIRED_FOR_ACTIVE_LEGS");
  if (estimatedGas === null)
    throw new Error("V4_BID_LADDER_CLOSE_ESTIMATE_REQUIRED");
  return postBroadcastSqliteBoundary(input, "CLOSE_BATCH", async () => {
    const sent = await submit({
        ...input,
        stage: "CLOSE_BATCH",
        to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
        data: plan.calldata,
        estimatedGas,
        batchBinding: "close",
        closeValuation: preview.closeValuation,
        closeReason,
        manualRepositionAuthorization: input.manualRepositionAuthorization,
      }),inline=await inlineCanonicalBidLadderReceipt(input,"CLOSE_BATCH",sent.receipt,{timing:sent.timing});
    return {
      status: "CLOSED" as const,
      hash: sent.hash,
      reconciliation: (inline.reconciliation as V4BidLadderManualCloseReconciliation | undefined) ?? pendingCloseReconciliation(),
      reconciliationPending:inline.reconciliationPending,
      durableHandoff:inline.durableHandoff,
      continuationStatus:inline.continuationStatus,
      mainnetTransactionsSent: sent.recovered ? 0 : 1,
    };
  });
}

export function formatV4BidLadderLivePreview(
  preview: Awaited<ReturnType<typeof previewV4BidLadderLive>>,
  options: { poolLiquidityLine?: string } = {},
) {
  const p = preview.state.parent,
    evidence = preview.marketCapEvidence,
    currentMarketCap = positive(evidence?.marketCapUsd)
      ? compactUsd(evidence.marketCapUsd)
      : "Unavailable",
    marketCapRange = estimateV4BidLadderMarketCapRange({
      parent: p,
      legs: preview.state.legs,
      target: preview.marketCapTokens.target,
      funding: preview.marketCapTokens.funding,
      evidence,
    }),
    difference =
      preview.priceGuard?.deviationBps === null ||
      preview.priceGuard?.deviationBps === undefined
        ? "unavailable"
        : `${Number(preview.priceGuard.deviationBps) / 100}%`,
    priceSafety = preview.priceGuard?.status === "PASS" ? "PASS" : "BLOCK",
    maxDownsideBps = Math.max(
      ...preview.state.legs.map((leg) => Number(leg.lower_drop_bps)),
    ),
    alignedLegs = preview.state.legs.map(
      (leg, index) =>
        `#${index + 1} -${Number(leg.upper_drop_bps) / 100}% → -${Number(leg.lower_drop_bps) / 100}% · ticks ${leg.tick_lower} / ${leg.tick_upper} · ${displayAmount(BigInt(String(leg.funding_amount_raw)), preview.marketCapTokens.funding.decimals)} ${preview.marketCapTokens.funding.symbol}`,
    );
  return [
    "V4 BID Ladder V1 · LIVE PREVIEW",
    `Status: ${preview.blockers.length ? "BLOCKED" : "READY"}`,
    "",
    "Market",
    `Current MC: ${currentMarketCap}`,
    `Targeted MC range: ${marketCapRange ? `${compactUsd(marketCapRange.startUsd)} → ${compactUsd(marketCapRange.deepestUsd)}` : "Unavailable"}`,
    `Pool Price: ${preview.priceGuard?.poolPriceFundingPerTarget ?? preview.poolPrice}`,
    `GMGN Price: ${preview.priceGuard?.tokenPriceFundingPerTarget ?? "TOKEN_PRICE_REFERENCE_UNAVAILABLE"}`,
    `Difference: ${difference} · ${priceSafety}`,
    options.poolLiquidityLine ?? "Pool liquidity: Unavailable",
    "",
    "Ladder",
    `Max downside: ${maxDownsideBps / 100}%`,
    ...alignedLegs,
    "",
    "Capital",
    `Funding: ${displayAmount(BigInt(String(p.total_funding_amount_raw)), preview.marketCapTokens.funding.decimals)} ${preview.marketCapTokens.funding.symbol}`,
    `Wallet balance: ${displayAmount(preview.balance, preview.marketCapTokens.funding.decimals)} ${preview.marketCapTokens.funding.symbol}`,
    `ERC20 approval: ${preview.approval.erc20Required ? "required" : "sufficient"}`,
    `Permit2 approval: ${preview.approval.permit2Required ? "required" : "sufficient"}`,
    "",
    "Execution",
    `Estimated batch gas: ${preview.estimatedGas ?? "pending approvals"}`,
    ...(preview.gasProjection ? [
      `Estimated execution: ${gasUsdText(preview.gasProjection.estimatedExecutionUsd)}`,
      `Maximum projected fee: ${gasUsdText(preview.gasProjection.maximumProjectedFeeUsd)}`,
      `Safety cap: $${preview.gasProjection.capUsd.toFixed(2)}`,
      `Gas limit: ${preview.gasProjection.signedGasLimit}`,
      `Gas price: ${(Number(preview.gasProjection.gasPrice)/1e9).toFixed(3)} gwei`,
    ] : ["Gas projection: unavailable"]),
    `Transactions: ${preview.transactionCount}`,
    "5 LP positions will be minted atomically.",
    "Manual reposition: USDG reset · explicit confirmation · same depth · no swap",
    "",
    `Ladder: ${p.ladder_id}`,
    `Pool: ${p.pool_id}`,
    `Reference/current tick: ${p.reference_tick} / ${preview.pool.tick}`,
    preview.blockers.length
      ? `BLOCKED: ${preview.blockers.join(", ")}`
      : "Ready for explicit confirmation.",
  ].join("\n");
}
export function formatV4BidLadderClosePreview(
  preview: Awaited<ReturnType<typeof previewV4BidLadderClose>>,
) {
  return [
    "V4 BID Ladder V1",
    "MANUAL CLOSE",
    `Ladder: ${preview.state.parent.ladder_id}`,
    `Active legs: ${preview.active.length}`,
    `TokenIds: ${preview.inspected.map((x) => x.tokenId).join(", ")}`,
    `Liquidity: ${preview.inspected.map((x) => x.liquidity).join(", ")}`,
    `Theoretical composition by NFT: ${preview.composition.map((x) => `${x.tokenId}=${x.token0}/${x.token1}`).join(", ")}`,
    `Estimated aggregate token0/token1: ${preview.aggregateExpected.token0}/${preview.aggregateExpected.token1}`,
    `Estimated gas: ${preview.estimatedGas ?? 0n}`,
    "NO SWAP WILL BE PERFORMED",
    "NO NFT WILL BE BURNED",
    "ALL RESULTING ASSETS REMAIN IN WALLET",
    preview.blockers.length
      ? `BLOCKED: ${preview.blockers.join(", ")}`
      : "Ready for explicit confirmation.",
  ].join("\n");
}

export function formatV4BidLadderCollectPreview(
  preview: Awaited<ReturnType<typeof previewV4BidLadderCollect>>,
) {
  const p = preview.state.parent,
    fundingIndex = Number(p.funding_index) as 0 | 1,
    usdg =
      fundingIndex === 0
        ? { amount: preview.fees.token0, token: preview.token0 }
        : { amount: preview.fees.token1, token: preview.token1 },
    target =
      fundingIndex === 0
        ? { amount: preview.fees.token1, token: preview.token1 }
        : { amount: preview.fees.token0, token: preview.token0 };
  return [
    "V4 BID Ladder · CLAIM FEES",
    `Ladder: ${p.ladder_id}`,
    `NFTs: ${preview.inspected.map((value) => value.tokenId).join(", ")}`,
    "",
    preview.plan ? "Claimable:" : "NO CLAIMABLE FEES",
    `USDG: ${displayAmount(usdg.amount, usdg.token.decimals)} ${usdg.token.symbol}`,
    `TOKEN: ${displayAmount(target.amount, target.token.decimals)} ${target.token.symbol}`,
    `Estimated USD value: ${preview.estimatedUsd === null ? "Unavailable" : compactUsd(preview.estimatedUsd)}`,
    `Estimated gas: ${preview.estimatedGas ?? 0n}`,
    "",
    "NO LIQUIDITY WILL BE REMOVED",
    "NO SWAP WILL BE PERFORMED",
    "NO NFT WILL BE BURNED",
    "ALL CLAIMED FEES REMAIN IN WALLET",
    preview.blockers.length
      ? `BLOCKED: ${preview.blockers.join(",")}`
      : preview.plan
        ? "Ready for explicit confirmation."
        : "No transaction will be signed or broadcast.",
  ].join("\n");
}
