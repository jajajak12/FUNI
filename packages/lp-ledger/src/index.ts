import Database from "better-sqlite3";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
export type TokenAmounts = { token0: bigint; token1: bigint };

/** Canonical telemetry encoding: stable object keys and lossless decimal BigInts. */
export function deterministicTelemetryJson(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const normalize = (item: unknown): unknown => {
      if (typeof item === "bigint") return item.toString(10);
      if (item === null || typeof item !== "object") return item;
      if (seen.has(item)) throw new TypeError("CIRCULAR_TELEMETRY_CONTEXT");
      seen.add(item);
      if (Array.isArray(item)) return item.map(normalize);
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort())
        output[key] = normalize((item as Record<string, unknown>)[key]);
      return output;
    };
    return JSON.stringify(normalize(value ?? {}));
  } catch (error) {
    return JSON.stringify({
      telemetry_context_error:
        error instanceof Error ? error.message : "UNSERIALIZABLE_CONTEXT",
    });
  }
}
export type PricePoint = {
  token0Usd?: number;
  token1Usd?: number;
  token0Decimals: number;
  token1Decimals: number;
  blockNumber: bigint;
  source: string;
  confidence: "verified" | "derived" | "partial";
  observedAt: string;
};
export type LedgerEvent = {
  id: string;
  positionId: string;
  txHash: string;
  logIndex: number;
  kind:
    | "mint"
    | "increase"
    | "decrease"
    | "collect"
    | "swap"
    | "gas"
    | "manual-correction"
    | "close";
  amounts?: TokenAmounts;
  price?: PricePoint;
  gasUsd?: number;
  executionCostUsd?: number;
  reason?: string;
  timestamp: string;
};
export type CollectionAllocation = {
  eventId: string;
  principal: TokenAmounts;
  fees: TokenAmounts;
};
export type PositionLedger = {
  deposits: TokenAmounts;
  pendingPrincipal: TokenAmounts;
  withdrawnPrincipal: TokenAmounts;
  claimedFees: TokenAmounts;
  unclaimedFees: TokenAmounts;
  gasUsd: number;
  executionCostsUsd: number;
  events: LedgerEvent[];
  allocations: CollectionAllocation[];
};
const zero = (): TokenAmounts => ({ token0: 0n, token1: 0n });
const add = (a: TokenAmounts, b: TokenAmounts): TokenAmounts => ({
  token0: a.token0 + b.token0,
  token1: a.token1 + b.token1,
});
const take = (available: bigint, amount: bigint): [bigint, bigint] => {
  const principal = available < amount ? available : amount;
  return [principal, amount - principal];
};
export class Ledger {
  private seen = new Set<string>();
  private positions = new Map<string, PositionLedger>();
  state(positionId: string): PositionLedger {
    let p = this.positions.get(positionId);
    if (!p) {
      p = {
        deposits: zero(),
        pendingPrincipal: zero(),
        withdrawnPrincipal: zero(),
        claimedFees: zero(),
        unclaimedFees: zero(),
        gasUsd: 0,
        executionCostsUsd: 0,
        events: [],
        allocations: [],
      };
      this.positions.set(positionId, p);
    }
    return p;
  }
  ingest(e: LedgerEvent): boolean {
    const key = `${e.txHash}:${e.logIndex}`;
    if (this.seen.has(key)) return false;
    if (e.kind === "manual-correction" && !e.reason)
      throw new Error("manual correction requires an audit reason");
    this.seen.add(key);
    const p = this.state(e.positionId),
      a = e.amounts ?? zero();
    p.events.push(e);
    switch (e.kind) {
      case "mint":
      case "increase":
        p.deposits = add(p.deposits, a);
        break;
      case "decrease":
        p.pendingPrincipal = add(p.pendingPrincipal, a);
        break;
      case "collect": {
        const [p0, f0] = take(p.pendingPrincipal.token0, a.token0),
          [p1, f1] = take(p.pendingPrincipal.token1, a.token1);
        const principal = { token0: p0, token1: p1 },
          fees = { token0: f0, token1: f1 };
        p.pendingPrincipal = {
          token0: p.pendingPrincipal.token0 - p0,
          token1: p.pendingPrincipal.token1 - p1,
        };
        p.withdrawnPrincipal = add(p.withdrawnPrincipal, principal);
        p.claimedFees = add(p.claimedFees, fees);
        p.allocations.push({ eventId: e.id, principal, fees });
        break;
      }
      case "gas":
        p.gasUsd += e.gasUsd ?? 0;
        break;
      case "swap":
        p.executionCostsUsd += e.executionCostUsd ?? 0;
        break;
      case "close":
        break;
    }
    return true;
  }
  setUnclaimedFees(positionId: string, fees: TokenAmounts): void {
    if (fees.token0 < 0n || fees.token1 < 0n)
      throw new Error("fees cannot be negative");
    this.state(positionId).unclaimedFees = fees;
  }
}
export type Pnl = {
  currentLiquidityValue: number;
  unclaimedFeeValue: number;
  claimedFeeMtmValue: number;
  withdrawnPrincipalMtmValue: number;
  totalStrategyMtmValue: number;
  depositedValue: number;
  grossPnl: number;
  grossPnlPct: number;
  netPnl: number;
  holdValue: number;
  holdPnl: number;
  lpVsHold: number;
  realizedValue: number;
  label: "mark-to-market";
};
function value(a: TokenAmounts, p: PricePoint): number {
  if (p.token0Usd === undefined || p.token1Usd === undefined)
    throw new Error("required token price unavailable");
  return (
    (Number(a.token0) / 10 ** p.token0Decimals) * p.token0Usd +
    (Number(a.token1) / 10 ** p.token1Decimals) * p.token1Usd
  );
}
/** Raw token amounts are valued using the matching persisted token decimals. */
export function markToMarket(
  p: PositionLedger,
  currentLiquidity: TokenAmounts,
  current: PricePoint,
  depositValue: number,
  originalDeposit: TokenAmounts,
): Pnl {
  const currentLiquidityValue = value(currentLiquidity, current),
    unclaimedFeeValue = value(p.unclaimedFees, current),
    claimedFeeMtmValue = value(p.claimedFees, current),
    withdrawnPrincipalMtmValue = value(p.withdrawnPrincipal, current),
    totalStrategyMtmValue =
      currentLiquidityValue +
      unclaimedFeeValue +
      claimedFeeMtmValue +
      withdrawnPrincipalMtmValue,
    grossPnl = totalStrategyMtmValue - depositValue,
    holdValue = value(originalDeposit, current);
  return {
    currentLiquidityValue,
    unclaimedFeeValue,
    claimedFeeMtmValue,
    withdrawnPrincipalMtmValue,
    totalStrategyMtmValue,
    depositedValue: depositValue,
    grossPnl,
    grossPnlPct: depositValue === 0 ? 0 : (grossPnl / depositValue) * 100,
    netPnl: grossPnl - p.gasUsd - p.executionCostsUsd,
    holdValue,
    holdPnl: holdValue - depositValue,
    lpVsHold: totalStrategyMtmValue - holdValue,
    realizedValue: withdrawnPrincipalMtmValue,
    label: "mark-to-market",
  };
}

export type OneSidedPnlInput = {
  currentLiquidity: TokenAmounts;
  current: PricePoint;
  initialFunding: bigint;
  fundingIndex: 0 | 1;
  initialFundingExecutionValue: number;
  realizedProceedsValue?: number;
  soldAssetValue?: number;
  targetAccumulatedRaw?: bigint;
  fundingRemainingRaw?: bigint;
  targetDecimals?: number;
  fundingDecimals?: number;
  targetPriceInFunding?: number;
  gasCosts?: number;
  executionCosts?: number;
};
export type OneSidedPnl = Pnl & {
  benchmarkAssetIndex: 0 | 1;
  fundingConversionPct: number;
  targetAccumulatedRaw: bigint;
  fundingRemainingRaw: bigint;
  averageTargetAcquisitionPrice?: number;
  effectiveAcquisitionPrice?: number;
  breakEvenTargetPrice?: number;
};
/** Generic token-level one-sided accounting.  Its benchmark is explicitly the
 * original funding asset, never the old balanced HODL basket. */
export function oneSidedMarkToMarket(
  p: PositionLedger,
  input: OneSidedPnlInput,
): OneSidedPnl {
  const liquidity = value(input.currentLiquidity, input.current),
    unclaimed = value(p.unclaimedFees, input.current),
    claimed = value(p.claimedFees, input.current),
    withdrawn = value(p.withdrawnPrincipal, input.current);
  const realized = input.realizedProceedsValue ?? 0,
    sold = input.soldAssetValue ?? 0,
    total = liquidity + unclaimed + claimed + withdrawn + realized - sold;
  const deposited = input.initialFundingExecutionValue,
    gross = total - deposited;
  const fundingUsd =
    input.fundingIndex === 0
      ? input.current.token0Usd
      : input.current.token1Usd;
  const fundingDecimals =
    input.fundingDecimals ??
    (input.fundingIndex === 0
      ? input.current.token0Decimals
      : input.current.token1Decimals);
  const holdValue =
    fundingUsd === undefined
      ? NaN
      : (Number(input.initialFunding) / 10 ** fundingDecimals) * fundingUsd;
  const fundingRemaining =
    input.fundingRemainingRaw ??
    (input.fundingIndex === 0
      ? input.currentLiquidity.token0
      : input.currentLiquidity.token1);
  const targetAccumulated =
    input.targetAccumulatedRaw ??
    (input.fundingIndex === 0
      ? input.currentLiquidity.token1
      : input.currentLiquidity.token0);
  const converted =
    input.initialFunding === 0n
      ? 0
      : (Number(input.initialFunding - fundingRemaining) /
          Number(input.initialFunding)) *
        100;
  const targetDecimals =
    input.targetDecimals ??
    (input.fundingIndex === 0
      ? input.current.token1Decimals
      : input.current.token0Decimals);
  const fundingUnits = Number(input.initialFunding) / 10 ** fundingDecimals,
    targetUnits = Number(targetAccumulated) / 10 ** targetDecimals;
  const average =
    targetUnits > 0 && input.targetPriceInFunding !== undefined
      ? (fundingUnits - Number(fundingRemaining) / 10 ** fundingDecimals) /
        targetUnits
      : undefined;
  const costs =
      (input.gasCosts ?? p.gasUsd) +
      (input.executionCosts ?? p.executionCostsUsd),
    effective =
      average === undefined ? undefined : average + costs / (targetUnits || 1);
  const targetUsd =
    input.fundingIndex === 0
      ? input.current.token1Usd
      : input.current.token0Usd;
  const breakEven =
    targetUnits > 0 && targetUsd !== undefined && fundingUsd !== undefined
      ? (deposited + costs - (total - targetUnits * targetUsd)) /
        (targetUnits * (fundingUsd || 1))
      : undefined;
  return {
    currentLiquidityValue: liquidity,
    unclaimedFeeValue: unclaimed,
    claimedFeeMtmValue: claimed,
    withdrawnPrincipalMtmValue: withdrawn,
    totalStrategyMtmValue: total,
    depositedValue: deposited,
    grossPnl: gross,
    grossPnlPct: deposited === 0 ? 0 : (gross / deposited) * 100,
    netPnl: gross - costs,
    holdValue,
    holdPnl: holdValue - deposited,
    lpVsHold: total - holdValue,
    realizedValue: withdrawn + realized,
    label: "mark-to-market",
    benchmarkAssetIndex: input.fundingIndex,
    fundingConversionPct: Math.max(0, Math.min(100, converted)),
    targetAccumulatedRaw: targetAccumulated,
    fundingRemainingRaw: fundingRemaining,
    averageTargetAcquisitionPrice: average,
    effectiveAcquisitionPrice: effective,
    breakEvenTargetPrice: breakEven,
  };
}

export type MigrationStatus = { applied: string[]; pending: string[] };
export type V4RegistryPoolRecord = {
  poolId: string;
  currency0: string;
  currency1: string;
  initializeFeeRaw: number;
  tickSpacing: number;
  hooks: string;
  initializationBlock: bigint;
  initializationTxHash?: string;
  initializationTxIndex?: number | null;
  initializationLogIndex?: number | null;
  dynamicFee: boolean;
  staticFeePips: number | null;
  hookClassification: string;
};
export type V4BidLadderPersistenceLeg = {
  legIndex: 0 | 1 | 2 | 3 | 4;
  upperDropBps: number;
  lowerDropBps: number;
  weightBps: number;
  tickLower: number;
  tickUpper: number;
  fundingAmount: bigint;
  plannedLiquidity: bigint;
  fundingIndex: 0 | 1;
  targetIndex: 0 | 1;
};
export type V4BidLadderPersistencePlan = {
  ladderId: string;
  strategyVersion: "V4_BID_LADDER_V1";
  executionMode: "DRY_RUN" | "LIVE";
  pool: {
    id: string;
    key: {
      currency0: string;
      currency1: string;
      fee: number;
      tickSpacing: number;
      hooks: string;
    };
    tick: number;
    blockNumber: bigint;
  };
  fundingToken: string;
  targetToken: string;
  fundingSymbol?: string;
  targetSymbol?: string;
  symbolProvenance?: unknown;
  fundingIndex: 0 | 1;
  targetIndex: 0 | 1;
  referenceBlockHash?: string;
  totalFundingAmount: bigint;
  entryUsdSnapshot?: number;
  createdAtMs: number;
  legs: readonly V4BidLadderPersistenceLeg[];
};
export const V4_BID_LADDER_USDG_RESET_POLICY =
  "USDG_RESET_REPOSITION_V1" as const;
export type V4BidLadderUsdResetPhase =
  | "OPEN_PENDING"
  | "WATCHING"
  | "CLOSE_PREPARED"
  | "CLOSE_SUBMITTED"
  | "CLOSE_CONFIRMED"
  | "PRINCIPAL_RECONCILED"
  | "REOPEN_PLANNED"
  | "REOPEN_PREPARED"
  | "REOPEN_SUBMITTED"
  | "COMPLETED"
  | "BLOCKED"
  | "OPERATOR_CLOSED";
export type V4BidLadderUsdResetCreation = {
  rootLadderId: string;
  previousLadderId?: string;
  generation: number;
  creationReason: "INITIAL_OPEN" | "USDG_RESET_REPOSITION";
};
export const nowMs = () => Date.now();
export const computeExpiresAt = (now: number, ttlMs: number) => {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0)
    throw new Error("invalid session clock or TTL");
  return now + ttlMs;
};
export const isExpired = (expiresAtMs: number, now: number) =>
  expiresAtMs <= now;
export type TelegramFlowStatus =
  "active" | "expired" | "cancelled" | "completed" | "superseded";
export type TelegramFlowSession = {
  sessionId: string;
  userId: string;
  chatId: string;
  state: Record<string, unknown>;
  status: TelegramFlowStatus;
  flowRevision: number;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
};
export type TelegramFlowCASResult = {
  result: "APPLIED" | "REVISION_CONFLICT" | "STATUS_CONFLICT" | "NOT_FOUND";
  expectedRevision: number;
  observedRevision?: number;
  resultingRevision?: number;
  previousKind?: string;
  requestedNextKind?: string;
  flow?: TelegramFlowSession;
};
export type DatabasePaths = {
  dataDir: string;
  databasePath: string;
  backupDir: string;
};
const DIRECTORY_MODE = 0o700,
  FILE_MODE = 0o600;
export const SQLITE_DEFAULT_BUSY_TIMEOUT_MS = 10_000;
export const SQLITE_RUNTIME_BUSY_TIMEOUT_MS = 250;
export const SQLITE_TRANSIENT_RETRY_BUDGET_MS = 1_500;
export const ECONOMIC_FOREGROUND_RETRY_BUDGET_MS = 3_000;
export const ECONOMIC_FOREGROUND_MARKER_TTL_MS = 5_000;
const ECONOMIC_FOREGROUND_MARKER_VERSION = 1,
  ECONOMIC_FOREGROUND_MARKER_LIMIT = 128,
  ECONOMIC_FOREGROUND_MARKER_NAME = /^fg-(\d+)-([0-9a-f-]{36})\.json$/,
  ECONOMIC_FOREGROUND_TEMP_NAME = /^\.fg-(\d+)-([0-9a-f-]{36})\.tmp$/;
export type EconomicForegroundTelemetry = {
  process: string;
  component: string;
  operation: string;
  persistenceClass: "foreground" | "background";
  workflow?: string;
  semanticStage?: string;
  economicDemandPresent: boolean;
  priorityAcquisitionLatencyMs: number;
  waitYieldDurationMs: number;
  writerWindowDurationMs: number;
  rowChangeCount: number | null;
  retryCount: number;
  outcome: "SUCCEEDED" | "FAILED" | "DEFERRED";
};
type EconomicForegroundMarker = {
  version: 1;
  databaseIdentity: string;
  ownerId: string;
  processId: number;
  component: string;
  operation: string;
  workflow?: string;
  semanticStage?: string;
  createdAtMs: number;
  expiresAtMs: number;
  monotonicStartedNs: string;
};
export type EconomicForegroundDemandInspection = {
  demandPresent: boolean;
  liveOwnerCount: number;
  nextExpiryAtMs: number | null;
  staleOwnerCount: number;
};
export class EconomicForegroundDemandActiveError extends Error {
  constructor(public readonly databasePath: string) {
    super("ECONOMIC_FOREGROUND_DEMAND_ACTIVE");
    this.name = "EconomicForegroundDemandActiveError";
  }
}
const economicForegroundScopes = new Map<
  string,
  { depth: number; release: () => void }
>();
const economicForegroundDatabaseIdentity = (databasePath: string) =>
  createHash("sha256").update(resolve(databasePath)).digest("hex").slice(0, 24);
export const economicForegroundMarkerDirectory = (databasePath: string) =>
  join(
    dirname(resolve(databasePath)),
    ".sqlite-economic-foreground",
    economicForegroundDatabaseIdentity(databasePath),
  );
function validEconomicForegroundMarker(
  value: unknown,
  databaseIdentity: string,
): value is EconomicForegroundMarker {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<EconomicForegroundMarker>;
  return (
    row.version === ECONOMIC_FOREGROUND_MARKER_VERSION &&
    row.databaseIdentity === databaseIdentity &&
    typeof row.ownerId === "string" &&
    row.ownerId.length > 0 &&
    row.ownerId.length <= 160 &&
    Number.isSafeInteger(row.processId) &&
    typeof row.component === "string" &&
    Number.isFinite(row.createdAtMs) &&
    Number.isFinite(row.expiresAtMs) &&
    row.expiresAtMs! > row.createdAtMs! &&
    row.expiresAtMs! - row.createdAtMs! <= 10_000 &&
    typeof row.monotonicStartedNs === "string" &&
    /^\d+$/.test(row.monotonicStartedNs)
  );
}
function economicForegroundMarkerRows(databasePath: string, nowMs: number) {
  const directory = economicForegroundMarkerDirectory(databasePath),
    databaseIdentity = economicForegroundDatabaseIdentity(databasePath),
    rows: Array<{
      path: string;
      marker?: EconomicForegroundMarker;
      live: boolean;
    }> = [];
  let names: string[];
  try {
    names = readdirSync(directory).slice(0, ECONOMIC_FOREGROUND_MARKER_LIMIT);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return rows;
    throw error;
  }
  for (const name of names) {
    if (!ECONOMIC_FOREGROUND_MARKER_NAME.test(name)) continue;
    const path = join(directory, name);
    try {
      const raw = readFileSync(path, "utf8");
      if (raw.length > 4096) {
        rows.push({ path, live: false });
        continue;
      }
      const marker = JSON.parse(raw) as unknown;
      if (!validEconomicForegroundMarker(marker, databaseIdentity)) {
        rows.push({ path, live: false });
        continue;
      }
      rows.push({ path, marker, live: marker.expiresAtMs > nowMs });
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT")
        rows.push({ path, live: false });
    }
  }
  return rows;
}
/** Read-only, bounded cross-process foreground-demand inspection. */
export function inspectEconomicForegroundDemand(
  databasePath: string,
  nowMs = Date.now(),
): EconomicForegroundDemandInspection {
  const rows = economicForegroundMarkerRows(databasePath, nowMs),
    live = rows.filter((row) => row.live && row.marker);
  return {
    demandPresent: live.length > 0,
    liveOwnerCount: live.length,
    nextExpiryAtMs: live.length
      ? Math.min(...live.map((row) => row.marker!.expiresAtMs))
      : null,
    staleOwnerCount: rows.length - live.length,
  };
}
function cleanupStaleEconomicForegroundMarkers(
  databasePath: string,
  nowMs = Date.now(),
) {
  const directory = economicForegroundMarkerDirectory(databasePath);
  for (const row of economicForegroundMarkerRows(databasePath, nowMs)) {
    if (row.live) continue;
    try {
      unlinkSync(row.path);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  // An owner can crash between writing its private temp file and atomic rename.
  let names: string[] = [];
  try {
    names = readdirSync(directory).slice(0, ECONOMIC_FOREGROUND_MARKER_LIMIT);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  for (const name of names) {
    if (!ECONOMIC_FOREGROUND_TEMP_NAME.test(name)) continue;
    const path = join(directory, name);
    try {
      if (nowMs - statSync(path).mtimeMs > 10_000) unlinkSync(path);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
}
export function acquireEconomicForegroundDemand(input: {
  databasePath: string;
  component: string;
  operation: string;
  workflow?: string;
  semanticStage?: string;
  ttlMs?: number;
  nowMs?: number;
}) {
  const databasePath = resolve(input.databasePath),
    directory = economicForegroundMarkerDirectory(databasePath),
    databaseIdentity = economicForegroundDatabaseIdentity(databasePath),
    nowMs = input.nowMs ?? Date.now(),
    ttlMs = Math.max(100, Math.min(10_000, input.ttlMs ?? ECONOMIC_FOREGROUND_MARKER_TTL_MS)),
    id = randomUUID(),
    ownerId = `${process.pid}:${id}`,
    finalPath = join(directory, `fg-${process.pid}-${id}.json`),
    tempPath = join(directory, `.fg-${process.pid}-${id}.tmp`),
    marker: EconomicForegroundMarker = {
      version: ECONOMIC_FOREGROUND_MARKER_VERSION,
      databaseIdentity,
      ownerId,
      processId: process.pid,
      component: input.component.slice(0, 128),
      operation: input.operation.slice(0, 160),
      ...(input.workflow ? { workflow: input.workflow.slice(0, 160) } : {}),
      ...(input.semanticStage
        ? { semanticStage: input.semanticStage.slice(0, 160) }
        : {}),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
      monotonicStartedNs: process.hrtime.bigint().toString(),
    };
  secureDirectory(directory);
  writeFileSync(tempPath, deterministicTelemetryJson(marker), {
    encoding: "utf8",
    mode: FILE_MODE,
    flag: "wx",
  });
  renameSync(tempPath, finalPath);
  cleanupStaleEconomicForegroundMarkers(databasePath, nowMs);
  let released = false;
  return {
    ownerId,
    path: finalPath,
    expiresAtMs: marker.expiresAtMs,
    release: () => {
      if (released) return;
      released = true;
      try {
        unlinkSync(finalPath);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
    },
  };
}
function inferredRowChangeCount(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const changes = (value as { changes?: unknown }).changes;
  return typeof changes === "number" && Number.isFinite(changes) ? changes : null;
}
/** Canonical economic DB boundary: publish demand without SQLite, retry only
 * the short persistence callback, then release before any RPC or receipt wait. */
export function withEconomicForegroundPersistenceSync<T>(input: {
  databasePath: string;
  component: string;
  operation: string;
  workflow?: string;
  semanticStage?: string;
  run: () => T;
  onTelemetry?: (event: EconomicForegroundTelemetry) => void;
}): T {
  const databasePath = resolve(input.databasePath),
    nested = economicForegroundScopes.get(databasePath);
  if (nested) {
    nested.depth++;
    try {
      return input.run();
    } finally {
      nested.depth--;
    }
  }
  const priorityStarted = Date.now(),
    marker = acquireEconomicForegroundDemand(input),
    acquiredAt = Date.now(),
    scope = { depth: 1, release: marker.release };
  economicForegroundScopes.set(databasePath, scope);
  let retries = 0,
    outcome: EconomicForegroundTelemetry["outcome"] = "FAILED",
    value: T | undefined,
    writerStarted = Date.now();
  try {
    value = withSqliteTransientRetrySync({
      operation: input.operation,
      maxAttempts: 7,
      maxTotalRetryMs: ECONOMIC_FOREGROUND_RETRY_BUDGET_MS,
      run: input.run,
      onEvent: (event) => {
        if (event.finalDisposition === "RETRYING") retries++;
      },
    });
    outcome = "SUCCEEDED";
    return value;
  } finally {
    const writerWindowDurationMs = Date.now() - writerStarted;
    economicForegroundScopes.delete(databasePath);
    marker.release();
    const telemetry: EconomicForegroundTelemetry = {
      process: String(process.pid),
      component: input.component,
      operation: input.operation,
      persistenceClass: "foreground",
      ...(input.workflow ? { workflow: input.workflow } : {}),
      ...(input.semanticStage ? { semanticStage: input.semanticStage } : {}),
      economicDemandPresent: true,
      priorityAcquisitionLatencyMs: acquiredAt - priorityStarted,
      waitYieldDurationMs: 0,
      writerWindowDurationMs,
      rowChangeCount: inferredRowChangeCount(value),
      retryCount: retries,
      outcome,
    };
    if (input.onTelemetry) input.onTelemetry(telemetry);
    else try { process.stdout.write(deterministicTelemetryJson({event:"sqlite_write_window",...telemetry,at:new Date().toISOString()})+"\n"); } catch {}
  }
}
export async function waitForEconomicForegroundDemandToClear(input: {
  databasePath: string;
  component: string;
  operation: string;
  maxWaitMs?: number;
  pollMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onTelemetry?: (event: EconomicForegroundTelemetry) => void;
}) {
  const started = Date.now(),
    maxWaitMs = Math.max(0, Math.min(10_000, input.maxWaitMs ?? 5_250)),
    pollMs = Math.max(5, Math.min(250, input.pollMs ?? 25)),
    sleep = input.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let first = true,
    demandPresent = false;
  for (;;) {
    const inspection = inspectEconomicForegroundDemand(input.databasePath);
    demandPresent ||= inspection.demandPresent;
    if (!inspection.demandPresent) {
      const waited = Date.now() - started;
      if (demandPresent)
        input.onTelemetry?.({process:String(process.pid),component:input.component,operation:input.operation,persistenceClass:"background",economicDemandPresent:true,priorityAcquisitionLatencyMs:0,waitYieldDurationMs:waited,writerWindowDurationMs:0,rowChangeCount:null,retryCount:Math.max(0,Math.ceil(waited/pollMs)-1),outcome:"SUCCEEDED"});
      return { cleared: true, demandPresent, waitedMs: waited };
    }
    const elapsed = Date.now() - started;
    if (!first && elapsed >= maxWaitMs) {
      input.onTelemetry?.({process:String(process.pid),component:input.component,operation:input.operation,persistenceClass:"background",economicDemandPresent:true,priorityAcquisitionLatencyMs:0,waitYieldDurationMs:elapsed,writerWindowDurationMs:0,rowChangeCount:null,retryCount:Math.max(0,Math.ceil(elapsed/pollMs)-1),outcome:"DEFERRED"});
      return { cleared: false, demandPresent: true, waitedMs: elapsed };
    }
    first = false;
    await sleep(Math.min(pollMs, Math.max(1, maxWaitMs - elapsed)));
  }
}
export function waitForEconomicForegroundDemandToClearSync(input: {
  databasePath: string;
  component: string;
  operation: string;
  maxWaitMs?: number;
  pollMs?: number;
  onTelemetry?: (event: EconomicForegroundTelemetry) => void;
}) {
  const sleepArray = new Int32Array(new SharedArrayBuffer(4)),
    started = Date.now(),
    maxWaitMs = Math.max(0, Math.min(10_000, input.maxWaitMs ?? 5_250)),
    pollMs = Math.max(5, Math.min(250, input.pollMs ?? 25));
  let first = true,
    demandPresent = false;
  for (;;) {
    const inspection = inspectEconomicForegroundDemand(input.databasePath);
    demandPresent ||= inspection.demandPresent;
    if (!inspection.demandPresent) {
      const waited = Date.now() - started;
      if (demandPresent)
        input.onTelemetry?.({process:String(process.pid),component:input.component,operation:input.operation,persistenceClass:"background",economicDemandPresent:true,priorityAcquisitionLatencyMs:0,waitYieldDurationMs:waited,writerWindowDurationMs:0,rowChangeCount:null,retryCount:Math.max(0,Math.ceil(waited/pollMs)-1),outcome:"SUCCEEDED"});
      return { cleared: true, demandPresent, waitedMs: waited };
    }
    const elapsed = Date.now() - started;
    if (!first && elapsed >= maxWaitMs) {
      input.onTelemetry?.({process:String(process.pid),component:input.component,operation:input.operation,persistenceClass:"background",economicDemandPresent:true,priorityAcquisitionLatencyMs:0,waitYieldDurationMs:elapsed,writerWindowDurationMs:0,rowChangeCount:null,retryCount:Math.max(0,Math.ceil(elapsed/pollMs)-1),outcome:"DEFERRED"});
      return { cleared: false, demandPresent: true, waitedMs: elapsed };
    }
    first = false;
    Atomics.wait(sleepArray, 0, 0, Math.min(pollMs, Math.max(1, maxWaitMs - elapsed)));
  }
}
export type SqliteTransientDisposition = "RETRYING" | "RECOVERED" | "DEFERRED";
export type SqliteTransientEvent = {
  operation: string;
  attempt: number;
  delayMs: number;
  sqliteCode: string;
  finalDisposition: SqliteTransientDisposition;
};
export class SqliteTransientRetryExhaustedError extends Error {
  readonly code: string;
  constructor(
    public readonly operation: string,
    public readonly sqliteCode: string,
    public readonly attempts: number,
    options: { cause: unknown },
  ) {
    super(
      `SQLITE_TRANSIENT_RETRY_EXHAUSTED:${operation}:${sqliteCode}`,
      options,
    );
    this.name = "SqliteTransientRetryExhaustedError";
    this.code = sqliteCode;
  }
}
export function sqliteTransientCode(error: unknown): string | undefined {
  const value = error as { code?: unknown; message?: unknown },
    code = typeof value?.code === "string" ? value.code.toUpperCase() : "";
  if (/^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(code)) return code;
  const message = String(value?.message ?? error);
  if (/database (?:table )?is locked|database is busy/i.test(message))
    return /table is locked/i.test(message) ? "SQLITE_LOCKED" : "SQLITE_BUSY";
  return undefined;
}
export const isSqliteTransientLock = (error: unknown) =>
  sqliteTransientCode(error) !== undefined;
type SqliteRetryInput<T> = {
  operation: string;
  run: () => T;
  onEvent?: (event: SqliteTransientEvent) => void;
  maxAttempts?: number;
  maxTotalRetryMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  random?: () => number;
};
function retryDelay(
  input: SqliteRetryInput<unknown>,
  attempt: number,
  remainingMs: number,
) {
  const base = Math.min(
      input.maxDelayMs ?? 250,
      (input.baseDelayMs ?? 25) * 2 ** (attempt - 1),
    ),
    jitter = Math.floor(
      (input.random ?? Math.random)() * (input.jitterMs ?? 25),
    );
  return Math.max(0, Math.min(base + jitter, remainingMs));
}
export async function withSqliteTransientRetry<T>(
  input: SqliteRetryInput<T> & { sleep?: (delayMs: number) => Promise<void> },
): Promise<T> {
  const started = Date.now(),
    maxAttempts = input.maxAttempts ?? 5,
    budget = input.maxTotalRetryMs ?? SQLITE_TRANSIENT_RETRY_BUDGET_MS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++)
    try {
      const value = await input.run();
      if (attempt > 1)
        input.onEvent?.({
          operation: input.operation,
          attempt,
          delayMs: 0,
          sqliteCode: "SQLITE_OK",
          finalDisposition: "RECOVERED",
        });
      return value;
    } catch (error) {
      const sqliteCode = sqliteTransientCode(error);
      if (!sqliteCode) throw error;
      const remaining = budget - (Date.now() - started);
      if (attempt === maxAttempts || remaining <= 0) {
        input.onEvent?.({
          operation: input.operation,
          attempt,
          delayMs: 0,
          sqliteCode,
          finalDisposition: "DEFERRED",
        });
        throw new SqliteTransientRetryExhaustedError(
          input.operation,
          sqliteCode,
          attempt,
          { cause: error },
        );
      }
      const delayMs = retryDelay(input, attempt, remaining);
      if (delayMs <= 0) {
        input.onEvent?.({
          operation: input.operation,
          attempt,
          delayMs: 0,
          sqliteCode,
          finalDisposition: "DEFERRED",
        });
        throw new SqliteTransientRetryExhaustedError(
          input.operation,
          sqliteCode,
          attempt,
          { cause: error },
        );
      }
      input.onEvent?.({
        operation: input.operation,
        attempt,
        delayMs,
        sqliteCode,
        finalDisposition: "RETRYING",
      });
      await (
        input.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      )(delayMs);
    }
  throw new Error("SQLITE_TRANSIENT_RETRY_INVARIANT");
}
export function withSqliteTransientRetrySync<T>(input: SqliteRetryInput<T>): T {
  const started = Date.now(),
    maxAttempts = input.maxAttempts ?? 5,
    budget = input.maxTotalRetryMs ?? SQLITE_TRANSIENT_RETRY_BUDGET_MS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++)
    try {
      const value = input.run();
      if (attempt > 1)
        input.onEvent?.({
          operation: input.operation,
          attempt,
          delayMs: 0,
          sqliteCode: "SQLITE_OK",
          finalDisposition: "RECOVERED",
        });
      return value;
    } catch (error) {
      const sqliteCode = sqliteTransientCode(error);
      if (!sqliteCode) throw error;
      const remaining = budget - (Date.now() - started);
      if (attempt === maxAttempts || remaining <= 0) {
        input.onEvent?.({
          operation: input.operation,
          attempt,
          delayMs: 0,
          sqliteCode,
          finalDisposition: "DEFERRED",
        });
        throw new SqliteTransientRetryExhaustedError(
          input.operation,
          sqliteCode,
          attempt,
          { cause: error },
        );
      }
      const delayMs = retryDelay(input, attempt, remaining);
      if (delayMs <= 0) {
        input.onEvent?.({
          operation: input.operation,
          attempt,
          delayMs: 0,
          sqliteCode,
          finalDisposition: "DEFERRED",
        });
        throw new SqliteTransientRetryExhaustedError(
          input.operation,
          sqliteCode,
          attempt,
          { cause: error },
        );
      }
      input.onEvent?.({
        operation: input.operation,
        attempt,
        delayMs,
        sqliteCode,
        finalDisposition: "RETRYING",
      });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  throw new Error("SQLITE_TRANSIENT_RETRY_INVARIANT");
}
function secureDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(path, DIRECTORY_MODE);
}
function secureFile(path: string) {
  if (existsSync(path)) chmodSync(path, FILE_MODE);
}
/** Resolves production storage without relying on /tmp. Tests can supply explicit paths. */
export function productionDatabasePaths(
  input: { dataDir?: string; databasePath?: string } = {},
): DatabasePaths {
  const dataDir = resolve(input.dataDir ?? process.env.DATA_DIR ?? "./data");
  const databasePath = resolve(
    input.databasePath ??
      process.env.DATABASE_PATH ??
      join(dataDir, "robinhood-lp.sqlite"),
  );
  return { dataDir, databasePath, backupDir: join(dataDir, "backups") };
}
function configure(
  db: Database.Database,
  busyTimeoutMs = SQLITE_DEFAULT_BUSY_TIMEOUT_MS,
) {
  // Every short-lived repository connection passes through this function. Set
  // the bounded wait policy before any pragma that can need a lock, and avoid
  // re-requesting WAL mode once the database is already in WAL. Reissuing the
  // mutating journal_mode pragma made Telegram foreground opens wait behind a
  // long-lived recovery connection before the 250 ms runtime timeout applied.
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma("foreign_keys = ON");
  const journalMode = String(db.pragma("journal_mode", { simple: true })).toLowerCase();
  if (journalMode !== "wal") db.pragma("journal_mode = WAL");
}
/** Durable JSON boundary: exact BigInt decimal strings, including nested arrays/objects. */
export function jsonStringify(value: unknown) {
  return JSON.stringify(value, (_, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}
type MigrationFile = {
  name: string;
  version: string;
  path: string;
  checksum: string;
  identity: string;
  sql: string;
};
type MigrationLedgerRow = {
  migration_identity: string;
  migration_version: string;
  migration_path: string;
  name: string;
  checksum: string;
  applied_at: string;
};
const migrationFiles = (directory: string): MigrationFile[] => {
  const walk = (current: string, prefix = ""): string[] =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(current, entry.name), `${prefix}${entry.name}/`)
        : entry.isFile() && entry.name.endsWith(".sql")
          ? [`${prefix}${entry.name}`]
          : [],
    );
  return walk(directory)
    .map((path) => {
      const name = path.split("/").at(-1)!,
        match = /^(\d+)(?:_|-)/.exec(name);
      if (!match) throw new Error(`MIGRATION_VERSION_INVALID:${path}`);
      const sql = readFileSync(join(directory, ...path.split("/")), "utf8"),
        checksum = createHash("sha256").update(sql).digest("hex"),
        version = match[1]!;
      return {
        name,
        version,
        path,
        checksum,
        identity: createHash("sha256")
          .update(`${version}\n${path}\n${checksum}`)
          .digest("hex"),
        sql,
      };
    })
    .sort(
      (a, b) =>
        Number(a.version) - Number(b.version) || a.path.localeCompare(b.path),
    );
};
const createCanonicalMigrationLedger = (db: Database.Database) =>
  db.exec(
    "CREATE TABLE schema_migrations (migration_identity TEXT PRIMARY KEY, migration_version TEXT NOT NULL, migration_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
function ensureCanonicalMigrationLedger(
  db: Database.Database,
  files: MigrationFile[],
) {
  const exists = Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get(),
  );
  if (!exists) {
    createCanonicalMigrationLedger(db);
    return;
  }
  const columns = (
    db.pragma("table_info(schema_migrations)") as { name: string }[]
  ).map((column) => column.name);
  if (columns.includes("migration_identity")) return;
  if (columns.join(",") !== "name,applied_at")
    throw new Error(
      `MIGRATION_HISTORY_SCHEMA_UNSUPPORTED:${columns.join(",")}`,
    );
  const legacy = db
    .prepare("SELECT name,applied_at FROM schema_migrations ORDER BY name")
    .all() as { name: string; applied_at: string }[];
  const mapped = legacy.map((row) => {
    const matches = files.filter((file) => file.name === row.name);
    if (matches.length !== 1)
      throw new Error(
        `${matches.length ? "LEGACY_MIGRATION_MAPPING_AMBIGUOUS" : "LEGACY_MIGRATION_MAPPING_MISSING"}:${row.name}`,
      );
    return { ...matches[0]!, appliedAt: row.applied_at };
  });
  const upgrade = db.transaction(() => {
    db.exec("ALTER TABLE schema_migrations RENAME TO schema_migrations_legacy");
    createCanonicalMigrationLedger(db);
    const insert = db.prepare(
      "INSERT INTO schema_migrations(migration_identity,migration_version,migration_path,name,checksum,applied_at) VALUES(?,?,?,?,?,?)",
    );
    for (const file of mapped)
      insert.run(
        file.identity,
        file.version,
        file.path,
        file.name,
        file.checksum,
        file.appliedAt,
      );
    db.exec("DROP TABLE schema_migrations_legacy");
  });
  upgrade();
}
type MigrationBatchBackupManifest = {
  version: 1;
  databaseIdentity: string;
  pendingMigrations: { identity: string; path: string; checksum: string }[];
  sourceStateMarker: string;
  sourceLedgerMarker: string;
  migrationBatchId: string;
  verifiedAt: string;
  outcome: "PENDING" | "SUCCESS";
};
type MigrationBatchBackup = {
  directory: string;
  path: string;
  manifestPath: string;
  manifest: MigrationBatchBackupManifest;
};
const migrationBatchBackupPrefix = "pre-migration-batch-";
const backupHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const migrationLedgerMarker = (db: Database.Database) =>
  backupHash(
    db
      .prepare(
        "SELECT migration_identity,migration_path,checksum FROM schema_migrations ORDER BY migration_path",
      )
      .all(),
  );
const migrationSourceStateMarker = (db: Database.Database) =>
  backupHash({
    schemaVersion: db.pragma("schema_version", { simple: true }),
    userVersion: db.pragma("user_version", { simple: true }),
    applicationId: db.pragma("application_id", { simple: true }),
    pageCount: db.pragma("page_count", { simple: true }),
    freelistCount: db.pragma("freelist_count", { simple: true }),
    ledger: migrationLedgerMarker(db),
  });
function backupManifest(
  path: string,
): MigrationBatchBackupManifest | undefined {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<MigrationBatchBackupManifest>;
    return value.version === 1 &&
      typeof value.databaseIdentity === "string" &&
      Array.isArray(value.pendingMigrations) &&
      typeof value.sourceStateMarker === "string" &&
      typeof value.sourceLedgerMarker === "string" &&
      typeof value.migrationBatchId === "string" &&
      (value.outcome === "PENDING" || value.outcome === "SUCCESS") &&
      typeof value.verifiedAt === "string"
      ? (value as MigrationBatchBackupManifest)
      : undefined;
  } catch {
    return undefined;
  }
}
function backupDatabaseIsValid(
  path: string,
  manifest: MigrationBatchBackupManifest,
) {
  if (!existsSync(path)) return false;
  let backup: Database.Database | undefined;
  try {
    backup = new Database(path, { readonly: true, fileMustExist: true });
    return (
      backup.pragma("integrity_check", { simple: true }) === "ok" &&
      migrationLedgerMarker(backup) === manifest.sourceLedgerMarker
    );
  } catch {
    return false;
  } finally {
    backup?.close();
  }
}
function validMigrationBatchBackup(
  path: string,
  manifestPath: string,
  expected: MigrationBatchBackupManifest,
) {
  const found = backupManifest(manifestPath);
  return (
    found !== undefined &&
    JSON.stringify(found.pendingMigrations) ===
      JSON.stringify(expected.pendingMigrations) &&
    found.databaseIdentity === expected.databaseIdentity &&
    found.sourceStateMarker === expected.sourceStateMarker &&
    found.sourceLedgerMarker === expected.sourceLedgerMarker &&
    found.migrationBatchId === expected.migrationBatchId &&
    backupDatabaseIsValid(path, found)
  );
}
function migrationBatchBackup(
  db: Database.Database,
  dbPath: string,
  pending: MigrationFile[],
): MigrationBatchBackup {
  const source = statSync(dbPath),
    databaseIdentity = backupHash({
      path: resolve(dbPath),
      device: source.dev,
      inode: source.ino,
    }),
    pendingMigrations = pending.map((file) => ({
      identity: file.identity,
      path: file.path,
      checksum: file.checksum,
    })),
    sourceLedgerMarker = migrationLedgerMarker(db),
    sourceStateMarker = migrationSourceStateMarker(db),
    migrationBatchId = backupHash({
      databaseIdentity,
      pendingMigrations,
      sourceStateMarker,
    }),
    directory = join(dirname(dbPath), "backups"),
    path = join(
      directory,
      `${migrationBatchBackupPrefix}${migrationBatchId}.sqlite`,
    ),
    manifestPath = `${path}.json`,
    manifest: MigrationBatchBackupManifest = {
      version: 1,
      databaseIdentity,
      pendingMigrations,
      sourceStateMarker,
      sourceLedgerMarker,
      migrationBatchId,
      verifiedAt: new Date().toISOString(),
      outcome: "PENDING",
    };
  secureDirectory(directory);
  if (validMigrationBatchBackup(path, manifestPath, manifest))
    return {
      directory,
      path,
      manifestPath,
      manifest: backupManifest(manifestPath)!,
    };
  const temporary = `${path}.${randomUUID()}.tmp`,
    temporaryManifest = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
    secureFile(temporary);
    if (!backupDatabaseIsValid(temporary, manifest))
      throw new Error(`MIGRATION_BACKUP_VALIDATION_FAILED:${migrationBatchId}`);
    writeFileSync(temporaryManifest, JSON.stringify(manifest), {
      mode: FILE_MODE,
    });
    secureFile(temporaryManifest);
    renameSync(temporary, path);
    renameSync(temporaryManifest, manifestPath);
    return { directory, path, manifestPath, manifest };
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (existsSync(temporaryManifest)) unlinkSync(temporaryManifest);
    throw error;
  }
}
function finalizeMigrationBatchBackup(backup: MigrationBatchBackup) {
  const manifest = {
      ...backup.manifest,
      outcome: "SUCCESS" as const,
      verifiedAt: new Date().toISOString(),
    },
    temporary = `${backup.manifestPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(manifest), { mode: FILE_MODE });
    secureFile(temporary);
    renameSync(temporary, backup.manifestPath);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  const manifests = readdirSync(backup.directory).filter(
    (name) =>
      name.startsWith(migrationBatchBackupPrefix) &&
      name.endsWith(".sqlite.json"),
  );
  for (const name of manifests) {
    const path = join(backup.directory, name),
      candidate = backupManifest(path);
    if (
      !candidate ||
      candidate.migrationBatchId === manifest.migrationBatchId ||
      candidate.outcome !== "SUCCESS"
    )
      continue;
    const databasePath = path.slice(0, -".json".length);
    if (existsSync(databasePath)) unlinkSync(databasePath);
    unlinkSync(path);
  }
}
/** SQLite migration runner with canonical path/version/checksum identity and an append-only ledger. */
export function migrateSqlite(
  dbPath: string,
  migrationsDir: string,
  options: { busyTimeoutMs?: number } = {},
): MigrationStatus {
  const existed = existsSync(dbPath),
    files = migrationFiles(migrationsDir);
  secureDirectory(dirname(dbPath));
  const db = new Database(dbPath);
  try {
    configure(db, options.busyTimeoutMs);
    ensureCanonicalMigrationLedger(db, files);
    const rows = db
        .prepare(
          "SELECT migration_identity,migration_version,migration_path,name,checksum,applied_at FROM schema_migrations",
        )
        .all() as MigrationLedgerRow[],
      byPath = new Map(rows.map((row) => [row.migration_path, row])),
      insert = db.prepare(
        "INSERT INTO schema_migrations(migration_identity,migration_version,migration_path,name,checksum,applied_at) VALUES(?,?,?,?,?,?)",
      );
    for (const file of files) {
      const applied = byPath.get(file.path);
      if (applied && applied.checksum !== file.checksum)
        throw new Error(
          `MIGRATION_CHECKSUM_MISMATCH:${file.path}:recorded=${applied.checksum}:current=${file.checksum}`,
        );
    }
    const pendingBefore = files.filter((file) => !byPath.has(file.path)),
      batchBackup =
        existed && pendingBefore.length
          ? migrationBatchBackup(db, dbPath, pendingBefore)
          : undefined;
    for (const file of pendingBefore) {
      const foreignKeysOff = /^-- migrate: foreign_keys=off$/m.test(file.sql);
      if (foreignKeysOff) db.pragma("foreign_keys = OFF");
      try {
        const run = db.transaction(() => {
          db.exec(file.sql);
          const violations = db.pragma("foreign_key_check") as unknown[];
          if (violations.length)
            throw new Error(`MIGRATION_FOREIGN_KEY_CHECK_FAILED:${file.path}`);
          insert.run(
            file.identity,
            file.version,
            file.path,
            file.name,
            file.checksum,
            new Date().toISOString(),
          );
        });
        run();
      } finally {
        if (foreignKeysOff) db.pragma("foreign_keys = ON");
      }
      byPath.set(file.path, {
        migration_identity: file.identity,
        migration_version: file.version,
        migration_path: file.path,
        name: file.name,
        checksum: file.checksum,
        applied_at: "",
      });
    }
    if (batchBackup) finalizeMigrationBatchBackup(batchBackup);
    secureFile(dbPath);
    return {
      applied: files
        .filter((file) => byPath.has(file.path))
        .map((file) => file.name),
      pending: files
        .filter((file) => !byPath.has(file.path))
        .map((file) => file.name),
    };
  } finally {
    db.close();
  }
}
export async function validateMigrationsOnCopy(input: {
  sourcePath: string;
  copyPath: string;
  migrationsDir: string;
}) {
  const sourcePath = resolve(input.sourcePath),
    copyPath = resolve(input.copyPath);
  if (sourcePath === copyPath)
    throw new Error("MIGRATION_VALIDATOR_COPY_MUST_DIFFER_FROM_SOURCE");
  if (!existsSync(sourcePath))
    throw new Error("MIGRATION_VALIDATOR_SOURCE_MISSING");
  if (existsSync(copyPath))
    throw new Error("MIGRATION_VALIDATOR_COPY_ALREADY_EXISTS");
  secureDirectory(dirname(copyPath));
  const before = statSync(sourcePath),
    source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(copyPath);
  } finally {
    source.close();
  }
  const status = migrateSqlite(copyPath, input.migrationsDir),
    copy = new Database(copyPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = copy.pragma("integrity_check", { simple: true });
    if (integrity !== "ok")
      throw new Error("MIGRATION_VALIDATOR_INTEGRITY_FAILED");
    const required = [
      "chain_positions",
      "chain_transaction_journal",
      "chain_v3_workflows",
      "chain_v3_lifecycle_events",
      "chain_accounting_events",
    ];
    for (const table of required)
      if (
        !copy
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table)
      )
        throw new Error(`MIGRATION_VALIDATOR_TABLE_MISSING:${table}`);
    const after = statSync(sourcePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("MIGRATION_VALIDATOR_SOURCE_CHANGED");
    return {
      sourceUnchanged: true,
      copyPath,
      integrity,
      migrations: status.applied,
      requiredTables: required,
    };
  } finally {
    copy.close();
  }
}
export function sqliteStatus(
  dbPath: string,
  migrationsDir: string,
): MigrationStatus {
  const files = migrationFiles(migrationsDir);
  try {
    const db = new Database(dbPath, { readonly: true }),
      columns = db.pragma("table_info(schema_migrations)") as {
        name: string;
      }[];
    const canonical = columns.some(
        (column) => column.name === "migration_path",
      ),
      appliedRows = (
        canonical
          ? db
              .prepare(
                "SELECT migration_path,name,checksum FROM schema_migrations",
              )
              .all()
          : db.prepare("SELECT name FROM schema_migrations").all()
      ) as { migration_path?: string; name: string; checksum?: string }[],
      appliedPaths = new Set(
        appliedRows.flatMap((row) =>
          row.migration_path ? [row.migration_path] : [],
        ),
      ),
      appliedNames = new Set(appliedRows.map((row) => row.name));
    db.close();
    return {
      applied: files
        .filter((file) =>
          canonical ? appliedPaths.has(file.path) : appliedNames.has(file.name),
        )
        .map((file) => file.name),
      pending: files
        .filter(
          (file) =>
            !(canonical
              ? appliedPaths.has(file.path)
              : appliedNames.has(file.name)),
        )
        .map((file) => file.name),
    };
  } catch {
    return { applied: [], pending: files.map((file) => file.name) };
  }
}
/** Creates a timestamped SQLite backup through SQLite's online backup API, then atomically publishes it. */
export async function backupSqlite(
  dbPath: string,
  backupDir: string,
  retention = 7,
): Promise<{ path: string; retained: number }> {
  if (!existsSync(dbPath))
    throw new Error(`database does not exist: ${dbPath}`);
  secureDirectory(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(backupDir, `robinhood-lp-${stamp}.sqlite`),
    temporary = `${target}.${randomUUID()}.tmp`,
    db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(temporary);
  } finally {
    db.close();
  }
  secureFile(temporary);
  renameSync(temporary, target);
  const backups = readdirSync(backupDir)
    .filter((x) => /^robinhood-lp-.*\.sqlite$/.test(x))
    .sort()
    .reverse();
  for (const stale of backups.slice(Math.max(0, retention)))
    unlinkSync(join(backupDir, stale));
  return { path: target, retained: Math.min(backups.length, retention) };
}
/** Testable restore helper; target must not exist to avoid accidental overwrite. */
export function restoreSqliteBackup(backupPath: string, targetPath: string) {
  if (!existsSync(backupPath))
    throw new Error(`backup does not exist: ${backupPath}`);
  if (existsSync(targetPath))
    throw new Error(`refusing to overwrite existing database: ${targetPath}`);
  secureDirectory(dirname(targetPath));
  copyFileSync(backupPath, targetPath);
  secureFile(targetPath);
}
export const V4_LIVE_OPEN_NO_BROADCAST_TERMINALIZATION_ACTOR =
  "cli:v4-live-open-terminalize-no-broadcast";
export const V4_LIVE_OPEN_NO_BROADCAST_TERMINALIZATION_EVENT =
  "FAILED_NO_BROADCAST_TERMINALIZED";
export class V4LiveOpenNoBroadcastTerminalizationError extends Error {
  constructor(
    public readonly code: string,
    public readonly safeEvidenceCategory: string,
    public readonly evidence: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "V4LiveOpenNoBroadcastTerminalizationError";
  }
}
type V4LiveOpenTerminalizationCounts = Record<string, number>;
export type V4LiveOpenTerminalizationWrite = {
  status: "TERMINALIZED_NO_BROADCAST" | "ALREADY_TERMINAL";
  intentId: string;
  operatorReason: string;
  terminalizedAt: string;
  previousState: "FAILED_RETRYABLE";
  resultingState: "FAILED";
  terminalizationClass: "PROVEN_NO_BROADCAST";
  beforeTransitionCount: number;
  protectedCounts: V4LiveOpenTerminalizationCounts;
};
export type V4LiveOpenTerminalizationReconciliationWrite = {
  status: "RECONCILED_TERMINAL_STATE" | "ALREADY_TERMINAL";
  intentId: string;
  terminalizedAt: string;
  previousState: "FAILED_RETRYABLE";
  resultingState: "FAILED";
  terminalizationClass: "PROVEN_NO_BROADCAST";
  beforeTransitionCount: number;
  protectedCounts: V4LiveOpenTerminalizationCounts;
};
const v4TerminalizationBlock = (
  code: string,
  safeEvidenceCategory: string,
  evidence: Record<string, unknown> = {},
): never => {
  throw new V4LiveOpenNoBroadcastTerminalizationError(
    code,
    safeEvidenceCategory,
    evidence,
  );
};
const terminalizationObject = (
  value: unknown,
): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
function terminalizationDetails(raw: unknown, ordinal: unknown) {
  try {
    const value = JSON.parse(String(raw));
    if (!terminalizationObject(value)) throw new Error();
    return value;
  } catch {
    return v4TerminalizationBlock(
      "V4_TERMINALIZATION_TRANSITION_DETAILS_MALFORMED",
      "TRANSITION_METADATA",
      { ordinal },
    );
  }
}
function terminalizationExecutionEvidence(
  value: unknown,
  path = "details",
): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = terminalizationExecutionEvidence(
        value[index],
        `${path}[${index}]`,
      );
      if (found) return found;
    }
    return;
  }
  if (!terminalizationObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const current = `${path}.${key}`,
      normalized = key.toLowerCase();
    if (
      (normalized === "exacthash" ||
        normalized === "serializedhash" ||
        normalized === "txhash" ||
        normalized === "transactionhash") &&
      item !== null &&
      item !== undefined &&
      item !== ""
    )
      return current;
    if (normalized.includes("receipt") && item !== null && item !== undefined)
      return current;
    if (
      (normalized === "tokenid" ||
        normalized === "token_id" ||
        normalized === "nonce") &&
      item !== null &&
      item !== undefined
    )
      return current;
    if (
      [
        "submitted",
        "confirmed",
        "executionstarted",
        "signingused",
        "broadcastused",
      ].includes(normalized) &&
      item === true
    )
      return current;
    const nested = terminalizationExecutionEvidence(item, current);
    if (nested) return nested;
  }
}
/** Receipt/log-derived repository. The tx hash + log index unique keys make reruns and restarts idempotent. */
export class SqliteLedgerRepository {
  readonly db: Database.Database;
  private closed = false;
  constructor(
    readonly path: string,
    options: { busyTimeoutMs?: number } = {},
  ) {
    secureDirectory(dirname(path));
    this.db = new Database(path);
    configure(this.db, options.busyTimeoutMs);
    secureFile(path);
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  private createBidLadder(
    plan: V4BidLadderPersistencePlan,
    reset?: V4BidLadderUsdResetCreation,
  ) {
    const legs = [...plan.legs].sort((a, b) => a.legIndex - b.legIndex);
    if (
      plan.strategyVersion !== "V4_BID_LADDER_V1" ||
      !["DRY_RUN", "LIVE"].includes(plan.executionMode) ||
      !plan.ladderId.trim() ||
      legs.length !== 5 ||
      legs.some(
        (leg, index) =>
          leg.legIndex !== index ||
          leg.fundingAmount <= 0n ||
          leg.plannedLiquidity <= 0n,
      ) ||
      legs.reduce((sum, leg) => sum + leg.fundingAmount, 0n) !==
        plan.totalFundingAmount
    )
      throw new Error("V4_BID_LADDER_PERSISTENCE_PLAN_INVALID");
    const existing = this.loadBidLadder(plan.ladderId);
    const equivalent = (
      parent: Record<string, unknown>,
      stored: Record<string, unknown>[],
    ) => {
      const p = plan.pool.key;
      const entryUsdSame =
        parent.entry_usd_snapshot === null ||
        parent.entry_usd_snapshot === undefined
          ? plan.entryUsdSnapshot === undefined
          : Number(parent.entry_usd_snapshot) === plan.entryUsdSnapshot;
      const parentSame =
        String(parent.strategy_version) === plan.strategyVersion &&
        String(parent.execution_mode) === plan.executionMode &&
        String(parent.pool_id).toLowerCase() === plan.pool.id.toLowerCase() &&
        String(parent.currency0).toLowerCase() === p.currency0.toLowerCase() &&
        String(parent.currency1).toLowerCase() === p.currency1.toLowerCase() &&
        Number(parent.fee) === p.fee &&
        Number(parent.tick_spacing) === p.tickSpacing &&
        String(parent.hooks).toLowerCase() === p.hooks.toLowerCase() &&
        String(parent.funding_token).toLowerCase() ===
          plan.fundingToken.toLowerCase() &&
        String(parent.target_token).toLowerCase() ===
          plan.targetToken.toLowerCase() &&
        Number(parent.funding_index) === plan.fundingIndex &&
        Number(parent.target_index) === plan.targetIndex &&
        Number(parent.reference_tick) === plan.pool.tick &&
        String(parent.reference_block) === plan.pool.blockNumber.toString() &&
        String(parent.reference_block_hash ?? "").toLowerCase() ===
          String(plan.referenceBlockHash ?? "").toLowerCase() &&
        String(parent.total_funding_amount_raw) ===
          plan.totalFundingAmount.toString() &&
        entryUsdSame;
      const legsSame =
        stored.length === 5 &&
        stored.every((row, index) => {
          const leg = legs[index]!;
          return (
            Number(row.leg_index) === leg.legIndex &&
            Number(row.upper_drop_bps) === leg.upperDropBps &&
            Number(row.lower_drop_bps) === leg.lowerDropBps &&
            Number(row.capital_weight_bps) === leg.weightBps &&
            Number(row.tick_lower) === leg.tickLower &&
            Number(row.tick_upper) === leg.tickUpper &&
            String(row.funding_amount_raw) === leg.fundingAmount.toString() &&
            String(row.planned_liquidity_raw) ===
              leg.plannedLiquidity.toString() &&
            Number(row.funding_index) === leg.fundingIndex &&
            Number(row.target_index) === leg.targetIndex &&
            String(row.status) === "PLANNED"
          );
        });
      return parentSame && legsSame;
    };
    if (existing) {
      if (!equivalent(existing, this.listBidLadderLegs(plan.ladderId)))
        throw new Error("V4_BID_LADDER_PLAN_CONFLICT");
      if (reset) {
        const stored = this.loadBidLadderUsdReset(plan.ladderId);
        if (
          !stored ||
          String(stored.root_ladder_id) !== reset.rootLadderId ||
          String(stored.previous_ladder_id ?? "") !==
            String(reset.previousLadderId ?? "") ||
          Number(stored.generation) !== reset.generation ||
          String(stored.creation_reason) !== reset.creationReason
        )
          throw new Error("V4_BID_LADDER_USDG_RESET_LINEAGE_CONFLICT");
      }
      return {
        ladder: existing,
        legs: this.listBidLadderLegs(plan.ladderId),
        created: false,
      };
    }
    const at = plan.createdAtMs,
      insert = this.db.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO v4_bid_ladders(ladder_id,strategy_version,execution_mode,pool_id,currency0,currency1,fee,tick_spacing,hooks,funding_token,target_token,funding_symbol,target_symbol,symbol_provenance_json,funding_index,target_index,reference_tick,reference_block,reference_block_hash,total_funding_amount_raw,entry_usd_snapshot,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            plan.ladderId,
            plan.strategyVersion,
            plan.executionMode,
            plan.pool.id.toLowerCase(),
            plan.pool.key.currency0.toLowerCase(),
            plan.pool.key.currency1.toLowerCase(),
            plan.pool.key.fee,
            plan.pool.key.tickSpacing,
            plan.pool.key.hooks.toLowerCase(),
            plan.fundingToken.toLowerCase(),
            plan.targetToken.toLowerCase(),
            plan.fundingSymbol ?? null,
            plan.targetSymbol ?? null,
            plan.symbolProvenance === undefined ? null : jsonStringify(plan.symbolProvenance),
            plan.fundingIndex,
            plan.targetIndex,
            plan.pool.tick,
            plan.pool.blockNumber.toString(),
            plan.referenceBlockHash?.toLowerCase() ?? null,
            plan.totalFundingAmount.toString(),
            plan.entryUsdSnapshot ?? null,
            "PLANNED",
            at,
            at,
          );
        const statement = this.db.prepare(
          "INSERT INTO v4_bid_ladder_legs(ladder_id,leg_index,upper_drop_bps,lower_drop_bps,capital_weight_bps,tick_lower,tick_upper,funding_amount_raw,planned_liquidity_raw,funding_index,target_index,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        );
        for (const leg of legs)
          statement.run(
            plan.ladderId,
            leg.legIndex,
            leg.upperDropBps,
            leg.lowerDropBps,
            leg.weightBps,
            leg.tickLower,
            leg.tickUpper,
            leg.fundingAmount.toString(),
            leg.plannedLiquidity.toString(),
            leg.fundingIndex,
            leg.targetIndex,
            "PLANNED",
            at,
            at,
          );
        if (reset) {
          const generationValid =
            Number.isSafeInteger(reset.generation) &&
            reset.generation >= 0 &&
            ((reset.generation === 0 &&
              !reset.previousLadderId &&
              reset.rootLadderId === plan.ladderId &&
              reset.creationReason === "INITIAL_OPEN") ||
              (reset.generation > 0 &&
                Boolean(reset.previousLadderId) &&
                reset.creationReason === "USDG_RESET_REPOSITION"));
          if (!generationValid)
            throw new Error("V4_BID_LADDER_USDG_RESET_LINEAGE_INVALID");
          this.db
            .prepare(
              "INSERT INTO v4_bid_ladder_usdg_reset_v1(ladder_id,root_ladder_id,previous_ladder_id,generation,policy,creation_reason,phase,created_at_ms,updated_at_ms) VALUES(?,?,?,?,? ,?,'OPEN_PENDING',?,?)",
            )
            .run(
              plan.ladderId,
              reset.rootLadderId,
              reset.previousLadderId ?? null,
              reset.generation,
              V4_BID_LADDER_USDG_RESET_POLICY,
              reset.creationReason,
              at,
              at,
            );
          if (reset.previousLadderId) {
            const linked = this.db
              .prepare(
                "UPDATE v4_bid_ladder_usdg_reset_v1 SET next_ladder_id=?,revision=revision+1,updated_at_ms=? WHERE ladder_id=? AND (next_ladder_id IS NULL OR next_ladder_id=?)",
              )
              .run(
                plan.ladderId,
                at,
                reset.previousLadderId,
                plan.ladderId,
              ).changes;
            if (linked !== 1)
              throw new Error("V4_BID_LADDER_USDG_RESET_CHILD_LINK_CONFLICT");
          }
        }
      });
    insert();
    return {
      ladder: this.loadBidLadder(plan.ladderId)!,
      legs: this.listBidLadderLegs(plan.ladderId),
      created: true,
    };
  }
  createDryRunBidLadder(plan: V4BidLadderPersistencePlan) {
    if (plan.executionMode !== "DRY_RUN")
      throw new Error("V4_BID_LADDER_PERSISTENCE_PLAN_INVALID");
    return this.createBidLadder(plan);
  }
  createLiveBidLadder(
    plan: V4BidLadderPersistencePlan,
    reset?: V4BidLadderUsdResetCreation,
  ) {
    if (plan.executionMode !== "LIVE")
      throw new Error("V4_BID_LADDER_PERSISTENCE_PLAN_INVALID");
    return this.createBidLadder(plan, reset);
  }
  loadBidLadder(ladderId: string) {
    return this.db
      .prepare("SELECT * FROM v4_bid_ladders WHERE ladder_id=?")
      .get(ladderId) as Record<string, unknown> | undefined;
  }
  listBidLadderLegs(ladderId: string) {
    return this.db
      .prepare(
        "SELECT * FROM v4_bid_ladder_legs WHERE ladder_id=? ORDER BY leg_index",
      )
      .all(ladderId) as Record<string, unknown>[];
  }
  listBidLadders(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("V4_BID_LADDER_LIST_LIMIT_INVALID");
    return this.db
      .prepare(
        "SELECT * FROM v4_bid_ladders ORDER BY created_at_ms DESC, ladder_id DESC LIMIT ?",
      )
      .all(limit) as Record<string, unknown>[];
  }
  loadBidLadderUsdReset(ladderId: string) {
    return this.db
      .prepare("SELECT * FROM v4_bid_ladder_usdg_reset_v1 WHERE ladder_id=?")
      .get(ladderId) as Record<string, unknown> | undefined;
  }
  listBidLadderUsdResetCandidates(limit = 8) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
      throw new Error("V4_BID_LADDER_USDG_RESET_LIMIT_INVALID");
    return this.db
      .prepare(
        "SELECT r.*,l.status ladder_status FROM v4_bid_ladder_usdg_reset_v1 r JOIN v4_bid_ladders l ON l.ladder_id=r.ladder_id WHERE r.phase NOT IN ('COMPLETED','BLOCKED','OPERATOR_CLOSED') ORDER BY r.updated_at_ms,r.ladder_id LIMIT ?",
      )
      .all(limit) as Record<string, unknown>[];
  }
  v4BidLadderStrategyDepthBps(ladderId: string) {
    const row = this.db
      .prepare(
        "SELECT lower_drop_bps FROM v4_bid_ladder_legs WHERE ladder_id=? AND leg_index=4",
      )
      .get(ladderId) as { lower_drop_bps: number } | undefined;
    const value = Number(row?.lower_drop_bps);
    if (!Number.isSafeInteger(value) || value <= 0 || value >= 10_000)
      throw new Error("V4_BID_LADDER_STRATEGY_DEPTH_MISSING");
    return value;
  }
  transitionBidLadderUsdReset(input: {
    ladderId: string;
    from: V4BidLadderUsdResetPhase | readonly V4BidLadderUsdResetPhase[];
    to: V4BidLadderUsdResetPhase;
    closeReason?: "NORMAL_OPERATOR_CLOSE" | "USDG_RESET_REPOSITION";
    closeWorkflowIdentity?: string;
    reopenWorkflowIdentity?: string;
    returnedUsdgPrincipal?: bigint;
    returnedTargetPrincipal?: bigint;
    returnedUsdgFee?: bigint;
    returnedTargetFee?: bigint;
    blockReason?: string | null;
    nowMs?: number;
  }) {
    const from = Array.isArray(input.from) ? input.from : [input.from],
      now = input.nowMs ?? Date.now();
    if (!from.length || !Number.isSafeInteger(now) || now < 0)
      throw new Error("V4_BID_LADDER_USDG_RESET_TRANSITION_INVALID");
    for (const value of [
      input.returnedUsdgPrincipal,
      input.returnedTargetPrincipal,
      input.returnedUsdgFee,
      input.returnedTargetFee,
    ])
      if (value !== undefined && value < 0n)
        throw new Error("V4_BID_LADDER_USDG_RESET_AMOUNT_INVALID");
    const placeholders = from.map(() => "?").join(","),
      changed = this.db
        .prepare(
          `UPDATE v4_bid_ladder_usdg_reset_v1 SET phase=?,close_reason=COALESCE(?,close_reason),close_workflow_identity=COALESCE(?,close_workflow_identity),reopen_workflow_identity=COALESCE(?,reopen_workflow_identity),returned_usdg_principal_raw=COALESCE(?,returned_usdg_principal_raw),returned_target_principal_raw=COALESCE(?,returned_target_principal_raw),returned_usdg_fee_raw=COALESCE(?,returned_usdg_fee_raw),returned_target_fee_raw=COALESCE(?,returned_target_fee_raw),block_reason=?,revision=revision+1,updated_at_ms=? WHERE ladder_id=? AND phase IN (${placeholders})`,
        )
        .run(
          input.to,
          input.closeReason ?? null,
          input.closeWorkflowIdentity ?? null,
          input.reopenWorkflowIdentity ?? null,
          input.returnedUsdgPrincipal?.toString() ?? null,
          input.returnedTargetPrincipal?.toString() ?? null,
          input.returnedUsdgFee?.toString() ?? null,
          input.returnedTargetFee?.toString() ?? null,
          input.blockReason ?? null,
          now,
          input.ladderId,
          ...from,
        ).changes;
    if (changed !== 1)
      throw new Error("V4_BID_LADDER_USDG_RESET_TRANSITION_CONFLICT");
    return this.loadBidLadderUsdReset(input.ladderId)!;
  }
  ensurePosition(id: string, tokenId: string, pool: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO positions(id,token_id,pool_address,status,created_at) VALUES(?,?,?,?,?)",
      )
      .run(id, tokenId, pool, "open", new Date().toISOString());
  }
  persistStrategyPosition(input: {
    positionId: string;
    strategyMode: "BALANCED" | "SINGLE_SIDED_DOWNSIDE";
    targetToken?: string;
    fundingToken?: string;
    targetSymbol?: string;
    fundingSymbol?: string;
    symbolProvenance?: unknown;
    upperDropPct?: number;
    lowerDropPct?: number;
    requestedUpperPrice?: number;
    requestedLowerPrice?: number;
    actualUpperPrice?: number;
    actualLowerPrice?: number;
    tickLower?: number;
    tickUpper?: number;
    initialFundingRaw?: bigint;
    targetDesiredRaw?: bigint;
    fundingDesiredRaw?: bigint;
    benchmarkAsset?: string;
    intent?: unknown;
    simulation?: unknown;
  }) {
    const stringify = (value: unknown) =>
      JSON.stringify(value, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
    this.db
      .prepare(
        "INSERT INTO position_strategy_details(position_id,strategy_mode,target_token,funding_token,upper_drop_pct,lower_drop_pct,requested_upper_price,requested_lower_price,actual_upper_price,actual_lower_price,tick_lower,tick_upper,initial_funding_raw,target_desired_raw,funding_desired_raw,benchmark_asset,intent_json,simulation_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(position_id) DO UPDATE SET strategy_mode=excluded.strategy_mode,target_token=excluded.target_token,funding_token=excluded.funding_token,upper_drop_pct=excluded.upper_drop_pct,lower_drop_pct=excluded.lower_drop_pct,requested_upper_price=excluded.requested_upper_price,requested_lower_price=excluded.requested_lower_price,actual_upper_price=excluded.actual_upper_price,actual_lower_price=excluded.actual_lower_price,tick_lower=excluded.tick_lower,tick_upper=excluded.tick_upper,initial_funding_raw=excluded.initial_funding_raw,target_desired_raw=excluded.target_desired_raw,funding_desired_raw=excluded.funding_desired_raw,benchmark_asset=excluded.benchmark_asset,intent_json=excluded.intent_json,simulation_json=excluded.simulation_json,updated_at=excluded.updated_at",
      )
      .run(
        input.positionId,
        input.strategyMode,
        input.targetToken ?? null,
        input.fundingToken ?? null,
        input.upperDropPct ?? null,
        input.lowerDropPct ?? null,
        input.requestedUpperPrice ?? null,
        input.requestedLowerPrice ?? null,
        input.actualUpperPrice ?? null,
        input.actualLowerPrice ?? null,
        input.tickLower ?? null,
        input.tickUpper ?? null,
        input.initialFundingRaw?.toString() ?? null,
        input.targetDesiredRaw?.toString() ?? null,
        input.fundingDesiredRaw?.toString() ?? null,
        input.benchmarkAsset ?? null,
        stringify(input.intent ?? {}),
        stringify(input.simulation ?? {}),
        new Date().toISOString(),
      );
  }
  strategyPosition(positionId: string) {
    return this.db
      .prepare("SELECT * FROM position_strategy_details WHERE position_id=?")
      .get(positionId) as Record<string, unknown> | undefined;
  }
  persistIntent(id: string, key: string, payload: unknown) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO transaction_intents(id,idempotency_key,state,payload_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        key,
        "simulated",
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }
  persistReceipt(hash: string, intentId: string | undefined, receipt: unknown) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO transaction_receipts(tx_hash,intent_id,receipt_json,reconciled_at) VALUES(?,?,?,NULL)",
      )
      .run(
        hash,
        intentId ?? null,
        JSON.stringify(receipt, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      );
  }
  ingestDeposit(input: {
    id: string;
    positionId: string;
    txHash: string;
    logIndex: number;
    amounts: TokenAmounts;
    blockNumber: bigint;
    blockTimestamp: string;
  }) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO position_deposits(id,position_id,tx_hash,log_index,token0_raw,token1_raw,prices_json,block_number,block_timestamp) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.id,
          input.positionId,
          input.txHash,
          input.logIndex,
          input.amounts.token0.toString(),
          input.amounts.token1.toString(),
          "{}",
          input.blockNumber.toString(),
          input.blockTimestamp,
        ).changes > 0
    );
  }
  ingestLiquidityChange(input: {
    id: string;
    positionId: string;
    txHash: string;
    logIndex: number;
    kind: "decrease" | "increase";
    amounts: TokenAmounts;
  }) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO liquidity_changes(id,position_id,tx_hash,log_index,kind,token0_raw,token1_raw) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          input.id,
          input.positionId,
          input.txHash,
          input.logIndex,
          input.kind,
          input.amounts.token0.toString(),
          input.amounts.token1.toString(),
        ).changes > 0
    );
  }
  ingestGas(positionId: string, hash: string, nativeRaw: bigint) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO gas_costs(id,position_id,tx_hash,native_raw,usd_value) VALUES(?,?,?,?,NULL)",
        )
        .run(`gas:${hash}`, positionId, hash, nativeRaw.toString()).changes > 0
    );
  }
  v4BurnEvidence(tokenId: bigint | string) {
    const position = this.v4Position(tokenId);
    if (!position || !position.mint_hash)
      return { previouslyMinted: false, burnConfirmed: false };
    const burn = this.db
      .prepare(
        "SELECT i.id,i.tx_hash FROM v4_lifecycle_intents i JOIN v4_lifecycle_receipts r ON r.intent_id=i.id AND r.tx_hash=i.tx_hash WHERE i.token_id=? AND i.action='burn' AND i.state='BURNED' AND i.tx_hash IS NOT NULL ORDER BY i.updated_at DESC LIMIT 1",
      )
      .get(tokenId.toString()) as { id: string; tx_hash: string } | undefined;
    return {
      previouslyMinted: true,
      burnConfirmed: !!burn,
      burnTxHash: burn?.tx_hash,
      sourceIntentId: burn?.id,
    };
  }
  finalizeV4TerminalAccounting(tokenId: bigint | string) {
    const row = this.v4Position(tokenId);
    if (
      !row ||
      String(row.status) !== "burned" ||
      BigInt(String(row.liquidity_raw)) !== 0n
    )
      throw new Error("V4_TERMINAL_EVIDENCE_INCOMPLETE");
    const evidence = this.v4BurnEvidence(tokenId);
    if (
      !evidence.burnConfirmed ||
      !evidence.burnTxHash ||
      !evidence.sourceIntentId
    )
      throw new Error("V4_TERMINAL_BURN_RECEIPT_MISSING");
    const positionId = `v4:${tokenId}`,
      before = this.positionAccounting(positionId),
      at = new Date().toISOString(),
      insert = this.db.prepare(
        "INSERT OR IGNORE INTO v4_terminal_differences(id,position_id,token_index,token_address,amount_raw,reason,source_intent_id,source_tx_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      );
    let inserted = 0;
    for (const [index, amount, address] of [
      [0, before.pendingPrincipal.token0, String(row.currency0)],
      [1, before.pendingPrincipal.token1, String(row.currency1)],
    ] as const)
      if (amount > 0n)
        inserted += insert.run(
          `v4-terminal:${tokenId}:${index}`,
          positionId,
          index,
          address,
          amount.toString(),
          "realized_shortfall",
          evidence.sourceIntentId,
          evidence.burnTxHash,
          at,
        ).changes;
    return {
      inserted,
      sourceIntentId: evidence.sourceIntentId,
      sourceTxHash: evidence.burnTxHash,
      accounting: this.positionAccounting(positionId),
    };
  }
  reconciliationDelta(positionId: string) {
    const one = (table: string) =>
      Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE position_id=?`,
            )
            .get(positionId) as { count: number }
        ).count,
      );
    return {
      events: one("collections") + one("liquidity_changes"),
      deposits: one("position_deposits"),
      principal: one("principal_withdrawals"),
      fees: one("fee_claims"),
    };
  }
  persistPnlSnapshot(id: string, positionId: string, payload: unknown) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO pnl_snapshots(id,position_id,payload_json,created_at) VALUES(?,?,?,?)",
      )
      .run(
        id,
        positionId,
        JSON.stringify(payload, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
        new Date().toISOString(),
      );
  }
  pnlSnapshot(id: string, positionId: string) {
    const row = this.db
      .prepare(
        "SELECT payload_json FROM pnl_snapshots WHERE id=? AND position_id=?",
      )
      .get(id, positionId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) : undefined;
  }
  ingestCollection(input: {
    id: string;
    positionId: string;
    txHash: string;
    logIndex: number;
    amounts: TokenAmounts;
    pending: TokenAmounts;
  }) {
    const p0 =
        input.pending.token0 < input.amounts.token0
          ? input.pending.token0
          : input.amounts.token0,
      p1 =
        input.pending.token1 < input.amounts.token1
          ? input.pending.token1
          : input.amounts.token1,
      fee0 = input.amounts.token0 - p0,
      fee1 = input.amounts.token1 - p1;
    const write = this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          "INSERT OR IGNORE INTO collections(id,position_id,tx_hash,log_index,token0_raw,token1_raw,principal0_raw,principal1_raw,fee0_raw,fee1_raw) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.id,
          input.positionId,
          input.txHash,
          input.logIndex,
          input.amounts.token0.toString(),
          input.amounts.token1.toString(),
          p0.toString(),
          p1.toString(),
          fee0.toString(),
          fee1.toString(),
        );
      if (!inserted.changes) return false;
      if (p0 || p1)
        this.db
          .prepare(
            "INSERT INTO principal_withdrawals(id,position_id,collection_id,token0_raw,token1_raw) VALUES(?,?,?,?,?)",
          )
          .run(
            `${input.id}:principal`,
            input.positionId,
            input.id,
            p0.toString(),
            p1.toString(),
          );
      if (fee0 || fee1)
        this.db
          .prepare(
            "INSERT INTO fee_claims(id,position_id,collection_id,token0_raw,token1_raw,claim_prices_json) VALUES(?,?,?,?,?,?)",
          )
          .run(
            `${input.id}:fees`,
            input.positionId,
            input.id,
            fee0.toString(),
            fee1.toString(),
            "{}",
          );
      return true;
    });
    return write();
  }
  collectionTotals(positionId: string) {
    const rows = this.db
      .prepare(
        "SELECT principal0_raw,principal1_raw,fee0_raw,fee1_raw FROM collections WHERE position_id=?",
      )
      .all(positionId) as Array<Record<string, string>>;
    return rows.reduce(
      (a, r) => ({
        principal: {
          token0: a.principal.token0 + BigInt(r.principal0_raw),
          token1: a.principal.token1 + BigInt(r.principal1_raw),
        },
        fees: {
          token0: a.fees.token0 + BigInt(r.fee0_raw),
          token1: a.fees.token1 + BigInt(r.fee1_raw),
        },
      }),
      { principal: zero(), fees: zero() },
    );
  }
  positionAccounting(
    positionId: string,
  ): Pick<
    PositionLedger,
    | "deposits"
    | "pendingPrincipal"
    | "withdrawnPrincipal"
    | "claimedFees"
    | "unclaimedFees"
    | "gasUsd"
    | "executionCostsUsd"
    | "events"
    | "allocations"
  > & {
    terminalDifferences: TokenAmounts;
    terminalDifferenceRecords: Record<string, unknown>[];
  } {
    const sum = (table: string, a: string, b: string) => {
      const rows = this.db
        .prepare(
          `SELECT ${a} AS a, ${b} AS b FROM ${table} WHERE position_id=?`,
        )
        .all(positionId) as Array<{ a: string; b: string }>;
      return rows.reduce<TokenAmounts>(
        (total, row) => ({
          token0: total.token0 + BigInt(row.a),
          token1: total.token1 + BigInt(row.b),
        }),
        zero(),
      );
    };
    const deposits = sum("position_deposits", "token0_raw", "token1_raw"),
      changes = sum("liquidity_changes", "token0_raw", "token1_raw"),
      totals = this.collectionTotals(positionId),
      terminalDifferenceRecords = this.db
        .prepare(
          "SELECT * FROM v4_terminal_differences WHERE position_id=? ORDER BY token_index,created_at",
        )
        .all(positionId) as Record<string, unknown>[],
      terminalDifferences = terminalDifferenceRecords.reduce<TokenAmounts>(
        (a, row) => {
          const key: keyof TokenAmounts =
            Number(row.token_index) === 0 ? "token0" : "token1";
          a[key] += BigInt(String(row.amount_raw));
          return a;
        },
        zero(),
      ),
      gas = Number(
        (
          this.db
            .prepare(
              "SELECT COALESCE(SUM(usd_value),0) AS value FROM gas_costs WHERE position_id=?",
            )
            .get(positionId) as { value: number }
        ).value,
      ),
      cost = Number(
        (
          this.db
            .prepare(
              "SELECT COALESCE(SUM(execution_cost_usd),0) AS value FROM swaps WHERE position_id=?",
            )
            .get(positionId) as { value: number }
        ).value,
      );
    return {
      deposits,
      pendingPrincipal: {
        token0:
          changes.token0 - totals.principal.token0 - terminalDifferences.token0,
        token1:
          changes.token1 - totals.principal.token1 - terminalDifferences.token1,
      },
      withdrawnPrincipal: totals.principal,
      claimedFees: totals.fees,
      terminalDifferences,
      terminalDifferenceRecords,
      unclaimedFees: zero(),
      gasUsd: gas,
      executionCostsUsd: cost,
      events: [],
      allocations: [],
    };
  }
  recordReconciliation(id: string, positionId: string, details: unknown) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO reconciliation_runs(id,position_id,status,details_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        positionId,
        "complete",
        JSON.stringify(details, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
        new Date().toISOString(),
      );
  }
  listPositions() {
    return this.db
      .prepare(
        "SELECT id,token_id,pool_address,status,created_at FROM positions ORDER BY created_at",
      )
      .all() as Array<{
      id: string;
      token_id: string;
      pool_address: string;
      status: string;
      created_at: string;
    }>;
  }
  /** Local receipt-derived reconciliation is intentionally idempotent; chain readers may enrich it separately. */
  reconcileAll() {
    const at = new Date().toISOString(),
      run = this.db.transaction(() =>
        this.listPositions().map((position) => {
          const details = {
            positionId: position.id,
            observed: this.reconciliationDelta(position.id),
            source: "persisted receipt/log ledger",
            at,
          };
          this.recordReconciliation(
            `startup:${position.id}`,
            position.id,
            details,
          );
          return details;
        }),
      );
    return run();
  }
  safetyState() {
    const row = this.db
      .prepare("SELECT payload_json FROM operator_safety_state WHERE id=1")
      .get() as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) : undefined;
  }
  persistSafetyState(payload: unknown) {
    this.db
      .prepare(
        "INSERT INTO operator_safety_state(id,payload_json,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at",
      )
      .run(JSON.stringify(payload), new Date().toISOString());
  }
  activateLiveSafety(input: {
    actor: string;
    reason: string;
    activationAt: string;
    caps: { maxPositionValueUsd: number; maxApprovalValueUsd: number };
    assertReady: (
      state: Record<string, unknown> | undefined,
    ) => "ACTIVATE" | "ALREADY_LIVE";
  }) {
    return this.db
      .transaction(() => {
        const prior = this.safetyState() as Record<string, unknown> | undefined,
          action = input.assertReady(prior);
        if (!prior) throw new Error("SAFETY_ACTIVATION_DURABLE_STATE_MISSING");
        const capsMatch =
          prior.maxPositionValueUsd === input.caps.maxPositionValueUsd &&
          prior.maxApprovalValueUsd === input.caps.maxApprovalValueUsd;
        if (action === "ALREADY_LIVE" && capsMatch)
          return { changed: false, action, state: prior };
        const next = {
          ...prior,
          ...input.caps,
          ...(action === "ACTIVATE"
            ? {
                manualPause: false,
                executionEnabled: true,
                dryRun: false,
                emergencyPause: false,
                effectiveEmergencyPause: false,
                actor: input.actor,
                reason: input.reason,
                activationAt: input.activationAt,
              }
            : {}),
        };
        this.persistSafetyState(next);
        return { changed: true, action, state: next };
      })
      .immediate();
  }
  setManualPause(paused: boolean, actor: string, reason?: string) {
    const prior = this.safetyState() ?? {};
    this.persistSafetyState({
      ...prior,
      manualPause: paused,
      manualPauseActor: actor,
      manualPauseReason: reason?.trim() || undefined,
      manualPauseAt: new Date().toISOString(),
    });
  }
  canaryBudget() {
    return this.db.prepare("SELECT * FROM canary_budget WHERE id=1").get() as
      Record<string, unknown> | undefined;
  }
  canaryBudgetAvailable() {
    const row = this.canaryBudget();
    return row?.status === "AVAILABLE" && Number(row.attempts_used) === 0;
  }
  updateCanaryBudgetState(
    state: "APPROVAL_SUBMITTED" | "MINT_SUBMITTED",
    intentId: string,
  ) {
    return (
      this.db
        .prepare(
          "UPDATE canary_budget SET status=?,updated_at=? WHERE id=1 AND intent_id=? AND status IN ('CLAIMED','APPROVAL_SUBMITTED')",
        )
        .run(state, new Date().toISOString(), intentId).changes === 1
    );
  }
  finalizeCanaryBudget(
    intentId: string,
    succeeded: boolean,
    input: { failureReason?: string; remainingAllowanceRaw?: bigint } = {},
  ) {
    const at = new Date().toISOString(),
      state = succeeded ? "SUCCEEDED" : "FAILED",
      finish = this.db.transaction(() => {
        const changed =
          this.db
            .prepare(
              "UPDATE canary_budget SET status=?,attempts_used=1,failure_reason=?,remaining_allowance_raw=?,updated_at=? WHERE id=1 AND intent_id=? AND status NOT IN ('SUCCEEDED','FAILED')",
            )
            .run(
              state,
              input.failureReason ?? null,
              input.remainingAllowanceRaw?.toString() ?? null,
              at,
              intentId,
            ).changes === 1;
        if (changed)
          this.setManualPause(true, `canary-budget:${state.toLowerCase()}`);
        return changed;
      });
    return finish();
  }
  requestCanaryBudgetReset(now = Date.now(), ttlMs = 300_000) {
    const token = randomUUID(),
      hash = createHash("sha256").update(token).digest("hex"),
      expiresAt = new Date(now + ttlMs).toISOString();
    this.db
      .prepare(
        "UPDATE canary_budget SET reset_token_hash=?,reset_expires_at=?,updated_at=? WHERE id=1",
      )
      .run(hash, expiresAt, new Date(now).toISOString());
    return { token, expiresAt };
  }
  resetCanaryBudget(token: string, now = Date.now()) {
    const hash = createHash("sha256").update(token).digest("hex"),
      at = new Date(now).toISOString(),
      reset = this.db.transaction(() => {
        const row = this.canaryBudget();
        if (
          !row ||
          row.reset_token_hash !== hash ||
          !row.reset_expires_at ||
          Date.parse(String(row.reset_expires_at)) <= now
        )
          return false;
        this.db
          .prepare(
            "UPDATE canary_budget SET status='AVAILABLE',attempts_used=0,intent_id=NULL,failure_reason=NULL,remaining_allowance_raw=NULL,reset_token_hash=NULL,reset_expires_at=NULL,updated_at=? WHERE id=1",
          )
          .run(at);
        this.setManualPause(false, "canary-budget-manual-reset");
        return true;
      });
    return reset();
  }
  createPoolSelection(input: {
    userId: string;
    chatId: string;
    sessionId: string;
    poolAddress: string;
    factoryAddress: string;
    token0Address: string;
    token1Address: string;
    fee: number;
    tickSpacing: number;
    discoveryBlock: bigint;
    liquidity: bigint;
    tvlUsd?: number;
    tvlSource?: string;
    tvlObservedAtMs?: number;
    tvlFreshUntilMs?: number;
    tvlStatus?: string;
    initialized: boolean;
  }) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO canary_pool_selections(id,user_id,chat_id,session_id,pool_address,factory_address,token0_address,token1_address,fee,tick_spacing,discovery_block,liquidity_raw,tvl_usd,tvl_source,tvl_observed_at_ms,tvl_fresh_until_ms,tvl_status,initialized,superseded,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)",
      )
      .run(
        id,
        input.userId,
        input.chatId,
        input.sessionId,
        input.poolAddress,
        input.factoryAddress,
        input.token0Address,
        input.token1Address,
        input.fee,
        input.tickSpacing,
        input.discoveryBlock.toString(),
        input.liquidity.toString(),
        input.tvlUsd ?? null,
        input.tvlSource ?? null,
        input.tvlObservedAtMs ?? null,
        input.tvlFreshUntilMs ?? null,
        input.tvlStatus ?? "missing",
        input.initialized ? 1 : 0,
        new Date().toISOString(),
      );
    return this.poolSelection(id)!;
  }
  poolSelection(id: string) {
    return this.db
      .prepare("SELECT * FROM canary_pool_selections WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
  }
  supersedePoolSelections(
    userId: string,
    chatId: string,
    exceptSessionId?: string,
  ) {
    const suffix = exceptSessionId ? " AND session_id<>?" : "",
      args = exceptSessionId
        ? [userId, chatId, exceptSessionId]
        : [userId, chatId];
    return this.db
      .prepare(
        `UPDATE canary_pool_selections SET superseded=1 WHERE user_id=? AND chat_id=? AND superseded=0${suffix}`,
      )
      .run(...args).changes;
  }
  createConfirmation(input: {
    action: string;
    payload: unknown;
    expiresAt: string;
    owner: string;
    idempotencyKey: string;
    blockNumber?: string;
    priceObservedAt?: string;
  }) {
    const existing = this.db
      .prepare("SELECT * FROM confirmation_requests WHERE idempotency_key=?")
      .get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return existing;
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO confirmation_requests(id,idempotency_key,action,payload_json,state,owner,block_number,price_observed_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.idempotencyKey,
        input.action,
        JSON.stringify(input.payload, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
        "AWAITING_CONFIRMATION",
        input.owner,
        input.blockNumber ?? null,
        input.priceObservedAt ?? null,
        input.expiresAt,
        new Date().toISOString(),
      );
    return this.confirmation(id);
  }
  confirmation(id: string): Record<string, unknown> | undefined {
    const row = this.db
      .prepare("SELECT * FROM confirmation_requests WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (
      row.state === "AWAITING_CONFIRMATION" &&
      String(row.expires_at) < new Date().toISOString()
    ) {
      this.db
        .prepare(
          "UPDATE confirmation_requests SET state='EXPIRED',updated_at=? WHERE id=? AND state='AWAITING_CONFIRMATION'",
        )
        .run(new Date().toISOString(), id);
      return this.confirmation(id);
    }
    return row;
  }
  resolveConfirmation(
    id: string,
    owner: string,
    decision: "confirm" | "cancel",
    currentBlock?: string,
  ) {
    const row = this.confirmation(id);
    if (!row) throw new Error("unknown confirmation ID");
    if (row.owner !== owner) throw new Error("confirmation owner mismatch");
    if (row.state !== "AWAITING_CONFIRMATION")
      throw new Error(`confirmation is ${String(row.state)}`);
    if (decision === "cancel") {
      this.db
        .prepare(
          "UPDATE confirmation_requests SET state='CANCELLED',updated_at=? WHERE id=? AND state='AWAITING_CONFIRMATION'",
        )
        .run(new Date().toISOString(), id);
      return this.confirmation(id)!;
    }
    const stale =
      currentBlock !== undefined &&
      row.block_number !== null &&
      BigInt(currentBlock) > BigInt(String(row.block_number)) + 5n;
    if (stale || this.pendingTransactions() > 0) {
      this.db
        .prepare(
          "UPDATE confirmation_requests SET state='EXECUTION_BLOCKED',updated_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), id);
      throw new Error(
        stale
          ? "preview is stale; refresh and re-simulate"
          : "pending transaction detected; wait for reconciliation",
      );
    }
    this.db
      .prepare(
        "UPDATE confirmation_requests SET state='EXECUTION_BLOCKED',updated_at=? WHERE id=? AND state='AWAITING_CONFIRMATION'",
      )
      .run(new Date().toISOString(), id);
    return this.confirmation(id)!;
  }
  recoverConfirmations() {
    return this.db
      .prepare(
        "UPDATE confirmation_requests SET state='EXPIRED',updated_at=? WHERE state IN ('DRAFT','SIMULATED','AWAITING_CONFIRMATION') AND expires_at<?",
      )
      .run(new Date().toISOString(), new Date().toISOString()).changes;
  }
  session(owner: string) {
    const row = this.db
      .prepare("SELECT state_json FROM telegram_sessions WHERE owner=?")
      .get(owner) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) : undefined;
  }
  persistSession(owner: string, state: unknown) {
    this.db
      .prepare(
        "INSERT INTO telegram_sessions(owner,state_json,updated_at) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at",
      )
      .run(owner, jsonStringify(state), new Date().toISOString());
  }
  clearSession(owner: string) {
    this.db.prepare("DELETE FROM telegram_sessions WHERE owner=?").run(owner);
  }
  /** Atomic, restart-safe Telegram flow storage. Epoch milliseconds are used exclusively. */
  createTelegramFlow(input: {
    userId: string;
    chatId: string;
    state: Record<string, unknown>;
    now: number;
    ttlMs: number;
  }) {
    const scope = `${input.userId}:${input.chatId}`,
      sessionId = randomUUID(),
      expiresAtMs = computeExpiresAt(input.now, input.ttlMs),
      stateJson = jsonStringify(input.state),
      create = this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE telegram_flow_sessions SET status='expired',flow_revision=flow_revision+1,updated_at_ms=? WHERE scope=? AND status='active' AND expires_at_ms<=?",
          )
          .run(input.now, scope, input.now);
        this.db
          .prepare(
            "UPDATE telegram_flow_sessions SET status='superseded',flow_revision=flow_revision+1,updated_at_ms=? WHERE scope=? AND status='active'",
          )
          .run(input.now, scope);
        this.db
          .prepare(
            "INSERT INTO telegram_flow_sessions(session_id,scope,user_id,chat_id,state_json,status,flow_revision,created_at_ms,updated_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            sessionId,
            scope,
            input.userId,
            input.chatId,
            stateJson,
            "active",
            0,
            input.now,
            input.now,
            expiresAtMs,
          );
      });
    create();
    return {
      sessionId,
      userId: input.userId,
      chatId: input.chatId,
      state: input.state,
      status: "active" as const,
      flowRevision: 0,
      createdAtMs: input.now,
      updatedAtMs: input.now,
      expiresAtMs,
    };
  }
  private mapTelegramFlow(row: {
    session_id: string;
    user_id: string;
    chat_id: string;
    state_json: string;
    status: TelegramFlowStatus;
    flow_revision: number;
    created_at_ms: number;
    updated_at_ms: number;
    expires_at_ms: number;
  }): TelegramFlowSession {
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      chatId: row.chat_id,
      state: JSON.parse(row.state_json),
      status: row.status,
      flowRevision: Number(row.flow_revision),
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      expiresAtMs: row.expires_at_ms,
    };
  }
  /** Historical lookup used for callback ownership/audit. It may return a terminal flow. */
  telegramFlow(input: {
    userId: string;
    chatId: string;
    sessionId?: string;
    now: number;
  }): TelegramFlowSession | undefined {
    const scope = `${input.userId}:${input.chatId}`;
    if (input.sessionId)
      this.db
        .prepare(
          "UPDATE telegram_flow_sessions SET status='expired',flow_revision=flow_revision+1,updated_at_ms=? WHERE scope=? AND session_id=? AND status='active' AND expires_at_ms<=?",
        )
        .run(input.now, scope, input.sessionId, input.now);
    const clause = input.sessionId ? "scope=? AND session_id=?" : "scope=?",
      args = input.sessionId ? [scope, input.sessionId] : [scope],
      row = this.db
        .prepare(
          `SELECT * FROM telegram_flow_sessions WHERE ${clause} ORDER BY updated_at_ms DESC,created_at_ms DESC LIMIT 1`,
        )
        .get(...args) as
        Parameters<SqliteLedgerRepository["mapTelegramFlow"]>[0] | undefined;
    return row ? this.mapTelegramFlow(row) : undefined;
  }
  /** The only lookup suitable for routing new state-dependent Telegram text. */
  activeTelegramFlow(input: {
    userId: string;
    chatId: string;
    now: number;
  }): TelegramFlowSession | undefined {
    const scope = `${input.userId}:${input.chatId}`;
    const row = this.db
      .prepare(
        "SELECT * FROM telegram_flow_sessions WHERE scope=? AND status='active' AND expires_at_ms>? ORDER BY updated_at_ms DESC LIMIT 1",
      )
      .get(scope, input.now) as
      Parameters<SqliteLedgerRepository["mapTelegramFlow"]>[0] | undefined;
    return row ? this.mapTelegramFlow(row) : undefined;
  }
  transitionTelegramFlowCAS(input: {
    userId: string;
    chatId: string;
    sessionId: string;
    expectedRevision: number;
    nextState: Record<string, unknown>;
    expectedStatus?: TelegramFlowStatus;
    nextStatus?: TelegramFlowStatus;
    now: number;
    ttlMs?: number;
  }): TelegramFlowCASResult {
    const scope = `${input.userId}:${input.chatId}`,
      expiresAtMs = input.ttlMs === undefined
        ? null
        : computeExpiresAt(input.now, input.ttlMs),
      statusPredicate = input.expectedStatus ? " AND status=?" : "",
      expiryPredicate = input.expectedStatus === "active"
        ? " AND expires_at_ms>?"
        : "",
      predicateArgs = [
        scope,
        input.sessionId,
        input.expectedRevision,
        ...(input.expectedStatus ? [input.expectedStatus] : []),
        ...(input.expectedStatus === "active" ? [input.now] : []),
      ],
      updated = this.db
        .prepare(
          `UPDATE telegram_flow_sessions
           SET state_json=?,status=COALESCE(?,status),flow_revision=flow_revision+1,
               updated_at_ms=?,expires_at_ms=COALESCE(?,expires_at_ms)
           WHERE scope=? AND session_id=? AND flow_revision=?${statusPredicate}${expiryPredicate}`,
        )
        .run(
          jsonStringify(input.nextState),
          input.nextStatus ?? null,
          input.now,
          expiresAtMs,
          ...predicateArgs,
        );
    const current = this.telegramFlow({
      userId: input.userId,
      chatId: input.chatId,
      sessionId: input.sessionId,
      now: input.now,
    });
    const requestedNextKind = String(input.nextState.kind ?? "unknown");
    if (updated.changes && current)
      return {
        result: "APPLIED",
        expectedRevision: input.expectedRevision,
        observedRevision: input.expectedRevision,
        resultingRevision: current.flowRevision,
        previousKind: undefined,
        requestedNextKind,
        flow: current,
      };
    if (!current)
      return { result: "NOT_FOUND", expectedRevision: input.expectedRevision, requestedNextKind };
    const previousKind = String(current.state.kind ?? "unknown"),
      common = {
        expectedRevision: input.expectedRevision,
        observedRevision: current.flowRevision,
        previousKind,
        requestedNextKind,
        flow: current,
      };
    if (input.expectedStatus && current.status !== input.expectedStatus)
      return { result: "STATUS_CONFLICT", ...common };
    return { result: "REVISION_CONFLICT", ...common };
  }
  applyTelegramHydrationRender(input: {
    userId: string;
    chatId: string;
    sessionId: string;
    expectedRevision: number;
    state: Record<string, unknown>;
    now: number;
    ttlMs: number;
    selections: Array<{
      id: string;
      liquidity: bigint;
      refreshBlock?: bigint;
      eligibility: boolean;
      blockers: string[];
    }>;
  }) {
    const updateSelection = this.db.prepare(
        "UPDATE v4_pool_selections SET liquidity_raw=?,refresh_block=?,eligibility=?,blockers_json=? WHERE id=? AND superseded=0",
      ),
      run = this.db.transaction(() => {
        const result = this.transitionTelegramFlowCAS({
          userId: input.userId,
          chatId: input.chatId,
          sessionId: input.sessionId,
          expectedRevision: input.expectedRevision,
          expectedStatus: "active",
          nextState: input.state,
          now: input.now,
          ttlMs: input.ttlMs,
        });
        if (result.result !== "APPLIED") return result;
        for (const selection of input.selections)
          updateSelection.run(
            selection.liquidity.toString(),
            selection.refreshBlock?.toString() ?? null,
            selection.eligibility ? 1 : 0,
            JSON.stringify(selection.blockers),
            selection.id,
          );
        return result;
      });
    return run();
  }
  cancelTelegramFlow(input: {
    userId: string;
    chatId: string;
    sessionId: string;
    expectedRevision: number;
    state: Record<string, unknown>;
    now: number;
  }) {
    return this.transitionTelegramFlowCAS({
      userId: input.userId,
      chatId: input.chatId,
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      expectedStatus: "active",
      nextStatus: "cancelled",
      nextState: input.state,
      now: input.now,
    });
  }
  recoverTelegramFlows(now: number) {
    return this.db
      .prepare(
        "UPDATE telegram_flow_sessions SET status='expired',flow_revision=flow_revision+1,updated_at_ms=? WHERE status='active' AND expires_at_ms<=?",
      )
      .run(now, now).changes;
  }
  telegramFlowDiagnostics(input: {
    userId: string;
    chatId: string;
    now: number;
  }) {
    const scope = `${input.userId}:${input.chatId}`;
    return (
      this.db
        .prepare(
          "SELECT session_id,state_json,status,flow_revision,created_at_ms,updated_at_ms,expires_at_ms FROM telegram_flow_sessions WHERE scope=? ORDER BY updated_at_ms DESC,created_at_ms DESC",
        )
        .all(scope) as Array<{
        session_id: string;
        state_json: string;
        status: TelegramFlowStatus;
        flow_revision: number;
        created_at_ms: number;
        updated_at_ms: number;
        expires_at_ms: number;
      }>
    ).map((row) => ({
      sessionId: row.session_id,
      state: JSON.parse(row.state_json),
      status: row.status,
      flowRevision: Number(row.flow_revision),
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      expiresAtMs: row.expires_at_ms,
      qualifiesAsActive:
        row.status === "active" && row.expires_at_ms > input.now,
    }));
  }
  telegramFlowAudit(now: number) {
    return (
      this.db
        .prepare(
          "SELECT session_id,state_json,status,flow_revision,created_at_ms,updated_at_ms,expires_at_ms FROM telegram_flow_sessions ORDER BY updated_at_ms DESC,created_at_ms DESC",
        )
        .all() as Array<{
        session_id: string;
        state_json: string;
        status: TelegramFlowStatus;
        flow_revision: number;
        created_at_ms: number;
        updated_at_ms: number;
        expires_at_ms: number;
      }>
    ).map((row) => ({
      sessionId: row.session_id,
      state: JSON.parse(row.state_json),
      status: row.status,
      flowRevision: Number(row.flow_revision),
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      expiresAtMs: row.expires_at_ms,
      qualifiesAsActive: row.status === "active" && row.expires_at_ms > now,
    }));
  }
  pendingTransactions() {
    return Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM transaction_intents WHERE state='submitted'",
          )
          .get() as { count: number }
      ).count,
    );
  }
  acquireNonceMutex(wallet: string, nonce: bigint, ttlSeconds = 300) {
    const key = wallet.trim().toLowerCase(),
      now = new Date(),
      acquiredAt = now.toISOString(),
      expires = new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      acquire = () =>
        this.db
          .prepare(
            "INSERT INTO nonce_mutex(wallet,nonce,acquired_at,expires_at) VALUES(?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET nonce=excluded.nonce,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at WHERE nonce_mutex.expires_at<excluded.acquired_at",
          )
          .run(key, nonce.toString(), acquiredAt, expires).changes === 1;
    return withSqliteTransientRetrySync({
      operation: "chain_nonce_mutex_acquire",
      run: () => acquire(),
    });
  }
  releaseNonceMutex(wallet: string) {
    return withSqliteTransientRetrySync({
      operation: "chain_nonce_mutex_release",
      run: () =>
        this.db
          .prepare("DELETE FROM nonce_mutex WHERE lower(wallet)=?")
          .run(wallet.trim().toLowerCase()).changes > 0,
    });
  }
  acquireChainNonceMutex(
    chainId: number,
    wallet: string,
    nonce: bigint,
    ttlSeconds = 300,
  ) {
    if (!Number.isSafeInteger(chainId) || chainId <= 0)
      throw new Error("CHAIN_ID_INVALID");
    const key = wallet.trim().toLowerCase(),
      now = new Date(),
      expires = new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      acquire = this.db.transaction(() => {
        this.db
          .prepare("DELETE FROM chain_nonce_mutex WHERE expires_at<?")
          .run(now.toISOString());
        if (
          this.db
            .prepare(
              "SELECT 1 FROM chain_nonce_mutex WHERE chain_id=? AND lower(wallet_address)=?",
            )
            .get(chainId, key)
        )
          return false;
        return (
          this.db
            .prepare(
              "INSERT OR IGNORE INTO chain_nonce_mutex(chain_id,wallet_address,nonce,acquired_at,expires_at) VALUES(?,?,?,?,?)",
            )
            .run(chainId, key, nonce.toString(), now.toISOString(), expires)
            .changes === 1
        );
      });
    return acquire();
  }
  releaseChainNonceMutex(chainId: number, wallet: string) {
    return (
      this.db
        .prepare(
          "DELETE FROM chain_nonce_mutex WHERE chain_id=? AND lower(wallet_address)=?",
        )
        .run(chainId, wallet.trim().toLowerCase()).changes > 0
    );
  }
  upsertChainPosition(input: {
    chainId: number;
    protocol: string;
    positionIdentifier: string;
    legacyPositionId?: string;
    owner?: string;
    provenance: "BOT_OPERATIONAL" | "MANUAL_EXTERNAL";
    lifecycleState: string;
    payload?: unknown;
  }) {
    const at = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO chain_positions(chain_id,protocol,position_identifier,legacy_position_id,owner_address,provenance,lifecycle_state,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain_id,protocol,position_identifier) DO UPDATE SET owner_address=excluded.owner_address,provenance=CASE WHEN chain_positions.provenance='BOT_OPERATIONAL' THEN chain_positions.provenance ELSE excluded.provenance END,lifecycle_state=excluded.lifecycle_state,payload_json=excluded.payload_json,updated_at=excluded.updated_at",
      )
      .run(
        input.chainId,
        input.protocol,
        input.positionIdentifier,
        input.legacyPositionId ?? null,
        input.owner?.toLowerCase() ?? null,
        input.provenance,
        input.lifecycleState,
        jsonStringify(input.payload ?? {}),
        at,
        at,
      );
    return this.chainPosition(
      input.chainId,
      input.protocol,
      input.positionIdentifier,
    )!;
  }
  chainPosition(chainId: number, protocol: string, positionIdentifier: string) {
    return this.db
      .prepare(
        "SELECT * FROM chain_positions WHERE chain_id=? AND protocol=? AND position_identifier=?",
      )
      .get(chainId, protocol, positionIdentifier) as
      Record<string, unknown> | undefined;
  }
  chainPositions(chainId: number, protocol?: string) {
    return (
      protocol
        ? this.db
            .prepare(
              "SELECT * FROM chain_positions WHERE chain_id=? AND protocol=? ORDER BY position_identifier",
            )
            .all(chainId, protocol)
        : this.db
            .prepare(
              "SELECT * FROM chain_positions WHERE chain_id=? ORDER BY protocol,position_identifier",
            )
            .all(chainId)
    ) as Record<string, unknown>[];
  }
  upsertChainToken(input: {
    chainId: number;
    address: string;
    symbol: string;
    decimals: number;
    metadata?: unknown;
    refreshedAtMs?: number;
  }) {
    this.db
      .prepare(
        "INSERT INTO chain_tokens(chain_id,address,symbol,decimals,metadata_json,refreshed_at_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(chain_id,address) DO UPDATE SET symbol=excluded.symbol,decimals=excluded.decimals,metadata_json=excluded.metadata_json,refreshed_at_ms=excluded.refreshed_at_ms",
      )
      .run(
        input.chainId,
        input.address.toLowerCase(),
        input.symbol,
        input.decimals,
        jsonStringify(input.metadata ?? {}),
        input.refreshedAtMs ?? Date.now(),
      );
    return this.db
      .prepare(
        "SELECT * FROM chain_tokens WHERE chain_id=? AND lower(address)=?",
      )
      .get(input.chainId, input.address.toLowerCase()) as Record<
      string,
      unknown
    >;
  }
  upsertChainPool(input: {
    chainId: number;
    protocol: string;
    poolAddress: string;
    token0: string;
    token1: string;
    fee?: number;
    tickSpacing?: number;
    state: unknown;
    validationStatus: string;
    blockerReason?: string;
    updatedAtMs?: number;
  }) {
    const at = input.updatedAtMs ?? Date.now();
    this.db
      .prepare(
        "INSERT INTO chain_pools(chain_id,protocol,pool_address,token0_address,token1_address,fee,tick_spacing,state_json,validation_status,blocker_reason,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain_id,protocol,pool_address) DO UPDATE SET token0_address=excluded.token0_address,token1_address=excluded.token1_address,fee=excluded.fee,tick_spacing=excluded.tick_spacing,state_json=excluded.state_json,validation_status=excluded.validation_status,blocker_reason=excluded.blocker_reason,updated_at_ms=excluded.updated_at_ms",
      )
      .run(
        input.chainId,
        input.protocol,
        input.poolAddress.toLowerCase(),
        input.token0.toLowerCase(),
        input.token1.toLowerCase(),
        input.fee ?? null,
        input.tickSpacing ?? null,
        jsonStringify(input.state),
        input.validationStatus,
        input.blockerReason ?? null,
        at,
      );
    return this.db
      .prepare(
        "SELECT * FROM chain_pools WHERE chain_id=? AND protocol=? AND lower(pool_address)=?",
      )
      .get(
        input.chainId,
        input.protocol,
        input.poolAddress.toLowerCase(),
      ) as Record<string, unknown>;
  }
  markChainPoolStale(
    chainId: number,
    protocol: string,
    poolAddress: string,
    blockerReason: string,
    updatedAtMs = Date.now(),
  ) {
    this.db
      .prepare(
        "UPDATE chain_pools SET validation_status='STALE',blocker_reason=?,updated_at_ms=? WHERE chain_id=? AND protocol=? AND lower(pool_address)=?",
      )
      .run(
        blockerReason.slice(0, 500),
        updatedAtMs,
        chainId,
        protocol,
        poolAddress.toLowerCase(),
      );
    return this.db
      .prepare(
        "SELECT * FROM chain_pools WHERE chain_id=? AND protocol=? AND lower(pool_address)=?",
      )
      .get(chainId, protocol, poolAddress.toLowerCase()) as
      Record<string, unknown> | undefined;
  }
  recordChainPositionBlocker(
    chainId: number,
    protocol: string,
    positionIdentifier: string,
    blockerReason: string,
  ) {
    const prior = this.chainPosition(chainId, protocol, positionIdentifier);
    if (!prior) return undefined;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(String(prior.payload_json));
    } catch {}
    payload = {
      ...payload,
      evidenceStatus: "STALE",
      blockerReason: blockerReason.slice(0, 500),
      executionReadinessElevated: false,
    };
    this.db
      .prepare(
        "UPDATE chain_positions SET payload_json=?,updated_at=? WHERE chain_id=? AND protocol=? AND position_identifier=?",
      )
      .run(
        jsonStringify(payload),
        new Date().toISOString(),
        chainId,
        protocol,
        positionIdentifier,
      );
    return this.chainPosition(chainId, protocol, positionIdentifier);
  }
  upsertChainRegistryCursor(input: {
    chainId: number;
    protocol: string;
    cursorKind: string;
    nextBlock: bigint | string;
    finalityConfirmations: number;
    state?: unknown;
  }) {
    const at = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO chain_registry_cursors(chain_id,protocol,cursor_kind,next_block,finality_confirmations,state_json,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(chain_id,protocol,cursor_kind) DO UPDATE SET next_block=excluded.next_block,finality_confirmations=excluded.finality_confirmations,state_json=excluded.state_json,updated_at=excluded.updated_at",
      )
      .run(
        input.chainId,
        input.protocol,
        input.cursorKind,
        String(input.nextBlock),
        input.finalityConfirmations,
        jsonStringify(input.state ?? {}),
        at,
      );
    return this.chainRegistryCursor(
      input.chainId,
      input.protocol,
      input.cursorKind,
    )!;
  }
  chainRegistryCursor(chainId: number, protocol: string, cursorKind: string) {
    return this.db
      .prepare(
        "SELECT * FROM chain_registry_cursors WHERE chain_id=? AND protocol=? AND cursor_kind=?",
      )
      .get(chainId, protocol, cursorKind) as
      Record<string, unknown> | undefined;
  }
  createChainV3Workflow(input: {
    chainId: number;
    protocol: string;
    workflowId: string;
    idempotencyKey: string;
    action: string;
    state?: string;
    positionIdentifier?: string;
    deploymentVersion: number;
    wallet: string;
    fundingToken?: string;
    previewRevision: number;
    capabilitySnapshot: unknown;
    safetyEvidence: unknown;
    exposureEvidence: unknown;
    feeEvidence: unknown;
    preview: unknown;
    commitmentUsd?: number;
  }) {
    const at = new Date().toISOString(),
      state = input.state ?? "PREVIEWED";
    this.db
      .prepare(
        "INSERT INTO chain_v3_workflows(chain_id,protocol,workflow_id,idempotency_key,action,state,position_identifier,deployment_version,wallet_address,funding_token,preview_revision,capability_snapshot_json,safety_evidence_json,exposure_evidence_json,fee_evidence_json,preview_json,commitment_usd,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain_id,protocol,idempotency_key) DO NOTHING",
      )
      .run(
        input.chainId,
        input.protocol,
        input.workflowId,
        input.idempotencyKey,
        input.action,
        state,
        input.positionIdentifier ?? null,
        input.deploymentVersion,
        input.wallet.toLowerCase(),
        input.fundingToken?.toLowerCase() ?? null,
        input.previewRevision,
        jsonStringify(input.capabilitySnapshot),
        jsonStringify(input.safetyEvidence),
        jsonStringify(input.exposureEvidence),
        jsonStringify(input.feeEvidence),
        jsonStringify(input.preview),
        input.commitmentUsd ?? null,
        at,
        at,
      );
    return (
      this.chainV3Workflow(input.chainId, input.protocol, input.workflowId) ??
      (this.db
        .prepare(
          "SELECT * FROM chain_v3_workflows WHERE chain_id=? AND protocol=? AND idempotency_key=?",
        )
        .get(input.chainId, input.protocol, input.idempotencyKey) as Record<
        string,
        unknown
      >)
    );
  }
  chainV3Workflow(chainId: number, protocol: string, workflowId: string) {
    return this.db
      .prepare(
        "SELECT * FROM chain_v3_workflows WHERE chain_id=? AND protocol=? AND workflow_id=?",
      )
      .get(chainId, protocol, workflowId) as
      Record<string, unknown> | undefined;
  }
  transitionChainV3Workflow(input: {
    chainId: number;
    protocol: string;
    workflowId: string;
    from: string;
    to: string;
    authorizationRevision?: number;
    replacementPositionIdentifier?: string;
    lastError?: string;
  }) {
    const at = new Date().toISOString(),
      changed = this.db
        .prepare(
          "UPDATE chain_v3_workflows SET state=?,authorization_revision=COALESCE(?,authorization_revision),replacement_position_identifier=COALESCE(?,replacement_position_identifier),last_error=COALESCE(?,last_error),updated_at=? WHERE chain_id=? AND protocol=? AND workflow_id=? AND state=?",
        )
        .run(
          input.to,
          input.authorizationRevision ?? null,
          input.replacementPositionIdentifier ?? null,
          input.lastError ?? null,
          at,
          input.chainId,
          input.protocol,
          input.workflowId,
          input.from,
        );
    if (changed.changes !== 1)
      throw new Error("CHAIN_V3_WORKFLOW_TRANSITION_CONFLICT");
    return this.chainV3Workflow(
      input.chainId,
      input.protocol,
      input.workflowId,
    )!;
  }
  recordChainV3LifecycleEvent(input: {
    chainId: number;
    protocol: string;
    workflowId: string;
    semanticStage: string;
    eventKind: string;
    journalId?: string;
    expectedHash?: string;
    payload?: unknown;
  }) {
    const at = new Date().toISOString(),
      payload = jsonStringify(input.payload ?? {}),
      changed = this.db
        .prepare(
          "INSERT OR IGNORE INTO chain_v3_lifecycle_events(chain_id,protocol,workflow_id,semantic_stage,event_kind,journal_id,expected_hash,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.chainId,
          input.protocol,
          input.workflowId,
          input.semanticStage,
          input.eventKind,
          input.journalId ?? null,
          input.expectedHash?.toLowerCase() ?? null,
          payload,
          at,
        );
    const row = this.db
      .prepare(
        "SELECT * FROM chain_v3_lifecycle_events WHERE chain_id=? AND protocol=? AND workflow_id=? AND semantic_stage=? AND event_kind=?",
      )
      .get(
        input.chainId,
        input.protocol,
        input.workflowId,
        input.semanticStage,
        input.eventKind,
      ) as Record<string, unknown>;
    if (
      !changed.changes &&
      (String(row.payload_json) !== payload ||
        String(row.expected_hash ?? "").toLowerCase() !==
          (input.expectedHash ?? "").toLowerCase())
    )
      throw new Error("CHAIN_V3_LIFECYCLE_EVENT_CONFLICT");
    return row;
  }
  recordChainAccountingEvent(input: {
    chainId: number;
    protocol: string;
    workflowId: string;
    semanticStage: string;
    eventKind: string;
    positionIdentifier?: string;
    tokenAddress?: string;
    amountRaw?: bigint;
    usdValue?: number;
    valuationStatus: string;
    evidence?: unknown;
  }) {
    const at = new Date().toISOString(),
      token = input.tokenAddress?.toLowerCase() ?? "",
      payload = jsonStringify(input.evidence ?? {}),
      changed = this.db
        .prepare(
          "INSERT OR IGNORE INTO chain_accounting_events(chain_id,protocol,workflow_id,semantic_stage,event_kind,position_identifier,token_address,amount_raw,usd_value,valuation_status,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.chainId,
          input.protocol,
          input.workflowId,
          input.semanticStage,
          input.eventKind,
          input.positionIdentifier ?? null,
          token,
          input.amountRaw?.toString() ?? null,
          input.usdValue ?? null,
          input.valuationStatus,
          payload,
          at,
        );
    const row = this.db
      .prepare(
        "SELECT * FROM chain_accounting_events WHERE chain_id=? AND protocol=? AND workflow_id=? AND semantic_stage=? AND event_kind=? AND token_address=?",
      )
      .get(
        input.chainId,
        input.protocol,
        input.workflowId,
        input.semanticStage,
        input.eventKind,
        token,
      ) as Record<string, unknown>;
    if (
      !changed.changes &&
      (String(row.amount_raw ?? "") !== String(input.amountRaw ?? "") ||
        String(row.evidence_json) !== payload)
    )
      throw new Error("CHAIN_ACCOUNTING_EVENT_CONFLICT");
    return row;
  }
  appendRealizedPnlEvent(input: {
    eventId: string;
    eventKind: "CLAIM" | "CLOSE";
    protocol: string;
    strategyType?: string;
    positionIdentity?: string;
    ladderIdentity?: string;
    workflowIdentity: string;
    journalStage: string;
    transactionHash: string;
    blockNumber: bigint;
    blockHash?: string;
    economicFinalAtMs: number;
    capitalBasisUsd?: string;
    returnedPrincipalUsd?: string;
    newlyRealizedFeesUsd?: string;
    realizedPnlUsd?: string;
    token0Raw?: bigint;
    token1Raw?: bigint;
    token0Decimals?: number;
    token1Decimals?: number;
    valuationStatus: "AVAILABLE" | "INCOMPLETE";
    valuationEvidence: unknown;
    closeReason?: string;
    presentationMetadata?: unknown;
  }) {
    if (!Number.isSafeInteger(input.economicFinalAtMs) || input.economicFinalAtMs < 0)
      throw new Error("REALIZED_PNL_ECONOMIC_FINAL_TIMESTAMP_INVALID");
    const at = Date.now(), evidence = jsonStringify(input.valuationEvidence), metadata = input.presentationMetadata === undefined ? null : jsonStringify(input.presentationMetadata);
    const changed = this.db.prepare("INSERT OR IGNORE INTO realized_pnl_events(event_id,event_kind,protocol,strategy_type,position_identity,ladder_identity,workflow_identity,journal_stage,transaction_hash,block_number,block_hash,economic_final_at_ms,economic_final_source,capital_basis_usd,returned_principal_usd,newly_realized_fees_usd,realized_pnl_usd,token0_raw,token1_raw,token0_decimals,token1_decimals,valuation_status,valuation_evidence_json,close_reason,presentation_metadata_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'RECEIPT_BLOCK_TIMESTAMP',?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(input.eventId,input.eventKind,input.protocol,input.strategyType??null,input.positionIdentity??null,input.ladderIdentity??null,input.workflowIdentity,input.journalStage,input.transactionHash.toLowerCase(),input.blockNumber.toString(),input.blockHash?.toLowerCase()??null,input.economicFinalAtMs,input.capitalBasisUsd??null,input.returnedPrincipalUsd??null,input.newlyRealizedFeesUsd??null,input.realizedPnlUsd??null,input.token0Raw?.toString()??null,input.token1Raw?.toString()??null,input.token0Decimals??null,input.token1Decimals??null,input.valuationStatus,evidence,input.closeReason??null,metadata,at);
    let row = this.db.prepare("SELECT * FROM realized_pnl_events WHERE workflow_identity=? AND journal_stage=? AND transaction_hash=? AND event_kind=?").get(input.workflowIdentity,input.journalStage,input.transactionHash.toLowerCase(),input.eventKind) as Record<string, unknown> | undefined;
    if (!row) throw new Error("REALIZED_PNL_EVENT_PERSISTENCE_FAILED");
    if (!changed.changes) {
      const immutable:[[string,unknown],...Array<[string,unknown]>]=[
        ["event_id",input.eventId],["event_kind",input.eventKind],["protocol",input.protocol],["strategy_type",input.strategyType??null],["position_identity",input.positionIdentity??null],["ladder_identity",input.ladderIdentity??null],["workflow_identity",input.workflowIdentity],["journal_stage",input.journalStage],["transaction_hash",input.transactionHash.toLowerCase()],["block_number",input.blockNumber.toString()],["block_hash",input.blockHash?.toLowerCase()??null],["economic_final_at_ms",input.economicFinalAtMs],["token0_raw",input.token0Raw?.toString()??null],["token1_raw",input.token1Raw?.toString()??null],["token0_decimals",input.token0Decimals??null],["token1_decimals",input.token1Decimals??null],
      ];
      if(immutable.some(([field,value])=>row![field]!==value))throw new Error("REALIZED_PNL_EVENT_IDENTITY_CONFLICT");
      if(String(row.valuation_status)==="AVAILABLE"){
        if(input.valuationStatus==="AVAILABLE"&&(row.newly_realized_fees_usd!==(input.newlyRealizedFeesUsd??null)||row.realized_pnl_usd!==(input.realizedPnlUsd??null)))throw new Error("REALIZED_PNL_EVENT_ECONOMIC_CONFLICT");
      }else if(input.valuationStatus==="AVAILABLE"){
        if(input.eventKind!=="CLAIM"||input.newlyRealizedFeesUsd===undefined||input.realizedPnlUsd===undefined)throw new Error("REALIZED_PNL_EVENT_REPAIR_INVALID");
        this.db.prepare("UPDATE realized_pnl_events SET newly_realized_fees_usd=?,realized_pnl_usd=?,valuation_status='AVAILABLE',valuation_evidence_json=?,presentation_metadata_json=COALESCE(?,presentation_metadata_json) WHERE event_id=? AND valuation_status='INCOMPLETE'").run(input.newlyRealizedFeesUsd,input.realizedPnlUsd,evidence,metadata,input.eventId);
      }else if(String(row.valuation_evidence_json)!==evidence){
        this.db.prepare("UPDATE realized_pnl_events SET valuation_evidence_json=? WHERE event_id=? AND valuation_status='INCOMPLETE'").run(evidence,input.eventId);
      }
      row=this.db.prepare("SELECT * FROM realized_pnl_events WHERE event_id=?").get(input.eventId) as Record<string,unknown>;
    }
    this.db.prepare("INSERT OR IGNORE INTO realized_pnl_coverage(coverage_key,started_at_ms,source,created_at_ms) VALUES('v1',?,'FIRST_CANONICAL_REALIZED_EVENT',?)").run(input.economicFinalAtMs,at);
    return row;
  }
  repairCloseRealizedFeeAttribution(input: {
    eventId: string;
    newlyRealizedFeesUsd?: string;
    valuationEvidence: unknown;
  }) {
    const evidence=jsonStringify(input.valuationEvidence),row=this.db.prepare("SELECT * FROM realized_pnl_events WHERE event_id=?").get(input.eventId) as Record<string,unknown>|undefined;
    if(!row||String(row.event_kind)!=="CLOSE")throw new Error("REALIZED_PNL_CLOSE_FEE_REPAIR_EVENT_INVALID");
    const prior=row.newly_realized_fees_usd===null?undefined:String(row.newly_realized_fees_usd);
    if(prior!==undefined&&input.newlyRealizedFeesUsd!==undefined&&prior!==input.newlyRealizedFeesUsd)throw new Error("REALIZED_PNL_CLOSE_FEE_REPAIR_CONFLICT");
    if(prior!==undefined)return {changed:0,row};
    const changed=input.newlyRealizedFeesUsd===undefined
      ? String(row.valuation_evidence_json)===evidence?0:this.db.prepare("UPDATE realized_pnl_events SET valuation_evidence_json=? WHERE event_id=? AND event_kind='CLOSE' AND newly_realized_fees_usd IS NULL").run(evidence,input.eventId).changes
      : this.db.prepare("UPDATE realized_pnl_events SET newly_realized_fees_usd=?,valuation_evidence_json=? WHERE event_id=? AND event_kind='CLOSE' AND newly_realized_fees_usd IS NULL").run(input.newlyRealizedFeesUsd,evidence,input.eventId).changes;
    return {changed,row:this.db.prepare("SELECT * FROM realized_pnl_events WHERE event_id=?").get(input.eventId) as Record<string,unknown>};
  }
  realizedPnlEventsBetween(startMs: number, endMs: number) {
    return this.db.prepare("SELECT * FROM realized_pnl_events WHERE economic_final_at_ms>=? AND economic_final_at_ms<? ORDER BY economic_final_at_ms,event_id").all(startMs,endMs) as Record<string, unknown>[];
  }
  realizedPnlCoverage() { return this.db.prepare("SELECT * FROM realized_pnl_coverage WHERE coverage_key='v1'").get() as Record<string, unknown> | undefined; }
  ensurePnlCardDelivery(input: { deliveryId: string; cardKind: "CLOSE" | "DAILY"; economicEventId?: string; requestedDayWib?: string; chatIdentity: string; metadata?: unknown }) {
    const at=Date.now(), metadata=jsonStringify(input.metadata??{});
    this.db.prepare("INSERT OR IGNORE INTO pnl_card_deliveries(delivery_id,card_kind,economic_event_id,requested_day_wib,chat_identity,render_status,delivery_status,metadata_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,'PENDING','PENDING',?,?,?)").run(input.deliveryId,input.cardKind,input.economicEventId??null,input.requestedDayWib??null,input.chatIdentity,metadata,at,at);
    return this.db.prepare("SELECT * FROM pnl_card_deliveries WHERE card_kind=? AND chat_identity=? AND ((?='CLOSE' AND economic_event_id=?) OR (?='DAILY' AND requested_day_wib=?))").get(input.cardKind,input.chatIdentity,input.cardKind,input.economicEventId??'',input.cardKind,input.requestedDayWib??'') as Record<string,unknown>;
  }
  recoverPnlCardDeliveryClaims(nowMs: number, leaseTimeoutMs: number) {
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(leaseTimeoutMs) || leaseTimeoutMs < 1)
      throw new Error("PNL_CARD_DELIVERY_RECOVERY_INPUT_INVALID");
    const expiredBefore=nowMs-leaseTimeoutMs;
    const definitelyUnsent=this.db.prepare("UPDATE pnl_card_deliveries SET delivery_status='PENDING',error_code='CLAIM_LEASE_EXPIRED_BEFORE_SEND',updated_at_ms=? WHERE delivery_status='SENDING' AND send_started_at_ms IS NULL AND attempted_at_ms<=?").run(nowMs,expiredBefore).changes;
    const ambiguous=this.db.prepare("UPDATE pnl_card_deliveries SET delivery_status='DELIVERY_UNCERTAIN',error_code='TELEGRAM_SEND_OUTCOME_AMBIGUOUS_AFTER_CRASH',updated_at_ms=? WHERE delivery_status='SENDING' AND send_started_at_ms IS NOT NULL AND attempted_at_ms<=?").run(nowMs,expiredBefore).changes;
    return {definitelyUnsent,ambiguous};
  }
  duePnlCardDeliveries(input: { nowMs: number; retryDelayMs: number; limit: number }) {
    const limit=Math.max(1,Math.min(8,Math.floor(input.limit))),dueBefore=input.nowMs-Math.max(0,input.retryDelayMs);
    return this.db.prepare("SELECT d.* FROM pnl_card_deliveries d JOIN realized_pnl_events e ON e.event_id=d.economic_event_id AND e.event_kind='CLOSE' WHERE d.card_kind='CLOSE' AND d.delivery_status='PENDING' AND (d.attempted_at_ms IS NULL OR d.updated_at_ms<=?) ORDER BY CASE WHEN d.attempted_at_ms IS NULL THEN 0 ELSE 1 END,d.updated_at_ms,d.delivery_id LIMIT ?").all(dueBefore,limit) as Record<string,unknown>[];
  }
  claimPnlCardDelivery(deliveryId: string, consumerSource: "TELEGRAM_EVENT_DRIVEN"|"RECONCILE_FALLBACK"="RECONCILE_FALLBACK") {
    const at=Date.now();
    const changed=this.db.prepare("UPDATE pnl_card_deliveries SET delivery_status='SENDING',attempted_at_ms=?,send_started_at_ms=NULL,attempt_count=attempt_count+1,consumer_source=?,error_code=NULL,updated_at_ms=? WHERE delivery_id=? AND delivery_status='PENDING'").run(at,consumerSource,at,deliveryId);
    return changed.changes===1 ? this.db.prepare("SELECT * FROM pnl_card_deliveries WHERE delivery_id=?").get(deliveryId) as Record<string,unknown> : undefined;
  }
  markPnlCardDeliverySendStarted(deliveryId: string, at=Date.now()) {
    const changed=this.db.prepare("UPDATE pnl_card_deliveries SET send_started_at_ms=?,updated_at_ms=? WHERE delivery_id=? AND delivery_status='SENDING' AND send_started_at_ms IS NULL").run(at,at,deliveryId);
    if(changed.changes!==1)throw new Error("PNL_CARD_DELIVERY_SEND_BOUNDARY_CONFLICT");
  }
  finalizePnlCardDelivery(input: { deliveryId: string; delivered: boolean; uncertain?: boolean; retryable?: boolean; messageId?: string|number|null; renderStatus: "RENDERED"|"FALLBACK_TEXT"|"FAILED"; errorCode?: string }) {
    const at=Date.now(), status=input.delivered?"DELIVERED":input.uncertain?"DELIVERY_UNCERTAIN":input.retryable?"PENDING":"FAILED";
    const changed=this.db.prepare("UPDATE pnl_card_deliveries SET render_status=?,delivery_status=?,telegram_message_id=?,delivered_at_ms=?,send_started_at_ms=CASE WHEN ?='PENDING' THEN NULL ELSE send_started_at_ms END,error_code=?,updated_at_ms=? WHERE delivery_id=? AND delivery_status='SENDING'").run(input.renderStatus,status,input.messageId===undefined||input.messageId===null?null:String(input.messageId),input.delivered?at:null,status,input.errorCode??null,at,input.deliveryId);
    if(changed.changes!==1) throw new Error("PNL_CARD_DELIVERY_FINALIZATION_CONFLICT");
  }
  commitChainExposure(input: {
    chainId: number;
    protocol: string;
    workflowId: string;
    provenance: "BOT_OPERATIONAL" | "MANUAL_EXTERNAL";
    committedUsd?: number;
    valuationStatus: "AVAILABLE" | "UNAVAILABLE";
    valuationSource?: string;
    valuationObservedAt?: string;
    evidence: unknown;
  }) {
    this.db
      .prepare(
        "INSERT INTO chain_exposure_commitments(chain_id,protocol,workflow_id,provenance,committed_usd,valuation_status,valuation_source,valuation_observed_at,evidence_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(chain_id,protocol,workflow_id) DO NOTHING",
      )
      .run(
        input.chainId,
        input.protocol,
        input.workflowId,
        input.provenance,
        input.committedUsd ?? null,
        input.valuationStatus,
        input.valuationSource ?? null,
        input.valuationObservedAt ?? null,
        jsonStringify(input.evidence),
      );
    return this.db
      .prepare(
        "SELECT * FROM chain_exposure_commitments WHERE chain_id=? AND protocol=? AND workflow_id=?",
      )
      .get(input.chainId, input.protocol, input.workflowId) as Record<
      string,
      unknown
    >;
  }
  releaseChainExposure(chainId: number, protocol: string, workflowId: string) {
    const at = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE chain_exposure_commitments SET released_at=COALESCE(released_at,?) WHERE chain_id=? AND protocol=? AND workflow_id=?",
      )
      .run(at, chainId, protocol, workflowId);
    return this.db
      .prepare(
        "SELECT * FROM chain_exposure_commitments WHERE chain_id=? AND protocol=? AND workflow_id=?",
      )
      .get(chainId, protocol, workflowId) as
      Record<string, unknown> | undefined;
  }
  unresolvedChainTransactions(chainId: number, wallet?: string) {
    const row = (
      wallet
        ? this.db
            .prepare(
              "SELECT COUNT(*) count FROM chain_transaction_journal WHERE chain_id=? AND lower(wallet_address)=? AND status IN ('PREPARED','SUBMITTED')",
            )
            .get(chainId, wallet.toLowerCase())
        : this.db
            .prepare(
              "SELECT COUNT(*) count FROM chain_transaction_journal WHERE chain_id=? AND status IN ('PREPARED','SUBMITTED')",
            )
            .get(chainId)
    ) as { count: number };
    return row.count;
  }
  persistChainPreparedTransaction(input: {
    chainId: number;
    chainKey: string;
    protocol: string;
    journalId: string;
    wallet: string;
    workflowIdentity: string;
    semanticStage: string;
    attempt: number;
    nonce: number;
    transactionType: string;
    expectedHash: string;
    to: string;
    requestFingerprint: string;
    feeModel: "legacy" | "eip1559";
    projectedGasNative?: bigint;
    projectedGasUsd?: number;
  }) {
    const at = new Date().toISOString();
    return withEconomicForegroundPersistenceSync({databasePath:this.path,component:"chain-transaction-journal",operation:`${input.semanticStage.toLowerCase()}_prepared_commit`,workflow:input.workflowIdentity,semanticStage:input.semanticStage,run:()=>this.db.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT * FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage=? AND attempt=?",
        )
        .get(
          input.chainId,
          input.workflowIdentity,
          input.semanticStage,
          input.attempt,
        ) as Record<string, unknown> | undefined;
      if (existing) {
        if (
          String(existing.expected_hash).toLowerCase() !==
            input.expectedHash.toLowerCase() ||
          Number(existing.nonce) !== input.nonce
        )
          throw new Error("CHAIN_JOURNAL_SAME_ATTEMPT_DIFFERENT_TRANSACTION");
        return existing;
      }
      const nonceUse = this.db
        .prepare(
          "SELECT expected_hash FROM chain_transaction_journal WHERE chain_id=? AND lower(wallet_address)=? AND nonce=? AND status IN ('PREPARED','SUBMITTED','CONFIRMED') LIMIT 1",
        )
        .get(input.chainId, input.wallet.toLowerCase(), input.nonce) as
        { expected_hash: string } | undefined;
      if (
        nonceUse &&
        nonceUse.expected_hash.toLowerCase() !==
          input.expectedHash.toLowerCase()
      )
        throw new Error("CHAIN_JOURNAL_SAME_NONCE_DIFFERENT_TRANSACTION");
      this.db
        .prepare(
          "INSERT INTO chain_transaction_journal(chain_id,chain_key,protocol,journal_id,wallet_address,workflow_identity,semantic_stage,attempt,status,nonce,transaction_type,expected_hash,to_address,request_fingerprint,fee_model,projected_gas_native,projected_gas_usd,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'PREPARED',?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.chainId,
          input.chainKey,
          input.protocol,
          input.journalId,
          input.wallet.toLowerCase(),
          input.workflowIdentity,
          input.semanticStage,
          input.attempt,
          input.nonce,
          input.transactionType,
          input.expectedHash.toLowerCase(),
          input.to.toLowerCase(),
          input.requestFingerprint,
          input.feeModel,
          input.projectedGasNative?.toString() ?? null,
          input.projectedGasUsd ?? null,
          at,
          at,
        );
      return this.db
        .prepare(
          "SELECT * FROM chain_transaction_journal WHERE chain_id=? AND journal_id=?",
        )
        .get(input.chainId, input.journalId) as Record<string, unknown>;
    })()});
  }
  transitionChainTransaction(input: {
    chainId: number;
    journalId: string;
    from: "PREPARED" | "SUBMITTED";
    to: "SUBMITTED" | "CONFIRMED" | "FAILED";
    receipt?: unknown;
    providerEvidence?: unknown;
    confirmationCount?: number;
    actualGasNative?: bigint;
    actualGasUsd?: number;
    failureReason?: string;
  }) {
    const identity=this.db.prepare("SELECT workflow_identity,semantic_stage FROM chain_transaction_journal WHERE chain_id=? AND journal_id=?").get(input.chainId,input.journalId) as {workflow_identity:string;semantic_stage:string}|undefined;
    return withEconomicForegroundPersistenceSync({databasePath:this.path,component:"chain-transaction-journal",operation:`chain_transaction_${input.to.toLowerCase()}_commit`,workflow:identity?.workflow_identity,semanticStage:identity?.semantic_stage,run:()=>{const at = new Date().toISOString(),
      submitted = input.to === "SUBMITTED" ? at : null,
      confirmed = input.to === "CONFIRMED" ? at : null,
      changed = this.db
        .prepare(
          "UPDATE chain_transaction_journal SET status=?,receipt_json=COALESCE(?,receipt_json),provider_evidence_json=COALESCE(?,provider_evidence_json),confirmation_count=COALESCE(?,confirmation_count),actual_gas_native=COALESCE(?,actual_gas_native),actual_gas_usd=COALESCE(?,actual_gas_usd),failure_reason=COALESCE(?,failure_reason),submitted_at=COALESCE(?,submitted_at),confirmed_at=COALESCE(?,confirmed_at),updated_at=? WHERE chain_id=? AND journal_id=? AND status=?",
        )
        .run(
          input.to,
          input.receipt === undefined ? null : jsonStringify(input.receipt),
          input.providerEvidence === undefined
            ? null
            : jsonStringify(input.providerEvidence),
          input.confirmationCount ?? null,
          input.actualGasNative?.toString() ?? null,
          input.actualGasUsd ?? null,
          input.failureReason ?? null,
          submitted,
          confirmed,
          at,
          input.chainId,
          input.journalId,
          input.from,
        );
    if (changed.changes !== 1)
      throw new Error("CHAIN_JOURNAL_TRANSITION_CONFLICT");
    return this.db
      .prepare(
        "SELECT * FROM chain_transaction_journal WHERE chain_id=? AND journal_id=?",
      )
      .get(input.chainId, input.journalId) as Record<string, unknown>;}});
  }
  reconcileDurableChainTransaction(input: {
    chainId: number;
    wallet: string;
    workflowIdentity: string;
    semanticStage: string;
    attempt: number;
    expectedHash: string;
    evidence:
      | { kind: "RECEIPT"; receipt: Record<string, unknown> }
      | { kind: "NONCE_UNAVAILABLE"; latestNonce: number; pendingNonce: number };
  }) {
    return withEconomicForegroundPersistenceSync({databasePath:this.path,component:"chain-transaction-journal",operation:`${input.semanticStage.toLowerCase()}_exact_hash_terminal_commit`,workflow:input.workflowIdentity,semanticStage:input.semanticStage,run:()=>this.db.transaction(() => {
      let row = this.db
        .prepare(
          "SELECT * FROM chain_transaction_journal WHERE chain_id=? AND lower(wallet_address)=? AND workflow_identity=? AND semantic_stage=? AND attempt=?",
        )
        .get(
          input.chainId,
          input.wallet.toLowerCase(),
          input.workflowIdentity,
          input.semanticStage,
          input.attempt,
        ) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      if (String(row.expected_hash).toLowerCase() !== input.expectedHash.toLowerCase())
        throw new Error("CHAIN_JOURNAL_RECOVERY_HASH_CONFLICT");
      if (["CONFIRMED", "FAILED"].includes(String(row.status))) return row;
      if (!["PREPARED", "SUBMITTED"].includes(String(row.status)))
        throw new Error("CHAIN_JOURNAL_RECOVERY_STATE_CONFLICT");
      let prior: Record<string, unknown> = {};
      try {
        prior = row.provider_evidence_json
          ? JSON.parse(String(row.provider_evidence_json))
          : {};
      } catch {}
      const recovery =
        input.evidence.kind === "RECEIPT"
          ? {
              kind: "EXACT_HASH_RECEIPT",
              transactionHash: input.expectedHash.toLowerCase(),
              status: String(input.evidence.receipt.status),
              blockNumber: String(input.evidence.receipt.blockNumber),
              observedAt: new Date().toISOString(),
            }
          : {
              kind: "EXACT_HASH_ABSENT_NONCE_UNAVAILABLE",
              latestNonce: input.evidence.latestNonce,
              pendingNonce: input.evidence.pendingNonce,
              observedAt: new Date().toISOString(),
            };
      const providerEvidence = { ...prior, recovery };
      if (input.evidence.kind === "NONCE_UNAVAILABLE") {
        row = this.transitionChainTransaction({
          chainId: input.chainId,
          journalId: String(row.journal_id),
          from: String(row.status) as "PREPARED" | "SUBMITTED",
          to: "FAILED",
          providerEvidence,
          failureReason: "NONCE_NO_LONGER_AVAILABLE",
        });
        return row;
      }
      if (String(row.status) === "PREPARED")
        row = this.transitionChainTransaction({
          chainId: input.chainId,
          journalId: String(row.journal_id),
          from: "PREPARED",
          to: "SUBMITTED",
          providerEvidence,
        });
      const receipt = input.evidence.receipt,
        success = String(receipt.status) === "success",
        gasUsed = BigInt(String(receipt.gasUsed)),
        effectiveGasPrice = BigInt(String(receipt.effectiveGasPrice));
      return this.transitionChainTransaction({
        chainId: input.chainId,
        journalId: String(row.journal_id),
        from: "SUBMITTED",
        to: success ? "CONFIRMED" : "FAILED",
        receipt,
        providerEvidence,
        confirmationCount: 1,
        actualGasNative: gasUsed * effectiveGasPrice,
        failureReason: success ? undefined : "TRANSACTION_REVERTED",
      });
    })()});
  }
  authorizeChainCallback(input: {
    authorizationId: string;
    userId: string;
    chatId: string;
    chainId: number;
    protocol: string;
    workflowOrPositionId: string;
    action: string;
    previewRevision: number;
    deploymentVersion?: number;
    walletAddress?: string;
    exposureRevision?: string;
    feeEvidenceRevision?: string;
    expiresAtMs: number;
    idempotencyKey: string;
    now?: number;
  }) {
    const now = input.now ?? Date.now();
    if (input.expiresAtMs <= now)
      throw new Error("CALLBACK_AUTHORIZATION_ALREADY_EXPIRED");
    this.db
      .prepare(
        "INSERT INTO chain_callback_authorizations(authorization_id,user_id,chat_id,chain_id,protocol,workflow_or_position_id,action,preview_revision,deployment_version,wallet_address,exposure_revision,fee_evidence_revision,expires_at_ms,idempotency_key,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        input.authorizationId,
        input.userId,
        input.chatId,
        input.chainId,
        input.protocol,
        input.workflowOrPositionId,
        input.action,
        input.previewRevision,
        input.deploymentVersion ?? 1,
        input.walletAddress?.toLowerCase() ?? "",
        input.exposureRevision ?? "",
        input.feeEvidenceRevision ?? "",
        input.expiresAtMs,
        input.idempotencyKey,
        now,
      );
  }
  consumeChainCallback(input: {
    authorizationId: string;
    userId: string;
    chatId: string;
    chainId: number;
    protocol: string;
    workflowOrPositionId: string;
    action: string;
    previewRevision: number;
    deploymentVersion?: number;
    walletAddress?: string;
    exposureRevision?: string;
    feeEvidenceRevision?: string;
    now?: number;
  }) {
    const now = input.now ?? Date.now(),
      changed = this.db
        .prepare(
          "UPDATE chain_callback_authorizations SET consumed_at_ms=? WHERE authorization_id=? AND user_id=? AND chat_id=? AND chain_id=? AND protocol=? AND workflow_or_position_id=? AND action=? AND preview_revision=? AND deployment_version=? AND wallet_address=? AND exposure_revision=? AND fee_evidence_revision=? AND consumed_at_ms IS NULL AND expires_at_ms>?",
        )
        .run(
          now,
          input.authorizationId,
          input.userId,
          input.chatId,
          input.chainId,
          input.protocol,
          input.workflowOrPositionId,
          input.action,
          input.previewRevision,
          input.deploymentVersion ?? 1,
          input.walletAddress?.toLowerCase() ?? "",
          input.exposureRevision ?? "",
          input.feeEvidenceRevision ?? "",
          now,
        );
    if (changed.changes !== 1)
      throw new Error("CALLBACK_AUTHORIZATION_INVALID_STALE_OR_REPLAYED");
    return true;
  }
  chainBotExposure(chainId: number) {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(committed_usd),0) total, COALESCE(SUM(CASE WHEN committed_usd IS NULL OR valuation_status!='AVAILABLE' THEN 1 ELSE 0 END),0) unavailable FROM chain_exposure_commitments WHERE chain_id=? AND provenance='BOT_OPERATIONAL' AND released_at IS NULL",
      )
      .get(chainId) as { total: number; unavailable: number };
    return {
      chainId,
      totalUsd: row.total,
      valuationAvailable: row.unavailable === 0,
      unavailableCommitments: row.unavailable,
    };
  }
  armCanary(input: {
    userId: string;
    chatId: string;
    now: number;
    ttlMs: number;
  }) {
    const id = randomUUID(),
      expires = input.now + input.ttlMs,
      run = this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE canary_arms SET status='EXPIRED' WHERE status='ARMED' AND expires_at_ms<=?",
          )
          .run(input.now);
        this.db
          .prepare(
            "UPDATE canary_arms SET status='DISARMED' WHERE user_id=? AND chat_id=? AND status='ARMED'",
          )
          .run(input.userId, input.chatId);
        this.db
          .prepare(
            "INSERT INTO canary_arms(id,user_id,chat_id,status,expires_at_ms,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(
            id,
            input.userId,
            input.chatId,
            "ARMED",
            expires,
            new Date().toISOString(),
          );
      });
    run();
    return { id, expiresAtMs: expires };
  }
  requestCanaryArm(input: {
    userId: string;
    chatId: string;
    now: number;
    ttlMs: number;
  }) {
    const id = randomUUID(),
      expires = input.now + input.ttlMs;
    this.db
      .prepare(
        "UPDATE canary_arms SET status='EXPIRED' WHERE user_id=? AND chat_id=? AND status='PENDING'",
      )
      .run(input.userId, input.chatId);
    this.db
      .prepare(
        "INSERT INTO canary_arms(id,user_id,chat_id,status,expires_at_ms,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        input.userId,
        input.chatId,
        "PENDING",
        expires,
        new Date().toISOString(),
      );
    return { id, expiresAtMs: expires };
  }
  confirmCanaryArm(input: {
    userId: string;
    chatId: string;
    id: string;
    now: number;
    ttlMs: number;
  }) {
    const expires = input.now + input.ttlMs,
      run = this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE canary_arms SET status='DISARMED' WHERE user_id=? AND chat_id=? AND status='ARMED'",
          )
          .run(input.userId, input.chatId);
        return (
          this.db
            .prepare(
              "UPDATE canary_arms SET status='ARMED',expires_at_ms=? WHERE id=? AND user_id=? AND chat_id=? AND status='PENDING' AND expires_at_ms>?",
            )
            .run(expires, input.id, input.userId, input.chatId, input.now)
            .changes === 1
        );
      });
    return run() ? { id: input.id, expiresAtMs: expires } : undefined;
  }
  disarmCanary(userId: string, chatId: string) {
    return (
      this.db
        .prepare(
          "UPDATE canary_arms SET status='DISARMED' WHERE user_id=? AND chat_id=? AND status='ARMED'",
        )
        .run(userId, chatId).changes > 0
    );
  }
  activeCanaryArm(userId: string, chatId: string, now: number) {
    this.db
      .prepare(
        "UPDATE canary_arms SET status='EXPIRED' WHERE status='ARMED' AND expires_at_ms<=?",
      )
      .run(now);
    return this.db
      .prepare(
        "SELECT id,expires_at_ms FROM canary_arms WHERE user_id=? AND chat_id=? AND status='ARMED' AND expires_at_ms>? ORDER BY created_at DESC LIMIT 1",
      )
      .get(userId, chatId, now) as
      { id: string; expires_at_ms: number } | undefined;
  }
  consumeCanaryArm(userId: string, chatId: string, id: string, now: number) {
    return (
      this.db
        .prepare(
          "UPDATE canary_arms SET status='CONSUMED',consumed_at=? WHERE id=? AND user_id=? AND chat_id=? AND status='ARMED' AND expires_at_ms>?",
        )
        .run(new Date().toISOString(), id, userId, chatId, now).changes === 1
    );
  }
  createCanaryIntent(input: {
    wallet: string;
    owner: string;
    idempotencyKey: string;
    payload: unknown;
  }) {
    const existing = this.db
      .prepare("SELECT * FROM canary_execution_intents WHERE idempotency_key=?")
      .get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return existing;
    const id = randomUUID(),
      at = new Date().toISOString();
    const create = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO canary_execution_intents(id,wallet,owner,state,idempotency_key,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          input.wallet,
          input.owner,
          "PREVIEWED",
          input.idempotencyKey,
          JSON.stringify(input.payload, (_, v) =>
            typeof v === "bigint" ? v.toString() : v,
          ),
          at,
          at,
        );
      this.db
        .prepare(
          "INSERT OR IGNORE INTO canary_execution_transitions(intent_id,state,created_at) VALUES(?,?,?)",
        )
        .run(id, "PREVIEWED", at);
    });
    create();
    return this.canaryIntent(id)!;
  }
  claimPreparedCanaryIntent(input: {
    intentId: string;
    owner: string;
    wallet: string;
  }) {
    const at = new Date().toISOString(),
      claim = this.db.transaction(() => {
        const intent = this.canaryIntent(input.intentId);
        if (
          !intent ||
          intent.owner !== input.owner ||
          String(intent.wallet).toLowerCase() !== input.wallet.toLowerCase()
        )
          return { status: "INVALID_INTENT" as const };
        if (intent.state !== "PREVIEWED")
          return { status: "ALREADY_CLAIMED" as const, intent };
        const budget =
          this.db
            .prepare(
              "UPDATE canary_budget SET status='CLAIMED',attempts_used=1,intent_id=?,updated_at=? WHERE id=1 AND status='AVAILABLE' AND attempts_used=0",
            )
            .run(input.intentId, at).changes === 1;
        if (!budget) return { status: "CANARY_BUDGET_UNAVAILABLE" as const };
        return {
          status: "CLAIMED" as const,
          intent: this.canaryIntent(input.intentId)!,
        };
      });
    return claim();
  }
  canaryIntent(id: string) {
    return this.db
      .prepare("SELECT * FROM canary_execution_intents WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
  }
  canaryIntentByKey(key: string) {
    return this.db
      .prepare("SELECT * FROM canary_execution_intents WHERE idempotency_key=?")
      .get(key) as Record<string, unknown> | undefined;
  }
  claimDirectCanaryIntent(input: {
    updateId: string;
    messageId: string;
    owner: string;
    userId: string;
    chatId: string;
    sessionId: string;
    selectionId: string;
    wallet: string;
    now: number;
    payload: unknown;
  }) {
    const key = `telegram-amount:${input.chatId}:${input.messageId}:${input.updateId}`,
      claim = this.db.transaction(() => {
        const existing = this.canaryIntentByKey(key);
        if (existing)
          return { status: "ALREADY_CLAIMED" as const, intent: existing };
        const selection = this.poolSelection(input.selectionId);
        if (
          !selection ||
          selection.user_id !== input.userId ||
          selection.chat_id !== input.chatId ||
          selection.session_id !== input.sessionId ||
          Number(selection.superseded) !== 0
        )
          return { status: "STALE_POOL_SELECTION" as const };
        const id = randomUUID(),
          at = new Date(input.now).toISOString(),
          budget =
            this.db
              .prepare(
                "UPDATE canary_budget SET status='CLAIMED',attempts_used=1,intent_id=?,updated_at=? WHERE id=1 AND status='AVAILABLE' AND attempts_used=0",
              )
              .run(id, at).changes === 1;
        if (!budget) return { status: "CANARY_BUDGET_UNAVAILABLE" as const };
        this.db
          .prepare(
            "INSERT INTO canary_execution_intents(id,wallet,owner,state,idempotency_key,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            input.wallet,
            input.owner,
            "PREVIEWED",
            key,
            JSON.stringify(
              {
                telegram: {
                  updateId: input.updateId,
                  messageId: input.messageId,
                  userId: input.userId,
                  chatId: input.chatId,
                  sessionId: input.sessionId,
                  selectionId: input.selectionId,
                },
                intent: input.payload,
              },
              (_, v) => (typeof v === "bigint" ? v.toString() : v),
            ),
            at,
            at,
          );
        this.db
          .prepare(
            "INSERT OR IGNORE INTO canary_execution_transitions(intent_id,state,created_at) VALUES(?,?,?)",
          )
          .run(id, "PREVIEWED", at);
        return { status: "CLAIMED" as const, intent: this.canaryIntent(id)! };
      });
    return claim();
  }
  claimCanaryConfirmation(input: {
    confirmationId: string;
    owner: string;
    userId: string;
    chatId: string;
    wallet: string;
    now: number;
    payload: unknown;
  }) {
    const key = `telegram-canary:${input.confirmationId}`,
      claim = this.db.transaction(() => {
        const existing = this.canaryIntentByKey(key);
        if (existing)
          return { status: "ALREADY_CLAIMED" as const, intent: existing };
        const confirmation = this.db
          .prepare("SELECT * FROM confirmation_requests WHERE id=?")
          .get(input.confirmationId) as Record<string, unknown> | undefined;
        if (
          !confirmation ||
          confirmation.owner !== input.owner ||
          confirmation.action !== "SINGLE_SIDED_DOWNSIDE_MINT"
        )
          return { status: "INVALID_CONFIRMATION" as const };
        if (confirmation.state !== "AWAITING_CONFIRMATION")
          return { status: "CONFIRMATION_NOT_ACTIVE" as const };
        if (Date.parse(String(confirmation.expires_at)) <= input.now) {
          this.db
            .prepare(
              "UPDATE confirmation_requests SET state='EXPIRED',updated_at=? WHERE id=? AND state='AWAITING_CONFIRMATION'",
            )
            .run(new Date(input.now).toISOString(), input.confirmationId);
          return { status: "CONFIRMATION_EXPIRED" as const };
        }
        const id = randomUUID(),
          at = new Date(input.now).toISOString(),
          budget =
            this.db
              .prepare(
                "UPDATE canary_budget SET status='CLAIMED',attempts_used=1,intent_id=?,updated_at=? WHERE id=1 AND status='AVAILABLE' AND attempts_used=0",
              )
              .run(id, at).changes === 1;
        if (!budget) return { status: "CANARY_BUDGET_UNAVAILABLE" as const };
        this.db
          .prepare(
            "INSERT INTO canary_execution_intents(id,wallet,owner,state,idempotency_key,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            input.wallet,
            input.owner,
            "PREVIEWED",
            key,
            JSON.stringify(input.payload, (_, v) =>
              typeof v === "bigint" ? v.toString() : v,
            ),
            at,
            at,
          );
        this.db
          .prepare(
            "INSERT OR IGNORE INTO canary_execution_transitions(intent_id,state,created_at) VALUES(?,?,?)",
          )
          .run(id, "PREVIEWED", at);
        this.db
          .prepare(
            "UPDATE confirmation_requests SET state='CONFIRMED',updated_at=? WHERE id=? AND state='AWAITING_CONFIRMATION'",
          )
          .run(at, input.confirmationId);
        return { status: "CLAIMED" as const, intent: this.canaryIntent(id)! };
      });
    return claim();
  }
  claimCanaryIntent(id: string) {
    const at = new Date().toISOString(),
      claim = this.db.transaction(() => {
        const changed =
          this.db
            .prepare(
              "UPDATE canary_execution_intents SET state='FINAL_SIMULATION_PASSED',updated_at=? WHERE id=? AND state='PREVIEWED'",
            )
            .run(at, id).changes === 1;
        if (changed)
          this.db
            .prepare(
              "INSERT OR IGNORE INTO canary_execution_transitions(intent_id,state,created_at) VALUES(?,?,?)",
            )
            .run(id, "FINAL_SIMULATION_PASSED", at);
        return changed;
      });
    return claim();
  }
  transitionCanaryIntent(
    id: string,
    state: string,
    patch: {
      approvalHash?: string;
      mintHash?: string;
      tokenId?: string;
      failureReason?: string;
    } = {},
  ) {
    const at = new Date().toISOString(),
      transition = this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE canary_execution_intents SET state=?,approval_hash=COALESCE(?,approval_hash),mint_hash=COALESCE(?,mint_hash),token_id=COALESCE(?,token_id),failure_reason=COALESCE(?,failure_reason),updated_at=? WHERE id=?",
          )
          .run(
            state,
            patch.approvalHash ?? null,
            patch.mintHash ?? null,
            patch.tokenId ?? null,
            patch.failureReason ?? null,
            at,
            id,
          );
        this.db
          .prepare(
            "INSERT OR IGNORE INTO canary_execution_transitions(intent_id,state,created_at) VALUES(?,?,?)",
          )
          .run(id, state, at);
      });
    transition();
    return this.canaryIntent(id)!;
  }
  canaryIntentTransitions(id: string) {
    return this.db
      .prepare(
        "SELECT state,created_at FROM canary_execution_transitions WHERE intent_id=? ORDER BY created_at,rowid",
      )
      .all(id) as Array<{ state: string; created_at: string }>;
  }
  activeCanaryExecutionCount(wallet: string) {
    return Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM canary_execution_intents WHERE wallet=? AND state IN ('PREVIEWED','FINAL_SIMULATION_PASSED','APPROVAL_REQUIRED','APPROVAL_SUBMITTED','APPROVAL_CONFIRMED','RANGE_REFRESHED','MINT_SIMULATION_PASSED','MINT_SUBMITTED')",
          )
          .get(wallet) as { count: number }
      ).count,
    );
  }
  upsertV4Position(input: {
    tokenId: bigint;
    owner: string;
    poolId: string;
    poolKey: unknown;
    currency0: string;
    currency1: string;
    fee: number;
    tickSpacing: number;
    hooks: string;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    initialAmount0: bigint;
    initialAmount1: bigint;
    mintHash: string;
    status?: "open" | "partially_closed" | "closed" | "burned";
    targetToken?: string;
    fundingToken?: string;
    targetSymbol?: string;
    fundingSymbol?: string;
    symbolProvenance?: unknown;
    targetDecimals?: number;
    fundingDecimals?: number;
    targetIndex?: 0 | 1;
    fundingIndex?: 0 | 1;
    feeSemantics?: unknown;
    hookStatus?: unknown;
    valuationProvenance?: unknown;
    openIntentId?: string;
    openEvidence?: unknown;
  }) {
    const at = new Date().toISOString(),
      json = JSON.stringify(input.poolKey),
      j = (v: unknown) =>
        v === undefined
          ? null
          : JSON.stringify(v, (_, x) =>
              typeof x === "bigint" ? x.toString() : x,
            );
    const current=this.v4Position(input.tokenId);
    if(current&&input.targetSymbol&&current.target_symbol&&String(current.target_symbol)!=='TOKEN'&&String(current.target_symbol)!==input.targetSymbol)
      this.db.prepare("INSERT OR IGNORE INTO v4_symbol_provenance_conflicts(token_id,token_address,established_symbol,proposed_symbol,established_provenance_json,proposed_provenance_json,observed_at_ms) VALUES(?,?,?,?,?,?,?)").run(input.tokenId.toString(),String(input.targetToken??current.target_token??''),String(current.target_symbol),input.targetSymbol,String(current.symbol_provenance_json??''),j(input.symbolProvenance),Date.now());
    this.db
      .prepare(
        "INSERT INTO v4_positions(token_id,owner,pool_id,pool_key_json,currency0,currency1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity_raw,initial_amount0_raw,initial_amount1_raw,status,mint_hash,created_at,updated_at,target_token,funding_token,target_symbol,funding_symbol,target_decimals,funding_decimals,target_index,funding_index,fee_semantics_json,hook_status_json,valuation_provenance_json,open_intent_id,open_evidence_json,symbol_provenance_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(token_id) DO UPDATE SET owner=excluded.owner,pool_id=excluded.pool_id,pool_key_json=excluded.pool_key_json,liquidity_raw=excluded.liquidity_raw,status=excluded.status,target_token=COALESCE(excluded.target_token,v4_positions.target_token),funding_token=COALESCE(excluded.funding_token,v4_positions.funding_token),target_symbol=CASE WHEN v4_positions.target_symbol IS NULL OR v4_positions.target_symbol='TOKEN' THEN excluded.target_symbol ELSE v4_positions.target_symbol END,funding_symbol=CASE WHEN v4_positions.funding_symbol IS NULL OR v4_positions.funding_symbol='FUNDING' THEN excluded.funding_symbol ELSE v4_positions.funding_symbol END,symbol_provenance_json=CASE WHEN v4_positions.target_symbol IS NULL OR v4_positions.target_symbol='TOKEN' THEN excluded.symbol_provenance_json ELSE v4_positions.symbol_provenance_json END,updated_at=excluded.updated_at",
      )
      .run(
        input.tokenId.toString(),
        input.owner,
        input.poolId,
        json,
        input.currency0,
        input.currency1,
        input.fee,
        input.tickSpacing,
        input.hooks,
        input.tickLower,
        input.tickUpper,
        input.liquidity.toString(),
        input.initialAmount0.toString(),
        input.initialAmount1.toString(),
        input.status ?? "open",
        input.mintHash,
        at,
        at,
        input.targetToken ?? null,
        input.fundingToken ?? null,
        input.targetSymbol ?? null,
        input.fundingSymbol ?? null,
        input.targetDecimals ?? null,
        input.fundingDecimals ?? null,
        input.targetIndex ?? null,
        input.fundingIndex ?? null,
        j(input.feeSemantics),
        j(input.hookStatus),
        j(input.valuationProvenance),
        input.openIntentId ?? null,
        j(input.openEvidence),
        j(input.symbolProvenance),
      );
    return this.v4Position(input.tokenId);
  }
  v4Position(tokenId: bigint | string) {
    return this.db
      .prepare("SELECT * FROM v4_positions WHERE token_id=?")
      .get(tokenId.toString()) as Record<string, unknown> | undefined;
  }
  listV4Positions() {
    return this.db
      .prepare("SELECT * FROM v4_positions ORDER BY created_at")
      .all() as Record<string, unknown>[];
  }
  updateV4Position(input: {
    tokenId: bigint | string;
    liquidity: bigint;
    status: "open" | "partially_closed" | "closed" | "burned";
    principal?: TokenAmounts;
    fees?: TokenAmounts;
  }) {
    const at = new Date().toISOString(),
      row = this.v4Position(input.tokenId);
    if (!row) throw new Error("V4_POSITION_NOT_FOUND");
    const p = input.principal ?? zero(),
      f = input.fees ?? zero();
    this.db
      .prepare(
        "UPDATE v4_positions SET liquidity_raw=?,status=?,withdrawn_principal0_raw=?,withdrawn_principal1_raw=?,claimed_fee0_raw=?,claimed_fee1_raw=?,updated_at=? WHERE token_id=?",
      )
      .run(
        input.liquidity.toString(),
        input.status,
        (BigInt(String(row.withdrawn_principal0_raw)) + p.token0).toString(),
        (BigInt(String(row.withdrawn_principal1_raw)) + p.token1).toString(),
        (BigInt(String(row.claimed_fee0_raw)) + f.token0).toString(),
        (BigInt(String(row.claimed_fee1_raw)) + f.token1).toString(),
        at,
        input.tokenId.toString(),
      );
    return this.v4Position(input.tokenId)!;
  }
  createV4LifecycleIntent(input: {
    tokenId: bigint | string;
    action: "collect" | "partial_close" | "full_close" | "burn";
    idempotencyKey: string;
    liquidity?: bigint;
    payload?: unknown;
  }) {
    const existing = this.db
      .prepare("SELECT * FROM v4_lifecycle_intents WHERE idempotency_key=?")
      .get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return existing;
    const id = randomUUID(),
      at = new Date().toISOString(),
      run = this.db.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO v4_lifecycle_intents(id,token_id,action,idempotency_key,state,liquidity_raw,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            input.tokenId.toString(),
            input.action,
            input.idempotencyKey,
            "PREVIEWED",
            input.liquidity?.toString() ?? "0",
            JSON.stringify(input.payload ?? {}, (_, v) =>
              typeof v === "bigint" ? v.toString() : v,
            ),
            at,
            at,
          );
        this.db
          .prepare(
            "INSERT INTO v4_lifecycle_transitions(intent_id,ordinal,state,details_json,created_at) VALUES(?,0,?,?,?)",
          )
          .run(id, "PREVIEWED", "{}", at);
      });
    run();
    return this.v4LifecycleIntent(id)!;
  }
  v4LifecycleIntent(id: string) {
    return this.db
      .prepare("SELECT * FROM v4_lifecycle_intents WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
  }
  v4LifecyclePreviewCancellationStatus(id: string) {
    const intent = this.v4LifecycleIntent(id);
    if (!intent) throw new Error("V4_LIFECYCLE_INTENT_NOT_FOUND");
    const payload = String(intent.payload_json ?? "").toLowerCase(),
      evidence = {
        hash: intent.tx_hash !== null,
        receipt: Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM v4_lifecycle_receipts WHERE intent_id=? LIMIT 1",
            )
            .get(id),
        ),
        gas: Boolean(
          this.db
            .prepare("SELECT 1 FROM v4_live_gas WHERE intent_id=? LIMIT 1")
            .get(id),
        ),
        durableRequest:
          /serialized|expectedhash|requestfingerprint|signedtransaction/.test(
            payload,
          ),
      };
    const blockers = Object.entries(evidence)
      .filter(([, present]) => present)
      .map(
        ([name]) =>
          `V4_LIFECYCLE_PREVIEW_CANCELLATION_${name.toUpperCase()}_EVIDENCE`,
      );
    if (String(intent.state) === "CANCELLED")
      return {
        intent,
        eligible: false,
        idempotent: true,
        blockers: [] as string[],
        evidence,
      };
    if (String(intent.state) !== "PREVIEWED")
      blockers.unshift("V4_LIFECYCLE_PREVIEW_CANCELLATION_STATE_NOT_PREVIEWED");
    return {
      intent,
      eligible: blockers.length === 0,
      idempotent: false,
      blockers,
      evidence,
    };
  }
  cancelV4LifecyclePreview(id: string) {
    const initial = this.v4LifecyclePreviewCancellationStatus(id);
    if (initial.idempotent) return initial.intent;
    if (!initial.eligible) throw new Error(initial.blockers[0]!);
    const at = new Date().toISOString(),
      details = JSON.stringify({
        reason: "OPERATOR_CANCELLED_PRE_EXECUTION_PREVIEW",
        executionStarted: false,
      }),
      run = this.db.transaction(() => {
        const current = this.v4LifecyclePreviewCancellationStatus(id);
        if (current.idempotent) return;
        if (!current.eligible) throw new Error(current.blockers[0]!);
        const changed = this.db
          .prepare(
            "UPDATE v4_lifecycle_intents SET state='CANCELLED',failure_reason=NULL,updated_at=? WHERE id=? AND state='PREVIEWED'",
          )
          .run(at, id).changes;
        if (changed !== 1)
          throw new Error(
            "V4_LIFECYCLE_PREVIEW_CANCELLATION_CONCURRENT_CHANGE",
          );
        this.db
          .prepare(
            "INSERT INTO v4_lifecycle_transitions(intent_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,'CANCELLED',?,? FROM v4_lifecycle_transitions WHERE intent_id=?",
          )
          .run(id, details, at, id);
      });
    run();
    return this.v4LifecycleIntent(id)!;
  }
  claimV4LifecycleIntent(id: string) {
    const at = new Date().toISOString(),
      run = this.db.transaction(() => {
        const changed =
          this.db
            .prepare(
              "UPDATE v4_lifecycle_intents SET state='CLAIMED',updated_at=? WHERE id=? AND state='PREVIEWED'",
            )
            .run(at, id).changes === 1;
        if (changed)
          this.db
            .prepare(
              "INSERT INTO v4_lifecycle_transitions(intent_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,'CLAIMED','{}',? FROM v4_lifecycle_transitions WHERE intent_id=?",
            )
            .run(id, at, id);
        return changed;
      });
    return run();
  }
  transitionV4LifecycleIntent(
    id: string,
    state: string,
    patch: { txHash?: string; failureReason?: string; details?: unknown } = {},
  ) {
    const at = new Date().toISOString(),
      run = this.db.transaction(() => {
        const current = this.v4LifecycleIntent(id);
        if (!current) throw new Error("V4_LIFECYCLE_INTENT_NOT_FOUND");
        const hash = String(patch.txHash ?? current.tx_hash ?? ""),
          receipt = hash
            ? (this.db
                .prepare(
                  "SELECT receipt_json FROM v4_lifecycle_receipts WHERE intent_id=? AND tx_hash=?",
                )
                .get(id, hash) as { receipt_json: string } | undefined)
            : undefined;
        let successfulReceipt = false;
        try {
          successfulReceipt = Boolean(
            receipt && JSON.parse(receipt.receipt_json)?.status === "success",
          );
        } catch {
          successfulReceipt = false;
        }
        const confirmedTruth =
            successfulReceipt ||
            [
              "CONFIRMED_RECONCILIATION_REQUIRED",
              "CONFIRMED",
              "RECONCILED",
              "BURNED",
            ].includes(String(current.state)),
          allowedAfterConfirmation = [
            "CONFIRMED_RECONCILIATION_REQUIRED",
            "CONFIRMED",
            "RECONCILED",
            "BURNED",
          ];
        if (confirmedTruth && !allowedAfterConfirmation.includes(state))
          throw new Error("V4_CONFIRMED_ACTION_FINALITY_VIOLATION");
        this.db
          .prepare(
            "UPDATE v4_lifecycle_intents SET state=?,tx_hash=COALESCE(?,tx_hash),failure_reason=COALESCE(?,failure_reason),updated_at=? WHERE id=?",
          )
          .run(
            state,
            patch.txHash ?? null,
            patch.failureReason ?? null,
            at,
            id,
          );
        this.db
          .prepare(
            "INSERT OR IGNORE INTO v4_lifecycle_transitions(intent_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,?,?,? FROM v4_lifecycle_transitions WHERE intent_id=?",
          )
          .run(
            id,
            state,
            JSON.stringify(patch.details ?? {}, (_, v) =>
              typeof v === "bigint" ? v.toString() : v,
            ),
            at,
            id,
          );
      });
    run();
    return this.v4LifecycleIntent(id)!;
  }
  v4LifecycleHistory(tokenId: bigint | string) {
    return this.db
      .prepare(
        "SELECT i.id,i.action,i.state,i.tx_hash,i.failure_reason,t.ordinal,t.state transition_state,t.details_json,t.created_at FROM v4_lifecycle_intents i JOIN v4_lifecycle_transitions t ON t.intent_id=i.id WHERE i.token_id=? ORDER BY i.created_at,t.ordinal",
      )
      .all(tokenId.toString()) as Record<string, unknown>[];
  }
  persistV4LifecycleReceipt(hash: string, intentId: string, receipt: unknown) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO v4_lifecycle_receipts(tx_hash,intent_id,receipt_json,created_at) VALUES(?,?,?,?)",
        )
        .run(
          hash,
          intentId,
          JSON.stringify(receipt, (_, v) =>
            typeof v === "bigint" ? v.toString() : v,
          ),
          new Date().toISOString(),
        ).changes > 0
    );
  }
  persistV4OperationalOpenReceipt(
    hash: string,
    intentId: string,
    phase: string,
    receipt: unknown,
  ) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO v4_operational_open_receipts(tx_hash,intent_id,phase,receipt_json,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          hash,
          intentId,
          phase,
          JSON.stringify(receipt, (_, v) =>
            typeof v === "bigint" ? v.toString() : v,
          ),
          new Date().toISOString(),
        ).changes > 0
    );
  }
  v4LifecycleReceipt(hash: string) {
    return this.db
      .prepare("SELECT * FROM v4_lifecycle_receipts WHERE tx_hash=?")
      .get(hash) as Record<string, unknown> | undefined;
  }
  v4LiveCanary() {
    return this.db
      .prepare("SELECT * FROM v4_live_canary WHERE id=1")
      .get() as Record<string, unknown>;
  }
  claimV4LiveOpen(input: { intentId: string }) {
    const at = new Date().toISOString(),
      run = this.db.transaction(
        () =>
          this.db
            .prepare(
              "UPDATE v4_live_canary SET state='OPENING',open_intent_id=?,failure_reason=NULL,updated_at=? WHERE id=1 AND state='AVAILABLE_FOR_OPEN' AND token_id IS NULL",
            )
            .run(input.intentId, at).changes === 1,
      );
    return run();
  }
  claimV4OperationalOpen(input: { intentId: string }) {
    const at = new Date().toISOString(),
      run = this.db.transaction(() => {
        const changed =
          this.db
            .prepare(
              "UPDATE v4_live_open_intents SET state='CLAIMED',updated_at=? WHERE id=? AND state='PREVIEWED'",
            )
            .run(at, input.intentId).changes === 1;
        if (changed)
          this.db
            .prepare(
              "INSERT OR IGNORE INTO v4_live_transitions(intent_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,'CLAIMED','{}',? FROM v4_live_transitions WHERE intent_id=?",
            )
            .run(input.intentId, at, input.intentId);
        return changed;
      });
    return run();
  }
  markV4OperationalOpenRetryable(intentId: string) {
    const at = new Date().toISOString(),
      run = this.db.transaction(() => {
        const changed =
          this.db
            .prepare(
              "UPDATE v4_live_open_intents SET state='FAILED_RETRYABLE',updated_at=? WHERE id=? AND state='FAILED' AND (json_extract(payload_json,'$.lane')='operational' OR json_extract(payload_json,'$.executor')='executeV4OperationalOpen') AND erc20_approval_hash IS NULL AND permit2_approval_hash IS NULL AND mint_hash IS NULL AND NOT EXISTS(SELECT 1 FROM v4_live_gas WHERE intent_id=v4_live_open_intents.id) AND NOT EXISTS(SELECT 1 FROM v4_operational_open_receipts WHERE intent_id=v4_live_open_intents.id)",
            )
            .run(at, intentId).changes === 1;
        if (changed)
          this.db
            .prepare(
              "INSERT OR IGNORE INTO v4_live_transitions(intent_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,'FAILED_RETRYABLE',?,? FROM v4_live_transitions WHERE intent_id=?",
            )
            .run(
              intentId,
              JSON.stringify({
                safeToCreateFreshIntent: true,
                noTransactionBroadcast: true,
                lane: "operational",
              }),
              at,
              intentId,
            );
        return changed;
      });
    return run();
  }
  claimV4LiveClose(input: { intentId: string; tokenId: string }) {
    const at = new Date().toISOString(),
      run = this.db.transaction(
        () =>
          this.db
            .prepare(
              "UPDATE v4_live_canary SET state='CLOSING',close_intent_id=?,failure_reason=NULL,updated_at=? WHERE id=1 AND state='OPENED' AND token_id=?",
            )
            .run(input.intentId, at, input.tokenId).changes === 1,
      );
    return run();
  }
  transitionV4LiveCanary(
    state:
      | "AVAILABLE_FOR_OPEN"
      | "OPENING"
      | "OPENED"
      | "CLOSING"
      | "CLOSED"
      | "FAILED",
    patch: {
      tokenId?: string;
      closeIntentId?: string;
      failureReason?: string;
      remainingAllowance?: bigint;
    } = {},
  ) {
    const at = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE v4_live_canary SET state=?,token_id=COALESCE(?,token_id),close_intent_id=COALESCE(?,close_intent_id),failure_reason=COALESCE(?,failure_reason),remaining_allowance_raw=COALESCE(?,remaining_allowance_raw),updated_at=? WHERE id=1",
      )
      .run(
        state,
        patch.tokenId ?? null,
        patch.closeIntentId ?? null,
        patch.failureReason ?? null,
        patch.remainingAllowance?.toString() ?? null,
        at,
      );
    return this.v4LiveCanary();
  }
  createV4LiveOpenIntent(input: {
    idempotencyKey: string;
    owner: string;
    userId?: string;
    chatId?: string;
    poolId: string;
    poolKey: unknown;
    amount: bigint;
    payload: unknown;
  }) {
    const prior = this.db
      .prepare("SELECT * FROM v4_live_open_intents WHERE idempotency_key=?")
      .get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (prior) return prior;
    const id = randomUUID(),
      at = new Date().toISOString(),
      run = this.db.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO v4_live_open_intents(id,idempotency_key,owner,telegram_user_id,telegram_chat_id,pool_id,pool_key_json,amount_raw,state,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,? ,?,?,?)",
          )
          .run(
            id,
            input.idempotencyKey,
            input.owner,
            input.userId ?? null,
            input.chatId ?? null,
            input.poolId,
            JSON.stringify(input.poolKey),
            input.amount.toString(),
            "PREVIEWED",
            JSON.stringify(input.payload, (_, v) =>
              typeof v === "bigint" ? v.toString() : v,
            ),
            at,
            at,
          );
        this.db
          .prepare(
            "INSERT INTO v4_live_transitions(intent_id,ordinal,state,details_json,created_at) VALUES(?,0,'PREVIEWED','{}',?)",
          )
          .run(id, at);
      });
    run();
    return this.v4LiveOpenIntent(id)!;
  }
  v4LiveOpenIntent(id: string) {
    return this.db
      .prepare("SELECT * FROM v4_live_open_intents WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
  }
  transitionV4LiveOpenIntent(
    id: string,
    state: string,
    patch: {
      erc20Hash?: string;
      permit2Hash?: string;
      mintHash?: string;
      tokenId?: string;
      failureReason?: string;
      details?: unknown;
    } = {},
  ) {
    const at = new Date().toISOString(),
      run = this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE v4_live_open_intents SET state=?,erc20_approval_hash=COALESCE(?,erc20_approval_hash),permit2_approval_hash=COALESCE(?,permit2_approval_hash),mint_hash=COALESCE(?,mint_hash),token_id=COALESCE(?,token_id),failure_reason=COALESCE(?,failure_reason),updated_at=? WHERE id=?",
          )
          .run(
            state,
            patch.erc20Hash ?? null,
            patch.permit2Hash ?? null,
            patch.mintHash ?? null,
            patch.tokenId ?? null,
            patch.failureReason ?? null,
            at,
            id,
          );
        this.db
          .prepare(
            "INSERT OR IGNORE INTO v4_live_transitions(intent_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,?,?,? FROM v4_live_transitions WHERE intent_id=?",
          )
          .run(
            id,
            state,
            JSON.stringify(patch.details ?? {}, (_, v) =>
              typeof v === "bigint" ? v.toString() : v,
            ),
            at,
            id,
          );
      });
    run();
    return this.v4LiveOpenIntent(id)!;
  }
  private v4TerminalizationProtectedCounts(): V4LiveOpenTerminalizationCounts {
    const tables = [
      "v4_live_gas",
      "v4_operational_open_receipts",
      "chain_transaction_journal",
      "v4_positions",
      "transaction_intents",
      "transaction_receipts",
      "nonce_mutex",
      "chain_nonce_mutex",
      "chain_callback_authorizations",
      "chain_exposure_commitments",
    ];
    return Object.fromEntries(
      tables.map((table) => [
        table,
        Number(
          (
            this.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as {
              count: number;
            }
          ).count,
        ),
      ]),
    );
  }
  private assertV4LiveOpenNoBroadcastEvidence(
    intentId: string,
    row: Record<string, unknown>,
    transitions: Record<string, unknown>[],
  ) {
    for (const [field, code, category] of [
      [
        "erc20_approval_hash",
        "V4_TERMINALIZATION_ERC20_APPROVAL_HASH_PRESENT",
        "TRANSACTION_HASH",
      ],
      [
        "permit2_approval_hash",
        "V4_TERMINALIZATION_PERMIT2_APPROVAL_HASH_PRESENT",
        "TRANSACTION_HASH",
      ],
      ["mint_hash", "V4_TERMINALIZATION_MINT_HASH_PRESENT", "TRANSACTION_HASH"],
      ["token_id", "V4_TERMINALIZATION_TOKEN_ID_PRESENT", "TOKEN_ID"],
    ] as const)
      if (row[field] !== null)
        v4TerminalizationBlock(code, category, { field });
    const count = (sql: string, ...params: unknown[]) =>
      Number((this.db.prepare(sql).get(...params) as { count: number }).count);
    const gates: Array<[string, string, string, unknown[]]> = [
      [
        "V4_TERMINALIZATION_GAS_RECORD_PRESENT",
        "GAS_RECORD",
        "SELECT COUNT(*) count FROM v4_live_gas WHERE intent_id=?",
        [intentId],
      ],
      [
        "V4_TERMINALIZATION_OPERATIONAL_RECEIPT_PRESENT",
        "TRANSACTION_RECEIPT",
        "SELECT COUNT(*) count FROM v4_operational_open_receipts WHERE intent_id=?",
        [intentId],
      ],
      [
        "V4_TERMINALIZATION_CHAIN_JOURNAL_PRESENT",
        "CHAIN_JOURNAL",
        "SELECT COUNT(*) count FROM chain_transaction_journal WHERE workflow_identity=?",
        [intentId],
      ],
      [
        "V4_TERMINALIZATION_LINKED_POSITION_PRESENT",
        "POSITION",
        "SELECT COUNT(*) count FROM v4_positions WHERE open_intent_id=?",
        [intentId],
      ],
      [
        "V4_TERMINALIZATION_TRANSACTION_INTENT_PRESENT",
        "EXECUTION_EVIDENCE",
        "SELECT COUNT(*) count FROM transaction_intents WHERE id=? OR idempotency_key=?",
        [intentId, intentId],
      ],
      [
        "V4_TERMINALIZATION_TRANSACTION_RECEIPT_PRESENT",
        "TRANSACTION_RECEIPT",
        "SELECT COUNT(*) count FROM transaction_receipts WHERE intent_id=?",
        [intentId],
      ],
      [
        "V4_TERMINALIZATION_NONCE_MUTEX_PRESENT",
        "NONCE_RESERVATION",
        "SELECT (SELECT COUNT(*) FROM nonce_mutex)+(SELECT COUNT(*) FROM chain_nonce_mutex) count",
        [],
      ],
      [
        "V4_TERMINALIZATION_CALLBACK_AUTHORIZATION_PRESENT",
        "CALLBACK_AUTHORIZATION",
        "SELECT COUNT(*) count FROM chain_callback_authorizations WHERE workflow_or_position_id=? AND consumed_at_ms IS NULL",
        [intentId],
      ],
      [
        "V4_TERMINALIZATION_EXPOSURE_COMMITMENT_PRESENT",
        "EXPOSURE_COMMITMENT",
        "SELECT COUNT(*) count FROM chain_exposure_commitments WHERE workflow_id=? AND released_at IS NULL",
        [intentId],
      ],
    ];
    for (const [code, category, sql, params] of gates) {
      const found = count(sql, ...params);
      if (found) v4TerminalizationBlock(code, category, { count: found });
    }
    const ambiguous = count(
      "SELECT (SELECT COUNT(*) FROM chain_transaction_journal WHERE instr(journal_id,?)>0 OR instr(workflow_identity,?)>0 OR instr(provider_evidence_json,?)>0)+(SELECT COUNT(*) FROM v4_positions WHERE instr(COALESCE(open_evidence_json,''),?)>0)+(SELECT COUNT(*) FROM chain_workflow_bindings WHERE workflow_id=?)+(SELECT COUNT(*) FROM v4_live_canary WHERE open_intent_id=? OR close_intent_id=?) count",
      intentId,
      intentId,
      intentId,
      intentId,
      intentId,
      intentId,
      intentId,
    );
    if (ambiguous)
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_AMBIGUOUS_LINKAGE",
        "AMBIGUOUS_LINKAGE",
        { count: ambiguous },
      );
    const retryable = transitions.filter(
      (item) => item.state === "FAILED_RETRYABLE",
    );
    if (retryable.length !== 1)
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_TRANSITION_EVIDENCE_MISSING",
        "TRANSITION_METADATA",
        { failedRetryableTransitionCount: retryable.length },
      );
    const retryableDetails = terminalizationDetails(
      retryable[0]!.details_json,
      retryable[0]!.ordinal,
    );
    if (retryableDetails.noTransactionBroadcast !== true)
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_NO_TRANSACTION_BROADCAST_NOT_PROVEN",
        "TRANSITION_METADATA",
        { value: retryableDetails.noTransactionBroadcast ?? null },
      );
    if (retryableDetails.safeToCreateFreshIntent !== true)
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_FRESH_INTENT_SAFETY_NOT_PROVEN",
        "TRANSITION_METADATA",
        { value: retryableDetails.safeToCreateFreshIntent ?? null },
      );
    if (retryableDetails.lane !== "operational")
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_OPERATIONAL_LANE_NOT_PROVEN",
        "TRANSITION_METADATA",
        { value: retryableDetails.lane ?? null },
      );
    for (const transition of transitions) {
      const state = String(transition.state);
      if (
        /(?:SUBMITTED|CONFIRMED|PREPARED|SIGNING|POSITION_RECONCILED)/.test(
          state,
        )
      )
        v4TerminalizationBlock(
          "V4_TERMINALIZATION_SUBMITTED_OR_CONFIRMED_EVIDENCE_PRESENT",
          "EXECUTION_EVIDENCE",
          { ordinal: transition.ordinal, state },
        );
      const details = terminalizationDetails(
          transition.details_json,
          transition.ordinal,
        ),
        path = terminalizationExecutionEvidence(details);
      if (path)
        v4TerminalizationBlock(
          "V4_TERMINALIZATION_EXECUTION_DETAIL_PRESENT",
          "EXECUTION_EVIDENCE",
          { ordinal: transition.ordinal, path },
        );
    }
  }
  private v4LiveOpenNoBroadcastTerminalizationAudit(
    transitions: Record<string, unknown>[],
  ) {
    const audits = transitions.filter(
      (item) => item.state === V4_LIVE_OPEN_NO_BROADCAST_TERMINALIZATION_EVENT,
    );
    if (audits.length !== 1)
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_AUDIT_COUNT_INVALID",
        "TERMINALIZATION_METADATA",
        { auditCount: audits.length },
      );
    const audit = audits[0]!,
      details = terminalizationDetails(audit.details_json, audit.ordinal),
      valid =
        details.actor === V4_LIVE_OPEN_NO_BROADCAST_TERMINALIZATION_ACTOR &&
        typeof details.operatorReason === "string" &&
        details.operatorReason.trim() !== "" &&
        details.previousState === "FAILED_RETRYABLE" &&
        details.resultingState === "FAILED" &&
        details.terminalizationClass === "PROVEN_NO_BROADCAST" &&
        details.noTransactionBroadcast === true &&
        details.safeToCreateFreshIntent === true &&
        details.executionStarted === false &&
        details.signingUsed === false &&
        details.broadcastUsed === false &&
        typeof details.terminalizedAt === "string" &&
        Number.isFinite(Date.parse(details.terminalizedAt)) &&
        audit.created_at === details.terminalizedAt;
    if (!valid)
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_RECORDED_METADATA_INVALID",
        "TERMINALIZATION_METADATA",
      );
    return { audit, details };
  }
  terminalizeV4LiveOpenNoBroadcast(input: {
    intentId: string;
    operatorReason: string;
    terminalizedAt: string;
  }): V4LiveOpenTerminalizationWrite {
    const operatorReason = input.operatorReason.trim();
    if (!operatorReason)
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_REASON_REQUIRED",
        "CLI_ARGUMENT",
      );
    if (!Number.isFinite(Date.parse(input.terminalizedAt)))
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_TIMESTAMP_INVALID",
        "TERMINALIZATION_METADATA",
      );
    const run = this.db.transaction(() => {
      const found = this.v4LiveOpenIntent(input.intentId);
      if (!found)
        v4TerminalizationBlock(
          "V4_TERMINALIZATION_INTENT_NOT_FOUND",
          "INTENT_IDENTITY",
        );
      const row = found as Record<string, unknown>;
      const transitions = this.db
        .prepare(
          "SELECT ordinal,state,details_json,created_at FROM v4_live_transitions WHERE intent_id=? ORDER BY ordinal",
        )
        .all(input.intentId) as Record<string, unknown>[];
      if (row.state === "FAILED") {
        const { details } =
          this.v4LiveOpenNoBroadcastTerminalizationAudit(transitions);
        if (row.failure_reason !== "V4_TX_GAS_CAP_EXCEEDED")
          v4TerminalizationBlock(
            "V4_TERMINALIZATION_RECORDED_METADATA_INVALID",
            "TERMINALIZATION_METADATA",
          );
        this.assertV4LiveOpenNoBroadcastEvidence(
          input.intentId,
          row,
          transitions,
        );
        return {
          status: "ALREADY_TERMINAL" as const,
          intentId: input.intentId,
          operatorReason: String(details.operatorReason),
          terminalizedAt: String(details.terminalizedAt),
          previousState: "FAILED_RETRYABLE" as const,
          resultingState: "FAILED" as const,
          terminalizationClass: "PROVEN_NO_BROADCAST" as const,
          beforeTransitionCount: transitions.length,
          protectedCounts: this.v4TerminalizationProtectedCounts(),
        };
      }
      if (row.state !== "FAILED_RETRYABLE")
        v4TerminalizationBlock(
          "V4_TERMINALIZATION_WRONG_SOURCE_STATE",
          "SOURCE_STATE",
          { state: row.state },
        );
      if (row.failure_reason !== "V4_TX_GAS_CAP_EXCEEDED")
        v4TerminalizationBlock(
          "V4_TERMINALIZATION_WRONG_FAILURE_REASON",
          "FAILURE_CLASS",
          { failureReason: row.failure_reason ?? null },
        );
      this.assertV4LiveOpenNoBroadcastEvidence(
        input.intentId,
        row,
        transitions,
      );
      const protectedCounts = this.v4TerminalizationProtectedCounts(),
        details = {
          actor: V4_LIVE_OPEN_NO_BROADCAST_TERMINALIZATION_ACTOR,
          operatorReason,
          previousState: "FAILED_RETRYABLE",
          resultingState: "FAILED",
          terminalizationClass: "PROVEN_NO_BROADCAST",
          noTransactionBroadcast: true,
          safeToCreateFreshIntent: true,
          executionStarted: false,
          signingUsed: false,
          broadcastUsed: false,
          terminalizedAt: input.terminalizedAt,
        };
      const changed = this.db
        .prepare(
          "UPDATE v4_live_open_intents SET state='FAILED',updated_at=? WHERE id=? AND state='FAILED_RETRYABLE' AND failure_reason='V4_TX_GAS_CAP_EXCEEDED' AND erc20_approval_hash IS NULL AND permit2_approval_hash IS NULL AND mint_hash IS NULL AND token_id IS NULL AND updated_at=?",
        )
        .run(input.terminalizedAt, input.intentId, row.updated_at).changes;
      if (changed !== 1)
        v4TerminalizationBlock(
          "V4_TERMINALIZATION_CONCURRENT_STATE_CHANGE",
          "STATE_CONFLICT",
        );
      const audit = this.db
        .prepare(
          "INSERT INTO v4_live_transitions(intent_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,?,?,? FROM v4_live_transitions WHERE intent_id=?",
        )
        .run(
          input.intentId,
          V4_LIVE_OPEN_NO_BROADCAST_TERMINALIZATION_EVENT,
          JSON.stringify(details),
          input.terminalizedAt,
          input.intentId,
        ).changes;
      if (audit !== 1)
        v4TerminalizationBlock(
          "V4_TERMINALIZATION_AUDIT_WRITE_FAILED",
          "AUDIT_TRANSITION",
        );
      return {
        status: "TERMINALIZED_NO_BROADCAST" as const,
        intentId: input.intentId,
        operatorReason,
        terminalizedAt: input.terminalizedAt,
        previousState: "FAILED_RETRYABLE" as const,
        resultingState: "FAILED" as const,
        terminalizationClass: "PROVEN_NO_BROADCAST" as const,
        beforeTransitionCount: transitions.length,
        protectedCounts,
      };
    });
    return run.immediate();
  }
  reconcileV4LiveOpenTerminalizedNoBroadcast(
    intentId: string,
  ): V4LiveOpenTerminalizationReconciliationWrite {
    const run = this.db.transaction(() => {
      const found = this.v4LiveOpenIntent(intentId);
      if (!found)
        v4TerminalizationBlock(
          "V4_TERMINALIZATION_INTENT_NOT_FOUND",
          "INTENT_IDENTITY",
        );
      const row = found as Record<string, unknown>,
        transitions = this.db
          .prepare(
            "SELECT ordinal,state,details_json,created_at FROM v4_live_transitions WHERE intent_id=? ORDER BY ordinal",
          )
          .all(intentId) as Record<string, unknown>[],
        { details } =
          this.v4LiveOpenNoBroadcastTerminalizationAudit(transitions);
      if (row.failure_reason !== "V4_TX_GAS_CAP_EXCEEDED")
        v4TerminalizationBlock(
          "V4_TERMINALIZATION_WRONG_FAILURE_REASON",
          "FAILURE_CLASS",
          { failureReason: row.failure_reason ?? null },
        );
      this.assertV4LiveOpenNoBroadcastEvidence(intentId, row, transitions);
      const terminalizedAt = String(details.terminalizedAt),
        protectedCounts = this.v4TerminalizationProtectedCounts();
      if (row.state === "FAILED")
        return {
          status: "ALREADY_TERMINAL" as const,
          intentId,
          terminalizedAt,
          previousState: "FAILED_RETRYABLE" as const,
          resultingState: "FAILED" as const,
          terminalizationClass: "PROVEN_NO_BROADCAST" as const,
          beforeTransitionCount: transitions.length,
          protectedCounts,
        };
      if (row.state !== "FAILED_RETRYABLE")
        v4TerminalizationBlock(
          "V4_TERMINALIZATION_WRONG_SOURCE_STATE",
          "SOURCE_STATE",
          { state: row.state },
        );
      const changed = this.db
        .prepare(
          "UPDATE v4_live_open_intents SET state='FAILED',updated_at=? WHERE id=? AND state='FAILED_RETRYABLE' AND failure_reason='V4_TX_GAS_CAP_EXCEEDED' AND erc20_approval_hash IS NULL AND permit2_approval_hash IS NULL AND mint_hash IS NULL AND token_id IS NULL AND updated_at=?",
        )
        .run(new Date().toISOString(), intentId, row.updated_at).changes;
      if (changed !== 1)
        v4TerminalizationBlock(
          "V4_TERMINALIZATION_CONCURRENT_STATE_CHANGE",
          "STATE_CONFLICT",
        );
      return {
        status: "RECONCILED_TERMINAL_STATE" as const,
        intentId,
        terminalizedAt,
        previousState: "FAILED_RETRYABLE" as const,
        resultingState: "FAILED" as const,
        terminalizationClass: "PROVEN_NO_BROADCAST" as const,
        beforeTransitionCount: transitions.length,
        protectedCounts,
      };
    });
    return run.immediate();
  }
  verifyV4LiveOpenTerminalizedNoBroadcastReconciliation(
    write: V4LiveOpenTerminalizationReconciliationWrite,
  ) {
    const row = this.v4LiveOpenIntent(write.intentId);
    if (
      !row ||
      row.state !== "FAILED" ||
      row.failure_reason !== "V4_TX_GAS_CAP_EXCEEDED" ||
      row.erc20_approval_hash !== null ||
      row.permit2_approval_hash !== null ||
      row.mint_hash !== null ||
      row.token_id !== null
    )
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_REOPEN_INTENT_MISMATCH",
        "POST_REOPEN_VERIFICATION",
      );
    const transitions = this.db
        .prepare(
          "SELECT ordinal,state,details_json,created_at FROM v4_live_transitions WHERE intent_id=? ORDER BY ordinal",
        )
        .all(write.intentId) as Record<string, unknown>[],
      { details } = this.v4LiveOpenNoBroadcastTerminalizationAudit(transitions);
    this.assertV4LiveOpenNoBroadcastEvidence(
      write.intentId,
      row as Record<string, unknown>,
      transitions,
    );
    if (
      transitions.length !== write.beforeTransitionCount ||
      String(details.terminalizedAt) !== write.terminalizedAt ||
      JSON.stringify(this.v4TerminalizationProtectedCounts()) !==
        JSON.stringify(write.protectedCounts)
    )
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_REOPEN_SIDE_EFFECT_DETECTED",
        "POST_REOPEN_VERIFICATION",
      );
    return {
      status: write.status,
      verifiedAfterReopen: true,
      intentId: write.intentId,
      previousState: write.previousState,
      resultingState: write.resultingState,
      terminalizationClass: write.terminalizationClass,
      signerConstructed: false,
      nonceReserved: false,
      journalCreated: false,
      authorizationCreated: false,
      commitmentCreated: false,
      executionInvoked: false,
      signingUsed: false,
      broadcastUsed: false,
      mainnetTransactionsSent: 0 as const,
    };
  }
  verifyV4LiveOpenNoBroadcastTerminalization(
    write: V4LiveOpenTerminalizationWrite,
  ) {
    const row = this.v4LiveOpenIntent(write.intentId);
    if (
      !row ||
      row.state !== "FAILED" ||
      row.failure_reason !== "V4_TX_GAS_CAP_EXCEEDED" ||
      row.erc20_approval_hash !== null ||
      row.permit2_approval_hash !== null ||
      row.mint_hash !== null ||
      row.token_id !== null
    )
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_REOPEN_INTENT_MISMATCH",
        "POST_REOPEN_VERIFICATION",
      );
    const transitions = this.db
        .prepare(
          "SELECT ordinal,state,details_json,created_at FROM v4_live_transitions WHERE intent_id=? ORDER BY ordinal",
        )
        .all(write.intentId) as Record<string, unknown>[],
      audits = transitions.filter(
        (item) =>
          item.state === V4_LIVE_OPEN_NO_BROADCAST_TERMINALIZATION_EVENT,
      );
    if (
      audits.length !== 1 ||
      transitions.length !==
        write.beforeTransitionCount +
          (write.status === "TERMINALIZED_NO_BROADCAST" ? 1 : 0)
    )
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_REOPEN_AUDIT_COUNT_MISMATCH",
        "POST_REOPEN_VERIFICATION",
        { auditCount: audits.length, transitionCount: transitions.length },
      );
    const details = terminalizationDetails(
      audits[0]!.details_json,
      audits[0]!.ordinal,
    );
    for (const [key, value] of Object.entries({
      actor: V4_LIVE_OPEN_NO_BROADCAST_TERMINALIZATION_ACTOR,
      operatorReason: write.operatorReason,
      previousState: "FAILED_RETRYABLE",
      resultingState: "FAILED",
      terminalizationClass: "PROVEN_NO_BROADCAST",
      noTransactionBroadcast: true,
      safeToCreateFreshIntent: true,
      executionStarted: false,
      signingUsed: false,
      broadcastUsed: false,
      terminalizedAt: write.terminalizedAt,
    }))
      if (details[key] !== value)
        v4TerminalizationBlock(
          "V4_TERMINALIZATION_REOPEN_METADATA_MISMATCH",
          "POST_REOPEN_VERIFICATION",
          { field: key },
        );
    if (
      audits[0]!.created_at !== write.terminalizedAt ||
      JSON.stringify(this.v4TerminalizationProtectedCounts()) !==
        JSON.stringify(write.protectedCounts)
    )
      v4TerminalizationBlock(
        "V4_TERMINALIZATION_REOPEN_SIDE_EFFECT_DETECTED",
        "POST_REOPEN_VERIFICATION",
      );
    return {
      status: write.status,
      verifiedAfterReopen: true,
      intentId: write.intentId,
      previousState: write.previousState,
      resultingState: write.resultingState,
      terminalizationClass: write.terminalizationClass,
      signerConstructed: false,
      nonceReserved: false,
      journalCreated: false,
      authorizationCreated: false,
      commitmentCreated: false,
      executionInvoked: false,
      signingUsed: false,
      broadcastUsed: false,
      mainnetTransactionsSent: 0 as const,
    };
  }
  terminalizeV4OperationalNonBroadcast(input: {
    intentId: string;
    phase: string;
    hash: string;
    nonce: number;
    evidence: unknown;
  }) {
    const at = new Date().toISOString(),
      state = `${input.phase}_NON_BROADCAST_TERMINAL`;
    this.db.transaction(() => {
      const row = this.v4LiveOpenIntent(input.intentId);
      if (
        !row ||
        String(row.failure_reason) !==
          "V4_BROADCAST_PROVEN_ABSENT_AFTER_IDENTICAL_RESEND" ||
        String(row.permit2_approval_hash).toLowerCase() !==
          input.hash.toLowerCase()
      )
        throw new Error("V4_NON_BROADCAST_TERMINALIZATION_CONFLICT");
      this.db
        .prepare(
          "UPDATE v4_live_open_intents SET state=?,failure_reason=NULL,updated_at=? WHERE id=?",
        )
        .run(state, at, input.intentId);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO v4_live_transitions(intent_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,?,?,? FROM v4_live_transitions WHERE intent_id=?",
        )
        .run(
          input.intentId,
          state,
          JSON.stringify({
            phase: input.phase,
            exactHash: input.hash,
            nonce: input.nonce,
            classification:
              "PROVEN_NON_BROADCAST_SUPERSEDED_BY_SUFFICIENT_ALLOWANCE",
            evidence: input.evidence,
          }),
          at,
          input.intentId,
        );
    })();
    return this.v4LiveOpenIntent(input.intentId)!;
  }
  v4LiveTransitions(intentId: string) {
    return this.db
      .prepare(
        "SELECT ordinal,state,details_json,created_at FROM v4_live_transitions WHERE intent_id=? ORDER BY ordinal",
      )
      .all(intentId) as Record<string, unknown>[];
  }
  addV4LiveGasEstimate(input: {
    txHash: string;
    intentId: string;
    phase: string;
    gas: bigint;
    eth: bigint;
    usd: number;
  }) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO v4_live_gas(tx_hash,intent_id,phase,estimated_gas,estimated_eth_raw,estimated_usd,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        input.txHash,
        input.intentId,
        input.phase,
        input.gas.toString(),
        input.eth.toString(),
        input.usd,
        new Date().toISOString(),
      );
  }
  confirmV4LiveGas(input: {
    txHash: string;
    gas: bigint;
    eth: bigint;
    usd: number;
  }) {
    const at = new Date().toISOString(),
      run = this.db.transaction(() => {
        const changed = this.db
          .prepare(
            "UPDATE v4_live_gas SET actual_gas=?,actual_eth_raw=?,actual_usd=?,confirmed_at=? WHERE tx_hash=? AND actual_gas IS NULL",
          )
          .run(
            input.gas.toString(),
            input.eth.toString(),
            input.usd,
            at,
            input.txHash,
          ).changes;
        if (changed)
          this.db
            .prepare(
              "UPDATE v4_live_canary SET gas_spent_eth_raw=CAST(CAST(gas_spent_eth_raw AS INTEGER)+? AS TEXT),gas_spent_usd=gas_spent_usd+?,updated_at=? WHERE id=1",
            )
            .run(input.eth.toString(), input.usd, at);
        return changed;
      });
    return run();
  }
  confirmV4OperationalGas(input: {
    txHash: string;
    gas: bigint;
    eth: bigint;
    usd: number;
  }) {
    const at = new Date().toISOString();
    return (
      this.db
        .prepare(
          "UPDATE v4_live_gas SET actual_gas=?,actual_eth_raw=?,actual_usd=?,confirmed_at=? WHERE tx_hash=? AND actual_gas IS NULL",
        )
        .run(
          input.gas.toString(),
          input.eth.toString(),
          input.usd,
          at,
          input.txHash,
        ).changes > 0
    );
  }
  v4OperationalGasSpentUsd(intentId: string) {
    return Number(
      (
        this.db
          .prepare(
            "SELECT COALESCE(SUM(actual_usd),0) AS spent FROM v4_live_gas WHERE intent_id=?",
          )
          .get(intentId) as { spent: number }
      ).spent,
    );
  }
  v4LiveGas() {
    return this.db
      .prepare("SELECT * FROM v4_live_gas ORDER BY created_at")
      .all() as Record<string, unknown>[];
  }
  createV4PoolSelection(input: {
    userId: string;
    chatId: string;
    sessionId: string;
    poolId: string;
    poolKey: unknown;
    discoveryBlock: bigint;
    liquidity: bigint;
    targetToken?: string;
    fundingToken?: string;
    targetSymbol?: string;
    fundingSymbol?: string;
    symbolProvenance?: unknown;
    targetIndex?: 0 | 1;
    fundingIndex?: 0 | 1;
    feeSemantics?: unknown;
    hookStatus?: unknown;
    refreshBlock?: bigint;
    valuationSnapshot?: unknown;
    eligibility?: boolean;
    blockers?: string[];
    expiresAtMs?: number;
    supersedeExisting?: boolean;
  }) {
    const id = randomUUID(),
      at = new Date().toISOString(),
      j = (v: unknown) =>
        JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
    if (input.supersedeExisting !== false)
      this.supersedeV4PoolSelections(
        input.userId,
        input.chatId,
        input.sessionId,
      );
    this.db
      .prepare(
        "INSERT INTO v4_pool_selections(id,user_id,chat_id,session_id,pool_id,pool_key_json,discovery_block,liquidity_raw,created_at,target_token,funding_token,target_symbol,funding_symbol,symbol_provenance_json,target_index,funding_index,fee_semantics_json,hook_status_json,refresh_block,valuation_snapshot_json,eligibility,blockers_json,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.userId,
        input.chatId,
        input.sessionId,
        input.poolId,
        j(input.poolKey),
        input.discoveryBlock.toString(),
        input.liquidity.toString(),
        at,
        input.targetToken ?? null,
        input.fundingToken ?? null,
        input.targetSymbol ?? null,
        input.fundingSymbol ?? null,
        input.symbolProvenance === undefined ? null : j(input.symbolProvenance),
        input.targetIndex ?? null,
        input.fundingIndex ?? null,
        input.feeSemantics === undefined ? null : j(input.feeSemantics),
        input.hookStatus === undefined ? null : j(input.hookStatus),
        input.refreshBlock?.toString() ?? null,
        input.valuationSnapshot === undefined
          ? null
          : j(input.valuationSnapshot),
        input.eligibility ? 1 : 0,
        j(
          input.blockers ??
            (input.eligibility ? [] : ["LEGACY_INCOMPLETE_SELECTION"]),
        ),
        input.expiresAtMs ?? null,
      );
    return this.v4PoolSelection(id)!;
  }
  supersedeV4PoolSelections(userId: string, chatId: string, sessionId: string) {
    return this.db
      .prepare(
        "UPDATE v4_pool_selections SET superseded=1 WHERE user_id=? AND chat_id=? AND session_id=? AND superseded=0",
      )
      .run(userId, chatId, sessionId).changes;
  }
  supersedeOtherV4PoolSelections(
    userId: string,
    chatId: string,
    exceptSessionId: string,
  ) {
    return this.db
      .prepare(
        "UPDATE v4_pool_selections SET superseded=1 WHERE user_id=? AND chat_id=? AND session_id<>? AND superseded=0",
      )
      .run(userId, chatId, exceptSessionId).changes;
  }
  v4PoolSelection(id: string) {
    return this.db
      .prepare("SELECT * FROM v4_pool_selections WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
  }
  v4PoolSelectionsForSession(
    userId: string,
    chatId: string,
    sessionId: string,
  ) {
    return this.db
      .prepare(
        "SELECT * FROM v4_pool_selections WHERE user_id=? AND chat_id=? AND session_id=? AND superseded=0",
      )
      .all(userId, chatId, sessionId) as Record<string, unknown>[];
  }
  updateV4PoolSelectionState(
    id: string,
    input: {
      liquidity: bigint;
      refreshBlock?: bigint;
      eligibility: boolean;
      blockers: string[];
    },
  ) {
    this.db
      .prepare(
        "UPDATE v4_pool_selections SET liquidity_raw=?,refresh_block=?,eligibility=?,blockers_json=? WHERE id=? AND superseded=0",
      )
      .run(
        input.liquidity.toString(),
        input.refreshBlock?.toString() ?? null,
        input.eligibility ? 1 : 0,
        JSON.stringify(input.blockers),
        id,
      );
    return this.v4PoolSelection(id);
  }
  persistV4RegistryPool(input: V4RegistryPoolRecord) {
    const at = new Date().toISOString(),
      blockers: string[] = [];
    if (input.dynamicFee) blockers.push("DYNAMIC_FEE_UNSUPPORTED");
    if (input.hookClassification !== "ZERO_HOOK")
      blockers.push("NONZERO_HOOK_UNSUPPORTED");
    return this.db
      .prepare(
        "INSERT INTO v4_pool_registry(pool_id,chain_id,currency0,currency1,initialize_fee_raw,tick_spacing,hooks,initialization_block,initialization_tx_hash,initialization_tx_index,initialization_log_index,first_seen_at,hook_classification,dynamic_fee,static_fee_pips,validation_status,blockers_json,updated_at) VALUES(?,4663,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pool_id) DO UPDATE SET currency0=excluded.currency0,currency1=excluded.currency1,initialize_fee_raw=excluded.initialize_fee_raw,tick_spacing=excluded.tick_spacing,hooks=excluded.hooks,initialization_block=excluded.initialization_block,initialization_tx_hash=COALESCE(excluded.initialization_tx_hash,v4_pool_registry.initialization_tx_hash),initialization_tx_index=COALESCE(excluded.initialization_tx_index,v4_pool_registry.initialization_tx_index),initialization_log_index=COALESCE(excluded.initialization_log_index,v4_pool_registry.initialization_log_index),hook_classification=excluded.hook_classification,dynamic_fee=excluded.dynamic_fee,static_fee_pips=excluded.static_fee_pips,updated_at=excluded.updated_at WHERE v4_pool_registry.currency0 IS NOT excluded.currency0 OR v4_pool_registry.currency1 IS NOT excluded.currency1 OR v4_pool_registry.initialize_fee_raw IS NOT excluded.initialize_fee_raw OR v4_pool_registry.tick_spacing IS NOT excluded.tick_spacing OR v4_pool_registry.hooks IS NOT excluded.hooks OR v4_pool_registry.initialization_block IS NOT excluded.initialization_block OR v4_pool_registry.initialization_tx_hash IS NOT COALESCE(excluded.initialization_tx_hash,v4_pool_registry.initialization_tx_hash) OR v4_pool_registry.initialization_tx_index IS NOT COALESCE(excluded.initialization_tx_index,v4_pool_registry.initialization_tx_index) OR v4_pool_registry.initialization_log_index IS NOT COALESCE(excluded.initialization_log_index,v4_pool_registry.initialization_log_index) OR v4_pool_registry.hook_classification IS NOT excluded.hook_classification OR v4_pool_registry.dynamic_fee IS NOT excluded.dynamic_fee OR v4_pool_registry.static_fee_pips IS NOT excluded.static_fee_pips",
      )
      .run(
        input.poolId,
        input.currency0,
        input.currency1,
        input.initializeFeeRaw,
        input.tickSpacing,
        input.hooks,
        input.initializationBlock.toString(),
        input.initializationTxHash ?? null,
        input.initializationTxIndex ?? null,
        input.initializationLogIndex ?? null,
        at,
        input.hookClassification,
        input.dynamicFee ? 1 : 0,
        input.staticFeePips,
        blockers.length ? "BLOCKED" : "DISCOVERED",
        JSON.stringify(blockers),
        at,
      ).changes;
  }
  upsertV4RegistryPool(input: V4RegistryPoolRecord) {
    this.persistV4RegistryPool(input);
    return this.v4RegistryPool(input.poolId);
  }
  v4RegistryPool(poolId: string) {
    return this.db
      .prepare("SELECT * FROM v4_pool_registry WHERE chain_id=4663 AND lower(pool_id)=lower(?)")
      .get(poolId) as Record<string, unknown> | undefined;
  }
  v4RegistryPoolsForToken(token: string, fundingTokens: string[]) {
    if (!fundingTokens.length) return [];
    const placeholders = fundingTokens.map(() => "?").join(","),
      lower = fundingTokens.map((x) => x.toLowerCase());
    return this.db
      .prepare(
        `SELECT * FROM v4_pool_registry WHERE (lower(currency0)=lower(?) AND lower(currency1) IN (${placeholders})) OR (lower(currency1)=lower(?) AND lower(currency0) IN (${placeholders})) ORDER BY initialization_block,pool_id`,
      )
      .all(token, ...lower, token, ...lower) as Record<string, unknown>[];
  }
  tokenMetadata(address: string) {
    return this.db
      .prepare(
        "SELECT * FROM token_metadata_cache WHERE lower(address)=lower(?)",
      )
      .get(address) as Record<string, unknown> | undefined;
  }
  v3CachedPoolsForToken(
    token: string,
    fundingTokens: string[],
    now = Date.now(),
  ) {
    if (!fundingTokens.length) return [];
    const p = fundingTokens.map(() => "?").join(","),
      lower = fundingTokens.map((x) => x.toLowerCase());
    return this.db
      .prepare(
        `SELECT * FROM v3_pool_state_cache WHERE initialized=1 AND CAST(liquidity_raw AS INTEGER)>0 AND refreshed_at_ms>? AND ((lower(token0_address)=lower(?) AND lower(token1_address) IN (${p})) OR (lower(token1_address)=lower(?) AND lower(token0_address) IN (${p}))) ORDER BY lower(pool_address) ASC`,
      )
      .all(now - 120_000, token, ...lower, token, ...lower) as Record<
      string,
      unknown
    >[];
  }
  updateV4RegistryTvl(
    poolId: string,
    input: {
      tvlUsd?: number;
      tvlSource?: string;
      observedAtMs?: number;
      freshUntilMs?: number;
      status: string;
    },
  ) {
    this.db
      .prepare(
        "UPDATE v4_pool_registry SET tvl_usd=?,tvl_source=?,tvl_observed_at_ms=?,tvl_fresh_until_ms=?,tvl_status=?,updated_at=? WHERE lower(pool_id)=lower(?)",
      )
      .run(
        input.tvlUsd ?? null,
        input.tvlSource ?? null,
        input.observedAtMs ?? null,
        input.freshUntilMs ?? null,
        input.status,
        new Date().toISOString(),
        poolId,
      );
    return this.v4RegistryPool(poolId);
  }
  upsertTokenMetadata(input: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    refreshedAtMs?: number;
  }) {
    this.db
      .prepare(
        "INSERT INTO token_metadata_cache(address,symbol,name,decimals,refreshed_at_ms) VALUES(?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,decimals=excluded.decimals,refreshed_at_ms=excluded.refreshed_at_ms",
      )
      .run(
        input.address,
        input.symbol,
        input.name,
        input.decimals,
        input.refreshedAtMs ?? Date.now(),
      );
  }
  enqueueV4StateRefresh(
    poolId: string,
    priority: number,
    reason: string,
    now = Date.now(),
    availableAtMs = now,
  ) {
    const lane = ["OPERATIONAL_OPEN_POOL_FRESHNESS", "REPOSITION_ON_DEMAND_POOL_FRESHNESS", "ACTIVE_OPEN_POOL_REFRESH_DUE"].includes(reason)
      ? "urgent"
      : "background";
    this.db
      .prepare(
        "INSERT INTO v4_state_refresh_queue(pool_id,lane,priority,reason,requested_at_ms,available_at_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(pool_id,lane) DO UPDATE SET priority=max(priority,excluded.priority),reason=CASE WHEN excluded.priority>=priority THEN excluded.reason ELSE reason END,requested_at_ms=min(requested_at_ms,excluded.requested_at_ms),available_at_ms=CASE WHEN leased_until_ms IS NULL THEN min(available_at_ms,excluded.available_at_ms) ELSE available_at_ms END",
      )
      .run(poolId, lane, priority, reason, now, availableAtMs);
  }
  enqueueNewV4Pools(limit = 100, now = Date.now()) {
    const rows = this.db
      .prepare(
        "SELECT pool_id FROM v4_pool_registry WHERE last_refreshed_at IS NULL ORDER BY initialization_block DESC LIMIT ?",
      )
      .all(limit) as Array<{ pool_id: string }>;
    for (const row of rows)
      this.enqueueV4StateRefresh(row.pool_id, 80, "new-pool", now);
    return rows.length;
  }
  enqueueV4PoolsDiscoveredBetween(
    fromBlock: bigint,
    toBlock: bigint,
    now = Date.now(),
  ) {
    const rows = this.db
      .prepare(
        "SELECT pool_id FROM v4_pool_registry WHERE CAST(initialization_block AS INTEGER) BETWEEN ? AND ?",
      )
      .all(fromBlock.toString(), toBlock.toString()) as Array<{
      pool_id: string;
    }>;
    for (const row of rows)
      this.enqueueV4StateRefresh(row.pool_id, 80, "new-pool", now);
    return rows.length;
  }
  enqueueHotV4Pools(limit = 20, now = Date.now()) {
    const cutoff = new Date(now - 60_000).toISOString(),
      rows = this.db
        .prepare(
          "SELECT pool_id FROM v4_pool_registry WHERE (validation_status='ELIGIBLE' OR CAST(active_liquidity_raw AS INTEGER)>0) AND (last_refreshed_at IS NULL OR last_refreshed_at<?) ORDER BY CASE WHEN validation_status='ELIGIBLE' THEN 0 ELSE 1 END,last_refreshed_at LIMIT ?",
        )
        .all(cutoff, limit) as Array<{ pool_id: string }>;
    for (const row of rows)
      this.enqueueV4StateRefresh(row.pool_id, 60, "active-or-eligible", now);
    return rows.length;
  }
  leaseV4StateRefresh(limit: number, leaseMs: number, now = Date.now()) {
    const run = this.db.transaction(() => {
      const rows = this.db
          .prepare(
            "SELECT * FROM v4_state_refresh_queue WHERE lane='background' AND available_at_ms<=? AND (leased_until_ms IS NULL OR leased_until_ms<?) ORDER BY priority DESC,requested_at_ms LIMIT ?",
          )
          .all(now, now, limit) as Record<string, unknown>[],
        lease = this.db.prepare(
          "UPDATE v4_state_refresh_queue SET leased_until_ms=?,leased_at_ms=?,lease_owner='legacy-background-consumer' WHERE pool_id=? AND lane='background' AND (leased_until_ms IS NULL OR leased_until_ms<?)",
        );
      return rows.filter(
        (row) => lease.run(now + leaseMs, now, row.pool_id, now).changes === 1,
      );
    });
    return run();
  }
  completeV4StateRefresh(poolId: string, ownerId?: string, maintenance?: { ttlMs: number; refreshedAtMs?: number; nowMs?: number }) {
    const removed = this.db
      .prepare(
        `DELETE FROM v4_state_refresh_queue WHERE lower(pool_id)=lower(?) AND leased_until_ms IS NOT NULL AND ${ownerId ? "lease_owner=?" : "(lease_owner IS NULL OR lease_owner LIKE 'legacy-%')"}`,
      )
      .run(poolId, ...(ownerId ? [ownerId] : [])).changes;
    if (removed && maintenance && Number.isSafeInteger(maintenance.ttlMs) && maintenance.ttlMs > 0) {
      const liveOpen = Boolean(this.db.prepare("SELECT 1 FROM v4_bid_ladders WHERE lower(pool_id)=lower(?) AND execution_mode='LIVE' AND status='OPEN' LIMIT 1").get(poolId));
      if (liveOpen) {
        const nowMs = maintenance.nowMs ?? Date.now(), registry = this.v4RegistryPool(poolId), parsed = registry?.last_refreshed_at ? Date.parse(String(registry.last_refreshed_at)) : 0,
          refreshedAtMs = maintenance.refreshedAtMs ?? parsed,
          headroomMs = Math.min(60_000, Math.max(15_000, Math.floor(maintenance.ttlMs / 3))),
          nextDueAtMs = refreshedAtMs + maintenance.ttlMs - headroomMs;
        if (Number.isSafeInteger(refreshedAtMs) && refreshedAtMs > 0)
          this.enqueueV4StateRefresh(poolId, 400, "ACTIVE_OPEN_POOL_REFRESH_DUE", refreshedAtMs, Math.max(nowMs, nextDueAtMs));
      }
    }
    return removed;
  }
  retryV4StateRefresh(
    poolId: string,
    error: string,
    attempts: number,
    now = Date.now(),
    ownerId?: string,
  ) {
    const delay = Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8));
    this.db
      .prepare(
        `UPDATE v4_state_refresh_queue SET attempts=?,available_at_ms=?,leased_until_ms=NULL,leased_at_ms=NULL,lease_owner=NULL,last_error=? WHERE lower(pool_id)=lower(?) AND ${ownerId ? "lease_owner=?" : "lane='background' AND lease_owner IS NULL"}`,
      )
      .run(attempts, now + delay, error.slice(0, 500), poolId, ...(ownerId ? [ownerId] : []));
  }
  recordLatency(
    metric: string,
    durationMs: number,
    input: {
      provider?: string;
      fallbackUsed?: boolean;
      cacheAgeMs?: number;
      context?: unknown;
    } = {},
  ) {
    this.db
      .prepare(
        "INSERT INTO latency_telemetry(metric,duration_ms,provider,fallback_used,cache_age_ms,context_json,created_at_ms) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        metric,
        Math.max(0, Math.round(durationMs)),
        input.provider ?? null,
        input.fallbackUsed ? 1 : 0,
        input.cacheAgeMs ?? null,
        deterministicTelemetryJson(input.context),
        Date.now(),
      );
  }
  refreshV4RegistryPool(input: {
    poolId: string;
    sqrtPriceX96: bigint;
    tick: number;
    liquidity: bigint;
    protocolFee: number;
    lpFeePips: number;
    initialized: boolean;
    refreshBlock: bigint;
    validationStatus: string;
    blockers: string[];
  }) {
    const at = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE v4_pool_registry SET sqrt_price_x96=?,current_tick=?,active_liquidity_raw=?,current_protocol_fee=?,current_lp_fee_pips=?,initialized=?,refresh_block=?,last_refreshed_at=?,validation_status=?,blockers_json=?,updated_at=? WHERE chain_id=4663 AND lower(pool_id)=lower(?) AND (refresh_block IS NULL OR CAST(refresh_block AS INTEGER)<=CAST(? AS INTEGER))",
      )
      .run(
        input.sqrtPriceX96.toString(),
        input.tick,
        input.liquidity.toString(),
        input.protocolFee,
        input.lpFeePips,
        input.initialized ? 1 : 0,
        input.refreshBlock.toString(),
        at,
        input.validationStatus,
        JSON.stringify([...new Set(input.blockers)]),
        at,
        input.poolId,
        input.refreshBlock.toString(),
      );
    return this.v4RegistryPool(input.poolId);
  }
  v4RegistryCursor() {
    return this.db
      .prepare("SELECT * FROM v4_pool_discovery_cursor WHERE chain_id=4663")
      .get() as Record<string, unknown> | undefined;
  }
  initializeV4RegistryCursor(input: {
    nextBlock: bigint;
    overlapBlocks: number;
    windowSize: number;
  }) {
    const at = new Date().toISOString();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO v4_pool_discovery_cursor(chain_id,next_block,overlap_blocks,window_size,updated_at) VALUES(4663,?,?,?,?)",
      )
      .run(
        input.nextBlock.toString(),
        input.overlapBlocks,
        input.windowSize,
        at,
      );
    return this.v4RegistryCursor()!;
  }
  configureV4RegistryCursor(input: {
    windowSize?: number;
    overlapBlocks?: number;
  }) {
    const current = this.v4RegistryCursor();
    if (!current) throw new Error("V4_REGISTRY_CURSOR_NOT_INITIALIZED");
    const window = input.windowSize ?? Number(current.window_size),
      overlap = input.overlapBlocks ?? Number(current.overlap_blocks);
    if (
      !Number.isSafeInteger(window) ||
      window < 1 ||
      window > 1_000_000 ||
      !Number.isSafeInteger(overlap) ||
      overlap < 0 ||
      overlap >= window
    )
      throw new Error("V4_REGISTRY_WINDOW_CONFIGURATION_INVALID");
    this.db
      .prepare(
        "UPDATE v4_pool_discovery_cursor SET window_size=?,overlap_blocks=?,updated_at=? WHERE chain_id=4663",
      )
      .run(window, overlap, new Date().toISOString());
    return this.v4RegistryCursor()!;
  }
  startV4RegistrySync(chainBlock: bigint) {
    const at = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE v4_pool_discovery_cursor SET last_chain_block=?,last_sync_started_at=?,last_error=NULL,updated_at=? WHERE chain_id=4663",
      )
      .run(chainBlock.toString(), at, at);
  }
  advanceV4RegistryCursor(nextBlock: bigint) {
    this.db
      .prepare(
        "UPDATE v4_pool_discovery_cursor SET next_block=?,updated_at=? WHERE chain_id=4663",
      )
      .run(nextBlock.toString(), new Date().toISOString());
  }
  commitV4RegistryWindow(input: {
    nextBlock: bigint;
    chainBlock: bigint;
    syncStartedAtMs: number;
    syncDurationMs: number;
    fallbackUses?: number;
  }) {
    const completedAt = new Date().toISOString();
    return this.db
      .prepare(
        "UPDATE v4_pool_discovery_cursor SET next_block=?,last_chain_block=?,last_sync_started_at=?,last_sync_completed_at=?,last_sync_duration_ms=?,last_error=NULL,fallback_uses=fallback_uses+?,updated_at=? WHERE chain_id=4663",
      )
      .run(
        input.nextBlock.toString(),
        input.chainBlock.toString(),
        new Date(input.syncStartedAtMs).toISOString(),
        completedAt,
        input.syncDurationMs,
        input.fallbackUses ?? 0,
        completedAt,
      ).changes;
  }
  finishV4RegistrySync(input: {
    durationMs: number;
    error?: string;
    fallbackUses?: number;
  }) {
    const at = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE v4_pool_discovery_cursor SET last_sync_completed_at=?,last_sync_duration_ms=?,last_error=?,fallback_uses=fallback_uses+?,updated_at=? WHERE chain_id=4663",
      )
      .run(
        at,
        input.durationMs,
        input.error ?? null,
        input.fallbackUses ?? 0,
        at,
      );
  }
  v4RegistryStatus() {
    const cursor = this.v4RegistryCursor(),
      counts = this.db
        .prepare(
          "SELECT COUNT(*) total,SUM(CASE WHEN initialized=1 AND CAST(active_liquidity_raw AS INTEGER)>0 THEN 1 ELSE 0 END) active,SUM(CASE WHEN hook_classification!='ZERO_HOOK' THEN 1 ELSE 0 END) hooked,SUM(dynamic_fee) dynamic,SUM(CASE WHEN validation_status='ELIGIBLE' THEN 1 ELSE 0 END) eligible FROM v4_pool_registry",
        )
        .get() as Record<string, unknown>;
    return { cursor, counts };
  }
}
