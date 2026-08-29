import { migrateSqlite,nowMs,SQLITE_RUNTIME_BUSY_TIMEOUT_MS,SqliteLedgerRepository,SqliteTransientRetryExhaustedError } from '@funi/ledger';
import { initializeSafety } from '../../cli/src/runtime.js';
import { retrySqliteBusySync } from './sqlite-busy.js';

type StartupLog=(event:string,data:Record<string,unknown>)=>void;
export type TelegramStartupResult={status:'READY';safety:Record<string,unknown>;expired:number;retryableOperationalOpenIntents:number}|{status:'DEFERRED';operation:string;attempt:number;delayMs:0;sqliteCode:string;finalDisposition:'DEFERRED'};

export function initializeTelegramRuntime(input:{databasePath:string;migrationsDir?:string;log:StartupLog;now?:()=>number}):TelegramStartupResult{
 const open=()=>new SqliteLedgerRepository(input.databasePath,{busyTimeoutMs:SQLITE_RUNTIME_BUSY_TIMEOUT_MS}),operation=<T>(name:string,work:(db:SqliteLedgerRepository)=>T)=>retrySqliteBusySync({operation:name,log:input.log,run:()=>{const db=open();try{return work(db);}finally{db.close();}}});
 try{
  retrySqliteBusySync({operation:'telegram_migration_check',log:input.log,run:()=>migrateSqlite(input.databasePath,input.migrationsDir??'infra/migrations',{busyTimeoutMs:SQLITE_RUNTIME_BUSY_TIMEOUT_MS})});
  const safety=operation('telegram_safety_read',db=>initializeSafety(db,'READ_ONLY_SAFETY_CONSUMER')) as Record<string,unknown>;
  operation('telegram_reconcile_all',db=>db.reconcileAll());
  const retryableOperationalOpenIntents=operation('telegram_operational_intent_recovery',db=>db.db.transaction(()=>(db.db.prepare("SELECT id FROM v4_live_open_intents WHERE state='FAILED' AND (json_extract(payload_json,'$.lane')='operational' OR json_extract(payload_json,'$.executor')='executeV4OperationalOpen') AND erc20_approval_hash IS NULL AND permit2_approval_hash IS NULL AND mint_hash IS NULL AND NOT EXISTS(SELECT 1 FROM v4_live_transitions WHERE intent_id=v4_live_open_intents.id AND state='FAILED_NO_BROADCAST_TERMINALIZED')").all() as Array<{id:string}>).filter(row=>db.markV4OperationalOpenRetryable(row.id)).length)()),expired=operation('telegram_session_recovery',db=>db.recoverTelegramFlows((input.now??nowMs)()));
  operation('telegram_confirmation_recovery',db=>db.recoverConfirmations());
  return {status:'READY',safety,expired,retryableOperationalOpenIntents};
 }catch(error){
  if(!(error instanceof SqliteTransientRetryExhaustedError))throw error;
  return {status:'DEFERRED',operation:error.operation,attempt:error.attempts,delayMs:0,sqliteCode:error.sqliteCode,finalDisposition:'DEFERRED'};
 }
}
