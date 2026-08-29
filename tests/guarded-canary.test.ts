import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateSqlite, SqliteLedgerRepository } from '@funi/ledger';
import { canaryGate } from '../apps/cli/src/guarded-canary.js';

const base={executionEnabled:true,dryRun:false,emergencyPause:false,liveCanaryEnabled:true,allowlisted:true,signerConfigured:true,chainId:4663,deploymentVerified:true,positionUsd:5,approvalUsd:5,maxPositionUsd:10,maxApprovalUsd:10,pendingExecutions:0,budgetAvailable:true,openPositions:0,maxOpenPositions:1};
describe('guarded live canary state',()=>{
 it('fails closed for every default execution gate',()=>{expect(canaryGate({...base,dryRun:true})).toMatch(/DRY_RUN/);expect(canaryGate({...base,budgetAvailable:false})).toMatch(/budget/);expect(canaryGate({...base,openPositions:1})).toMatch(/MAX_OPEN/);expect(canaryGate(base)).toBeUndefined();});
 it('keeps historical arm records readable without using them as an execution gate',()=>{const root=mkdtempSync(join(tmpdir(),'funi-canary-')),path=join(root,'ledger.sqlite');migrateSqlite(path,join(process.cwd(),'infra/migrations'));const repo=new SqliteLedgerRepository(path);try{const arm=repo.armCanary({userId:'u',chatId:'c',now:100,ttlMs:600});expect(repo.consumeCanaryArm('u','c',arm.id,102)).toBe(true);expect(repo.canaryBudgetAvailable()).toBe(true);}finally{repo.close();}});
 it('persists a single-use execution intent and tracks nonterminal work',()=>{const root=mkdtempSync(join(tmpdir(),'funi-canary-')),path=join(root,'ledger.sqlite');migrateSqlite(path,join(process.cwd(),'infra/migrations'));const repo=new SqliteLedgerRepository(path);try{const first=repo.createCanaryIntent({wallet:'0xabc',owner:'u',idempotencyKey:'once',payload:{}}),same=repo.createCanaryIntent({wallet:'0xabc',owner:'u',idempotencyKey:'once',payload:{}});expect(same.id).toBe(first.id);expect(repo.activeCanaryExecutionCount('0xabc')).toBe(1);repo.transitionCanaryIntent(String(first.id),'FAILED',{failureReason:'safe abort'});expect(repo.activeCanaryExecutionCount('0xabc')).toBe(0);}finally{repo.close();}});
});
