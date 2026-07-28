import type { Address } from 'viem';
import { inspectV3Pool } from '@robin/core';
import { SqliteLedgerRepository } from '@robin/ledger';
import {
  canaryGate,
  executeGuardedSingleSidedCanary,
  type GuardedCanaryInput,
} from './guarded-canary.js';

export type RouteFundingReadiness = {
  status: string;
  approvalStatus: 'APPROVAL_REQUIRED' | 'ALLOWANCE_SUFFICIENT';
  estimatedGasUsd?: number;
};

export type CanaryGateEvaluationInput = {
  executionEnabled: boolean;
  dryRun: boolean;
  emergencyPause: boolean;
  liveCanaryEnabled: boolean;
  manualPause: boolean;
  runtimeConfigurationMatches: boolean;
  allowlisted: boolean;
  signerConfigured: boolean;
  chainId: number;
  deploymentVerified: boolean;
  positionUsd: number;
  approvalUsd: number;
  maxPositionUsd: number;
  maxApprovalUsd: number;
  pendingExecutions: number;
  budgetAvailable: boolean;
  openPositions: number;
  maxOpenPositions: number;
  readiness: RouteFundingReadiness;
  poolValidation?: { ok: boolean; reason?: string };
};

/** Shared by CLI, Telegram preview/callback, and the production route. */
export function evaluateCanaryGates(input: CanaryGateEvaluationInput) {
  const gates = {
    EXECUTION_ENABLED: input.executionEnabled,
    DRY_RUN_DISABLED: !input.dryRun,
    EMERGENCY_PAUSE_DISABLED: !input.emergencyPause,
    LIVE_CANARY_ENABLED: input.liveCanaryEnabled,
    DURABLE_MANUAL_PAUSE_DISABLED: !input.manualPause,
    RUNTIME_CONFIGURATION_MATCH: input.runtimeConfigurationMatches,
    CANARY_BUDGET_AVAILABLE: input.budgetAvailable,
    PROTECTED_SIGNER_CONFIGURED: input.signerConfigured,
    OPERATOR_ALLOWLISTED: input.allowlisted,
    CHAIN_ID_4663: input.chainId === 4663,
    DEPLOYMENT_REGISTRY_VERIFIED: input.deploymentVerified,
    EXACT_POOL_VALID: input.poolValidation?.ok === true,
    FUNDING_READY: input.readiness.status.startsWith('READY_FOR_'),
    GAS_ESTIMATE_WITHIN_CAP: input.readiness.estimatedGasUsd !== undefined,
    POSITION_VALUE_WITHIN_CAP: input.positionUsd <= input.maxPositionUsd,
    APPROVAL_VALUE_WITHIN_CAP: input.approvalUsd <= input.maxApprovalUsd,
    NO_PENDING_INTENT: input.pendingExecutions === 0,
    NO_EXISTING_CANARY_POSITION: input.openPositions < input.maxOpenPositions,
  };
  const reasons: string[] = [];
  if (!input.runtimeConfigurationMatches) reasons.push('RUNTIME_CONFIGURATION_MISMATCH');
  if (input.manualPause) reasons.push('DURABLE_MANUAL_PAUSE');
  const legacy = canaryGate({
    executionEnabled: input.executionEnabled,
    dryRun: input.dryRun,
    emergencyPause: input.emergencyPause || input.manualPause,
    liveCanaryEnabled: input.liveCanaryEnabled,
    allowlisted: input.allowlisted,
    signerConfigured: input.signerConfigured,
    chainId: input.chainId,
    deploymentVerified: input.deploymentVerified,
    positionUsd: input.positionUsd,
    approvalUsd: input.approvalUsd,
    maxPositionUsd: input.maxPositionUsd,
    maxApprovalUsd: input.maxApprovalUsd,
    pendingExecutions: input.pendingExecutions,
    budgetAvailable: input.budgetAvailable,
    openPositions: input.openPositions,
    maxOpenPositions: input.maxOpenPositions,
  });
  if (legacy) reasons.push(legacy);
  if (!input.poolValidation?.ok) reasons.push(input.poolValidation?.reason ?? 'STALE_POOL_SELECTION');
  if (!input.readiness.status.startsWith('READY_FOR_')) reasons.push(input.readiness.status);
  if (input.readiness.estimatedGasUsd === undefined) reasons.push('GAS_ESTIMATE_UNAVAILABLE');
  return { executionReachable: reasons.length === 0, gates, blockingReasons: [...new Set(reasons)], executor: 'executeGuardedSingleSidedCanary' as const };
}

export type ConfirmedCanaryRouteInput = {
  repo: SqliteLedgerRepository;
  confirmationId: string;
  selectionId: string;
  sessionId: string;
  buttonPool: Address;
  verifiedFactory: Address;
  userId: string;
  chatId: string;
  allowlisted: boolean;
  readiness: RouteFundingReadiness;
  executionEnabled: boolean;
  dryRun: boolean;
  emergencyPause: boolean;
  liveCanaryEnabled: boolean;
  signerConfigured: boolean;
  chainId: number;
  deploymentVerified: boolean;
  runtimeConfigurationMatches?: boolean;
  positionUsd: number;
  approvalUsd: number;
  maxPositionUsd: number;
  maxApprovalUsd: number;
  openPositions: number;
  maxOpenPositions: number;
  wallet: Address;
  executorInput: Omit<GuardedCanaryInput, 'repo' | 'intentId'>;
  log?: (event: string, payload: Record<string, unknown>) => void;
  poolValidator?: (input: ConfirmedCanaryRouteInput) => Promise<{ok:boolean;reason?:string}>;
};

type Executor = typeof executeGuardedSingleSidedCanary;

export async function validateBoundPool(input: Pick<ConfirmedCanaryRouteInput, 'repo'|'selectionId'|'sessionId'|'buttonPool'|'verifiedFactory'|'userId'|'chatId'|'executorInput'>) {
  const selected = input.repo.poolSelection(input.selectionId);
  if (!selected || selected.user_id !== input.userId || selected.chat_id !== input.chatId || selected.session_id !== input.sessionId || Number(selected.superseded) !== 0) return { ok: false as const, reason: 'STALE_POOL_SELECTION' };
  const addresses = [String(selected.pool_address).toLowerCase(), input.buttonPool.toLowerCase(), input.executorInput.pool.toLowerCase()];
  if (new Set(addresses).size !== 1) return { ok: false as const, reason: 'POOL_SELECTION_MISMATCH' };
  const refreshed = await inspectV3Pool(input.executorInput.rpc, input.executorInput.pool);
  if (refreshed.status === 'unavailable') return { ok: false as const, reason: 'STALE_POOL_SELECTION' };
  const pool = refreshed.value;
  if (pool.address.toLowerCase() !== addresses[0] || pool.factory.toLowerCase() !== String(selected.factory_address).toLowerCase() || pool.factory.toLowerCase() !== input.verifiedFactory.toLowerCase()) return { ok: false as const, reason: 'POOL_SELECTION_MISMATCH' };
  const expectedTokens = [input.executorInput.target.address.toLowerCase(), input.executorInput.funding.address.toLowerCase()].sort().join(':');
  if ([pool.token0.toLowerCase(), pool.token1.toLowerCase()].sort().join(':') !== expectedTokens || pool.token0.toLowerCase() !== String(selected.token0_address).toLowerCase() || pool.token1.toLowerCase() !== String(selected.token1_address).toLowerCase()) return { ok: false as const, reason: 'POOL_TOKEN_MISMATCH' };
  if (pool.fee !== Number(selected.fee) || pool.tickSpacing !== Number(selected.tick_spacing)) return { ok: false as const, reason: 'POOL_FEE_MISMATCH' };
  if (!pool.initialized || pool.tick < -887272 || pool.tick > 887272) return { ok: false as const, reason: 'STALE_POOL_SELECTION' };
  if (pool.liquidity <= 0n) return { ok: false as const, reason: 'POOL_ZERO_ACTIVE_LIQUIDITY' };
  return { ok: true as const, selected, refreshed: pool };
}

/** One atomic budget claim bridges one bound Telegram confirmation to the sender. */
export async function executeConfirmedCanaryRoute(input: ConfirmedCanaryRouteInput, executor: Executor = executeGuardedSingleSidedCanary) {
  const poolValidation = await (input.poolValidator ?? validateBoundPool)(input);
  const safety = input.repo.safetyState() ?? {};
  const evaluation = evaluateCanaryGates({
    ...input,
    manualPause: safety.manualPause === true,
    runtimeConfigurationMatches: input.runtimeConfigurationMatches ?? true,
    pendingExecutions: input.repo.pendingTransactions() + input.repo.activeCanaryExecutionCount(input.wallet),
    budgetAvailable: input.repo.canaryBudgetAvailable(),
    poolValidation,
  });
  input.log?.('canary_gate_evaluated', { confirmationId: input.confirmationId, selectionId: input.selectionId, ...evaluation });
  if (!evaluation.executionReachable) return { status: 'EXECUTION_BLOCKED' as const, reason: evaluation.blockingReasons.join(', '), evaluation };
  const claim = input.repo.claimCanaryConfirmation({ confirmationId: input.confirmationId, owner: input.userId, userId: input.userId, chatId: input.chatId, wallet: input.wallet, now: Date.now(), payload: { confirmationId: input.confirmationId, selectionId: input.selectionId, pool: input.buttonPool, readiness: input.readiness } });
  if (claim.status === 'ALREADY_CLAIMED') return { status: 'ALREADY_PROCESSING_OR_COMPLETED' as const, intentId: String(claim.intent.id) };
  if (claim.status !== 'CLAIMED') return { status: 'EXECUTION_BLOCKED' as const, reason: claim.status };
  const intentId = String(claim.intent.id);
  const result = await executor({ ...input.executorInput, repo: input.repo, intentId });
  return { status: 'EXECUTOR_INVOKED' as const, intentId, result };
}

export type PreparedCanaryRouteInput=Omit<ConfirmedCanaryRouteInput,'confirmationId'>&{intentId:string};

/** The final Telegram button claims this durable amount-entry intent. Preview age is intentionally irrelevant. */
export async function executePreparedCanaryRoute(input:PreparedCanaryRouteInput,executor:Executor=executeGuardedSingleSidedCanary){
 const existing=input.repo.canaryIntent(input.intentId);if(!existing)return {status:'EXECUTION_BLOCKED' as const,reason:'INVALID_INTENT'};
 if(existing.state!=='PREVIEWED')return {status:'ALREADY_PROCESSING_OR_COMPLETED' as const,intentId:input.intentId};
 const poolValidation=await (input.poolValidator??validateBoundPool)(input as unknown as ConfirmedCanaryRouteInput),safety=input.repo.safetyState()??{},ownPreparedIntent=existing.state==='PREVIEWED'?1:0,evaluation=evaluateCanaryGates({...input,manualPause:safety.manualPause===true,runtimeConfigurationMatches:input.runtimeConfigurationMatches??true,pendingExecutions:Math.max(0,input.repo.pendingTransactions()+input.repo.activeCanaryExecutionCount(input.wallet)-ownPreparedIntent),budgetAvailable:input.repo.canaryBudgetAvailable(),poolValidation});
 input.log?.('canary_gate_evaluated',{stage:'final_click',intentId:input.intentId,selectionId:input.selectionId,...evaluation});
 if(!evaluation.executionReachable)return {status:'EXECUTION_BLOCKED' as const,reason:evaluation.blockingReasons.join(', '),evaluation};
 const claim=input.repo.claimPreparedCanaryIntent({intentId:input.intentId,owner:input.userId,wallet:input.wallet});
 if(claim.status==='ALREADY_CLAIMED')return {status:'ALREADY_PROCESSING_OR_COMPLETED' as const,intentId:input.intentId};
 if(claim.status!=='CLAIMED')return {status:'EXECUTION_BLOCKED' as const,reason:claim.status};
 const result=await executor({...input.executorInput,repo:input.repo,intentId:input.intentId});return {status:'EXECUTOR_INVOKED' as const,intentId:input.intentId,result};
}

export type DirectAmountCanaryRouteInput = Omit<ConfirmedCanaryRouteInput,'confirmationId'> & {
  updateId:string;
  messageId:string;
};

/**
 * Production amount-entry bridge. The Telegram update is the single-use
 * confirmation; no preview request, hash, expiry, or callback is consulted.
 */
export async function executeDirectAmountCanary(input:DirectAmountCanaryRouteInput,executor:Executor=executeGuardedSingleSidedCanary){
  const key=`telegram-amount:${input.chatId}:${input.messageId}:${input.updateId}`,existing=input.repo.canaryIntentByKey(key);
  if(existing)return {status:'ALREADY_PROCESSING_OR_COMPLETED' as const,intentId:String(existing.id)};
  const poolValidation=await (input.poolValidator??validateBoundPool)(input as unknown as ConfirmedCanaryRouteInput);
  const safety=input.repo.safetyState()??{},evaluation=evaluateCanaryGates({...input,manualPause:safety.manualPause===true,runtimeConfigurationMatches:input.runtimeConfigurationMatches??true,pendingExecutions:input.repo.pendingTransactions()+input.repo.activeCanaryExecutionCount(input.wallet),budgetAvailable:input.repo.canaryBudgetAvailable(),poolValidation});
  input.log?.('canary_gate_evaluated',{stage:'amount_entry',updateId:input.updateId,messageId:input.messageId,selectionId:input.selectionId,...evaluation});
  if(!evaluation.executionReachable)return {status:'EXECUTION_BLOCKED' as const,reason:evaluation.blockingReasons.join(', '),evaluation};
  const claim=input.repo.claimDirectCanaryIntent({updateId:input.updateId,messageId:input.messageId,owner:input.userId,userId:input.userId,chatId:input.chatId,sessionId:input.sessionId,selectionId:input.selectionId,wallet:input.wallet,now:Date.now(),payload:{pool:input.buttonPool,fee:(poolValidation as any).refreshed?.fee,target:input.executorInput.target,funding:input.executorInput.funding,amount:input.executorInput.fundingAmount,range:{upperDropPct:input.executorInput.upperDropPct,lowerDropPct:input.executorInput.lowerDropPct},readiness:input.readiness}});
  if(claim.status==='ALREADY_CLAIMED')return {status:'ALREADY_PROCESSING_OR_COMPLETED' as const,intentId:String(claim.intent.id)};
  if(claim.status!=='CLAIMED')return {status:'EXECUTION_BLOCKED' as const,reason:claim.status};
  const intentId=String(claim.intent.id),result=await executor({...input.executorInput,repo:input.repo,intentId});
  return {status:'EXECUTOR_INVOKED' as const,intentId,result};
}
