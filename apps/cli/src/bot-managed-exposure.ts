/** Canonical, read-only Robin-managed exposure accounting. */
import type { SqliteLedgerRepository } from '@robin/ledger';
import { PORTFOLIO_PRICE_TTL_MS } from './portfolio.js';
import { canonicalWorkflowCommitment, rebalanceCommitmentReleaseMarkerValid } from './rebalance-commitment-release.js';

export type BotManagedExposureBreakdown={
 activeBotManagedEquityUsd:number|null; pendingOpenCommitmentUsd:number; pendingReplacementCommitmentUsd:number;
 incrementalActionCapitalUsd:number; projectedExposureUsd:number|null; includedPositionIds:string[]; includedCommitmentIds:string[];
 externalEquityUsd:number|null; totalWalletEquityUsd:number|null; ambiguityReasons:string[]; releasedHistoricalCommitmentUsd:number; releasedWorkflowIds:string[];
};
export type BotManagedExposureResult={reason?:'BOT_MANAGED_EXPOSURE_DATA_STALE'|'BOT_MANAGED_EXPOSURE_SOURCE_AMBIGUOUS'|'BOT_MANAGED_EXPOSURE_VALUE_UNAVAILABLE'|'BOT_MANAGED_EXPOSURE_RELEASE_MARKER_INVALID';breakdown:BotManagedExposureBreakdown};
type SnapshotPosition={positionId?:unknown;status?:unknown;lifecycle?:unknown;liquidityRaw?:unknown;source?:unknown;accounting?:{currentEquityUsd?:unknown};excludedFromAggregateReason?:unknown;openIntentId?:unknown};
type Snapshot={positions?:unknown;totalEquityUsd?:unknown;lastReconciliationAt?:unknown};
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const terminalOpenStates=new Set(['POSITION_RECONCILED','FAILED_RETRYABLE']);
const terminalRebalanceStates=new Set(['COMPLETED','FAILED_TERMINAL','CANCELLED']);
const active=(position:SnapshotPosition)=>{try{return ['open','partially_closed'].includes(String(position.status))&&position.lifecycle==='CONFIRMED_ACTIVE_FRESH'&&position.excludedFromAggregateReason==null&&BigInt(String(position.liquidityRaw??'0'))>0n;}catch{return false;}};
const json=(value:unknown):Record<string,any>=>{try{return JSON.parse(String(value??'{}'));}catch{return {};}};
function empty(incrementalActionCapitalUsd:number):BotManagedExposureBreakdown{return {activeBotManagedEquityUsd:null,pendingOpenCommitmentUsd:0,pendingReplacementCommitmentUsd:0,incrementalActionCapitalUsd,projectedExposureUsd:null,includedPositionIds:[],includedCommitmentIds:[],externalEquityUsd:null,totalWalletEquityUsd:null,ambiguityReasons:[],releasedHistoricalCommitmentUsd:0,releasedWorkflowIds:[]};}
function openCommitmentUsd(row:Record<string,unknown>){const payload=json(row.payload_json),selection=payload.genericSelection??payload.selection??{},decimals=Number(selection.fundingDecimals??payload.fundingDecimals??(String(selection.funding??payload.funding??'').toLowerCase().includes('5fc5360d0400a0fd4f2af552add042d716f1d168')?6:NaN)),price=Number(payload.fundingUsd??payload.committedUsdPerFunding??(decimals===6?1:NaN)),amount=Number(row.amount_raw);const value=amount/10**decimals*price;return finite(value)&&value>0?value:null;}

/** Uses only the persisted snapshot plus durable open/rebalance intent rows. It never refreshes or writes state. */
export function botManagedProjectedExposure(repo:SqliteLedgerRepository,input:{incrementalActionCapitalUsd:number;proposedCommitmentId?:string;nowMs?:number;ttlMs?:number}):BotManagedExposureResult{
 const incremental=finite(input.incrementalActionCapitalUsd)?input.incrementalActionCapitalUsd:NaN,breakdown=empty(incremental);
 if(!finite(incremental))return {reason:'BOT_MANAGED_EXPOSURE_VALUE_UNAVAILABLE',breakdown};
 const row=repo.db.prepare("SELECT payload_json,refreshed_at_ms,last_reconciliation_at_ms FROM portfolio_persisted_snapshot WHERE snapshot_key='current'").get() as Record<string,unknown>|undefined;
 const now=input.nowMs??Date.now(),ttl=input.ttlMs??PORTFOLIO_PRICE_TTL_MS;
 if(!row||!Number.isFinite(Number(row.refreshed_at_ms))||now-Number(row.refreshed_at_ms)>ttl)return {reason:'BOT_MANAGED_EXPOSURE_DATA_STALE',breakdown};
 const snapshot=json(row.payload_json) as Snapshot;if(!Array.isArray(snapshot.positions))return {reason:'BOT_MANAGED_EXPOSURE_VALUE_UNAVAILABLE',breakdown};
 for(const position of snapshot.positions as SnapshotPosition[]){if(!['open','partially_closed'].includes(String(position.status))||position.excludedFromAggregateReason!=null)continue;try{if(BigInt(String(position.liquidityRaw??'0'))>0n&&position.lifecycle!=='CONFIRMED_ACTIVE_FRESH')return {reason:'BOT_MANAGED_EXPOSURE_DATA_STALE',breakdown};}catch{return {reason:'BOT_MANAGED_EXPOSURE_VALUE_UNAVAILABLE',breakdown};}}
 const activePositions=(snapshot.positions as SnapshotPosition[]).filter(active),ambiguous:string[]=[];let managed=0,external=0,externalKnown=true;
 for(const position of activePositions){const id=typeof position.positionId==='string'?position.positionId:'(unknown)';const source=String(position.source??'');const equity=position.accounting?.currentEquityUsd;
  if(source==='BOT_OPERATIONAL'){if(!finite(equity))return {reason:'BOT_MANAGED_EXPOSURE_VALUE_UNAVAILABLE',breakdown};managed+=equity;breakdown.includedPositionIds.push(id);}
  else if(source==='MANUAL_EXTERNAL'){if(finite(equity))external+=equity;else externalKnown=false;}
  else ambiguous.push(`ACTIVE_POSITION_SOURCE_AMBIGUOUS:${id}:${source||'UNKNOWN'}`);
 }
 breakdown.activeBotManagedEquityUsd=managed;breakdown.externalEquityUsd=externalKnown?external:null;breakdown.totalWalletEquityUsd=externalKnown?managed+external:null;breakdown.ambiguityReasons=ambiguous;
 if(ambiguous.length)return {reason:'BOT_MANAGED_EXPOSURE_SOURCE_AMBIGUOUS',breakdown};
 const represented=new Set(activePositions.filter(p=>p.source==='BOT_OPERATIONAL').map(p=>String(p.openIntentId??''))),included=new Set(breakdown.includedPositionIds);
 const opens=repo.db.prepare('SELECT * FROM v4_live_open_intents').all() as Record<string,unknown>[];
 for(const intent of opens){const id=String(intent.id),state=String(intent.state);if(terminalOpenStates.has(state)||represented.has(id)||id===input.proposedCommitmentId)continue;const value=openCommitmentUsd(intent);if(value===null)return {reason:'BOT_MANAGED_EXPOSURE_VALUE_UNAVAILABLE',breakdown};breakdown.pendingOpenCommitmentUsd+=value;breakdown.includedCommitmentIds.push(`open:${id}`);}
 const workflows=repo.db.prepare('SELECT * FROM rebalance_workflows').all() as Record<string,unknown>[];const seenLineages=new Set<string>();
 for(const workflow of workflows){const id=String(workflow.id),lineage=String(workflow.lineage_id),state=String(workflow.state);if(terminalRebalanceStates.has(state)||id===input.proposedCommitmentId||seenLineages.has(lineage))continue;seenLineages.add(lineage);const oldIncluded=included.has(String(workflow.old_position_id)),replacementIncluded=Boolean(workflow.replacement_position_id&&included.has(String(workflow.replacement_position_id))),value=canonicalWorkflowCommitment(workflow,oldIncluded,replacementIncluded);if(value===null)return {reason:'BOT_MANAGED_EXPOSURE_VALUE_UNAVAILABLE',breakdown};try{const marker=rebalanceCommitmentReleaseMarkerValid(repo,id);if(marker){breakdown.releasedHistoricalCommitmentUsd+=Number(marker.released_commitment_usd);breakdown.releasedWorkflowIds.push(id);continue;}}catch{return {reason:'BOT_MANAGED_EXPOSURE_RELEASE_MARKER_INVALID',breakdown};}if(value>0){breakdown.pendingReplacementCommitmentUsd+=value;breakdown.includedCommitmentIds.push(`rebalance:${id}`);}}
 breakdown.projectedExposureUsd=managed+breakdown.pendingOpenCommitmentUsd+breakdown.pendingReplacementCommitmentUsd+incremental;
 return {breakdown};
}

export function botManagedExposureGate(input:{result:BotManagedExposureResult;maxBotManagedExposureUsd?:number;live:boolean}){
 if(input.result.reason)return input.result.reason;
 if(!input.live)return undefined;
 if(!finite(input.maxBotManagedExposureUsd)||input.maxBotManagedExposureUsd<=0)return 'BOT_MANAGED_EXPOSURE_CAP_UNCONFIGURED' as const;
 if((input.result.breakdown.projectedExposureUsd??Infinity)>input.maxBotManagedExposureUsd)return 'BOT_MANAGED_EXPOSURE_CAP_EXCEEDED' as const;
 return undefined;
}
