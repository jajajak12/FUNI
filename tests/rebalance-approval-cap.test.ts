import { describe, expect, it } from 'vitest';
import { evaluateCanaryGates } from '../apps/cli/src/live-canary-route.js';
import { evaluateRebalanceApproval, rebalanceApprovalPreviewLines } from '../apps/cli/src/rebalance.js';
import { runtimeEnvSchema } from '../apps/cli/src/runtime.js';
import { classifyRebalanceFunding } from '../apps/cli/src/v4-rebalance-executor.js';

const normalEntryBase={
 executionEnabled:true,dryRun:false,emergencyPause:false,liveCanaryEnabled:true,manualPause:false,
 runtimeConfigurationMatches:true,allowlisted:true,signerConfigured:true,chainId:4663,
 deploymentVerified:true,positionUsd:1000,approvalUsd:1000,maxPositionUsd:1000,maxApprovalUsd:1000,
 pendingExecutions:0,budgetAvailable:true,openPositions:0,maxOpenPositions:1,
 readiness:{status:'READY_FOR_USDG_ONLY_CANARY',approvalStatus:'APPROVAL_REQUIRED'} as const,
 poolValidation:{ok:true} as const,
};
const runtimeBase={
 ...process.env,
 RH_CHAIN_ID:'4663',
 MAX_POSITION_VALUE_USD:'1000',
 MAX_APPROVAL_VALUE_USD:'1000',
 MAX_REBALANCE_COMPOUND_VALUE_USD:'5000',
 MAX_REBALANCE_APPROVAL_VALUE_USD:'5000',
};

describe('separate environment-driven rebalance approval cap',()=>{
 it('keeps the normal entry approval gate at $1000',()=>{
  expect(evaluateCanaryGates(normalEntryBase).gates.APPROVAL_VALUE_WITHIN_CAP).toBe(true);
  const above=evaluateCanaryGates({...normalEntryBase,approvalUsd:1000.01});
  expect(above.gates.APPROVAL_VALUE_WITHIN_CAP).toBe(false);
  expect(above.blockingReasons).toContain('approval value cap exceeded');
 });
 it('permits an exact $5000 rebalance approval and rejects any amount above its dedicated cap',()=>{
  expect(evaluateRebalanceApproval({requestedApprovalUsd:5000,actualReopenedFundingRequirementUsd:5000,maximumApprovalUsd:5000})).toMatchObject({exactAmount:true,unlimited:false});
  expect(()=>evaluateRebalanceApproval({requestedApprovalUsd:5000.01,actualReopenedFundingRequirementUsd:5000.01,maximumApprovalUsd:5000})).toThrow('REBALANCE_APPROVAL_CAP_EXCEEDED');
 });
 it('never permits excess, mismatched, non-finite, or unlimited approval values',()=>{
  expect(()=>evaluateRebalanceApproval({requestedApprovalUsd:1001,actualReopenedFundingRequirementUsd:1000,maximumApprovalUsd:5000})).toThrow('REBALANCE_APPROVAL_NOT_EXACT');
  for(const value of [Number.NaN,Number.POSITIVE_INFINITY,0,-1])expect(()=>evaluateRebalanceApproval({requestedApprovalUsd:value,actualReopenedFundingRequirementUsd:value,maximumApprovalUsd:5000})).toThrow('REBALANCE_APPROVAL_VALUE_INVALID');
 });
 it('changes preview and final-preflight decisions when only the supplied environment value changes',()=>{
  const at5000=evaluateRebalanceApproval({requestedApprovalUsd:1000,actualReopenedFundingRequirementUsd:1000,maximumApprovalUsd:5000});
  const at750=evaluateRebalanceApproval({requestedApprovalUsd:750,actualReopenedFundingRequirementUsd:750,maximumApprovalUsd:750});
  expect(rebalanceApprovalPreviewLines(at5000)).toContain('Effective rebalance approval maximum: $5000.00');
  expect(rebalanceApprovalPreviewLines(at750)).toContain('Effective rebalance approval maximum: $750.00');
  expect(()=>evaluateRebalanceApproval({requestedApprovalUsd:1000,actualReopenedFundingRequirementUsd:1000,maximumApprovalUsd:750})).toThrow('REBALANCE_APPROVAL_CAP_EXCEEDED');
 });
 it('requires a finite positive startup value while accepting a safe bound of at least $5000',()=>{
  expect(runtimeEnvSchema.safeParse(runtimeBase).success).toBe(true);
  for(const value of [undefined,'','0','-1','NaN','Infinity']){
   const candidate={...runtimeBase,MAX_REBALANCE_APPROVAL_VALUE_USD:value};
   expect(runtimeEnvSchema.safeParse(candidate).success).toBe(false);
  }
 });
 it('keeps verified fees out of Normal reopen capital and computes only the exact principal top-up',()=>{
  expect(classifyRebalanceFunding({mode:'REBALANCE',principalRequiredRaw:25_000_000n,principalRecoveredRaw:24_000_000n,verifiedFeeRecoveredRaw:3_000_000n,compoundFeeLimitRaw:3_000_000n})).toEqual({principalForReopen:24_000_000n,principalTopUpRequired:1_000_000n,principalSurplus:0n,feeForReopen:0n,feeSurplus:3_000_000n,reopenRequiredRaw:25_000_000n,parkedSurplusRaw:3_000_000n});
 });
 it('compounds only verified fees within the explicit compound limit',()=>{
  expect(classifyRebalanceFunding({mode:'REBALANCE_COMPOUND',principalRequiredRaw:25_000_000n,principalRecoveredRaw:26_000_000n,verifiedFeeRecoveredRaw:3_000_000n,compoundFeeLimitRaw:2_000_000n})).toMatchObject({principalTopUpRequired:0n,principalSurplus:1_000_000n,feeForReopen:2_000_000n,feeSurplus:1_000_000n,reopenRequiredRaw:27_000_000n,parkedSurplusRaw:2_000_000n});
 });
});
