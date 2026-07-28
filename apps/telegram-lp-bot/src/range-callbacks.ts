import { formatHumanAmount, type DisplayToken } from './amount-ux.js';

export type RangeCallback=
 | {kind:'v4_open_range';selectionId:string;value:'10'|'30'|'50'|'60'|'custom'}
 | {kind:'rebalance_range';value:'10'|'30'|'50'|'60'|'custom'};

/**
 * Callback namespaces are deliberately parsed as a closed set.  In particular,
 * a rebalance range has no selection id, while an open range always has one.
 */
export function parseRangeCallback(data:string):RangeCallback|undefined{
 const open=/^v4-range:([^:]+):(10|30|50|60|custom)$/.exec(data);
 if(open)return {kind:'v4_open_range',selectionId:open[1]!,value:open[2]! as RangeCallback['value']};
 const rebalance=/^rebalance-range:(10|30|50|60|custom)$/.exec(data);
 if(rebalance)return {kind:'rebalance_range',value:rebalance[1]! as RangeCallback['value']};
 return undefined;
}

export async function dispatchRangeCallback(data:string,handlers:{open:(selectionId:string,value:'10'|'30'|'50'|'60'|'custom')=>Promise<unknown>;rebalance:(value:'10'|'30'|'50'|'60'|'custom')=>Promise<unknown>}){
 const callback=parseRangeCallback(data);
 if(!callback)return false;
 if(callback.kind==='v4_open_range')await handlers.open(callback.selectionId,callback.value);
 else await handlers.rebalance(callback.value);
 return true;
}

export function v4AmountRangeSelection(input:{state:Record<string,unknown>;range:{upperDropPct:number;lowerDropPct:number};selectionQuote:unknown;fundingBalance:bigint;funding:DisplayToken;rangePricing:string}){
 return {
  state:{...input.state,kind:'v4_amount',fundingBalance:input.fundingBalance.toString(),...input.range,rangeSelectionQuote:input.selectionQuote},
  prompt:[input.rangePricing,'',`Enter ${input.funding.symbol} amount`,`Available capital: ${formatHumanAmount(input.fundingBalance,input.funding.decimals)} ${input.funding.symbol}`].join('\n'),
 };
}
