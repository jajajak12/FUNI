import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSqlite, SqliteLedgerRepository } from '@funi/ledger';
import { robinhoodMainnet } from '@funi/core';
import {
  adoptionAudit,
  confirmAdoptionBaseline,
  createAdoptionBaselineConfirmation,
  completeWalletPositionSync,
  enqueueWalletPositionSync,
  leaseWalletPositionSync,
  setAdoptedFundingAsset,
  walletPositionSyncAudit,
} from '../apps/cli/src/position-adoption.js';

const token='0x0000000000000000000000000000000000000011';
const key={currency0:token,currency1:robinhoodMainnet.assets.USDG,fee:500,tickSpacing:10,hooks:'0x0000000000000000000000000000000000000000'};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'position-adoption-')),path=join(dir,'db.sqlite');
 migrateSqlite(path,'infra/migrations');
 const repo=new SqliteLedgerRepository(path),at=new Date().toISOString();
 repo.ensurePosition('v4:7','7','pool');
 repo.upsertV4Position({tokenId:7n,owner:'0x0000000000000000000000000000000000000001',poolId:'pool',poolKey:key,currency0:key.currency0,currency1:key.currency1,fee:key.fee,tickSpacing:key.tickSpacing,hooks:key.hooks,tickLower:-100,tickUpper:0,liquidity:1n,initialAmount0:0n,initialAmount1:0n,mintHash:`0x${'1'.repeat(64)}`});
 repo.db.prepare("INSERT INTO wallet_position_candidates(protocol_version,token_id,manager_address,acquisition_tx_hash,acquisition_block,acquisition_log_index,acquisition_from,last_verified_owner,ownership_verified_at,created_at,updated_at) VALUES('v4','7',?,?,?,?,?,?,?, ?,?)").run('0x0000000000000000000000000000000000000022',`0x${'2'.repeat(64)}`,'10',0,'0x0000000000000000000000000000000000000000','0x0000000000000000000000000000000000000001',at,at,at);
 repo.db.prepare("INSERT INTO position_adoptions(position_id,protocol_version,token_id,manager_address,source,adoption_status,accounting_status,discovery_method,history_json,created_at,updated_at) VALUES('v4:7','v4','7',?,'MANUAL_EXTERNAL','AUTO_ADOPTED','ADOPTED_ACCOUNTING_INCOMPLETE','PERSISTED_TRANSFER_CURSOR_PLUS_OWNEROF',?,?,?)").run('0x0000000000000000000000000000000000000022',JSON.stringify({tokens:[{address:token,symbol:'TEST',decimals:18},{address:robinhoodMainnet.assets.USDG,symbol:'USDG',decimals:6}]}),at,at);
 return {repo,close(){repo.close();rmSync(dir,{recursive:true,force:true});}};
}

describe('manual external position adoption',()=>{
 it('persists one immutable user-verified baseline after final confirmation',()=>{
  const opened=fixture();try{
   const pending=createAdoptionBaselineConfirmation(opened.repo,{positionId:'v4:7',userId:'u',chatId:'c',baselineUsd:5,nowMs:1000,ttlMs:1000});
   expect(confirmAdoptionBaseline(opened.repo,{id:pending.id,userId:'u',chatId:'c',nowMs:1500})).toMatchObject({status:'CONFIRMED',baselineUsd:5,provenance:'USER_VERIFIED_BASELINE'});
   expect(()=>createAdoptionBaselineConfirmation(opened.repo,{positionId:'v4:7',userId:'u',chatId:'c',baselineUsd:6,nowMs:1600,ttlMs:1000})).toThrow('ADOPTION_BASELINE_ALREADY_VERIFIED');
  }finally{opened.close();}
 });
 it('persists explicit funding only once and never guesses an asset outside the pool',()=>{
  const opened=fixture();try{
   expect(setAdoptedFundingAsset(opened.repo,{positionId:'v4:7',token:robinhoodMainnet.assets.USDG,symbol:'USDG',provenance:'USER_SELECTED_FUNDING'})).toMatchObject({funding_symbol:'USDG',funding_provenance:'USER_SELECTED_FUNDING'});
   expect(()=>setAdoptedFundingAsset(opened.repo,{positionId:'v4:7',token:robinhoodMainnet.assets.WETH,symbol:'WETH',provenance:'USER_SELECTED_FUNDING'})).toThrow('ADOPTION_FUNDING_ALREADY_VERIFIED');
  }finally{opened.close();}
 });
 it('keeps audits read-only and exposes adoption provenance without duplication',()=>{
  const opened=fixture();try{
   const before=opened.repo.db.prepare('SELECT COUNT(*) count FROM position_adoptions').get() as {count:number};
   expect(walletPositionSyncAudit(opened.repo)).toMatchObject({status:'READ_ONLY',mainnetTransactionsSent:0});
   expect(adoptionAudit(opened.repo,'7')).toMatchObject({status:'ADOPTED',adoption:{source:'MANUAL_EXTERNAL',adoption_status:'AUTO_ADOPTED'},mainnetTransactionsSent:0});
   const after=opened.repo.db.prepare('SELECT COUNT(*) count FROM position_adoptions').get() as {count:number};
   expect(after.count).toBe(before.count);
  }finally{opened.close();}
 });
 it('deduplicates background sync requests and resumes a persisted lease',()=>{
  const opened=fixture();try{
   expect(enqueueWalletPositionSync(opened.repo,'telegram',1_000)).toMatchObject({queued:true,requestKey:'wallet'});
   enqueueWalletPositionSync(opened.repo,'telegram-pagination-must-not-call-this',1_001);
   expect((opened.repo.db.prepare('SELECT COUNT(*) count FROM wallet_position_sync_requests').get() as {count:number}).count).toBe(1);
   expect(leaseWalletPositionSync(opened.repo,1_000,1_002)).toBeTruthy();
   expect(leaseWalletPositionSync(opened.repo,1_000,1_003)).toBeUndefined();
   expect(leaseWalletPositionSync(opened.repo,1_000,2_003)).toBeTruthy();
   completeWalletPositionSync(opened.repo,2_004);
   expect(leaseWalletPositionSync(opened.repo,1_000,2_005)).toBeUndefined();
  }finally{opened.close();}
 });
 it('persists terminal candidate lifecycle state for cheap future skips',()=>{
  const opened=fixture();try{
   opened.repo.db.prepare("UPDATE wallet_position_candidates SET candidate_state='ADOPTED',ownership_verified_at=? WHERE protocol_version='v4' AND token_id='7'").run(new Date().toISOString());
   const row=opened.repo.db.prepare("SELECT candidate_state,ownership_verified_at FROM wallet_position_candidates WHERE protocol_version='v4' AND token_id='7'").get() as Record<string,unknown>;
   expect(row.candidate_state).toBe('ADOPTED');expect(row.ownership_verified_at).toBeTruthy();
  }finally{opened.close();}
 });
});
