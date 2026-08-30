import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertFuniCredentialIsolation } from '../../shared/credential-isolation.js';
import { FallbackRpc, orderedRpcUrls, robinhoodMainnet } from '@funi/core';
import { EconomicForegroundDemandActiveError, migrateSqlite, productionDatabasePaths, SQLITE_RUNTIME_BUSY_TIMEOUT_MS, SqliteLedgerRepository, waitForEconomicForegroundDemandToClear } from '@funi/ledger';
import { acquireRpcReadLease, releaseRpcReadLease } from '../../cli/src/active-position-reconciliation.js';
import { executeDirectTokenLookup, leaseDirectTokenLookup, releaseDirectTokenLookupLease } from '../../cli/src/direct-token-lookup.js';

type BusyRunner=<T>(operation:string,work:()=>T)=>Promise<T>;
type LookupStage='cycle_start'|'request_lease_start'|'request_lease_end'|'execute_start'|'candidate_discovery_start'|'candidate_discovery_end'|'rpc_lease_start'|'rpc_lease_end'|'rpc_start'|'rpc_end'|'completion_persistence_start'|'completion_persistence_end'|'outbox_persistence_complete'|'execute_end'|'cycle_end';
type LookupStageRecord={stage:LookupStage;atMs:number;elapsedFromRequestMs?:number;deadlineRemainingMs?:number;deadlineOverrunMs?:number;[key:string]:unknown};

export async function runDedicatedDirectLookupCycle(input:{
 repo:SqliteLedgerRepository;rpc:FallbackRpc;requestLeaseMs?:number;rpcLeaseMs?:number;candidateBudget?:number;maxRpcBatches?:number;ethCallBudget?:number;now?:()=>number;busy?:BusyRunner;onStage?:(record:LookupStageRecord)=>void;
}){
 const now=input.now??Date.now,busy=input.busy??(async(_operation,work)=>work()),stages:LookupStageRecord[]=[],cycleStarted=now(),stage=(name:LookupStage,request?:{created_at_ms:number;deadline_at_ms:number},extra:Record<string,unknown>={})=>{const atMs=now(),elapsed=request?atMs-Number(request.created_at_ms):undefined,remaining=request?Number(request.deadline_at_ms)-atMs:undefined,record={stage:name,atMs,...(elapsed===undefined?{}:{elapsedFromRequestMs:elapsed}),...(remaining===undefined?{}:remaining>=0?{deadlineRemainingMs:remaining}:{deadlineOverrunMs:-remaining}),...extra};stages.push(record);input.onStage?.(record);};
 stage('cycle_start');const requestLeaseStarted=now();stage('request_lease_start');const expired:Array<{id:string;revision:number;created_at_ms:number;deadline_at_ms:number}>=[],request=await busy('direct_lookup_lease',()=>leaseDirectTokenLookup(input.repo,input.requestLeaseMs??15_000,now(),item=>expired.push(item)));
 if(!request){const expiredRequest=expired[0];stage('request_lease_end',expiredRequest,{leaseResult:expiredRequest?'EXPIRED_BEFORE_LEASE':'NONE',elapsedMs:now()-requestLeaseStarted,...(expiredRequest?{requestId:expiredRequest.id,requestRevision:expiredRequest.revision}: {})});stage('cycle_end',expiredRequest,{cycleElapsedMs:now()-cycleStarted});return expiredRequest?{status:'EXPIRED' as const,request:expiredRequest,stages}:{status:'IDLE' as const,stages};}
 stage('request_lease_end',request,{leaseResult:'LEASED',elapsedMs:now()-requestLeaseStarted,requestId:request.id,requestRevision:request.revision,requestAgeMs:now()-Number(request.created_at_ms)});
 const owner=`direct-lookup:${request.id}:${request.revision}`;
 const rpcLeaseStarted=now();stage('rpc_lease_start',request);const acquired=await busy('rpc_read_lease_acquire',()=>acquireRpcReadLease(input.repo,owner,input.rpcLeaseMs??15_000,now())),holder=acquired?undefined:input.repo.db.prepare("SELECT owner_id,leased_until_ms FROM rpc_read_work_lease WHERE lease_key='alchemy-read-budget'").get() as {owner_id:string;leased_until_ms:number}|undefined;stage('rpc_lease_end',request,{acquired,elapsedMs:now()-rpcLeaseStarted,...(holder?{holderOwnerId:holder.owner_id,holderLeasedUntilMs:holder.leased_until_ms}:{})});
 if(!acquired){await busy('direct_lookup_lease_release',()=>releaseDirectTokenLookupLease(input.repo,request,now()));stage('cycle_end',request,{status:'RPC_LEASE_BUSY',cycleElapsedMs:now()-cycleStarted});return {status:'RPC_LEASE_BUSY' as const,request,stages};}
 let rpcLeaseHeld=true;
 const release=async()=>{if(!rpcLeaseHeld)return;await busy('rpc_read_lease_release',()=>releaseRpcReadLease(input.repo,owner,now()));rpcLeaseHeld=false;};
 try{
  const executeStarted=now();stage('execute_start',request);const result=await executeDirectTokenLookup({repo:input.repo,rpc:input.rpc,request,candidateBudget:input.candidateBudget,maxRpcBatches:input.maxRpcBatches,ethCallBudget:input.ethCallBudget,now,afterRpc:release,onStage:(name,extra)=>stage(name,request,extra)});stage('execute_end',request,{executeElapsedMs:now()-executeStarted});
  stage('cycle_end',request,{status:'COMPLETED',cycleElapsedMs:now()-cycleStarted});return {status:'COMPLETED' as const,request,result,stages};
 }finally{await release();}
}

async function main(){
 assertFuniCredentialIsolation(process.env);
 delete process.env.LP_PRIVATE_KEY;delete process.env.LP_MNEMONIC;delete process.env.SEED_PHRASE;delete process.env.MNEMONIC;
 process.env.EXECUTION_ENABLED='false';process.env.DRY_RUN='true';process.env.EMERGENCY_PAUSE='true';process.env.LIVE_CANARY_ENABLED='false';process.env.V4_LIVE_CANARY_ENABLED='false';
 if(!process.env.ALCHEMY_RPC_URLS&&!process.env.ALCHEMY_RPC_URL)throw new Error('ALCHEMY_RPC_URL_REQUIRED');
 const integer=(name:string,fallback:number,min:number,max:number)=>{const value=Number(process.env[name]??fallback);return Number.isSafeInteger(value)&&value>=min&&value<=max?value:fallback;};
 const paths=productionDatabasePaths({dataDir:process.env.DATA_DIR,databasePath:process.env.DATABASE_PATH}),urls=orderedRpcUrls(process.env.ALCHEMY_RPC_URLS,process.env.ALCHEMY_RPC_URL),loopMs=integer('DIRECT_LOOKUP_WORKER_IDLE_MS',750,250,10_000),candidateBudget=integer('DIRECT_LOOKUP_CANDIDATE_BUDGET',12,1,12),maxRpcBatches=integer('DIRECT_LOOKUP_MAX_RPC_BATCHES',1,1,2),ethCallBudget=integer('DIRECT_LOOKUP_ETH_CALL_BUDGET',24,2,24),rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:urls},urls,{timeoutMs:integer('STATE_CACHE_RPC_TIMEOUT_MS',2_000,250,15_000)});
 migrateSqlite(paths.databasePath,'infra/migrations',{busyTimeoutMs:SQLITE_RUNTIME_BUSY_TIMEOUT_MS});
 let stopping=false,idleProven=false,currentOperation='startup';
 process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
 const emit=(event:string,data:Record<string,unknown>={})=>process.stdout.write(JSON.stringify({event,process:'funi-v4-direct-lookup-worker',...data,at:new Date().toISOString()},(_,value)=>typeof value==='bigint'?value.toString():value)+'\n');
 const busy:BusyRunner=async(operation,work)=>{const priority=await waitForEconomicForegroundDemandToClear({databasePath:paths.databasePath,component:'funi-v4-direct-lookup-worker',operation,maxWaitMs:500,onTelemetry:event=>emit('sqlite_write_window',event)});if(!priority.cleared)throw new EconomicForegroundDemandActiveError(paths.databasePath);const started=Date.now();let failure:unknown;for(let attempt=0;attempt<3;attempt++)try{const windowStarted=Date.now(),value=work();emit('sqlite_write_window',{component:'funi-v4-direct-lookup-worker',operation,persistenceClass:'background',economicDemandPresent:priority.demandPresent,waitYieldDurationMs:priority.waitedMs,writerWindowDurationMs:Date.now()-windowStarted,rowChangeCount:value&&typeof value==='object'&&typeof (value as {changes?:unknown}).changes==='number'?Number((value as unknown as {changes:number}).changes):null,retryCount:attempt,outcome:'SUCCEEDED'});return value;}catch(error){failure=error;if(!/SQLITE_BUSY|database is locked/i.test(error instanceof Error?error.message:String(error)))throw error;const wait=50*2**attempt+Math.floor(Math.random()*50);emit('sqlite_busy_retry',{operation,attempt:attempt+1,waitMs:wait});await sleep(wait);}emit('sqlite_busy_terminal',{operation,dbWaitMs:Date.now()-started,error:failure instanceof Error?failure.message:String(failure)});throw failure;};
 emit('direct_lookup_worker_started',{databasePath:paths.databasePath,pollMs:loopMs,candidateBudget,maxRpcBatches,ethCallBudget,requestDeadlineMs:15_000,executionEnabled:false,signerConstructed:false,mainnetTransactionsSent:0});
 const repo=new SqliteLedgerRepository(paths.databasePath,{busyTimeoutMs:SQLITE_RUNTIME_BUSY_TIMEOUT_MS});
 while(!stopping){
  const started=Date.now();let sleepAfterCycle=true;
  try{
   currentOperation='direct_lookup';const cycle=await runDedicatedDirectLookupCycle({repo,rpc,candidateBudget,maxRpcBatches,ethCallBudget,busy});
   if(cycle.status==='IDLE'){if(!idleProven){emit('direct_lookup_worker_idle',{dbOpen:true,rpcLeaseHeld:false,mainnetTransactionsSent:0});idleProven=true;}}
   else if(cycle.status==='EXPIRED')emit('direct_lookup_stage_summary',{requestId:cycle.request.id,requestRevision:cycle.request.revision,stages:cycle.stages,mainnetTransactionsSent:0});
   else if(cycle.status==='RPC_LEASE_BUSY'){emit('rpc_cycle_deferred',{interaction:'direct-token-lookup',requestId:cycle.request.id,requestRevision:cycle.request.revision,overlapPrevented:true,ethCallCount:0,mainnetTransactionsSent:0});emit('direct_lookup_stage_summary',{requestId:cycle.request.id,requestRevision:cycle.request.revision,stages:cycle.stages,mainnetTransactionsSent:0});}
   else{const completed=repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=?').get(cycle.request.id) as Record<string,unknown>|undefined,metrics=JSON.parse(String(completed?.rpc_attribution_json??'{}'));emit('rpc_cycle_telemetry',{interaction:'direct-token-lookup',interactionId:cycle.request.interaction_id??null,requestId:cycle.request.id,requestRevision:cycle.request.revision,token:cycle.request.token_address,cacheHit:false,deduplicated:false,candidatePoolCount:completed?.candidate_pool_count??0,hydratedPoolCount:completed?.hydrated_pool_count??0,eligiblePoolCount:completed?.eligible_pool_count??0,queueJobsCreated:0,jobsLeased:1,jobsCompleted:cycle.result.completed?1:0,jobsSkippedFresh:0,rpcCallCount:metrics.rpcCallCount??0,ethCallCount:metrics.ethCallCount??0,eth_blockNumberCount:metrics.eth_blockNumberCount??0,getLogsCount:metrics.getLogsCount??0,multicallCount:metrics.multicallCount??0,multicallMembers:metrics.multicallMembers??0,provider:metrics.provider??'none',elapsedMs:Date.now()-started,overlapPrevented:true,rpcLeaseHeld:false,terminalStatus:completed?.status,mainnetTransactionsSent:0});emit('direct_lookup_stage_summary',{requestId:cycle.request.id,requestRevision:cycle.request.revision,stages:cycle.stages,mainnetTransactionsSent:0});}
   sleepAfterCycle=cycle.status==='IDLE'||cycle.status==='RPC_LEASE_BUSY';
   currentOperation='idle';
  }catch(error){const reason=error instanceof Error?error.message:String(error);emit('direct_lookup_cycle_error',{operation:currentOperation,error:reason,mainnetTransactionsSent:0});}
  if(!stopping&&sleepAfterCycle)await sleep(loopMs);
 }
 repo.close();
 emit('direct_lookup_worker_stopped',{mainnetTransactionsSent:0});
}

if(process.env.pm_id!==undefined||(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href))void main().catch(error=>{process.stderr.write(JSON.stringify({event:'direct_lookup_worker_fatal',error:error instanceof Error?error.message:String(error),mainnetTransactionsSent:0})+'\n');process.exitCode=1;});
