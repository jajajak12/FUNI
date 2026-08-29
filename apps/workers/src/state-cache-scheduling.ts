import type Database from 'better-sqlite3';
import type { SqliteLedgerRepository } from '@funi/ledger';
export type StateCacheWorkerPhase=()=>Promise<boolean>;
export type PriorityWork={p0:boolean;p1:boolean};
export type StateCacheSchedulerState={priorityTurns:number;priorityCursor:0|1;lowerCursor:2|3};
export const MAX_PRIORITY_TURNS=4;
export const P1_STATE_REFRESH_REASONS=Object.freeze(['recent-token-lookup','recent-telegram-token','telegram-token','OPERATIONAL_OPEN_POOL_FRESHNESS','REPOSITION_ON_DEMAND_POOL_FRESHNESS'] as const);
export const URGENT_STATE_REFRESH_REASONS=Object.freeze(['OPERATIONAL_OPEN_POOL_FRESHNESS','REPOSITION_ON_DEMAND_POOL_FRESHNESS','ACTIVE_OPEN_POOL_REFRESH_DUE'] as const);
export const URGENT_TARGETED_POSITION_REASONS=Object.freeze(['OPERATIONAL_MINT_CONFIRMED','ECONOMIC_CLOSE_RECEIPT_CONFIRMED','OPERATOR_TARGETED_RECONCILIATION','OPERATOR_KNOWN_EXTERNAL_V4_IMPORT','FALSE_OWNERSHIP_LOSS_RECOVERY','ACTIVE_OPEN_POSITION_REFRESH_DUE'] as const);
const p1ReasonsSql=P1_STATE_REFRESH_REASONS.map(()=>'?').join(',');
const urgentStateReasonsSql=URGENT_STATE_REFRESH_REASONS.map(()=>'?').join(','),urgentTargetedReasonsSql=URGENT_TARGETED_POSITION_REASONS.map(()=>'?').join(',');

export function createStateCacheSchedulerState():StateCacheSchedulerState{return {priorityTurns:0,priorityCursor:0,lowerCursor:2};}

/** Existing durable queue rows are the wake signal; this does not lease or mutate them. */
export function runnablePriorityWork(db:Database.Database,now=Date.now()):PriorityWork{
 const targeted=Boolean(db.prepare("SELECT 1 FROM targeted_position_reconciliation_requests WHERE lane='background' AND available_at_ms<=? AND (leased_until_ms IS NULL OR leased_until_ms<?) LIMIT 1").get(now,now));
 const direct=Boolean(db.prepare(`SELECT 1 FROM v4_state_refresh_queue WHERE lane='background' AND priority>=90 AND reason IN (${p1ReasonsSql}) AND available_at_ms<=? AND (leased_until_ms IS NULL OR leased_until_ms<?) LIMIT 1`).get(...P1_STATE_REFRESH_REASONS,now,now));
 return {p0:targeted,p1:direct};
}

export function runnableUrgentWork(db:Database.Database,now=Date.now(),minimumPriority=0):PriorityWork{
 const targeted=Boolean(db.prepare("SELECT 1 FROM targeted_position_reconciliation_requests WHERE lane='urgent' AND priority>=? AND available_at_ms<=? AND (leased_until_ms IS NULL OR leased_until_ms<?) LIMIT 1").get(minimumPriority,now,now));
 const state=Boolean(db.prepare("SELECT 1 FROM v4_state_refresh_queue WHERE lane='urgent' AND priority>=? AND available_at_ms<=? AND (leased_until_ms IS NULL OR leased_until_ms<?) LIMIT 1").get(minimumPriority,now,now));
 return {p0:targeted,p1:state};
}

function leaseStateRefreshByLane(db:Database.Database,input:{limit:number;leaseMs:number;ownerId:string;now:number;urgent:boolean}){
 const lane=input.urgent?'urgent':'background';
 return db.transaction(():Record<string,unknown>[]=>{const rows=db.prepare('SELECT * FROM v4_state_refresh_queue WHERE lane=? AND available_at_ms<=? AND (leased_until_ms IS NULL OR leased_until_ms<?) ORDER BY priority DESC,requested_at_ms LIMIT ?').all(lane,input.now,input.now,Math.max(0,input.limit)) as Record<string,unknown>[],update=db.prepare('UPDATE v4_state_refresh_queue SET leased_until_ms=?,leased_at_ms=?,lease_owner=? WHERE pool_id=? AND lane=? AND (leased_until_ms IS NULL OR leased_until_ms<?)');return rows.filter(row=>update.run(input.now+input.leaseMs,input.now,input.ownerId,row.pool_id,lane,input.now).changes===1).map(row=>({...row,leased_at_ms:input.now,lease_owner:input.ownerId}) as Record<string,unknown>);})();
}
export function leaseUrgentStateRefresh(db:Database.Database,limit:number,leaseMs:number,ownerId:string,now=Date.now()){return leaseStateRefreshByLane(db,{limit,leaseMs,ownerId,now,urgent:true});}
export function leaseBackgroundStateRefresh(db:Database.Database,limit:number,leaseMs:number,ownerId:string,now=Date.now()){return leaseStateRefreshByLane(db,{limit,leaseMs,ownerId,now,urgent:false});}

export function acquireStatePersistenceLease(db:Database.Database,ownerId:string,leaseMs:number,now=Date.now()){
 return db.transaction(()=>{const row=db.prepare("SELECT owner_id,leased_until_ms FROM state_cache_persistence_lease WHERE lease_key='canonical-state-persistence'").get() as {owner_id:string;leased_until_ms:number}|undefined;if(row&&row.leased_until_ms>now&&row.owner_id!==ownerId)return false;db.prepare("INSERT INTO state_cache_persistence_lease(lease_key,owner_id,leased_until_ms,updated_at_ms) VALUES('canonical-state-persistence',?,?,?) ON CONFLICT(lease_key) DO UPDATE SET owner_id=excluded.owner_id,leased_until_ms=excluded.leased_until_ms,updated_at_ms=excluded.updated_at_ms").run(ownerId,now+leaseMs,now);return true;})();
}
export function releaseStatePersistenceLease(db:Database.Database,ownerId:string,now=Date.now()){return db.prepare("UPDATE state_cache_persistence_lease SET leased_until_ms=?,updated_at_ms=? WHERE lease_key='canonical-state-persistence' AND owner_id=?").run(now,now,ownerId).changes===1;}

/** Exact OPEN actionability contract. This is intentionally independent of the
 * presentation snapshot and accepts only fresh StateView plus five fresh,
 * verified-owned active NFT rows bound to the ladder's exact pool identity. */
export function fullyActionableV4BidLadder(db:Database.Database,ladderId:string,nowMs:number,poolTtlMs:number){
 const row=db.prepare(`SELECT l.pool_id,r.refresh_block,r.last_refreshed_at,
  COUNT(x.leg_index) leg_count,
  SUM(CASE WHEN x.status='OPEN' AND x.token_id IS NOT NULL
    AND lower(p.pool_id)=lower(l.pool_id)
    AND p.open_intent_id=l.ladder_id
    AND a.owner_status='VERIFIED_OWNED' AND a.confirmed_active=1
    AND a.terminal_reason IS NULL AND a.fresh_until_ms>? THEN 1 ELSE 0 END) verified_count
  FROM v4_bid_ladders l
  LEFT JOIN v4_pool_registry r ON lower(r.pool_id)=lower(l.pool_id)
  LEFT JOIN v4_bid_ladder_legs x ON x.ladder_id=l.ladder_id
  LEFT JOIN v4_positions p ON p.token_id=x.token_id
  LEFT JOIN active_position_reconciliations a ON a.position_id='v4:'||x.token_id
  WHERE l.ladder_id=? AND l.status='OPEN' GROUP BY l.ladder_id`).get(nowMs,ladderId) as {refresh_block:string|null;last_refreshed_at:string|null;leg_count:number;verified_count:number}|undefined;
 const observedAt=row?.last_refreshed_at?Date.parse(row.last_refreshed_at):0;
 return Boolean(row?.refresh_block&&observedAt&&nowMs-observedAt<=poolTtlMs&&row.leg_count===5&&row.verified_count===5);
}

/** The urgent verifier owns OPEN_PENDING convergence. The transition is attempted
 * only after the exact fully-actionable evidence contract is satisfied. */
export function convergeOpenPendingV4BidLadder(repo:SqliteLedgerRepository,ladderId:string,nowMs:number,poolTtlMs:number){
 const reset=repo.loadBidLadderUsdReset(ladderId);
 if(String(reset?.phase)!=='OPEN_PENDING'||!fullyActionableV4BidLadder(repo.db,ladderId,nowMs,poolTtlMs))return false;
 repo.transitionBidLadderUsdReset({ladderId,from:'OPEN_PENDING',to:'WATCHING',nowMs});
 return true;
}

/** Leases only targeted direct-lookup refreshes; active-position priority remains in canonical ordering. */
export function leasePriorityDirectLookupRefresh(db:Database.Database,limit:number,leaseMs:number,now=Date.now()){
 const ownerId=`legacy-priority-state:${now}`,run=db.transaction(():Record<string,unknown>[]=>{const rows=db.prepare(`SELECT * FROM v4_state_refresh_queue WHERE lane='background' AND priority>=90 AND reason IN (${p1ReasonsSql}) AND available_at_ms<=? AND (leased_until_ms IS NULL OR leased_until_ms<?) ORDER BY priority DESC,requested_at_ms LIMIT ?`).all(...P1_STATE_REFRESH_REASONS,now,now,Math.max(0,limit)) as Record<string,unknown>[],update=db.prepare("UPDATE v4_state_refresh_queue SET leased_until_ms=?,leased_at_ms=?,lease_owner=? WHERE pool_id=? AND lane='background' AND (leased_until_ms IS NULL OR leased_until_ms<?)");return rows.filter(row=>update.run(now+leaseMs,now,ownerId,row.pool_id,now).changes===1).map(row=>({...row,leased_at_ms:now,lease_owner:ownerId}) as Record<string,unknown>);});
 return run();
}

/** Runs one safe, bounded RPC-bearing unit and then returns control to the outer loop. */
export async function runStateCacheWorkerCycle(input:{
 state:StateCacheSchedulerState;
 priorityWork:()=>PriorityWork|Promise<PriorityWork>;
 targetedReconciliation:StateCacheWorkerPhase;
 priorityStateCache:StateCacheWorkerPhase;
 activeReconciliation:StateCacheWorkerPhase;
 backgroundStateCache:StateCacheWorkerPhase;
 adoption:(rpcTaskRan:boolean)=>Promise<void>;
}){
 const work=await input.priorityWork(),priorityRunnable=work.p0||work.p1,forceLower=priorityRunnable&&input.state.priorityTurns>=MAX_PRIORITY_TURNS;
 let rpcTaskRan=false,selected:'p0'|'p1'|'p2'|'p3'|'none'='none';
 if(priorityRunnable&&!forceLower){
  const order=input.state.priorityCursor===0?(['p0','p1'] as const):(['p1','p0'] as const);
  for(const priority of order){if((priority==='p0'?work.p0:work.p1)&&(await (priority==='p0'?input.targetedReconciliation:input.priorityStateCache)())){rpcTaskRan=true;selected=priority;input.state.priorityCursor=priority==='p0'?1:0;input.state.priorityTurns++;break;}}
 }
 if(!rpcTaskRan&&(!priorityRunnable||forceLower)){
  const order=input.state.lowerCursor===2?(['p2','p3'] as const):(['p3','p2'] as const);
  for(const priority of order){if(await (priority==='p2'?input.activeReconciliation:input.backgroundStateCache)()){rpcTaskRan=true;selected=priority;input.state.lowerCursor=priority==='p2'?3:2;break;}}
  input.state.priorityTurns=0;
 }
 if(!rpcTaskRan&&priorityRunnable){
  if(work.p0&&await input.targetedReconciliation()){rpcTaskRan=true;selected='p0';input.state.priorityCursor=1;input.state.priorityTurns++;}
  else if(work.p1&&await input.priorityStateCache()){rpcTaskRan=true;selected='p1';input.state.priorityCursor=0;input.state.priorityTurns++;}
 }
 await input.adoption(rpcTaskRan);
 return {rpcTaskRan,selected,priorityRunnable};
}
