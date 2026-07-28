import type { SqliteLedgerRepository } from '@robin/ledger';

export type SafetyRuntime={
 chainId:number;executionEnabled:boolean;dryRun:boolean;emergencyPause:boolean;
};
type SafetyState=Record<string,unknown>;
type RepositoryFactory=(path:string)=>SqliteLedgerRepository;

function state(repo:SqliteLedgerRepository,runtime:SafetyRuntime,databasePath:string){
 const durable=(repo.safetyState()??{}) as SafetyState,manualPause=durable.manualPause===true;
 return {
  manualPause,
  manualPauseActor:typeof durable.manualPauseActor==='string'?durable.manualPauseActor:null,
  manualPauseReason:typeof durable.manualPauseReason==='string'?durable.manualPauseReason:null,
  manualPauseAt:typeof durable.manualPauseAt==='string'?durable.manualPauseAt:null,
  executionEnabled:runtime.executionEnabled,
  dryRun:runtime.dryRun,
  emergencyPause:runtime.emergencyPause,
  effectiveEmergencyPause:runtime.emergencyPause||manualPause,
  databasePath,
  chainId:runtime.chainId,
  mainnetTransactionsSent:0 as const,
 };
}

export function safetyStatus(input:{repo:SqliteLedgerRepository;runtime:SafetyRuntime;databasePath:string}){
 return state(input.repo,input.runtime,input.databasePath);
}

export function setDurableManualPause(input:{openRepository:RepositoryFactory;databasePath:string;runtime:SafetyRuntime;paused:boolean;confirmed:boolean;reason:string;actor:string}){
 if(input.confirmed!==true)throw new Error('SAFETY_CONFIRMATION_REQUIRED: use --confirm <reason>');
 const reason=input.reason.trim();
 if(!reason)throw new Error('SAFETY_REASON_REQUIRED: provide a non-empty reason');
 let writer:SqliteLedgerRepository|undefined;
 try{
  writer=input.openRepository(input.databasePath);
  writer.setManualPause(input.paused,input.actor,reason);
 }finally{writer?.close();}
 let verifier:SqliteLedgerRepository|undefined;
 try{
  verifier=input.openRepository(input.databasePath);
  const result=state(verifier,input.runtime,input.databasePath);
  if(result.manualPause!==input.paused||result.manualPauseActor!==input.actor||result.manualPauseReason!==reason||!result.manualPauseAt)throw new Error('SAFETY_PERSISTENCE_VERIFICATION_FAILED');
  return {...result,verifiedAfterReopen:true,action:input.paused?'SAFETY_PAUSED':'SAFETY_RESUMED'};
 }finally{verifier?.close();}
}
