import { describe, expect, it } from 'vitest';
import { rebalanceExecutionBlockers } from '../apps/cli/src/v4-rebalance-executor.js';

describe('rebalance production gate',()=>{
 it('requires only the approved global runtime, operator, signer, chain, and deployment gates',()=>{
  expect(rebalanceExecutionBlockers({executionEnabled:true,dryRun:false,emergencyPause:false,authorized:true,signerConfigured:true,chainId:4663,deploymentVerified:true})).toEqual([]);
 });
 it('fails closed with exact reasons and has no canary dependency',()=>{
  expect(rebalanceExecutionBlockers({executionEnabled:false,dryRun:true,emergencyPause:true,authorized:false,signerConfigured:false,chainId:1,deploymentVerified:false})).toEqual(['EXECUTION_DISABLED','DRY_RUN_ENABLED','EMERGENCY_PAUSE','OPERATOR_NOT_ALLOWLISTED','PROTECTED_SIGNER_REQUIRED','WRONG_CHAIN','V4_DEPLOYMENT_UNVERIFIED']);
 });
});
