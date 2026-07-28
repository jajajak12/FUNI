import { setTimeout as sleep } from 'node:timers/promises';

export const isSqliteBusy=(error:unknown)=>{
 const value=error as {code?:unknown;message?:unknown};
 return value?.code==='SQLITE_BUSY'||/database is locked|SQLITE_BUSY/i.test(String(value?.message??error));
};

export async function retrySqliteBusy<T>(input:{operation:string;run:()=>T;log:(event:string,data:Record<string,unknown>)=>void;maxAttempts?:number;baseWaitMs?:number}){
 const maxAttempts=input.maxAttempts??4,baseWaitMs=input.baseWaitMs??25;
 for(let attempt=1;attempt<=maxAttempts;attempt++){
  try{const value=input.run();if(attempt>1)input.log('sqlite_busy_retry',{operation:input.operation,attempt,waitMs:0,outcome:'recovered'});return value;}
  catch(error){if(!isSqliteBusy(error)||attempt===maxAttempts){if(isSqliteBusy(error))input.log('sqlite_busy_retry',{operation:input.operation,attempt,waitMs:0,outcome:'exhausted'});throw error;}
   const waitMs=baseWaitMs*2**(attempt-1);input.log('sqlite_busy_retry',{operation:input.operation,attempt,waitMs,outcome:'retrying'});await sleep(waitMs);
  }
 }
 throw new Error('SQLITE_BUSY_RETRY_EXHAUSTED');
}

export function retrySqliteBusySync<T>(input:{operation:string;run:()=>T;log:(event:string,data:Record<string,unknown>)=>void;maxAttempts?:number;baseWaitMs?:number}){
 const maxAttempts=input.maxAttempts??4,baseWaitMs=input.baseWaitMs??25;
 for(let attempt=1;attempt<=maxAttempts;attempt++)try{return input.run();}catch(error){if(!isSqliteBusy(error)||attempt===maxAttempts){if(isSqliteBusy(error))input.log('sqlite_busy_retry',{operation:input.operation,attempt,waitMs:0,outcome:'exhausted'});throw error;}const waitMs=baseWaitMs*2**(attempt-1);input.log('sqlite_busy_retry',{operation:input.operation,attempt,waitMs,outcome:'retrying'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,waitMs);}
 throw new Error('SQLITE_BUSY_RETRY_EXHAUSTED');
}
