import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import { protocolDeployment } from '@funi/core';
import {
  assertGuardedV3TransactionSemantics,
  buildGuardedV3Approval,
  buildGuardedV3Burn,
  buildGuardedV3Close,
  buildGuardedV3Collect,
  buildGuardedV3Decrease,
  buildGuardedV3Mint,
  discoverOwnedV3TokenIds,
  guardedV3Deployment,
  validateV3TokenExecutionEvidence,
  verifyV3ProtocolRoles,
  type V3PoolExecutionEvidence,
} from '@funi/v3';

const token0='0x0000000000000000000000000000000000000001' as const;
const token1='0x0000000000000000000000000000000000000002' as const;
const wallet='0x0000000000000000000000000000000000000003' as const;
const bscPool:V3PoolExecutionEvidence={chainId:56,protocol:'pancakeswap_v3',pool:'0x0000000000000000000000000000000000000004',token0,token1,fee:500,tickSpacing:10,initialized:true,factoryVerified:true,observedBlock:1n};
const tokenEvidence={chainId:56 as const,token:token0,runtimeCodePresent:true,decimals:18,totalSupply:100n,transferSemantics:'STANDARD_ERC20' as const,approveReturn:'BOOL' as const};

describe('explicit guarded v3 protocol adapters',()=>{
  it('builds PancakeSwap v3 direct approvals only to its own position manager',()=>{const tx=buildGuardedV3Approval({chainId:56,protocol:'pancakeswap_v3',tokenEvidence,amount:10n});expect(tx.approvalSpender).toBe(protocolDeployment(56,'pancakeswap_v3').contracts.positionManager);expect(()=>assertGuardedV3TransactionSemantics({...tx,approvalSpender:protocolDeployment(1,'uniswap_v3').contracts.positionManager})).toThrow('V3_APPROVAL_WRONG_DEPLOYMENT_SPENDER');expect(()=>buildGuardedV3Approval({chainId:1,protocol:'uniswap_v3',tokenEvidence,amount:10n})).toThrow('V3_APPROVAL_TOKEN_CHAIN_MISMATCH');expect(()=>guardedV3Deployment(56,'uniswap_v3')).toThrow('V3_GUARDED_CHAIN_PROTOCOL_MISMATCH');});
  it('encodes Pancake native-BNB mint as manager multicall with refund and validates the pool',()=>{const wrapped=protocolDeployment(56,'pancakeswap_v3').contracts.wrappedNative!,pool={...bscPool,token1:wrapped};const tx=buildGuardedV3Mint({chainId:56,protocol:'pancakeswap_v3',pool,recipient:wallet,tickLower:-20,tickUpper:20,amount0Desired:10n,amount1Desired:20n,amount0Min:9n,amount1Min:19n,deadline:200n,nowUnix:100n,fundNative:true});expect(tx.value).toBe(20n);expect(tx.to).toBe(protocolDeployment(56,'pancakeswap_v3').contracts.positionManager);expect(decodeFunctionData({abi:[{type:'function',name:'multicall',stateMutability:'payable',inputs:[{type:'bytes[]'}],outputs:[{type:'bytes[]'}]}] as const,data:tx.data}).functionName).toBe('multicall');expect(()=>assertGuardedV3TransactionSemantics(tx)).not.toThrow();});
  it('encodes collect, separate decrease, bundled close, and burn with chain-bound manager semantics',()=>{const collect=buildGuardedV3Collect({chainId:56,protocol:'pancakeswap_v3',tokenId:7n,recipient:wallet}),decrease=buildGuardedV3Decrease({chainId:56,protocol:'pancakeswap_v3',tokenId:7n,liquidity:10n,fullLiquidity:10n,amount0Min:1n,amount1Min:1n,deadline:200n,nowUnix:100n}),partial=buildGuardedV3Close({chainId:56,protocol:'pancakeswap_v3',tokenId:7n,liquidity:5n,fullLiquidity:10n,amount0Min:1n,amount1Min:1n,recipient:wallet,deadline:200n,nowUnix:100n}),full=buildGuardedV3Close({chainId:56,protocol:'pancakeswap_v3',tokenId:7n,liquidity:10n,fullLiquidity:10n,amount0Min:1n,amount1Min:1n,recipient:wallet,deadline:200n,nowUnix:100n,burnAfter:true}),burn=buildGuardedV3Burn({chainId:1,protocol:'uniswap_v3',tokenId:7n});for(const tx of [collect,decrease,partial,full,burn])expect(()=>assertGuardedV3TransactionSemantics(tx)).not.toThrow();expect(decrease.action).toBe('full_close');expect(partial.action).toBe('partial_close');expect(full.action).toBe('full_close');});
  it('fails closed for fee-on-transfer, unknown transfer, and non-standard approval tokens',()=>{const base=tokenEvidence;expect(()=>validateV3TokenExecutionEvidence(base)).not.toThrow();expect(()=>validateV3TokenExecutionEvidence({...base,transferSemantics:'FEE_ON_TRANSFER'})).toThrow('V3_FEE_ON_TRANSFER_TOKEN_UNSUPPORTED');expect(()=>validateV3TokenExecutionEvidence({...base,approveReturn:'EMPTY'})).toThrow('V3_NONSTANDARD_TOKEN_UNSUPPORTED');});
  it('verifies Pancake-specific deployer as well as factory and WBNB roles',async()=>{const deployment=protocolDeployment(56,'pancakeswap_v3'),client={readContract:async({functionName}:any)=>functionName==='factory'?deployment.contracts.factory:functionName==='WETH9'?deployment.contracts.wrappedNative:deployment.contracts.poolDeployer} as any;await expect(verifyV3ProtocolRoles({client,chainId:56,protocol:'pancakeswap_v3'})).resolves.toMatchObject({deployer:deployment.contracts.poolDeployer});await expect(verifyV3ProtocolRoles({client:{readContract:async({functionName}:any)=>functionName==='factory'?deployment.contracts.factory:functionName==='WETH9'?deployment.contracts.wrappedNative:token0} as any,chainId:56,protocol:'pancakeswap_v3'})).rejects.toThrow('PANCAKESWAP_V3_POOL_DEPLOYER_MISMATCH');});
  it('bounds enumerable ownership discovery',async()=>{const manager=protocolDeployment(1,'uniswap_v3').contracts.positionManager,client={readContract:async({address,functionName,args}:any)=>{expect(address).toBe(manager);if(functionName==='balanceOf')return 2n;return BigInt(args[1])+10n;}} as any;await expect(discoverOwnedV3TokenIds({client,chainId:1,protocol:'uniswap_v3',owner:wallet,maximumPositions:2})).resolves.toEqual([10n,11n]);await expect(discoverOwnedV3TokenIds({client,chainId:1,protocol:'uniswap_v3',owner:wallet,maximumPositions:1})).rejects.toThrow('V3_DISCOVERY_POSITION_LIMIT_EXCEEDED');});
});

describe('Ethereum Uniswap v3 guarded adapter',()=>{
  const deployment=protocolDeployment(1,'uniswap_v3'),evidence={chainId:1 as const,token:token0,runtimeCodePresent:true,decimals:18,totalSupply:100n,transferSemantics:'STANDARD_ERC20' as const,approveReturn:'BOOL' as const},pool:V3PoolExecutionEvidence={chainId:1,protocol:'uniswap_v3',pool:'0x0000000000000000000000000000000000000004',token0,token1,fee:500,tickSpacing:10,initialized:true,factoryVerified:true,observedBlock:1n};
  it('targets only the official Ethereum position manager for direct approval',()=>{const tx=buildGuardedV3Approval({chainId:1,protocol:'uniswap_v3',tokenEvidence:evidence,amount:10n});expect(tx.approvalSpender).toBe(deployment.contracts.positionManager);expect(()=>assertGuardedV3TransactionSemantics(tx)).not.toThrow();});
  it('encodes Ethereum mint and separate full decrease with EVM-chain identity 1',()=>{const mint=buildGuardedV3Mint({chainId:1,protocol:'uniswap_v3',pool,recipient:wallet,tickLower:-20,tickUpper:20,amount0Desired:10n,amount1Desired:20n,amount0Min:9n,amount1Min:19n,deadline:200n,nowUnix:100n}),decrease=buildGuardedV3Decrease({chainId:1,protocol:'uniswap_v3',tokenId:7n,liquidity:10n,fullLiquidity:10n,amount0Min:1n,amount1Min:1n,deadline:200n,nowUnix:100n});expect(mint).toMatchObject({chainId:1,protocol:'uniswap_v3',to:deployment.contracts.positionManager});expect(decrease).toMatchObject({chainId:1,action:'full_close'});expect(()=>assertGuardedV3TransactionSemantics(mint)).not.toThrow();expect(()=>assertGuardedV3TransactionSemantics(decrease)).not.toThrow();});
  it('verifies Ethereum manager factory and WETH without assuming Pancake deployer()',async()=>{const client={readContract:async({functionName}:any)=>functionName==='factory'?deployment.contracts.factory:functionName==='WETH9'?deployment.contracts.wrappedNative:Promise.reject(new Error('deployer must not be called'))} as any;await expect(verifyV3ProtocolRoles({client,chainId:1,protocol:'uniswap_v3'})).resolves.toMatchObject({factory:deployment.contracts.factory,wrappedNative:deployment.contracts.wrappedNative,deployer:undefined});});
});
