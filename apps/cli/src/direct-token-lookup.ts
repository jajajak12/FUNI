import { randomUUID } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import type { FallbackRpc } from '@funi/core';
import { robinhoodMainnet } from '@funi/core';
import type { SqliteLedgerRepository } from '@funi/ledger';
import { classifyV4Hooks, decodeV4Fee, poolId, V4_MAX_EXECUTION_STATIC_FEE_PIPS } from '@funi/v4';
import { attributedRpc, type RpcAttribution } from './rpc-attribution.js';
import { cachedV4PoolsForToken, refreshV4RegistryPoolBatch } from './v4-registry.js';

export const DIRECT_LOOKUP_VERSION=1;
export const DIRECT_LOOKUP_TERMINAL_STATUSES=[
 'SUPPORTED_POOLS_FOUND',
 'NO_ACTIVE_LIQUIDITY_POOL',
 'PROVIDER_TEMPORARILY_UNAVAILABLE',
 'LOOKUP_TIMED_OUT',
 'REQUEST_EXPIRED',
] as const;
export type DirectLookupTerminalStatus=typeof DIRECT_LOOKUP_TERMINAL_STATUSES[number];
export type DirectLookupStatus='QUEUED'|'RUNNING'|DirectLookupTerminalStatus;
export type DirectLookupRequest=Record<string,unknown>&{
 id:string;chain_id:number;token_address:string;lookup_version:number;dedup_key:string;revision:number;
 status:DirectLookupStatus;created_at_ms:number;deadline_at_ms:number;result_expires_at_ms:number;attempts:number;
};
const terminal=(status:unknown):status is DirectLookupTerminalStatus=>
 DIRECT_LOOKUP_TERMINAL_STATUSES.includes(status as DirectLookupTerminalStatus);
const json=(value:unknown)=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?item.toString():item);
const parseIds=(value:unknown):string[]=>{try{const parsed=JSON.parse(String(value??'[]'));return Array.isArray(parsed)?parsed.map(String):[];}catch{return [];}};
const dedupKey=(chainId:number,token:Address,version:number)=>`${chainId}:${token.toLowerCase()}:${version}`;

export function createOrReuseDirectLookup(input:{
 repo:SqliteLedgerRepository;chainId?:number;token:Address;interactionId?:string;nowMs?:number;deadlineMs?:number;resultTtlMs?:number;explicitRetry?:boolean;refreshStaleEvidence?:boolean;naturalTimeline?:{pasteReceivedAtMs:number;firstUiResponseAtMs:number};
}){
 const chainId=input.chainId??4663,token=getAddress(input.token),version=DIRECT_LOOKUP_VERSION,requestedAt=input.nowMs??Date.now(),deadlineMs=input.deadlineMs??15_000,resultTtlMs=input.resultTtlMs??300_000,key=dedupKey(chainId,token,version);
 const run=input.repo.db.transaction(()=>{
  const latest=input.repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE dedup_key=? ORDER BY revision DESC LIMIT 1').get(key) as DirectLookupRequest|undefined;
  if(latest&&input.refreshStaleEvidence){
   if((latest.status==='QUEUED'||latest.status==='RUNNING')&&latest.deadline_at_ms>requestedAt)return {request:latest,deduplicated:true,cacheHit:false,created:false};
   if(!terminal(latest.status)||latest.result_expires_at_ms<=requestedAt){}else{
    // A fresh-evidence refresh deliberately bypasses a completed negative result.
   }
  }else if(latest&&!input.explicitRetry){
   if((latest.status==='QUEUED'||latest.status==='RUNNING')&&latest.deadline_at_ms>requestedAt)return {request:latest,deduplicated:true,cacheHit:false,created:false};
   if(terminal(latest.status)&&latest.result_expires_at_ms>requestedAt)return {request:latest,deduplicated:true,cacheHit:true,created:false};
  }
  const revision=(latest?.revision??0)+1,id=randomUUID();
  input.repo.db.prepare(`INSERT INTO direct_token_lookup_requests
   (id,chain_id,token_address,lookup_version,dedup_key,revision,interaction_id,status,created_at_ms,updated_at_ms,deadline_at_ms,result_expires_at_ms)
   VALUES(?,?,?,?,?,?,?,'QUEUED',?,?,?,?)`).run(id,chainId,token,version,key,revision,input.interactionId??null,requestedAt,requestedAt,requestedAt+deadlineMs,requestedAt+resultTtlMs);
  // SQLite may wait for a contended writer inside INSERT. Runtime deadlines begin
  // only after the durable request actually exists; deterministic tests retain nowMs.
  const persistedAt=input.nowMs??Date.now();
  input.repo.db.prepare('UPDATE direct_token_lookup_requests SET created_at_ms=?,updated_at_ms=?,deadline_at_ms=?,result_expires_at_ms=?,rpc_attribution_json=? WHERE id=? AND revision=?').run(persistedAt,persistedAt,persistedAt+deadlineMs,persistedAt+resultTtlMs,json({...input.naturalTimeline,requestPersistedAtMs:persistedAt}),id,revision);
  return {request:input.repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=?').get(id) as DirectLookupRequest,deduplicated:false,cacheHit:false,created:true};
 });
 // Candidate discovery belongs exclusively to the worker. Publishing the request
 // first and then building candidate rows here allowed the worker to lease a
 // partially-created revision while Telegram held the candidate write lock.
 return run();
}

function outboxPayload(request:DirectLookupRequest){
 return {
  interactionId:request.interaction_id??null,requestId:request.id,requestRevision:request.revision,token:request.token_address,terminalStatus:request.status,
  candidatePoolCount:Number(request.candidate_pool_count??0),hydratedPoolCount:Number(request.hydrated_pool_count??0),
  eligiblePoolIds:parseIds(request.eligible_pool_ids_json),eligiblePoolCount:Number(request.eligible_pool_count??0),
  reasonCode:request.reason_code??null,completedAt:request.completed_at_ms?new Date(Number(request.completed_at_ms)).toISOString():null,
  rpcAttribution:JSON.parse(String(request.rpc_attribution_json??'{}')),
 };
}
function insertOutbox(repo:SqliteLedgerRepository,request:DirectLookupRequest,subscriberId:string,now:number){
 if(!terminal(request.status))return;
 repo.db.prepare(`INSERT OR IGNORE INTO direct_token_lookup_outbox
  (id,request_id,request_revision,subscriber_id,status,payload_json,available_at_ms,created_at_ms)
  VALUES(?,?,?,?,'PENDING',?,?,?)`).run(randomUUID(),request.id,request.revision,subscriberId,json(outboxPayload(request)),now,now);
}
export function attachDirectLookupSubscriber(input:{
 repo:SqliteLedgerRepository;requestId:string;requestRevision:number;interactionId:string;userId:string;chatId:string;messageId:number;sessionId:string;nowMs?:number;
}){
 const now=input.nowMs??Date.now(),id=randomUUID(),run=input.repo.db.transaction(()=>{
  const request=input.repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=? AND revision=?').get(input.requestId,input.requestRevision) as DirectLookupRequest|undefined;
  if(!request)throw new Error('DIRECT_LOOKUP_REQUEST_REVISION_NOT_FOUND');
  input.repo.db.prepare(`INSERT OR IGNORE INTO direct_token_lookup_subscribers
   (id,request_id,request_revision,interaction_id,user_id,chat_id,message_id,session_id,attached_at_ms)
   VALUES(?,?,?,?,?,?,?,?,?)`).run(id,input.requestId,input.requestRevision,input.interactionId,input.userId,input.chatId,input.messageId,input.sessionId,now);
  const subscriber=input.repo.db.prepare('SELECT * FROM direct_token_lookup_subscribers WHERE request_id=? AND request_revision=? AND chat_id=? AND message_id=?').get(input.requestId,input.requestRevision,input.chatId,input.messageId) as Record<string,unknown>;
  insertOutbox(input.repo,request,String(subscriber.id),now);
  return subscriber;
 });
 return run();
}

export function leaseDirectTokenLookup(repo:SqliteLedgerRepository,leaseMs:number,now=Date.now(),onExpired?:(request:DirectLookupRequest)=>void):DirectLookupRequest|undefined{
 const run=repo.db.transaction(()=>{
  expireDueDirectTokenLookups(repo,now,10,onExpired);
  const row=repo.db.prepare("SELECT * FROM direct_token_lookup_requests WHERE status IN ('QUEUED','RUNNING') AND deadline_at_ms>? AND (leased_until_ms IS NULL OR leased_until_ms<?) ORDER BY created_at_ms LIMIT 1").get(now,now) as DirectLookupRequest|undefined;
  if(!row)return undefined;
  const changed=repo.db.prepare("UPDATE direct_token_lookup_requests SET status='RUNNING',leased_until_ms=?,attempts=attempts+1,updated_at_ms=? WHERE id=? AND revision=? AND status IN ('QUEUED','RUNNING') AND (leased_until_ms IS NULL OR leased_until_ms<?)").run(now+leaseMs,now,row.id,row.revision,now).changes;
  return changed?repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=?').get(row.id) as DirectLookupRequest:undefined;
 });
 return run();
}
export function releaseDirectTokenLookupLease(repo:SqliteLedgerRepository,request:Pick<DirectLookupRequest,'id'|'revision'>,now=Date.now()){
 return repo.db.prepare("UPDATE direct_token_lookup_requests SET status='QUEUED',leased_until_ms=NULL,updated_at_ms=? WHERE id=? AND revision=? AND status='RUNNING'").run(now,request.id,request.revision).changes===1;
}
export function expireDueDirectTokenLookups(repo:SqliteLedgerRepository,now=Date.now(),limit=10,onExpired?:(request:DirectLookupRequest)=>void){
 const expired=repo.db.prepare("SELECT * FROM direct_token_lookup_requests WHERE status IN ('QUEUED','RUNNING') AND deadline_at_ms<=? ORDER BY created_at_ms LIMIT ?").all(now,limit) as DirectLookupRequest[];let completed=0;
 for(const request of expired){
  finalizeUnresolvedDirectLookupCandidates(repo,request,now);
  const rows=directLookupCandidateLifecycle(repo,request.id,request.revision),evidence=directLookupEvidenceForRequest(repo,request,now),eligiblePoolIds=canonicalDirectLookupEligiblePoolIds(repo,request,now),unleased=Number(request.attempts)===0;
  if(completeDirectTokenLookup(repo,{requestId:request.id,requestRevision:request.revision,status:eligiblePoolIds.length?'SUPPORTED_POOLS_FOUND':'LOOKUP_TIMED_OUT',reasonCode:eligiblePoolIds.length?'FRESH_ELIGIBLE_CANDIDATE_EVIDENCE':unleased?'DIRECT_LOOKUP_WORKER_NOT_LEASED':'DIRECT_LOOKUP_DEADLINE_EXCEEDED',candidatePoolCount:rows.length||evidence.structuralCandidateCount+evidence.unsupportedCandidateCount,hydratedPoolCount:evidence.freshClassifiedCandidateCount,eligiblePoolIds,providerResult:eligiblePoolIds.length?'candidate_evidence_available':unleased?'worker_stalled':'deadline',rpcAttribution:{rpcCallCount:0,ethCallCount:0,eth_blockNumberCount:0,multicallCount:0,multicallMembers:0,requestLeased:!unleased,terminalCandidateCount:rows.length,...evidence},nowMs:now}).completed){completed++;onExpired?.(request);}
 }
 return completed;
}

const DIRECT_LOOKUP_FAST_SLOTS=6,DIRECT_LOOKUP_FRESH_MS=120_000,DIRECT_LOOKUP_FAIRNESS_MIN_REMAINING_MS=6_000;
type DirectLookupCandidateRow={pool_id:string;currency0:string;currency1:string;initialize_fee_raw:number;tick_spacing:number;hooks:string;active_liquidity_raw:string|null;validation_status:string;initialized:number;last_refreshed_at:string|null};
export type DirectLookupCandidateState='DISCOVERED'|'REFRESH_REQUESTED'|'LEASED'|'ELIGIBLE'|'NO_ACTIVE_LIQUIDITY'|'UNSUPPORTED'|'EVIDENCE_UNAVAILABLE';
type DirectLookupCandidateLifecycleRow={request_id:string;request_revision:number;pool_id:string;state:DirectLookupCandidateState;reason_code:string|null;attempt_count:number;requested_at_ms:number|null;leased_at_ms:number|null;completed_at_ms:number|null;evidence_at_ms:number|null;refresh_block:string|null;last_error:string|null};
const directLookupCursorKind=(token:Address)=>`direct_lookup_fairness:${token.toLowerCase()}`;
const rowRefreshMs=(row:DirectLookupCandidateRow)=>row.last_refreshed_at?Date.parse(row.last_refreshed_at)||0:0;
const rowLiquidity=(row:DirectLookupCandidateRow)=>{try{return BigInt(row.active_liquidity_raw??'0');}catch{return 0n;}};
function directLookupStructuralCandidates(repo:SqliteLedgerRepository,token:Address){
 const funding=[robinhoodMainnet.assets.USDG.toLowerCase(),robinhoodMainnet.assets.WETH.toLowerCase()];
 const rows=repo.db.prepare(`SELECT pool_id,currency0,currency1,initialize_fee_raw,tick_spacing,hooks,active_liquidity_raw,validation_status,initialized,last_refreshed_at FROM v4_pool_registry
  WHERE ((lower(currency0)=lower(?) AND lower(currency1) IN (?,?)) OR (lower(currency1)=lower(?) AND lower(currency0) IN (?,?)))`).all(token,funding[0],funding[1],token,funding[0],funding[1]) as DirectLookupCandidateRow[],plausible=new Set(directLookupRpcCandidatePoolIds(repo,rows.map(row=>row.pool_id),token).rpcIds.map(id=>id.toLowerCase()));
 return rows.filter(row=>plausible.has(row.pool_id.toLowerCase()));
}
export function directLookupFairnessCursor(repo:SqliteLedgerRepository,token:Address){
 const row=repo.chainRegistryCursor(4663,'uniswap_v4',directLookupCursorKind(token));
 let state:Record<string,unknown>={};try{state=JSON.parse(String(row?.state_json??'{}')) as Record<string,unknown>;}catch{}
 const nextOffset=Number(row?.next_block??0);
 return {nextOffset:Number.isSafeInteger(nextOffset)&&nextOffset>=0?nextOffset:0,candidateCount:Number(state.candidateCount??0),lastPoolId:typeof state.lastPoolId==='string'?state.lastPoolId:null};
}
function rankedFastCandidates(rows:DirectLookupCandidateRow[],token:Address,now:number){
 const target=token.toLowerCase(),usd=robinhoodMainnet.assets.USDG.toLowerCase(),fresh=(row:DirectLookupCandidateRow)=>row.last_refreshed_at!==null&&rowRefreshMs(row)>=now-DIRECT_LOOKUP_FRESH_MS,active=(row:DirectLookupCandidateRow)=>rowLiquidity(row)>0n,lastKnownEligible=(row:DirectLookupCandidateRow)=>row.validation_status==='ELIGIBLE'&&Number(row.initialized)===1,quoteIsUsd=(row:DirectLookupCandidateRow)=>(row.currency0.toLowerCase()===target?row.currency1:row.currency0).toLowerCase()===usd;
 return rows.filter(row=>!fresh(row)&&(active(row)||lastKnownEligible(row))).sort((a,b)=>Number(active(b))-Number(active(a))||Number(lastKnownEligible(b))-Number(lastKnownEligible(a))||Number(quoteIsUsd(b))-Number(quoteIsUsd(a))||(rowLiquidity(b)>rowLiquidity(a)?1:rowLiquidity(b)<rowLiquidity(a)?-1:0)||rowRefreshMs(a)-rowRefreshMs(b)||a.pool_id.localeCompare(b.pool_id));
}
function fairnessCandidates(rows:DirectLookupCandidateRow[],now:number){return rows.filter(row=>Number(row.initialized)!==1||row.last_refreshed_at===null||rowRefreshMs(row)<now-DIRECT_LOOKUP_FRESH_MS).sort((a,b)=>rowRefreshMs(a)-rowRefreshMs(b)||a.pool_id.localeCompare(b.pool_id));}
export function allocateDirectLookupCandidates(repo:SqliteLedgerRepository,token:Address,limit:number,now=Date.now(),advance=true){
 const budget=Math.max(1,Math.min(12,limit)),rows=directLookupStructuralCandidates(repo,token),fastRanked=rankedFastCandidates(rows,token,now),fastInitial=fastRanked.slice(0,Math.min(DIRECT_LOOKUP_FAST_SLOTS,budget)),selected=new Set(fastInitial.map(row=>row.pool_id.toLowerCase())),fairnessRows=fairnessCandidates(rows,now),cursor=directLookupFairnessCursor(repo,token),cursorStart=fairnessRows.length?cursor.nextOffset%fairnessRows.length:0,start=fairnessRows.length&&rowRefreshMs(fairnessRows[cursorStart]!)>rowRefreshMs(fairnessRows[0]!)?0:cursorStart,fairnessTarget=budget-fastInitial.length,fairness:DirectLookupCandidateRow[]=[];
 let traversed=0,overlap=0,lastPoolId:string|null=null;const fairnessCursorOffsets:number[]=[];
 for(;traversed<fairnessRows.length&&fairness.length<fairnessTarget;traversed++){
  const row=fairnessRows[(start+traversed)%fairnessRows.length]!;lastPoolId=row.pool_id;
  if(selected.has(row.pool_id.toLowerCase())){overlap++;continue;}
  selected.add(row.pool_id.toLowerCase());fairness.push(row);fairnessCursorOffsets.push((start+traversed+1)%fairnessRows.length);
 }
 const fastBackfill=fastRanked.filter(row=>!selected.has(row.pool_id.toLowerCase())).slice(0,budget-selected.size);for(const row of fastBackfill)selected.add(row.pool_id.toLowerCase());
 const nextOffset=fairnessRows.length?(start+traversed)%fairnessRows.length:0;
 if(advance)repo.upsertChainRegistryCursor({chainId:4663,protocol:'uniswap_v4',cursorKind:directLookupCursorKind(token),nextBlock:BigInt(nextOffset),finalityConfirmations:0,state:{candidateCount:fairnessRows.length,lastPoolId,updatedAtMs:now}});
 return {candidateIds:[...fastInitial,...fairness,...fastBackfill].map(row=>row.pool_id),fastIds:[...fastInitial,...fastBackfill].map(row=>row.pool_id),fairnessIds:fairness.map(row=>row.pool_id),fastFairnessOverlap:overlap,fairnessCursorBefore:cursor.nextOffset,fairnessCursorAfter:nextOffset,fairnessCursorOffsets,fairnessCandidateCount:fairnessRows.length,fairnessLastPoolId:lastPoolId,structuralCandidateCount:rows.length};
}
export function directLookupCandidatePoolIds(repo:SqliteLedgerRepository,token:Address,limit:number){return allocateDirectLookupCandidates(repo,token,limit,Date.now(),false).candidateIds;}
export function commitDirectLookupFairness(repo:SqliteLedgerRepository,token:Address,allocation:ReturnType<typeof allocateDirectLookupCandidates>,now=Date.now(),completedCount=allocation.fairnessIds.length){
 const count=Math.min(Math.max(0,completedCount),allocation.fairnessIds.length);if(!count)return false;
 repo.upsertChainRegistryCursor({chainId:4663,protocol:'uniswap_v4',cursorKind:directLookupCursorKind(token),nextBlock:BigInt(allocation.fairnessCursorOffsets[count-1]!),finalityConfirmations:0,state:{candidateCount:allocation.fairnessCandidateCount,lastPoolId:allocation.fairnessIds[count-1]!,updatedAtMs:now}});return true;
}
export function directLookupRawCandidatePoolCount(repo:SqliteLedgerRepository,token:Address){const funding=[robinhoodMainnet.assets.USDG.toLowerCase(),robinhoodMainnet.assets.WETH.toLowerCase()];return Number((repo.db.prepare(`SELECT COUNT(*) count FROM v4_pool_registry WHERE ((lower(currency0)=lower(?) AND lower(currency1) IN (?,?)) OR (lower(currency1)=lower(?) AND lower(currency0) IN (?,?)))`).get(token,funding[0],funding[1],token,funding[0],funding[1]) as {count:number}).count);}

function directLookupAllCandidateIds(repo:SqliteLedgerRepository,token:Address){const funding=[robinhoodMainnet.assets.USDG.toLowerCase(),robinhoodMainnet.assets.WETH.toLowerCase()];return (repo.db.prepare(`SELECT pool_id FROM v4_pool_registry WHERE ((lower(currency0)=lower(?) AND lower(currency1) IN (?,?)) OR (lower(currency1)=lower(?) AND lower(currency0) IN (?,?))) ORDER BY lower(pool_id)`).all(token,funding[0],funding[1],token,funding[0],funding[1]) as Array<{pool_id:string}>).map(row=>row.pool_id);}

function initializeDirectLookupCandidates(repo:SqliteLedgerRepository,request:DirectLookupRequest,token:Address,allIds:string[],selectedIds:string[],now:number){
 if(Number((repo.db.prepare('SELECT COUNT(*) count FROM direct_token_lookup_candidates WHERE request_id=? AND request_revision=?').get(request.id,request.revision) as {count:number}).count)>0)return;
 const selected=new Set(selectedIds.map(id=>id.toLowerCase())),work=directLookupRpcCandidatePoolIds(repo,allIds,token),unsupported=new Map(work.blocked.map(item=>[item.id.toLowerCase(),item.blockers[0]??'STRUCTURALLY_UNSUPPORTED'])),cached=new Map(cachedV4PoolsForToken({repo,token,now}).candidates.map(item=>[item.poolId.toLowerCase(),item])),priorRows=repo.db.prepare(`SELECT c.* FROM direct_token_lookup_candidates c JOIN direct_token_lookup_requests r ON r.id=c.request_id AND r.revision=c.request_revision WHERE r.dedup_key=? AND r.revision<? AND c.state='ELIGIBLE' AND c.evidence_at_ms>=? ORDER BY r.revision DESC`).all(request.dedup_key,request.revision,now-DIRECT_LOOKUP_FRESH_MS) as DirectLookupCandidateLifecycleRow[],priorEligible=new Map<string,DirectLookupCandidateLifecycleRow>();
 for(const row of priorRows)if(!priorEligible.has(row.pool_id.toLowerCase()))priorEligible.set(row.pool_id.toLowerCase(),row);
 const insert=repo.db.prepare(`INSERT OR REPLACE INTO direct_token_lookup_candidates(request_id,request_revision,pool_id,state,reason_code,attempt_count,requested_at_ms,completed_at_ms,evidence_at_ms,refresh_block,last_error) VALUES(?,?,?,?,?,0,?,?,?,?,NULL)`),run=repo.db.transaction(()=>{for(const id of allIds){const candidate=cached.get(id.toLowerCase()),registry=repo.v4RegistryPool(id),prior=priorEligible.get(id.toLowerCase()),registryRefreshMs=registry?.last_refreshed_at?Date.parse(String(registry.last_refreshed_at))||0:0,blocker=unsupported.get(id.toLowerCase()),chosen=selected.has(id.toLowerCase()),freshRegistryEligible=Boolean(candidate?.executionEligible),freshEligible=freshRegistryEligible||Boolean(prior),freshZero=candidate?.uiState==='SUPPORTED_NO_ACTIVE_LIQUIDITY',freshNotInitialized=Boolean(registryRefreshMs&&Math.max(0,now-registryRefreshMs)<=DIRECT_LOOKUP_FRESH_MS&&Number(registry?.initialized)!==1),state:DirectLookupCandidateState=blocker?'UNSUPPORTED':freshEligible?'ELIGIBLE':freshZero?'NO_ACTIVE_LIQUIDITY':freshNotInitialized?'EVIDENCE_UNAVAILABLE':chosen?'REFRESH_REQUESTED':'EVIDENCE_UNAVAILABLE',reason=blocker??(freshEligible?'FRESH_POSITIVE_ACTIVE_LIQUIDITY':freshZero?'FRESH_ZERO_ACTIVE_LIQUIDITY':freshNotInitialized?'FRESH_STATEVIEW_NOT_INITIALIZED':chosen?'STATEVIEW_REFRESH_REQUESTED':'BOUNDED_CANDIDATE_BUDGET_NOT_SELECTED'),freshEvidence=freshEligible||freshZero||freshNotInitialized,terminalState=Boolean(blocker)||freshEvidence||!chosen,evidenceAt=freshRegistryEligible||freshZero||freshNotInitialized?now:prior?.evidence_at_ms??null,refreshBlock=freshRegistryEligible||freshZero||freshNotInitialized?candidate?.refreshBlock.toString()??registry?.refresh_block??null:prior?.refresh_block??null;insert.run(request.id,request.revision,id,state,reason,chosen&&!terminalState?now:null,terminalState?now:null,freshEvidence?evidenceAt:null,freshEvidence?refreshBlock:null);}});run();
}
function updateDirectLookupCandidate(repo:SqliteLedgerRepository,request:DirectTokenLookupRequestRef,poolId:string,state:DirectLookupCandidateState,reason:string,now:number,error:string|null=null){const terminalState=['ELIGIBLE','NO_ACTIVE_LIQUIDITY','UNSUPPORTED','EVIDENCE_UNAVAILABLE'].includes(state),freshEvidence=state==='ELIGIBLE'||state==='NO_ACTIVE_LIQUIDITY'||reason==='FRESH_STATEVIEW_NOT_INITIALIZED';repo.db.prepare(`UPDATE direct_token_lookup_candidates SET state=?,reason_code=?,attempt_count=attempt_count+CASE WHEN ?='LEASED' THEN 1 ELSE 0 END,leased_at_ms=CASE WHEN ?='LEASED' THEN ? ELSE leased_at_ms END,completed_at_ms=CASE WHEN ? THEN ? ELSE NULL END,evidence_at_ms=CASE WHEN ? THEN ? ELSE evidence_at_ms END,refresh_block=CASE WHEN ? THEN (SELECT refresh_block FROM v4_pool_registry WHERE lower(pool_id)=lower(?)) ELSE refresh_block END,last_error=? WHERE request_id=? AND request_revision=? AND lower(pool_id)=lower(?)`).run(state,reason,state,state,now,terminalState?1:0,now,freshEvidence?1:0,now,freshEvidence?1:0,poolId,error,request.id,request.revision,poolId);}
type DirectTokenLookupRequestRef=Pick<DirectLookupRequest,'id'|'revision'>;
function settleDirectLookupCandidateFromRegistry(repo:SqliteLedgerRepository,request:DirectTokenLookupRequestRef,poolId:string,now:number){const row=repo.v4RegistryPool(poolId),liquidity=BigInt(String(row?.active_liquidity_raw??0));if(!row)return updateDirectLookupCandidate(repo,request,poolId,'EVIDENCE_UNAVAILABLE','STATEVIEW_EVIDENCE_NOT_PERSISTED',now);if(Number(row.initialized)!==1)return updateDirectLookupCandidate(repo,request,poolId,'EVIDENCE_UNAVAILABLE','FRESH_STATEVIEW_NOT_INITIALIZED',now);return updateDirectLookupCandidate(repo,request,poolId,liquidity>0n?'ELIGIBLE':'NO_ACTIVE_LIQUIDITY',liquidity>0n?'FRESH_POSITIVE_ACTIVE_LIQUIDITY':'FRESH_ZERO_ACTIVE_LIQUIDITY',now);}
function finalizeUnresolvedDirectLookupCandidates(repo:SqliteLedgerRepository,request:DirectTokenLookupRequestRef,now:number){repo.db.prepare("UPDATE direct_token_lookup_candidates SET state='EVIDENCE_UNAVAILABLE',reason_code=CASE state WHEN 'LEASED' THEN 'REFRESH_ATTEMPT_INCOMPLETE' ELSE 'DIRECT_LOOKUP_DEADLINE_OR_LANE_BUDGET' END,completed_at_ms=?,last_error=COALESCE(last_error,'BOUNDED_REFRESH_NOT_COMPLETED') WHERE request_id=? AND request_revision=? AND state IN ('DISCOVERED','REFRESH_REQUESTED','LEASED')").run(now,request.id,request.revision);}
export function directLookupCandidateLifecycle(repo:SqliteLedgerRepository,requestId:string,revision:number){return repo.db.prepare('SELECT * FROM direct_token_lookup_candidates WHERE request_id=? AND request_revision=? ORDER BY lower(pool_id)').all(requestId,revision) as DirectLookupCandidateLifecycleRow[];}

function directLookupEvidenceCounts(rows:DirectLookupCandidateLifecycleRow[]){const unsupported=rows.filter(row=>row.state==='UNSUPPORTED').length,zeroLiquidity=rows.filter(row=>row.state==='NO_ACTIVE_LIQUIDITY').length,notInitialized=rows.filter(row=>row.state==='EVIDENCE_UNAVAILABLE'&&row.reason_code==='FRESH_STATEVIEW_NOT_INITIALIZED').length,evidenceUnavailable=rows.filter(row=>row.state==='EVIDENCE_UNAVAILABLE'&&row.reason_code!=='FRESH_STATEVIEW_NOT_INITIALIZED').length;return {structuralCandidateCount:rows.length-unsupported,zeroLiquidityCandidateCount:zeroLiquidity,notInitializedCandidateCount:notInitialized,unavailableCandidateCount:evidenceUnavailable,unsupportedCandidateCount:unsupported,freshClassifiedCandidateCount:rows.filter(row=>row.state==='ELIGIBLE'||row.state==='NO_ACTIVE_LIQUIDITY'||row.reason_code==='FRESH_STATEVIEW_NOT_INITIALIZED').length};}
function directLookupEvidenceForRequest(repo:SqliteLedgerRepository,request:DirectLookupRequest,now:number){
 const rows=directLookupCandidateLifecycle(repo,request.id,request.revision);if(rows.length)return directLookupEvidenceCounts(rows);
 const structuralCandidateCount=directLookupStructuralCandidates(repo,getAddress(request.token_address)).length,raw=directLookupRawCandidatePoolCount(repo,getAddress(request.token_address));
 return {structuralCandidateCount,zeroLiquidityCandidateCount:0,notInitializedCandidateCount:0,unavailableCandidateCount:structuralCandidateCount,unsupportedCandidateCount:Math.max(0,raw-structuralCandidateCount),freshClassifiedCandidateCount:0};
}
function canonicalDirectLookupEligiblePoolIds(repo:SqliteLedgerRepository,request:DirectLookupRequest,now:number){
 const rows=repo.db.prepare(`SELECT c.* FROM direct_token_lookup_candidates c JOIN direct_token_lookup_requests r ON r.id=c.request_id AND r.revision=c.request_revision WHERE r.dedup_key=? AND r.revision<=? AND c.evidence_at_ms>=? ORDER BY r.revision DESC`).all(request.dedup_key,request.revision,now-DIRECT_LOOKUP_FRESH_MS) as DirectLookupCandidateLifecycleRow[],latestEvidence=new Map<string,DirectLookupCandidateLifecycleRow>();
 for(const row of rows)if(!latestEvidence.has(row.pool_id.toLowerCase()))latestEvidence.set(row.pool_id.toLowerCase(),row);
 const v4=[...latestEvidence.values()].filter(row=>row.state==='ELIGIBLE').map(row=>row.pool_id),v3=repo.v3CachedPoolsForToken(getAddress(request.token_address),[robinhoodMainnet.assets.USDG,robinhoodMainnet.assets.WETH],now).map(item=>String(item.pool_address));
 return [...new Map([...v4,...v3].map(id=>[id.toLowerCase(),id])).values()];
}
function recomputeDirectLookupParent(repo:SqliteLedgerRepository,request:DirectLookupRequest,now:number){const rows=directLookupCandidateLifecycle(repo,request.id,request.revision),pending=rows.filter(row=>['DISCOVERED','REFRESH_REQUESTED','LEASED'].includes(row.state));if(pending.length)return {completed:false,pending:pending.length};const eligiblePoolIds=canonicalDirectLookupEligiblePoolIds(repo,request,now),evidence=directLookupEvidenceForRequest(repo,request,now),status:DirectLookupTerminalStatus=eligiblePoolIds.length?'SUPPORTED_POOLS_FOUND':evidence.unavailableCandidateCount?'PROVIDER_TEMPORARILY_UNAVAILABLE':'NO_ACTIVE_LIQUIDITY_POOL';return completeDirectTokenLookup(repo,{requestId:request.id,requestRevision:request.revision,status,candidatePoolCount:rows.length||evidence.structuralCandidateCount+evidence.unsupportedCandidateCount,hydratedPoolCount:evidence.freshClassifiedCandidateCount,eligiblePoolIds,providerResult:evidence.unavailableCandidateCount?'partial_terminal':'available',rpcAttribution:{recomputedFromCandidateLifecycle:true,terminalCandidateCount:rows.length,...evidence,rpcCallCount:0,ethCallCount:0,multicallCount:0,multicallMembers:0},reasonCode:eligiblePoolIds.length?'FRESH_ELIGIBLE_AFTER_STATE_REFRESH':evidence.unavailableCandidateCount?'CANDIDATE_REFRESH_FAILED':evidence.structuralCandidateCount?'ALL_PLAUSIBLE_CANDIDATES_FRESH_NON_EXECUTABLE':'NO_STRUCTURALLY_SUPPORTED_CANDIDATE',nowMs:now});}
export function settleDirectLookupCandidateRefresh(repo:SqliteLedgerRepository,poolId:string,outcome:'REFRESHED'|'FAILED',reason:string,now=Date.now()){
 const requests=repo.db.prepare(`SELECT DISTINCT r.* FROM direct_token_lookup_requests r JOIN direct_token_lookup_candidates c ON c.request_id=r.id AND c.request_revision=r.revision WHERE lower(c.pool_id)=lower(?) AND r.status IN ('QUEUED','RUNNING') AND c.state IN ('DISCOVERED','REFRESH_REQUESTED','LEASED')`).all(poolId) as DirectLookupRequest[],results=[] as unknown[];
 for(const request of requests){if(outcome==='REFRESHED')settleDirectLookupCandidateFromRegistry(repo,request,poolId,now);else updateDirectLookupCandidate(repo,request,poolId,'EVIDENCE_UNAVAILABLE',reason,now,reason);results.push(recomputeDirectLookupParent(repo,request,now));}
 return {parents:requests.length,results};
}
export function markDirectLookupCandidateRefreshLeased(repo:SqliteLedgerRepository,poolIds:string[],now=Date.now()){
 if(!poolIds.length)return 0;let changed=0;for(const poolId of poolIds)changed+=repo.db.prepare(`UPDATE direct_token_lookup_candidates SET state='LEASED',reason_code='STATE_CACHE_REFRESH_LEASED',attempt_count=attempt_count+1,leased_at_ms=?,completed_at_ms=NULL WHERE lower(pool_id)=lower(?) AND state IN ('REFRESH_REQUESTED','LEASED') AND EXISTS(SELECT 1 FROM direct_token_lookup_requests r WHERE r.id=request_id AND r.revision=request_revision AND r.status IN ('QUEUED','RUNNING'))`).run(now,poolId).changes;return changed;
}
export function requeueDirectLookupCandidateRefresh(repo:SqliteLedgerRepository,poolId:string,reason:string){return repo.db.prepare(`UPDATE direct_token_lookup_candidates SET state='REFRESH_REQUESTED',reason_code=?,completed_at_ms=NULL,last_error=? WHERE lower(pool_id)=lower(?) AND state='LEASED' AND EXISTS(SELECT 1 FROM direct_token_lookup_requests r WHERE r.id=request_id AND r.revision=request_revision AND r.status IN ('QUEUED','RUNNING'))`).run(reason,reason,poolId).changes;}

export function applyDirectLookupCandidatePresentation<T extends {poolId:string;uiState?:string;uiReason?:string|null;executionEligible:boolean;blockers?:string[]}>(repo:SqliteLedgerRepository,token:Address,candidates:readonly T[],now=Date.now(),requestRef?:{requestId:string;requestRevision:number}):T[]{
 const request=(requestRef?repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=? AND revision=? AND dedup_key=?').get(requestRef.requestId,requestRef.requestRevision,dedupKey(4663,getAddress(token),DIRECT_LOOKUP_VERSION)):repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE dedup_key=? ORDER BY revision DESC LIMIT 1').get(dedupKey(4663,getAddress(token),DIRECT_LOOKUP_VERSION))) as DirectLookupRequest|undefined;if(!request)return [...candidates];
 const rows=directLookupCandidateLifecycle(repo,request.id,request.revision),byId=new Map(rows.map(row=>[row.pool_id.toLowerCase(),row])),active=request.status==='QUEUED'||request.status==='RUNNING';
 return candidates.map(candidate=>{const row=byId.get(candidate.poolId.toLowerCase());if(!row)return candidate;const evidenceFresh=row.evidence_at_ms!==null&&row.evidence_at_ms>=now-DIRECT_LOOKUP_FRESH_MS,structurallyBlocked=Boolean(candidate.blockers?.length)||String(candidate.uiState).startsWith('UNSUPPORTED:');if(active&&['DISCOVERED','REFRESH_REQUESTED','LEASED'].includes(row.state))return {...candidate,executionEligible:false,uiState:'CHECKING',uiReason:row.reason_code};if(row.state==='ELIGIBLE'&&evidenceFresh&&!structurallyBlocked)return {...candidate,executionEligible:true,uiState:'EXECUTABLE',uiReason:row.reason_code};if(row.state==='NO_ACTIVE_LIQUIDITY'&&evidenceFresh)return {...candidate,executionEligible:false,uiState:'SUPPORTED_NO_ACTIVE_LIQUIDITY',uiReason:row.reason_code};if(row.reason_code==='FRESH_STATEVIEW_NOT_INITIALIZED'&&evidenceFresh)return {...candidate,executionEligible:false,uiState:'NOT_INITIALIZED',uiReason:row.reason_code};if(row.state==='UNSUPPORTED')return {...candidate,executionEligible:false,uiState:`UNSUPPORTED:${row.reason_code??'STRUCTURALLY_UNSUPPORTED'}`,uiReason:row.reason_code};if(candidate.uiState==='CHECKING'||candidate.uiState==='TEMPORARILY_UNAVAILABLE'||row.state==='EVIDENCE_UNAVAILABLE'||!evidenceFresh)return {...candidate,executionEligible:false,uiState:'EVIDENCE_UNAVAILABLE',uiReason:row.state==='ELIGIBLE'||row.state==='NO_ACTIVE_LIQUIDITY'?'DIRECT_LOOKUP_EVIDENCE_EXPIRED':row.reason_code??'EVIDENCE_UNAVAILABLE'};return candidate;});
}

export function directLookupRpcCandidatePoolIds(repo:SqliteLedgerRepository,candidateIds:string[],token?:Address){
 const rpcIds:string[]=[],blocked:Array<{id:string;blockers:string[]}>=[];
 const rows=candidateIds.length?repo.db.prepare(`SELECT pool_id,currency0,currency1,initialize_fee_raw,tick_spacing,hooks FROM v4_pool_registry WHERE lower(pool_id) IN (${candidateIds.map(()=>'?').join(',')})`).all(...candidateIds.map(id=>id.toLowerCase())) as Array<Record<string,unknown>>:[],byId=new Map(rows.map(row=>[String(row.pool_id).toLowerCase(),row])),funding=new Set([robinhoodMainnet.assets.USDG.toLowerCase(),robinhoodMainnet.assets.WETH.toLowerCase()]);
 for(const id of candidateIds){
  const row=byId.get(id.toLowerCase());if(!row){blocked.push({id,blockers:['CANDIDATE_REGISTRY_ROW_MISSING']});continue;}
  const blockers:string[]=[];try{const fee=decodeV4Fee(Number(row.initialize_fee_raw)),hooks=classifyV4Hooks(getAddress(String(row.hooks))),key={currency0:getAddress(String(row.currency0)),currency1:getAddress(String(row.currency1)),fee:Number(row.initialize_fee_raw),tickSpacing:Number(row.tick_spacing),hooks:getAddress(String(row.hooks))};blockers.push(...fee.blockers,...hooks.blockers,...(fee.staticFeePips!==null&&fee.staticFeePips>V4_MAX_EXECUTION_STATIC_FEE_PIPS?['EXTREME_STATIC_FEE']:[]));if(poolId(key).toLowerCase()!==id.toLowerCase())blockers.push('POOL_KEY_IDENTITY_MISMATCH');if(token){const target=token.toLowerCase(),a=key.currency0.toLowerCase(),b=key.currency1.toLowerCase(),other=a===target?b:b===target?a:null;if(!other||!funding.has(other))blockers.push('UNSUPPORTED_FUNDING_PAIR');}}catch{blockers.push('POOL_KEY_IDENTITY_INVALID');}
  const unique=[...new Set(blockers)];if(unique.length)blocked.push({id,blockers:unique});else rpcIds.push(id);
 }
 return {rpcIds,blocked};
}

function freshExecutablePoolIds(repo:SqliteLedgerRepository,token:Address,now:number){
 const v4=cachedV4PoolsForToken({repo,token,now}).candidates.filter(item=>item.executionEligible).map(item=>item.poolId),v3=repo.v3CachedPoolsForToken(token,[robinhoodMainnet.assets.USDG,robinhoodMainnet.assets.WETH],now).map(item=>String(item.pool_address));
 return [...new Map([...v4,...v3].map(id=>[id.toLowerCase(),id])).values()];
}

export function completeDirectTokenLookup(repo:SqliteLedgerRepository,input:{
 requestId:string;requestRevision:number;status:DirectLookupTerminalStatus;candidatePoolCount:number;hydratedPoolCount:number;eligiblePoolIds:string[];
 providerResult:string;rpcAttribution:Partial<RpcAttribution>&Record<string,unknown>;reasonCode:string;nowMs?:number;
}){
 const now=input.nowMs??Date.now(),run=repo.db.transaction(()=>{
  const current=repo.db.prepare('SELECT id,revision FROM direct_token_lookup_requests WHERE dedup_key=(SELECT dedup_key FROM direct_token_lookup_requests WHERE id=?) ORDER BY revision DESC LIMIT 1').get(input.requestId) as {id:string;revision:number}|undefined;
  if(!current||current.id!==input.requestId||current.revision!==input.requestRevision)return {completed:false,stale:true};
  const requestBefore=repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=? AND revision=?').get(input.requestId,input.requestRevision) as DirectLookupRequest,evidence=directLookupEvidenceForRequest(repo,requestBefore,now),canonicalEligible=canonicalDirectLookupEligiblePoolIds(repo,requestBefore,now),eligiblePoolIds=[...new Map([...input.eligiblePoolIds,...canonicalEligible].map(id=>[id.toLowerCase(),id])).values()];let priorAttribution:Record<string,unknown>={};try{priorAttribution=JSON.parse(String(requestBefore.rpc_attribution_json??'{}')) as Record<string,unknown>;}catch{}
  let status:DirectLookupTerminalStatus=eligiblePoolIds.length?'SUPPORTED_POOLS_FOUND':input.status,reasonCode=input.reasonCode;
  if(status==='NO_ACTIVE_LIQUIDITY_POOL'&&evidence.structuralCandidateCount>0&&(evidence.unavailableCandidateCount>0||evidence.freshClassifiedCandidateCount<evidence.structuralCandidateCount)){status='PROVIDER_TEMPORARILY_UNAVAILABLE';reasonCode='PLAUSIBLE_CANDIDATE_EVIDENCE_INCOMPLETE';}
  if(reasonCode==='NO_STRUCTURALLY_SUPPORTED_CANDIDATE'&&evidence.structuralCandidateCount>0)reasonCode=evidence.unavailableCandidateCount?'PLAUSIBLE_CANDIDATE_EVIDENCE_INCOMPLETE':'ALL_PLAUSIBLE_CANDIDATES_FRESH_NON_EXECUTABLE';
  const changed=repo.db.prepare(`UPDATE direct_token_lookup_requests SET status=?,candidate_pool_count=?,hydrated_pool_count=?,eligible_pool_count=?,
   eligible_pool_ids_json=?,provider_result=?,rpc_attribution_json=?,reason_code=?,completed_at_ms=?,updated_at_ms=?,leased_until_ms=NULL
   WHERE id=? AND revision=? AND status IN ('QUEUED','RUNNING')`).run(status,input.candidatePoolCount,input.hydratedPoolCount,eligiblePoolIds.length,json(eligiblePoolIds),input.providerResult,json({...priorAttribution,...input.rpcAttribution,...evidence}),reasonCode,now,now,input.requestId,input.requestRevision).changes;
  if(!changed)return {completed:false,stale:true};
  const request=repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=?').get(input.requestId) as DirectLookupRequest;
  const subscribers=repo.db.prepare('SELECT id FROM direct_token_lookup_subscribers WHERE request_id=? AND request_revision=?').all(input.requestId,input.requestRevision) as Array<{id:string}>;
  for(const subscriber of subscribers)insertOutbox(repo,request,subscriber.id,now);
  return {completed:true,stale:false,request,outboxCreated:subscribers.length};
 });
 return run();
}

export async function executeDirectTokenLookup(input:{
 repo:SqliteLedgerRepository;rpc:FallbackRpc;request:DirectLookupRequest;candidateBudget?:number;maxRpcBatches?:number;ethCallBudget?:number;provider?:string;now?:()=>number;afterRpc?:()=>void|Promise<void>;onStage?:(stage:'candidate_discovery_start'|'candidate_discovery_end'|'rpc_start'|'rpc_end'|'completion_persistence_start'|'completion_persistence_end'|'outbox_persistence_complete',extra?:Record<string,unknown>)=>void;
}){
 const now=input.now??Date.now,started=now(),candidateBudget=Math.max(1,Math.min(12,input.candidateBudget??12)),provider=input.provider??'alchemy',token=getAddress(input.request.token_address);
 const candidateStarted=now();input.onStage?.('candidate_discovery_start');const allCandidateIds=directLookupAllCandidateIds(input.repo,token),rawCandidateCount=allCandidateIds.length,allocation=allocateDirectLookupCandidates(input.repo,token,candidateBudget,candidateStarted,false),candidateIds=allocation.candidateIds,fastWorkset=directLookupRpcCandidatePoolIds(input.repo,candidateIds.slice(0,6),token),fairnessWorkset=directLookupRpcCandidatePoolIds(input.repo,candidateIds.slice(6,12),token),rpcCandidateIds=[...fastWorkset.rpcIds,...fairnessWorkset.rpcIds];initializeDirectLookupCandidates(input.repo,input.request,token,allCandidateIds,rpcCandidateIds,candidateStarted);const initialEligibleIds=canonicalDirectLookupEligiblePoolIds(input.repo,input.request,candidateStarted);for(const id of rpcCandidateIds)input.repo.enqueueV4StateRefresh(id,90,'recent-token-lookup',candidateStarted);input.onStage?.('candidate_discovery_end',{rawCandidateCount,boundedCandidateCount:candidateIds.length,rpcCandidateCount:rpcCandidateIds.length,durableBlockedCount:allCandidateIds.length-rpcCandidateIds.length,fastCandidateCount:allocation.fastIds.length,fairnessCandidateCount:allocation.fairnessIds.length,fastFairnessOverlap:allocation.fastFairnessOverlap,fairnessCursorBefore:allocation.fairnessCursorBefore,fairnessCursorAfter:allocation.fairnessCursorAfter,freshExecutableCacheBefore:initialEligibleIds.length,elapsedMs:now()-candidateStarted});const attributed=attributedRpc(input.rpc,provider,input.ethCallBudget??candidateBudget*2);
 const hydrated:string[]=[],failed:string[]=[],errors:unknown[]=[],completedIds=new Set<string>();let completedLaneCount=0,fairnessStarted=false,fairnessCommitted=false,firstRpcAtMs:number|null=null,hydrationCompletedAtMs:number|null=null;
 const commitAttemptedFairness=()=>{let proven=0;for(const id of allocation.fairnessIds){if(!completedIds.has(id.toLowerCase()))break;proven++;}if(proven)fairnessCommitted=commitDirectLookupFairness(input.repo,token,allocation,now(),proven)||fairnessCommitted;};
 const runLane=async(lane:'FAST'|'FAIRNESS',poolIds:string[])=>{if(!poolIds.length)return true;const remaining=input.request.deadline_at_ms-now();if(remaining<=(lane==='FAIRNESS'?DIRECT_LOOKUP_FAIRNESS_MIN_REMAINING_MS:0))return false;if(lane==='FAIRNESS')fairnessStarted=true;const rpcStarted=now();firstRpcAtMs??=rpcStarted;for(const id of poolIds)updateDirectLookupCandidate(input.repo,input.request,id,'LEASED','STATEVIEW_REFRESH_LEASED',rpcStarted);input.onStage?.('rpc_start',{lane,batchSize:poolIds.length,ethCallCount:poolIds.length*2,multicallMembers:poolIds.length*2,deadlineRemainingMs:Math.max(0,input.request.deadline_at_ms-rpcStarted)});try{const result=await refreshV4RegistryPoolBatch({repo:input.repo,rpc:attributed.rpc,poolIds});hydrated.push(...result.refreshed);failed.push(...result.failed);for(const id of result.refreshed){input.repo.completeV4StateRefresh(id);settleDirectLookupCandidateFromRegistry(input.repo,input.request,id,now());}for(const id of result.failed){input.repo.retryV4StateRefresh(id,'DIRECT_LOOKUP_MULTICALL_MEMBER_FAILED',1,now());updateDirectLookupCandidate(input.repo,input.request,id,'EVIDENCE_UNAVAILABLE','STATEVIEW_MULTICALL_MEMBER_FAILED',now(),'DIRECT_LOOKUP_MULTICALL_MEMBER_FAILED');}for(const id of [...result.refreshed,...result.failed])completedIds.add(id.toLowerCase());completedLaneCount++;commitAttemptedFairness();return true;}catch(error){const safe=(error instanceof Error?error.message:String(error)).replace(/https?:\/\/\S+/g,'[redacted-provider]').slice(0,120);errors.push(error);for(const id of poolIds){input.repo.retryV4StateRefresh(id,'DIRECT_LOOKUP_RPC_FAILED',1,now());updateDirectLookupCandidate(input.repo,input.request,id,'EVIDENCE_UNAVAILABLE','STATEVIEW_RPC_FAILED',now(),safe);completedIds.add(id.toLowerCase());}commitAttemptedFairness();return false;}finally{hydrationCompletedAtMs=now();input.onStage?.('rpc_end',{lane,elapsedMs:hydrationCompletedAtMs-rpcStarted,ethCallCount:poolIds.length*2,multicallCount:1,multicallMembers:poolIds.length*2,deadlineRemainingMs:Math.max(0,input.request.deadline_at_ms-hydrationCompletedAtMs)});}};
 try{await runLane('FAST',fastWorkset.rpcIds);await runLane('FAIRNESS',fairnessWorkset.rpcIds);}finally{await input.afterRpc?.();}
 const ended=now();finalizeUnresolvedDirectLookupCandidates(input.repo,input.request,ended);const lifecycle=directLookupCandidateLifecycle(input.repo,input.request.id,input.request.revision),unresolved=lifecycle.filter(row=>!['ELIGIBLE','NO_ACTIVE_LIQUIDITY','UNSUPPORTED','EVIDENCE_UNAVAILABLE'].includes(row.state));if(unresolved.length)throw new Error('DIRECT_LOOKUP_CANDIDATE_TERMINALIZATION_INCOMPLETE');const currentEligibleIds=canonicalDirectLookupEligiblePoolIds(input.repo,input.request,ended),hydratedSet=new Set(hydrated.map(id=>id.toLowerCase())),preservedInitialIds=initialEligibleIds.filter(id=>!hydratedSet.has(id.toLowerCase())),eligibleIds=[...new Map([...preservedInitialIds,...currentEligibleIds].map(id=>[id.toLowerCase(),id])).values()],calls=attributed.finish(),evidence=directLookupEvidenceCounts(lifecycle),timedOut=ended>=input.request.deadline_at_ms||errors.some(error=>/timeout/i.test(error instanceof Error?error.message:String(error))),status:DirectLookupTerminalStatus=eligibleIds.length?'SUPPORTED_POOLS_FOUND':evidence.unavailableCandidateCount?(timedOut?'LOOKUP_TIMED_OUT':'PROVIDER_TEMPORARILY_UNAVAILABLE'):'NO_ACTIVE_LIQUIDITY_POOL',safeErrors=errors.map(error=>(error instanceof Error?error.message:String(error)).replace(/https?:\/\/\S+/g,'[redacted-provider]').slice(0,120));
 input.onStage?.('completion_persistence_start');const completed=completeDirectTokenLookup(input.repo,{requestId:input.request.id,requestRevision:input.request.revision,status,candidatePoolCount:allCandidateIds.length,hydratedPoolCount:hydrated.length,eligiblePoolIds:eligibleIds,providerResult:errors.length?eligibleIds.length||completedLaneCount?'partial':`unavailable:${safeErrors.join(';')}`:evidence.unavailableCandidateCount?'partial_terminal':'available',rpcAttribution:{...calls,rpcCallCount:calls.eth_blockNumberCount+calls.multicallCount,queueJobsCreated:rpcCandidateIds.length,terminalCandidateCount:lifecycle.length,...evidence,fastCandidateCount:allocation.fastIds.length,fairnessCandidateCount:allocation.fairnessIds.length,fastFairnessOverlap:allocation.fastFairnessOverlap,fairnessCursorBefore:allocation.fairnessCursorBefore,fairnessCursorAfter:fairnessCommitted?directLookupFairnessCursor(input.repo,token).nextOffset:allocation.fairnessCursorBefore,fairnessStarted,fairnessCommitted,freshExecutableCacheBefore:initialEligibleIds.length,requestPersistedAtMs:Number(input.request.created_at_ms),workerLeasedAtMs:Number(input.request.updated_at_ms??started),firstRpcAtMs,hydrationCompletedAtMs,outboxCreatedAtMs:ended,workerMs:ended-started,totalMs:ended-Number(input.request.created_at_ms)},reasonCode:status==='SUPPORTED_POOLS_FOUND'?(evidence.unavailableCandidateCount?'FRESH_ELIGIBLE_WITH_TERMINAL_UNAVAILABLE_CANDIDATES':'FRESH_ELIGIBLE_POOL_VERIFIED'):status==='LOOKUP_TIMED_OUT'?'DIRECT_LOOKUP_DEADLINE_EXCEEDED':status==='PROVIDER_TEMPORARILY_UNAVAILABLE'?'BOUNDED_EVIDENCE_UNAVAILABLE':evidence.structuralCandidateCount?'ALL_PLAUSIBLE_CANDIDATES_FRESH_NON_EXECUTABLE':'NO_STRUCTURALLY_SUPPORTED_CANDIDATE',nowMs:ended});input.onStage?.('completion_persistence_end');input.onStage?.('outbox_persistence_complete',{outboxCreated:completed.outboxCreated??0});return completed;
}

export function leaseDirectLookupOutbox(repo:SqliteLedgerRepository,leaseMs:number,now=Date.now()){
 const run=repo.db.transaction(()=>{
  const row=repo.db.prepare(`SELECT o.*,s.chat_id,s.message_id,s.session_id,s.user_id,s.interaction_id
   FROM direct_token_lookup_outbox o JOIN direct_token_lookup_subscribers s ON s.id=o.subscriber_id
   WHERE o.status IN ('PENDING','LEASED') AND o.available_at_ms<=? AND (o.leased_until_ms IS NULL OR o.leased_until_ms<?)
   ORDER BY o.created_at_ms LIMIT 1`).get(now,now) as Record<string,unknown>|undefined;
  if(!row)return undefined;
  const changed=repo.db.prepare("UPDATE direct_token_lookup_outbox SET status='LEASED',leased_until_ms=?,attempts=attempts+1 WHERE id=? AND request_revision=? AND status IN ('PENDING','LEASED') AND (leased_until_ms IS NULL OR leased_until_ms<?)").run(now+leaseMs,row.id,row.request_revision,now).changes;
  return changed?{...row,status:'LEASED',attempts:Number(row.attempts)+1}:undefined;
 });
 return run();
}
export function saveDirectLookupOutboxRender(repo:SqliteLedgerRepository,id:string,render:unknown,hash:string){
 repo.db.prepare('UPDATE direct_token_lookup_outbox SET render_json=?,render_hash=? WHERE id=? AND render_json IS NULL').run(json(render),hash,id);
}
export function completeDirectLookupOutbox(repo:SqliteLedgerRepository,id:string,now=Date.now()){
 return repo.db.prepare("UPDATE direct_token_lookup_outbox SET status='DELIVERED',delivered_at_ms=?,leased_until_ms=NULL,last_error=NULL WHERE id=? AND status='LEASED'").run(now,id).changes===1;
}
export function retryDirectLookupOutbox(repo:SqliteLedgerRepository,id:string,error:string,maxRetries:number,now=Date.now()){
 const row=repo.db.prepare('SELECT attempts FROM direct_token_lookup_outbox WHERE id=?').get(id) as {attempts:number}|undefined,attempts=Number(row?.attempts??maxRetries),failed=attempts>=maxRetries,delay=Math.min(5_000,250*2**Math.max(0,attempts-1));
 repo.db.prepare("UPDATE direct_token_lookup_outbox SET status=?,available_at_ms=?,leased_until_ms=NULL,last_error=? WHERE id=?").run(failed?'FAILED':'PENDING',now+delay,error.slice(0,300),id);
 return {failed,attempts,delay};
}

export function cleanupLegacyDirectLookupFanout(repo:SqliteLedgerRepository,apply=false,now=Date.now()){
 const reasons=['telegram-token','recent-telegram-token'],before=repo.db.prepare("SELECT reason,COUNT(*) count FROM v4_state_refresh_queue GROUP BY reason ORDER BY reason").all() as Array<{reason:string;count:number}>;
 const removable=repo.db.prepare(`SELECT q.pool_id,q.reason FROM v4_state_refresh_queue q
  WHERE q.reason IN (?,?)
   AND NOT EXISTS(SELECT 1 FROM v4_positions p WHERE lower(p.pool_id)=lower(q.pool_id) AND p.status IN ('open','partially_closed'))
   AND NOT EXISTS(SELECT 1 FROM direct_token_lookup_requests r WHERE r.status IN ('QUEUED','RUNNING') AND r.deadline_at_ms>? AND EXISTS(SELECT 1 FROM v4_pool_registry p WHERE lower(p.pool_id)=lower(q.pool_id) AND (lower(p.currency0)=lower(r.token_address) OR lower(p.currency1)=lower(r.token_address))))
   AND NOT EXISTS(SELECT 1 FROM v4_pool_selections s WHERE lower(s.pool_id)=lower(q.pool_id) AND s.superseded=0 AND s.expires_at_ms>?)`).all(...reasons,now,now) as Array<{pool_id:string;reason:string}>;
 if(apply){
  const remove=repo.db.prepare('DELETE FROM v4_state_refresh_queue WHERE pool_id=? AND reason=?'),run=repo.db.transaction(()=>{for(const row of removable)remove.run(row.pool_id,row.reason);});run();
 }
 const after=apply?repo.db.prepare("SELECT reason,COUNT(*) count FROM v4_state_refresh_queue GROUP BY reason ORDER BY reason").all():before;
 return {mode:apply?'APPLIED':'READ_ONLY',before,removableByReason:Object.entries(removable.reduce<Record<string,number>>((out,row)=>(out[row.reason]=(out[row.reason]??0)+1,out),{})).map(([reason,count])=>({reason,count})),removed:apply?removable.length:0,after,mainnetTransactionsSent:0};
}
