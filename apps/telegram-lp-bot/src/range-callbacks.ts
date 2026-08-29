import { formatHumanAmount, type DisplayToken } from './amount-ux.js';

export function v4AmountRangeSelection(input:{state:Record<string,unknown>;range:{upperDropPct:number;lowerDropPct:number};selectionQuote:unknown;fundingBalance:bigint;funding:DisplayToken;rangePricing:string}){
 return {
  state:{...input.state,kind:'v4_amount',fundingBalance:input.fundingBalance.toString(),...input.range,rangeSelectionQuote:input.selectionQuote},
  prompt:[input.rangePricing,'',`Enter ${input.funding.symbol} amount`,`Available capital: ${formatHumanAmount(input.fundingBalance,input.funding.decimals)} ${input.funding.symbol}`].join('\n'),
 };
}
