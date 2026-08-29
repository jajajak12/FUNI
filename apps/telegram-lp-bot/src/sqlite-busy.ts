import { isSqliteTransientLock,withSqliteTransientRetry,withSqliteTransientRetrySync } from '@funi/ledger';

export const isSqliteBusy=isSqliteTransientLock;

export async function retrySqliteBusy<T>(input:{operation:string;run:()=>T;log:(event:string,data:Record<string,unknown>)=>void;maxAttempts?:number;baseWaitMs?:number}){
 return withSqliteTransientRetry({operation:input.operation,run:input.run,maxAttempts:input.maxAttempts,baseDelayMs:input.baseWaitMs,onEvent:event=>input.log('sqlite_transient_lock',event)});
}

export function retrySqliteBusySync<T>(input:{operation:string;run:()=>T;log:(event:string,data:Record<string,unknown>)=>void;maxAttempts?:number;baseWaitMs?:number}){
 return withSqliteTransientRetrySync({operation:input.operation,run:input.run,maxAttempts:input.maxAttempts,baseDelayMs:input.baseWaitMs,onEvent:event=>input.log('sqlite_transient_lock',event)});
}
