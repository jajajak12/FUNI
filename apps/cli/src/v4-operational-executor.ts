/**
 * Normal operational v4 open preflight and executor.
 *
 * This lane deliberately does not read, claim, transition, or charge gas to
 * the historical v4_live_canary singleton. It shares only the generic durable
 * intent/transition tables used to reconcile transaction receipts.
 */
import {
  decodeEventLog, encodeFunctionData, getAddress, keccak256, parseAbiItem,
  type Address, type Hash, type Hex, type TransactionReceipt, type WalletClient,
} from 'viem';
import {
  FallbackRpc, priceFromSqrtX96, robinhoodMainnet, v3PoolAbi,
} from '@robin/core';
import { SqliteLedgerRepository } from '@robin/ledger';
import {
  V4_ROBINHOOD_DEPLOYMENTS, auditRobinhoodV4Deployments,
  buildGenericV4SingleSidedDownsidePlan, inspectV4Pool, inspectV4Position,
  parseV4MintTokenId, permit2Abi, permit2Allowance, permit2ApproveAbi, poolId,
  classifyV4Hooks, decodeV4Fee, v4StateViewAbi,
  v4ExecutionBlockers, type V4DownsideRangeRequest, type V4PoolKey,
} from '@robin/v4';
import {
  evaluateV4OperationalGates, type GenericV4OpenSelection,
  type V4OperationalExecutionResult, type V4OperationalGate,
  type V4OperationalPoolSnapshot,
} from './v4-operational-open.js';
import { markOperationalPositionOpenConfirming } from './active-position-reconciliation.js';
import { botManagedExposureGate, botManagedProjectedExposure, type BotManagedExposureResult } from './bot-managed-exposure.js';
import { broadcastSignedTransaction, rebalanceExactHashEvidence, signWithConfiguredAccount } from './rebalance-transaction.js';

export type { GenericV4OpenSelection } from './v4-operational-open.js';

const erc20Abi=[
  {type:'function',name:'balanceOf',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]},
  {type:'function',name:'allowance',stateMutability:'view',inputs:[{type:'address'},{type:'address'}],outputs:[{type:'uint256'}]},
  {type:'function',name:'approve',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'uint256'}],outputs:[{type:'bool'}]},
] as const;
const transferEvent=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const activeOperationalIntents=new Set<string>();
type V4DeploymentAudit=Awaited<ReturnType<typeof auditRobinhoodV4Deployments>>;
const v4DeploymentAuditCache=new WeakMap<object,{expiresAt:number;promise:Promise<V4DeploymentAudit>}>();
const operationalStaticCache=new WeakMap<object,{expiresAt:number;promise:Promise<V4OperationalStaticVerification>}>();
const canonicalPriceCache=new WeakMap<object,{expiresAt:number;value:V4OperationalNativeUsd}>();
export const V4_CANONICAL_NATIVE_USD_POOL=getAddress(process.env.V4_CANONICAL_NATIVE_USD_POOL??'0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca');
const V3_FACTORY=getAddress('0x1f7d7550b1b028f7571e69a784071f0205fd2efa');
const MULTICALL3=getAddress('0xca11bde05977b3631167028862be2a173976ca11');
const staticTtlMs=()=>Math.max(60_000,Number(process.env.V4_PREVIEW_STATIC_VERIFICATION_TTL_MS??900_000));
const nativeUsdTtlMs=()=>Math.max(5_000,Number(process.env.V4_PREVIEW_NATIVE_USD_TTL_MS??60_000));
const erc20DecimalsAbi=[{type:'function',name:'decimals',stateMutability:'view',inputs:[],outputs:[{type:'uint8'}]}] as const;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const json=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
const rpcCacheKey=(rpc:FallbackRpc)=>(rpc as any).__cacheKey??rpc as object;
function cachedV4DeploymentAudit(rpc:FallbackRpc){
  const key=rpcCacheKey(rpc),now=Date.now(),cached=v4DeploymentAuditCache.get(key);if(cached&&cached.expiresAt>now)return {promise:cached.promise,cacheHit:true};
  const promise=auditRobinhoodV4Deployments(rpc);v4DeploymentAuditCache.set(key,{expiresAt:now+300_000,promise});promise.catch(()=>v4DeploymentAuditCache.delete(key));return {promise,cacheHit:false};
}
type V4OperationalStaticVerification={
 audit:V4DeploymentAudit;chainId:4663;canonicalPool:Address;
 canonical:{factory:Address;token0:Address;token1:Address;fee:number;tickSpacing:number;wethIndex:0|1};
};
export type V4OperationalNativeUsd={nativeUsd:number;nativeUsdSource:string;nativeUsdObservedAtMs:number;nativeUsdFreshUntilMs:number;blockNumber:bigint;cacheHit:boolean};
export type V4OperationalPreviewContext={
 staticVerification:V4OperationalStaticVerification;deploymentCacheHit:boolean;staticVerificationPrewarmed:boolean;
 sharedBlock:{number:bigint;timestamp:bigint};
 pool:Awaited<ReturnType<typeof inspectV4Pool>>;
 fundingBalance:bigint;nativeBalance:bigint;gasPriceWei:bigint;
 erc20Allowance:bigint;permit2Allowance:readonly [bigint,number,number];
  nativeUsd:V4OperationalNativeUsd;
  dynamicMulticallCount:1;dynamicMulticallMembers:number;duplicateReadsEliminated:string[];
  timing:{staticVerificationMs:number;sharedBlockMs:number;dynamicReadsMs:number;canonicalPricingMs:number};
};
function operationalStaticVerification(rpc:FallbackRpc){
 const key=rpcCacheKey(rpc),now=Date.now(),cached=operationalStaticCache.get(key);
 if(cached&&cached.expiresAt>now)return {promise:cached.promise,cacheHit:true};
 const deployment=cachedV4DeploymentAudit(rpc),promise=Promise.all([
  deployment.promise,
  rpc.withClient(async client=>{
   const [code,identity]=await Promise.all([
    client.getBytecode({address:V4_CANONICAL_NATIVE_USD_POOL}),
    client.multicall({multicallAddress:MULTICALL3,allowFailure:false,contracts:[
     {address:V4_CANONICAL_NATIVE_USD_POOL,abi:v3PoolAbi,functionName:'factory'},
     {address:V4_CANONICAL_NATIVE_USD_POOL,abi:v3PoolAbi,functionName:'token0'},
     {address:V4_CANONICAL_NATIVE_USD_POOL,abi:v3PoolAbi,functionName:'token1'},
     {address:V4_CANONICAL_NATIVE_USD_POOL,abi:v3PoolAbi,functionName:'fee'},
     {address:V4_CANONICAL_NATIVE_USD_POOL,abi:v3PoolAbi,functionName:'tickSpacing'},
     {address:robinhoodMainnet.assets.WETH,abi:erc20DecimalsAbi,functionName:'decimals'},
     {address:robinhoodMainnet.assets.USDG,abi:erc20DecimalsAbi,functionName:'decimals'},
    ]}),
   ]);
   if(!code||code==='0x')throw new Error('CANONICAL_WETH_USDG_POOL_BYTECODE_MISSING');
   const [factory,token0,token1,fee,tickSpacing,wethDecimals,usdgDecimals]=identity as [Address,Address,Address,number,number,number,number];
   const expectedTokens=[robinhoodMainnet.assets.WETH.toLowerCase(),robinhoodMainnet.assets.USDG.toLowerCase()].sort();
   if(factory.toLowerCase()!==V3_FACTORY.toLowerCase()
    ||[token0.toLowerCase(),token1.toLowerCase()].sort().join(':')!==expectedTokens.join(':')
    ||Number(fee)<=0||Number(tickSpacing)<=0||Number(wethDecimals)!==18||Number(usdgDecimals)!==6)
    throw new Error('CANONICAL_WETH_USDG_POOL_IDENTITY_MISMATCH');
   return {factory:getAddress(factory),token0:getAddress(token0),token1:getAddress(token1),fee:Number(fee),tickSpacing:Number(tickSpacing),wethIndex:(token0.toLowerCase()===robinhoodMainnet.assets.WETH.toLowerCase()?0:1) as 0|1};
  }),
 ]).then(([audit,canonical])=>{
  if(audit.status==='unavailable')throw new Error(audit.reason);
  return {audit,chainId:4663 as const,canonicalPool:V4_CANONICAL_NATIVE_USD_POOL,canonical};
 });
 operationalStaticCache.set(key,{expiresAt:now+staticTtlMs(),promise});
 promise.catch(()=>operationalStaticCache.delete(key));
 return {promise,cacheHit:false};
}
export async function prewarmV4OperationalPreviewStaticVerification(rpc:FallbackRpc){
 return operationalStaticVerification(rpc).promise;
}
const requiredMulticall=<T>(value:any,index:number,name:string):T=>{
 const item=value[index];if(item&&typeof item==='object'&&'status' in item){if(item.status!=='success')throw new Error(`V4_PREVIEW_MULTICALL_FAILED:${name}`);return item.result as T;}return item as T;
};
export async function prepareV4OperationalPreviewContext(input:{rpc:FallbackRpc;wallet:Address;selection:GenericV4OpenSelection;staticVerificationPrewarmed?:boolean}):Promise<V4OperationalPreviewContext>{
 const staticStarted=Date.now(),staticEntry=operationalStaticVerification(input.rpc),staticVerification=await staticEntry.promise,staticVerificationMs=Date.now()-staticStarted,key=rpcCacheKey(input.rpc);
 const selectedKey={...input.selection.key,currency0:getAddress(input.selection.key.currency0),currency1:getAddress(input.selection.key.currency1),hooks:getAddress(input.selection.key.hooks)} as V4PoolKey;
 const cachedPrice=canonicalPriceCache.get(key),priceCacheHit=Boolean(cachedPrice&&cachedPrice.expiresAt>Date.now());
 return input.rpc.withClient(async client=>{
  const blockStarted=Date.now(),[block,gasPriceWei]=await Promise.all([client.getBlock({blockTag:'latest'}),client.getGasPrice()]),sharedBlockMs=Date.now()-blockStarted;
  const id=poolId(selectedKey),contracts:any[]=[
   {address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:v4StateViewAbi,functionName:'getSlot0',args:[id]},
   {address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:v4StateViewAbi,functionName:'getLiquidity',args:[id]},
   {address:getAddress(input.selection.funding),abi:erc20Abi,functionName:'balanceOf',args:[input.wallet]},
   {address:getAddress(input.selection.funding),abi:erc20Abi,functionName:'allowance',args:[input.wallet,V4_ROBINHOOD_DEPLOYMENTS.permit2]},
   {address:V4_ROBINHOOD_DEPLOYMENTS.permit2,abi:permit2Abi,functionName:'allowance',args:[input.wallet,getAddress(input.selection.funding),V4_ROBINHOOD_DEPLOYMENTS.positionManager]},
  ];
  if(!priceCacheHit)contracts.push(
   {address:V4_CANONICAL_NATIVE_USD_POOL,abi:v3PoolAbi,functionName:'slot0'},
   {address:V4_CANONICAL_NATIVE_USD_POOL,abi:v3PoolAbi,functionName:'liquidity'},
  );
  const dynamicStarted=Date.now(),[values,nativeBalance]=await Promise.all([
   client.multicall({multicallAddress:MULTICALL3,allowFailure:false,blockNumber:block.number,contracts}),
   client.getBalance({address:input.wallet,blockNumber:block.number}),
  ]),dynamicReadsMs=Date.now()-dynamicStarted;
  const slot=requiredMulticall<readonly [bigint,number,number,number]>(values,0,'selectedPool.slot0'),liquidity=requiredMulticall<bigint>(values,1,'selectedPool.liquidity');
  const protocolFee=Number(slot[2]),lpFee=Number(slot[3]),pool={status:'available' as const,value:{id,key:selectedKey,sqrtPriceX96:slot[0],tick:Number(slot[1]),liquidity,initialized:slot[0]!==0n,blockNumber:block.number,protocolFee,lpFee,feeSemantics:decodeV4Fee(selectedKey.fee,lpFee,protocolFee),hookSemantics:classifyV4Hooks(selectedKey.hooks)},provenance:{provider:'shared-block v4 preview multicall',observedAt:new Date().toISOString(),blockNumber:block.number,confidence:'verified' as const}};
  let nativeUsd:V4OperationalNativeUsd;
  if(priceCacheHit)nativeUsd={...cachedPrice!.value,cacheHit:true};
  else{
   const canonicalSlot=requiredMulticall<readonly [bigint,number,number,number,number,number,boolean]>(values,5,'canonical.slot0'),canonicalLiquidity=requiredMulticall<bigint>(values,6,'canonical.liquidity');
   if(canonicalSlot[0]===0n||canonicalLiquidity<=0n)throw new Error('CANONICAL_WETH_USDG_PRICE_UNAVAILABLE');
   const ratio=priceFromSqrtX96(canonicalSlot[0],staticVerification.canonical.token0.toLowerCase()===robinhoodMainnet.assets.WETH.toLowerCase()?18:6,staticVerification.canonical.token1.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()?6:18);
   const value=staticVerification.canonical.wethIndex===0?ratio:1/ratio,observedAtMs=Number(block.timestamp)*1000,age=Date.now()-observedAtMs;
   if(!Number.isFinite(value)||value<=0)throw new Error('CANONICAL_WETH_USDG_PRICE_INVALID');
   if(age<0||age>120_000)throw new Error('CANONICAL_WETH_USDG_PRICE_STALE');
   nativeUsd={nativeUsd:value,nativeUsdSource:`Uniswap v3 WETH/USDG ${V4_CANONICAL_NATIVE_USD_POOL}`,nativeUsdObservedAtMs:observedAtMs,nativeUsdFreshUntilMs:observedAtMs+120_000,blockNumber:block.number,cacheHit:false};
   canonicalPriceCache.set(key,{expiresAt:Date.now()+nativeUsdTtlMs(),value:nativeUsd});
  }
  return {staticVerification,deploymentCacheHit:staticEntry.cacheHit,staticVerificationPrewarmed:Boolean(input.staticVerificationPrewarmed),sharedBlock:{number:block.number,timestamp:block.timestamp},pool,fundingBalance:requiredMulticall<bigint>(values,2,'funding.balance'),nativeBalance,gasPriceWei,erc20Allowance:requiredMulticall<bigint>(values,3,'funding.allowance'),permit2Allowance:requiredMulticall<readonly [bigint,number,number]>(values,4,'permit2.allowance'),nativeUsd,dynamicMulticallCount:1 as const,dynamicMulticallMembers:contracts.length,duplicateReadsEliminated:['v3 fee-tier discovery','four unrelated v3 pool inspections','duplicate WETH/USDG pricing','selected pool block-number read','balance read','ERC20 allowance read','Permit2 allowance read'],timing:{staticVerificationMs,sharedBlockMs,dynamicReadsMs,canonicalPricingMs:priceCacheHit?0:dynamicReadsMs}};
 });
}
async function timed<T>(record:Record<string,number>,name:string,work:()=>Promise<T>|T){const started=Date.now();try{return await work();}finally{record[name]=(record[name]??0)+Date.now()-started;}}

function gasUsd(gas:bigint,gasPrice:bigint,nativeUsd:number):number{
  return Number(gas*gasPrice)/1e18*nativeUsd;
}
export type V4OperationalGasStageInput={
  intentId:string;stage:string;gasUnits:bigint;gasPriceWei:bigint;
  gasLimitMultiplier:number;nativeUsd:number;nativeUsdSource:string;
  nativeUsdObservedAtMs?:number;nativeUsdFreshUntilMs?:number;
  estimatedGasUsd:number;perTxCapUsd:number;projectedLifecycleGasUsd:number;lifecycleCapUsd:number;
};
export function evaluateV4OperationalGasStage(input:V4OperationalGasStageInput){
  const bufferedGasUnits=input.gasUnits*BigInt(Math.round(input.gasLimitMultiplier*1000))/1000n;
  const bufferedGasUsd=input.estimatedGasUsd*input.gasLimitMultiplier;
  const verdict=!Number.isFinite(input.nativeUsd)||input.nativeUsd<=0||!Number.isFinite(input.estimatedGasUsd)
    ?'BLOCKED_NATIVE_USD'
    :input.estimatedGasUsd>input.perTxCapUsd
      ?'BLOCKED_PER_TX_CAP'
      :input.projectedLifecycleGasUsd>input.lifecycleCapUsd
        ?'BLOCKED_LIFECYCLE_CAP'
        :'PASS';
  return {...input,bufferedGasUnits,bufferedGasUsd,verdict};
}
function emitGasTelemetry(log:V4OperationalOpenPreflightInput['log'],stage:ReturnType<typeof evaluateV4OperationalGasStage>){
  log?.('v4_operational_gas_estimate',{...stage,gasUnits:stage.gasUnits.toString(),gasPriceWei:stage.gasPriceWei.toString(),bufferedGasUnits:stage.bufferedGasUnits.toString()});
}
function exactApproval(current:bigint,required:bigint,usable=true){
  return {current,required,approvalTransactionRequired:!usable||current!==required};
}
export function permit2ApprovalRequired(current:bigint,required:bigint,expiration:number,now:bigint){return current<required||BigInt(expiration)<=now;}
function assertSelectedPool(key:V4PoolKey,id:string,selection:GenericV4OpenSelection){
  if(id.toLowerCase()!==selection.poolId.toLowerCase()
    ||poolId(key).toLowerCase()!==selection.poolId.toLowerCase()
    ||json(key).toLowerCase()!==json(selection.key).toLowerCase())throw new Error('V4_POOL_KEY_MISMATCH');
}
function fundingSpent(logs:readonly any[],owner:Address,funding:Address){
  let spent=0n;
  for(const log of logs){
    if(!same(String(log.address),funding))continue;
    try{
      const event=decodeEventLog({abi:[transferEvent],data:log.data,topics:log.topics});
      if(event.eventName==='Transfer'&&same(event.args.from,owner))spent+=event.args.value;
    }catch{}
  }
  return spent;
}
async function receipt(rpc:FallbackRpc,hash:Hash){
  return rpc.withClient(client=>client.waitForTransactionReceipt({hash,timeout:60_000}));
}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export type V4OperationalOpenPreflightInput={
  repo:SqliteLedgerRepository;
  rpc:FallbackRpc;
  wallet:Address;
  runtime:{executionEnabled:boolean;dryRun:boolean;emergencyPause:boolean;signerConfigured:boolean;allowlisted:boolean};
  selection:GenericV4OpenSelection;
  range:V4DownsideRangeRequest;
  maxPositionUsd:number;
  maxApprovalUsd:number;
  maxBotManagedExposureUsd?:number;
  maxTxGasUsd:number;
  maxLifecycleGasUsd:number;
  slippageBps:number;
  maxSlippageBps:number;
  nativeUsd:number;
  nativeUsdSource:string;
  nativeUsdObservedAtMs:number;
  nativeUsdFreshUntilMs:number;
  fundingUsd:number;
  priceObservedAtMs:number;
  priceFreshUntilMs:number;
  walletClient?:WalletClient;
  alternateWalletClient?:WalletClient;
  alternateWalletClients?:Array<{providerIndex:number;providerType:string;walletClient:WalletClient}>;
  intentId?:string;
  gasPriceWei?:bigint;
  nativeBalance?:bigint;
  fundingBalance?:bigint;
  notify?:(state:string,details?:unknown)=>void|Promise<void>;
  log?:(event:string,details:Record<string,unknown>)=>void;
  telemetryIntentId?:string;
  /** Test-only shortening of the mandatory ambiguous-send observation window. */
  ambiguousMonitorMs?:number;
  /** Presentation-only immutable read context. Execution never supplies this:
   * the final click always performs a new authoritative preflight. */
  previewContext?:V4OperationalPreviewContext;
};

export type V4OperationalOpenPreflightResult={
  status:'V4 READY — awaiting final confirmation'|'BLOCKED';
  gate:V4OperationalGate;
  mainnetTransactionsSent:0;
  poolId:string;
  poolKey:V4PoolKey;
  range:{upperDropPct:number;lowerDropPct:number;tickLower:number;tickUpper:number};
  funding:{address:Address;amount:bigint;balance:bigint;usd:number};
  positionUsd:number;
  approvalUsd:number;
  pool:V4OperationalPoolSnapshot;
  fundingBalance:bigint;
  exposure:BotManagedExposureResult;
  hasOpenIntent:boolean;
  approvals:{erc20ToPermit2:ReturnType<typeof exactApproval>;permit2ToPositionManager:ReturnType<typeof exactApproval>};
  gas:{perTxUsd:number;lifecycleUsd:number;stages:Array<ReturnType<typeof evaluateV4OperationalGasStage>>};
  timing:Record<string,number|boolean>;
};

export async function v4OperationalOpenPreflight(input:V4OperationalOpenPreflightInput):Promise<V4OperationalOpenPreflightResult>{
  const s=input.selection;
  const key={...s.key,currency0:getAddress(s.key.currency0),currency1:getAddress(s.key.currency1),hooks:getAddress(s.key.hooks as `0x${string}`)} as V4PoolKey;
  const now=Date.now(),timing:Record<string,number>={},preview=input.previewContext,deployment=preview?{promise:Promise.resolve(preview.staticVerification.audit),cacheHit:preview.deploymentCacheHit}:cachedV4DeploymentAudit(input.rpc);
  const [audit,inspected,chainId,fundingBalance,nativeBalance,gasPrice,pending,block]=await Promise.all([
    timed(timing,'deploymentCacheMs',()=>deployment.promise),
    timed(timing,'poolStateMs',()=>preview?preview.pool:inspectV4Pool(input.rpc,key)),
    timed(timing,'chainMs',()=>preview?preview.staticVerification.chainId:input.rpc.withClient(client=>client.getChainId())),
    timed(timing,'balanceMs',()=>preview?preview.fundingBalance:input.fundingBalance!==undefined?input.fundingBalance:input.rpc.withClient(client=>client.readContract({address:getAddress(s.funding),abi:erc20Abi,functionName:'balanceOf',args:[input.wallet]}))),
    timed(timing,'nativeBalanceMs',()=>preview?preview.nativeBalance:input.nativeBalance!==undefined?input.nativeBalance:input.rpc.withClient(client=>client.getBalance({address:input.wallet}))),
    timed(timing,'gasPriceMs',()=>preview?preview.gasPriceWei:input.gasPriceWei!==undefined?input.gasPriceWei:input.rpc.withClient(client=>client.getGasPrice())),
    timed(timing,'databaseMs',()=>Number((input.repo.db.prepare("SELECT COUNT(*) AS count FROM v4_live_open_intents WHERE id<>COALESCE(?, '') AND state NOT IN ('PREVIEWED','POSITION_RECONCILED','FAILED','FAILED_RETRYABLE')").get(input.intentId??null) as {count:number}).count)>0),
    timed(timing,'blockContextMs',()=>preview?preview.sharedBlock:input.rpc.withClient(client=>client.getBlock())),
  ]);
  const pool=inspected.status==='available'?inspected.value:undefined;
  const registry=await timed(timing,'databaseMs',()=>input.repo.v4RegistryPool(s.poolId));
  const registryMatch=Boolean(pool&&registry)
    &&pool!.id.toLowerCase()===s.poolId.toLowerCase()
    &&String(registry!.validation_status)==='ELIGIBLE'
    &&json(pool!.key).toLowerCase()===json(key).toLowerCase();
  const noExecutionBlockers=Boolean(pool)&&v4ExecutionBlockers(pool!).length===0;
  const plan=pool?buildGenericV4SingleSidedDownsidePlan({pool,target:getAddress(s.target),funding:getAddress(s.funding),fundingAmount:s.amount,owner:input.wallet,deadline:block.timestamp+600n,range:input.range}):undefined;
  const [erc20Allowance,permit]=await timed(timing,'allowanceMs',()=>preview
   ?Promise.resolve([preview.erc20Allowance,preview.permit2Allowance] as const)
   :Promise.all([
     input.rpc.withClient(client=>client.readContract({address:getAddress(s.funding),abi:erc20Abi,functionName:'allowance',args:[input.wallet,V4_ROBINHOOD_DEPLOYMENTS.permit2]})),
     permit2Allowance(input.rpc,input.wallet,getAddress(s.funding),V4_ROBINHOOD_DEPLOYMENTS.positionManager),
   ]));
  const erc20Decision=exactApproval(erc20Allowance,s.amount);
  const permitDecision={current:permit[0],required:s.amount,approvalTransactionRequired:permit2ApprovalRequired(permit[0],s.amount,permit[1],block.timestamp)};
  const approvalData=encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[V4_ROBINHOOD_DEPLOYMENTS.permit2,s.amount]});
  const permitData=encodeFunctionData({abi:permit2ApproveAbi,functionName:'approve',args:[getAddress(s.funding),V4_ROBINHOOD_DEPLOYMENTS.positionManager,s.amount,Number(block.timestamp+3600n)]});
  const estimates=await input.rpc.withClient(async client=>{
    const [erc20,permitGas,mint]=await Promise.all([
      timed(timing,'approvalEstimateMs',()=>erc20Decision.approvalTransactionRequired?client.estimateGas({account:input.wallet,to:getAddress(s.funding),data:approvalData}):0n),
      timed(timing,'approvalEstimateMs',()=>permitDecision.approvalTransactionRequired?client.estimateGas({account:input.wallet,to:V4_ROBINHOOD_DEPLOYMENTS.permit2,data:permitData}):0n),
      timed(timing,'mintEstimateMs',()=>plan?client.estimateGas({account:input.wallet,to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,data:plan.calldata,value:0n}).catch(()=>400_000n):400_000n),
    ]);
    return {erc20,permit:permitGas,mint,close:180_000n,burn:70_000n};
  });
  const lifecycleStarted=Date.now();
  const stageEstimates=[
    ['ERC20_TO_PERMIT2',estimates.erc20],
    ['PERMIT2_POSITION_MANAGER',estimates.permit],
    ['MINT',estimates.mint],
    ['FULL_CLOSE_CONSERVATIVE',estimates.close],
    ['BURN_CONSERVATIVE',estimates.burn],
  ] as const;
  const quotes=stageEstimates.map(([,value])=>gasUsd(value,gasPrice,input.nativeUsd));
  const perTxUsd=Math.max(...quotes),lifecycleUsd=quotes.reduce((sum,value)=>sum+value,0);
  const telemetryIntentId=input.intentId??input.telemetryIntentId??'(preview)';
  const gasStages=stageEstimates.map(([stage,gasUnits],index)=>evaluateV4OperationalGasStage({
    intentId:telemetryIntentId,stage,gasUnits,gasPriceWei:gasPrice,gasLimitMultiplier:1.2,
    nativeUsd:input.nativeUsd,nativeUsdSource:input.nativeUsdSource,nativeUsdObservedAtMs:input.nativeUsdObservedAtMs,nativeUsdFreshUntilMs:input.nativeUsdFreshUntilMs,estimatedGasUsd:quotes[index]!,
    perTxCapUsd:input.maxTxGasUsd,projectedLifecycleGasUsd:lifecycleUsd,lifecycleCapUsd:input.maxLifecycleGasUsd,
  }));
  for(const stage of gasStages)emitGasTelemetry(input.log,stage);
  const lifecycleNative=Object.values(estimates).reduce((sum,value)=>sum+value,0n)*gasPrice*12n/10n;
  timing.lifecycleProjectionMs=Date.now()-lifecycleStarted;
  const decimals=s.fundingDecimals??18;
  const positionUsd=Number(s.amount)/10**decimals*input.fundingUsd;
  const approvalUsd=positionUsd;
  const exposure=botManagedProjectedExposure(input.repo,{incrementalActionCapitalUsd:positionUsd,proposedCommitmentId:input.intentId});
  const poolSnapshot:V4OperationalPoolSnapshot={id:pool?.id??s.poolId,key,initialized:Boolean(pool?.initialized),liquidity:pool?.liquidity??0n};
  const gate=evaluateV4OperationalGates({
    chainId,executionEnabled:input.runtime.executionEnabled,dryRun:input.runtime.dryRun,
    emergencyPause:input.runtime.emergencyPause,liveCanaryEnabled:false,v4LiveCanaryEnabled:false,
    signerConfigured:input.runtime.signerConfigured,authorized:input.runtime.allowlisted,
    deploymentVerified:audit.status==='available',pool:poolSnapshot,
    price:{fresh:now>=input.priceObservedAtMs&&now<input.priceFreshUntilMs,usdPerFunding:input.fundingUsd},
    positionUsd,approvalUsd,maxPositionUsd:input.maxPositionUsd,maxApprovalUsd:input.maxApprovalUsd,
    hasOpenIntent:pending,fundingBalance,
    gas:{nativeBalance,maxTxUsd:input.maxTxGasUsd,maxLifecycleUsd:input.maxLifecycleGasUsd,perTxUsd,lifecycleUsd},
    range:{valid:Boolean(plan)},selection:{targetIndex:s.targetIndex,fundingIndex:s.fundingIndex,targetZeroRequired:Boolean(plan&&(s.targetIndex===0?plan.amount0Expected:plan.amount1Expected)===0n),fundingPositiveRequired:Boolean(plan&&(s.fundingIndex===0?plan.amount0Expected:plan.amount1Expected)>0n)},
    slippageBps:input.slippageBps,maxSlippageBps:input.maxSlippageBps,
  });
  if(fundingBalance<s.amount)gate.reasons.push('FUNDING_ASSET_BALANCE_INSUFFICIENT');
  if(nativeBalance<lifecycleNative)gate.reasons.push('GAS_BALANCE_INSUFFICIENT');
  if(!Number.isFinite(input.nativeUsd)||input.nativeUsd<=0)gate.reasons.push('V4_NATIVE_USD_PRICE_INVALID');
  if(now<input.nativeUsdObservedAtMs||now>=input.nativeUsdFreshUntilMs)gate.reasons.push('V4_NATIVE_USD_PRICE_STALE');
  if(!registryMatch)gate.reasons.push('V4_POOL_KEY_MISMATCH');
  if(!noExecutionBlockers)gate.reasons.push('V4_POOL_EXECUTION_BLOCKERS');
  const exposureReason=botManagedExposureGate({result:exposure,maxBotManagedExposureUsd:input.maxBotManagedExposureUsd,live:input.runtime.executionEnabled&&!input.runtime.dryRun});
  if(exposureReason)gate.reasons.push(exposureReason);
  gate.reasons=Array.from(new Set(gate.reasons));
  gate.executionReachable=gate.reasons.length===0;
  return {
    status:gate.executionReachable?'V4 READY — awaiting final confirmation':'BLOCKED',gate,
    mainnetTransactionsSent:0,poolId:s.poolId,poolKey:key,
    range:{...input.range,tickLower:plan?.tickLower??0,tickUpper:plan?.tickUpper??0},
    funding:{address:getAddress(s.funding),amount:s.amount,balance:fundingBalance,usd:positionUsd},
    positionUsd,approvalUsd,pool:poolSnapshot,fundingBalance,hasOpenIntent:pending,exposure,
    approvals:{erc20ToPermit2:erc20Decision,permit2ToPositionManager:permitDecision},
    gas:{perTxUsd,lifecycleUsd,stages:gasStages},timing:{...timing,deploymentCacheHit:deployment.cacheHit,staticVerificationPrewarmed:Boolean(preview?.staticVerificationPrewarmed),sharedBlockNumber:Number(preview?.sharedBlock.number??pool?.blockNumber??0n),dynamicMulticallCount:preview?.dynamicMulticallCount??0,dynamicMulticallMembers:preview?.dynamicMulticallMembers??0,canonicalPriceCacheHit:Boolean(preview?.nativeUsd.cacheHit),duplicateReadsEliminated:preview?.duplicateReadsEliminated.length??0},
  };
}

function persistOpenedPosition(input:{repo:SqliteLedgerRepository;wallet:Address;selection:GenericV4OpenSelection;tokenId:bigint;liquidity:bigint;tickLower:number;tickUpper:number;fundingSpent:bigint;mintHash:Hash;blockNumber:bigint;intentId:string}){
  const {repo,wallet,selection:s}=input,positionId=`v4:${input.tokenId}`,amounts={token0:s.fundingIndex===0?input.fundingSpent:0n,token1:s.fundingIndex===1?input.fundingSpent:0n};
  repo.ensurePosition(positionId,input.tokenId.toString(),s.poolId);
  repo.upsertV4Position({tokenId:input.tokenId,owner:wallet,poolId:s.poolId,poolKey:s.key,currency0:s.key.currency0,currency1:s.key.currency1,fee:s.key.fee,tickSpacing:s.key.tickSpacing,hooks:s.key.hooks,tickLower:input.tickLower,tickUpper:input.tickUpper,liquidity:input.liquidity,initialAmount0:amounts.token0,initialAmount1:amounts.token1,mintHash:input.mintHash,targetToken:s.target,fundingToken:s.funding,targetSymbol:s.targetSymbol,fundingSymbol:s.fundingSymbol,targetDecimals:s.targetDecimals,fundingDecimals:s.fundingDecimals,targetIndex:s.targetIndex,fundingIndex:s.fundingIndex,feeSemantics:s.feeSemantics,hookStatus:s.hookStatus,valuationProvenance:s.valuationProvenance,openIntentId:input.intentId,openEvidence:{mintHash:input.mintHash,blockNumber:input.blockNumber,selectionId:s.selectionId,lane:'operational'}});
  repo.ingestDeposit({id:`v4-open:${input.mintHash}`,positionId,txHash:input.mintHash,logIndex:0,amounts,blockNumber:input.blockNumber,blockTimestamp:new Date().toISOString()});
  markOperationalPositionOpenConfirming(repo,{positionId,tokenId:input.tokenId.toString(),intentId:input.intentId,mintHash:input.mintHash,blockNumber:input.blockNumber});
  return positionId;
}

/** Re-runs every operational gate, atomically claims the durable intent, and
 * resumes submitted hashes by reconciling their receipts before doing more. */
export async function executeV4OperationalOpen(input:V4OperationalOpenPreflightInput&{intentId:string;idempotencyKey:string;walletClient:WalletClient}):Promise<V4OperationalExecutionResult>{
  const existing=input.repo.db.prepare('SELECT * FROM v4_live_open_intents WHERE id=? AND idempotency_key=?').get(input.intentId,input.idempotencyKey) as Record<string,unknown>|undefined;
  if(!existing)return {status:'EXECUTION_BLOCKED',reasons:['V4_INTENT_NOT_FOUND'],mainnetTransactionsSent:0};
  if(String(existing.state)==='POSITION_RECONCILED'||String(existing.state)==='FAILED_RETRYABLE'||String(existing.state)==='FAILED'&&!['V4_BROADCAST_PROVEN_ABSENT_NONCE_AVAILABLE','V4_BROADCAST_PROVEN_ABSENT_AFTER_IDENTICAL_RESEND'].includes(String(existing.failure_reason)))return {status:'ALREADY_COMPLETED',intentId:String(existing.id),mainnetTransactionsSent:0};
  if(activeOperationalIntents.has(input.intentId))return {status:'ALREADY_PROCESSING',intentId:input.intentId,mainnetTransactionsSent:0};
  activeOperationalIntents.add(input.intentId);
  let sent=0;
  try{
    const preflight=await v4OperationalOpenPreflight({...input,intentId:input.intentId});
    if(!preflight.gate.executionReachable)return {status:'EXECUTION_BLOCKED',reasons:preflight.gate.reasons,mainnetTransactionsSent:0};
    const current=input.repo.v4LiveOpenIntent(input.intentId)!;
    if(String(current.state)==='PREVIEWED'&&!input.repo.claimV4OperationalOpen({intentId:input.intentId}))return {status:'ALREADY_PROCESSING',intentId:input.intentId,mainnetTransactionsSent:0};
    const persisted=input.repo.v4LiveOpenIntent(input.intentId)!;
    const selection=input.selection;
    assertSelectedPool(JSON.parse(String(persisted.pool_key_json)) as V4PoolKey,String(persisted.pool_id),selection);
    if(BigInt(String(persisted.amount_raw))!==selection.amount||!same(String(persisted.owner),input.wallet))throw new Error('V4_PERSISTED_INTENT_MISMATCH');
    const enforceGas=async(stage:string,gas:bigint)=>{
      const gasPrice=input.gasPriceWei??await input.rpc.withClient(client=>client.getGasPrice()),usd=gasUsd(gas,gasPrice,input.nativeUsd);
      const projectedLifecycleGasUsd=input.repo.v4OperationalGasSpentUsd(input.intentId)+usd;
      const decision=evaluateV4OperationalGasStage({intentId:input.intentId,stage,gasUnits:gas,gasPriceWei:gasPrice,gasLimitMultiplier:1.2,nativeUsd:input.nativeUsd,nativeUsdSource:input.nativeUsdSource,nativeUsdObservedAtMs:input.nativeUsdObservedAtMs,nativeUsdFreshUntilMs:input.nativeUsdFreshUntilMs,estimatedGasUsd:usd,perTxCapUsd:input.maxTxGasUsd,projectedLifecycleGasUsd,lifecycleCapUsd:input.maxLifecycleGasUsd});
      emitGasTelemetry(input.log,decision);
      if(decision.verdict==='BLOCKED_NATIVE_USD')throw new Error('V4_NATIVE_USD_PRICE_INVALID');
      if(decision.verdict==='BLOCKED_PER_TX_CAP')throw new Error(`V4_TX_GAS_CAP_EXCEEDED:${stage}`);
      if(decision.verdict==='BLOCKED_LIFECYCLE_CAP')throw new Error(`V4_LIFECYCLE_GAS_BUDGET_EXCEEDED:${stage}`);
      return {gasPrice,usd,eth:gas*gasPrice};
    };
    const reconcile=async(phase:string,hash:Hash,knownReceipt?:TransactionReceipt)=>{
      const txReceipt:any=knownReceipt??await receipt(input.rpc,hash);
      if(!txReceipt||String(txReceipt.transactionHash).toLowerCase()!==hash.toLowerCase()||!['success','reverted'].includes(String(txReceipt.status)))throw new Error(`${phase}_EXACT_RECEIPT_INVALID`);
      input.repo.persistV4OperationalOpenReceipt(hash,input.intentId,phase,txReceipt);
      if(txReceipt.status!=='success')throw new Error(`${phase}_REVERTED`);
      const gas=BigInt(txReceipt.gasUsed),price=BigInt(txReceipt.effectiveGasPrice),eth=gas*price;
      input.repo.confirmV4OperationalGas({txHash:hash,gas,eth,usd:Number(eth)/1e18*input.nativeUsd});
      return txReceipt;
    };
    const ambiguous=async(phase:string,hash:Hash,nonce:number)=>{
      const until=Date.now()+(input.ambiguousMonitorMs??600_000);let evidence=await rebalanceExactHashEvidence(input.rpc,input.wallet,hash,nonce);
      while(evidence.kind==='ABSENT'&&evidence.latestNonce===nonce&&evidence.pendingNonce===nonce&&Date.now()<until){await delay(Math.min(10_000,Math.max(1,until-Date.now())));evidence=await rebalanceExactHashEvidence(input.rpc,input.wallet,hash,nonce);}
      if(evidence.kind==='RECEIPT')return reconcile(phase,hash,evidence.receipt);
      if(evidence.kind==='PENDING'){
        input.repo.transitionV4LiveOpenIntent(input.intentId,`${phase}_SUBMITTED`);
        return reconcile(phase,hash);
      }
      const reason=evidence.kind==='INCONCLUSIVE'?`V4_BROADCAST_AMBIGUOUS:${evidence.reason}`:evidence.latestNonce===nonce&&evidence.pendingNonce===nonce?'V4_BROADCAST_PROVEN_ABSENT_NONCE_AVAILABLE':'V4_BROADCAST_EXACT_HASH_ABSENT_NONCE_CONSUMED_OR_REPLACED';
      input.repo.transitionV4LiveOpenIntent(input.intentId,evidence.kind==='INCONCLUSIVE'?`${phase}_BROADCAST_AMBIGUOUS`:'FAILED',{failureReason:reason,details:{phase,exactHash:hash,nonce,evidence}});
      throw new Error(reason);
    };
    const submit=async(phase:string,to:Address,data:Hex,hashField:'erc20Hash'|'permit2Hash'|'mintHash',gas:bigint,quote:{gasPrice:bigint;usd:number;eth:bigint})=>{
      if(!input.repo.acquireNonceMutex(input.wallet,0n,660))throw new Error('V4_NONCE_MUTEX_HELD');
      try{
        const nonce=await input.rpc.withClient(client=>client.getTransactionCount({address:input.wallet,blockTag:'pending'}),{stage:'v4_operational_prebroadcast',method:'eth_getTransactionCount'}),request={account:input.wallet,chainId:input.rpc.config.chainId,to,data,value:0n,gas:gas*12n/10n,gasPrice:quote.gasPrice,nonce},serialized=await signWithConfiguredAccount(input.walletClient,request),hash=keccak256(serialized);
        input.repo.addV4LiveGasEstimate({txHash:hash,intentId:input.intentId,phase,gas,eth:quote.eth,usd:quote.usd});
        input.repo.transitionV4LiveOpenIntent(input.intentId,`${phase}_PREPARED`,{[hashField]:hash,details:{phase,exactHash:hash,nonce,request:{...request,value:'0',gas:request.gas.toString(),gasPrice:request.gasPrice.toString()},serializedHash:hash}});
        await input.notify?.(`${phase}_PREPARED`,{hash,nonce});
        try{await broadcastSignedTransaction({walletClient:input.walletClient,serializedTransaction:serialized,expectedHash:hash,expectedSender:input.wallet,expectedChainId:input.rpc.config.chainId,expectedNonce:nonce,providerIndex:0,providerName:'configured-write-provider-0',onEvidence:evidence=>input.log?.('transaction_broadcast_transport',evidence)});sent++;}
        catch{return {hash,receipt:await ambiguous(phase,hash,nonce)};}
        input.repo.transitionV4LiveOpenIntent(input.intentId,`${phase}_SUBMITTED`);
        await input.notify?.(`${phase}_SUBMITTED`,{hash});
        return {hash,receipt:await reconcile(phase,hash)};
      }finally{input.repo.releaseNonceMutex(input.wallet);}
    };
    const resendPersisted=async(phase:string,hash:Hash)=>{
      const endpoints=input.alternateWalletClients??(input.alternateWalletClient?[{providerIndex:1,providerType:'configured-write-provider',walletClient:input.alternateWalletClient}]:[]);if(!endpoints.length)throw new Error('V4_ALTERNATE_WRITE_PROVIDER_REQUIRED');
      const transition=input.repo.db.prepare('SELECT details_json FROM v4_live_transitions WHERE intent_id=? AND state=? ORDER BY ordinal DESC LIMIT 1').get(input.intentId,`${phase}_PREPARED`) as {details_json:string}|undefined;if(!transition)throw new Error('V4_PREPARED_REQUEST_MISSING');
      let details:any;try{details=JSON.parse(transition.details_json);}catch{throw new Error('V4_PREPARED_REQUEST_MALFORMED');}const raw=details.request,nonce=Number(raw?.nonce);if(!raw||!Number.isSafeInteger(nonce)||nonce<0)throw new Error('V4_PREPARED_REQUEST_MALFORMED');
      const request={account:getAddress(raw.account),chainId:Number(raw.chainId),to:getAddress(raw.to),data:raw.data as Hex,value:BigInt(raw.value),gas:BigInt(raw.gas),gasPrice:BigInt(raw.gasPrice),nonce},serialized=await signWithConfiguredAccount(input.walletClient,request);if(keccak256(serialized).toLowerCase()!==hash.toLowerCase())throw new Error('V4_SIGNED_TRANSACTION_HASH_MISMATCH');
      if(!input.repo.acquireNonceMutex(input.wallet,BigInt(nonce),660))throw new Error('V4_NONCE_MUTEX_HELD');
      try{
        const before=await rebalanceExactHashEvidence(input.rpc,input.wallet,hash,nonce);if(before.kind==='RECEIPT')return reconcile(phase,hash,before.receipt);if(before.kind==='PENDING'){input.repo.transitionV4LiveOpenIntent(input.intentId,`${phase}_SUBMITTED`);return reconcile(phase,hash);}if(before.kind==='INCONCLUSIVE')throw new Error(`V4_BROADCAST_AMBIGUOUS:${before.reason}`);if(before.latestNonce!==nonce||before.pendingNonce!==nonce)throw new Error('V4_BROADCAST_EXACT_HASH_ABSENT_NONCE_CONSUMED_OR_REPLACED');
        input.repo.db.prepare('UPDATE v4_live_open_intents SET failure_reason=NULL WHERE id=?').run(input.intentId);
        for(const [endpointOrdinal,endpoint] of endpoints.entries()){
         input.repo.transitionV4LiveOpenIntent(input.intentId,`${phase}_IDENTICAL_RESEND_PREPARED`,{details:{phase,exactHash:hash,nonce,identicalSerializedBytes:true,providerIndex:endpoint.providerIndex,providerType:endpoint.providerType}});
         try{await broadcastSignedTransaction({walletClient:endpoint.walletClient,serializedTransaction:serialized,expectedHash:hash,expectedSender:input.wallet,expectedChainId:input.rpc.config.chainId,expectedNonce:nonce,providerIndex:endpoint.providerIndex,providerName:`${endpoint.providerType}-${endpoint.providerIndex}`,onEvidence:evidence=>input.log?.('transaction_broadcast_transport',evidence)});sent++;input.repo.transitionV4LiveOpenIntent(input.intentId,`${phase}_SUBMITTED`);await input.notify?.(`${phase}_SUBMITTED`,{hash,identicalResend:true,providerIndex:endpoint.providerIndex});return reconcile(phase,hash);}
         catch{
          const after=await rebalanceExactHashEvidence(input.rpc,input.wallet,hash,nonce);if(after.kind==='RECEIPT')return reconcile(phase,hash,after.receipt);if(after.kind==='PENDING'){input.repo.transitionV4LiveOpenIntent(input.intentId,`${phase}_SUBMITTED`);return reconcile(phase,hash);}const reason=after.kind==='INCONCLUSIVE'?`V4_BROADCAST_AMBIGUOUS:${after.reason}`:after.latestNonce===nonce&&after.pendingNonce===nonce?'V4_BROADCAST_PROVEN_ABSENT_AFTER_IDENTICAL_RESEND':'V4_BROADCAST_EXACT_HASH_ABSENT_NONCE_CONSUMED_OR_REPLACED';if(after.kind==='INCONCLUSIVE'||reason!=='V4_BROADCAST_PROVEN_ABSENT_AFTER_IDENTICAL_RESEND'||endpointOrdinal===endpoints.length-1){input.repo.transitionV4LiveOpenIntent(input.intentId,after.kind==='INCONCLUSIVE'?`${phase}_BROADCAST_AMBIGUOUS`:'FAILED',{failureReason:reason,details:{phase,exactHash:hash,nonce,providerIndex:endpoint.providerIndex,providerType:endpoint.providerType,evidence:after}});throw new Error(reason);}
         }
        }
        throw new Error('V4_ALTERNATE_WRITE_PROVIDERS_EXHAUSTED');
      }finally{input.repo.releaseNonceMutex(input.wallet);}
    };
    const send=async(phase:string,to:Address,data:`0x${string}`,hashField:'erc20Hash'|'permit2Hash')=>{
      const gas=await input.rpc.withClient(client=>client.estimateGas({account:input.wallet,to,data,value:0n}));
      const quote=await enforceGas(phase,gas);
      const {hash}=await submit(phase,to,data,hashField,gas,quote);
      input.repo.transitionV4LiveOpenIntent(input.intentId,`${phase}_CONFIRMED`);
      return hash;
    };
    let row=input.repo.v4LiveOpenIntent(input.intentId)!;const retryableAbsent=()=>['V4_BROADCAST_PROVEN_ABSENT_NONCE_AVAILABLE','V4_BROADCAST_PROVEN_ABSENT_AFTER_IDENTICAL_RESEND'].includes(String(input.repo.v4LiveOpenIntent(input.intentId)?.failure_reason));
    if(row.erc20_approval_hash&&String(row.state)==='ERC20_PERMIT2_SUBMITTED'){await reconcile('ERC20_PERMIT2',row.erc20_approval_hash as Hash);input.repo.transitionV4LiveOpenIntent(input.intentId,'ERC20_PERMIT2_CONFIRMED');}
    if(!row.erc20_approval_hash&&String(row.state)==='ERC20_PERMIT2_SIGNING')return {status:'ALREADY_PROCESSING',intentId:input.intentId,mainnetTransactionsSent:0};
    const erc20Current=await input.rpc.withClient(client=>client.readContract({address:getAddress(selection.funding),abi:erc20Abi,functionName:'allowance',args:[input.wallet,V4_ROBINHOOD_DEPLOYMENTS.permit2]}));
    if(erc20Current!==selection.amount){
      if(row.erc20_approval_hash&&retryableAbsent()){await resendPersisted('ERC20_PERMIT2',row.erc20_approval_hash as Hash);input.repo.transitionV4LiveOpenIntent(input.intentId,'ERC20_PERMIT2_CONFIRMED');}
      else{const data=encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[V4_ROBINHOOD_DEPLOYMENTS.permit2,selection.amount]});await send('ERC20_PERMIT2',getAddress(selection.funding),data,'erc20Hash');}
    }
    row=input.repo.v4LiveOpenIntent(input.intentId)!;const block=await input.rpc.withClient(client=>client.getBlock()),permit=await permit2Allowance(input.rpc,input.wallet,getAddress(selection.funding),V4_ROBINHOOD_DEPLOYMENTS.positionManager),permitRequired=permit2ApprovalRequired(permit[0],selection.amount,permit[1],block.timestamp);
    if(!permitRequired&&row.permit2_approval_hash&&retryableAbsent()){const nonce=await input.rpc.withClient(client=>client.getTransactionCount({address:input.wallet,blockTag:'latest'})),pendingNonce=await input.rpc.withClient(client=>client.getTransactionCount({address:input.wallet,blockTag:'pending'})),evidence=await rebalanceExactHashEvidence(input.rpc,input.wallet,row.permit2_approval_hash as Hash,nonce);if(evidence.kind!=='ABSENT'||evidence.latestNonce!==nonce||evidence.pendingNonce!==nonce||pendingNonce!==nonce)throw new Error('V4_PERMIT2_NON_BROADCAST_EVIDENCE_CHANGED');input.repo.terminalizeV4OperationalNonBroadcast({intentId:input.intentId,phase:'PERMIT2_POSITION_MANAGER',hash:String(row.permit2_approval_hash),nonce,evidence});row=input.repo.v4LiveOpenIntent(input.intentId)!;}
    if(permitRequired&&row.permit2_approval_hash&&retryableAbsent()){const prepared=input.repo.db.prepare("SELECT details_json FROM v4_live_transitions WHERE intent_id=? AND state='PERMIT2_POSITION_MANAGER_PREPARED' ORDER BY ordinal DESC LIMIT 1").get(input.intentId) as {details_json:string}|undefined;if(!prepared)throw new Error('V4_PREPARED_REQUEST_MISSING');let durableHash:Hash;try{const parsed=JSON.parse(prepared.details_json);durableHash=parsed.exactHash as Hash;if(!/^0x[0-9a-fA-F]{64}$/.test(durableHash))throw new Error();}catch{throw new Error('V4_PREPARED_REQUEST_MALFORMED');}if(String(row.permit2_approval_hash).toLowerCase()!==durableHash.toLowerCase()){input.repo.transitionV4LiveOpenIntent(input.intentId,'PERMIT2_POSITION_MANAGER_RECOVERY_SELECTED',{permit2Hash:durableHash,details:{phase:'PERMIT2_POSITION_MANAGER',exactHash:durableHash,durablePreparedRequest:true}});row=input.repo.v4LiveOpenIntent(input.intentId)!;}await resendPersisted('PERMIT2_POSITION_MANAGER',durableHash);input.repo.transitionV4LiveOpenIntent(input.intentId,'PERMIT2_POSITION_MANAGER_CONFIRMED');row=input.repo.v4LiveOpenIntent(input.intentId)!;}
    if(permitRequired&&row.permit2_approval_hash&&String(row.state)==='PERMIT2_POSITION_MANAGER_SUBMITTED'){await reconcile('PERMIT2_POSITION_MANAGER',row.permit2_approval_hash as Hash);input.repo.transitionV4LiveOpenIntent(input.intentId,'PERMIT2_POSITION_MANAGER_CONFIRMED');}
    if(permitRequired&&!row.permit2_approval_hash&&String(row.state)==='PERMIT2_POSITION_MANAGER_SIGNING')return {status:'ALREADY_PROCESSING',intentId:input.intentId,mainnetTransactionsSent:0};
    if(permitRequired){
      const data=encodeFunctionData({abi:permit2ApproveAbi,functionName:'approve',args:[getAddress(selection.funding),V4_ROBINHOOD_DEPLOYMENTS.positionManager,selection.amount,Number(block.timestamp+3600n)]});
      await send('PERMIT2_POSITION_MANAGER',V4_ROBINHOOD_DEPLOYMENTS.permit2,data,'permit2Hash');
    }
    const exactErc20=await input.rpc.withClient(client=>client.readContract({address:getAddress(selection.funding),abi:erc20Abi,functionName:'allowance',args:[input.wallet,V4_ROBINHOOD_DEPLOYMENTS.permit2]}));
    const exactPermit=await permit2Allowance(input.rpc,input.wallet,getAddress(selection.funding),V4_ROBINHOOD_DEPLOYMENTS.positionManager);
    if(exactErc20!==selection.amount||permit2ApprovalRequired(exactPermit[0],selection.amount,exactPermit[1],block.timestamp))throw new Error('V4_EXACT_ALLOWANCE_VERIFICATION_FAILED');
    const refreshed=await inspectV4Pool(input.rpc,selection.key as V4PoolKey);
    if(refreshed.status==='unavailable'||!refreshed.value.initialized||refreshed.value.liquidity<=0n||v4ExecutionBlockers(refreshed.value).length)throw new Error('V4_POOL_EXECUTION_INELIGIBLE');
    assertSelectedPool(refreshed.value.key,refreshed.value.id,selection);
    const deadline=(await input.rpc.withClient(client=>client.getBlock())).timestamp+600n;
    const plan=buildGenericV4SingleSidedDownsidePlan({pool:refreshed.value,target:getAddress(selection.target),funding:getAddress(selection.funding),fundingAmount:selection.amount,owner:input.wallet,deadline,range:input.range});
    if((selection.targetIndex===0?plan.amount0Expected:plan.amount1Expected)!==0n||(selection.fundingIndex===0?plan.amount0Expected:plan.amount1Expected)<=0n)throw new Error('V4_SINGLE_SIDED_INVARIANT_FAILED');
    input.repo.transitionV4LiveOpenIntent(input.intentId,'RANGE_REFRESHED',{details:{tick:refreshed.value.tick,tickLower:plan.tickLower,tickUpper:plan.tickUpper,calldataHash:plan.calldataHash,slippageBps:input.slippageBps}});
    row=input.repo.v4LiveOpenIntent(input.intentId)!;
    let mintHash=row.mint_hash as Hash|undefined;
    let mintReceipt:any;
    if(mintHash){
      mintReceipt=retryableAbsent()?await resendPersisted('V4_MINT',mintHash):await reconcile('V4_MINT',mintHash);
    }else{
      if(String(row.state)==='MINT_SIGNING')return {status:'ALREADY_PROCESSING',intentId:input.intentId,mainnetTransactionsSent:0};
      const gas=await input.rpc.withClient(client=>client.estimateGas({account:input.wallet,to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,data:plan.calldata,value:0n}));
      const quote=await enforceGas('MINT',gas);
      const submitted=await submit('MINT',V4_ROBINHOOD_DEPLOYMENTS.positionManager,plan.calldata,'mintHash',gas,quote);mintHash=submitted.hash;mintReceipt=submitted.receipt;
    }
    const tokenId=parseV4MintTokenId(mintReceipt.logs,input.wallet),onchain=await inspectV4Position(input.rpc,tokenId);
    const spent=fundingSpent(mintReceipt.logs,input.wallet,getAddress(selection.funding));
    if(spent<=0n||spent>selection.amount||onchain.liquidity<=0n)throw new Error('V4_MINT_ACCOUNTING_INVARIANT_FAILED');
    input.repo.transitionV4LiveOpenIntent(input.intentId,'MINT_CONFIRMED',{tokenId:tokenId.toString(),details:{fundingSpent:spent,liquidity:onchain.liquidity}});
    const positionId=input.repo.db.transaction(()=>persistOpenedPosition({repo:input.repo,wallet:input.wallet,selection,tokenId,liquidity:onchain.liquidity,tickLower:plan.tickLower,tickUpper:plan.tickUpper,fundingSpent:spent,mintHash,blockNumber:mintReceipt.blockNumber,intentId:input.intentId}))();
    for(const gasRow of input.repo.v4LiveGas().filter(item=>String(item.intent_id)===input.intentId&&item.actual_eth_raw!==null)){
      input.repo.ingestGas(positionId,String(gasRow.tx_hash),BigInt(String(gasRow.actual_eth_raw)));
      input.repo.db.prepare('UPDATE gas_costs SET usd_value=? WHERE tx_hash=?').run(Number(gasRow.actual_usd),String(gasRow.tx_hash));
    }
    input.repo.transitionV4LiveOpenIntent(input.intentId,'POSITION_RECONCILED',{tokenId:tokenId.toString()});
    await input.notify?.('POSITION_RECONCILED',{tokenId});
    return {status:'POSITION_RECONCILED',intentId:input.intentId,mintHash,tokenId,fundingSpent:spent,mainnetTransactionsSent:sent};
  }catch(error){
    const reason=error instanceof Error?error.message:String(error);
    const durable=input.repo.v4LiveOpenIntent(input.intentId),state=String(durable?.state??'');
    if(!/_PREPARED$|_SUBMITTED$|_BROADCAST_AMBIGUOUS$/.test(state))input.repo.transitionV4LiveOpenIntent(input.intentId,'FAILED',{failureReason:reason});
    throw error;
  }finally{
    activeOperationalIntents.delete(input.intentId);
  }
}
