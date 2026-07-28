import type { MarketRangeDisplay, PortfolioAccounting } from "../../cli/src/portfolio.js";
import {
  buildPersistedPortfolioSnapshot,
  persistedPortfolioSnapshot,
  type TerminalReason,
} from "../../cli/src/active-position-reconciliation.js";
import type { SqliteLedgerRepository } from "@robin/ledger";
import type { BotManagedExposureResult } from "../../cli/src/bot-managed-exposure.js";

export type PersistedPositionView = {
  protocol: "v3" | "v4";
  tokenId: string;
  positionId: string;
  pair: string;
  poolId: string;
  status: string;
  range: string;
  rangeStatus: "IN_RANGE" | "OUT_OF_RANGE" | "CLOSED" | "UNAVAILABLE";
  currentPriceUsd: number | null;
  marketRange?: MarketRangeDisplay;
  source: "BOT_OPERATIONAL" | "MANUAL_EXTERNAL" | "TRACKED";
  accountingStatus: string;
  accounting: PortfolioAccounting;
  openedAt: string | null;
  baselineProvenance: string | null;
  fundingProvenance: string | null;
  openIntentId: string | null;
  lifecycle:
    | "CONFIRMED_ACTIVE_FRESH"
    | "CONFIRMED_ACTIVE_REFRESHING"
    | "OPEN_CONFIRMING"
    | "PENDING_NEVER_VERIFIED"
    | "TERMINAL";
  terminalReason: TerminalReason | null;
  ownerResult: string | null;
  liquidityRaw: string | null;
  tickLower: number | null;
  tickUpper: number | null;
  claimable0Raw: string | null;
  claimable1Raw: string | null;
  lastReconciledAt: string | null;
  priceSource: string | null;
  priceBlock: string | null;
  priceObservedAt: string | null;
  reconciliation: string;
  excludedFromAggregateReason: string | null;
};
export type PersistedPortfolioSummary = {
  totalEquityUsd: number | null;
  originalCapitalUsd: number | null;
  grossPnlUsd: number | null;
  netPnlUsd: number | null;
  roiPct: number | null;
  uncollectedFeesUsd: number | null;
  collectedFeesUsd: number | null;
  realizedProceedsUsd: number | null;
  gasSpentUsd: number | null;
  activePositions: number;
  inRange: number;
  outOfRange: number;
  openConfirmingCount: number;
  pendingReconciliationCount: number;
  lastReconciliationAt: string | null;
};
export type PersistedExposureSummary = {
  activeBotManagedEquityUsd: number | null;
  externalEquityUsd: number | null;
  totalWalletEquityUsd: number | null;
  ambiguityReasons: string[];
};

const money = (value: number | null) =>
  value === null ? "Unavailable" : `$${value.toFixed(2)}`;
const percent = (value: number | null) =>
  value === null ? "Unavailable" : `${value.toFixed(2)}%`;
const percentLabel = (value: number | null) =>
  value === null ? "Unavailable" : `${value.toFixed(2)}%`;
export const compactUsd = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(value >= 100_000_000_000 ? 0 : 2).replace(/\.0+$/, "")}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 100_000_000 ? 0 : 2).replace(/\.0+$/, "")}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 100_000 ? 0 : 2).replace(/\.0+$/, "")}K`;
  return `$${value >= 1 ? value.toFixed(2) : value.toPrecision(3)}`;
};
const marketReason = (reason: MarketRangeDisplay["reason"] | undefined) =>
  reason === "SUPPLY_EVIDENCE_MISSING" ? "Supply evidence missing" :
  reason === "LP_TICK_METADATA_UNAVAILABLE" ? "LP tick metadata missing" :
  reason === "TOKEN_DECIMALS_UNAVAILABLE" ? "Token decimals missing" :
  reason === "USD_QUOTE_TOKEN_UNAVAILABLE" ? "USD quote token unavailable" :
  reason === "CURRENT_TOKEN_PRICE_UNAVAILABLE" ? "Current token price unavailable" : "Unavailable";
const marketStatus = (status: MarketRangeDisplay["rangeStatus"] | undefined) =>
  status === "IN_RANGE" ? "In range" : status === "BELOW_RANGE" ? "Below range" : status === "ABOVE_RANGE" ? "Above range" : "Unavailable";
export function marketRangeLines(range: MarketRangeDisplay | undefined) {
  const label = range?.label ?? "MC";
  const current = range?.currentUsd ?? null, lower = range?.lowerUsd ?? null, upper = range?.upperUsd ?? null;
  return [
    `Current ${label}: ${compactUsd(current)}`,
    `LP ${label} range: ${lower === null || upper === null ? "Unavailable" : `${compactUsd(lower)} – ${compactUsd(upper)}`}`,
    `Range status: ${marketStatus(range?.rangeStatus)}`,
    ...(current === null || lower === null || upper === null ? [`Reason: ${marketReason(range?.reason)}`] : []),
  ];
}
const sourceLabel = (source: PersistedPositionView["source"]) =>
  source === "BOT_OPERATIONAL"
    ? "Bot-managed"
    : source === "MANUAL_EXTERNAL"
      ? "External"
      : "Tracked";
const rangeLabel = (status: PersistedPositionView["rangeStatus"]) =>
  status === "IN_RANGE"
    ? "In range"
    : status === "OUT_OF_RANGE"
      ? "Out of range"
      : status === "CLOSED"
        ? "Closed"
        : "Unavailable";
const lifecycleLabel = (position: PersistedPositionView) =>
  position.lifecycle === "CONFIRMED_ACTIVE_FRESH"
    ? "Active"
    : position.lifecycle === "CONFIRMED_ACTIVE_REFRESHING"
      ? "Active · refreshing"
      : position.lifecycle === "OPEN_CONFIRMING"
        ? "Opening · confirming"
        : position.lifecycle === "TERMINAL"
          ? "Closed"
          : "Unavailable";

export function persistedPositionViews(
  repo: SqliteLedgerRepository,
): PersistedPositionView[] {
  const snapshot = persistedPortfolioSnapshot(repo) as {
    positions?: PersistedPositionView[];
  };
  return Array.isArray(snapshot.positions)
    ? snapshot.positions
    : (buildPersistedPortfolioSnapshot(repo)
        .positions as PersistedPositionView[]);
}
export function persistedPositionCard(position: PersistedPositionView) {
  return [
    `${position.pair} · ${position.protocol} · NFT ${position.tokenId}`,
    `Current value: ${money(position.accounting.currentEquityUsd)} · PnL: ${position.accounting.netPnlUsd === null ? "Unavailable" : `${percentLabel(position.accounting.netPnlUsd)} (${money(position.accounting.netPnlUsd)})`}`,
    `${rangeLabel(position.rangeStatus)} · ${sourceLabel(position.source)}`,
  ].join("\n");
}
export function persistedPositionSummary(position: PersistedPositionView) {
  return `${position.pair} · ${position.protocol} · NFT ${position.tokenId} · ${money(position.accounting.currentEquityUsd)} · ${rangeLabel(position.rangeStatus)} · ${sourceLabel(position.source)}`;
}
export function persistedPositionDetail(position: PersistedPositionView) {
  const a = position.accounting;
  return [
    `${position.pair} · ${position.protocol} · NFT ${position.tokenId}`,
    `${lifecycleLabel(position)} · ${rangeLabel(position.rangeStatus)} · ${sourceLabel(position.source)}`,
    `Current value: ${money(a.currentEquityUsd)}`,
    `Cost basis: ${money(a.externalCapitalUsd)}`,
    `Current principal: ${money(a.activePrincipalUsd)}`,
    `Unclaimed fees: ${money(a.uncollectedFeesUsd)}`,
    `Collected fees: ${money(a.collectedFeesUsd)}`,
    `Realized proceeds: ${money(a.realizedProceedsUsd)}`,
    `Gross PnL: ${money(a.grossPnlUsd)}`,
    `Gas spent: ${money(a.gasSpentUsd)}`,
    `Net PnL: ${money(a.netPnlUsd)}`,
    `ROI: ${percent(a.netPnlPct)}`,
    ...marketRangeLines(position.marketRange),
    `Opened: ${position.openedAt ?? "Unavailable"}`,
  ].join("\n");
}
export function persistedPositionTechnicalDetails(
  position: PersistedPositionView,
) {
  return [
    "Technical details",
    `Pool address: ${position.poolId}`,
    `Owner: ${position.ownerResult ?? "Unavailable"}`,
    `Raw liquidity: ${position.liquidityRaw ?? "Unavailable"}`,
    `Ticks: ${position.tickLower ?? "Unavailable"} → ${position.tickUpper ?? "Unavailable"}`,
    `Raw claimable: ${position.claimable0Raw ?? "Unavailable"} / ${position.claimable1Raw ?? "Unavailable"}`,
    `Source provenance: ${position.source}`,
    `Accounting state: ${position.accountingStatus}`,
    `Baseline provenance: ${position.baselineProvenance ?? "Unavailable"}`,
    `Funding provenance: ${position.fundingProvenance ?? "Unavailable"}`,
    `Internal status: ${position.lifecycle}${position.terminalReason ? ` · ${position.terminalReason}` : ""}`,
    `Price source: ${position.priceSource ?? "Unavailable"}`,
    `Price block/time: ${position.priceBlock ?? "Unavailable"} · ${position.priceObservedAt ?? "Unavailable"}`,
    `Reconciliation: ${position.reconciliation}`,
    `Last reconciled: ${position.lastReconciledAt ?? "Unavailable"}`,
  ].join("\n");
}
export function formatPortfolioSnapshot(
  snapshot: PersistedPortfolioSummary,
  exposure?: PersistedExposureSummary,
  cap?: number,
) {
  return [
    "Portfolio",
    ...(exposure
      ? [
          `Robin-managed equity: ${money(exposure.activeBotManagedEquityUsd)}`,
          `External equity (informational): ${money(exposure.externalEquityUsd)}`,
          `Total wallet LP equity: ${money(exposure.totalWalletEquityUsd)}`,
          `Robin aggregate cap: ${cap === undefined ? "not configured" : money(cap)}`,
          "External positions are excluded from Robin’s execution budget.",
          ...(exposure.ambiguityReasons.length
            ? [
                `Ambiguous provenance: ${exposure.ambiguityReasons.length} position(s) excluded from managed and external totals.`,
              ]
            : []),
        ]
      : []),
    `Total equity: ${money(snapshot.totalEquityUsd)}`,
    `Original capital: ${money(snapshot.originalCapitalUsd)}`,
    `Gross PnL: ${money(snapshot.grossPnlUsd)}`,
    `Net PnL: ${money(snapshot.netPnlUsd)}`,
    `ROI: ${percent(snapshot.roiPct)}`,
    `Unclaimed fees: ${money(snapshot.uncollectedFeesUsd)}`,
    `Collected fees: ${money(snapshot.collectedFeesUsd)}`,
    `Realized proceeds: ${money(snapshot.realizedProceedsUsd)}`,
    `Gas spent: ${money(snapshot.gasSpentUsd)}`,
    `Active positions: ${snapshot.activePositions}`,
    `In range: ${snapshot.inRange}`,
    `Out of range: ${snapshot.outOfRange}`,
    ...(snapshot.openConfirmingCount
      ? [`Opening · confirming: ${snapshot.openConfirmingCount}`]
      : []),
    ...(snapshot.pendingReconciliationCount
      ? [`Pending reconciliation: ${snapshot.pendingReconciliationCount}`]
      : []),
    `Last refreshed: ${snapshot.lastReconciliationAt ?? "Unavailable"}`,
  ].join("\n");
}
export function formatRebalanceExposurePreview(
  exposure: BotManagedExposureResult,
  cap?: number,
) {
  const b = exposure.breakdown,
    blocked =
      exposure.reason ??
      (cap === undefined ? "BOT_MANAGED_EXPOSURE_CAP_UNCONFIGURED" : undefined),
    headroom =
      cap !== undefined && b.projectedExposureUsd !== null
        ? cap - b.projectedExposureUsd
        : null;
  if (blocked)
    return [
      "Robin-managed exposure",
      "Aggregate status: " + blocked,
      "Live execution blocked: " + blocked,
      ...b.ambiguityReasons.map((reason) => `Ambiguous/TRACKED position: ${reason}`),
      "No exposure value has been substituted.",
    ].join("\n");
  return [
    "Robin-managed exposure",
    `Current Robin-managed equity: ${money(b.activeBotManagedEquityUsd)}`,
    `Unresolved Robin-funded commitments: ${money(b.pendingOpenCommitmentUsd + b.pendingReplacementCommitmentUsd)}`,
    `Permanently released historical commitment: ${money(b.releasedHistoricalCommitmentUsd??0)} (excluded from Robin execution exposure; workflows permanently non-resumable)`,
    `Incremental Robin capital for this action: ${money(b.incrementalActionCapitalUsd)}`,
    `Projected Robin-managed exposure: ${money(b.projectedExposureUsd)}`,
    `Robin aggregate cap: ${cap === undefined ? "not configured" : money(cap)}`,
    `Remaining headroom: ${headroom === null ? "Unavailable" : money(headroom)}`,
    `External wallet equity (informational): ${money(b.externalEquityUsd)}`,
    `Total wallet LP equity: ${money(b.totalWalletEquityUsd)}`,
    ...(b.ambiguityReasons.length
      ? [
          `Ambiguous/TRACKED positions: ${b.ambiguityReasons.join("; ")}`,
          "Live execution blocked: BOT_MANAGED_EXPOSURE_SOURCE_AMBIGUOUS",
        ]
      : []),
    "External positions are excluded from Robin’s execution budget.",
  ].join("\n");
}
