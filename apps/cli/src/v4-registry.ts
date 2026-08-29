import { getAddress, type Address } from 'viem';
import { inspectErc20, priceFromSqrtX96, robinhoodMainnet, type FallbackRpc } from '@funi/core';
import type { SqliteLedgerRepository } from '@funi/ledger';
import { trustedV4PoolUsdMetric } from './v4-liquidity-display.js';
import {
  auditRobinhoodV4Deployments, buildGenericV4SingleSidedDownsidePlan, classifyV4Hooks, decodeV4Fee,
  inspectV4Pool, poolId, readV4InitializeEvents, v4ExecutionBlockers, V4_MAX_EXECUTION_STATIC_FEE_PIPS, V4_ROBINHOOD_DEPLOYMENTS, v4StateViewAbi, type V4InitializeEvent, type V4PoolKey,
} from '@funi/v4';

export const V4_REGISTRY_CHAIN_ID=4663;
export const DEFAULT_V4_REGISTRY_WINDOW=50_000;
export const DEFAULT_V4_REGISTRY_OVERLAP=12;
export const DEFAULT_V4_CONFIRMATIONS=2;
export type V4RegistryReader=(fromBlock:bigint,toBlock:bigint)=>Promise<V4InitializeEvent[]>;
export type V4Valuation={status:'available';estimatedTvlUsd:number;provenance:string}|{status:'unavailable';reason:string;provenance:string};
export type V4Candidate={
 protocolVersion:'v4';poolId:string;key:V4PoolKey;target:{address:Address;symbol:string;decimals:number};funding:{address:Address;symbol:string;decimals:number};
 targetIndex:0|1;fundingIndex:0|1;priceFundingPerTarget:number|null;priceProvenance:string;liquidity:bigint;feeLabel:string;tickSpacing:number;
 trustedTvlUsd:number|null;
 feeSemantics:ReturnType<typeof decodeV4Fee>;hookStatus:ReturnType<typeof classifyV4Hooks>;valuation:V4Valuation;refreshBlock:bigint;
 executionEligible:boolean;blockers:string[];initializationBlock:bigint;
 uiState?:'CHECKING'|'TEMPORARILY_UNAVAILABLE'|'EVIDENCE_UNAVAILABLE'|'EXECUTABLE'|'SUPPORTED_NO_ACTIVE_LIQUIDITY'|`UNSUPPORTED:${string}`;
 uiReason?:string|null;
 cacheAgeMs?:number|null;
};

const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function mapConcurrent<T,U>(items:readonly T[],limit:number,work:(item:T)=>Promise<U>){
 const results=new Array<U>(items.length),next={value:0};
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  for(;;){const index=next.value++;if(index>=items.length)return;results[index]=await work(items[index]!);}
 }));
 return results;
}
function eventRecord(event:V4InitializeEvent){
 const fee=decodeV4Fee(event.initializeFeeRaw),hooks=classifyV4Hooks(event.key.hooks);
 return {poolId:event.id,currency0:event.key.currency0,currency1:event.key.currency1,initializeFeeRaw:event.initializeFeeRaw,tickSpacing:event.key.tickSpacing,hooks:event.key.hooks,initializationBlock:event.blockNumber,initializationTxHash:event.transactionHash,initializationTxIndex:event.transactionIndex,initializationLogIndex:event.logIndex,dynamicFee:fee.dynamicFee,staticFeePips:fee.staticFeePips,hookClassification:hooks.classification};
}
async function defaultReader(rpc:FallbackRpc,from:bigint,to:bigint){
 let failure:unknown;
 for(let attempt=0;attempt<4;attempt++){
  const result=await readV4InitializeEvents(rpc,from,to);
  if(result.status==='available')return result.value;
  failure=new Error(result.reason);
  if(attempt<3)await sleep(150*2**attempt);
 }
 throw failure;
}

/** Restart-safe incremental sync. The overlap is applied once per run and each RPC request is bounded. */
export async function syncV4PoolRegistry(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;toBlock?:bigint;confirmations?:number;reader?:V4RegistryReader;onEvent?:(name:string,data:Record<string,unknown>)=>void}){
 const started=Date.now(),fallbackBefore=input.rpc.metrics?.fallbackUses??0,cursor=input.repo.v4RegistryCursor();
 if(!cursor)throw new Error('V4_REGISTRY_CURSOR_NOT_INITIALIZED: run v4-pool-registry-bootstrap with explicit bounds');
 const latest=input.toBlock??await input.rpc.withClient(c=>c.getBlockNumber()),confirmations=BigInt(input.confirmations??DEFAULT_V4_CONFIRMATIONS),target=latest>confirmations?latest-confirmations:0n,next=BigInt(String(cursor.next_block)),overlap=BigInt(Number(cursor.overlap_blocks)),window=BigInt(Number(cursor.window_size));
 let from=next>overlap?next-overlap:0n,inserted=0,updated=0,windows=0;
 input.repo.startV4RegistrySync(latest);input.onEvent?.('v4_registry_sync_start',{cursor:next.toString(),fromBlock:from.toString(),targetBlock:target.toString(),windowSize:window.toString()});
 try{
  while(from<=target){
   const to=from+window-1n<target?from+window-1n:target;input.onEvent?.('v4_registry_window',{fromBlock:from.toString(),toBlock:to.toString()});
   const events=await (input.reader?input.reader(from,to):defaultReader(input.rpc,from,to));
   // Each pool upsert is independently atomic and the cursor advances only after
   // the whole window succeeds. A crash therefore replays the idempotent window
   // without holding SQLite's single WAL writer for the entire event batch.
   for(const event of events){const existed=!!input.repo.v4RegistryPool(event.id);input.repo.upsertV4RegistryPool(eventRecord(event));existed?updated++:inserted++;}
   input.repo.advanceV4RegistryCursor(to+1n);windows++;from=to+1n;
  }
  const fallbackUses=(input.rpc.metrics?.fallbackUses??fallbackBefore)-fallbackBefore;input.repo.finishV4RegistrySync({durationMs:Date.now()-started,fallbackUses});input.onEvent?.('v4_registry_sync_end',{windows,inserted,updated,durationMs:Date.now()-started,rpcProvider:fallbackUses?'fallback_used':'primary',fallbackUses});
  return {chainId:V4_REGISTRY_CHAIN_ID,fromBlock:(next>overlap?next-overlap:0n),toBlock:target,nextBlock:target+1n,windows,inserted,updated,durationMs:Date.now()-started,fallbackUses,mainnetTransactionsSent:0};
 }catch(error){const fallbackUses=(input.rpc.metrics?.fallbackUses??fallbackBefore)-fallbackBefore;input.repo.finishV4RegistrySync({durationMs:Date.now()-started,error:errorText(error),fallbackUses});input.onEvent?.('v4_registry_sync_end',{error:errorText(error),durationMs:Date.now()-started,fallbackUses});throw error;}
}

/** Explicit one-time bootstrap. Both bounds are mandatory; startup never calls this. */
export async function bootstrapV4PoolRegistry(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;fromBlock:bigint;toBlock:bigint;windowSize?:number;overlapBlocks?:number;reader?:V4RegistryReader;onEvent?:(name:string,data:Record<string,unknown>)=>void}){
 if(input.fromBlock<0n||input.toBlock<input.fromBlock)throw new Error('V4_BOOTSTRAP_EXPLICIT_BOUNDS_REQUIRED');
 if(input.repo.v4RegistryCursor())throw new Error('V4_REGISTRY_ALREADY_BOOTSTRAPPED');
 const window=input.windowSize??DEFAULT_V4_REGISTRY_WINDOW,overlap=input.overlapBlocks??DEFAULT_V4_REGISTRY_OVERLAP;
 if(!Number.isSafeInteger(window)||window<1||window>1_000_000||!Number.isSafeInteger(overlap)||overlap<0||overlap>=window)throw new Error('V4_REGISTRY_WINDOW_CONFIGURATION_INVALID');
 input.repo.initializeV4RegistryCursor({nextBlock:input.fromBlock,overlapBlocks:overlap,windowSize:window});
 return syncV4PoolRegistry({...input,toBlock:input.toBlock,confirmations:0});
}

function rowKey(row:Record<string,unknown>):V4PoolKey{return {currency0:getAddress(String(row.currency0)),currency1:getAddress(String(row.currency1)),fee:Number(row.initialize_fee_raw),tickSpacing:Number(row.tick_spacing),hooks:getAddress(String(row.hooks))};}
export async function refreshV4RegistryPool(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;poolId:string;deploymentVerified?:boolean}){
 const row=input.repo.v4RegistryPool(input.poolId);if(!row)throw new Error('V4_POOL_NOT_REGISTERED');const key=rowKey(row);
 if(poolId(key).toLowerCase()!==input.poolId.toLowerCase())throw new Error('V4_REGISTRY_POOL_KEY_MISMATCH');
 const state=await inspectV4Pool(input.rpc,key);if(state.status==='unavailable')throw new Error(`V4_STATEVIEW_UNAVAILABLE:${state.reason}`);
 const blockers=v4ExecutionBlockers(state.value);
 if(input.deploymentVerified===false)blockers.push('DEPLOYMENT_AUDIT_FAILED');
 input.repo.refreshV4RegistryPool({poolId:input.poolId,sqrtPriceX96:state.value.sqrtPriceX96,tick:state.value.tick,liquidity:state.value.liquidity,protocolFee:state.value.protocolFee!,lpFeePips:state.value.lpFee!,initialized:state.value.initialized,refreshBlock:state.value.blockNumber,validationStatus:blockers.length?'BLOCKED':'ELIGIBLE',blockers});
 return state.value;
}
/** One bounded Alchemy multicall batch. Individual fallback is deliberately left to failed members only. */
export type V4RegistryPoolBatchPlan={rows:Array<{id:string;key:V4PoolKey}>};
export type V4RegistryPoolBatchFetch={states:Array<{id:string;state:{key:V4PoolKey;id:`0x${string}`;sqrtPriceX96:bigint;tick:number;protocolFee:number;lpFee:number;liquidity:bigint;initialized:boolean;blockNumber:bigint}}>;failed:string[];multicallPoolCount:number};
export function planV4RegistryPoolBatch(input:{repo:SqliteLedgerRepository;poolIds:string[]}):V4RegistryPoolBatchPlan{
 const rows=input.poolIds.map(id=>input.repo.v4RegistryPool(id)).filter((x):x is Record<string,unknown>=>Boolean(x)),keys=rows.map(rowKey),ids=rows.map(row=>String(row.pool_id));
 return {rows:ids.map((id,index)=>({id,key:keys[index]!}))};
}
export async function fetchV4RegistryPoolBatch(input:{rpc:FallbackRpc;plan:V4RegistryPoolBatchPlan}):Promise<V4RegistryPoolBatchFetch>{
 if(!input.plan.rows.length)return {states:[],failed:[],multicallPoolCount:0};
 const response=await input.rpc.withClient(async client=>({block:await client.getBlockNumber(),results:await client.multicall({multicallAddress:'0xca11bde05977b3631167028862be2a173976ca11',allowFailure:true,contracts:input.plan.rows.flatMap(({key})=>[{address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:v4StateViewAbi,functionName:'getSlot0',args:[poolId(key)]},{address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:v4StateViewAbi,functionName:'getLiquidity',args:[poolId(key)]}])})}));
 const states:V4RegistryPoolBatchFetch['states']=[],failed:string[]=[];
 for(let i=0;i<input.plan.rows.length;i++){const slot=response.results[i*2],liquidity=response.results[i*2+1],planned=input.plan.rows[i]!;if(slot?.status!=='success'||liquidity?.status!=='success'){failed.push(planned.id);continue;}const value=slot.result as readonly [bigint,bigint,bigint,bigint];states.push({id:planned.id,state:{key:planned.key,id:poolId(planned.key),sqrtPriceX96:value[0],tick:Number(value[1]),protocolFee:Number(value[2]),lpFee:Number(value[3]),liquidity:liquidity.result as bigint,initialized:value[0]!==0n,blockNumber:response.block}});}
 return {states,failed,multicallPoolCount:input.plan.rows.length};
}
export function persistV4RegistryPoolBatch(input:{repo:SqliteLedgerRepository;result:V4RegistryPoolBatchFetch}){
 const refreshed:string[]=[];for(const item of input.result.states){const state=item.state,blockers=v4ExecutionBlockers(state);input.repo.refreshV4RegistryPool({poolId:item.id,sqrtPriceX96:state.sqrtPriceX96,tick:state.tick,liquidity:state.liquidity,protocolFee:state.protocolFee,lpFeePips:state.lpFee,initialized:state.initialized,refreshBlock:state.blockNumber,validationStatus:blockers.length?'BLOCKED':'ELIGIBLE',blockers});refreshed.push(item.id);}
 return {refreshed,failed:input.result.failed,multicallPoolCount:input.result.multicallPoolCount};
}
export async function refreshV4RegistryPoolBatch(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;poolIds:string[]}){
 const plan=planV4RegistryPoolBatch(input),result=await fetchV4RegistryPoolBatch({rpc:input.rpc,plan});return persistV4RegistryPoolBatch({repo:input.repo,result});
}
function feeLabel(fee:ReturnType<typeof decodeV4Fee>){return fee.dynamicFee?'dynamic fee':fee.displayedFeePercent===null?'unknown fee':`${fee.displayedFeePercent.toFixed(4).replace(/0+$/,'').replace(/\.$/,'')}%`;}

/** Direct registry lookup + StateView refresh. It never reads PoolManager logs. */
export async function v4PoolsForToken(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;token:Address;fundingAssets?:Address[];auditDeployment?:boolean;onEvent?:(name:string,data:Record<string,unknown>)=>void}){
 const started=Date.now(),targetAddress=getAddress(input.token),fundingAssets=(input.fundingAssets??[robinhoodMainnet.assets.USDG,robinhoodMainnet.assets.WETH]).filter(x=>x.toLowerCase()!==targetAddress.toLowerCase()),rows=input.repo.v4RegistryPoolsForToken(targetAddress,fundingAssets);
 const deployment=input.auditDeployment===false?{status:'available' as const}:await auditRobinhoodV4Deployments(input.rpc),deploymentVerified=deployment.status==='available';
 const target=await inspectErc20(input.rpc,targetAddress);if(target.status==='unavailable')return {status:'unavailable' as const,reason:`TARGET_TOKEN_INVALID:${target.reason}`,candidates:[]};
 const fundingMetadata=new Map<string,ReturnType<typeof inspectErc20>>();
 const inspected=await mapConcurrent<Record<string,unknown>,V4Candidate|null>(rows,6,async row=>{
  const key=rowKey(row),fundingAddress=getAddress(key.currency0.toLowerCase()===targetAddress.toLowerCase()?key.currency1:key.currency0),fundingKey=fundingAddress.toLowerCase();
  let fundingPromise=fundingMetadata.get(fundingKey);if(!fundingPromise){fundingPromise=inspectErc20(input.rpc,fundingAddress);fundingMetadata.set(fundingKey,fundingPromise);}
  const funding=await fundingPromise,extra:string[]=[];
  if(funding.status==='unavailable'){input.onEvent?.('v4_candidate_filtered',{poolId:String(row.pool_id),reason:'FUNDING_TOKEN_INVALID'});return null;}
  const refreshStarted=Date.now();let state;try{state=await refreshV4RegistryPool({repo:input.repo,rpc:input.rpc,poolId:String(row.pool_id),deploymentVerified});input.onEvent?.('v4_stateview_refresh',{poolId:String(row.pool_id),latencyMs:Date.now()-refreshStarted});}catch(error){input.onEvent?.('v4_candidate_filtered',{poolId:String(row.pool_id),reason:errorText(error)});return null;}
  const targetIndex=(key.currency0.toLowerCase()===targetAddress.toLowerCase()?0:1) as 0|1,fundingIndex=(targetIndex===0?1:0) as 0|1,fee=state.feeSemantics??decodeV4Fee(key.fee,state.lpFee,state.protocolFee),hooks=state.hookSemantics??classifyV4Hooks(key.hooks);
  let price:number|null=null,priceProvenance='unavailable';
  try{const onePerZero=priceFromSqrtX96(state.sqrtPriceX96,targetIndex===0?target.value.decimals:funding.value.decimals,targetIndex===0?funding.value.decimals:target.value.decimals);price=targetIndex===0?onePerZero:1/onePerZero;if(!Number.isFinite(price)||price<=0){price=null;extra.push('IMPLAUSIBLE_OR_UNVERIFIABLE_PRICE');}else priceProvenance='StateView.sqrtPriceX96 + verified ERC20 decimals';}catch{extra.push('IMPLAUSIBLE_OR_UNVERIFIABLE_PRICE');}
  const valuation:V4Valuation={status:'unavailable',reason:'active liquidity is not TVL; complete initialized-tick/position inventory is unavailable',provenance:'StateView active liquidity only'};
  const blockers=[...v4ExecutionBlockers(state),...extra];if(!deploymentVerified)blockers.push('DEPLOYMENT_AUDIT_FAILED');
  try{buildGenericV4SingleSidedDownsidePlan({pool:state,target:targetAddress,funding:fundingAddress,fundingAmount:10n**BigInt(funding.value.decimals),owner:'0x0000000000000000000000000000000000000001',deadline:1n,range:{upperDropPct:0,lowerDropPct:10}});}catch(error){const reason=errorText(error);if(!reason.startsWith('V4_POOL_EXECUTION_BLOCKED'))blockers.push('SINGLE_SIDED_PLAN_UNAVAILABLE');}
  return {protocolVersion:'v4' as const,poolId:String(row.pool_id),key,target:target.value,funding:funding.value,targetIndex,fundingIndex,priceFundingPerTarget:price,priceProvenance,liquidity:state.liquidity,feeLabel:feeLabel(fee),tickSpacing:key.tickSpacing,trustedTvlUsd:trustedV4PoolUsdMetric(row).usd,feeSemantics:fee,hookStatus:hooks,valuation,refreshBlock:state.blockNumber,executionEligible:blockers.length===0,blockers:[...new Set(blockers)],initializationBlock:BigInt(String(row.initialization_block))};
 });
 const candidates=inspected.filter((candidate):candidate is V4Candidate=>candidate!==null);
 const ranked=rankV4Candidates(candidates);input.onEvent?.('v4_registry_lookup',{token:targetAddress,registered:rows.length,candidates:ranked.length,eligible:ranked.filter(x=>x.executionEligible).length,latencyMs:Date.now()-started});
 return {status:'available' as const,token:target.value,candidates:ranked,lookupLatencyMs:Date.now()-started,provenance:'durable v4 registry + bounded StateView refresh',mainnetTransactionsSent:0};
}

/** Eligibility first; trusted fresh pool TVL ranks only within that class, then PoolId remains deterministic. */
export function rankV4Candidates(candidates:V4Candidate[]){
 return [...candidates].sort((a,b)=>Number(b.executionEligible)-Number(a.executionEligible)||Number(b.trustedTvlUsd!==null)-Number(a.trustedTvlUsd!==null)||((b.trustedTvlUsd??0)-(a.trustedTvlUsd??0))||a.poolId.localeCompare(b.poolId));
}

/** Indexed, persisted-state-only lookup for interactive paths. Never performs RPC. */
export function cachedV4PoolsForToken(input:{repo:SqliteLedgerRepository;token:Address;fundingAssets?:Address[];now?:number}){
 const started=Date.now(),targetAddress=getAddress(input.token),fundingAssets=(input.fundingAssets??[robinhoodMainnet.assets.USDG,robinhoodMainnet.assets.WETH]).filter(x=>x.toLowerCase()!==targetAddress.toLowerCase()),rows=input.repo.v4RegistryPoolsForToken(targetAddress,fundingAssets),now=input.now??Date.now();
 const targetRow=input.repo.tokenMetadata(targetAddress),target={address:targetAddress,symbol:String(targetRow?.symbol??`${targetAddress.slice(0,6)}…`),name:String(targetRow?.name??'Cached token'),decimals:Number(targetRow?.decimals??18),canonical:false};
 const candidates:V4Candidate[]=rows.map(row=>{
  const key=rowKey(row),targetIndex=(key.currency0.toLowerCase()===targetAddress.toLowerCase()?0:1) as 0|1,fundingIndex=(targetIndex===0?1:0) as 0|1,fundingAddress=getAddress(targetIndex===0?key.currency1:key.currency0),fundingRow=input.repo.tokenMetadata(fundingAddress),fee=decodeV4Fee(Number(row.initialize_fee_raw),row.current_lp_fee_pips===null?undefined:Number(row.current_lp_fee_pips),row.current_protocol_fee===null?undefined:Number(row.current_protocol_fee)),hooks=classifyV4Hooks(key.hooks),persisted=JSON.parse(String(row.blockers_json??'[]')) as string[],refreshed=row.last_refreshed_at?Date.parse(String(row.last_refreshed_at)):0,cacheAgeMs=refreshed?Math.max(0,now-refreshed):null;
  const structural=[...new Set([...persisted,...fee.blockers,...hooks.blockers,...(fee.staticFeePips!==null&&fee.staticFeePips>V4_MAX_EXECUTION_STATIC_FEE_PIPS?['EXTREME_STATIC_FEE']:[])].filter(x=>x!=='ZERO_ACTIVE_LIQUIDITY'))],unsupported=[...structural.filter(x=>x==='EXTREME_STATIC_FEE'),...structural.filter(x=>x==='NONZERO_HOOK_UNSUPPORTED'),...structural.filter(x=>x==='DYNAMIC_FEE_UNSUPPORTED'),...structural.filter(x=>x!=='EXTREME_STATIC_FEE'&&x!=='NONZERO_HOOK_UNSUPPORTED'&&x!=='DYNAMIC_FEE_UNSUPPORTED')],initialized=Number(row.initialized)===1,stateFresh=cacheAgeMs!==null&&cacheAgeMs<=120_000;
  const liquidity=BigInt(String(row.active_liquidity_raw??0)),executionEligible=unsupported.length===0&&initialized&&stateFresh&&liquidity>0n,uiState:V4Candidate['uiState']=unsupported.length?`UNSUPPORTED:${unsupported[0]}`:!initialized?'TEMPORARILY_UNAVAILABLE':!stateFresh?'CHECKING':liquidity<=0n?'SUPPORTED_NO_ACTIVE_LIQUIDITY':'EXECUTABLE';
  const valuation={status:'unavailable' as const,reason:'TVL intentionally not used for active-liquidity-only listings',provenance:'not requested'};
  return {protocolVersion:'v4' as const,poolId:String(row.pool_id),key,target,funding:{address:fundingAddress,symbol:String(fundingRow?.symbol??(fundingAddress.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()?'USDG':fundingAddress.toLowerCase()===robinhoodMainnet.assets.WETH.toLowerCase()?'WETH':`${fundingAddress.slice(0,6)}…`)),name:String(fundingRow?.name??'Cached funding token'),decimals:Number(fundingRow?.decimals??(fundingAddress.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()?6:18)),canonical:true},targetIndex,fundingIndex,priceFundingPerTarget:null,priceProvenance:'persisted StateView cache',liquidity,feeLabel:feeLabel(fee),tickSpacing:key.tickSpacing,trustedTvlUsd:trustedV4PoolUsdMetric(row,now).usd,feeSemantics:fee,hookStatus:hooks,valuation,refreshBlock:BigInt(String(row.refresh_block??0)),executionEligible,blockers:unsupported,initializationBlock:BigInt(String(row.initialization_block)),cacheAgeMs,uiState};
 });
 const ages=candidates.map(x=>x.cacheAgeMs).filter((x):x is number=>x!==null),cacheAgeMs=ages.length?Math.max(...ages):null,ranked=rankV4Candidates(candidates);
 return {status:'available' as const,token:target,target,candidates:ranked,lookupLatencyMs:Date.now()-started,cacheAgeMs,provider:'local-cache',fallbackUsed:false,mainnetTransactionsSent:0};
}

export async function v4RegistryStatus(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc}){
 const local=input.repo.v4RegistryStatus(),latest=await input.rpc.withClient(c=>c.getBlockNumber()),cursor=local.cursor,next=cursor?BigInt(String(cursor.next_block)):null;
 return {...local,latestChainBlock:latest,registryLag:next===null?null:(latest>=next?latest-next+1n:0n),mainnetTransactionsSent:0};
}
