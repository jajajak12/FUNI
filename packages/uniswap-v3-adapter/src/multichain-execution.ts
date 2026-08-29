import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  FallbackRpc,
  inspectV3Pool,
  protocolDeployment,
  type Availability,
  type PoolState,
  type ProtocolDeployment,
} from '@funi/core';

export type GuardedV3Protocol = 'pancakeswap_v3' | 'uniswap_v3';
export type GuardedV3Chain = 56 | 1;
export type V3LifecycleAction = 'approval' | 'mint' | 'increase' | 'collect' | 'partial_close' | 'full_close' | 'burn';

const uint128Max = (1n << 128n) - 1n;
const factoryAbi = [
  {type:'function',name:'getPool',stateMutability:'view',inputs:[{type:'address'},{type:'address'},{type:'uint24'}],outputs:[{type:'address'}]},
  {type:'function',name:'feeAmountTickSpacing',stateMutability:'view',inputs:[{type:'uint24'}],outputs:[{type:'int24'}]},
] as const;
const roleAbi = [
  {type:'function',name:'factory',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'WETH9',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
  {type:'function',name:'deployer',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
] as const;
const enumerableAbi = [
  {type:'function',name:'balanceOf',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]},
  {type:'function',name:'tokenOfOwnerByIndex',stateMutability:'view',inputs:[{type:'address'},{type:'uint256'}],outputs:[{type:'uint256'}]},
] as const;
const approvalAbi = [{type:'function',name:'approve',stateMutability:'nonpayable',inputs:[{type:'address',name:'spender'},{type:'uint256',name:'amount'}],outputs:[{type:'bool'}]}] as const;
const managerAbi = [
  {type:'function',name:'mint',stateMutability:'payable',inputs:[{type:'tuple',name:'params',components:[{type:'address',name:'token0'},{type:'address',name:'token1'},{type:'uint24',name:'fee'},{type:'int24',name:'tickLower'},{type:'int24',name:'tickUpper'},{type:'uint256',name:'amount0Desired'},{type:'uint256',name:'amount1Desired'},{type:'uint256',name:'amount0Min'},{type:'uint256',name:'amount1Min'},{type:'address',name:'recipient'},{type:'uint256',name:'deadline'}]}],outputs:[{type:'uint256'},{type:'uint128'},{type:'uint256'},{type:'uint256'}]},
  {type:'function',name:'increaseLiquidity',stateMutability:'payable',inputs:[{type:'tuple',name:'params',components:[{type:'uint256',name:'tokenId'},{type:'uint256',name:'amount0Desired'},{type:'uint256',name:'amount1Desired'},{type:'uint256',name:'amount0Min'},{type:'uint256',name:'amount1Min'},{type:'uint256',name:'deadline'}]}],outputs:[{type:'uint128'},{type:'uint256'},{type:'uint256'}]},
  {type:'function',name:'decreaseLiquidity',stateMutability:'payable',inputs:[{type:'tuple',name:'params',components:[{type:'uint256',name:'tokenId'},{type:'uint128',name:'liquidity'},{type:'uint256',name:'amount0Min'},{type:'uint256',name:'amount1Min'},{type:'uint256',name:'deadline'}]}],outputs:[{type:'uint256'},{type:'uint256'}]},
  {type:'function',name:'collect',stateMutability:'payable',inputs:[{type:'tuple',name:'params',components:[{type:'uint256',name:'tokenId'},{type:'address',name:'recipient'},{type:'uint128',name:'amount0Max'},{type:'uint128',name:'amount1Max'}]}],outputs:[{type:'uint256'},{type:'uint256'}]},
  {type:'function',name:'burn',stateMutability:'payable',inputs:[{type:'uint256',name:'tokenId'}],outputs:[]},
  {type:'function',name:'multicall',stateMutability:'payable',inputs:[{type:'bytes[]',name:'data'}],outputs:[{type:'bytes[]',name:'results'}]},
  {type:'function',name:'refundETH',stateMutability:'payable',inputs:[],outputs:[]},
  {type:'function',name:'unwrapWETH9',stateMutability:'payable',inputs:[{type:'uint256',name:'amountMinimum'},{type:'address',name:'recipient'}],outputs:[]},
  {type:'function',name:'sweepToken',stateMutability:'payable',inputs:[{type:'address',name:'token'},{type:'uint256',name:'amountMinimum'},{type:'address',name:'recipient'}],outputs:[]},
] as const;

export type V3TokenExecutionEvidence = {
  chainId: GuardedV3Chain;
  token: Address;
  runtimeCodePresent: boolean;
  decimals: number;
  totalSupply: bigint;
  transferSemantics: 'STANDARD_ERC20' | 'FEE_ON_TRANSFER' | 'UNKNOWN';
  approveReturn: 'BOOL' | 'EMPTY' | 'UNKNOWN';
};

export type V3PoolExecutionEvidence = {
  chainId: GuardedV3Chain;
  protocol: GuardedV3Protocol;
  pool: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  initialized: boolean;
  factoryVerified: boolean;
  observedBlock: bigint;
};

export type V3BuiltTransaction = {
  chainId: GuardedV3Chain;
  protocol: GuardedV3Protocol;
  action: V3LifecycleAction;
  to: Address;
  data: Hex;
  value: bigint;
  positionId?: bigint;
  approvalSpender?: Address;
  approvedTokenEvidence?: V3TokenExecutionEvidence;
  deadline?: bigint;
  deploymentVersion: number;
};

export function guardedV3Deployment(chainId: GuardedV3Chain, protocol: GuardedV3Protocol): ProtocolDeployment {
  if ((chainId === 56 && protocol !== 'pancakeswap_v3') || (chainId === 1 && protocol !== 'uniswap_v3')) {
    throw new Error(`V3_GUARDED_CHAIN_PROTOCOL_MISMATCH:${chainId}:${protocol}`);
  }
  const deployment = protocolDeployment(chainId, protocol);
  if (!deployment.contracts.factory || !deployment.contracts.positionManager || !deployment.contracts.wrappedNative) {
    throw new Error('V3_GUARDED_DEPLOYMENT_INCOMPLETE');
  }
  return deployment;
}

export function validateV3TokenExecutionEvidence(evidence: V3TokenExecutionEvidence): void {
  if (!evidence.runtimeCodePresent) throw new Error('V3_TOKEN_RUNTIME_CODE_MISSING');
  if (!Number.isInteger(evidence.decimals) || evidence.decimals < 0 || evidence.decimals > 255 || evidence.totalSupply <= 0n) throw new Error('V3_TOKEN_METADATA_INVALID');
  if (evidence.transferSemantics === 'FEE_ON_TRANSFER') throw new Error('V3_FEE_ON_TRANSFER_TOKEN_UNSUPPORTED');
  if (evidence.transferSemantics !== 'STANDARD_ERC20' || evidence.approveReturn !== 'BOOL') throw new Error('V3_NONSTANDARD_TOKEN_UNSUPPORTED');
}

export function validateV3PoolExecutionEvidence(evidence: V3PoolExecutionEvidence): ProtocolDeployment {
  const deployment = guardedV3Deployment(evidence.chainId, evidence.protocol);
  if (!evidence.initialized) throw new Error('V3_POOL_NOT_INITIALIZED');
  if (!evidence.factoryVerified) throw new Error('V3_POOL_FACTORY_NOT_VERIFIED');
  if (evidence.tickSpacing <= 0 || evidence.fee <= 0) throw new Error('V3_POOL_FEE_OR_TICK_SPACING_INVALID');
  if (BigInt(evidence.token0) >= BigInt(evidence.token1)) throw new Error('V3_POOL_TOKEN_ORDER_INVALID');
  return deployment;
}

export async function verifyV3ProtocolRoles(input: {client: PublicClient; chainId: GuardedV3Chain; protocol: GuardedV3Protocol}) {
  const deployment = guardedV3Deployment(input.chainId, input.protocol);
  const manager = deployment.contracts.positionManager!;
  const [factory, wrappedNative] = await Promise.all([
    input.client.readContract({address:manager,abi:roleAbi,functionName:'factory'}),
    input.client.readContract({address:manager,abi:roleAbi,functionName:'WETH9'}),
  ]);
  if (factory.toLowerCase() !== deployment.contracts.factory!.toLowerCase()) throw new Error('V3_POSITION_MANAGER_FACTORY_MISMATCH');
  if (wrappedNative.toLowerCase() !== deployment.contracts.wrappedNative!.toLowerCase()) throw new Error('V3_POSITION_MANAGER_WRAPPED_NATIVE_MISMATCH');
  let deployer: Address | undefined;
  if (input.protocol === 'pancakeswap_v3') {
    deployer = await input.client.readContract({address:manager,abi:roleAbi,functionName:'deployer'});
    if (!deployment.contracts.poolDeployer || deployer.toLowerCase() !== deployment.contracts.poolDeployer.toLowerCase()) throw new Error('PANCAKESWAP_V3_POOL_DEPLOYER_MISMATCH');
  }
  return {factory, wrappedNative, deployer};
}

export async function inspectGuardedV3Pool(input:{client:PublicClient;rpc:FallbackRpc;chainId:GuardedV3Chain;protocol:GuardedV3Protocol;tokenA:Address;tokenB:Address;fee:number}):Promise<Availability<{pool:PoolState;evidence:V3PoolExecutionEvidence}>> {
  try {
    if (input.rpc.config.chainId !== input.chainId) throw new Error('V3_RPC_CHAIN_MISMATCH');
    const deployment = guardedV3Deployment(input.chainId,input.protocol);
    const spacing = Number(await input.client.readContract({address:deployment.contracts.factory!,abi:factoryAbi,functionName:'feeAmountTickSpacing',args:[input.fee]}));
    if (spacing <= 0) return {status:'unavailable',reason:'V3_FEE_TIER_DISABLED'};
    const address = await input.client.readContract({address:deployment.contracts.factory!,abi:factoryAbi,functionName:'getPool',args:[input.tokenA,input.tokenB,input.fee]});
    if (address === zeroAddress) return {status:'unavailable',reason:'V3_POOL_NOT_FOUND'};
    const inspected = await inspectV3Pool(input.rpc,address);
    if (inspected.status === 'unavailable') return inspected;
    const pool=inspected.value,evidence:V3PoolExecutionEvidence={chainId:input.chainId,protocol:input.protocol,pool:address,token0:pool.token0,token1:pool.token1,fee:pool.fee,tickSpacing:pool.tickSpacing,initialized:pool.initialized,factoryVerified:pool.factory.toLowerCase()===deployment.contracts.factory!.toLowerCase()&&pool.tickSpacing===spacing,observedBlock:pool.blockNumber};
    validateV3PoolExecutionEvidence(evidence);
    return {status:'available',value:{pool,evidence},provenance:inspected.provenance};
  } catch (error) { return {status:'unavailable',reason:`V3_POOL_VALIDATION_FAILED:${error instanceof Error?error.message:'UNKNOWN'}`}; }
}

function assertDeadline(deadline:bigint,nowUnix:bigint){if(deadline<=nowUnix)throw new Error('V3_DEADLINE_EXPIRED');}
function assertAmounts(desired0:bigint,desired1:bigint,min0:bigint,min1:bigint){if(desired0<0n||desired1<0n||desired0+desired1<=0n||min0<0n||min1<0n||min0>desired0||min1>desired1)throw new Error('V3_AMOUNT_OR_SLIPPAGE_BOUNDS_INVALID');}
function multicall(calls:readonly Hex[]):Hex{return encodeFunctionData({abi:managerAbi,functionName:'multicall',args:[[...calls]]});}

export function buildGuardedV3Approval(input:{chainId:GuardedV3Chain;protocol:GuardedV3Protocol;tokenEvidence:V3TokenExecutionEvidence;amount:bigint}):V3BuiltTransaction{
  if(input.amount<=0n)throw new Error('V3_APPROVAL_AMOUNT_INVALID');if(input.tokenEvidence.chainId!==input.chainId)throw new Error('V3_APPROVAL_TOKEN_CHAIN_MISMATCH');validateV3TokenExecutionEvidence(input.tokenEvidence);const deployment=guardedV3Deployment(input.chainId,input.protocol),spender=deployment.contracts.positionManager!;
  if(input.tokenEvidence.token.toLowerCase()===zeroAddress)throw new Error('V3_APPROVAL_TOKEN_INVALID');
  return {chainId:input.chainId,protocol:input.protocol,action:'approval',to:getAddress(input.tokenEvidence.token),data:encodeFunctionData({abi:approvalAbi,functionName:'approve',args:[spender,input.amount]}),value:0n,approvalSpender:spender,approvedTokenEvidence:input.tokenEvidence,deploymentVersion:deployment.registryVersion};
}

export function buildGuardedV3Mint(input:{chainId:GuardedV3Chain;protocol:GuardedV3Protocol;pool:V3PoolExecutionEvidence;recipient:Address;tickLower:number;tickUpper:number;amount0Desired:bigint;amount1Desired:bigint;amount0Min:bigint;amount1Min:bigint;deadline:bigint;nowUnix:bigint;fundNative?:boolean}):V3BuiltTransaction{
  const deployment=validateV3PoolExecutionEvidence(input.pool);assertDeadline(input.deadline,input.nowUnix);assertAmounts(input.amount0Desired,input.amount1Desired,input.amount0Min,input.amount1Min);
  if(input.tickLower>=input.tickUpper||input.tickLower%input.pool.tickSpacing||input.tickUpper%input.pool.tickSpacing)throw new Error('V3_TICK_RANGE_INVALID');
  const mint=encodeFunctionData({abi:managerAbi,functionName:'mint',args:[{token0:input.pool.token0,token1:input.pool.token1,fee:input.pool.fee,tickLower:input.tickLower,tickUpper:input.tickUpper,amount0Desired:input.amount0Desired,amount1Desired:input.amount1Desired,amount0Min:input.amount0Min,amount1Min:input.amount1Min,recipient:input.recipient,deadline:input.deadline}]});
  let data=mint,value=0n;if(input.fundNative){const wrapped=deployment.contracts.wrappedNative!,index=input.pool.token0.toLowerCase()===wrapped.toLowerCase()?0:input.pool.token1.toLowerCase()===wrapped.toLowerCase()?1:-1;if(index<0)throw new Error('V3_NATIVE_FUNDING_REQUIRES_WRAPPED_NATIVE_POOL');value=index===0?input.amount0Desired:input.amount1Desired;if(value<=0n)throw new Error('V3_NATIVE_FUNDING_AMOUNT_INVALID');data=multicall([mint,encodeFunctionData({abi:managerAbi,functionName:'refundETH'})]);}
  return {chainId:input.chainId,protocol:input.protocol,action:'mint',to:deployment.contracts.positionManager!,data,value,deadline:input.deadline,deploymentVersion:deployment.registryVersion};
}

export function buildGuardedV3Increase(input:{chainId:GuardedV3Chain;protocol:GuardedV3Protocol;tokenId:bigint;amount0Desired:bigint;amount1Desired:bigint;amount0Min:bigint;amount1Min:bigint;deadline:bigint;nowUnix:bigint}):V3BuiltTransaction{
  const deployment=guardedV3Deployment(input.chainId,input.protocol);assertDeadline(input.deadline,input.nowUnix);assertAmounts(input.amount0Desired,input.amount1Desired,input.amount0Min,input.amount1Min);if(input.tokenId<=0n)throw new Error('V3_POSITION_ID_INVALID');
  return {chainId:input.chainId,protocol:input.protocol,action:'increase',to:deployment.contracts.positionManager!,data:encodeFunctionData({abi:managerAbi,functionName:'increaseLiquidity',args:[{tokenId:input.tokenId,amount0Desired:input.amount0Desired,amount1Desired:input.amount1Desired,amount0Min:input.amount0Min,amount1Min:input.amount1Min,deadline:input.deadline}]}),value:0n,positionId:input.tokenId,deadline:input.deadline,deploymentVersion:deployment.registryVersion};
}

export function buildGuardedV3Collect(input:{chainId:GuardedV3Chain;protocol:GuardedV3Protocol;tokenId:bigint;recipient:Address;unwrapNative?:{wrappedToken:Address;otherToken:Address;amountNativeMin:bigint;amountOtherMin:bigint}}):V3BuiltTransaction{
  const deployment=guardedV3Deployment(input.chainId,input.protocol);if(input.tokenId<=0n)throw new Error('V3_POSITION_ID_INVALID');let data:Hex;
  if(input.unwrapNative){if(input.unwrapNative.wrappedToken.toLowerCase()!==deployment.contracts.wrappedNative!.toLowerCase())throw new Error('V3_UNWRAP_TOKEN_MISMATCH');data=multicall([encodeFunctionData({abi:managerAbi,functionName:'collect',args:[{tokenId:input.tokenId,recipient:zeroAddress,amount0Max:uint128Max,amount1Max:uint128Max}]}),encodeFunctionData({abi:managerAbi,functionName:'unwrapWETH9',args:[input.unwrapNative.amountNativeMin,input.recipient]}),encodeFunctionData({abi:managerAbi,functionName:'sweepToken',args:[input.unwrapNative.otherToken,input.unwrapNative.amountOtherMin,input.recipient]})]);}
  else data=encodeFunctionData({abi:managerAbi,functionName:'collect',args:[{tokenId:input.tokenId,recipient:input.recipient,amount0Max:uint128Max,amount1Max:uint128Max}]});
  return {chainId:input.chainId,protocol:input.protocol,action:'collect',to:deployment.contracts.positionManager!,data,value:0n,positionId:input.tokenId,deploymentVersion:deployment.registryVersion};
}

export function buildGuardedV3Decrease(input:{chainId:GuardedV3Chain;protocol:GuardedV3Protocol;tokenId:bigint;liquidity:bigint;fullLiquidity:bigint;amount0Min:bigint;amount1Min:bigint;deadline:bigint;nowUnix:bigint}):V3BuiltTransaction{
  const deployment=guardedV3Deployment(input.chainId,input.protocol);assertDeadline(input.deadline,input.nowUnix);if(input.tokenId<=0n||input.liquidity<=0n||input.fullLiquidity<=0n||input.liquidity>input.fullLiquidity||input.amount0Min<0n||input.amount1Min<0n)throw new Error('V3_CLOSE_INPUT_INVALID');const full=input.liquidity===input.fullLiquidity;return {chainId:input.chainId,protocol:input.protocol,action:full?'full_close':'partial_close',to:deployment.contracts.positionManager!,data:encodeFunctionData({abi:managerAbi,functionName:'decreaseLiquidity',args:[{tokenId:input.tokenId,liquidity:input.liquidity,amount0Min:input.amount0Min,amount1Min:input.amount1Min,deadline:input.deadline}]}),value:0n,positionId:input.tokenId,deadline:input.deadline,deploymentVersion:deployment.registryVersion};
}

export function buildGuardedV3Close(input:{chainId:GuardedV3Chain;protocol:GuardedV3Protocol;tokenId:bigint;liquidity:bigint;fullLiquidity:bigint;amount0Min:bigint;amount1Min:bigint;recipient:Address;deadline:bigint;nowUnix:bigint;burnAfter?:boolean}):V3BuiltTransaction{
  const deployment=guardedV3Deployment(input.chainId,input.protocol);assertDeadline(input.deadline,input.nowUnix);if(input.tokenId<=0n||input.liquidity<=0n||input.fullLiquidity<=0n||input.liquidity>input.fullLiquidity||input.amount0Min<0n||input.amount1Min<0n)throw new Error('V3_CLOSE_INPUT_INVALID');const full=input.liquidity===input.fullLiquidity;if(input.burnAfter&&!full)throw new Error('V3_BURN_REQUIRES_FULL_CLOSE');
  const calls:Hex[]=[encodeFunctionData({abi:managerAbi,functionName:'decreaseLiquidity',args:[{tokenId:input.tokenId,liquidity:input.liquidity,amount0Min:input.amount0Min,amount1Min:input.amount1Min,deadline:input.deadline}]}),encodeFunctionData({abi:managerAbi,functionName:'collect',args:[{tokenId:input.tokenId,recipient:input.recipient,amount0Max:uint128Max,amount1Max:uint128Max}]})];if(input.burnAfter)calls.push(encodeFunctionData({abi:managerAbi,functionName:'burn',args:[input.tokenId]}));
  return {chainId:input.chainId,protocol:input.protocol,action:full?'full_close':'partial_close',to:deployment.contracts.positionManager!,data:multicall(calls),value:0n,positionId:input.tokenId,deadline:input.deadline,deploymentVersion:deployment.registryVersion};
}

export function buildGuardedV3Burn(input:{chainId:GuardedV3Chain;protocol:GuardedV3Protocol;tokenId:bigint}):V3BuiltTransaction{const deployment=guardedV3Deployment(input.chainId,input.protocol);if(input.tokenId<=0n)throw new Error('V3_POSITION_ID_INVALID');return {chainId:input.chainId,protocol:input.protocol,action:'burn',to:deployment.contracts.positionManager!,data:encodeFunctionData({abi:managerAbi,functionName:'burn',args:[input.tokenId]}),value:0n,positionId:input.tokenId,deploymentVersion:deployment.registryVersion};}

export function assertGuardedV3TransactionSemantics(tx:V3BuiltTransaction):void{
  const deployment=guardedV3Deployment(tx.chainId,tx.protocol);if(tx.action==='approval'){if(!tx.approvalSpender||!tx.approvedTokenEvidence)throw new Error('V3_APPROVAL_EVIDENCE_OR_SPENDER_MISSING');if(tx.approvedTokenEvidence.chainId!==tx.chainId||tx.approvedTokenEvidence.token.toLowerCase()!==tx.to.toLowerCase())throw new Error('V3_APPROVAL_TOKEN_CHAIN_MISMATCH');validateV3TokenExecutionEvidence(tx.approvedTokenEvidence);const decoded=decodeFunctionData({abi:approvalAbi,data:tx.data});if(decoded.functionName!=='approve'||String(decoded.args[0]).toLowerCase()!==deployment.contracts.positionManager!.toLowerCase()||tx.approvalSpender.toLowerCase()!==deployment.contracts.positionManager!.toLowerCase())throw new Error('V3_APPROVAL_WRONG_DEPLOYMENT_SPENDER');if(tx.value!==0n)throw new Error('V3_APPROVAL_VALUE_NOT_ZERO');return;}
  if(tx.to.toLowerCase()!==deployment.contracts.positionManager!.toLowerCase())throw new Error('V3_TRANSACTION_WRONG_DEPLOYMENT_DESTINATION');const decoded=decodeFunctionData({abi:managerAbi,data:tx.data}),allowed:Record<Exclude<V3LifecycleAction,'approval'>,readonly string[]>={mint:['mint','multicall'],increase:['increaseLiquidity','multicall'],collect:['collect','multicall'],partial_close:['decreaseLiquidity','multicall'],full_close:['decreaseLiquidity','multicall'],burn:['burn']};if(!allowed[tx.action].includes(decoded.functionName))throw new Error('V3_TRANSACTION_SELECTOR_STAGE_MISMATCH');if(tx.value>0n&&decoded.functionName!=='multicall')throw new Error('V3_NATIVE_VALUE_REQUIRES_REFUND_MULTICALL');
}

export async function discoverOwnedV3TokenIds(input:{client:PublicClient;chainId:GuardedV3Chain;protocol:GuardedV3Protocol;owner:Address;maximumPositions:number}):Promise<bigint[]>{const deployment=guardedV3Deployment(input.chainId,input.protocol);if(!Number.isSafeInteger(input.maximumPositions)||input.maximumPositions<=0)throw new Error('V3_DISCOVERY_BOUND_INVALID');const count=await input.client.readContract({address:deployment.contracts.positionManager!,abi:enumerableAbi,functionName:'balanceOf',args:[input.owner]});if(count>BigInt(input.maximumPositions))throw new Error('V3_DISCOVERY_POSITION_LIMIT_EXCEEDED');const ids:bigint[]=[];for(let index=0n;index<count;index++)ids.push(await input.client.readContract({address:deployment.contracts.positionManager!,abi:enumerableAbi,functionName:'tokenOfOwnerByIndex',args:[input.owner,index]}));return ids;}
