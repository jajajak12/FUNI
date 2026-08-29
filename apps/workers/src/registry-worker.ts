import 'dotenv/config';
import { assertFuniCredentialIsolation } from '../../shared/credential-isolation.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { FallbackRpc, robinhoodMainnet } from '@funi/core';
import { migrateSqlite, productionDatabasePaths, SQLITE_RUNTIME_BUSY_TIMEOUT_MS, SqliteLedgerRepository } from '@funi/ledger';
import { syncV4PoolRegistry } from '../../cli/src/v4-registry.js';

assertFuniCredentialIsolation(process.env);
delete process.env.LP_PRIVATE_KEY; delete process.env.LP_MNEMONIC; delete process.env.SEED_PHRASE; delete process.env.MNEMONIC;
const url=process.env.RH_LOGS_RPC_URL??'https://rpc.mainnet.chain.robinhood.com',paths=productionDatabasePaths({dataDir:process.env.DATA_DIR,databasePath:process.env.DATABASE_PATH}),rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:[url]});
migrateSqlite(paths.databasePath,'infra/migrations',{busyTimeoutMs:SQLITE_RUNTIME_BUSY_TIMEOUT_MS});
const cadenceMs=Math.max(5_000,Math.min(300_000,Number(process.env.V4_REGISTRY_CADENCE_MS??15_000)||15_000));
let stopping=false,running=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
const emit=(event:string,data:unknown={})=>process.stdout.write(JSON.stringify({event,...data as object,provider:'robinhood-logs',at:new Date().toISOString()},(_,value)=>typeof value==='bigint'?value.toString():value)+'\n');
async function withBusyRetry<T>(operation:string,work:()=>Promise<T>){const started=Date.now();let last:unknown;for(let attempt=0;attempt<3;attempt++)try{return await work();}catch(error){last=error;if(!/SQLITE_BUSY|database is locked/i.test(error instanceof Error?error.message:String(error)))throw error;const waitMs=75*2**attempt+Math.floor(Math.random()*50);emit('sqlite_busy_retry',{operation,attempt:attempt+1,waitMs,dbWaitMs:Date.now()-started});await sleep(waitMs);}emit('sqlite_busy_terminal',{operation,dbWaitMs:Date.now()-started,writer:'registry-sync short persistence phase'});throw last;}
while(!stopping){
 if(running){await sleep(250);continue;}running=true;const db=new SqliteLedgerRepository(paths.databasePath,{busyTimeoutMs:SQLITE_RUNTIME_BUSY_TIMEOUT_MS});
 try{
  const cursor=db.v4RegistryCursor();if(!cursor)throw new Error('V4_REGISTRY_CURSOR_NOT_INITIALIZED');
  const result=await withBusyRetry('registry_sync_persist',()=>syncV4PoolRegistry({repo:db,rpc,onEvent:emit}));const current=Number(db.v4RegistryCursor()!.window_size),next=Math.min(50_000,Math.max(100,current*2));if(next!==current)db.configureV4RegistryCursor({windowSize:next});emit('registry_cycle',{...result,cadenceMs,stateHydrationPolicy:'wallet-active-or-recent-request-only'});
 }catch(error){const message=error instanceof Error?error.message:String(error),cursor=db.v4RegistryCursor();if(cursor&&!/database is locked/i.test(message)){const current=Number(cursor.window_size),next=Math.max(100,Math.floor(current/2));if(next!==current)db.configureV4RegistryCursor({windowSize:next});}emit('registry_cycle_error',{error:message});}
 finally{db.close();running=false;}if(!stopping)await sleep(cadenceMs);
}
