import { parseUnits, type Address } from 'viem';
import {
  auditRobinhoodV3Deployments,
  discoverV3Pools,
  inspectErc20,
  robinhoodMainnet,
} from '@funi/core';
import { presentPool } from '@funi/v3';
import { SqliteLedgerRepository } from '@funi/ledger';
import { inspectV3Pool } from '@funi/core';
import { evaluateCanaryGates } from './live-canary-route.js';
import { sequentialApprovalMintSimulation } from './sequential-approval-sim.js';
import {
  dedicatedWallet,
  runtimeEnv,
  runtimePaths,
  runtimeRpc,
  walletPreflight,
} from './runtime.js';

export async function nativeUsdPrice() {
  const deployments = await auditRobinhoodV3Deployments(runtimeRpc);
  if (deployments.status === 'unavailable') return undefined;
  const pools = await discoverV3Pools(runtimeRpc, deployments, robinhoodMainnet.assets.WETH);
  if (pools.status === 'unavailable') return undefined;
  for (const pool of pools.value.filter(item => item.liquidity > 0n).sort((a, b) => a.fee - b.fee)) {
    if (pool.token0.toLowerCase() !== robinhoodMainnet.assets.USDG.toLowerCase() && pool.token1.toLowerCase() !== robinhoodMainnet.assets.USDG.toLowerCase()) continue;
    const shown = await presentPool(runtimeRpc, pool);
    if (shown.status === 'unavailable') continue;
    return shown.value.token0.address.toLowerCase() === robinhoodMainnet.assets.WETH.toLowerCase()
      ? shown.value.priceToken1PerToken0
      : 1 / shown.value.priceToken1PerToken0;
  }
  return undefined;
}

export async function liveCanaryRoutePreflight(input: { funding: string; amount: string; target: Address; pool?: Address }) {
  const poolArgIndex=process.argv.indexOf('--pool');
  const explicitlyBoundPool=input.pool??(poolArgIndex>=0&&process.argv[poolArgIndex+1]?process.argv[poolArgIndex+1] as Address:undefined);
  const wallet = dedicatedWallet();
  if (!wallet.address) throw new Error('dedicated wallet is not configured');
  const deployments = await auditRobinhoodV3Deployments(runtimeRpc);
  if (deployments.status === 'unavailable') throw new Error(deployments.reason);
  const target = await inspectErc20(runtimeRpc, input.target);
  if (target.status === 'unavailable') throw new Error(target.reason);
  const fundingAddress = input.funding.toUpperCase() === 'USDG'
    ? robinhoodMainnet.assets.USDG
    : input.funding.toUpperCase() === 'WETH'
      ? robinhoodMainnet.assets.WETH
      : undefined;
  if (!fundingAddress) throw new Error('--funding must be USDG or WETH');
  const funding = await inspectErc20(runtimeRpc, fundingAddress);
  if (funding.status === 'unavailable') throw new Error(funding.reason);
  const amount = parseUnits(input.amount, funding.value.decimals);
  const pools = await discoverV3Pools(runtimeRpc, deployments, target.value.address);
  if (pools.status === 'unavailable') throw new Error(pools.reason);
  const explicitlySelected = explicitlyBoundPool ? await inspectV3Pool(runtimeRpc, explicitlyBoundPool) : undefined;
  if (explicitlySelected?.status === 'unavailable') throw new Error(explicitlySelected.reason);
  const pool = explicitlyBoundPool
    ? explicitlySelected!.value
    : pools.value.filter(item => item.liquidity > 0n).find(item => item.token0.toLowerCase() === fundingAddress.toLowerCase() || item.token1.toLowerCase() === fundingAddress.toLowerCase());
  if (!pool) throw new Error(`no verified ${target.value.symbol}/${funding.value.symbol} v3 pool`);
  if (pool.address.toLowerCase() !== explicitlyBoundPool?.toLowerCase() && explicitlyBoundPool) throw new Error('POOL_SELECTION_MISMATCH');
  if (pool.factory.toLowerCase() !== deployments.value.factory.toLowerCase()) throw new Error('POOL_SELECTION_MISMATCH');
  if (![pool.token0.toLowerCase(),pool.token1.toLowerCase()].includes(target.value.address.toLowerCase())||![pool.token0.toLowerCase(),pool.token1.toLowerCase()].includes(funding.value.address.toLowerCase()))throw new Error('POOL_TOKEN_MISMATCH');
  const [gasPriceWei, nativeUsd] = await Promise.all([
    runtimeRpc.withClient(client => client.getGasPrice()),
    nativeUsdPrice(),
  ]);
  const repo = new SqliteLedgerRepository(runtimePaths.databasePath);
  try {
    const fundingReadiness = await walletPreflight(deployments, repo, runtimeRpc, {
      targetToken: target.value.address,
      fundingToken: funding.value.address,
      fundingSymbol: funding.value.symbol,
      fundingAmount: amount,
      pool: pool.address,
      protocolVersion: 'v3',
      gasPriceWei,
      nativeUsd,
    });
    const simulation = pool.liquidity>0n?await sequentialApprovalMintSimulation({
    wallet: wallet.address,
    pool: pool.address,
    target: { address: target.value.address, symbol: target.value.symbol, decimals: target.value.decimals },
    funding: { address: funding.value.address, symbol: funding.value.symbol, decimals: funding.value.decimals },
    fundingAmount: amount,
    upperDropPct: 0,
    lowerDropPct: 30,
    slippageBps: runtimeEnv.MAX_SLIPPAGE_BPS,
    deadlineSeconds: runtimeEnv.CONFIRMATION_TTL_SECONDS,
    upstreamUrl: runtimeEnv.RH_RPC_URL,
    artifactRoot: `${runtimePaths.dataDir}/fork-artifacts`,
    }):{status:'SEQUENTIAL_SIMULATION_FAILED' as const,reason:'selected verified pool currently has zero active liquidity',artifactPath:'not-created',mainnetWrites:0 as const};
    const readiness = simulation.status === 'SEQUENTIAL_SIMULATION_SUCCEEDED'
      ? await walletPreflight(deployments, repo, runtimeRpc, {
        targetToken: target.value.address,
        fundingToken: funding.value.address,
        fundingSymbol: funding.value.symbol,
        fundingAmount: amount,
        pool: pool.address,
        protocolVersion: 'v3',
        combinedGasEstimate: simulation.combinedGasUsed,
        gasPriceWei,
        nativeUsd,
      })
      : { ...fundingReadiness, gasStatus: 'GAS_ESTIMATE_UNAVAILABLE', simulationStatus: 'FINAL_SIMULATION_FAILED', reason: simulation.reason };
    const safety=repo.safetyState()??{},routeEvaluation=evaluateCanaryGates({executionEnabled:runtimeEnv.EXECUTION_ENABLED,dryRun:runtimeEnv.DRY_RUN,emergencyPause:runtimeEnv.EMERGENCY_PAUSE,liveCanaryEnabled:runtimeEnv.LIVE_CANARY_ENABLED,manualPause:safety.manualPause===true,runtimeConfigurationMatches:safety.executionEnabled===undefined||(safety.executionEnabled===runtimeEnv.EXECUTION_ENABLED&&safety.dryRun===runtimeEnv.DRY_RUN&&safety.emergencyPause===runtimeEnv.EMERGENCY_PAUSE&&safety.liveCanaryEnabled===runtimeEnv.LIVE_CANARY_ENABLED),allowlisted:Boolean(process.env.TELEGRAM_ALLOWED_USER_IDS?.trim()),signerConfigured:wallet.signerConfigured,chainId:runtimeEnv.RH_CHAIN_ID,deploymentVerified:true,positionUsd:input.funding.toUpperCase()==='USDG'?Number(input.amount):Number.POSITIVE_INFINITY,approvalUsd:input.funding.toUpperCase()==='USDG'?Number(input.amount):Number.POSITIVE_INFINITY,maxPositionUsd:runtimeEnv.MAX_POSITION_VALUE_USD,maxApprovalUsd:runtimeEnv.MAX_APPROVAL_VALUE_USD,pendingExecutions:repo.pendingTransactions()+repo.activeCanaryExecutionCount(wallet.address),budgetAvailable:repo.canaryBudgetAvailable(),openPositions:repo.listPositions().filter(x=>x.status==='open').length,maxOpenPositions:runtimeEnv.LIVE_CANARY_MAX_OPEN_POSITIONS,readiness,poolValidation:pool.liquidity>0n?{ok:true}:{ok:false,reason:'POOL_ZERO_ACTIVE_LIQUIDITY'}});
    return {
      status: 'NO_BROADCAST',
      previewStatus: routeEvaluation.executionReachable ? 'LIVE CANARY READY — awaiting final confirmation' : 'EXECUTION_BLOCKED',
      selectedIntent: { protocolVersion: 'v3', target: target.value, funding: funding.value, amount, pool: pool.address, fee: pool.fee, poolLiquidity:pool.liquidity },
      readiness,
      approvalRequired: readiness.approvalStatus === 'APPROVAL_REQUIRED',
      gas: { approvalGas: simulation.approvalGasUsed, mintGas: simulation.mintGasUsed, combinedGas: simulation.combinedGasUsed, gasPriceWei, nativeUsd, estimatedGasUsd: readiness.estimatedGasUsd, maxGasUsd: runtimeEnv.MAX_GAS_COST_USD },
      route: { ...routeEvaluation, telegramCallback: 'open-canary', executorSelected: 'executeGuardedSingleSidedCanary', requiresOneUseArm: false, requiresCanaryBudget: true },
      simulation: { status: simulation.status, artifactPath: simulation.artifactPath, mainnetWrites: simulation.mainnetWrites },
      mainnetTransactionsSent: 0,
    };
  } finally {
    repo.close();
  }
}
