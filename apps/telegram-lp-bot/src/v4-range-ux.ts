import { validateV4DownsideRange, type V4DownsideRangeRequest } from '@funi/v4';
import type { SqliteLedgerRepository } from '@funi/ledger';

export const V4_RANGE_PRESETS=[10,30,50,60] as const;
export function v4RangeButtons(selectionId:string){return [...V4_RANGE_PRESETS.map(value=>[{label:`USDG-only current → -${value}%`,data:`v4-spot-range:${selectionId}:${value}`}]),[{label:'USDG-only Custom range',data:`v4-spot-range:${selectionId}:custom`}]];}
export function parseV4RangeChoice(value:string):V4DownsideRangeRequest|'custom'{if(value==='custom')return 'custom';const range={upperDropPct:0,lowerDropPct:Number(value)};return validateV4DownsideRange(range);}
export function parseV4CustomRange(value:string){const pair=value.split(',').map(x=>Number(x.trim()));if(pair.length!==2||!pair.every(Number.isFinite))throw new Error('Enter two percentages as start,finish, for example 30,60.');return validateV4DownsideRange({upperDropPct:pair[0]!,lowerDropPct:pair[1]!});}

export type TrustedMarketMetric={
 kind:'market_cap'|'fdv';valueUsd:number;observedAtMs:number;provenance:string;
 constantSupplyBasis:{kind:'circulating'|'total';value:number}|null;
};
export type V4RangeSelectionQuote={currentPriceUsd:number;marketMetric:TrustedMarketMetric|null;quoteBlock:bigint;quoteTimestampMs:number};
export type V4RangePricing=V4RangeSelectionQuote&{
 range:V4DownsideRangeRequest;upperPriceUsd:number;lowerPriceUsd:number;upperMetricUsd:number|null;lowerMetricUsd:number|null;
 selected?:V4RangeSelectionQuote;recalculated:boolean;
};

const finitePositive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;
export function orientedTokenPrice(poolPriceToken1PerToken0:number,targetIndex:0|1){
 if(!finitePositive(poolPriceToken1PerToken0))throw new Error('V4_TOKEN_PRICE_UNAVAILABLE');
 return targetIndex===0?poolPriceToken1PerToken0:1/poolPriceToken1PerToken0;
}
export function readTrustedMarketMetric(repo:SqliteLedgerRepository,token:string,nowMs=Date.now(),maxAgeMs=30*60_000):TrustedMarketMetric|null{
 const row=repo.db.prepare('SELECT observed_at_ms,market_cap_usd,source_json FROM gmgn_robinhood_observations WHERE lower(token_address)=lower(?) ORDER BY observed_at_ms DESC LIMIT 1').get(token) as {observed_at_ms:number;market_cap_usd:number|null;source_json:string}|undefined;
 if(!row||row.observed_at_ms>nowMs||nowMs-row.observed_at_ms>maxAgeMs)return null;
 let source:Record<string,unknown>={};try{source=JSON.parse(row.source_json);}catch{return null;}
 const rawBasis=source.supplyBasis as Record<string,unknown>|undefined,basisKind=rawBasis?.kind,constantSupplyBasis:TrustedMarketMetric['constantSupplyBasis']=(basisKind==='circulating'||basisKind==='total')&&finitePositive(rawBasis?.value)?{kind:basisKind,value:rawBasis.value}:null;
 const explicitKind=source.marketMetricKind;
 if(explicitKind==='fdv'&&finitePositive(source.fdvUsd))return {kind:'fdv',valueUsd:source.fdvUsd,observedAtMs:row.observed_at_ms,provenance:String(source.marketMetricProvenance??source.marketCapProvenance??'trusted cached FDV'),constantSupplyBasis};
 if((explicitKind==='market_cap'||source.marketCapProvenance==='trending_market_cap')&&finitePositive(row.market_cap_usd))return {kind:'market_cap',valueUsd:row.market_cap_usd,observedAtMs:row.observed_at_ms,provenance:String(source.marketMetricProvenance??source.marketCapProvenance??'trusted cached market cap'),constantSupplyBasis};
 return null;
}
export function buildV4RangePricing(input:{currentPriceUsd:number;range:V4DownsideRangeRequest;marketMetric:TrustedMarketMetric|null;quoteBlock:bigint;quoteTimestampMs:number;upperPriceUsd?:number;lowerPriceUsd?:number;selected?:V4RangeSelectionQuote;recalculated?:boolean}):V4RangePricing{
 validateV4DownsideRange(input.range);
 if(!finitePositive(input.currentPriceUsd)||!Number.isFinite(input.quoteTimestampMs)||input.quoteTimestampMs<=0)throw new Error('V4_RANGE_QUOTE_INVALID');
 const requestedUpper=input.currentPriceUsd*(1-input.range.upperDropPct/100),requestedLower=input.currentPriceUsd*(1-input.range.lowerDropPct/100),upperPriceUsd=input.upperPriceUsd??requestedUpper,lowerPriceUsd=input.lowerPriceUsd??requestedLower;
 if(!finitePositive(upperPriceUsd)||!finitePositive(lowerPriceUsd)||upperPriceUsd<=lowerPriceUsd)throw new Error('V4_RANGE_PRICE_BOUNDARIES_INVALID');
 const canDerive=Boolean(input.marketMetric?.constantSupplyBasis)&&finitePositive(input.marketMetric?.valueUsd),upperMetricUsd=canDerive?input.marketMetric!.valueUsd*upperPriceUsd/input.currentPriceUsd:null,lowerMetricUsd=canDerive?input.marketMetric!.valueUsd*lowerPriceUsd/input.currentPriceUsd:null;
 return {currentPriceUsd:input.currentPriceUsd,marketMetric:input.marketMetric,quoteBlock:input.quoteBlock,quoteTimestampMs:input.quoteTimestampMs,range:input.range,upperPriceUsd,lowerPriceUsd,upperMetricUsd,lowerMetricUsd,selected:input.selected,recalculated:Boolean(input.recalculated)};
}
const price=(value:number)=>`$${value>=1?value.toLocaleString('en-US',{maximumFractionDigits:4}):value.toFixed(8).replace(/0+$/,'').replace(/\.$/,'')}`;
const compactUsd=(value:number)=>value>=1_000_000_000?`$${(value/1_000_000_000).toFixed(2)}B`:value>=1_000_000?`$${(value/1_000_000).toFixed(2)}M`:value>=1_000?`$${(value/1_000).toFixed(value>=100_000?0:1)}k`:`$${value.toFixed(2)}`;
const movement=(from:number,to:number)=>`${price(from)} → ${price(to)} (${((to/from-1)*100).toFixed(1)}%)`;
export function formatV4RangePricing(quote:V4RangePricing){
 const metricLabel=quote.marketMetric?.kind==='fdv'?'FDV':'market cap',lines=[
  `Current token price: ${price(quote.currentPriceUsd)}`,
  `Current ${metricLabel}: ${quote.marketMetric?`~${compactUsd(quote.marketMetric.valueUsd)}`:'Unavailable'}`,
  `LP price range: ${price(quote.upperPriceUsd)} → ${price(quote.lowerPriceUsd)}`,
  `Estimated ${metricLabel} range: ${quote.upperMetricUsd!==null&&quote.lowerMetricUsd!==null?`~${compactUsd(quote.upperMetricUsd)} → ~${compactUsd(quote.lowerMetricUsd)}`:'Unavailable'}`,
  `Selected range: -${quote.range.upperDropPct}% → -${quote.range.lowerDropPct}%`,
  `Quote: ${new Date(quote.quoteTimestampMs).toISOString()} · block ${quote.quoteBlock}`,
 ];
 if(quote.selected){
  lines.push(`Price movement since selection: ${movement(quote.selected.currentPriceUsd,quote.currentPriceUsd)}`);
  if(quote.selected.marketMetric&&quote.marketMetric&&quote.selected.marketMetric.kind===quote.marketMetric.kind)lines.push(`Market movement since selection: ~${compactUsd(quote.selected.marketMetric.valueUsd)} → ~${compactUsd(quote.marketMetric.valueUsd)} (${((quote.marketMetric.valueUsd/quote.selected.marketMetric.valueUsd-1)*100).toFixed(1)}%)`);
  else lines.push('Market movement since selection: Unavailable');
 }
 if(quote.recalculated)lines.push('Range recalculated from the fresh current price.');
 return lines.join('\n');
}
