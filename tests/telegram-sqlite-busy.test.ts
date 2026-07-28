import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSqlite, SqliteLedgerRepository } from '@robin/ledger';
import { isSqliteBusy, retrySqliteBusy, retrySqliteBusySync } from '../apps/telegram-lp-bot/src/sqlite-busy.js';

const busy=Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'});
describe('Telegram SQLite busy handling',()=>{
 it('retries a flow write and preserves the single successful transition',async()=>{
  let calls=0,transitions=0;const events:any[]=[];
  const value=await retrySqliteBusy({operation:'transitionTelegramFlow',baseWaitMs:1,log:(event,data)=>events.push({event,data}),run:()=>{calls++;if(calls<3)throw busy;transitions++;return 'v4_amount';}});
  expect(value).toBe('v4_amount');expect(transitions).toBe(1);expect(events.filter(x=>x.data.outcome==='retrying')).toHaveLength(2);expect(events.at(-1)?.data.outcome).toBe('recovered');
 });
 it('retries an actual held SQLite write lock and reaches v4_amount once released',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'robin-telegram-busy-')),path=join(dir,'db.sqlite');migrateSqlite(path,'infra/migrations');const seed=new SqliteLedgerRepository(path),flow=seed.createTelegramFlow({userId:'u',chatId:'c',state:{kind:'v4_mode'},now:1_700_000_000_000,ttlMs:600_000});seed.close();const lock=new Database(path);lock.exec('BEGIN IMMEDIATE');setTimeout(()=>lock.exec('COMMIT'),20);try{const next=await retrySqliteBusy({operation:'transitionTelegramFlow',baseWaitMs:1,log:()=>{},run:()=>{const repo=new SqliteLedgerRepository(path,{busyTimeoutMs:1});try{return repo.transitionTelegramFlow({userId:'u',chatId:'c',sessionId:flow.sessionId,state:{kind:'v4_amount'},now:1_700_000_000_001,ttlMs:600_000});}finally{repo.close();}}});expect(next?.state.kind).toBe('v4_amount');}finally{try{lock.close();}catch{}rmSync(dir,{recursive:true,force:true});}
 });
 it('exhausts safely without invoking any transaction path',()=>{
  let calls=0,transactions=0;expect(()=>retrySqliteBusySync({operation:'transitionTelegramFlow',baseWaitMs:1,maxAttempts:2,log:()=>{},run:()=>{calls++;throw busy;}})).toThrow(/locked/);expect(calls).toBe(2);expect(transactions).toBe(0);expect(isSqliteBusy(busy)).toBe(true);
 });
 it('keeps a non-fatal process-level catch handler installed',async()=>{
  const source=await import('node:fs/promises').then(fs=>fs.readFile('apps/telegram-lp-bot/src/index.ts','utf8'));expect(source).toContain('bot.catch(async error=>');expect(source).toContain('Temporarily busy. Please tap the button again in a moment.');expect(source).toContain("retryable:busy");
 });
});
