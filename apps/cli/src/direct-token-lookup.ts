import { randomUUID } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import type { FallbackRpc } from '@robin/core';
import { robinhoodMainnet } from '@robin/core';
import type { SqliteLedgerRepository } from '@robin/ledger';
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
 status:DirectLookupStatus;deadline_at_ms:number;result_expires_at_ms:number;attempts:number;
};
const terminal=(status:unknown):status is DirectLookupTerminalStatus=>
 DIRECT_LOOKUP_TERMINAL_STATUSES.includes(status as DirectLookupTerminalStatus);
const json=(value:unknown)=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?item.toString():item);
const parseIds=(value:unknown):string[]=>{try{const parsed=JSON.parse(String(value??'[]'));return Array.isArray(parsed)?parsed.map(String):[];}catch{return [];}};
const dedupKey=(chainId:number,token:Address,version:number)=>`${chainId}:${token.toLowerCase()}:${version}`;

export function createOrReuseDirectLookup(input:{
 repo:SqliteLedgerRepository;chainId?:number;token:Address;interactionId?:string;nowMs?:number;deadlineMs?:number;resultTtlMs?:number;explicitRetry?:boolean;
}){
 const chainId=input.chainId??4663,token=getAddress(input.token),version=DIRECT_LOOKUP_VERSION,now=input.nowMs??Date.now(),deadlineMs=input.deadlineMs??10_000,resultTtlMs=input.resultTtlMs??300_000,key=dedupKey(chainId,token,version);
 const run=input.repo.db.transaction(()=>{
  const latest=input.repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE dedup_key=? ORDER BY revision DESC LIMIT 1').get(key) as DirectLookupRequest|undefined;
  if(latest&&!input.explicitRetry){
   if((latest.status==='QUEUED'||latest.status==='RUNNING')&&latest.deadline_at_ms>now)return {request:latest,deduplicated:true,cacheHit:false,created:false};
   if(terminal(latest.status)&&latest.result_expires_at_ms>now)return {request:latest,deduplicated:true,cacheHit:true,created:false};
  }
  const revision=(latest?.revision??0)+1,id=randomUUID(),requestDeadline=now+deadlineMs;
  input.repo.db.prepare(`INSERT INTO direct_token_lookup_requests
   (id,chain_id,token_address,lookup_version,dedup_key,revision,interaction_id,status,created_at_ms,updated_at_ms,deadline_at_ms,result_expires_at_ms)
   VALUES(?,?,?,?,?,?,?,'QUEUED',?,?,?,?)`).run(id,chainId,token,version,key,revision,input.interactionId??null,now,now,requestDeadline,now+resultTtlMs);
  return {request:input.repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=?').get(id) as DirectLookupRequest,deduplicated:false,cacheHit:false,created:true};
 });
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

export function leaseDirectTokenLookup(repo:SqliteLedgerRepository,leaseMs:number,now=Date.now()):DirectLookupRequest|undefined{
 const run=repo.db.transaction(()=>{
  expireDueDirectTokenLookups(repo,now);
  const row=repo.db.prepare("SELECT * FROM direct_token_lookup_requests WHERE status IN ('QUEUED','RUNNING') AND deadline_at_ms>? AND (leased_until_ms IS NULL OR leased_until_ms<?) ORDER BY created_at_ms LIMIT 1").get(now,now) as DirectLookupRequest|undefined;
  if(!row)return undefined;
  const changed=repo.db.prepare("UPDATE direct_token_lookup_requests SET status='RUNNING',leased_until_ms=?,attempts=attempts+1,updated_at_ms=? WHERE id=? AND revision=? AND status IN ('QUEUED','RUNNING') AND (leased_until_ms IS NULL OR leased_until_ms<?)").run(now+leaseMs,now,row.id,row.revision,now).changes;
  return changed?repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=?').get(row.id) as DirectLookupRequest:undefined;
 });
 return run();
}
export function expireDueDirectTokenLookups(repo:SqliteLedgerRepository,now=Date.now(),limit=10){
 const expired=repo.db.prepare("SELECT * FROM direct_token_lookup_requests WHERE status IN ('QUEUED','RUNNING') AND deadline_at_ms<=? ORDER BY created_at_ms LIMIT ?").all(now,limit) as DirectLookupRequest[];let completed=0;
 for(const request of expired)if(completeDirectTokenLookup(repo,{requestId:request.id,requestRevision:request.revision,status:'LOOKUP_TIMED_OUT',reasonCode:'DIRECT_LOOKUP_DEADLINE_EXCEEDED',candidatePoolCount:Number(request.candidate_pool_count??0),hydratedPoolCount:Number(request.hydrated_pool_count??0),eligiblePoolIds:[],providerResult:'deadline',rpcAttribution:{rpcCallCount:0,ethCallCount:0,eth_blockNumberCount:0,multicallCount:0,multicallMembers:0},nowMs:now}).completed)completed++;
 return completed;
}

export function directLookupCandidatePoolIds(repo:SqliteLedgerRepository,token:Address,limit:number){
 const funding=[robinhoodMainnet.assets.USDG.toLowerCase(),robinhoodMainnet.assets.WETH.toLowerCase()];
 return (repo.db.prepare(`SELECT pool_id FROM v4_pool_registry
  WHERE ((lower(currency0)=lower(?) AND lower(currency1) IN (?,?)) OR (lower(currency1)=lower(?) AND lower(currency0) IN (?,?)))
  ORDER BY
   CASE WHEN validation_status='ELIGIBLE' AND active_liquidity_raw<>'0' THEN 0 WHEN active_liquidity_raw<>'0' THEN 1 ELSE 2 END,
   CASE WHEN lower(currency0)=? OR lower(currency1)=? THEN 0 ELSE 1 END,
   CASE WHEN lower(currency0)=? OR lower(currency1)=? THEN 0 ELSE 1 END,
   CASE WHEN last_refreshed_at IS NULL THEN 0 ELSE 1 END,
   initialization_block DESC,pool_id ASC
  LIMIT ?`).all(token,funding[0],funding[1],token,funding[0],funding[1],funding[0],funding[0],funding[1],funding[1],limit) as Array<{pool_id:string}>).map(row=>row.pool_id);
}

export function completeDirectTokenLookup(repo:SqliteLedgerRepository,input:{
 requestId:string;requestRevision:number;status:DirectLookupTerminalStatus;candidatePoolCount:number;hydratedPoolCount:number;eligiblePoolIds:string[];
 providerResult:string;rpcAttribution:Partial<RpcAttribution>&Record<string,unknown>;reasonCode:string;nowMs?:number;
}){
 const now=input.nowMs??Date.now(),run=repo.db.transaction(()=>{
  const current=repo.db.prepare('SELECT id,revision FROM direct_token_lookup_requests WHERE dedup_key=(SELECT dedup_key FROM direct_token_lookup_requests WHERE id=?) ORDER BY revision DESC LIMIT 1').get(input.requestId) as {id:string;revision:number}|undefined;
  if(!current||current.id!==input.requestId||current.revision!==input.requestRevision)return {completed:false,stale:true};
  const changed=repo.db.prepare(`UPDATE direct_token_lookup_requests SET status=?,candidate_pool_count=?,hydrated_pool_count=?,eligible_pool_count=?,
   eligible_pool_ids_json=?,provider_result=?,rpc_attribution_json=?,reason_code=?,completed_at_ms=?,updated_at_ms=?,leased_until_ms=NULL
   WHERE id=? AND revision=? AND status IN ('QUEUED','RUNNING')`).run(input.status,input.candidatePoolCount,input.hydratedPoolCount,input.eligiblePoolIds.length,json(input.eligiblePoolIds),input.providerResult,json(input.rpcAttribution),input.reasonCode,now,now,input.requestId,input.requestRevision).changes;
  if(!changed)return {completed:false,stale:true};
  const request=repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=?').get(input.requestId) as DirectLookupRequest;
  const subscribers=repo.db.prepare('SELECT id FROM direct_token_lookup_subscribers WHERE request_id=? AND request_revision=?').all(input.requestId,input.requestRevision) as Array<{id:string}>;
  for(const subscriber of subscribers)insertOutbox(repo,request,subscriber.id,now);
  return {completed:true,stale:false,request,outboxCreated:subscribers.length};
 });
 return run();
}

export async function executeDirectTokenLookup(input:{
 repo:SqliteLedgerRepository;rpc:FallbackRpc;request:DirectLookupRequest;candidateBudget?:number;maxRpcBatches?:number;ethCallBudget?:number;provider?:string;now?:()=>number;
}){
 const started=(input.now??Date.now)(),candidateBudget=Math.max(1,Math.min(12,input.candidateBudget??12)),maxBatches=Math.max(1,Math.min(2,input.maxRpcBatches??1)),provider=input.provider??'alchemy';
 const candidateIds=directLookupCandidatePoolIds(input.repo,getAddress(input.request.token_address),candidateBudget),attributed=attributedRpc(input.rpc,provider,input.ethCallBudget??candidateBudget*2);
 let hydrated:string[]=[],failed:string[]=[];
 try{
  const batchSize=Math.ceil(candidateIds.length/maxBatches);
  for(let offset=0;offset<candidateIds.length&&offset/batchSize<maxBatches;offset+=batchSize){
   if((input.now??Date.now)()>=input.request.deadline_at_ms)break;
   const result=await refreshV4RegistryPoolBatch({repo:input.repo,rpc:attributed.rpc,poolIds:candidateIds.slice(offset,offset+batchSize)});
   hydrated.push(...result.refreshed);failed.push(...result.failed);
   const current=cachedV4PoolsForToken({repo:input.repo,token:getAddress(input.request.token_address),now:(input.now??Date.now)()}).candidates.filter(item=>hydrated.some(id=>id.toLowerCase()===item.poolId.toLowerCase())&&item.executionEligible);
   if(current.length)break;
  }
  const ended=(input.now??Date.now)(),calls=attributed.finish(),eligibleV4=cachedV4PoolsForToken({repo:input.repo,token:getAddress(input.request.token_address),now:ended}).candidates.filter(item=>hydrated.some(id=>id.toLowerCase()===item.poolId.toLowerCase())&&item.executionEligible),v3=input.repo.v3CachedPoolsForToken(input.request.token_address,[robinhoodMainnet.assets.USDG,robinhoodMainnet.assets.WETH],ended),eligibleIds=[...eligibleV4.map(item=>item.poolId),...v3.map(item=>String(item.pool_address))];
  const status:DirectLookupTerminalStatus=ended>=input.request.deadline_at_ms?'LOOKUP_TIMED_OUT':eligibleIds.length?'SUPPORTED_POOLS_FOUND':'NO_ACTIVE_LIQUIDITY_POOL';
  return completeDirectTokenLookup(input.repo,{requestId:input.request.id,requestRevision:input.request.revision,status,candidatePoolCount:candidateIds.length,hydratedPoolCount:hydrated.length,eligiblePoolIds:eligibleIds,providerResult:failed.length?'partial':'available',rpcAttribution:{...calls,rpcCallCount:calls.eth_blockNumberCount+calls.multicallCount,queueJobsCreated:1,workerMs:ended-started,totalMs:ended-Number(input.request.created_at_ms)},reasonCode:status==='SUPPORTED_POOLS_FOUND'?'FRESH_ELIGIBLE_POOL_VERIFIED':status==='LOOKUP_TIMED_OUT'?'DIRECT_LOOKUP_DEADLINE_EXCEEDED':'NO_FRESH_POSITIVE_ACTIVE_LIQUIDITY',nowMs:ended});
 }catch(error){
  const ended=(input.now??Date.now)(),calls=attributed.finish(),timedOut=ended>=input.request.deadline_at_ms||/timeout/i.test(error instanceof Error?error.message:String(error));
  const safeError=(error instanceof Error?error.message:String(error)).replace(/https?:\/\/\S+/g,'[redacted-provider]').slice(0,160);
  return completeDirectTokenLookup(input.repo,{requestId:input.request.id,requestRevision:input.request.revision,status:timedOut?'LOOKUP_TIMED_OUT':'PROVIDER_TEMPORARILY_UNAVAILABLE',candidatePoolCount:candidateIds.length,hydratedPoolCount:hydrated.length,eligiblePoolIds:[],providerResult:`unavailable:${safeError}`,rpcAttribution:{...calls,rpcCallCount:calls.eth_blockNumberCount+calls.multicallCount,queueJobsCreated:1,workerMs:ended-started,totalMs:ended-Number(input.request.created_at_ms)},reasonCode:timedOut?'DIRECT_LOOKUP_DEADLINE_EXCEEDED':'BOUNDED_PROVIDER_FAILURE',nowMs:ended});
 }
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
