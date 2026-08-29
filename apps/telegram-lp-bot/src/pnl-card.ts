import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { usdTextToMicros, usdMicrosToText } from "../../cli/src/v4-realized-accounting.js";

export const FUNI_APPROVED_TEMPLATE_REFERENCE=fileURLToPath(new URL("../assets/reference/funi-pnl-template-approved.png",import.meta.url));
export const FUNI_APPROVED_TEMPLATE_SHA256="dce3e5bfa0ecf3b640088eaf7a4987fc0415a0e3bc827223966103a1d07d4dbd";
export const FUNI_WORDMARK_ASSET=fileURLToPath(new URL("../assets/funi-approved-logo.png",import.meta.url));
export const FUNI_WORDMARK_SHA256="cb3a57c7459084487ba8672ca8a41b4c19e5dfec8d92bdaed5e1b6bfd16e2af9";
export const FUNI_RENDERED_LOGO_SIZE=150;
export type FuniCardTone="profit"|"loss"|"flat";
export type FuniPeriodKind="DAILY_PNL"|"WEEKLY_PNL"|"MONTHLY_PNL";
export type FuniCoverage="FULL"|"PARTIAL"|"INCOMPLETE";
export type FuniBadgeKind="coverage"|"outcome";
export type FuniCardFact={label:string;value:string};
export type FuniPositionPrivacyOptions={showCapitalBasis:boolean;showReturnedValue:boolean;showPnlPercent:boolean};
export type FuniPnlCardModel={family:"PERIOD"|"CLOSE";kind:FuniPeriodKind|"CLOSE";tone:FuniCardTone;title:string;periodLabel:string;badge:string;badgeKind:FuniBadgeKind;heroLabel:string;hero:string;facts:FuniCardFact[];notice?:string;metadata:string[]};
export type WibDayWindow={key:string;label:string;startMs:number;endMs:number};
export type WibPeriodWindow={kind:FuniPeriodKind;key:string;label:string;startMs:number;endMs:number};

const WIDTH=1080,HEIGHT=1080,REGULAR="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",BOLD="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",FOOTER="@jajajakbtc · t.me/Jajajakbothouse";
const clean=(value:unknown,max=52)=>String(value??"Unavailable").replace(/[\r\n\t]+/g," ").replace(/[^\x20-\x7e\u00b7\u2013\u2026]/g," ").replace(/\s+/g," ").trim().slice(0,max)||"Unavailable";
const money=(value:bigint)=>{const n=usdMicrosToText(value),negative=n.startsWith("-");return `${negative?"-":value>0n?"+":""}$${Math.abs(Number(n)).toFixed(2)}`;};
const eventMicros=(row:Record<string,unknown>,field:string)=>row[field]===null||row[field]===undefined?null:usdTextToMicros(String(row[field]));
const count=(events:Record<string,unknown>[],kind:string)=>events.filter(row=>String(row.event_kind)===kind).length;
const closeReason=(value:unknown)=>{const text=String(value??"");if(text.startsWith("NORMAL_OPERATOR_CLOSE"))return "Operator close";if(text.startsWith("MANUAL_CLOSE"))return "Manual close";if(text.startsWith("USDG_RESET_REPOSITION"))return "Reposition · USDG reset";return clean(text.replace(/[_-]+/g," "),30);};
const closeDate=(value:unknown)=>clean(value,32).replace(/,?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM))?\b/gi,"").trim();
const wibDate=(date:Date,options:Intl.DateTimeFormatOptions)=>new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Jakarta",...options}).format(date);
const wibTime=(ms:number)=>wibDate(new Date(ms),{hour:"2-digit",minute:"2-digit",hour12:false});

export function wibPeriodWindow(kind:FuniPeriodKind,now=new Date()):WibPeriodWindow{
 const shifted=new Date(now.getTime()+7*3_600_000),y=shifted.getUTCFullYear(),m=shifted.getUTCMonth(),d=shifted.getUTCDate();
 if(kind==="DAILY_PNL"){const startMs=Date.UTC(y,m,d)-7*3_600_000;return {kind,key:`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`,label:wibDate(now,{day:"2-digit",month:"short",year:"numeric"}),startMs,endMs:startMs+86_400_000};}
 if(kind==="WEEKLY_PNL"){const monday=(shifted.getUTCDay()+6)%7,startMs=Date.UTC(y,m,d-monday)-7*3_600_000,endMs=startMs+7*86_400_000,startDate=new Date(startMs+7*3_600_000),endDate=new Date(endMs-1+7*3_600_000),sameMonth=startDate.getUTCFullYear()===endDate.getUTCFullYear()&&startDate.getUTCMonth()===endDate.getUTCMonth(),first=wibDate(new Date(startMs),{day:"2-digit",month:"short"}),last=wibDate(new Date(endMs-1),{day:"2-digit",month:"short",year:"numeric"}),label=sameMonth?`${String(startDate.getUTCDate()).padStart(2,"0")}–${String(endDate.getUTCDate()).padStart(2,"0")} ${wibDate(new Date(endMs-1),{month:"short",year:"numeric"})}`:`${first}–${last}`;return {kind,key:`${y}-W${String(Math.floor((Date.UTC(y,m,d)-Date.UTC(y,0,1))/604800000)+1).padStart(2,"0")}`,label,startMs,endMs};}
 const startMs=Date.UTC(y,m,1)-7*3_600_000,endMs=Date.UTC(y,m+1,1)-7*3_600_000;return {kind,key:`${y}-${String(m+1).padStart(2,"0")}`,label:wibDate(now,{month:"short",year:"numeric"}),startMs,endMs};
}
export function wibDayWindow(now=new Date()):WibDayWindow{const value=wibPeriodWindow("DAILY_PNL",now);return {key:value.key,label:value.label,startMs:value.startMs,endMs:value.endMs};}
export function normalizePositionPrivacy(input:Partial<FuniPositionPrivacyOptions>={}):FuniPositionPrivacyOptions{const showCapitalBasis=input.showCapitalBasis===true,showReturnedValue=showCapitalBasis&&input.showReturnedValue===true;return {showCapitalBasis,showReturnedValue,showPnlPercent:showCapitalBasis&&showReturnedValue&&input.showPnlPercent===true};}

export function periodPnlPresentation(input:{period:WibPeriodWindow;coverageStartMs:number|null;events:Record<string,unknown>[]}){
 const {period,events}=input,start=input.coverageStartMs,available=events.filter(row=>String(row.valuation_status)==="AVAILABLE"),unpriced=events.filter(row=>String(row.valuation_status)!=="AVAILABLE"),closed=available.filter(row=>String(row.event_kind)==="CLOSE").reduce((sum,row)=>sum+(eventMicros(row,"realized_pnl_usd")??0n),0n),fees=available.filter(row=>String(row.event_kind)==="CLAIM").reduce((sum,row)=>sum+(eventMicros(row,"realized_pnl_usd")??0n),0n),pnl=closed+fees;
 const historical=start===null||period.endMs<=start,coverage:FuniCoverage=unpriced.length?"INCOMPLETE":start!==null&&start>period.startMs?"PARTIAL":"FULL",known=coverage!=="FULL"||historical,notice=historical?"Historical realized PnL unavailable":coverage==="INCOMPLETE"?"Valuation incomplete · unpriced events present":coverage==="PARTIAL"?`Coverage partial · tracking started ${wibTime(start!)} WIB`:"Coverage: full";
 const facts:FuniCardFact[]=coverage==="FULL"&&!historical?[{label:"Closed PnL",value:money(closed)},{label:"Claimed fees",value:money(fees)},{label:"Fee claims",value:String(count(events,"CLAIM"))},{label:"Positions closed",value:String(count(events,"CLOSE"))}]:[{label:"Fee claims",value:String(count(events,"CLAIM"))},{label:"Positions closed",value:String(count(events,"CLOSE"))},{label:"Unpriced closes",value:String(unpriced.filter(row=>String(row.event_kind)==="CLOSE").length)},{label:"Unpriced events",value:String(unpriced.length)}];
 const model:FuniPnlCardModel={family:"PERIOD",kind:period.kind,tone:historical?"flat":pnl>0n?"profit":pnl<0n?"loss":"flat",title:period.kind.replace("_PNL","").replace("_"," ")+" PNL",periodLabel:`${period.label} · WIB`,badge:historical?"INCOMPLETE":coverage,badgeKind:"coverage",heroLabel:known?"KNOWN PNL":"REALIZED PNL",hero:historical?"Unavailable":money(pnl),facts,notice,metadata:[FOOTER]};
 const caption=[`FUNI · ${model.title}`,model.periodLabel,`${model.heroLabel}: ${model.hero}`,notice].join("\n");return {status:historical?"HISTORICAL_UNAVAILABLE":coverage,tone:model.tone,caption,knownPnlMicros:pnl,incompleteCount:unpriced.length,card:model};
}
export function dailyPnlPresentation(input:{day:WibDayWindow;coverageStartMs:number|null;events:Record<string,unknown>[]}){return periodPnlPresentation({period:{kind:"DAILY_PNL",...input.day},coverageStartMs:input.coverageStartMs,events:input.events});}

export function lifecyclePnlPresentation(input:{closeEvent:Record<string,unknown>;events:Record<string,unknown>[]}){
 const unique=[...new Map<string,Record<string,unknown>>(input.events.map(row=>[String(row.event_id),row])).values()],available=unique.filter(row=>String(row.valuation_status)==="AVAILABLE"),incomplete=unique.filter(row=>String(row.valuation_status)!=="AVAILABLE"),knownMicros=available.reduce((sum,row)=>sum+(eventMicros(row,"realized_pnl_usd")??0n),0n),feeComponents=unique.filter(row=>String(row.event_kind)==="CLAIM"||String(row.event_id)===String(input.closeEvent.event_id)),feeValues=feeComponents.map(row=>eventMicros(row,"newly_realized_fees_usd")),feeComplete=feeValues.every((value):value is bigint=>value!==null),feeMicros=feeComplete?feeValues.reduce((sum,value)=>sum+value,0n):null,basisMicros=eventMicros(input.closeEvent,"capital_basis_usd"),coverage:FuniCoverage=incomplete.length?(available.length?"PARTIAL":"INCOMPLETE"):"FULL",complete=coverage==="FULL";
 return {coverage,pnl:complete?Number(usdMicrosToText(knownMicros)):null,knownPnl:Number(usdMicrosToText(knownMicros)),basis:basisMicros===null?null:Number(usdMicrosToText(basisMicros)),pct:complete&&basisMicros!==null&&basisMicros>0n?Number(knownMicros*10_000n/basisMicros)/100:null,lpFees:feeMicros===null?null:Number(usdMicrosToText(feeMicros)),incompleteEventIds:incomplete.map(row=>String(row.event_id)),incompleteFeeEventIds:feeComponents.filter((_,index)=>feeValues[index]===null).map(row=>String(row.event_id)),events:unique};
}

export function closePnlCardModel(input:{pair?:unknown;strategy?:unknown;mode?:unknown;pnl:number|null;pct:number|null;basis:number|null;returnedValue:string|null;lpFees?:number|null;held?:string;reason?:unknown;closedAt:string;transactionHash:unknown;coverage?:FuniCoverage;privacy?:Partial<FuniPositionPrivacyOptions>}):FuniPnlCardModel{
 const privacy=normalizePositionPrivacy(input.privacy),coverage=input.coverage??"FULL",tone:FuniCardTone=input.pnl===null||input.pnl===0?"flat":input.pnl>0?"profit":"loss",hero=input.pnl===null?"Unavailable":`${input.pnl>0?"+":input.pnl<0?"-":""}$${Math.abs(input.pnl).toFixed(2)}`,facts:FuniCardFact[]=[];
 facts.push({label:"LP fees",value:input.lpFees===undefined||input.lpFees===null?"Unavailable":`+$${Math.abs(input.lpFees).toFixed(2)}`});
 facts.push({label:"Close reason",value:closeReason(input.reason)},{label:"Held duration",value:clean(input.held??"Unavailable",18)});
 if(privacy.showCapitalBasis)facts.push({label:"Capital basis",value:input.basis===null?"Unavailable":`$${Math.abs(input.basis).toFixed(2)}`});
 if(privacy.showReturnedValue)facts.push({label:"Returned value",value:input.returnedValue===null?"Unavailable":`$${Number(input.returnedValue).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`});
 if(privacy.showPnlPercent)facts.push({label:"PnL %",value:input.pct===null?"Unavailable":`${input.pct>=0?"+":""}${input.pct.toFixed(2)}%`});
 return {family:"CLOSE",kind:"CLOSE",tone,title:"POSITION CLOSED",periodLabel:clean(input.pair??"Pair unavailable",34),badge:coverage!=="FULL"?coverage:tone==="profit"?"PROFIT":tone==="loss"?"LOSS":"BREAKEVEN",badgeKind:coverage==="FULL"?"outcome":"coverage",heroLabel:"REALIZED PNL",hero,facts,metadata:[`Closed at · ${closeDate(input.closedAt)} WIB`,FOOTER]};
}

function crc32(value:Buffer){let c=0xffffffff;for(const b of value){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type:string,body:Buffer){const name=Buffer.from(type),out=Buffer.alloc(12+body.length);out.writeUInt32BE(body.length,0);name.copy(out,4);body.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([name,body])),8+body.length);return out;}
function semanticPng(png:Buffer,semantic:string){const end=8+4+4+13+4;return Buffer.concat([png.subarray(0,end),chunk("tEXt",Buffer.from(`funi_card\0${semantic}`)),png.subarray(end)]);}
function esc(value:string){return clean(value,62).replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/:/g,"\\:").replace(/,/g,"\\,");}
function fit(value:string,size:number,width:number){return Math.max(13,Math.min(size,Math.floor(width/Math.max(1,value.length*.57))));}
function box(out:string[],x:number,y:number,w:number,h:number,color:string,border?:string){out.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill`);if(border)out.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${border}:t=2`);}
function text(out:string[],value:string,x:number,y:number,size:number,color:string,bold=false,width=800,center=false){if(!value)return;const font=bold?BOLD:REGULAR,content=esc(value),fontSize=fit(content,size,width);out.push(`drawtext=fontfile=${font}:text='${content}':expansion=none:fontcolor=${color}:fontsize=${fontSize}:x=${center?`${x}+(${width}-text_w)/2`:x}:y=${center?`${y}+(40-text_h)/2`:y}`);}
export function funiBadgePalette(kind:FuniBadgeKind,badge:string,tone:FuniCardTone){
 if(kind==="coverage")return badge==="FULL"?{fill:"0x123B35",text:"0x2EEA8B",border:"0x8D7258"}:badge==="PARTIAL"?{fill:"0x3B3016",text:"0xE9C46A",border:"0x8D7258"}:{fill:"0x482716",text:"0xF0A15A",border:"0xA86A10"};
 return tone==="profit"?{fill:"0x123B35",text:"0x2EEA8B",border:"0x8D7258"}:tone==="loss"?{fill:"0x3E1B25",text:"0xF05A6A",border:"0x8D7258"}:{fill:"0x1A2432",text:"0xF3F5F7",border:"0x8D7258"};
}

/** Renderer-only layer: it consumes the typed view model and performs no accounting. */
export function renderFuniPnlCard(input:{model:FuniPnlCardModel}){
 if(!existsSync(REGULAR)||!existsSync(BOLD)||!existsSync(FUNI_WORDMARK_ASSET))throw new Error("FUNI_CARD_ASSET_UNAVAILABLE");
 const m=input.model,accent=m.tone==="profit"?"0x2EEA8B":m.tone==="loss"?"0xF05A6A":"0xF3F5F7",badge=funiBadgePalette(m.badgeKind,m.badge,m.tone),f:string[]=[];
 box(f,0,0,WIDTH,HEIGHT,"0x050A12");box(f,22,52,1036,976,"0x07111D","0xD49A11");box(f,50,235,980,m.family==="PERIOD"?274:248,"0x08131F","0xA86A10");
 text(f,m.title,m.family==="PERIOD"?295:318,138,37,"0xF5F4EF",true,470);text(f,m.periodLabel,m.family==="PERIOD"?295:318,184,25,"0xF2C62C",false,530);
 box(f,790,78,210,70,badge.fill,badge.border);text(f,m.badge,790,93,18,badge.text,true,210,true);
 text(f,m.heroLabel,75,275,24,"0xF1C52C",true,900,true);text(f,m.hero,75,330,82,accent,true,900,true);box(f,180,455,720,1,"0xC7B99B");
 if(m.family==="PERIOD"){box(f,50,540,980,245,"0x07101B","0x303B47");m.facts.slice(0,4).forEach((fact,i)=>{const col=i%2,row=Math.floor(i/2),x=85+col*475,y=570+row*98;text(f,fact.label,x,y,21,"0xEDE8DD",false,290);text(f,fact.value,x,y+35,28,"0xF4F7FA",true,315);box(f,x,y+72,385,1,"0x303B47");});box(f,50,810,980,92,"0x07101B","0x303B47");text(f,m.notice??"Coverage: full",75,837,20,"0xE9D6A1",false,880,true);text(f,FOOTER,75,965,21,"0xF1C52C",false,900,true);}else{const grid=m.facts.length>=5;if(grid)m.facts.forEach((fact,i)=>{const col=i%2,row=Math.floor(i/2),x=65+col*475,y=530+row*78;box(f,x,y,460,64,"0x08131F","0x263747");text(f,fact.label,x+28,y+14,17,"0xF1F2F4",false,200);text(f,fact.value,x+28,y+37,20,"0xE8D7B7",false,390);});else{let y=530;for(const fact of m.facts){box(f,65,y,950,64,"0x08131F","0x263747");text(f,fact.label,105,y+20,22,"0xF1F2F4",false,320);text(f,fact.value,510,y+20,22,"0xE8D7B7",false,460);y+=78;}}const metadataY=grid?817:Math.max(837,530+m.facts.length*78+14);text(f,m.metadata[0]??"",90,metadataY,20,"0xF1F2F4",false,850);box(f,65,940,950,1,"0xA86A10");text(f,FOOTER,90,965,21,"0xF1C52C",false,850,true);}
 const graph=`[0:v]${f.join(",")}[card];[1:v]scale=${FUNI_RENDERED_LOGO_SIZE}:${FUNI_RENDERED_LOGO_SIZE}[wordmark];[card][wordmark]overlay=x=62:y=70:format=auto[out]`,result=spawnSync("ffmpeg",["-v","error","-f","lavfi","-i",`color=c=0x050A12:s=${WIDTH}x${HEIGHT}:r=1`,"-i",FUNI_WORDMARK_ASSET,"-filter_complex",graph,"-map","[out]","-frames:v","1","-threads","1","-f","image2pipe","-vcodec","png","pipe:1"],{encoding:null,maxBuffer:12*1024*1024});
 if(result.status!==0||!result.stdout?.length)throw new Error(`FUNI_CARD_RENDER_FAILED:${String(result.stderr??"").slice(0,120)}`);const semantic=[m.title,m.periodLabel,m.badge,m.heroLabel,m.hero,...m.facts.flatMap(x=>[x.label,x.value]),m.notice??"",...m.metadata].join(" | ");return semanticPng(Buffer.from(result.stdout),semantic);
}
