import { describe,expect,it } from 'vitest';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAddress,zeroAddress } from 'viem';
import { migrateSqlite,SqliteLedgerRepository } from '@robin/ledger';
import { robinhoodMainnet } from '@robin/core';
import { attachDirectLookupSubscriber,cleanupLegacyDirectLookupFanout,completeDirectLookupOutbox,completeDirectTokenLookup,createOrReuseDirectLookup,directLookupCandidatePoolIds,executeDirectTokenLookup,expireDueDirectTokenLookups,leaseDirectLookupOutbox,leaseDirectTokenLookup,retryDirectLookupOutbox } from '../apps/cli/src/direct-token-lookup.js';

const token=getAddress('0x000000000000000000000000000000000000c0de');
function fixture(count=180){
 const dir=mkdtempSync(join(tmpdir(),'direct-lookup-')),path=join(dir,'test.sqlite');migrateSqlite(path,'infra/migrations');const repo=new SqliteLedgerRepository(path);
 repo.upsertTokenMetadata({address:token,symbol:'TEST',name:'Test',decimals:18});
 for(let i=0;i<count;i++){const id=`0x${(i+1).toString(16).padStart(64,'0')}`,quote=i%2?robinhoodMainnet.assets.WETH:robinhoodMainnet.assets.USDG,[currency0,currency1]=[token,quote].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())) as [typeof token,typeof quote];repo.upsertV4RegistryPool({poolId:id,currency0,currency1,initializeFeeRaw:500+i,tickSpacing:10,hooks:zeroAddress,initializationBlock:BigInt(1000+i),dynamicFee:false,staticFeePips:500+i,hookClassification:'ZERO_HOOK'});}
 return {repo,close(){repo.close();rmSync(dir,{recursive:true,force:true});}};
}
function rpc(liquidity=1n,fail=false){
 const client={getBlockNumber:async()=>100n,multicall:async(input:any)=>{if(fail)throw new Error('provider timeout');return input.contracts.map((_:unknown,index:number)=>({status:'success',result:index%2===0?[2n**96n,0,0,500]:liquidity}));}};
 return {config:{},metrics:{fallbackUses:0},withClient:async(work:any)=>work(client,'mock')} as any;
}

describe('durable direct token lookup',()=>{
 it('bounds a 180-pool token to one request, twelve candidates and one RPC batch',async()=>{
  const f=fixture();try{
   const first=createOrReuseDirectLookup({repo:f.repo,token,nowMs:1_000,deadlineMs:10_000}),duplicate=createOrReuseDirectLookup({repo:f.repo,token,nowMs:1_100,deadlineMs:10_000});
   expect(first.created).toBe(true);expect(duplicate).toMatchObject({created:false,deduplicated:true});expect(duplicate.request.id).toBe(first.request.id);
   attachDirectLookupSubscriber({repo:f.repo,requestId:first.request.id,requestRevision:first.request.revision,interactionId:'interaction-1',userId:'u',chatId:'c',messageId:7,sessionId:'s',nowMs:1_200});
   const leased=leaseDirectTokenLookup(f.repo,10_000,1_300)!;expect(leased.id).toBe(first.request.id);
   const done=await executeDirectTokenLookup({repo:f.repo,rpc:rpc(),request:leased,candidateBudget:12,maxRpcBatches:1,now:()=>2_000});
   expect(done).toMatchObject({completed:true,stale:false});
   const row=f.repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=?').get(first.request.id) as any,metrics=JSON.parse(row.rpc_attribution_json);
   expect(row.provider_result).toBe('available');
   expect(row).toMatchObject({status:'SUPPORTED_POOLS_FOUND',candidate_pool_count:12,hydrated_pool_count:12,eligible_pool_count:12});
   expect(metrics).toMatchObject({ethCallCount:24,eth_blockNumberCount:1,multicallCount:1,multicallMembers:24,rpcCallCount:2,queueJobsCreated:1});
   expect(leaseDirectLookupOutbox(f.repo,5_000,2_100)).toMatchObject({request_id:first.request.id,interaction_id:'interaction-1'});
   expect(completeDirectTokenLookup(f.repo,{requestId:first.request.id,requestRevision:first.request.revision,status:'NO_ACTIVE_LIQUIDITY_POOL',candidatePoolCount:0,hydratedPoolCount:0,eligiblePoolIds:[],providerResult:'late',rpcAttribution:{},reasonCode:'STALE',nowMs:2_200})).toEqual({completed:false,stale:true});
  }finally{f.close();}
 });
 it('returns a bounded terminal provider/timeout result and never creates generic state jobs',async()=>{
  const f=fixture(173);try{const created=createOrReuseDirectLookup({repo:f.repo,token,nowMs:1_000,deadlineMs:10_000}),leased=leaseDirectTokenLookup(f.repo,10_000,1_100)!;await executeDirectTokenLookup({repo:f.repo,rpc:rpc(0n,true),request:leased,candidateBudget:9,maxRpcBatches:1,now:()=>12_000});const row=f.repo.db.prepare('SELECT * FROM direct_token_lookup_requests WHERE id=?').get(created.request.id) as any;expect(row.status).toBe('LOOKUP_TIMED_OUT');expect(f.repo.db.prepare('SELECT COUNT(*) count FROM v4_state_refresh_queue').get()).toEqual({count:0});expect(directLookupCandidatePoolIds(f.repo,token,9)).toHaveLength(9);}finally{f.close();}});
 it('cleans only legacy fan-out while preserving active-position pool work',()=>{
  const f=fixture(3);try{const ids=directLookupCandidatePoolIds(f.repo,token,3);for(const id of ids)f.repo.enqueueV4StateRefresh(id,90,'recent-telegram-token',1_000);f.repo.upsertV4Position({tokenId:1n,owner:'0x0000000000000000000000000000000000000001',poolId:ids[0]!,poolKey:{currency0:token,currency1:robinhoodMainnet.assets.USDG,fee:500,tickSpacing:10,hooks:zeroAddress},currency0:token,currency1:robinhoodMainnet.assets.USDG,fee:500,tickSpacing:10,hooks:zeroAddress,tickLower:-10,tickUpper:10,liquidity:1n,initialAmount0:0n,initialAmount1:0n,mintHash:'0x1'});const result=cleanupLegacyDirectLookupFanout(f.repo,true,2_000);expect(result.removed).toBe(2);expect(f.repo.db.prepare('SELECT pool_id FROM v4_state_refresh_queue').all()).toEqual([{pool_id:ids[0]}]);}finally{f.close();}});
 it('keeps cached lookup and Telegram handlers free of hydration polling and fan-out side effects',()=>{
  const registry=readFileSync('apps/cli/src/v4-registry.ts','utf8'),telegram=readFileSync('apps/telegram-lp-bot/src/index.ts','utf8'),cached=registry.slice(registry.indexOf('export function cachedV4PoolsForToken'),registry.indexOf('export async function v4RegistryStatus'));
  expect(cached).not.toContain('noteTokenRequest');expect(cached).not.toContain('enqueueV4StateRefresh');expect(telegram).not.toContain('scheduleHydrationEdit');expect(telegram).not.toContain('noChangeRenderCount');expect(telegram).toMatch(/pollingIterations\s*:\s*0/);
 });
 it('times out durably even when no worker ever leases the request',()=>{
  const f=fixture(1);try{const created=createOrReuseDirectLookup({repo:f.repo,token,nowMs:1_000,deadlineMs:500});attachDirectLookupSubscriber({repo:f.repo,requestId:created.request.id,requestRevision:created.request.revision,interactionId:'deadline',userId:'u',chatId:'c',messageId:2,sessionId:'s',nowMs:1_010});expect(expireDueDirectTokenLookups(f.repo,1_501)).toBe(1);expect((f.repo.db.prepare('SELECT status FROM direct_token_lookup_requests WHERE id=?').get(created.request.id) as any).status).toBe('LOOKUP_TIMED_OUT');expect(leaseDirectLookupOutbox(f.repo,1_000,1_502)).toBeTruthy();}finally{f.close();}});
 it('rejects a stale completion after an explicit retry creates a newer revision',()=>{
  const f=fixture(1);try{const old=createOrReuseDirectLookup({repo:f.repo,token,nowMs:1_000}),next=createOrReuseDirectLookup({repo:f.repo,token,nowMs:1_100,explicitRetry:true});expect(next.request.revision).toBe(old.request.revision+1);expect(completeDirectTokenLookup(f.repo,{requestId:old.request.id,requestRevision:old.request.revision,status:'SUPPORTED_POOLS_FOUND',candidatePoolCount:1,hydratedPoolCount:1,eligiblePoolIds:['old'],providerResult:'late',rpcAttribution:{},reasonCode:'LATE',nowMs:1_200})).toEqual({completed:false,stale:true});expect((f.repo.db.prepare('SELECT status FROM direct_token_lookup_requests WHERE id=?').get(next.request.id) as any).status).toBe('QUEUED');}finally{f.close();}});
 it('delivers an outbox revision once and retries network failure idempotently',()=>{
  const f=fixture(1);try{const created=createOrReuseDirectLookup({repo:f.repo,token,nowMs:1_000});attachDirectLookupSubscriber({repo:f.repo,requestId:created.request.id,requestRevision:created.request.revision,interactionId:'i',userId:'u',chatId:'c',messageId:1,sessionId:'s',nowMs:1_010});completeDirectTokenLookup(f.repo,{requestId:created.request.id,requestRevision:created.request.revision,status:'NO_ACTIVE_LIQUIDITY_POOL',candidatePoolCount:1,hydratedPoolCount:1,eligiblePoolIds:[],providerResult:'available',rpcAttribution:{},reasonCode:'NONE',nowMs:1_020});const first=leaseDirectLookupOutbox(f.repo,1_000,1_030)! as any;expect(retryDirectLookupOutbox(f.repo,String(first.id),'telegram timeout',3,1_040)).toMatchObject({failed:false,attempts:1});const second=leaseDirectLookupOutbox(f.repo,1_000,1_300)! as any;expect(second.id).toBe(first.id);expect(completeDirectLookupOutbox(f.repo,String(second.id),1_310)).toBe(true);expect(completeDirectLookupOutbox(f.repo,String(second.id),1_320)).toBe(false);expect(leaseDirectLookupOutbox(f.repo,1_000,1_400)).toBeUndefined();}finally{f.close();}});
 it('uses WAL plus busy timeout and releases write phases before network work',async()=>{
  const f=fixture(0);try{
   expect(f.repo.db.pragma('journal_mode',{simple:true})).toBe('wal');expect(f.repo.db.pragma('busy_timeout',{simple:true})).toBe(10_000);
   const child=spawn(process.execPath,['-e',`const DB=require('better-sqlite3'),db=new DB(${JSON.stringify(f.repo.path)});db.exec('BEGIN IMMEDIATE');process.stdout.write('locked');setTimeout(()=>{db.exec('COMMIT');db.close()},150)`],{cwd:process.cwd(),stdio:['ignore','pipe','inherit']});
   const closed=new Promise(resolve=>child.once('close',resolve));await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);});const started=Date.now();f.repo.db.prepare("INSERT INTO latency_telemetry(metric,duration_ms,fallback_used,context_json,created_at_ms) VALUES('busy-test',0,0,'{}',?)").run(Date.now());expect(Date.now()-started).toBeGreaterThanOrEqual(100);await closed;
   const telegram=readFileSync('apps/telegram-lp-bot/src/index.ts','utf8'),outbox=telegram.slice(telegram.indexOf('async function deliverDirectLookupOutbox'),telegram.indexOf('async function directLookupOutboxConsumer')),workerSource=readFileSync('apps/workers/src/state-cache-worker.ts','utf8'),worker=workerSource.slice(workerSource.indexOf('async function stateCachePhase'),workerSource.indexOf('async function adoptionPhase'));
   expect(outbox.indexOf('renderDb.close()')).toBeLessThan(outbox.indexOf('bot.api.editMessageText'));expect(worker.indexOf('selectDb.close()')).toBeLessThan(worker.indexOf('refreshV4RegistryPoolBatch'));
  }finally{f.close();}
 });
});
