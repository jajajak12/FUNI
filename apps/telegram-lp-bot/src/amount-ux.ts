export type DisplayToken={symbol:string;address:string;decimals:number};
const shortAddress=(address:string)=>`${address.slice(0,6)}…${address.slice(-4)}`;
/** Symbol is presentation only; an ambiguous symbol always carries its address. */
export function tokenLabel(token:DisplayToken, sibling?:DisplayToken):string{
 const symbol=token.symbol.trim();
 const suspicious=!symbol||symbol.length>12||!/^[A-Za-z0-9._-]+$/.test(symbol)||sibling?.symbol.trim().toLowerCase()===symbol.toLowerCase();
 return suspicious?`TOKEN (${shortAddress(token.address)})`:symbol;
}
/** Decimal parser equivalent to parseUnits without using floating-point token quantities. */
export function parseHumanAmount(input:string,decimals:number):bigint{
 const value=input.trim();
 if(!Number.isInteger(decimals)||decimals<0||decimals>255)throw new Error('token decimals are invalid');
 const match=/^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
 if(!match)throw new Error('Enter a positive decimal amount such as 0.001, 1, or 12.5.');
 const [,whole,fraction='']=match;
 if(fraction.length>decimals)throw new Error(`This token supports at most ${decimals} decimal places.`);
 const raw=BigInt(whole)*10n**BigInt(decimals)+BigInt((fraction+'0'.repeat(decimals)).slice(0,decimals)||'0');
 if(raw<=0n)throw new Error('Amount must be greater than zero.');
 return raw;
}
export function formatHumanAmount(raw:bigint,decimals:number,maxFraction=6):string{
 const negative=raw<0n,absolute=negative?-raw:raw,scale=10n**BigInt(decimals),whole=absolute/scale,fraction=(absolute%scale).toString().padStart(decimals,'0').slice(0,Math.min(decimals,maxFraction)).replace(/0+$/,'');
 return `${negative?'-':''}${whole}${fraction?`.${fraction}`:''}`;
}
export function amountPrompt(token:DisplayToken,balance:bigint,sibling?:DisplayToken):string{
 const label=tokenLabel(token,sibling);return `Enter ${label} amount\nBalance: ${formatHumanAmount(balance,token.decimals)} ${label}\nExample: ${token.decimals>=3?'0.001':'1'}`;
}
export function parseAmountMessage(text:string):string|undefined{
 const trimmed=text.trim();if(trimmed.startsWith('/amount')){const rest=trimmed.slice('/amount'.length).trim();return rest||undefined;}return trimmed;
}
export function isEvmAddressText(text:string):boolean{return /^0x[0-9a-fA-F]{40}$/.test(text.trim());}
export function routeTelegramText(activeKind:string|undefined,text:string):'amount'|'token'|'other'{
 const trimmed=text.trim();if(isEvmAddressText(trimmed))return 'token';
 if(trimmed.startsWith('/amount')||activeKind==='amount')return 'amount';
 return 'other';
}
export function assertAmountWithinBalance(raw:bigint,balance:bigint){if(raw>balance)throw new Error('Amount exceeds wallet balance.');}
export function assertCanaryValue(estimatedUsd:number,maxUsd:number){if(!Number.isFinite(estimatedUsd)||estimatedUsd>maxUsd)throw new Error(`Estimated position value exceeds the $${maxUsd} canary cap.`);}
export function pairedAmountMessage(input:{token0:DisplayToken;token1:DisplayToken;enteredIndex:0|1;enteredRaw:bigint;required0:bigint;required1:bigint;balance0:bigint;balance1:bigint;range:number}):string{
 const entered=input.enteredIndex===0?input.token0:input.token1,paired=input.enteredIndex===0?input.token1:input.token0,enteredRaw=input.enteredIndex===0?input.required0:input.required1,pairedRaw=input.enteredIndex===0?input.required1:input.required0;
 return [`Selected pool: ${tokenLabel(input.token0,input.token1)} / ${tokenLabel(input.token1,input.token0)}`,`Range: ±${input.range}%`,'',`You enter:`,`${formatHumanAmount(enteredRaw,entered.decimals)} ${tokenLabel(entered,paired)}`,'',`Required paired asset:`,`${formatHumanAmount(pairedRaw,paired.decimals)} ${tokenLabel(paired,entered)}`,'',`Wallet balances:`,`${tokenLabel(input.token0,input.token1)}: ${formatHumanAmount(input.balance0,input.token0.decimals)}`,`${tokenLabel(input.token1,input.token0)}: ${formatHumanAmount(input.balance1,input.token1.decimals)}`].join('\n');
}
