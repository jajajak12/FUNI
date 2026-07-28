import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { migrateSqlite, SqliteLedgerRepository } from '@robin/ledger';
import { scanProtocol } from '../apps/cli/src/position-adoption.js';

const manager='0x0000000000000000000000000000000000000022' as const;
const oldWallet='0x0000000000000000000000000000000000000001' as const;
const newWallet='0x0000000000000000000000000000000000000002' as const;
function fixture(){const dir=mkdtempSync(join(tmpdir(),'wallet-cursor-')),path=join(dir,'db.sqlite');migrateSqlite(path,'infra/migrations');const repo=new SqliteLedgerRepository(path);return {repo,close(){repo.close();rmSync(dir,{recursive:true,force:true});}};}
function rpc(getLogs:()=>Promise<unknown[]>){return {withClient:async(fn:(client:any)=>unknown)=>fn({getLogs})} as any;}
async function scan(repo:SqliteLedgerRepository,wallet:Address,client:any){return scanProtocol({repo,rpc:client,protocol:'v4',manager,wallet,event:{},idName:'id',latest:19n,fromBlock:0n,windowSize:10n,maxWindows:1});}

describe('wallet-scoped transfer cursors',()=>{
 it('does not inherit an old wallet cursor and retains legacy rows for audit',async()=>{const opened=fixture();try{
  opened.repo.db.prepare("INSERT INTO wallet_position_sync_cursors_legacy(protocol_version,manager_address,initialized_from_block,next_block,latest_observed_block,window_size,updated_at) VALUES('v4',?,'0','99','99',10,'now')").run(manager);
  await scan(opened.repo,newWallet,rpc(async()=>[]));
  expect(opened.repo.db.prepare("SELECT next_block FROM wallet_position_sync_cursors WHERE protocol_version='v4' AND wallet_address=?").get(newWallet)).toMatchObject({next_block:'10'});
  expect(opened.repo.db.prepare("SELECT next_block FROM wallet_position_sync_cursors_legacy WHERE protocol_version='v4'").get()).toMatchObject({next_block:'99'});
 }finally{opened.close();}});
 it('advances V4 cursors independently for two wallets',async()=>{const opened=fixture();try{
  await scan(opened.repo,oldWallet,rpc(async()=>[]));await scan(opened.repo,newWallet,rpc(async()=>[]));
  expect(opened.repo.db.prepare("SELECT COUNT(*) count FROM wallet_position_sync_cursors WHERE protocol_version='v4' AND next_block='10'").get()).toMatchObject({count:2});
 }finally{opened.close();}});
 it('does not advance on either incoming or outgoing provider failure',async()=>{const opened=fixture();try{
  let calls=0;await expect(scan(opened.repo,newWallet,rpc(async()=>{calls++;if(calls===2)throw new Error('logs unavailable');return [];}))).rejects.toThrow('logs unavailable');
  expect(opened.repo.db.prepare("SELECT next_block FROM wallet_position_sync_cursors WHERE protocol_version='v4' AND wallet_address=?").get(newWallet)).toMatchObject({next_block:'0'});
 }finally{opened.close();}});
 it('concurrent same-wallet scans commit one window exactly once',async()=>{const opened=fixture();try{
  let arrivals=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const client=rpc(async()=>{arrivals++;if(arrivals===2)release();await gate;return [];});
  const [a,b]=await Promise.all([scan(opened.repo,newWallet,client),scan(opened.repo,newWallet,client)]);
  expect(a.windows+b.windows).toBe(1);expect(opened.repo.db.prepare("SELECT next_block FROM wallet_position_sync_cursors WHERE protocol_version='v4' AND wallet_address=?").get(newWallet)).toMatchObject({next_block:'10'});
 }finally{opened.close();}});
});
