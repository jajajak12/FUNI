export type FinalActionState='PREVIEWED'|'PROCESSING'|'COMPLETED'|'FAILED';
/** A preview clock can reject an unused button, but never overrides an already-claimed durable intent. */
export function finalActionDisposition(input:{expiresAtMs:number;nowMs:number;state:string}){
  if(input.state!=='PREVIEWED')return input.state==='COMPLETED'?{status:'ALREADY_COMPLETED' as const}:{status:'ALREADY_PROCESSING' as const};
  if(!Number.isFinite(input.expiresAtMs)||input.expiresAtMs<=input.nowMs)return {status:'PREVIEW_EXPIRED' as const};
  return {status:'CLAIMABLE' as const};
}
