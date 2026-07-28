import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,expect,it } from 'vitest';
import { migrateSqlite,SqliteLedgerRepository } from '@robin/ledger';
import { safetyStatus,setDurableManualPause } from '../apps/cli/src/safety-operator.js';

const runtime={chainId:4663,executionEnabled:true,dryRun:false,emergencyPause:false};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'robin-safety-operator-')),path=join(dir,'ledger.sqlite');migrateSqlite(path,'infra/migrations');return {path,open:(value:string)=>new SqliteLedgerRepository(value),close(){rmSync(dir,{recursive:true,force:true});}};}

describe('durable manual pause operator control',()=>{
 it('reads durable true and false without a transaction path',()=>{
  const f=fixture();try{let repo=f.open(f.path);repo.setManualPause(true,'fixture','initial pause');expect(safetyStatus({repo,runtime,databasePath:f.path})).toMatchObject({manualPause:true,manualPauseActor:'fixture',manualPauseReason:'initial pause',effectiveEmergencyPause:true,mainnetTransactionsSent:0});repo.close();repo=f.open(f.path);repo.setManualPause(false,'fixture','initial resume');expect(safetyStatus({repo,runtime,databasePath:f.path})).toMatchObject({manualPause:false,effectiveEmergencyPause:false,mainnetTransactionsSent:0});expect((repo.db.prepare('SELECT COUNT(*) count FROM transaction_intents').get() as {count:number}).count).toBe(0);repo.close();}finally{f.close();}
 });
 it('rejects resume without literal confirmation or a reason',()=>{
  const f=fixture();try{expect(()=>setDurableManualPause({openRepository:f.open,databasePath:f.path,runtime,paused:false,confirmed:false,reason:'resume',actor:'cli:safety-resume'})).toThrow('SAFETY_CONFIRMATION_REQUIRED');expect(()=>setDurableManualPause({openRepository:f.open,databasePath:f.path,runtime,paused:false,confirmed:true,reason:'   ',actor:'cli:safety-resume'})).toThrow('SAFETY_REASON_REQUIRED');}finally{f.close();}
 });
 it('persists pause and resume with actor, reason, timestamp, and reopen verification',()=>{
  const f=fixture();try{
   const paused=setDurableManualPause({openRepository:f.open,databasePath:f.path,runtime,paused:true,confirmed:true,reason:'operator pause for review',actor:'cli:safety-pause'});
   expect(paused).toMatchObject({action:'SAFETY_PAUSED',manualPause:true,manualPauseActor:'cli:safety-pause',manualPauseReason:'operator pause for review',verifiedAfterReopen:true,effectiveEmergencyPause:true,mainnetTransactionsSent:0});expect(paused.manualPauseAt).toEqual(expect.any(String));
   const resumed=setDurableManualPause({openRepository:f.open,databasePath:f.path,runtime,paused:false,confirmed:true,reason:'NFT 343976 close-and-burn smoke',actor:'cli:safety-resume'});
   expect(resumed).toMatchObject({action:'SAFETY_RESUMED',manualPause:false,manualPauseActor:'cli:safety-resume',manualPauseReason:'NFT 343976 close-and-burn smoke',verifiedAfterReopen:true,effectiveEmergencyPause:false,mainnetTransactionsSent:0});expect(resumed.manualPauseAt).toEqual(expect.any(String));
   const reopened=f.open(f.path);try{expect(reopened.safetyState()).toMatchObject({manualPause:false,manualPauseActor:'cli:safety-resume',manualPauseReason:'NFT 343976 close-and-burn smoke'});expect((reopened.db.prepare('SELECT COUNT(*) count FROM transaction_intents').get() as {count:number}).count).toBe(0);}finally{reopened.close();}
  }finally{f.close();}
 });
});
