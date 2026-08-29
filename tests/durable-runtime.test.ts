import { mkdtempSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupSqlite, migrateSqlite, productionDatabasePaths, restoreSqliteBackup, SqliteLedgerRepository, sqliteStatus } from '@funi/ledger';

describe('durable production ledger runtime',()=>{
 it('migrates repeatably, uses restrictive paths, and restores an atomic backup',async()=>{
  const root=mkdtempSync(join(tmpdir(),'funi-durable-')),paths=productionDatabasePaths({dataDir:root}),migrations=join(process.cwd(),'infra/migrations');
  try{
   expect(migrateSqlite(paths.databasePath,migrations).pending).toEqual([]);
   expect(migrateSqlite(paths.databasePath,migrations).pending).toEqual([]);
   expect(sqliteStatus(paths.databasePath,migrations).pending).toEqual([]);
   const repo=new SqliteLedgerRepository(paths.databasePath);repo.persistSafetyState({manualPause:true});repo.close();
   const backup=await backupSqlite(paths.databasePath,paths.backupDir,2),restored=join(root,'restored.sqlite');
   restoreSqliteBackup(backup.path,restored);
   expect(existsSync(restored)).toBe(true);expect(sqliteStatus(restored,migrations).pending).toEqual([]);
   expect(statSync(paths.databasePath).mode&0o077).toBe(0);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('makes confirmations single-use, rejects stale requests, and keeps reconciliation idempotent',()=>{
  const root=mkdtempSync(join(tmpdir(),'funi-confirm-')),path=join(root,'ledger.sqlite'),migrations=join(process.cwd(),'infra/migrations');
  try{
   migrateSqlite(path,migrations);const repo=new SqliteLedgerRepository(path),expires=new Date(Date.now()+60_000).toISOString();
   const first=repo.createConfirmation({action:'COLLECT',owner:'1',expiresAt:expires,idempotencyKey:'once',blockNumber:'10',payload:{tokenId:'1'}})!;
   expect(repo.createConfirmation({action:'COLLECT',owner:'1',expiresAt:expires,idempotencyKey:'once',payload:{}})!.id).toBe(first.id);
   expect(()=>repo.resolveConfirmation(String(first.id),'1','confirm','20')).toThrow(/stale/);
   expect(()=>repo.resolveConfirmation(String(first.id),'1','confirm','20')).toThrow(/EXECUTION_BLOCKED/);
   repo.ensurePosition('p','1','0xpool');expect(repo.reconcileAll()).toHaveLength(1);expect(repo.reconcileAll()).toHaveLength(1);repo.close();
  }finally{rmSync(root,{recursive:true,force:true});}
 });
});
