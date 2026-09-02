import { describe, expect, it } from 'vitest';
import { evaluateV4OperationalExecution, evaluateV4OperationalGates, type V4OperationalGate } from '../apps/cli/src/v4-operational-open.js';
import { evaluateV4OperationalGasStage, permit2ApprovalRequired } from '../apps/cli/src/v4-operational-executor.js';
import { runtimeEnvSchema } from '../apps/cli/src/runtime.js';

const allowed=4663;
const base={
  chainId:allowed,
  executionEnabled:true,
  dryRun:false,
  emergencyPause:false,
  liveCanaryEnabled:false,
  v4LiveCanaryEnabled:false,
  signerConfigured:true,
  authorized:true,
  deploymentVerified:true,
  pool:{id:'0xfcfae8fa0bd6da961bcf5d990f27690932deac4f093e99bf3e871691c6586593',key:{currency0:'0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',currency1:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',fee:500,tickSpacing:10,hooks:'0x0000000000000000000000000000000000000000'},initialized:true,liquidity:1_000n},
  price:{fresh:true,usdPerFunding:1},
  positionUsd:5,
  approvalUsd:5,
  maxPositionUsd:1000,
  maxApprovalUsd:1000,
  hasOpenIntent:false,
  fundingBalance:5_000_000n,
  gas:{nativeBalance:1n,maxTxUsd:0.25,maxLifecycleUsd:1,perTxUsd:0.1,lifecycleUsd:0.3},
  range:{valid:true},
  selection:{targetIndex:0,fundingIndex:1,targetZeroRequired:true,fundingPositiveRequired:true}
} as const;

describe('v4 operational open gate',()=>{
  it('skips an unexpired Permit2 allowance that already exceeds the required amount',()=>{expect(permit2ApprovalRequired((2n**160n)-1n,5_000_000n,2_000,1_000n)).toBe(false);expect(permit2ApprovalRequired(4_999_999n,5_000_000n,2_000,1_000n)).toBe(true);expect(permit2ApprovalRequired(5_000_000n,5_000_000n,1_000,1_000n)).toBe(true);});
  it('passes when only the global execution toggle is enabled and both canary flags are false',()=>{
    const gate=evaluateV4OperationalGates(base);
    expect(gate.executionReachable).toBe(true);
    expect(gate.reasons).toEqual([]);
    expect(gate.executor).toBe('executeV4OperationalOpen');
  });

  it('consumed legacy canary state does not block normal open',()=>{
    // legacy canary is in OPENED state but v4LiveCanaryEnabled is false; operational path must still pass
    const gate=evaluateV4OperationalGates({...base, canary:{state:'OPENED',tokenId:'42'}});
    expect(gate.executionReachable).toBe(true);
    expect(gate.reasons).toEqual([]);
  });

  it('legacy canary gating reasons are never emitted by the operational evaluator',()=>{
    const gate=evaluateV4OperationalGates(base);
    for(const r of gate.reasons){
      expect(r).not.toMatch(/V4_LIVE_CANARY|V4_CANARY|LIVE_CANARY/);
    }
  });

  it('blocks when EXECUTION_ENABLED is false',()=>{
    expect(evaluateV4OperationalGates({...base,executionEnabled:false}).reasons).toContain('EXECUTION_DISABLED');
  });
  it('blocks when DRY_RUN is true',()=>{
    expect(evaluateV4OperationalGates({...base,dryRun:true}).reasons).toContain('DRY_RUN_ENABLED');
  });
  it('blocks when EMERGENCY_PAUSE is true',()=>{
    expect(evaluateV4OperationalGates({...base,emergencyPause:true}).reasons).toContain('EMERGENCY_PAUSE');
  });
  it('blocks when signer is not configured',()=>{
    expect(evaluateV4OperationalGates({...base,signerConfigured:false}).reasons).toContain('PROTECTED_SIGNER_REQUIRED');
  });
  it('blocks when operator is not allowlisted',()=>{
    expect(evaluateV4OperationalGates({...base,authorized:false}).reasons).toContain('OPERATOR_NOT_ALLOWLISTED');
  });
  it('blocks when chainId is not 4663',()=>{
    expect(evaluateV4OperationalGates({...base,chainId:1}).reasons).toContain('WRONG_CHAIN');
  });
  it('blocks when deployments are not verified',()=>{
    expect(evaluateV4OperationalGates({...base,deploymentVerified:false}).reasons).toContain('V4_DEPLOYMENT_UNVERIFIED');
  });
  it('blocks when pool is uninitialized or has no liquidity',()=>{
    expect(evaluateV4OperationalGates({...base,pool:{...base.pool,initialized:false}}).reasons).toContain('V4_POOL_UNINITIALIZED');
    expect(evaluateV4OperationalGates({...base,pool:{...base.pool,liquidity:0n}}).reasons).toContain('V4_POOL_NO_LIQUIDITY');
  });
  it('blocks when price is not fresh',()=>{
    expect(evaluateV4OperationalGates({...base,price:{fresh:false,usdPerFunding:1}}).reasons).toContain('V4_PRICE_STALE');
  });
  it('blocks when position or approval USD exceeds the operational caps',()=>{
    expect(evaluateV4OperationalGates({...base,positionUsd:1000.01}).reasons).toContain('POSITION_VALUE_CAP_EXCEEDED');
    expect(evaluateV4OperationalGates({...base,approvalUsd:1000.01}).reasons).toContain('APPROVAL_VALUE_CAP_EXCEEDED');
  });
  it('blocks when funding balance is below the requested amount',()=>{
    expect(evaluateV4OperationalGates({...base,fundingBalance:0n}).reasons).toContain('FUNDING_ASSET_BALANCE_INSUFFICIENT');
  });
  it('blocks when an existing non-terminal open intent is in flight (idempotency guard)',()=>{
    expect(evaluateV4OperationalGates({...base,hasOpenIntent:true}).reasons).toContain('V4_PENDING_INTENT');
  });
  it('blocks when per-transaction or lifecycle gas caps are breached',()=>{
    expect(evaluateV4OperationalGates({...base,gas:{...base.gas,perTxUsd:0.26}}).reasons).toContain('V4_TX_GAS_CAP_EXCEEDED');
    expect(evaluateV4OperationalGates({...base,gas:{...base.gas,lifecycleUsd:1.01}}).reasons).toContain('V4_LIFECYCLE_GAS_BUDGET_EXCEEDED');
    expect(evaluateV4OperationalGates({...base,gas:{...base.gas,nativeBalance:0n}}).reasons).toContain('GAS_BALANCE_INSUFFICIENT');
  });
  it('enforces the public $0.50 operational gas boundary without weakening the schema ceiling',()=>{
    const configured=runtimeEnvSchema.safeParse({...process.env,RH_CHAIN_ID:'4663',MAX_GAS_COST_USD:'0.50'});
    expect(configured.success).toBe(true);
    if(configured.success)expect(configured.data.MAX_GAS_COST_USD).toBe(.5);
    expect(evaluateV4OperationalGates({...base,gas:{...base.gas,maxTxUsd:.5,perTxUsd:.3192}}).reasons).not.toContain('V4_TX_GAS_CAP_EXCEEDED');
    expect(evaluateV4OperationalGates({...base,gas:{...base.gas,maxTxUsd:.5,perTxUsd:.5}}).reasons).not.toContain('V4_TX_GAS_CAP_EXCEEDED');
    expect(evaluateV4OperationalGates({...base,gas:{...base.gas,maxTxUsd:.5,perTxUsd:.5000001}}).reasons).toContain('V4_TX_GAS_CAP_EXCEEDED');
    expect(runtimeEnvSchema.safeParse({...process.env,RH_CHAIN_ID:'4663',MAX_GAS_COST_USD:'2.00'}).success).toBe(true);
    expect(runtimeEnvSchema.safeParse({...process.env,RH_CHAIN_ID:'4663',MAX_GAS_COST_USD:'2.01'}).success).toBe(false);
  });
  it('blocks when the range or single-sided invariant is not satisfied',()=>{
    expect(evaluateV4OperationalGates({...base,range:{valid:false}}).reasons).toContain('V4_RANGE_INVALID');
    expect(evaluateV4OperationalGates({...base,selection:{...base.selection,targetZeroRequired:false}}).reasons).toContain('V4_SINGLE_SIDED_INVARIANT_FAILED');
  });
  it('reports all blocking reasons at once for diagnostic completeness',()=>{
    const reasons=evaluateV4OperationalGates({...base,executionEnabled:false,dryRun:true,emergencyPause:true,signerConfigured:false,authorized:false,chainId:1,deploymentVerified:false,pool:{...base.pool,initialized:false},price:{fresh:false,usdPerFunding:1},positionUsd:9_999,approvalUsd:9_999,hasOpenIntent:true,fundingBalance:0n,gas:{...base.gas,nativeBalance:0n,perTxUsd:0.3,lifecycleUsd:2},range:{valid:false}}).reasons;
    expect(reasons).toEqual(expect.arrayContaining([
      'EXECUTION_DISABLED','DRY_RUN_ENABLED','EMERGENCY_PAUSE','PROTECTED_SIGNER_REQUIRED',
      'OPERATOR_NOT_ALLOWLISTED','WRONG_CHAIN','V4_DEPLOYMENT_UNVERIFIED',
      'V4_POOL_UNINITIALIZED','V4_PRICE_STALE','POSITION_VALUE_CAP_EXCEEDED',
      'APPROVAL_VALUE_CAP_EXCEEDED','FUNDING_ASSET_BALANCE_INSUFFICIENT',
      'V4_PENDING_INTENT','GAS_BALANCE_INSUFFICIENT','V4_TX_GAS_CAP_EXCEEDED',
      'V4_LIFECYCLE_GAS_BUDGET_EXCEEDED','V4_RANGE_INVALID'
    ]));
  });
});

describe('v4 operational open executor (no broadcast)',()=>{
  const baseRuntime={executionEnabled:true,dryRun:false,emergencyPause:false,signerConfigured:true,allowlisted:true} as const;
  const basePool={id:'0xfcfae8fa0bd6da961bcf5d990f27690932deac4f093e99bf3e871691c6586593',key:{currency0:'0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',currency1:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',fee:500,tickSpacing:10,hooks:'0x0000000000000000000000000000000000000000'},initialized:true,liquidity:1_000n,registryMatch:true,noExecutionBlockers:true} as const;
  const baseGas={nativeBalance:1n,maxTxUsd:0.25,maxLifecycleUsd:1,perTxUsd:0.1,lifecycleUsd:0.3} as const;

  it('returns V4_BROADCAST_HOLD with zero transactions and zero mainnet when the gate passes and both canary flags are false',()=>{
    const result=evaluateV4OperationalExecution({chainId:4663,runtime:baseRuntime,pool:basePool,price:{fresh:true,usdPerFunding:1},positionUsd:5,approvalUsd:5,maxPositionUsd:1000,maxApprovalUsd:1000,hasOpenIntent:false,fundingBalance:5_000_000n,gas:baseGas,range:{valid:true},selection:{targetIndex:0,fundingIndex:1,targetZeroRequired:true,fundingPositiveRequired:true}});
    expect(result.status).toBe('V4_BROADCAST_HOLD');
    expect(result.mainnetTransactionsSent).toBe(0);
    if(result.status==='V4_BROADCAST_HOLD')expect(result.reasons).toEqual([]);
  });
  it('returns EXECUTION_BLOCKED with the global flags when execution is disabled',()=>{
    const result=evaluateV4OperationalExecution({chainId:4663,runtime:{...baseRuntime,executionEnabled:false},pool:basePool,price:{fresh:true,usdPerFunding:1},positionUsd:5,approvalUsd:5,maxPositionUsd:1000,maxApprovalUsd:1000,hasOpenIntent:false,fundingBalance:5_000_000n,gas:baseGas,range:{valid:true},selection:{targetIndex:0,fundingIndex:1,targetZeroRequired:true,fundingPositiveRequired:true}});
    expect(result.status).toBe('EXECUTION_BLOCKED');
    if(result.status==='EXECUTION_BLOCKED'){
      expect(result.reasons).toEqual(expect.arrayContaining(['EXECUTION_DISABLED']));
      expect(result.mainnetTransactionsSent).toBe(0);
    }
  });
  it('never broadcasts: mainnetTransactionsSent is always 0 in this build',()=>{
    const success=evaluateV4OperationalExecution({chainId:4663,runtime:baseRuntime,pool:basePool,price:{fresh:true,usdPerFunding:1},positionUsd:5,approvalUsd:5,maxPositionUsd:1000,maxApprovalUsd:1000,hasOpenIntent:false,fundingBalance:5_000_000n,gas:baseGas,range:{valid:true},selection:{targetIndex:0,fundingIndex:1,targetZeroRequired:true,fundingPositiveRequired:true}});
    const blocked=evaluateV4OperationalExecution({chainId:4663,runtime:{...baseRuntime,dryRun:true,emergencyPause:true},pool:basePool,price:{fresh:true,usdPerFunding:1},positionUsd:5,approvalUsd:5,maxPositionUsd:1000,maxApprovalUsd:1000,hasOpenIntent:false,fundingBalance:5_000_000n,gas:baseGas,range:{valid:true},selection:{targetIndex:0,fundingIndex:1,targetZeroRequired:true,fundingPositiveRequired:true}});
    expect(success.mainnetTransactionsSent).toBe(0);
    expect(blocked.mainnetTransactionsSent).toBe(0);
  });
  it('passes regardless of legacy canary state (consumed canary does not block normal open)',()=>{
    const result=evaluateV4OperationalExecution({chainId:4663,runtime:baseRuntime,pool:basePool,price:{fresh:true,usdPerFunding:1},positionUsd:5,approvalUsd:5,maxPositionUsd:1000,maxApprovalUsd:1000,hasOpenIntent:false,fundingBalance:5_000_000n,gas:baseGas,range:{valid:true},selection:{targetIndex:0,fundingIndex:1,targetZeroRequired:true,fundingPositiveRequired:true},canary:{state:'OPENED',tokenId:'99'}});
    expect(result.status).toBe('V4_BROADCAST_HOLD');
  });
  it('never references the legacy canary string set in the operational gate reasons',()=>{
    const legacyTokens=['V4_LIVE_CANARY_DISABLED','V4_CANARY_OPEN_UNAVAILABLE','V4_CANARY_AMOUNT_MUST_BE_EXACTLY_5_USDG','V4_CANARY_TOKEN_ID_MISMATCH','V4_CANARY_NOT_OPENED','V4_CANARY_POSITION_ALREADY_EXISTS','V4_CANARY_AMOUNT'];
    const variants:[string,V4OperationalGate[]][]=[
      ['pass',[executionGatePass()]],
      ['block position',[executionGateBlockOnPosition()]],
      ['block approval',[executionGateBlockOnApproval()]],
      ['block emergency',[executionGateBlockOnCanary()]],
    ];
    for(const [,gates] of variants){
      for(const g of gates){
        for(const r of g.reasons){
          for(const t of legacyTokens)expect(r).not.toBe(t);
        }
      }
    }
  });
});

describe('v4 operational gas calculation',()=>{
  const gas={intentId:'intent-1',stage:'ERC20_TO_PERMIT2',gasUnits:41_188n,gasPriceWei:116_700_000n,gasLimitMultiplier:1.2,nativeUsd:1861.91,nativeUsdSource:'fresh trusted WETH/USDG',estimatedGasUsd:.00895,perTxCapUsd:.25,projectedLifecycleGasUsd:.126,lifecycleCapUsd:1};
  it('classifies a missing native USD value as a price defect, not a gas-cap breach',()=>{
    expect(evaluateV4OperationalGasStage({...gas,nativeUsd:Number.NaN,estimatedGasUsd:Number.NaN}).verdict).toBe('BLOCKED_NATIVE_USD');
  });
  it('compares one transaction with the per-transaction cap and the projection with the lifecycle cap',()=>{
    expect(evaluateV4OperationalGasStage(gas).verdict).toBe('PASS');
    expect(evaluateV4OperationalGasStage({...gas,estimatedGasUsd:.251}).verdict).toBe('BLOCKED_PER_TX_CAP');
    expect(evaluateV4OperationalGasStage({...gas,projectedLifecycleGasUsd:1.001}).verdict).toBe('BLOCKED_LIFECYCLE_CAP');
  });
  it('applies the gas-limit buffer once and keeps pre-buffer and buffered USD distinct',()=>{
    const result=evaluateV4OperationalGasStage(gas);
    expect(result.bufferedGasUnits).toBe(49_425n);
    expect(result.bufferedGasUsd).toBeCloseTo(.01074);
    expect(result.estimatedGasUsd).toBe(.00895);
  });
});

function executionGatePass(){return evaluateV4OperationalGates({chainId:4663,executionEnabled:true,dryRun:false,emergencyPause:false,liveCanaryEnabled:false,v4LiveCanaryEnabled:false,signerConfigured:true,authorized:true,deploymentVerified:true,pool:{id:'0xfcfae8fa0bd6da961bcf5d990f27690932deac4f093e99bf3e871691c6586593',key:{currency0:'0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',currency1:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',fee:500,tickSpacing:10,hooks:'0x0000000000000000000000000000000000000000'},initialized:true,liquidity:1_000n},price:{fresh:true,usdPerFunding:1},positionUsd:5,approvalUsd:5,maxPositionUsd:1000,maxApprovalUsd:1000,hasOpenIntent:false,fundingBalance:5_000_000n,gas:{nativeBalance:1n,maxTxUsd:0.25,maxLifecycleUsd:1,perTxUsd:0.1,lifecycleUsd:0.3},range:{valid:true},selection:{targetIndex:0,fundingIndex:1,targetZeroRequired:true,fundingPositiveRequired:true},canary:{state:'OPENED',tokenId:'99'}});}
function executionGateBlockOnPosition(){return evaluateV4OperationalGates({...base,positionUsd:9_999});}
function executionGateBlockOnApproval(){return evaluateV4OperationalGates({...base,approvalUsd:9_999});}
function executionGateBlockOnCanary(){return evaluateV4OperationalGates({...base,emergencyPause:true});}
