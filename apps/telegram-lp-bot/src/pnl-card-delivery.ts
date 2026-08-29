import { SqliteLedgerRepository } from "@funi/ledger";
import { closePnlCardModel, lifecyclePnlPresentation, renderFuniPnlCard } from "./pnl-card.js";

export type PnlCardConsumerSource="TELEGRAM_EVENT_DRIVEN"|"RECONCILE_FALLBACK";
type SendResult={delivered:boolean;messageId:number|null;retryable?:boolean;failureCode?:string};
type DeliveryTelemetry=(event:string,details:Record<string,unknown>)=>void;

const number=(value:unknown)=>Number(value), text=(value:unknown)=>String(value??"");
const safeTelemetry=(emit:DeliveryTelemetry|undefined,event:string,details:Record<string,unknown>)=>{try{emit?.(event,details);}catch{}};
const withRepo=<T>(open:()=>SqliteLedgerRepository,work:(repo:SqliteLedgerRepository)=>T)=>{const repo=open();try{return work(repo);}finally{repo.close();}};

function closeCardTruth(repo:SqliteLedgerRepository,economicEventId:string){
  const event=repo.db.prepare("SELECT * FROM realized_pnl_events WHERE event_id=? AND event_kind='CLOSE'").get(economicEventId) as Record<string,unknown>|undefined;
  if(!event)throw new Error("PNL_CARD_CLOSE_EVENT_NOT_READY");
  const lifecycleIdentity=text(event.ladder_identity??event.workflow_identity),events=repo.db.prepare("SELECT * FROM realized_pnl_events WHERE COALESCE(ladder_identity,workflow_identity)=? AND event_kind IN ('CLAIM','CLOSE') AND economic_final_at_ms<=? ORDER BY economic_final_at_ms,event_id").all(lifecycleIdentity,number(event.economic_final_at_ms)) as Record<string,unknown>[],
    lifecycle=lifecyclePnlPresentation({closeEvent:event,events}),meta=event.presentation_metadata_json?JSON.parse(text(event.presentation_metadata_json)) as Record<string,unknown>:{},
    when=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Jakarta",dateStyle:"medium"}).format(new Date(number(event.economic_final_at_ms))),opened=typeof meta.openedAt==="string"?Date.parse(meta.openedAt):NaN,
    held=Number.isFinite(opened)?`${Math.max(0,Math.floor((number(event.economic_final_at_ms)-opened)/3_600_000))}h`:"Unavailable",returnedValue=meta.returnedValueUsd===null||meta.returnedValueUsd===undefined?null:text(meta.returnedValueUsd),
    caption=["FUNI · POSITION CLOSED",text(meta.pair||"Pair unavailable"),`Closed: ${when} · WIB`,`Coverage: ${lifecycle.coverage}`].join("\n"),
    model=closePnlCardModel({pair:meta.pair,strategy:meta.strategy,mode:meta.mode,pnl:lifecycle.pnl,pct:lifecycle.pct,basis:lifecycle.basis,returnedValue,lpFees:lifecycle.lpFees,coverage:lifecycle.coverage,held,reason:event.close_reason,closedAt:when,transactionHash:event.transaction_hash,privacy:{showCapitalBasis:false,showReturnedValue:false,showPnlPercent:false}});
  return {event,lifecycleIdentity,caption,model};
}

export async function drainClosePnlCardDeliveries(input:{
  openRepository:()=>SqliteLedgerRepository;
  sendPhoto:(png:Buffer,caption:string,category:string)=>Promise<SendResult>;
  sendMessage:(text:string,category:string)=>Promise<SendResult>;
  consumerSource:PnlCardConsumerSource;
  telemetry?:DeliveryTelemetry;
  now?:()=>number;
  limit?:number;
  leaseTimeoutMs?:number;
  retryDelayMs?:number;
  recoverClaims?:boolean;
}){
  const now=input.now??Date.now,limit=Math.max(1,Math.min(8,input.limit??8)),leaseTimeoutMs=input.leaseTimeoutMs??30_000,retryDelayMs=input.retryDelayMs??5_000,
    recovery=input.recoverClaims===false?{definitelyUnsent:0,ambiguous:0}:withRepo(input.openRepository,repo=>repo.recoverPnlCardDeliveryClaims(now(),leaseTimeoutMs)),
    due=withRepo(input.openRepository,repo=>repo.duePnlCardDeliveries({nowMs:now(),retryDelayMs,limit})),results:Array<Record<string,unknown>>=[];
  for(const candidate of due){
    const deliveryId=text(candidate.delivery_id),claimed=withRepo(input.openRepository,repo=>repo.claimPnlCardDelivery(deliveryId,input.consumerSource));
    if(!claimed)continue;
    const claimedAt=number(claimed.attempted_at_ms),attempt=number(claimed.attempt_count),economicEventId=text(claimed.economic_event_id);
    let truth:ReturnType<typeof closeCardTruth>;
    try{truth=withRepo(input.openRepository,repo=>closeCardTruth(repo,economicEventId));}
    catch(error){
      withRepo(input.openRepository,repo=>repo.finalizePnlCardDelivery({deliveryId,delivered:false,retryable:true,renderStatus:"FAILED",errorCode:error instanceof Error?error.message:"PNL_CARD_TRUTH_NOT_READY"}));
      results.push({deliveryId,economicEventId,status:"RETRYABLE_NOT_READY",attempt});continue;
    }
    const economicFinalAtMs=number(truth.event.economic_final_at_ms),eventPersistedAtMs=number(truth.event.created_at_ms),deliveryEnsuredAtMs=number(claimed.created_at_ms),renderStartedAtMs=now();
    let png:Buffer|undefined;
    try{png=renderFuniPnlCard({model:truth.model});}catch{}
    const renderEndedAtMs=now(),telegramSendStartedAtMs=now();
    withRepo(input.openRepository,repo=>repo.markPnlCardDeliverySendStarted(deliveryId,telegramSendStartedAtMs));
    try{
      const sent=png?await input.sendPhoto(png,truth.caption,"funi_close_pnl_card"):await input.sendMessage(truth.caption,"funi_close_pnl_text_fallback"),deliveredAtMs=now();
      withRepo(input.openRepository,repo=>repo.finalizePnlCardDelivery({deliveryId,delivered:sent.delivered,retryable:!sent.delivered&&sent.retryable===true,messageId:sent.messageId,renderStatus:png?"RENDERED":"FALLBACK_TEXT",errorCode:sent.failureCode}));
      const totalCloseToDeliveredMs=deliveredAtMs-economicFinalAtMs,telemetry={economicEventId,ladderId:truth.lifecycleIdentity,deliveryId,economicFinalAtMs,eventPersistedAtMs,deliveryEnsuredAtMs,deliveryClaimedAtMs:claimedAt,renderStartedAtMs,renderEndedAtMs,telegramSendStartedAtMs,deliveredAtMs:sent.delivered?deliveredAtMs:null,totalCloseToDeliveredMs:sent.delivered?totalCloseToDeliveredMs:null,attempt,consumerSource:input.consumerSource,sla:sent.delivered?(totalCloseToDeliveredMs<30_000?"PASS":"FAIL"):null,accountingReadyToClaimMs:claimedAt-eventPersistedAtMs,renderMs:renderEndedAtMs-renderStartedAtMs,telegramSendMs:deliveredAtMs-telegramSendStartedAtMs};
      safeTelemetry(input.telemetry,"pnl_card_delivery",telemetry);results.push({...telemetry,status:sent.delivered?"DELIVERED":sent.retryable?"RETRYABLE":"FAILED"});
    }catch(error){
      withRepo(input.openRepository,repo=>repo.finalizePnlCardDelivery({deliveryId,delivered:false,uncertain:true,renderStatus:png?"RENDERED":"FALLBACK_TEXT",errorCode:"TELEGRAM_TRANSPORT_UNCERTAIN"}));
      safeTelemetry(input.telemetry,"pnl_card_delivery",{economicEventId,ladderId:truth.lifecycleIdentity,deliveryId,economicFinalAtMs,eventPersistedAtMs,deliveryEnsuredAtMs,deliveryClaimedAtMs:claimedAt,renderStartedAtMs,renderEndedAtMs,telegramSendStartedAtMs,deliveredAtMs:null,totalCloseToDeliveredMs:null,attempt,consumerSource:input.consumerSource,sla:null,accountingReadyToClaimMs:claimedAt-eventPersistedAtMs,renderMs:renderEndedAtMs-renderStartedAtMs,telegramSendMs:now()-telegramSendStartedAtMs,status:"DELIVERY_UNCERTAIN"});
      results.push({deliveryId,economicEventId,status:"DELIVERY_UNCERTAIN",attempt});
    }
  }
  return {recovery,examined:due.length,claimed:results.length,results};
}
