import {
  canonicalPortfolioAccounting,
  type MarketRangeDisplay,
  type PortfolioAccounting,
} from "../../cli/src/portfolio.js";
import {
  activePositionTruth,
  buildPersistedV4PositionView,
  type TerminalReason,
} from "../../cli/src/active-position-reconciliation.js";
import type { SqliteLedgerRepository } from "@funi/ledger";

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
  if (value >= 1_000_000_000)
    return `$${(value / 1_000_000_000).toFixed(value >= 100_000_000_000 ? 0 : 2).replace(/\.0+$/, "")}B`;
  if (value >= 1_000_000)
    return `$${(value / 1_000_000).toFixed(value >= 100_000_000 ? 0 : 2).replace(/\.0+$/, "")}M`;
  if (value >= 1_000)
    return `$${(value / 1_000).toFixed(value >= 100_000 ? 0 : 2).replace(/\.0+$/, "")}K`;
  return `$${value >= 1 ? value.toFixed(2) : value.toPrecision(3)}`;
};
const marketReason = (reason: MarketRangeDisplay["reason"] | undefined) =>
  reason === "SUPPLY_EVIDENCE_MISSING"
    ? "Supply evidence missing"
    : reason === "LP_TICK_METADATA_UNAVAILABLE"
      ? "LP tick metadata missing"
      : reason === "TOKEN_DECIMALS_UNAVAILABLE"
        ? "Token decimals missing"
        : reason === "USD_QUOTE_TOKEN_UNAVAILABLE"
          ? "USD quote token unavailable"
          : reason === "CURRENT_TOKEN_PRICE_UNAVAILABLE"
            ? "Current token price unavailable"
            : "Unavailable";
const marketStatus = (status: MarketRangeDisplay["rangeStatus"] | undefined) =>
  status === "IN_RANGE"
    ? "In range"
    : status === "BELOW_RANGE"
      ? "Below range"
      : status === "ABOVE_RANGE"
        ? "Above range"
        : "Unavailable";
export function marketRangeLines(range: MarketRangeDisplay | undefined) {
  const label = range?.label ?? "MC";
  const current = range?.currentUsd ?? null,
    lower = range?.lowerUsd ?? null,
    upper = range?.upperUsd ?? null;
  return [
    `Current ${label}: ${compactUsd(current)}`,
    `LP ${label} range: ${lower === null || upper === null ? "Unavailable" : `${compactUsd(lower)} – ${compactUsd(upper)}`}`,
    `Range status: ${marketStatus(range?.rangeStatus)}`,
    ...(current === null || lower === null || upper === null
      ? [`Reason: ${marketReason(range?.reason)}`]
      : []),
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

function recordLiveOverlayActionability(repo:SqliteLedgerRepository,input:{ladderId:string;poolId:string;tokenIds:string[];poolFreshAtMs:number;allNftsFreshAtMs:number}){
 try{
  const confirmed=repo.db.prepare("SELECT confirmed_at FROM chain_transaction_journal WHERE chain_id=4663 AND workflow_identity=? AND semantic_stage='OPEN_BATCH' AND status='CONFIRMED' ORDER BY attempt DESC LIMIT 1").get(input.ladderId) as {confirmed_at:string|null}|undefined,openConfirmedAtMs=confirmed?.confirmed_at?Date.parse(confirmed.confirmed_at):0;
  if(!openConfirmedAtMs)return;
  const prior=repo.db.prepare("SELECT 1 FROM latency_telemetry WHERE metric='v4_bid_ladder_open_to_user_actionable' AND json_extract(context_json,'$.ladderId')=? AND json_extract(context_json,'$.source')='canonical_live_overlay' LIMIT 1").get(input.ladderId);if(prior)return;
  let poolFreshAtMs=input.poolFreshAtMs,allNftsFreshAtMs=input.allNftsFreshAtMs,composedActionableAtMs=Math.max(poolFreshAtMs,allNftsFreshAtMs);
  if(composedActionableAtMs-openConfirmedAtMs>=30_000){
   const firstPool=repo.db.prepare("SELECT CAST(json_extract(context_json,'$.serviceEndedAtMs') AS INTEGER) at_ms FROM latency_telemetry WHERE metric='v4_state_refresh_request_lifecycle' AND created_at_ms>=? AND lower(json_extract(context_json,'$.poolId'))=lower(?) AND json_extract(context_json,'$.completionReason') IN ('RPC_REFRESHED','ALREADY_FRESH_OBLIGATION_SATISFIED') ORDER BY created_at_ms LIMIT 1").get(openConfirmedAtMs,input.poolId) as {at_ms:number}|undefined,placeholders=input.tokenIds.map(()=>'?').join(','),firstNfts=repo.db.prepare(`SELECT json_extract(context_json,'$.positionId') position_id,MIN(CAST(json_extract(context_json,'$.serviceEndedAtMs') AS INTEGER)) at_ms FROM latency_telemetry WHERE metric='targeted_nft_request_lifecycle' AND created_at_ms>=? AND json_extract(context_json,'$.completionReason')='RPC_REFRESHED' AND json_extract(context_json,'$.positionId') IN (${placeholders}) GROUP BY json_extract(context_json,'$.positionId')`).all(openConfirmedAtMs,...input.tokenIds.map(tokenId=>`v4:${tokenId}`)) as Array<{position_id:string;at_ms:number}>;
   poolFreshAtMs=Number(firstPool?.at_ms??poolFreshAtMs);if(firstNfts.length===5)allNftsFreshAtMs=Math.max(...firstNfts.map(row=>Number(row.at_ms)));composedActionableAtMs=Math.max(poolFreshAtMs,allNftsFreshAtMs);
  }
  const totalMs=composedActionableAtMs-openConfirmedAtMs;if(totalMs>=0)repo.recordLatency('v4_bid_ladder_open_to_user_actionable',totalMs,{context:{ladderId:input.ladderId,openConfirmedAtMs,poolFreshAtMs,allNftsFreshAtMs,composedActionableAtMs,totalMs,source:'canonical_live_overlay',classification:totalMs<30_000?'PASS':'FAIL'}});
 }catch{}
}

export function persistedPositionViews(
  repo: SqliteLedgerRepository,
  nowMs = Date.now(),
  poolTtlMs = 120_000,
): PersistedPositionView[] {
  const snapshotRow = repo.db.prepare("SELECT payload_json,refreshed_at_ms FROM portfolio_persisted_snapshot WHERE snapshot_key='current'").get() as {payload_json:string;refreshed_at_ms:number}|undefined;
  let snapshot:{positions?:PersistedPositionView[]}={};
  try{snapshot=snapshotRow?JSON.parse(snapshotRow.payload_json):{};}catch{}
  const persisted = Array.isArray(snapshot.positions) ? snapshot.positions : [],
    byId = new Map(persisted.map(position => [position.positionId, position])),
    unavailableAccounting: PortfolioAccounting = {
      externalCapitalUsd:null,activePrincipalUsd:null,uncollectedFeesUsd:null,collectedFeesUsd:null,
      realizedProceedsUsd:null,gasSpentUsd:null,currentEquityUsd:null,grossPnlUsd:null,grossPnlPct:null,
      netPnlUsd:null,netPnlPct:null,warnings:["CANONICAL_RECONCILIATION_PENDING"],
    };
  const truthRows=activePositionTruth(repo,nowMs),truthById=new Map(truthRows.map(item=>[item.positionId,item]));
  for (const truth of truthRows) {
    if (truth.protocol !== "v4") continue;
    const prior = byId.get(truth.positionId), rec = truth.reconciliation;
    if (prior) {
      byId.set(truth.positionId, {
        ...prior,status:truth.localStatus,lifecycle:truth.classification,terminalReason:truth.terminalReason,
        ownerResult:rec?.owner_result??prior.ownerResult,liquidityRaw:rec?.liquidity_raw??prior.liquidityRaw,
        claimable0Raw:rec?.claimable0_raw??prior.claimable0Raw,claimable1Raw:rec?.claimable1_raw??prior.claimable1Raw,
        lastReconciledAt:rec?new Date(rec.checked_at_ms).toISOString():prior.lastReconciledAt,
        rangeStatus:truth.classification==="TERMINAL"?"CLOSED":prior.rangeStatus,
      });
      continue;
    }
    if(truth.classification==='TERMINAL')continue;
    const row = repo.v4Position(truth.tokenId);
    if (!row) continue;
    const operational = Boolean(row.open_intent_id);
    const immediate=operational?buildPersistedV4PositionView(repo,truth,nowMs) as PersistedPositionView|undefined:undefined;
    if(immediate){byId.set(truth.positionId,immediate);continue;}
    byId.set(truth.positionId, {
      protocol:"v4",tokenId:truth.tokenId,positionId:truth.positionId,
      pair:`${String(row.target_symbol??"Unavailable")}/${String(row.funding_symbol??"Unavailable")}`,
      poolId:String(row.pool_id),status:truth.localStatus,range:"Unavailable",
      rangeStatus:"UNAVAILABLE",currentPriceUsd:null,
      source:operational?"BOT_OPERATIONAL":"TRACKED",accountingStatus:operational?"RECEIPT_ACCOUNTED":"TRACKED",
      accounting:unavailableAccounting,openedAt:null,baselineProvenance:operational?"OPERATIONAL_OPEN_RECEIPT":null,
      fundingProvenance:operational?"OPERATIONAL_OPEN_SELECTION":null,openIntentId:row.open_intent_id?String(row.open_intent_id):null,
      lifecycle:truth.classification,terminalReason:truth.terminalReason,ownerResult:rec?.owner_result??null,
      liquidityRaw:rec?.liquidity_raw??null,tickLower:Number(row.tick_lower),tickUpper:Number(row.tick_upper),
      claimable0Raw:rec?.claimable0_raw??null,claimable1Raw:rec?.claimable1_raw??null,
      lastReconciledAt:rec?new Date(rec.checked_at_ms).toISOString():null,priceSource:null,priceBlock:null,
      priceObservedAt:null,reconciliation:operational?"BOT_OPERATIONAL_RECEIPT_LEDGER":"PENDING",
      excludedFromAggregateReason:null,
    });
  }
  const openLadders=repo.db.prepare("SELECT ladder_id FROM v4_bid_ladders WHERE strategy_version='V4_BID_LADDER_V1' AND execution_mode='LIVE' AND status='OPEN'").all() as Array<{ladder_id:string}>,ladderIds=new Set([...openLadders.map(row=>row.ladder_id),...persisted.flatMap(position=>position.protocol==='v4'&&position.openIntentId?[position.openIntentId]:[])]),snapshotAt=Number(snapshotRow?.refreshed_at_ms??-1);
  for(const ladderId of ladderIds){
    const parent=repo.loadBidLadder(ladderId);if(!parent||String(parent.strategy_version)!=='V4_BID_LADDER_V1'||String(parent.execution_mode)!=='LIVE')continue;
    const legs=repo.listBidLadderLegs(ladderId),tokenIds=legs.filter(leg=>leg.token_id).map(leg=>String(leg.token_id));
    if(String(parent.status)!=='OPEN'){
      for(const [positionId,position] of byId)if(position.openIntentId===ladderId)byId.set(positionId,{...position,status:String(parent.status).toLowerCase(),lifecycle:'TERMINAL',rangeStatus:'CLOSED'});
      continue;
    }
    if(legs.length!==5||tokenIds.length!==5||new Set(tokenIds).size!==5)continue;
    const truths=tokenIds.map(tokenId=>truthById.get(`v4:${tokenId}`));if(truths.some(item=>!item))continue;
    const exactTruth=truths as NonNullable<(typeof truths)[number]>[],reset=repo.loadBidLadderUsdReset(ladderId),registry=repo.v4RegistryPool(String(parent.pool_id)),poolFreshAtMs=registry?.last_refreshed_at?Date.parse(String(registry.last_refreshed_at)):0,allNftsFreshAtMs=Math.max(0,...exactTruth.map(item=>Number(item.reconciliation?.checked_at_ms??0))),positionEvidence=tokenIds.map(tokenId=>repo.v4Position(tokenId)),conflict=repo.db.prepare("SELECT 1 FROM chain_transaction_journal WHERE chain_id=4663 AND workflow_identity=? AND semantic_stage IN ('CLOSE_BATCH','OPEN_BATCH') AND status IN ('PREPARED','SUBMITTED') LIMIT 1").get(ladderId),actionable=String(reset?.phase)==='WATCHING'&&!conflict&&Boolean(registry?.refresh_block)&&poolFreshAtMs>0&&nowMs-poolFreshAtMs<=poolTtlMs&&legs.every(leg=>String(leg.status)==='OPEN')&&positionEvidence.every(row=>row&&String(row.pool_id).toLowerCase()===String(parent.pool_id).toLowerCase()&&String(row.open_intent_id)===ladderId)&&exactTruth.every(item=>item.reconciliation?.owner_status==='VERIFIED_OWNED'&&Boolean(item.reconciliation.confirmed_active)&&!item.reconciliation.terminal_reason&&item.reconciliation.fresh_until_ms>nowMs),snapshotExact=tokenIds.every(tokenId=>byId.get(`v4:${tokenId}`)?.openIntentId===ladderId),snapshotValued=snapshotExact&&tokenIds.every(tokenId=>{const accounting=byId.get(`v4:${tokenId}`)!.accounting;return typeof accounting.currentEquityUsd==='number'&&typeof accounting.uncollectedFeesUsd==='number';}),canonicalAt=Math.max(Number(parent.updated_at_ms??0),Number(reset?.updated_at_ms??0),poolFreshAtMs,allNftsFreshAtMs),needsOverlay=!snapshotExact||!snapshotValued||canonicalAt>snapshotAt;
    if(actionable){
      if(!needsOverlay)continue;
      const canonical=exactTruth.map(item=>buildPersistedV4PositionView(repo,item,nowMs) as PersistedPositionView|undefined);if(canonical.some(item=>!item))continue;const views=canonical as PersistedPositionView[];
      for(const view of views)byId.set(view.positionId,view);
      recordLiveOverlayActionability(repo,{ladderId,poolId:String(parent.pool_id),tokenIds,poolFreshAtMs,allNftsFreshAtMs});
      continue;
    }
    const views=tokenIds.map(tokenId=>byId.get(`v4:${tokenId}`)).filter((view):view is PersistedPositionView=>Boolean(view));if(views.length!==5)continue;
    for(const view of views){
      const accounting=canonicalPortfolioAccounting({externalCapitalUsd:view.accounting.externalCapitalUsd,activePrincipalUsd:null,uncollectedFeesUsd:null,collectedFeesUsd:view.accounting.collectedFeesUsd,realizedProceedsUsd:view.accounting.realizedProceedsUsd,gasSpentUsd:view.accounting.gasSpentUsd}),truth=truthById.get(view.positionId),lifecycle=truth?.classification==='OPEN_CONFIRMING'||truth?.classification==='PENDING_NEVER_VERIFIED'?'OPEN_CONFIRMING':'CONFIRMED_ACTIVE_REFRESHING';
      byId.set(view.positionId,{...view,lifecycle,accounting,currentPriceUsd:poolFreshAtMs&&nowMs-poolFreshAtMs<=poolTtlMs?view.currentPriceUsd:null,rangeStatus:'UNAVAILABLE'});
    }
  }
  return [...byId.values()];
}

export function bidLadderRepositionActionState(repo:SqliteLedgerRepository,ladderId:string){
  const parent=repo.loadBidLadder(ladderId),reset=repo.loadBidLadderUsdReset(ladderId);
  if(!parent||String(parent.execution_mode)!=="LIVE"||String(parent.status)!=="OPEN")return {executable:false,reason:"LADDER_NOT_OPEN"};
  if(String(reset?.phase)!=="WATCHING")return {executable:false,reason:`REPOSITION_${String(reset?.phase??"STATE_UNAVAILABLE")}`};
  const legs=repo.listBidLadderLegs(ladderId);
  if(!legs.length||legs.some(leg=>!leg.token_id||String(leg.status)!=="OPEN"))return {executable:false,reason:"CANONICAL_LEGS_NOT_OPEN"};
  const conflict=repo.db.prepare("SELECT 1 FROM chain_transaction_journal WHERE chain_id=4663 AND workflow_identity=? AND semantic_stage IN ('CLOSE_BATCH','OPEN_BATCH') AND status IN ('PREPARED','SUBMITTED') LIMIT 1").get(ladderId);
  if(conflict)return {executable:false,reason:"REPOSITION_TRANSACTION_IN_PROGRESS"};
  return {executable:true,reason:null};
}
export type BidLadderDisplayItem = {
  kind: "bid_ladder";
  ladderId: string;
  pair: string;
  status: string;
  mode: string;
  tokenIds: string[];
  upperDropBps: number;
  lowerDropBps: number;
  capitalRaw: bigint;
  fundingDecimals: number;
  fundingSymbol: string;
  equityUsd: number | null;
  unclaimedFeesUsd: number | null;
  inventoryPnlUsd: number | null;
  lifecycle:
    | "CONFIRMED_ACTIVE_FRESH"
    | "CONFIRMED_ACTIVE_REFRESHING"
    | "OPEN_CONFIRMING";
};
export type PersistedPositionDisplayItem =
  { kind: "position"; position: PersistedPositionView } | BidLadderDisplayItem;
const activeLifecycle = (value: PersistedPositionView["lifecycle"]) =>
  value === "CONFIRMED_ACTIVE_FRESH" ||
  value === "CONFIRMED_ACTIVE_REFRESHING" ||
  value === "OPEN_CONFIRMING";
const bps = (value: number) =>
  `${Math.floor(value / 100)}${value % 100 ? `.${String(value % 100).padStart(2, "0")}`.replace(/0+$/, "") : ""}%`;
const rawAmount = (value: bigint, decimals: number) => {
  const scale = 10n ** BigInt(decimals),
    whole = value / scale,
    fraction = String(value % scale)
      .padStart(decimals, "0")
      .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
};
function bidLadderDisplay(
  repo: SqliteLedgerRepository,
  ladderId: string,
  views: PersistedPositionView[],
): BidLadderDisplayItem | undefined {
  const parent = repo.loadBidLadder(ladderId);
  if (
    !parent ||
    String(parent.strategy_version) !== "V4_BID_LADDER_V1" ||
    String(parent.execution_mode) !== "LIVE" ||
    String(parent.status) !== "OPEN"
  )
    return;
  const legs = repo.listBidLadderLegs(ladderId);
  if (
    !legs.length ||
    legs.some((leg) => String(leg.status) !== "OPEN" || !leg.token_id)
  )
    return;
  const tokenIds = legs.map((leg) => String(leg.token_id));
  if (new Set(tokenIds).size !== tokenIds.length) return;
  const candidates = tokenIds.map((tokenId) =>
    views.filter((view) => view.tokenId === tokenId),
  );
  if (candidates.some((matches) => matches.length !== 1)) return;
  const positions = candidates.map((matches) => matches[0]!);
  if (
    positions.some(
      (view) =>
        view.protocol !== "v4" ||
        view.source !== "BOT_OPERATIONAL" ||
        view.openIntentId !== ladderId ||
        !activeLifecycle(view.lifecycle) ||
        view.status !== "open",
    )
  )
    return;
  const metadata = repo.v4Position(tokenIds[0]!);
  const fundingDecimals = Number(metadata?.funding_decimals),
    fundingSymbol = String(metadata?.funding_symbol ?? "");
  if (
    !metadata ||
    !Number.isInteger(fundingDecimals) ||
    fundingDecimals < 0 ||
    !fundingSymbol
  )
    return;
  const equity = positions.map((view) => view.accounting.currentEquityUsd),
    fees = positions.map((view) => view.accounting.uncollectedFeesUsd),
    inventoryPnl = positions.map((view) => canonicalInventoryPnlUsd(view.accounting));
  return {
    kind: "bid_ladder",
    ladderId,
    pair: positions[0]!.pair,
    status: String(parent.status),
    mode: String(parent.execution_mode),
    tokenIds,
    upperDropBps: Number(legs[0]!.upper_drop_bps),
    lowerDropBps: Number(legs.at(-1)!.lower_drop_bps),
    capitalRaw: BigInt(String(parent.total_funding_amount_raw)),
    fundingDecimals,
    fundingSymbol,
    equityUsd: equity.every((value): value is number => value !== null)
      ? equity.reduce((sum, value) => sum + value, 0)
      : null,
    unclaimedFeesUsd: fees.every((value): value is number => value !== null)
      ? fees.reduce((sum, value) => sum + value, 0)
      : null,
    inventoryPnlUsd: inventoryPnl.every((value): value is number => value !== null)
      ? inventoryPnl.reduce((sum, value) => sum + value, 0)
      : null,
    lifecycle: positions.some((view) => view.lifecycle === "OPEN_CONFIRMING")
      ? "OPEN_CONFIRMING"
      : positions.every((view) => view.lifecycle === "CONFIRMED_ACTIVE_FRESH")
        ? "CONFIRMED_ACTIVE_FRESH"
        : "CONFIRMED_ACTIVE_REFRESHING",
  };
}
/** Presentation-only grouping; canonical persisted views and snapshot counters remain untouched. */
export function persistedPositionDisplayItems(
  repo: SqliteLedgerRepository,
  views = persistedPositionViews(repo),
): PersistedPositionDisplayItem[] {
  const ladderIds = [
      ...new Set(
        views
          .filter(
            (view) =>
              view.protocol === "v4" &&
              view.source === "BOT_OPERATIONAL" &&
              typeof view.openIntentId === "string",
          )
          .map((view) => view.openIntentId!),
      ),
    ],
    groups = new Map(
      ladderIds
        .map((id) => [id, bidLadderDisplay(repo, id, views)])
        .filter((entry): entry is [string, BidLadderDisplayItem] =>
          Boolean(entry[1]),
        ),
    ),
    emitted = new Set<string>(),
    byToken = new Map<string, BidLadderDisplayItem>();
  for (const group of groups.values())
    for (const tokenId of group.tokenIds) byToken.set(tokenId, group);
  const items: PersistedPositionDisplayItem[] = [];
  for (const position of views) {
    const group = byToken.get(position.tokenId);
    if (group) {
      if (!emitted.has(group.ladderId)) {
        items.push(group);
        emitted.add(group.ladderId);
      }
      continue;
    }
    items.push({ kind: "position", position });
  }
  return items;
}
export const displayLifecycle = (item: PersistedPositionDisplayItem) =>
  item.kind === "bid_ladder" ? item.lifecycle : item.position.lifecycle;
export const displayEquity = (item: PersistedPositionDisplayItem) =>
  item.kind === "bid_ladder"
    ? item.equityUsd
    : item.position.accounting.currentEquityUsd;
export const displayUnclaimedFees = (item: PersistedPositionDisplayItem) =>
  item.kind === "bid_ladder"
    ? item.unclaimedFeesUsd
    : item.position.accounting.uncollectedFeesUsd;
/** Existing canonical inventory definition: current principal less immutable deployed basis.
 * Fees are deliberately excluded because they are reported on their own line. */
export const canonicalInventoryPnlUsd = (accounting: PortfolioAccounting) =>
  typeof accounting.activePrincipalUsd === "number" &&
  Number.isFinite(accounting.activePrincipalUsd) &&
  typeof accounting.externalCapitalUsd === "number" &&
  Number.isFinite(accounting.externalCapitalUsd)
    ? accounting.activePrincipalUsd - accounting.externalCapitalUsd
    : null;
const funiOpenItems = (items: readonly PersistedPositionDisplayItem[]) =>
  items.filter(
    (item) =>
      activeLifecycle(displayLifecycle(item)) &&
      (item.kind === "bid_ladder"
        ? item.status === "OPEN"
        : item.position.source === "BOT_OPERATIONAL" &&
          item.position.status.toLowerCase() === "open"),
  );
export function aggregateFuniOpenInventoryPnl(
  items: readonly PersistedPositionDisplayItem[],
) {
  const funiOpen = funiOpenItems(items);
  if (!funiOpen.length) return null;
  const values = funiOpen.map((item) =>
    item.kind === "bid_ladder"
      ? item.inventoryPnlUsd
      : canonicalInventoryPnlUsd(item.position.accounting),
  );
  return values.every((value): value is number => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}
const usdTextMicros = (value: unknown) => {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const negative = value.startsWith("-"),
    [whole, fraction = ""] = (negative ? value.slice(1) : value).split("."),
    micros = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return negative ? -micros : micros;
};
const microsToSafeUsd = (value: bigint) => {
  const micros = Number(value);
  return Number.isSafeInteger(micros) ? micros / 1_000_000 : null;
};
/** Bounded current-generation read model. CLAIM rows remain event-local and
 * are selected only by exact OPEN workflow identities from the composed view. */
export function aggregateFuniOpenLifecyclePnl(
  repo: SqliteLedgerRepository,
  items: readonly PersistedPositionDisplayItem[],
) {
  const funiOpen = funiOpenItems(items),
    inventoryPnlUsd = aggregateFuniOpenInventoryPnl(funiOpen),
    unclaimedValues = funiOpen.map(displayUnclaimedFees),
    unclaimedFeesUsd = funiOpen.length > 0 && unclaimedValues.every((value): value is number => value !== null)
      ? unclaimedValues.reduce((sum, value) => sum + value, 0)
      : null,
    workflowIds = [...new Set(funiOpen.flatMap((item) =>
      item.kind === "bid_ladder"
        ? [item.ladderId]
        : item.position.openIntentId
          ? [item.position.openIntentId]
          : [],
    ))],
    placeholders = workflowIds.map(() => "?").join(","),
    claimRows = workflowIds.length
      ? repo.db.prepare(`SELECT event_id,valuation_status,newly_realized_fees_usd FROM realized_pnl_events WHERE event_kind='CLAIM' AND (ladder_identity IN (${placeholders}) OR (ladder_identity IS NULL AND workflow_identity IN (${placeholders}))) ORDER BY event_id`).all(...workflowIds, ...workflowIds) as Array<Record<string, unknown>>
      : [],
    claimMicros = claimRows.map((row) =>
      String(row.valuation_status) === "AVAILABLE"
        ? usdTextMicros(row.newly_realized_fees_usd)
        : null,
    ),
    claimedFeesUsd = claimMicros.every((value): value is bigint => value !== null)
      ? microsToSafeUsd(claimMicros.reduce((sum, value) => sum + value, 0n))
      : null,
    openLifecyclePnlUsd = inventoryPnlUsd !== null && unclaimedFeesUsd !== null && claimedFeesUsd !== null
      ? inventoryPnlUsd + unclaimedFeesUsd + claimedFeesUsd
      : null;
  return { inventoryPnlUsd, unclaimedFeesUsd, claimedFeesUsd, openLifecyclePnlUsd, workflowIds };
}
export function persistedPositionDisplayCard(
  item: PersistedPositionDisplayItem,
) {
  if (item.kind === "position") return persistedPositionCard(item.position);
  const ids =
    item.tokenIds.length > 1 &&
    BigInt(item.tokenIds.at(-1)!) ===
      BigInt(item.tokenIds[0]!) + BigInt(item.tokenIds.length - 1)
      ? `${item.tokenIds[0]}–${item.tokenIds.at(-1)}`
      : item.tokenIds.join(", ");
  return [
    "🪜 V4 BID Ladder V1",
    item.pair,
    `Status: ${item.lifecycle === "OPEN_CONFIRMING" ? "OPEN / REFRESHING" : item.status}`,
    `Equity: ${item.lifecycle === "OPEN_CONFIRMING" ? "Refreshing..." : money(item.equityUsd)}`,
    `Unclaimed fees: ${item.lifecycle === "OPEN_CONFIRMING" ? "Refreshing..." : money(item.unclaimedFeesUsd)}`,
    `Capital: ${rawAmount(item.capitalRaw, item.fundingDecimals)} ${item.fundingSymbol}`,
    `Legs: ${item.tokenIds.length}`,
    `NFTs: ${ids}`,
    `Range: -${bps(item.upperDropBps)} → -${bps(item.lowerDropBps)}`,
    `Mode: ${item.mode}`,
    "Manual position management · Manual close",
  ].join("\n");
}
export function persistedPositionDisplaySummary(
  item: PersistedPositionDisplayItem,
) {
  return item.kind === "position"
    ? persistedPositionSummary(item.position)
    : `V4 BID Ladder V1 · ${item.pair} · ${money(item.equityUsd)} · ${item.tokenIds.length} legs`;
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
) {
  return [
    "Portfolio",
    ...(exposure
      ? [
          `FUNI-tracked equity: ${money(exposure.activeBotManagedEquityUsd)}`,
          `External equity (informational): ${money(exposure.externalEquityUsd)}`,
          `Total wallet LP equity: ${money(exposure.totalWalletEquityUsd)}`,
          "External positions are excluded from FUNI manual execution totals.",
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
