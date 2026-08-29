import { getAddress, type Address } from 'viem';
import { gmgnCliJson } from '../../shared/gmgn-market.js';

export const LP_ENTRY_PRICE_PREVIEW_TTL_MS=30_000;
export const LP_ENTRY_PRICE_COOLDOWN_MS=10_000;
export const LP_ENTRY_PRICE_DIVERGENCE_LIMIT_BPS=1_000n;

export type GmgnEntryPriceEvidence={
 token:Address;
 priceUsd:string;
 source:'gmgn-token-info-price.price';
 fetchedAtMs:number;
 freshUntilMs:number;
};
export type LpEntryPriceGuardResult={
 status:'PASS'|'BLOCK';
 poolPriceFundingPerTarget:string;
 tokenPriceFundingPerTarget:string|null;
 deviationBps:bigint|null;
 blocker:string|null;
 evidence?:GmgnEntryPriceEvidence;
};

type Rational={numerator:bigint;denominator:bigint};
function rational(value:string|number):Rational{
 const source=String(value).trim().toLowerCase(),match=/^([+]?(?:\d+(?:\.\d*)?|\.\d+))(?:e([+-]?\d+))?$/.exec(source);
 if(!match)throw new Error('LP_ENTRY_PRICE_INVALID');
 const [whole='0',fraction='']=(match[1]!.replace('+','').startsWith('.')?`0${match[1]}`:match[1]!).split('.'),exponent=Number(match[2]??0);
 if(!Number.isSafeInteger(exponent)||exponent<-100||exponent>100)throw new Error('LP_ENTRY_PRICE_INVALID');
 let numerator=BigInt(`${whole}${fraction}`),denominator=10n**BigInt(fraction.length);
 if(exponent>0)numerator*=10n**BigInt(exponent);else if(exponent<0)denominator*=10n**BigInt(-exponent);
 if(numerator<=0n)throw new Error('LP_ENTRY_PRICE_INVALID');
 return {numerator,denominator};
}
function decimal(r:Rational,places=18){
 const whole=r.numerator/r.denominator,remainder=r.numerator%r.denominator,fraction=(remainder*10n**BigInt(places)/r.denominator).toString().padStart(places,'0').replace(/0+$/,'');
 return fraction?`${whole}.${fraction}`:whole.toString();
}
function divide(a:Rational,b:Rational):Rational{return {numerator:a.numerator*b.denominator,denominator:a.denominator*b.numerator};}

export function evaluateLpEntryPriceGuard(input:{poolPriceFundingPerTarget:string|number;gmgnTargetUsd?:string|number|null;fundingUsd?:string|number|null;evidence?:GmgnEntryPriceEvidence}):LpEntryPriceGuardResult{
 let pool:Rational;try{pool=rational(input.poolPriceFundingPerTarget);}catch{return {status:'BLOCK',poolPriceFundingPerTarget:String(input.poolPriceFundingPerTarget),tokenPriceFundingPerTarget:null,deviationBps:null,blocker:'POOL_PRICE_INVALID'};}
 if(input.gmgnTargetUsd===null||input.gmgnTargetUsd===undefined)return {status:'BLOCK',poolPriceFundingPerTarget:decimal(pool),tokenPriceFundingPerTarget:null,deviationBps:null,blocker:'GMGN_TOKEN_PRICE_MISSING'};
 if(input.fundingUsd===null||input.fundingUsd===undefined)return {status:'BLOCK',poolPriceFundingPerTarget:decimal(pool),tokenPriceFundingPerTarget:null,deviationBps:null,blocker:'FUNDING_PRICE_UNAVAILABLE'};
 let token:Rational;try{token=divide(rational(input.gmgnTargetUsd),rational(input.fundingUsd));}catch{return {status:'BLOCK',poolPriceFundingPerTarget:decimal(pool),tokenPriceFundingPerTarget:null,deviationBps:null,blocker:'GMGN_TOKEN_PRICE_INVALID'};}
 const left=pool.numerator*token.denominator,right=token.numerator*pool.denominator,difference=left>=right?left-right:right-left,denominator=token.numerator*pool.denominator,deviationBps=difference*10_000n/denominator,status=deviationBps<LP_ENTRY_PRICE_DIVERGENCE_LIMIT_BPS?'PASS':'BLOCK';
 return {status,poolPriceFundingPerTarget:decimal(pool),tokenPriceFundingPerTarget:decimal(token),deviationBps,blocker:status==='BLOCK'?'PRICE_DIVERGENCE_AT_OR_ABOVE_1000_BPS':null,evidence:input.evidence};
}

export function orientPoolPriceFundingPerTarget(input:{priceToken1PerToken0:number;token0:Address|string;token1:Address|string;target:Address|string;funding:Address|string}){
 const t0=String(input.token0).toLowerCase(),t1=String(input.token1).toLowerCase(),target=String(input.target).toLowerCase(),funding=String(input.funding).toLowerCase();
 if(!Number.isFinite(input.priceToken1PerToken0)||input.priceToken1PerToken0<=0)throw new Error('POOL_PRICE_INVALID');
 if(target===t0&&funding===t1)return input.priceToken1PerToken0;
 if(target===t1&&funding===t0)return 1/input.priceToken1PerToken0;
 throw new Error('POOL_PRICE_ORIENTATION_INVALID');
}

export async function fetchCanonicalGmgnEntryPrice(token:Address,options:{now?:()=>number;invoke?:(args:string[],timeoutMs?:number)=>Promise<unknown>}={}):Promise<GmgnEntryPriceEvidence>{
 const requested=getAddress(token),value=await (options.invoke??gmgnCliJson)(['token','info','--chain','robinhood','--address',requested,'--raw'],15_000);
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('GMGN_TOKEN_PRICE_RESPONSE_INVALID');
 const row=value as Record<string,unknown>;let returned:Address;try{returned=getAddress(String(row.address));}catch{throw new Error('GMGN_TOKEN_PRICE_IDENTITY_INVALID');}
 if(returned.toLowerCase()!==requested.toLowerCase())throw new Error('GMGN_TOKEN_PRICE_IDENTITY_INVALID');
 const price=row.price&&typeof row.price==='object'&&!Array.isArray(row.price)?(row.price as Record<string,unknown>).price:undefined;
 try{rational(String(price));}catch{throw new Error('GMGN_TOKEN_PRICE_INVALID');}
 const fetchedAtMs=(options.now??Date.now)();if(!Number.isSafeInteger(fetchedAtMs)||fetchedAtMs<0)throw new Error('GMGN_TOKEN_PRICE_CLOCK_INVALID');
 return {token:requested,priceUsd:String(price),source:'gmgn-token-info-price.price',fetchedAtMs,freshUntilMs:fetchedAtMs+LP_ENTRY_PRICE_PREVIEW_TTL_MS};
}

/** Always calls GMGN. This function is the final OPEN preflight boundary. */
export async function freshLpEntryPriceGuard(input:{target:Address;poolPriceFundingPerTarget:string|number;fundingUsd:string|number;fetch?:(token:Address)=>Promise<GmgnEntryPriceEvidence>}){
 try{const evidence=await (input.fetch??fetchCanonicalGmgnEntryPrice)(input.target);return evaluateLpEntryPriceGuard({poolPriceFundingPerTarget:input.poolPriceFundingPerTarget,gmgnTargetUsd:evidence.priceUsd,fundingUsd:input.fundingUsd,evidence});}
 catch(error){return {status:'BLOCK',poolPriceFundingPerTarget:String(input.poolPriceFundingPerTarget),tokenPriceFundingPerTarget:null,deviationBps:null,blocker:error instanceof Error?error.message:'GMGN_TOKEN_PRICE_REQUEST_FAILED'} as LpEntryPriceGuardResult;}
}

export function priceGuardCooldown(input:{nowMs:number;blocked:boolean;existingUntilMs?:number|null}){
 if(!Number.isSafeInteger(input.nowMs)||input.nowMs<0)throw new Error('LP_ENTRY_PRICE_COOLDOWN_CLOCK_INVALID');
 const activeUntil=input.existingUntilMs??0;
 if(activeUntil>input.nowMs)return {allowed:false,untilMs:activeUntil,remainingMs:activeUntil-input.nowMs};
 if(input.blocked)return {allowed:false,untilMs:input.nowMs+LP_ENTRY_PRICE_COOLDOWN_MS,remainingMs:LP_ENTRY_PRICE_COOLDOWN_MS};
 return {allowed:true,untilMs:0,remainingMs:0};
}

export function formatLpEntryPriceGuard(result:LpEntryPriceGuardResult){
 const difference=result.deviationBps===null?'unavailable':`${Number(result.deviationBps)/100}%`;
 return [`Pool Price: ${result.poolPriceFundingPerTarget}`,`Token Price: ${result.tokenPriceFundingPerTarget??'TOKEN_PRICE_REFERENCE_UNAVAILABLE'}`,`Difference: ${difference}`,result.status==='PASS'?'Price safety: PASS':'⚠️ PRICE MISMATCH\nEntry blocked.\nRetry available in 10s.'].join('\n');
}
