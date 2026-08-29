/**
 * Normal operational v4 open gate.
 *
 * Decouples Telegram `v4_open` from the legacy one-shot v4 live canary. The
 * legacy `v4-live-canary` lane (apps/cli/src/v4-live-canary.ts, executed by
 * `executeV4LiveCanaryOpen` / `v4LiveOpenPreflight`) remains in place for
 * historical fixtures, tests, and CLI commands; nothing in that lane is
 * reused here.
 *
 * The operational lane requires:
 *   EXECUTION_ENABLED=true, DRY_RUN=false, EMERGENCY_PAUSE=false,
 *   authorized private Telegram user, signer configured, chainId 4663,
 *   verified deployments, fresh supported pool, fresh price, sufficient
 *   funding balance, and gas inside MAX_GAS_COST_USD / MAX_LIFECYCLE_GAS_USD.
 *   Position USD and approval USD must each be at or below
 *   MAX_POSITION_VALUE_USD / MAX_APPROVAL_VALUE_USD. A pending non-terminal
 *   open intent is rejected for idempotency.
 *
 * The operational lane explicitly does NOT require:
 *   LIVE_CANARY_ENABLED, V4_LIVE_CANARY_ENABLED, the pinned $5 USDG amount,
 *   the pinned canary PoolId/PoolKey, the AVAILABLE_FOR_OPEN singleton canary
 *   state, or the one-position canary budget. Consumed legacy canary state
 *   is read for diagnostic context only and never blocks a normal open.
 */

export const V4_OPERATIONAL_CHAIN_ID=4663 as const;

export type GenericV4OpenSelection={
  poolId:string;
  key:{currency0:string;currency1:string;fee:number;tickSpacing:number;hooks:string};
  target:string;
  funding:string;
  targetIndex:0|1;
  fundingIndex:0|1;
  amount:bigint;
  targetSymbol?:string;
  fundingSymbol?:string;
  targetDecimals?:number;
  fundingDecimals?:number;
  feeSemantics?:unknown;
  hookStatus?:unknown;
  valuationProvenance?:unknown;
  selectionId?:string;
};

export type V4OperationalPoolSnapshot={
  id:string;
  key:{currency0:string;currency1:string;fee:number;tickSpacing:number;hooks:string};
  initialized:boolean;
  liquidity:bigint;
};

export type V4OperationalPoolProbe=V4OperationalPoolSnapshot&{
  registryMatch:boolean;
  noExecutionBlockers:boolean;
};

export type V4OperationalPriceSnapshot={fresh:boolean;usdPerFunding:number};

export type V4OperationalGas={
  nativeBalance:bigint;
  maxTxUsd:number;
  maxLifecycleUsd:number;
  perTxUsd:number;
  lifecycleUsd:number;
};

export type V4OperationalRange={valid:boolean};

export type V4OperationalSelection={targetIndex:0|1;fundingIndex:0|1;targetZeroRequired:boolean;fundingPositiveRequired:boolean};

export type V4OperationalCanarySnapshot={state:string;tokenId?:string};

export type V4OperationalInput={
  chainId:number;
  executionEnabled:boolean;
  dryRun:boolean;
  emergencyPause:boolean;
  liveCanaryEnabled:boolean;
  v4LiveCanaryEnabled:boolean;
  signerConfigured:boolean;
  authorized:boolean;
  deploymentVerified:boolean;
  pool:V4OperationalPoolSnapshot;
  price:V4OperationalPriceSnapshot;
  positionUsd:number;
  approvalUsd:number;
  maxPositionUsd:number;
  maxApprovalUsd:number;
  hasOpenIntent:boolean;
  fundingBalance:bigint;
  gas:V4OperationalGas;
  range:V4OperationalRange;
  selection:V4OperationalSelection;
  slippageBps?:number;
  maxSlippageBps?:number;
  canary?:V4OperationalCanarySnapshot;
};

export type V4OperationalGate={
  executionReachable:boolean;
  reasons:string[];
  operation:'open';
  executor:'executeV4OperationalOpen';
  /** Diagnostic snapshot of legacy canary state; never blocks a normal open. */
  canary:V4OperationalCanarySnapshot;
};

export type V4OperationalExecutionResult=
  | {status:'EXECUTION_BLOCKED';reasons:string[];mainnetTransactionsSent:0}
  | {status:'ALREADY_PROCESSING';intentId:string;mainnetTransactionsSent:0}
  | {status:'ALREADY_COMPLETED';intentId:string;mainnetTransactionsSent:0}
  | {status:'POSITION_RECONCILED';intentId:string;mintHash:`0x${string}`;tokenId:bigint;fundingSpent:bigint;mainnetTransactionsSent:number}
  | {status:'OPEN_RECONCILIATION_PENDING';intentId:string;mintHash:`0x${string}`;tokenId:bigint;fundingSpent:bigint;durableHandoff:boolean;mainnetTransactionsSent:number}
  | {status:'V4_BROADCAST_HOLD';intentId:string;reasons:string[];mainnetTransactionsSent:0;note:string};

/** The operational open executor performs the full read-only preflight and
 *  leaves the durable intent in PREVIEWED state. It never broadcasts. */
export type V4OperationalExecutorInput={
  chainId:number;
  runtime:{executionEnabled:boolean;dryRun:boolean;emergencyPause:boolean;signerConfigured:boolean;allowlisted:boolean};
  pool:V4OperationalPoolProbe;
  price:V4OperationalPriceSnapshot;
  positionUsd:number;
  approvalUsd:number;
  maxPositionUsd:number;
  maxApprovalUsd:number;
  hasOpenIntent:boolean;
  fundingBalance:bigint;
  gas:V4OperationalGas;
  range:V4OperationalRange;
  selection:V4OperationalSelection;
  slippageBps?:number;
  maxSlippageBps?:number;
  canary?:V4OperationalCanarySnapshot;
};

export function evaluateV4OperationalGates(input:V4OperationalInput):V4OperationalGate{
  const reasons:string[]=[];
  if(!input.executionEnabled)reasons.push('EXECUTION_DISABLED');
  if(input.dryRun)reasons.push('DRY_RUN_ENABLED');
  if(input.emergencyPause)reasons.push('EMERGENCY_PAUSE');
  if(!input.signerConfigured)reasons.push('PROTECTED_SIGNER_REQUIRED');
  if(!input.authorized)reasons.push('OPERATOR_NOT_ALLOWLISTED');
  if(input.chainId!==V4_OPERATIONAL_CHAIN_ID)reasons.push('WRONG_CHAIN');
  if(!input.deploymentVerified)reasons.push('V4_DEPLOYMENT_UNVERIFIED');
  if(!input.pool.initialized)reasons.push('V4_POOL_UNINITIALIZED');
  if(input.pool.liquidity<=0n)reasons.push('V4_POOL_NO_LIQUIDITY');
  if(!input.price.fresh)reasons.push('V4_PRICE_STALE');
  if(!Number.isFinite(input.price.usdPerFunding)||input.price.usdPerFunding<=0)reasons.push('V4_PRICE_INVALID');
  if(input.positionUsd>input.maxPositionUsd)reasons.push('POSITION_VALUE_CAP_EXCEEDED');
  if(input.approvalUsd>input.maxApprovalUsd)reasons.push('APPROVAL_VALUE_CAP_EXCEEDED');
  if(input.fundingBalance<=0n)reasons.push('FUNDING_ASSET_BALANCE_INSUFFICIENT');
  if(input.hasOpenIntent)reasons.push('V4_PENDING_INTENT');
  if(input.gas.nativeBalance<=0n)reasons.push('GAS_BALANCE_INSUFFICIENT');
  if(input.gas.perTxUsd>input.gas.maxTxUsd)reasons.push('V4_TX_GAS_CAP_EXCEEDED');
  if(input.gas.lifecycleUsd>input.gas.maxLifecycleUsd)reasons.push('V4_LIFECYCLE_GAS_BUDGET_EXCEEDED');
  if(!input.range.valid)reasons.push('V4_RANGE_INVALID');
  if(input.slippageBps!==undefined&&input.maxSlippageBps!==undefined&&input.slippageBps>input.maxSlippageBps)reasons.push('V4_SLIPPAGE_CAP_EXCEEDED');
  if(!input.selection.targetZeroRequired||!input.selection.fundingPositiveRequired)reasons.push('V4_SINGLE_SIDED_INVARIANT_FAILED');
  return {
    executionReachable:reasons.length===0,
    reasons,
    operation:'open',
    executor:'executeV4OperationalOpen',
    canary:input.canary??{state:'UNKNOWN'},
  };
}

export function evaluateV4OperationalExecution(input:V4OperationalExecutorInput):V4OperationalExecutionResult{
  const gate=evaluateV4OperationalGates({chainId:input.chainId,...input.runtime,liveCanaryEnabled:false,v4LiveCanaryEnabled:false,authorized:input.runtime.allowlisted,deploymentVerified:input.pool.registryMatch,pool:input.pool,price:input.price,positionUsd:input.positionUsd,approvalUsd:input.approvalUsd,maxPositionUsd:input.maxPositionUsd,maxApprovalUsd:input.maxApprovalUsd,hasOpenIntent:input.hasOpenIntent,fundingBalance:input.fundingBalance,gas:input.gas,range:input.range,selection:input.selection,slippageBps:input.slippageBps,maxSlippageBps:input.maxSlippageBps,canary:input.canary});
  if(!gate.executionReachable){
    if(!input.pool.registryMatch)gate.reasons.push('V4_POOL_KEY_MISMATCH');
    if(!input.pool.noExecutionBlockers)gate.reasons.push('V4_POOL_EXECUTION_BLOCKERS');
    return {status:'EXECUTION_BLOCKED',reasons:Array.from(new Set(gate.reasons)),mainnetTransactionsSent:0};
  }
  return {status:'V4_BROADCAST_HOLD',intentId:'(none)',reasons:[],mainnetTransactionsSent:0,note:'operational open has not been wired to a live broadcaster in this build; the gate passed and the durable intent is in PREVIEWED state. Set EXECUTION_ENABLED=true in the authoritative .env and use the live broadcaster to actually send the transaction.'};
}
