import { encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem';
import { erc20Abi, FallbackRpc, inspectErc20, inspectV3Pool, positionManagerAbi, priceFromSqrtX96, protocolDeployment, requireProtocolCapability, type Availability, type PoolState, type ProtocolKey, type V3Position, type VerifiedUniswapV3Deployments } from '@funi/core';

export * from './multichain-execution.js';

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const Q96 = 2n ** 96n;
const v3FamilyFactoryAbi=[{type:'function',name:'getPool',stateMutability:'view',inputs:[{type:'address'},{type:'address'},{type:'uint24'}],outputs:[{type:'address'}]}] as const;
/** Read-only v3-family discovery shared by verified Uniswap and Pancake
 * deployments. Transaction encoders remain protocol-specific and disabled. */
export async function discoverV3FamilyPools(input:{rpc:FallbackRpc;chainId:number;protocol:Extract<ProtocolKey,'uniswap_v3'|'pancakeswap_v3'>;token:Address;quoteTokens:readonly Address[];feeTiers?:readonly number[]}):Promise<Availability<PoolState[]>>{const deployment=requireProtocolCapability(input.chainId,input.protocol,'discovery'),factory=deployment.contracts.factory;if(!factory)return {status:'unavailable',reason:'DEPLOYMENT_CAPABILITY_CONTRACT_MISSING:factory'};if(input.rpc.config.chainId!==input.chainId)return {status:'unavailable',reason:'V3_FAMILY_RPC_CHAIN_MISMATCH'};const feeTiers=input.feeTiers??[100,500,2500,3000,10000],pools:PoolState[]=[];try{for(const quote of input.quoteTokens){if(quote.toLowerCase()===input.token.toLowerCase())continue;for(const fee of feeTiers){const pool=await input.rpc.withClient(client=>client.readContract({address:factory,abi:v3FamilyFactoryAbi,functionName:'getPool',args:[input.token,quote,fee]}),{stage:'v3_family_discovery',method:'Factory.getPool'});if(pool===zeroAddress)continue;const inspected=await inspectV3Pool(input.rpc,pool);if(inspected.status==='available'&&inspected.value.factory.toLowerCase()===factory.toLowerCase()&&inspected.value.fee===fee)pools.push(inspected.value);}}return {status:'available',value:pools,provenance:{provider:`${input.protocol} official factory getPool + pool role reads`,observedAt:new Date().toISOString(),blockNumber:pools.reduce<bigint|undefined>((latest,pool)=>latest===undefined||pool.blockNumber>latest?pool.blockNumber:latest,undefined),confidence:'verified'}};}catch(error){return {status:'unavailable',reason:`V3_FAMILY_DISCOVERY_FAILED:${error instanceof Error?error.message:'RPC_ERROR'}`};}}
export async function inspectV3FamilyPosition(input:{rpc:FallbackRpc;chainId:number;protocol:Extract<ProtocolKey,'uniswap_v3'|'pancakeswap_v3'>;tokenId:bigint}):Promise<Availability<V3Position>>{const deployment=requireProtocolCapability(input.chainId,input.protocol,'portfolioRead'),factory=deployment.contracts.factory,positionManager=deployment.contracts.positionManager;if(!factory||!positionManager)return {status:'unavailable',reason:'V3_FAMILY_REQUIRED_DEPLOYMENT_MISSING'};if(input.rpc.config.chainId!==input.chainId)return {status:'unavailable',reason:'V3_FAMILY_RPC_CHAIN_MISMATCH'};try{return await input.rpc.withClient(async client=>{const [owner,p]=await Promise.all([client.readContract({address:positionManager,abi:positionManagerAbi,functionName:'ownerOf',args:[input.tokenId]}),client.readContract({address:positionManager,abi:positionManagerAbi,functionName:'positions',args:[input.tokenId]})]),poolAddress=await client.readContract({address:factory,abi:v3FamilyFactoryAbi,functionName:'getPool',args:[p[2],p[3],p[4]]});if(poolAddress===zeroAddress)return {status:'unavailable' as const,reason:'POSITION_POOL_NOT_REGISTERED_BY_SELECTED_FACTORY'};const pool=await inspectV3Pool(input.rpc,poolAddress);if(pool.status==='unavailable'||pool.value.factory.toLowerCase()!==factory.toLowerCase())return {status:'unavailable' as const,reason:'POSITION_POOL_DEPLOYMENT_MISMATCH'};return {status:'available' as const,value:{tokenId:input.tokenId,owner,operator:p[1],token0:p[2],token1:p[3],fee:Number(p[4]),tickLower:Number(p[5]),tickUpper:Number(p[6]),liquidity:p[7],tokensOwed0:p[10],tokensOwed1:p[11],pool:pool.value},provenance:{provider:`${input.protocol} position manager + factory`,observedAt:new Date().toISOString(),blockNumber:pool.value.blockNumber,confidence:'verified' as const}};},{stage:'v3_family_position',method:'PositionManager.ownerOf+positions+Factory.getPool'});}catch(error){return {status:'unavailable',reason:`V3_FAMILY_POSITION_READ_FAILED:${error instanceof Error?error.message:'RPC_ERROR'}`};}}
export function v3FamilyExecutionBlocker(chainId:number,protocol:Extract<ProtocolKey,'uniswap_v3'|'pancakeswap_v3'>){const deployment=protocolDeployment(chainId,protocol);if(!deployment.capabilities.executionSupported)return deployment.capabilities.blockerReason??'EXECUTION_UNSUPPORTED';return deployment.runtimeVerification.status==='VERIFIED'?undefined:deployment.runtimeVerification.blockerReason??'DEPLOYMENT_RUNTIME_NOT_VERIFIED';}
export function compareAddresses(a: Address, b: Address): -1 | 0 | 1 { const aa=BigInt(a), bb=BigInt(b); return aa<bb?-1:aa>bb?1:0; }
export function canonicalTokenOrder(a: Address, b: Address): readonly [Address, Address] { if (a.toLowerCase()===b.toLowerCase()) throw new Error('pool tokens must differ'); return compareAddresses(a,b)<0?[a,b]:[b,a]; }
export function nearestUsableTick(tick: number, spacing: number): number { if (!Number.isInteger(tick) || !Number.isInteger(spacing) || spacing<=0) throw new Error('tick and tick spacing must be integers'); const rounded = Math.round(tick / spacing) * spacing; return Math.min(MAX_TICK - (MAX_TICK % spacing), Math.max(MIN_TICK - (MIN_TICK % spacing), rounded)); }
export function floorUsableTick(tick: number, spacing: number): number { return nearestUsableTick(Math.floor(tick/spacing)*spacing,spacing); }
export function sqrtRatioAtTick(tick: number): bigint { if (!Number.isInteger(tick)||tick<MIN_TICK||tick>MAX_TICK) throw new Error('tick outside v3 bounds'); return BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * Number(Q96))); }
export function tickAtPrice(priceToken1PerToken0: number, token0Decimals: number, token1Decimals: number): number { if (!Number.isFinite(priceToken1PerToken0)||priceToken1PerToken0<=0) throw new Error('price must be positive'); return Math.floor(Math.log(priceToken1PerToken0 / 10 ** (token0Decimals-token1Decimals)) / Math.log(1.0001)); }
export function rangeFromPercent(currentPrice: number, percent: number, token0Decimals: number, token1Decimals: number, spacing: number): { tickLower:number; tickUpper:number } { if (percent<=0||percent>=100) throw new Error('percent must be between 0 and 100'); const lower=floorUsableTick(tickAtPrice(currentPrice*(1-percent/100),token0Decimals,token1Decimals),spacing); const upper=nearestUsableTick(tickAtPrice(currentPrice*(1+percent/100),token0Decimals,token1Decimals),spacing); if (lower>=upper) throw new Error('range collapses after tick spacing'); return {tickLower:lower,tickUpper:upper}; }
function mulDiv(a:bigint,b:bigint,d:bigint): bigint { return a*b/d; }
/** Amounts represented by a v3 liquidity amount at current sqrt price. */
export function amountsForLiquidity(sqrtCurrent: bigint, sqrtLower: bigint, sqrtUpper: bigint, liquidity: bigint): { amount0: bigint; amount1: bigint } { if (sqrtLower>=sqrtUpper || liquidity<0n) throw new Error('invalid range or liquidity'); if (sqrtCurrent<=sqrtLower) return {amount0:mulDiv(mulDiv(liquidity,Q96,sqrtLower),sqrtUpper-sqrtLower,sqrtUpper),amount1:0n}; if (sqrtCurrent<sqrtUpper) return {amount0:mulDiv(mulDiv(liquidity,Q96,sqrtCurrent),sqrtUpper-sqrtCurrent,sqrtUpper),amount1:mulDiv(liquidity,sqrtCurrent-sqrtLower,Q96)}; return {amount0:0n,amount1:mulDiv(liquidity,sqrtUpper-sqrtLower,Q96)}; }
/** Maximum liquidity funded by balanced desired token amounts; no zap or swap implied. */
export function liquidityForAmounts(sqrtCurrent: bigint,sqrtLower:bigint,sqrtUpper:bigint,amount0:bigint,amount1:bigint): bigint { if (sqrtLower>=sqrtUpper) throw new Error('invalid range'); if (sqrtCurrent<=sqrtLower) return amount0*sqrtLower*sqrtUpper/Q96/(sqrtUpper-sqrtLower); if (sqrtCurrent>=sqrtUpper) return amount1*Q96/(sqrtUpper-sqrtLower); const l0=amount0*sqrtCurrent*sqrtUpper/Q96/(sqrtUpper-sqrtCurrent); const l1=amount1*Q96/(sqrtCurrent-sqrtLower); return l0<l1?l0:l1; }
export type RangeQuote = { tickLower:number; tickUpper:number; liquidity:bigint; requiredAmount0:bigint; requiredAmount1:bigint; currentBlock:bigint };
export function balancedRangeQuote(pool: PoolState, tickLower: number, tickUpper: number, desired0: bigint, desired1: bigint): RangeQuote { if (tickLower%pool.tickSpacing||tickUpper%pool.tickSpacing||tickLower>=tickUpper) throw new Error('range must obey pool tick spacing'); const l=liquidityForAmounts(pool.sqrtPriceX96,sqrtRatioAtTick(tickLower),sqrtRatioAtTick(tickUpper),desired0,desired1); const a=amountsForLiquidity(pool.sqrtPriceX96,sqrtRatioAtTick(tickLower),sqrtRatioAtTick(tickUpper),l); return {tickLower,tickUpper,liquidity:l,requiredAmount0:a.amount0,requiredAmount1:a.amount1,currentBlock:pool.blockNumber}; }

/** A role is deliberately separate from token0/token1.  All displayed prices are
 * funding units per one target unit, irrespective of the canonical pool order. */
export type StrategyAsset = { address: Address; symbol: string; decimals: number };
export type SingleSidedRoles = { targetAsset: StrategyAsset; fundingAsset: StrategyAsset; token0: StrategyAsset; token1: StrategyAsset; targetIndex: 0|1; fundingIndex: 0|1 };
export const DOWNSIDE_PRESETS = [10,20,30,40,50,60] as const;
export type DownsideRangeRequest = { currentDisplayedPrice: number; upperDropPct: number; lowerDropPct: number };
export type SingleSidedDownsideQuote = {
 tickLower:number; tickUpper:number; liquidity:bigint; amount0Desired:bigint; amount1Desired:bigint;
 requiredAmount0:bigint; requiredAmount1:bigint; currentBlock:bigint; targetIndex:0|1; fundingIndex:0|1;
 requestedUpperPrice:number; requestedLowerPrice:number; actualUpperPrice:number; actualLowerPrice:number;
 requestedUpperDropPct:number; requestedLowerDropPct:number; actualUpperDropPct:number; actualLowerDropPct:number;
};
export class RangeNotStrictlySingleSidedError extends Error { constructor(){super('RANGE_NOT_STRICTLY_SINGLE_SIDED');this.name='RangeNotStrictlySingleSidedError';} }
export function resolveSingleSidedRoles(input:{target:StrategyAsset; funding:StrategyAsset; token0:StrategyAsset; token1:StrategyAsset}):SingleSidedRoles {
 const same=(a:Address,b:Address)=>a.toLowerCase()===b.toLowerCase();
 if(same(input.target.address,input.funding.address)) throw new Error('target and funding assets must differ');
 const targetIndex=same(input.target.address,input.token0.address)?0:same(input.target.address,input.token1.address)?1:undefined;
 const fundingIndex=same(input.funding.address,input.token0.address)?0:same(input.funding.address,input.token1.address)?1:undefined;
 if(targetIndex===undefined||fundingIndex===undefined||targetIndex===fundingIndex) throw new Error('target/funding roles do not match pool tokens');
 return {targetAsset:input.target,fundingAsset:input.funding,token0:input.token0,token1:input.token1,targetIndex,fundingIndex};
}
export function validateDownsidePercentages(upperDropPct:number,lowerDropPct:number):void {
 if(!Number.isFinite(upperDropPct)||!Number.isFinite(lowerDropPct)||upperDropPct<0||upperDropPct>=lowerDropPct||lowerDropPct>=100) throw new Error('downside percentages must satisfy 0 <= upperDropPct < lowerDropPct < 100');
}
export function downsideFromCurrent(currentDisplayedPrice:number,downsidePct:number):DownsideRangeRequest {
 if(!Number.isFinite(currentDisplayedPrice)||currentDisplayedPrice<=0) throw new Error('current displayed price must be positive');
 validateDownsidePercentages(0,downsidePct); return {currentDisplayedPrice,upperDropPct:0,lowerDropPct:downsidePct};
}
export function displayedPriceFromPoolPrice(poolPriceToken1PerToken0:number,roles:SingleSidedRoles):number { return roles.targetIndex===0?poolPriceToken1PerToken0:1/poolPriceToken1PerToken0; }
function poolPriceFromDisplayed(displayed:number,roles:SingleSidedRoles):number { return roles.targetIndex===0?displayed:1/displayed; }
function priceAtTickForRoles(tick:number,roles:SingleSidedRoles):number { return displayedPriceFromPoolPrice(priceFromSqrtX96(sqrtRatioAtTick(tick),roles.token0.decimals,roles.token1.decimals),roles); }
function floorTick(tick:number,spacing:number){return Math.floor(tick/spacing)*spacing;}
function ceilTick(tick:number,spacing:number){return Math.ceil(tick/spacing)*spacing;}
/**
 * Builds a lower-price buy range and rounds the boundary away from the current
 * price.  That outward round is intentional: entering the range by even one
 * atomic tick would require target inventory, so it fails closed instead.
 */
export function singleSidedDownsideQuote(pool:PoolState,roles:SingleSidedRoles,fundingAmount:bigint,request:DownsideRangeRequest):SingleSidedDownsideQuote {
 if(fundingAmount<=0n) throw new Error('funding amount must be positive'); validateDownsidePercentages(request.upperDropPct,request.lowerDropPct);
 if(compareAddresses(roles.token0.address,roles.token1.address)>=0) throw new Error('pool token order is not canonical');
 const current=displayedPriceFromPoolPrice(priceFromSqrtX96(pool.sqrtPriceX96,roles.token0.decimals,roles.token1.decimals),roles);
 const base=request.currentDisplayedPrice; if(!Number.isFinite(base)||base<=0) throw new Error('current displayed price must be positive');
 const requestedUpper=base*(1-request.upperDropPct/100), requestedLower=base*(1-request.lowerDropPct/100);
 const poolAtUpper=poolPriceFromDisplayed(requestedUpper,roles),poolAtLower=poolPriceFromDisplayed(requestedLower,roles);
 let tickLower:number,tickUpper:number;
 if(roles.targetIndex===0){ // displayed and pool price descend together; funding is token1 above range
   tickLower=floorTick(tickAtPrice(poolAtLower,roles.token0.decimals,roles.token1.decimals),pool.tickSpacing);
   tickUpper=floorTick(tickAtPrice(poolAtUpper,roles.token0.decimals,roles.token1.decimals),pool.tickSpacing);
   // pool.tick identifies the containing tick, not a guarantee that sqrtPrice
   // has reached that tick's upper boundary.  Keep a full usable tick outside.
   if(tickUpper>=pool.tick) tickUpper=floorTick(pool.tick-1,pool.tickSpacing);
 } else { // displayed decline means pool price rises; funding is token0 below range
   tickLower=ceilTick(tickAtPrice(poolAtUpper,roles.token0.decimals,roles.token1.decimals),pool.tickSpacing);
   tickUpper=ceilTick(tickAtPrice(poolAtLower,roles.token0.decimals,roles.token1.decimals),pool.tickSpacing);
   if(tickLower<=pool.tick) tickLower=ceilTick(pool.tick+1,pool.tickSpacing);
 }
 // Up to four further outward ticks protect against numerical/tick-boundary dust.
 for(let attempt=0;attempt<5;attempt++){
   if(tickLower<MIN_TICK||tickUpper>MAX_TICK||tickLower>=tickUpper) throw new RangeNotStrictlySingleSidedError();
   // These are the actual v3 side invariants, independent of any displayed
   // price conversion.  If they fail, NPM can derive zero liquidity from the
   // zero target desired amount even when a stale UI quote looked one-sided.
   if(roles.fundingIndex===0&&!(roles.targetIndex===1&&pool.tick<tickLower)) throw new RangeNotStrictlySingleSidedError();
   if(roles.fundingIndex===1&&!(roles.targetIndex===0&&pool.tick>=tickUpper)) throw new RangeNotStrictlySingleSidedError();
   const desired0=roles.fundingIndex===0?fundingAmount:0n,desired1=roles.fundingIndex===1?fundingAmount:0n;
   const liquidity=liquidityForAmounts(pool.sqrtPriceX96,sqrtRatioAtTick(tickLower),sqrtRatioAtTick(tickUpper),desired0,desired1);
   const actual=amountsForLiquidity(pool.sqrtPriceX96,sqrtRatioAtTick(tickLower),sqrtRatioAtTick(tickUpper),liquidity);
   const targetRequired=roles.targetIndex===0?actual.amount0:actual.amount1, fundingRequired=roles.fundingIndex===0?actual.amount0:actual.amount1;
   if(liquidity>0n&&targetRequired===0n&&fundingRequired>0n) {
    const actualUpper=roles.targetIndex===0?priceAtTickForRoles(tickUpper,roles):priceAtTickForRoles(tickLower,roles);
    const actualLower=roles.targetIndex===0?priceAtTickForRoles(tickLower,roles):priceAtTickForRoles(tickUpper,roles);
    return {tickLower,tickUpper,liquidity,amount0Desired:desired0,amount1Desired:desired1,requiredAmount0:actual.amount0,requiredAmount1:actual.amount1,currentBlock:pool.blockNumber,targetIndex:roles.targetIndex,fundingIndex:roles.fundingIndex,requestedUpperPrice:requestedUpper,requestedLowerPrice:requestedLower,actualUpperPrice:actualUpper,actualLowerPrice:actualLower,requestedUpperDropPct:request.upperDropPct,requestedLowerDropPct:request.lowerDropPct,actualUpperDropPct:(1-actualUpper/base)*100,actualLowerDropPct:(1-actualLower/base)*100};
   }
   if(roles.targetIndex===0) tickUpper-=pool.tickSpacing; else tickLower+=pool.tickSpacing;
 }
 throw new RangeNotStrictlySingleSidedError();
}
export type ExecutionBlock = { allowed:false; reason:string } | { allowed:true; deployments:VerifiedUniswapV3Deployments };
export function canExecuteV3(deployments: Availability<VerifiedUniswapV3Deployments>, executionEnabled: boolean, dryRun: boolean, emergencyPause: boolean): ExecutionBlock { if (deployments.status==='unavailable') return {allowed:false,reason:deployments.reason}; if (!executionEnabled) return {allowed:false,reason:'EXECUTION_ENABLED is false'}; if (dryRun) return {allowed:false,reason:'DRY_RUN is true'}; if (emergencyPause) return {allowed:false,reason:'emergency pause is enabled'}; return {allowed:true,deployments:deployments.value}; }
export type TransactionPreview = { chainId:number; valueUsd:number; gasUsd:number; slippageBps:number; approval0:bigint; approval1:bigint; required0:bigint; required1:bigint; deadlineUnix:number };
export type SafetyLimits = { expectedChainId:number; maxValueUsd:number; maxGasUsd:number; maxSlippageBps:number; approvalCapMultiplierBps:number; nowUnix:number };
export function validatePreview(p:TransactionPreview, limits:SafetyLimits):void { if(p.chainId!==limits.expectedChainId) throw new Error(`wrong chain: expected ${limits.expectedChainId}`);if(p.valueUsd>limits.maxValueUsd) throw new Error('transaction-value cap exceeded');if(p.gasUsd>limits.maxGasUsd) throw new Error('gas cap exceeded');if(p.slippageBps>limits.maxSlippageBps) throw new Error('slippage cap exceeded');if(p.deadlineUnix<=limits.nowUnix) throw new Error('deadline expired');const cap=(v:bigint)=>v*BigInt(limits.approvalCapMultiplierBps)/10_000n;if(p.approval0>cap(p.required0)||p.approval1>cap(p.required1)) throw new Error('approval cap exceeded'); }
/** Process-local duplicate-button protection; persist idempotency keys in transaction_intents before broadcast. */
export class ConfirmationGate { private pending=new Set<string>(); begin(key:string):boolean {if(this.pending.has(key))return false;this.pending.add(key);return true;} finish(key:string):void{this.pending.delete(key);} }
export type PoolPresentation={pool:PoolState;token0:{address:Address;symbol:string;decimals:number};token1:{address:Address;symbol:string;decimals:number};priceToken1PerToken0:number;estimatedTvlUsd:Availability<number>};
export async function presentPool(rpc:FallbackRpc,pool:PoolState):Promise<Availability<PoolPresentation>>{
 const [t0,t1]=await Promise.all([inspectErc20(rpc,pool.token0),inspectErc20(rpc,pool.token1)]);
 if(t0.status==='unavailable'||t1.status==='unavailable')return {status:'unavailable',reason:'pool token metadata unavailable'};
 const price=priceFromSqrtX96(pool.sqrtPriceX96,t0.value.decimals,t1.value.decimals);
 let tvl:Availability<number>={status:'unavailable',reason:'USD valuation unavailable: neither pool token is canonical USDG'};
 if((t0.value.canonical&&t0.value.symbol==='USDG')||(t1.value.canonical&&t1.value.symbol==='USDG')){
  try { const [b0,b1]=await rpc.withClient(c=>Promise.all([
   c.readContract({address:pool.token0,abi:erc20Abi,functionName:'balanceOf',args:[pool.address]}),
   c.readContract({address:pool.token1,abi:erc20Abi,functionName:'balanceOf',args:[pool.address]})
  ]));
   const usd0=t0.value.symbol==='USDG'?1:(t1.value.symbol==='USDG'?price:undefined), usd1=t1.value.symbol==='USDG'?1:(t0.value.symbol==='USDG'?1/price:undefined);
   if(usd0!==undefined&&usd1!==undefined)tvl={status:'available',value:Number(b0)/10**t0.value.decimals*usd0+Number(b1)/10**t1.value.decimals*usd1,provenance:{provider:'rpc:ERC20 balances + USDG pool price',observedAt:new Date().toISOString(),blockNumber:pool.blockNumber,confidence:'derived'}};
  } catch { tvl={status:'unavailable',reason:'pool balance read unavailable'}; }
 }
 return {status:'available',value:{pool,token0:{address:t0.value.address,symbol:t0.value.symbol,decimals:t0.value.decimals},token1:{address:t1.value.address,symbol:t1.value.symbol,decimals:t1.value.decimals},priceToken1PerToken0:price,estimatedTvlUsd:tvl},provenance:{provider:'rpc:pool + ERC20',observedAt:new Date().toISOString(),blockNumber:pool.blockNumber,confidence:'verified'}};
}
export type PositionPresentation={position:V3Position;inRange:boolean;currentAmounts:{token0:bigint;token1:bigint};lowerPrice:number;currentPrice:number;upperPrice:number};
export async function presentPosition(rpc:FallbackRpc,position:V3Position):Promise<Availability<PositionPresentation>>{const [t0,t1]=await Promise.all([inspectErc20(rpc,position.token0),inspectErc20(rpc,position.token1)]);if(t0.status==='unavailable'||t1.status==='unavailable')return {status:'unavailable',reason:'position token metadata unavailable'};const amounts=amountsForLiquidity(position.pool.sqrtPriceX96,sqrtRatioAtTick(position.tickLower),sqrtRatioAtTick(position.tickUpper),position.liquidity);return {status:'available',value:{position,inRange:position.pool.tick>=position.tickLower&&position.pool.tick<position.tickUpper,currentAmounts:{token0:amounts.amount0,token1:amounts.amount1},lowerPrice:priceFromSqrtX96(sqrtRatioAtTick(position.tickLower),t0.value.decimals,t1.value.decimals),currentPrice:priceFromSqrtX96(position.pool.sqrtPriceX96,t0.value.decimals,t1.value.decimals),upperPrice:priceFromSqrtX96(sqrtRatioAtTick(position.tickUpper),t0.value.decimals,t1.value.decimals)},provenance:{provider:'rpc:position + pool',observedAt:new Date().toISOString(),blockNumber:position.pool.blockNumber,confidence:'verified'}};}
const approvalAbi=[{type:'function',name:'approve',stateMutability:'nonpayable',inputs:[{type:'address',name:'spender'},{type:'uint256',name:'amount'}],outputs:[{type:'bool'}]}] as const;
const managerWriteAbi=[{type:'function',name:'mint',stateMutability:'payable',inputs:[{type:'tuple',name:'params',components:[{type:'address',name:'token0'},{type:'address',name:'token1'},{type:'uint24',name:'fee'},{type:'int24',name:'tickLower'},{type:'int24',name:'tickUpper'},{type:'uint256',name:'amount0Desired'},{type:'uint256',name:'amount1Desired'},{type:'uint256',name:'amount0Min'},{type:'uint256',name:'amount1Min'},{type:'address',name:'recipient'},{type:'uint256',name:'deadline'}]}],outputs:[{type:'uint256'},{type:'uint128'},{type:'uint256'},{type:'uint256'}]},{type:'function',name:'increaseLiquidity',stateMutability:'payable',inputs:[{type:'tuple',name:'params',components:[{type:'uint256',name:'tokenId'},{type:'uint256',name:'amount0Desired'},{type:'uint256',name:'amount1Desired'},{type:'uint256',name:'amount0Min'},{type:'uint256',name:'amount1Min'},{type:'uint256',name:'deadline'}]}],outputs:[{type:'uint128'},{type:'uint256'},{type:'uint256'}]},{type:'function',name:'decreaseLiquidity',stateMutability:'payable',inputs:[{type:'tuple',name:'params',components:[{type:'uint256',name:'tokenId'},{type:'uint128',name:'liquidity'},{type:'uint256',name:'amount0Min'},{type:'uint256',name:'amount1Min'},{type:'uint256',name:'deadline'}]}],outputs:[{type:'uint256'},{type:'uint256'}]},{type:'function',name:'collect',stateMutability:'payable',inputs:[{type:'tuple',name:'params',components:[{type:'uint256',name:'tokenId'},{type:'address',name:'recipient'},{type:'uint128',name:'amount0Max'},{type:'uint128',name:'amount1Max'}]}],outputs:[{type:'uint256'},{type:'uint256'}]}] as const;
export type BuiltTransaction={to:Address;data:Hex;value:bigint;operation:'approval'|'mint'|'increase'|'collect'|'decrease'};
export function buildApproval(token:Address,spender:Address,amount:bigint):BuiltTransaction{return {to:token,data:encodeFunctionData({abi:approvalAbi,functionName:'approve',args:[spender,amount]}),value:0n,operation:'approval'};}
/**
 * An ERC-20 approval eth_call only proves that the approval calldata is valid.
 * It cannot update allowance state for a separate mint eth_call.  Keep that
 * distinction explicit in every preview so a TransferHelper STF is not
 * misreported as a range or position-manager failure.
 */
export type AllowanceSimulationState={
 currentAllowance:bigint;
 requiredAllowance:bigint;
 approvalRequired:boolean;
 approvalStatus:'ALLOWANCE_SUFFICIENT'|'APPROVAL_REQUIRED';
 directMintStatus:'DIRECT_MINT_ALLOWED'|'MINT_BLOCKED_UNTIL_APPROVAL';
 approvalAppliedToSimulationState:false;
};
export function allowanceSimulationState(currentAllowance:bigint,requiredAllowance:bigint):AllowanceSimulationState{
 if(currentAllowance<0n||requiredAllowance<=0n) throw new Error('allowance amounts must be non-negative and required allowance positive');
 const approvalRequired=currentAllowance<requiredAllowance;
 return {currentAllowance,requiredAllowance,approvalRequired,approvalStatus:approvalRequired?'APPROVAL_REQUIRED':'ALLOWANCE_SUFFICIENT',directMintStatus:approvalRequired?'MINT_BLOCKED_UNTIL_APPROVAL':'DIRECT_MINT_ALLOWED',approvalAppliedToSimulationState:false};
}
export function explainMintSimulationFailure(reason:string):string{
 return /\bSTF\b/.test(reason)?'Funding token transfer failed, usually because the approval has not yet been applied or the balance is insufficient.':reason;
}
export function buildMint(d:VerifiedUniswapV3Deployments,params:{token0:Address;token1:Address;fee:number;tickLower:number;tickUpper:number;amount0Desired:bigint;amount1Desired:bigint;amount0Min:bigint;amount1Min:bigint;recipient:Address;deadline:bigint}):BuiltTransaction{return {to:d.positionManager,data:encodeFunctionData({abi:managerWriteAbi,functionName:'mint',args:[params]}),value:0n,operation:'mint'};}
export function buildIncrease(d:VerifiedUniswapV3Deployments,params:{tokenId:bigint;amount0Desired:bigint;amount1Desired:bigint;amount0Min:bigint;amount1Min:bigint;deadline:bigint}):BuiltTransaction{return {to:d.positionManager,data:encodeFunctionData({abi:managerWriteAbi,functionName:'increaseLiquidity',args:[params]}),value:0n,operation:'increase'};}
export function buildDecrease(d:VerifiedUniswapV3Deployments,params:{tokenId:bigint;liquidity:bigint;amount0Min:bigint;amount1Min:bigint;deadline:bigint}):BuiltTransaction{return {to:d.positionManager,data:encodeFunctionData({abi:managerWriteAbi,functionName:'decreaseLiquidity',args:[params]}),value:0n,operation:'decrease'};}
export function buildCollect(d:VerifiedUniswapV3Deployments,params:{tokenId:bigint;recipient:Address;amount0Max:bigint;amount1Max:bigint}):BuiltTransaction{return {to:d.positionManager,data:encodeFunctionData({abi:managerWriteAbi,functionName:'collect',args:[params]}),value:0n,operation:'collect'};}
/** Simulates a real ERC-20 approve call with eth_call and estimates its gas; never broadcasts. */
export async function simulateApproval(rpc:FallbackRpc,from:Address,tx:BuiltTransaction):Promise<Availability<{gas:bigint;returnValue:boolean}>>{if(tx.operation!=='approval')return {status:'unavailable',reason:'only approval transactions can be simulated by this method'};return rpc.withClient(async c=>{try{const gas=await c.estimateGas({account:from,to:tx.to,data:tx.data,value:tx.value});const response=await c.call({account:from,to:tx.to,data:tx.data,value:tx.value});const data=response.data??'0x';return {status:'available',value:{gas,returnValue:data==='0x'||data.endsWith('1'.padStart(64,'0'))},provenance:{provider:'rpc:eth_call + eth_estimateGas',observedAt:new Date().toISOString(),confidence:'verified'}};}catch(e){return {status:'unavailable',reason:`approval simulation failed: ${e instanceof Error?e.message:String(e)}`};}})}
export async function simulateBuiltTransaction(rpc:FallbackRpc,from:Address,tx:BuiltTransaction):Promise<Availability<{gas:bigint;returnData:Hex}>>{return rpc.withClient(async c=>{try{const gas=await c.estimateGas({account:from,to:tx.to,data:tx.data,value:tx.value});const response=await c.call({account:from,to:tx.to,data:tx.data,value:tx.value});return {status:'available',value:{gas,returnData:(response.data??'0x') as Hex},provenance:{provider:'rpc:eth_call + eth_estimateGas',observedAt:new Date().toISOString(),confidence:'verified'}};}catch(e){return {status:'unavailable',reason:`${tx.operation} simulation failed: ${e instanceof Error?e.message:String(e)}`};}})}
