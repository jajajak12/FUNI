import { getAddress, type Address } from 'viem';
import {
  auditRobinhoodV3Deployments,
  discoverV3Pools,
  erc20Abi,
  inspectErc20,
  inspectV3Position,
  isRetryableRpcFailure,
  priceFromSqrtX96,
  robinhoodMainnet,
  simulateUnclaimedFees,
  type FallbackRpc,
} from '@robin/core';
import { presentPosition } from '@robin/v3';
import { inspectV4Pool, inspectV4PositionState, poolId as v4PoolId, sqrtPriceAtTick, v4ExecutionBlockers, type V4PoolKey } from '@robin/v4';
import type { SqliteLedgerRepository, TokenAmounts } from '@robin/ledger';
import { positionAdoption } from './position-adoption.js';

export const PORTFOLIO_PRICE_TTL_MS=120_000;
export type OptionalUsd=number|null;
export type PortfolioAccountingInput={
 externalCapitalUsd:OptionalUsd;
 activePrincipalUsd:OptionalUsd;
 uncollectedFeesUsd:OptionalUsd;
 collectedFeesUsd:OptionalUsd;
 realizedProceedsUsd:OptionalUsd;
 gasSpentUsd:OptionalUsd;
};
export type PortfolioAccounting=PortfolioAccountingInput&{
 currentEquityUsd:OptionalUsd;
 grossPnlUsd:OptionalUsd;
 grossPnlPct:OptionalUsd;
 netPnlUsd:OptionalUsd;
 netPnlPct:OptionalUsd;
 warnings:string[];
};
export type PortfolioPrice={
 token0Usd:number;
 token1Usd:number;
 token0Decimals:number;
 token1Decimals:number;
 source:string;
 blockNumber:bigint;
 sourceTimestamp:string;
 observedAt:string;
 freshUntil:string;
 confidence:'verified'|'derived';
};
export type TokenSupplyEvidence={
 raw:string;
 normalized:number;
 kind:'CIRCULATING'|'TOTAL';
 source:string;
 observedAt:string;
 decimals:number;
};
export type MarketRangeDisplay={
 label:'MC'|'FDV';
 currentUsd:number|null;
 lowerUsd:number|null;
 upperUsd:number|null;
 rangeStatus:'IN_RANGE'|'BELOW_RANGE'|'ABOVE_RANGE'|'UNAVAILABLE';
 reason?:'SUPPLY_EVIDENCE_MISSING'|'LP_TICK_METADATA_UNAVAILABLE'|'TOKEN_DECIMALS_UNAVAILABLE'|'USD_QUOTE_TOKEN_UNAVAILABLE'|'CURRENT_TOKEN_PRICE_UNAVAILABLE';
 supply?:TokenSupplyEvidence;
};
export type PortfolioPosition={
 positionId:string;
 tokenId:string;
 protocol:'v3'|'v4';
 pair:string;
 poolId:string;
 token0Address:Address;
 token1Address:Address;
 status:string;
 rangeStatus:'IN_RANGE'|'OUT_OF_RANGE'|'CLOSED'|'UNRECONCILED';
 range:string;
 currentPrice:OptionalUsd;
 marketRange?:MarketRangeDisplay;
 valuationStatus:'PRICED'|'UNPRICED';
 valuationReason?:string;
 price?:PortfolioPrice;
 raw:{
  originalDeposits:TokenAmounts;
  currentPrincipal:TokenAmounts|null;
  uncollectedFees:TokenAmounts|null;
  collectedFees:TokenAmounts;
  withdrawnPrincipal:TokenAmounts;
 };
 accounting:PortfolioAccounting;
 reconciliation:string;
 adoption?:{
  source:'MANUAL_EXTERNAL'|'BOT_OPERATIONAL';
  status:'AUTO_ADOPTED'|'OPERATIONAL_OPEN';
  accountingStatus:string;
  baselineProvenance:string|null;
  fundingSymbol:string|null;
  fundingProvenance:string|null;
 };
 lineage?:{lineageId:string;rootPositionId:string;role:'ORIGINAL'|'REPLACEMENT';originalPrincipalUsd:number;topUpsUsd:number;parkedSurplusUsd:number};
 excludedFromAggregateReason?:string;
};

const finitePositive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;
export function deriveTokenStableMarketRange(input:{token0:Address;token1:Address;token0Usd:number|null;token1Usd:number|null;token0Decimals:number|null;token1Decimals:number|null;tickLower:number|null;tickUpper:number|null;supply?:TokenSupplyEvidence}):MarketRangeDisplay{
 const token0IsUsd=input.token0.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase(),token1IsUsd=input.token1.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase();
 if(token0IsUsd===token1IsUsd)return {label:'MC',currentUsd:null,lowerUsd:null,upperUsd:null,rangeStatus:'UNAVAILABLE',reason:'USD_QUOTE_TOKEN_UNAVAILABLE'};
 if(!Number.isInteger(input.token0Decimals)||!Number.isInteger(input.token1Decimals)||(input.token0Decimals as number)<0||(input.token1Decimals as number)<0)return {label:'MC',currentUsd:null,lowerUsd:null,upperUsd:null,rangeStatus:'UNAVAILABLE',reason:'TOKEN_DECIMALS_UNAVAILABLE'};
 if(!Number.isInteger(input.tickLower)||!Number.isInteger(input.tickUpper)||(input.tickLower as number)>=(input.tickUpper as number))return {label:'MC',currentUsd:null,lowerUsd:null,upperUsd:null,rangeStatus:'UNAVAILABLE',reason:'LP_TICK_METADATA_UNAVAILABLE'};
 const volatileIndex=token0IsUsd?1:0,currentPrice=volatileIndex===0?input.token0Usd:input.token1Usd;
 if(!finitePositive(currentPrice))return {label:'MC',currentUsd:null,lowerUsd:null,upperUsd:null,rangeStatus:'UNAVAILABLE',reason:'CURRENT_TOKEN_PRICE_UNAVAILABLE'};
 const priceAtTick=(tick:number)=>{const poolPrice=priceFromSqrtX96(sqrtPriceAtTick(tick),input.token0Decimals!,input.token1Decimals!);return volatileIndex===0?poolPrice:1/poolPrice;};
 const a=priceAtTick(input.tickLower!),b=priceAtTick(input.tickUpper!);if(!finitePositive(a)||!finitePositive(b))return {label:'MC',currentUsd:null,lowerUsd:null,upperUsd:null,rangeStatus:'UNAVAILABLE',reason:'LP_TICK_METADATA_UNAVAILABLE'};
 const lowerPrice=Math.min(a,b),upperPrice=Math.max(a,b),status=currentPrice<lowerPrice?'BELOW_RANGE':currentPrice>upperPrice?'ABOVE_RANGE':'IN_RANGE',label=input.supply?.kind==='TOTAL'?'FDV':'MC';
 if(!input.supply||!finitePositive(input.supply.normalized))return {label,currentUsd:null,lowerUsd:null,upperUsd:null,rangeStatus:status,reason:'SUPPLY_EVIDENCE_MISSING'};
 return {label,currentUsd:currentPrice*input.supply.normalized,lowerUsd:lowerPrice*input.supply.normalized,upperUsd:upperPrice*input.supply.normalized,rangeStatus:status,supply:input.supply};
}
export type PortfolioAudit={
 schemaVersion:1;
 observedAt:string;
 priceTtlMs:number;
 positions:PortfolioPosition[];
 aggregate:ReturnType<typeof aggregatePortfolio>;
 warnings:string[];
 pricingPolicy:string[];
 mainnetTransactionsSent:0;
};

const finite=(value:number|null):value is number=>value!==null&&Number.isFinite(value);
const sumKnown=(...values:OptionalUsd[])=>values.every(finite)?values.reduce<number>((sum,value)=>sum+(value as number),0):null;
function cachedCirculatingSupply(repo:SqliteLedgerRepository,address:Address,decimals:number,nowMs=Date.now()):TokenSupplyEvidence|undefined{
 const row=repo.db.prepare('SELECT observed_at_ms,source_json FROM gmgn_robinhood_observations WHERE lower(token_address)=lower(?) ORDER BY observed_at_ms DESC LIMIT 1').get(address) as {observed_at_ms:number;source_json:string}|undefined;
 if(!row||row.observed_at_ms>nowMs||nowMs-row.observed_at_ms>30*60_000)return;
 try{const basis=JSON.parse(row.source_json).supplyBasis as {kind?:unknown;raw?:unknown;normalized?:unknown}|undefined,raw=typeof basis?.raw==='string'&&/^\d+$/.test(basis.raw)?basis.raw:undefined,normalized=raw?Number(BigInt(raw))/10**decimals:NaN;if(basis?.kind==='circulating'&&raw&&finitePositive(normalized))return {raw,normalized,kind:'CIRCULATING',source:'gmgn cached circulating supply',observedAt:new Date(row.observed_at_ms).toISOString(),decimals};}catch{}return;
}
export function canonicalPortfolioAccounting(input:PortfolioAccountingInput):PortfolioAccounting{
 const currentEquityUsd=sumKnown(input.activePrincipalUsd,input.uncollectedFeesUsd);
 const grossPnlUsd=sumKnown(currentEquityUsd,input.realizedProceedsUsd,input.collectedFeesUsd,input.externalCapitalUsd===null?null:-input.externalCapitalUsd);
 const netPnlUsd=sumKnown(grossPnlUsd,input.gasSpentUsd===null?null:-input.gasSpentUsd);
 const pct=(value:OptionalUsd)=>finite(value)&&finite(input.externalCapitalUsd)&&input.externalCapitalUsd>0?value/input.externalCapitalUsd*100:null;
 const warnings:string[]=[];
 for(const [name,value] of Object.entries(input))if(value===null)warnings.push(`${name.toUpperCase()}_UNAVAILABLE`);
 return {...input,currentEquityUsd,grossPnlUsd,grossPnlPct:pct(grossPnlUsd),netPnlUsd,netPnlPct:pct(netPnlUsd),warnings};
}
export function aggregatePortfolio(positions:PortfolioPosition[]){
 const included=positions.filter(position=>!position.excludedFromAggregateReason),priced=included.filter(position=>position.valuationStatus==='PRICED'),active=included.filter(position=>['open','partially_closed'].includes(position.status)),sum=(field:keyof PortfolioAccounting)=>priced.length&&priced.every(position=>typeof position.accounting[field]==='number'&&Number.isFinite(position.accounting[field]))?priced.reduce((total,position)=>total+(position.accounting[field] as number),0):null,complete=priced.filter(position=>position.accounting.grossPnlUsd!==null&&position.accounting.netPnlUsd!==null),allComplete=included.length>0&&complete.length===included.length,capital=complete.reduce((total,position)=>total+(position.accounting.externalCapitalUsd??0),0),gross=complete.reduce((total,position)=>total+(position.accounting.grossPnlUsd??0),0),net=complete.reduce((total,position)=>total+(position.accounting.netPnlUsd??0),0),originalCapitalUsd=included.length&&included.every(position=>finite(position.accounting.externalCapitalUsd))?included.reduce((total,position)=>total+(position.accounting.externalCapitalUsd as number),0):null;
 return {activePositions:active.length,pricedPositions:priced.length,unpricedPositions:included.length-priced.length,excludedReplacedPositions:positions.length-included.length,fullyAccountedPositions:complete.length,originalCapitalUsd,activePrincipalUsd:sum('activePrincipalUsd'),uncollectedFeesUsd:sum('uncollectedFeesUsd'),currentEquityUsd:sum('currentEquityUsd'),collectedFeesUsd:sum('collectedFeesUsd'),realizedProceedsUsd:sum('realizedProceedsUsd'),grossPnlUsd:allComplete?gross:null,grossPnlPct:allComplete&&capital>0?gross/capital*100:null,gasSpentUsd:sum('gasSpentUsd'),netPnlUsd:allComplete?net:null,netPnlPct:allComplete&&capital>0?net/capital*100:null,inRange:active.filter(position=>position.rangeStatus==='IN_RANGE').length,outOfRange:active.filter(position=>position.rangeStatus==='OUT_OF_RANGE').length,partialValuation:priced.length!==included.length||complete.length!==included.length};
}
function valueRaw(amounts:TokenAmounts,price:PortfolioPrice){const value=Number(amounts.token0)/10**price.token0Decimals*price.token0Usd+Number(amounts.token1)/10**price.token1Decimals*price.token1Usd;return Number.isFinite(value)&&value>=0?value:null;}
function zeroAmounts(amounts:TokenAmounts){return amounts.token0===0n&&amounts.token1===0n;}
function gasValue(repo:SqliteLedgerRepository,positionId:string):OptionalUsd{const row=repo.db.prepare('SELECT COUNT(*) total,COUNT(usd_value) priced,COALESCE(SUM(usd_value),0) value FROM gas_costs WHERE position_id=?').get(positionId) as {total:number;priced:number;value:number};return row.total===row.priced&&Number.isFinite(row.value)?row.value:null;}
function executionCapital(repo:SqliteLedgerRepository,positionId:string,token0:Address,token1:Address,d0:number,d1:number):OptionalUsd{
 const adopted=positionAdoption(repo,positionId);
 if(adopted?.baseline_provenance==='USER_VERIFIED_BASELINE'&&adopted.original_capital_usd!==null&&Number.isFinite(Number(adopted.original_capital_usd)))return Number(adopted.original_capital_usd);
 const native=repo.v4Position(positionId.startsWith('v4:')?positionId.slice(3):'');if(native?.open_intent_id&&String(native.funding_symbol)==='USDG'){const raw=Number(native.funding_index)===0?BigInt(String(native.initial_amount0_raw)):BigInt(String(native.initial_amount1_raw)),decimals=Number(native.funding_decimals??6),value=Number(raw)/10**decimals;if(Number.isFinite(value)&&value>=0)return value;}
 const rows=repo.db.prepare('SELECT token0_raw,token1_raw,prices_json FROM position_deposits WHERE position_id=?').all(positionId) as Array<{token0_raw:string;token1_raw:string;prices_json:string}>;
 if(!rows.length)return null;
 let total=0;
 for(const row of rows){const a0=BigInt(row.token0_raw),a1=BigInt(row.token1_raw);let parsed:Record<string,unknown>={};try{parsed=JSON.parse(row.prices_json);}catch{return null;}const p0=Number(parsed.token0Usd),p1=Number(parsed.token1Usd),usd0=Number.isFinite(p0)&&p0>0?p0:token0.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()?1:undefined,usd1=Number.isFinite(p1)&&p1>0?p1:token1.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()?1:undefined;if((a0>0n&&usd0===undefined)||(a1>0n&&usd1===undefined))return null;total+=Number(a0)/10**d0*(usd0??0)+Number(a1)/10**d1*(usd1??0);}
 return Number.isFinite(total)?total:null;
}
function historicalValue(amounts:TokenAmounts,token0:Address,token1:Address,d0:number,d1:number):OptionalUsd{
 if(zeroAmounts(amounts))return 0;
 const nonUsd0=token0.toLowerCase()!==robinhoodMainnet.assets.USDG.toLowerCase()&&amounts.token0>0n,nonUsd1=token1.toLowerCase()!==robinhoodMainnet.assets.USDG.toLowerCase()&&amounts.token1>0n;
 if(nonUsd0||nonUsd1)return null;
 return Number(amounts.token0)/10**d0+Number(amounts.token1)/10**d1;
}
type V3DeploymentAudit=Awaited<ReturnType<typeof auditRobinhoodV3Deployments>>;
export type WethUsdReference={status:'available';value:number;blockNumber:bigint;source:string;sourceTimestamp:string;observedAt:string}|{status:'unavailable';reason:string};
const deploymentAuditCache=new WeakMap<object,{expiresAt:number;promise:Promise<V3DeploymentAudit>}>();
const wethUsdCache=new WeakMap<object,{expiresAt:number;promise:Promise<WethUsdReference>}>();
const rpcCacheKey=(rpc:FallbackRpc)=>(rpc as any).__cacheKey??rpc as object;
async function cachedV3DeploymentAudit(rpc:FallbackRpc){
 const key=rpcCacheKey(rpc),now=Date.now(),cached=deploymentAuditCache.get(key);if(cached&&cached.expiresAt>now)return cached.promise;
 const promise=auditRobinhoodV3Deployments(rpc);deploymentAuditCache.set(key,{expiresAt:now+300_000,promise});return promise;
}
async function loadTrustedWethUsdReference(rpc:FallbackRpc):Promise<WethUsdReference>{
 const deployments=await cachedV3DeploymentAudit(rpc),found=await discoverV3Pools(rpc,deployments,robinhoodMainnet.assets.WETH);
 if(found.status==='unavailable')return {status:'unavailable' as const,reason:found.reason};
 const candidates=found.value.filter(pool=>pool.liquidity>0n&&(pool.token0.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()||pool.token1.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase())).sort((a,b)=>a.liquidity===b.liquidity?a.address.localeCompare(b.address):a.liquidity>b.liquidity?-1:1),pool=candidates[0];
 if(!pool)return {status:'unavailable' as const,reason:'CANONICAL_WETH_USDG_POOL_UNAVAILABLE'};
 const [t0,t1]=await Promise.all([inspectErc20(rpc,pool.token0),inspectErc20(rpc,pool.token1)]);if(t0.status==='unavailable'||t1.status==='unavailable')return {status:'unavailable' as const,reason:'CANONICAL_WETH_USDG_METADATA_UNAVAILABLE'};
 const block=await rpc.withClient(client=>client.getBlock({blockNumber:pool.blockNumber}),{stage:'price_preflight',method:'eth_getBlockByNumber'}),sourceTimestamp=new Date(Number(block.timestamp)*1000),age=Date.now()-sourceTimestamp.getTime();if(age<0||age>PORTFOLIO_PRICE_TTL_MS)return {status:'unavailable' as const,reason:'CANONICAL_WETH_USDG_PRICE_STALE'};
 const onePerZero=priceFromSqrtX96(pool.sqrtPriceX96,t0.value.decimals,t1.value.decimals),value=pool.token0.toLowerCase()===robinhoodMainnet.assets.WETH.toLowerCase()?onePerZero:1/onePerZero;
 if(!Number.isFinite(value)||value<=0)return {status:'unavailable' as const,reason:'CANONICAL_WETH_USDG_PRICE_INVALID'};
 return {status:'available' as const,value,blockNumber:pool.blockNumber,source:`Uniswap v3 WETH/USDG ${pool.address}`,sourceTimestamp:sourceTimestamp.toISOString(),observedAt:new Date().toISOString()};
}
export async function trustedWethUsdReference(rpc:FallbackRpc){
 const key=rpcCacheKey(rpc),now=Date.now(),cached=wethUsdCache.get(key);if(cached&&cached.expiresAt>now)return cached.promise;
 const promise=loadTrustedWethUsdReference(rpc);wethUsdCache.set(key,{expiresAt:now+60_000,promise});
 promise.then(result=>{if(result.status==='unavailable')wethUsdCache.set(key,{expiresAt:Date.now()+5_000,promise:Promise.resolve(result)});}).catch(()=>wethUsdCache.delete(key));
 return promise;
}
export async function trustedV4WethUsdReference(input:{rpc:FallbackRpc;repo:SqliteLedgerRepository}):Promise<WethUsdReference>{
 const rows=input.repo.v4RegistryPoolsForToken(robinhoodMainnet.assets.WETH,[robinhoodMainnet.assets.USDG]).filter(row=>Number(row.initialized)===1&&BigInt(String(row.active_liquidity_raw??0))>0n&&String(row.validation_status)!=='BLOCKED').sort((a,b)=>{
  const liquidityA=BigInt(String(a.active_liquidity_raw??0)),liquidityB=BigInt(String(b.active_liquidity_raw??0));
  return liquidityA===liquidityB?String(a.pool_id).localeCompare(String(b.pool_id)):liquidityA>liquidityB?-1:1;
 });
 const row=rows[0];if(!row)return {status:'unavailable',reason:'V4_CANONICAL_WETH_USDG_POOL_UNAVAILABLE'};
 const key={currency0:getAddress(String(row.currency0)),currency1:getAddress(String(row.currency1)),fee:Number(row.initialize_fee_raw),tickSpacing:Number(row.tick_spacing),hooks:getAddress(String(row.hooks))} as V4PoolKey;
 if(v4PoolId(key).toLowerCase()!==String(row.pool_id).toLowerCase())return {status:'unavailable',reason:'V4_CANONICAL_WETH_USDG_POOL_KEY_MISMATCH'};
 const [pool,t0,t1]=await Promise.all([inspectV4Pool(input.rpc,key),inspectErc20(input.rpc,key.currency0),inspectErc20(input.rpc,key.currency1)]);
 if(pool.status==='unavailable'||t0.status==='unavailable'||t1.status==='unavailable'||v4ExecutionBlockers(pool.value).length)return {status:'unavailable',reason:'V4_CANONICAL_WETH_USDG_POOL_UNAVAILABLE'};
 const price=await boundedPrice(input.rpc,pairPrice({token0:key.currency0,token1:key.currency1,d0:t0.value.decimals,d1:t1.value.decimals,sqrtPriceX96:pool.value.sqrtPriceX96,blockNumber:pool.value.blockNumber,poolSource:`Uniswap v4 WETH/USDG ${row.pool_id}`}));
 if(!price)return {status:'unavailable',reason:'V4_CANONICAL_WETH_USDG_PRICE_UNAVAILABLE'};
 const value=key.currency0.toLowerCase()===robinhoodMainnet.assets.WETH.toLowerCase()?price.token0Usd:price.token1Usd;
 return {status:'available',value,blockNumber:price.blockNumber,source:price.source,sourceTimestamp:price.sourceTimestamp,observedAt:price.observedAt};
}
function pairPrice(input:{token0:Address;token1:Address;d0:number;d1:number;sqrtPriceX96:bigint;blockNumber:bigint;poolSource:string;wethUsd?:number;wethSource?:string}):PortfolioPrice|null{
 const ratio=priceFromSqrtX96(input.sqrtPriceX96,input.d0,input.d1);let token0Usd:number|undefined,token1Usd:number|undefined,source=input.poolSource,confidence:'verified'|'derived'='derived';
 if(input.token0.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()){token0Usd=1;token1Usd=1/ratio;}
 else if(input.token1.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()){token0Usd=ratio;token1Usd=1;}
 else if(input.wethUsd&&input.token0.toLowerCase()===robinhoodMainnet.assets.WETH.toLowerCase()){token0Usd=input.wethUsd;token1Usd=input.wethUsd/ratio;source+=` + ${input.wethSource}`;}
 else if(input.wethUsd&&input.token1.toLowerCase()===robinhoodMainnet.assets.WETH.toLowerCase()){token0Usd=ratio*input.wethUsd;token1Usd=input.wethUsd;source+=` + ${input.wethSource}`;}
 if(!token0Usd||!token1Usd||![token0Usd,token1Usd].every(value=>Number.isFinite(value)&&value>0))return null;
 const observedAt=new Date().toISOString();return {token0Usd,token1Usd,token0Decimals:input.d0,token1Decimals:input.d1,source,blockNumber:input.blockNumber,sourceTimestamp:'',observedAt,freshUntil:new Date(Date.parse(observedAt)+PORTFOLIO_PRICE_TTL_MS).toISOString(),confidence};
}
async function boundedPrice(rpc:FallbackRpc,price:PortfolioPrice|null){if(!price)return null;try{const block=await rpc.withClient(client=>client.getBlock({blockNumber:price.blockNumber}),{stage:'price_preflight',method:'eth_getBlockByNumber'}),sourceTimestamp=new Date(Number(block.timestamp)*1000),age=Date.now()-sourceTimestamp.getTime();if(age<0||age>PORTFOLIO_PRICE_TTL_MS)return null;return {...price,sourceTimestamp:sourceTimestamp.toISOString(),freshUntil:new Date(sourceTimestamp.getTime()+PORTFOLIO_PRICE_TTL_MS).toISOString()};}catch(error){if(isRetryableRpcFailure(error))throw error;return null;}}
function positionResult(input:{positionId:string;tokenId:string;protocol:'v3'|'v4';pair:string;poolId:string;status:string;rangeStatus:PortfolioPosition['rangeStatus'];range:string;currentPrice:OptionalUsd;marketRange?:MarketRangeDisplay;price:PortfolioPrice|null;reason?:string;original:TokenAmounts;principal:TokenAmounts|null;uncollected:TokenAmounts|null;collected:TokenAmounts;withdrawn:TokenAmounts;repo:SqliteLedgerRepository;token0:Address;token1:Address;d0:number;d1:number}):PortfolioPosition{
 const adopted=positionAdoption(input.repo,input.positionId),native=input.repo.v4Position(input.tokenId),botOperational=input.protocol==='v4'&&Boolean(native?.open_intent_id),externalCapitalUsd=executionCapital(input.repo,input.positionId,input.token0,input.token1,input.d0,input.d1),activePrincipalUsd=input.price&&input.principal?valueRaw(input.principal,input.price):input.principal&&zeroAmounts(input.principal)?0:null,uncollectedFeesUsd=input.price&&input.uncollected?valueRaw(input.uncollected,input.price):input.uncollected&&zeroAmounts(input.uncollected)?0:null,collectedFeesUsd=botOperational?historicalValue(input.collected,input.token0,input.token1,input.d0,input.d1):adopted?null:historicalValue(input.collected,input.token0,input.token1,input.d0,input.d1),realizedProceedsUsd=botOperational?historicalValue(input.withdrawn,input.token0,input.token1,input.d0,input.d1):adopted?null:historicalValue(input.withdrawn,input.token0,input.token1,input.d0,input.d1),gasSpentUsd=gasValue(input.repo,input.positionId),accounting=canonicalPortfolioAccounting({externalCapitalUsd,activePrincipalUsd,uncollectedFeesUsd,collectedFeesUsd,realizedProceedsUsd,gasSpentUsd});
 return {positionId:input.positionId,tokenId:input.tokenId,protocol:input.protocol,pair:input.pair,poolId:input.poolId,token0Address:input.token0,token1Address:input.token1,status:input.status,rangeStatus:input.rangeStatus,range:input.range,currentPrice:input.currentPrice,marketRange:input.marketRange,valuationStatus:input.price?'PRICED':'UNPRICED',valuationReason:input.price?undefined:input.reason??'TRUSTED_ONCHAIN_PRICE_UNAVAILABLE',price:input.price??undefined,raw:{originalDeposits:input.original,currentPrincipal:input.principal,uncollectedFees:input.uncollected,collectedFees:input.collected,withdrawnPrincipal:input.withdrawn},accounting,reconciliation:botOperational?'BOT_OPERATIONAL_RECEIPT_LEDGER':adopted?String(adopted.accounting_status):accounting.warnings.length?'PARTIAL':'COMPLETE',adoption:botOperational?{source:'BOT_OPERATIONAL',status:'OPERATIONAL_OPEN',accountingStatus:'RECEIPT_ACCOUNTED',baselineProvenance:'OPERATIONAL_OPEN_RECEIPT',fundingSymbol:String(native?.funding_symbol??null),fundingProvenance:'OPERATIONAL_OPEN_SELECTION'}:adopted?{source:'MANUAL_EXTERNAL',status:'AUTO_ADOPTED',accountingStatus:String(adopted.accounting_status),baselineProvenance:adopted.baseline_provenance,fundingSymbol:adopted.funding_symbol,fundingProvenance:adopted.funding_provenance}:undefined};
}
export async function buildPortfolioAudit(input:{rpc:FallbackRpc;repo:SqliteLedgerRepository;wallet?:Address;positionIds?:readonly string[];v4PositionStates?:ReadonlyMap<string,Promise<Awaited<ReturnType<typeof inspectV4PositionState>>>>;wethUsdReference?:Promise<WethUsdReference>|(()=>Promise<WethUsdReference>);protocolScope?:'v4'}):Promise<PortfolioAudit>{
 const selected=input.positionIds?new Set(input.positionIds):undefined,observedAt=new Date().toISOString(),positions:PortfolioPosition[]=[];let reference:WethUsdReference|undefined,referencePromise:Promise<WethUsdReference>|undefined;
 const resolveWethReference=()=>referencePromise??=(typeof input.wethUsdReference==='function'?input.wethUsdReference():input.wethUsdReference??(input.protocolScope==='v4'?Promise.resolve({status:'unavailable' as const,reason:'V4_WETH_USD_REFERENCE_NOT_CONFIGURED'}):trustedWethUsdReference(input.rpc))).then(value=>(reference=value));
 const priceForPair=async(args:{token0:Address;token1:Address;d0:number;d1:number;sqrtPriceX96:bigint;blockNumber:bigint;poolSource:string})=>{
  const directUsd=args.token0.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()||args.token1.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase(),hasWeth=args.token0.toLowerCase()===robinhoodMainnet.assets.WETH.toLowerCase()||args.token1.toLowerCase()===robinhoodMainnet.assets.WETH.toLowerCase(),resolved=!directUsd&&hasWeth?await resolveWethReference():undefined;
  return boundedPrice(input.rpc,pairPrice({...args,wethUsd:resolved?.status==='available'?resolved.value:undefined,wethSource:resolved?.status==='available'?resolved.source:undefined}));
 };
 const marketRangeFor=async(args:{token0:Address;token1:Address;d0:number;d1:number;tickLower:number;tickUpper:number;price:PortfolioPrice|null})=>{
  const token0IsUsd=args.token0.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase(),token1IsUsd=args.token1.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase(),volatile=token0IsUsd?args.token1:token1IsUsd?args.token0:undefined,decimals=token0IsUsd?args.d1:args.d0;
  let supply:TokenSupplyEvidence|undefined;
  if(volatile&&Number.isInteger(decimals)&&decimals>=0){supply=cachedCirculatingSupply(input.repo,volatile,decimals);if(!supply)try{const raw=await input.rpc.withClient(client=>client.readContract({address:volatile,abi:erc20Abi,functionName:'totalSupply'}),{stage:'portfolio_token_supply',method:'ERC20.totalSupply'}),normalized=Number(raw)/10**decimals;if(finitePositive(normalized))supply={raw:raw.toString(),normalized,kind:'TOTAL',source:'rpc:ERC20.totalSupply',observedAt:new Date().toISOString(),decimals};}catch{/* A missing totalSupply is a display-only unavailable supply evidence result. */}}
  return deriveTokenStableMarketRange({token0:args.token0,token1:args.token1,token0Usd:args.price?.token0Usd??null,token1Usd:args.price?.token1Usd??null,token0Decimals:args.d0,token1Decimals:args.d1,tickLower:args.tickLower,tickUpper:args.tickUpper,supply});
 };
 const v3Rows=input.repo.listPositions().filter(row=>row.id.startsWith('live:')&&(!selected||selected.has(row.id))),deployments=v3Rows.length?await auditRobinhoodV3Deployments(input.rpc):{status:'unavailable' as const,reason:'V3_NOT_SELECTED'};
 for(const row of v3Rows){const positionId=row.id,accounting=input.repo.positionAccounting(positionId),totals=input.repo.collectionTotals(positionId);try{const chain=await inspectV3Position(input.rpc,deployments,BigInt(row.token_id));if(chain.status==='unavailable'){positions.push(positionResult({positionId,tokenId:row.token_id,protocol:'v3',pair:'Unavailable',poolId:row.pool_address,status:'unreconciled',rangeStatus:'UNRECONCILED',range:'Unavailable',currentPrice:null,price:null,reason:chain.reason,original:accounting.deposits,principal:null,uncollected:null,collected:totals.fees,withdrawn:totals.principal,repo:input.repo,token0:robinhoodMainnet.assets.WETH,token1:robinhoodMainnet.assets.USDG,d0:18,d1:6}));continue;}const [view,t0,t1,fees]=await Promise.all([presentPosition(input.rpc,chain.value),inspectErc20(input.rpc,chain.value.token0),inspectErc20(input.rpc,chain.value.token1),input.wallet?simulateUnclaimedFees(input.rpc,deployments,chain.value,input.wallet):Promise.resolve({status:'unavailable' as const,reason:'WALLET_UNAVAILABLE'})]);if(view.status==='unavailable'||t0.status==='unavailable'||t1.status==='unavailable'){throw new Error('V3_POSITION_METADATA_UNAVAILABLE');}const price=await priceForPair({token0:chain.value.token0,token1:chain.value.token1,d0:t0.value.decimals,d1:t1.value.decimals,sqrtPriceX96:chain.value.pool.sqrtPriceX96,blockNumber:chain.value.pool.blockNumber,poolSource:`Uniswap v3 position pool ${chain.value.pool.address}`}),marketRange=await marketRangeFor({token0:chain.value.token0,token1:chain.value.token1,d0:t0.value.decimals,d1:t1.value.decimals,tickLower:chain.value.tickLower,tickUpper:chain.value.tickUpper,price});positions.push(positionResult({positionId,tokenId:row.token_id,protocol:'v3',pair:`${t0.value.symbol}/${t1.value.symbol}`,poolId:chain.value.pool.address,status:chain.value.liquidity>0n?'open':'closed',rangeStatus:chain.value.liquidity===0n?'CLOSED':view.value.inRange?'IN_RANGE':'OUT_OF_RANGE',range:`${view.value.lowerPrice}–${view.value.upperPrice}`,currentPrice:view.value.currentPrice,marketRange,price,original:accounting.deposits,principal:view.value.currentAmounts,uncollected:fees.status==='available'?fees.value:null,collected:totals.fees,withdrawn:totals.principal,repo:input.repo,token0:chain.value.token0,token1:chain.value.token1,d0:t0.value.decimals,d1:t1.value.decimals}));}catch(error){if(!positions.some(position=>position.positionId===positionId))positions.push(positionResult({positionId,tokenId:row.token_id,protocol:'v3',pair:'Unavailable',poolId:row.pool_address,status:'unreconciled',rangeStatus:'UNRECONCILED',range:'Unavailable',currentPrice:null,price:null,reason:error instanceof Error?error.message:String(error),original:accounting.deposits,principal:null,uncollected:null,collected:totals.fees,withdrawn:totals.principal,repo:input.repo,token0:robinhoodMainnet.assets.WETH,token1:robinhoodMainnet.assets.USDG,d0:18,d1:6}));}}
 for(const row of input.repo.listV4Positions().filter(row=>!selected||selected.has(`v4:${String(row.token_id)}`))){
  const tokenId=String(row.token_id),positionId=`v4:${tokenId}`,accounting=input.repo.positionAccounting(positionId),totals=input.repo.collectionTotals(positionId),key=JSON.parse(String(row.pool_key_json)) as V4PoolKey,d0=Number(row.target_index)===0?Number(row.target_decimals):Number(row.funding_decimals),d1=Number(row.target_index)===1?Number(row.target_decimals):Number(row.funding_decimals);
  if(String(row.status)==='burned'){
   const [t0,t1,pool]=await Promise.all([inspectErc20(input.rpc,key.currency0),inspectErc20(input.rpc,key.currency1),inspectV4Pool(input.rpc,key)]);
   if(t0.status==='unavailable'||t1.status==='unavailable'||pool.status==='unavailable'){positions.push(positionResult({positionId,tokenId,protocol:'v4',pair:'Unavailable',poolId:String(row.pool_id),status:'burned',rangeStatus:'CLOSED',range:`${row.tick_lower}–${row.tick_upper}`,currentPrice:null,price:null,reason:'V4_POSITION_METADATA_OR_POOL_UNAVAILABLE',original:accounting.deposits,principal:{token0:0n,token1:0n},uncollected:{token0:0n,token1:0n},collected:totals.fees,withdrawn:totals.principal,repo:input.repo,token0:key.currency0,token1:key.currency1,d0,d1}));continue;}
   const price=await priceForPair({token0:key.currency0,token1:key.currency1,d0:t0.value.decimals,d1:t1.value.decimals,sqrtPriceX96:pool.value.sqrtPriceX96,blockNumber:pool.value.blockNumber,poolSource:`Uniswap v4 position pool ${row.pool_id}`});
   const marketRange=await marketRangeFor({token0:key.currency0,token1:key.currency1,d0:t0.value.decimals,d1:t1.value.decimals,tickLower:Number(row.tick_lower),tickUpper:Number(row.tick_upper),price});positions.push(positionResult({positionId,tokenId,protocol:'v4',pair:`${t0.value.symbol}/${t1.value.symbol}`,poolId:String(row.pool_id),status:'burned',rangeStatus:'CLOSED',range:`${row.tick_lower}–${row.tick_upper}`,currentPrice:priceFromSqrtX96(pool.value.sqrtPriceX96,t0.value.decimals,t1.value.decimals),marketRange,price,original:accounting.deposits,principal:{token0:0n,token1:0n},uncollected:{token0:0n,token1:0n},collected:totals.fees,withdrawn:totals.principal,repo:input.repo,token0:key.currency0,token1:key.currency1,d0:t0.value.decimals,d1:t1.value.decimals}));continue;
  }
  try{
   const state=await (input.v4PositionStates?.get(tokenId)??inspectV4PositionState(input.rpc,BigInt(tokenId))),price=await priceForPair({token0:key.currency0,token1:key.currency1,d0:state.token0.decimals,d1:state.token1.decimals,sqrtPriceX96:state.pool.sqrtPriceX96,blockNumber:state.pool.blockNumber,poolSource:`Uniswap v4 position pool ${row.pool_id}`}),marketRange=await marketRangeFor({token0:key.currency0,token1:key.currency1,d0:state.token0.decimals,d1:state.token1.decimals,tickLower:state.tickLower,tickUpper:state.tickUpper,price});
   positions.push(positionResult({positionId,tokenId,protocol:'v4',pair:`${state.token0.symbol}/${state.token1.symbol}`,poolId:String(row.pool_id),status:String(row.status),rangeStatus:state.rangeState==='in_range'?'IN_RANGE':'OUT_OF_RANGE',range:`${state.tickLower}–${state.tickUpper}`,currentPrice:state.price1Per0,marketRange,price,original:accounting.deposits,principal:state.currentAmounts,uncollected:{token0:state.claimableFees.token0,token1:state.claimableFees.token1},collected:totals.fees,withdrawn:totals.principal,repo:input.repo,token0:key.currency0,token1:key.currency1,d0:state.token0.decimals,d1:state.token1.decimals}));
  }catch(error){if(isRetryableRpcFailure(error))throw error;positions.push(positionResult({positionId,tokenId,protocol:'v4',pair:'Unavailable',poolId:String(row.pool_id),status:'unreconciled',rangeStatus:'UNRECONCILED',range:`${row.tick_lower}–${row.tick_upper}`,currentPrice:null,price:null,reason:error instanceof Error?error.message:String(error),original:accounting.deposits,principal:null,uncollected:null,collected:totals.fees,withdrawn:totals.principal,repo:input.repo,token0:key.currency0,token1:key.currency1,d0,d1}));}
 }
 for(const position of positions){const row=input.repo.db.prepare('SELECT l.*,w.replacement_position_id,w.id workflow_id FROM rebalance_lineages l LEFT JOIN rebalance_workflows w ON w.lineage_id=l.id WHERE l.root_position_id=? OR w.replacement_position_id=? ORDER BY w.updated_at DESC LIMIT 1').get(position.positionId,position.positionId) as Record<string,unknown>|undefined;if(!row)continue;const sums=input.repo.db.prepare("SELECT COALESCE(SUM(CASE WHEN kind='TOPUP_EXTERNAL_CAPITAL' THEN usd_value ELSE 0 END),0) topups,COALESCE(SUM(CASE WHEN kind='USDG_PARKED_SURPLUS' THEN usd_value ELSE 0 END),0) parked FROM rebalance_accounting_events e JOIN rebalance_workflows w ON w.id=e.workflow_id WHERE w.lineage_id=?").get(String(row.id)) as {topups:number;parked:number},replacement=row.replacement_position_id?String(row.replacement_position_id):undefined,originalPrincipalUsd=Number(row.original_principal_usd);position.lineage={lineageId:String(row.id),rootPositionId:String(row.root_position_id),role:position.positionId===String(row.root_position_id)?'ORIGINAL':'REPLACEMENT',originalPrincipalUsd,topUpsUsd:Number(sums.topups),parkedSurplusUsd:Number(sums.parked)};position.accounting=canonicalPortfolioAccounting({...position.accounting,externalCapitalUsd:originalPrincipalUsd+Number(sums.topups)});if(replacement&&position.positionId!==replacement)position.excludedFromAggregateReason='REPLACED_BY_CHILD_POSITION';}
 const aggregate=aggregatePortfolio(positions),warnings=[...(reference?.status==='unavailable'?[`WETH_USD_REFERENCE_UNAVAILABLE:${reference.reason}`]:[]),...(aggregate.partialValuation?['PARTIAL_VALUATION_TOTALS_INCLUDE_PRICED_COMPONENTS_ONLY']:[])];
 return {schemaVersion:1,observedAt,priceTtlMs:PORTFOLIO_PRICE_TTL_MS,positions,aggregate,warnings,pricingPolicy:['Canonical USDG is the USD anchor.','Direct target/USDG uses the fresh position pool price.',input.protocolScope==='v4'?'Target/WETH uses the position pool plus a fresh canonical Uniswap v4 WETH/USDG reference.':'Target/WETH uses the position pool plus a fresh canonical Uniswap v3 WETH/USDG reference.','Historical proceeds and fees remain unavailable unless their event-time USD valuation is recorded.'],mainnetTransactionsSent:0};
}
