import 'dotenv/config';
import { assertRobinCredentialIsolation } from '../../shared/credential-isolation.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { getAddress } from 'viem';
import { FallbackRpc, ROBINHOOD_V3_DEPLOYMENT_SPECS, orderedRpcUrls, robinhoodMainnet } from '@robin/core';
import { V4_ROBINHOOD_DEPLOYMENTS } from '@robin/v4';
import { migrateSqlite, productionDatabasePaths, SqliteLedgerRepository } from '@robin/ledger';
import { completeWalletPositionSync, enqueueWalletPositionSync, leaseWalletPositionSync, retryWalletPositionSync, syncWalletPositions } from '../../cli/src/position-adoption.js';
import { acquireRpcReadLease, completePortfolioRefresh, completeTargetedPositionReconciliation, leasePortfolioRefresh, leaseTargetedPositionReconciliations, persistPortfolioSnapshot, reconcileActivePositions, releaseRpcReadLease, retryTargetedPositionReconciliation } from '../../cli/src/active-position-reconciliation.js';
import { executeDirectTokenLookup, leaseDirectTokenLookup } from '../../cli/src/direct-token-lookup.js';
import { attributedRpc } from '../../cli/src/rpc-attribution.js';
import { refreshV4RegistryPoolBatch } from '../../cli/src/v4-registry.js';

assertRobinCredentialIsolation(process.env);
delete process.env.LP_PRIVATE_KEY;delete process.env.LP_MNEMONIC;delete process.env.SEED_PHRASE;delete process.env.MNEMONIC;
process.env.EXECUTION_ENABLED='false';process.env.DRY_RUN='true';process.env.EMERGENCY_PAUSE='true';process.env.LIVE_CANARY_ENABLED='false';process.env.V4_LIVE_CANARY_ENABLED='false';
if(!process.env.ALCHEMY_RPC_URLS&&!process.env.ALCHEMY_RPC_URL)throw new Error('ALCHEMY_RPC_URL_REQUIRED');
const integer=(name:string,fallback:number,min:number,max:number)=>{const value=Number(process.env[name]??fallback);return Number.isSafeInteger(value)&&value>=min&&value<=max?value:fallback;};
const paths=productionDatabasePaths({dataDir:process.env.DATA_DIR,databasePath:process.env.DATABASE_PATH}),stateUrls=orderedRpcUrls(process.env.ALCHEMY_RPC_URLS,process.env.ALCHEMY_RPC_URL),logUrls=[process.env.RH_LOGS_RPC_URL??'https://rpc.mainnet.chain.robinhood.com'];
const stateRpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:stateUrls},stateUrls,{timeoutMs:integer('STATE_CACHE_RPC_TIMEOUT_MS',2_000,250,15_000)}),logRpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:logUrls},logUrls,{timeoutMs:integer('ADOPTION_LOG_RPC_TIMEOUT_MS',8_000,500,30_000)});
const walletText=process.env.DEDICATED_WALLET_ADDRESS??process.env.OPERATOR_WALLET??process.env.WALLET_ADDRESS,wallet=walletText?getAddress(walletText):undefined;
const loopMs=integer('DIRECT_LOOKUP_WORKER_IDLE_MS',750,250,10_000),stateCadenceMs=integer('STATE_CACHE_CADENCE_MS',60_000,30_000,3_600_000),stateBatch=integer('STATE_CACHE_BATCH_LIMIT',16,1,32),stateTtlMs=integer('STATE_CACHE_ACTIVE_POOL_TTL_MS',120_000,60_000,3_600_000);
const directCandidateBudget=integer('DIRECT_LOOKUP_CANDIDATE_BUDGET',12,1,12),directMaxBatches=integer('DIRECT_LOOKUP_MAX_RPC_BATCHES',1,1,2),directEthCallBudget=integer('DIRECT_LOOKUP_ETH_CALL_BUDGET',24,2,24);
const adoptionCadenceMs=integer('WALLET_ADOPTION_CADENCE_MS',300_000,60_000,86_400_000),candidateLimit=integer('WALLET_ADOPTION_CANDIDATE_LIMIT',16,1,100),ownershipTtlMs=integer('WALLET_ADOPTION_OWNERSHIP_TTL_MS',86_400_000,60_000,604_800_000),scanWindows=integer('WALLET_ADOPTION_MAX_WINDOWS',2,1,10),scanWindow=BigInt(integer('WALLET_ADOPTION_BLOCK_WINDOW',25_000,100,100_000)),adoptionEthCallBudget=integer('WALLET_ADOPTION_ETH_CALL_BUDGET',24,1,64);
const activeCadenceMs=integer('ACTIVE_POSITION_RECONCILIATION_CADENCE_MS',300_000,60_000,3_600_000),activeTtlMs=integer('ACTIVE_POSITION_RECONCILIATION_TTL_MS',300_000,60_000,3_600_000),activeLimit=integer('ACTIVE_POSITION_RECONCILIATION_LIMIT',16,1,32);
migrateSqlite(paths.databasePath,'infra/migrations');
let stopping=false,lastPeriodicAdoption=0,lastActiveReconciliation=0,lastStateCache=0,currentOperation='idle';
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
const emit=(event:string,data:Record<string,unknown>={})=>process.stdout.write(JSON.stringify({event,process:'robin-v4-state-cache-worker',...data,at:new Date().toISOString()},(_,value)=>typeof value==='bigint'?value.toString():value)+'\n');
const v3Factory=ROBINHOOD_V3_DEPLOYMENT_SPECS.find(item=>item.name==='factory')!.address,v3PositionManager=ROBINHOOD_V3_DEPLOYMENT_SPECS.find(item=>item.name==='positionManager')!.address;
const deploymentCache={v3:{status:'available',value:{factory:v3Factory,positionManager:v3PositionManager},provenance:{provider:'pinned official Uniswap deployment registry',observedAt:new Date().toISOString(),confidence:'verified'}},v4:{status:'available',value:V4_ROBINHOOD_DEPLOYMENTS,provenance:{provider:'pinned official Uniswap deployment registry',observedAt:new Date().toISOString(),confidence:'verified'}}} as any;
const open=()=>new SqliteLedgerRepository(paths.databasePath);
const busy=async<T>(operation:string,work:()=>Promise<T>|T):Promise<{value:T;lockRetryCount:number;dbWaitMs:number}>=>{
 const started=Date.now();let failure:unknown;
 for(let attempt=0;attempt<3;attempt++)try{return {value:await work(),lockRetryCount:attempt,dbWaitMs:Date.now()-started};}catch(error){failure=error;if(!/SQLITE_BUSY|database is locked/i.test(error instanceof Error?error.message:String(error)))throw error;const wait=50*2**attempt+Math.floor(Math.random()*50);emit('sqlite_busy_retry',{operation,attempt:attempt+1,waitMs:wait});await sleep(wait);}
 emit('sqlite_busy_terminal',{operation,dbWaitMs:Date.now()-started,error:failure instanceof Error?failure.message:String(failure)});throw failure;
};
const queueDepth=()=>{const db=open();try{return Number((db.db.prepare('SELECT COUNT(*) count FROM v4_state_refresh_queue').get() as {count:number}).count);}finally{db.close();}};

async function directLookupPhase(){
 const leased=await busy('direct_lookup_lease',()=>{const db=open();try{return leaseDirectTokenLookup(db,15_000);}finally{db.close();}});if(!leased.value)return false;
 const request=leased.value,started=Date.now(),depthBefore=queueDepth(),workDb=open();let result;
 try{result=await executeDirectTokenLookup({repo:workDb,rpc:stateRpc,request,candidateBudget:directCandidateBudget,maxRpcBatches:directMaxBatches,ethCallBudget:directEthCallBudget});}finally{workDb.close();}
 const inspectDb=open();let completed:Record<string,unknown>|undefined;try{completed=inspectDb.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=?').get(request.id) as Record<string,unknown>|undefined;}finally{inspectDb.close();}
 const metrics=JSON.parse(String(completed?.rpc_attribution_json??'{}'));
 emit('rpc_cycle_telemetry',{interaction:'direct-token-lookup',interactionId:request.interaction_id??null,requestId:request.id,requestRevision:request.revision,token:request.token_address,cacheHit:false,deduplicated:false,candidatePoolCount:completed?.candidate_pool_count??0,hydratedPoolCount:completed?.hydrated_pool_count??0,eligiblePoolCount:completed?.eligible_pool_count??0,queueJobsCreated:0,jobsLeased:1,jobsCompleted:result.completed?1:0,jobsSkippedFresh:0,lockRetryCount:leased.lockRetryCount,dbWaitMs:leased.dbWaitMs,rpcCallCount:metrics.rpcCallCount??0,ethCallCount:metrics.ethCallCount??0,eth_blockNumberCount:metrics.eth_blockNumberCount??0,getLogsCount:metrics.getLogsCount??0,multicallCount:metrics.multicallCount??0,multicallMembers:metrics.multicallMembers??0,provider:metrics.provider??'none',elapsedMs:Date.now()-started,queueDepthBefore:depthBefore,queueDepthAfter:queueDepth(),overlapPrevented:true,terminalStatus:completed?.status,mainnetTransactionsSent:0});
 return true;
}

async function targetedReconciliationPhase(now:number){
 if(!wallet)return false;
 const leased=await busy('targeted_reconciliation_lease',()=>{const db=open();try{return leaseTargetedPositionReconciliations(db,activeLimit,15_000,now);}finally{db.close();}});
 if(!leased.value.length)return false;
 const owner=`worker-targeted:${now}`,leaseDb=open();let acquired=false;try{acquired=acquireRpcReadLease(leaseDb,owner,15_000,now);}finally{leaseDb.close();}
 if(!acquired){const retryDb=open();try{for(const request of leased.value)retryTargetedPositionReconciliation(retryDb,String(request.position_id),'GLOBAL_RPC_LEASE_BUSY',now);}finally{retryDb.close();}emit('rpc_cycle_deferred',{interaction:'targeted-position-reconciliation',interactionId:owner,jobsLeased:leased.value.length,overlapPrevented:true,ethCallCount:0});return false;}
 const started=Date.now(),db=open();
 try{
  const ids=leased.value.map(row=>String(row.position_id)),result=await reconcileActivePositions({repo:db,rpc:stateRpc,wallet,positionIds:ids,limit:ids.length,ttlMs:activeTtlMs,interactionId:owner});
  const byId=new Map(result.positions.map(position=>[position.positionId,position]));
  for(const request of leased.value){const id=String(request.position_id),position=byId.get(id);if(position&&!position.error)completeTargetedPositionReconciliation(db,id,now);else retryTargetedPositionReconciliation(db,id,position?.error??'TARGETED_RECONCILIATION_INCOMPLETE',now);}
  emit('rpc_cycle_telemetry',{interaction:'targeted-position-reconciliation',...result,jobsLeased:leased.value.length,jobsCompleted:result.positions.filter(position=>!position.error).length,jobsSkippedFresh:0,lockRetryCount:leased.lockRetryCount,dbWaitMs:leased.dbWaitMs,elapsedMs:Date.now()-started,queueDepthBefore:leased.value.length,queueDepthAfter:0,overlapPrevented:true,mainnetTransactionsSent:0});
  return result.ethCallCount>0;
 }finally{db.close();const releaseDb=open();try{releaseRpcReadLease(releaseDb,owner);}finally{releaseDb.close();}}
}

async function activeReconciliationPhase(now:number){
 if(!wallet)return false;
 const requestDb=open();let portfolioRequest;try{portfolioRequest=leasePortfolioRefresh(requestDb,Math.max(60_000,activeCadenceMs*2),now);}finally{requestDb.close();}
 if(!portfolioRequest&&now-lastActiveReconciliation<activeCadenceMs)return false;
 const owner=`worker-active:${now}`,leaseDb=open();let acquired=false;try{acquired=acquireRpcReadLease(leaseDb,owner,60_000,now);}finally{leaseDb.close();}if(!acquired){emit('rpc_cycle_deferred',{interaction:'active-position-reconciliation',interactionId:owner,overlapPrevented:true,ethCallCount:0});return false;}
 const started=Date.now(),db=open();try{const result=await reconcileActivePositions({repo:db,rpc:stateRpc,wallet,limit:activeLimit,ttlMs:activeTtlMs,interactionId:portfolioRequest?`portfolio-worker:${String(portfolioRequest.requested_at_ms)}`:`active-worker:${now}`});lastActiveReconciliation=now;if(portfolioRequest)completePortfolioRefresh(db);else persistPortfolioSnapshot(db,now);emit('rpc_cycle_telemetry',{interaction:'active-position-reconciliation',...result,jobsLeased:result.activePositionChecks,jobsCompleted:result.positions.length,jobsSkippedFresh:result.skippedFreshTtlCount,lockRetryCount:0,dbWaitMs:0,elapsedMs:Date.now()-started,queueDepthBefore:0,queueDepthAfter:0,overlapPrevented:true,confirmedActiveCount:result.positions.filter(item=>item.confirmedActive).length,terminalizedCount:result.positions.filter(item=>item.terminalReason).length,mainnetTransactionsSent:0});return result.ethCallCount>0;}finally{db.close();const releaseDb=open();try{releaseRpcReadLease(releaseDb,owner);}finally{releaseDb.close();}}
}

async function stateCachePhase(now:number){
 if(now-lastStateCache<stateCadenceMs)return false;lastStateCache=now;
 const owner=`worker-state:${now}`,leaseDb=open();let acquired=false;try{acquired=acquireRpcReadLease(leaseDb,owner,60_000,now);}finally{leaseDb.close();}if(!acquired){emit('rpc_cycle_deferred',{interaction:'state-cache',interactionId:owner,overlapPrevented:true,ethCallCount:0});return false;}
 const started=Date.now(),depthBefore=queueDepth(),selectDb=open();let jobs:Record<string,unknown>[]=[],activePoolCount=0,skippedFreshTtlCount=0;
 try{
  const all=selectDb.db.prepare(`SELECT DISTINCT p.pool_id,r.last_refreshed_at FROM v4_positions p
   JOIN active_position_reconciliations a ON a.position_id='v4:'||p.token_id AND a.confirmed_active=1
   LEFT JOIN v4_pool_registry r ON lower(r.pool_id)=lower(p.pool_id)
   WHERE p.status IN ('open','partially_closed') ORDER BY p.updated_at DESC LIMIT ?`).all(stateBatch) as Array<{pool_id:string;last_refreshed_at:string|null}>;
  activePoolCount=all.length;const due=all.filter(row=>!row.last_refreshed_at||Date.parse(row.last_refreshed_at)<=now-stateTtlMs);skippedFreshTtlCount=all.length-due.length;
  for(const row of due)selectDb.enqueueV4StateRefresh(row.pool_id,120,'active-wallet-position',now);
  jobs=selectDb.leaseV4StateRefresh(Math.min(stateBatch,due.length),60_000,now).filter(job=>String(job.reason)==='active-wallet-position');
 }finally{selectDb.close();}
 try{
  if(!jobs.length){emit('rpc_cycle_telemetry',{interaction:'state-cache',interactionId:`state-cache:${now}`,method:'StateView.multicall',provider:'none',jobsLeased:0,jobsCompleted:0,jobsSkippedFresh:skippedFreshTtlCount,lockRetryCount:0,dbWaitMs:0,rpcCallCount:0,ethCallCount:0,eth_blockNumberCount:0,getCodeCount:0,multicallCount:0,multicallMembers:0,elapsedMs:Date.now()-started,queueDepthBefore:depthBefore,queueDepthAfter:queueDepth(),activePoolCount,overlapPrevented:true,mainnetTransactionsSent:0});return false;}
  const workDb=open();let batch:Awaited<ReturnType<typeof refreshV4RegistryPoolBatch>>;try{batch=await refreshV4RegistryPoolBatch({repo:workDb,rpc:stateRpc,poolIds:jobs.map(x=>String(x.pool_id))});for(const id of batch.refreshed)workDb.completeV4StateRefresh(id);for(const job of jobs.filter(x=>batch.failed.includes(String(x.pool_id))))workDb.retryV4StateRefresh(String(job.pool_id),'BOUNDED_MULTICALL_MEMBER_FAILED',Number(job.attempts)+1);}finally{workDb.close();}
  emit('rpc_cycle_telemetry',{interaction:'state-cache',interactionId:`state-cache:${now}`,method:'StateView.multicall',provider:'alchemy',jobsLeased:jobs.length,jobsCompleted:batch.refreshed.length,jobsSkippedFresh:skippedFreshTtlCount,lockRetryCount:0,dbWaitMs:0,rpcCallCount:2,ethCallCount:jobs.length*2,eth_blockNumberCount:1,getCodeCount:0,multicallCount:1,multicallMembers:jobs.length*2,elapsedMs:Date.now()-started,queueDepthBefore:depthBefore,queueDepthAfter:queueDepth(),activePoolCount,overlapPrevented:true,mainnetTransactionsSent:0});return true;
 }finally{const releaseDb=open();try{releaseRpcReadLease(releaseDb,owner);}finally{releaseDb.close();}}
}

async function adoptionPhase(now:number,rpcTaskRan:boolean){
 if(!wallet)return;
 if(now-lastPeriodicAdoption>=adoptionCadenceMs){await busy('adoption_enqueue',()=>{const db=open();try{enqueueWalletPositionSync(db,'periodic-safety-sync',now);}finally{db.close();}});lastPeriodicAdoption=now;}
 if(rpcTaskRan)return;
 const dueDb=open();let adoptionDue=false;try{adoptionDue=Boolean(dueDb.db.prepare("SELECT 1 FROM wallet_position_sync_requests WHERE request_key='wallet' AND available_at_ms<=? AND (leased_until_ms IS NULL OR leased_until_ms<?)").get(now,now));}finally{dueDb.close();}if(!adoptionDue)return;
 const owner=`worker-adoption:${now}`,lease=await busy('adoption_lease',()=>{const leaseDb=open();try{const acquired=acquireRpcReadLease(leaseDb,owner,60_000,now),request=acquired?leaseWalletPositionSync(leaseDb,Math.max(60_000,adoptionCadenceMs),now):undefined;return {acquired,request};}finally{leaseDb.close();}}),{acquired,request}=lease.value;if(!request){if(acquired)await busy('adoption_lease_release',()=>{const releaseDb=open();try{releaseRpcReadLease(releaseDb,owner);}finally{releaseDb.close();}});return;}
 const started=Date.now(),attributed=attributedRpc(stateRpc,'alchemy',adoptionEthCallBudget),attributedLogs=attributedRpc(logRpc,'robinhood-logs',adoptionEthCallBudget,attributed.metrics),db=open();
 try{const result=await syncWalletPositions({repo:db,readRpc:attributed.rpc,logsRpc:attributedLogs.rpc,wallet,windowSize:scanWindow,maxWindows:scanWindows,candidateLimit,ownershipTtlMs,deploymentCache});completeWalletPositionSync(db);const calls=attributed.finish();emit('rpc_cycle_telemetry',{interaction:'wallet-adoption',interactionId:String(request.reason),method:'bounded-transfer-cursor+ownerOf',...calls,jobsLeased:1,jobsCompleted:1,jobsSkippedFresh:result.skippedFinalizedCount,lockRetryCount:0,dbWaitMs:0,cacheHitCount:result.skippedFinalizedCount,candidateCount:result.candidateCount,skippedFinalizedCount:result.skippedFinalizedCount,scanWindows:result.scans.reduce((sum,item)=>sum+item.windows,0),ethCallBudget:adoptionEthCallBudget,overlapPrevented:true,elapsedMs:Date.now()-started,mainnetTransactionsSent:0});}
 catch(error){const reason=error instanceof Error?error.message:String(error);retryWalletPositionSync(db,reason);emit('wallet_adoption_cycle_error',{interactionId:String(request.reason),reason,...attributed.finish(),ethCallBudget:adoptionEthCallBudget,overlapPrevented:true,elapsedMs:Date.now()-started,mainnetTransactionsSent:0});}
 finally{db.close();const releaseDb=open();try{releaseRpcReadLease(releaseDb,owner);}finally{releaseDb.close();}}
}

while(!stopping){
 const cycleStarted=Date.now();
 try{
  currentOperation='targeted_reconciliation';const targetedRan=await targetedReconciliationPhase(cycleStarted);let rpcTaskRan=targetedRan;
  if(!targetedRan){currentOperation='direct_lookup';rpcTaskRan=await directLookupPhase();}
  if(!rpcTaskRan){currentOperation='active_reconciliation';rpcTaskRan=await activeReconciliationPhase(cycleStarted);}
  if(!rpcTaskRan){currentOperation='state_cache';rpcTaskRan=await stateCachePhase(cycleStarted);}
  currentOperation='adoption';await adoptionPhase(cycleStarted,rpcTaskRan);currentOperation='idle';
 }catch(error){const reason=error instanceof Error?error.message:String(error);if(/SQLITE_BUSY|database is locked/i.test(reason)){const waitMs=250+Math.floor(Math.random()*250);emit('sqlite_busy_cycle_backoff',{operation:currentOperation,writerPhase:'short lease or persistence transaction',waitMs,error:'SQLITE_BUSY',mainnetTransactionsSent:0});await sleep(waitMs);}else emit('state_cache_cycle_error',{operation:currentOperation,error:reason,mainnetTransactionsSent:0});}
 if(!stopping)await sleep(loopMs);
}
