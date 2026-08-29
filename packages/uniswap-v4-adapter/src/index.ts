import { decodeAbiParameters, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, parseAbiItem, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { RH_MAINNET, evaluateDeploymentVerification, inspectErc20, isRetryableRpcFailure, priceFromSqrtX96, robinhoodMainnet, sanitizeRpcError, type Availability, type DeploymentVerificationResult, type ExplorerStatus, type FallbackRpc } from '@funi/core';

/** Official Uniswap v4 registry for Robinhood Chain only. Kept separate from v3. */
export const V4_ROBINHOOD_DEPLOYMENTS=Object.freeze({
 chainId:4663,
 source:'https://developers.uniswap.org/docs/protocols/v4/deployments',
 abiSource:'https://robinhoodchain.blockscout.com/api?module=contract&action=getsourcecode&address=0x58daec3116aae6d93017baaea7749052e8a04fa7',
 positionManagerSourceVersion:'v4-periphery PositionManager.sol; solc 0.8.26+commit.8a97fa7a; EVM Cancun',
 poolManager:getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951'),
 positionManager:getAddress('0x58daec3116aae6d93017baaea7749052e8a04fa7'),
 permit2:getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3'),
 universalRouter:getAddress('0x8876789976decbfcbbbe364623c63652db8c0904'),
 quoter:getAddress('0x8dc178efb8111bb0973dd9d722ebeff267c98f94'),
 stateView:getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'),
 reservesLens:getAddress('0x0000001b173C3bbF3984D417d8614E3eed34865B'),
});
/** Immutable runtime fingerprints captured by the verified Phase 1 deployment audit. */
export const V4_ROBINHOOD_RUNTIME_FINGERPRINTS=Object.freeze({
 poolManager:{address:V4_ROBINHOOD_DEPLOYMENTS.poolManager,hash:'0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626',size:24009},
 positionManager:{address:V4_ROBINHOOD_DEPLOYMENTS.positionManager,hash:'0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2',size:23877},
 permit2:{address:V4_ROBINHOOD_DEPLOYMENTS.permit2,hash:'0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca',size:9152},
 universalRouter:{address:V4_ROBINHOOD_DEPLOYMENTS.universalRouter,hash:'0x2ce6aaaf9f4151f5e1cbf774668772f17f532ae11b15e9284fd0a072a8b0fbde',size:24546},
 quoter:{address:V4_ROBINHOOD_DEPLOYMENTS.quoter,hash:'0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6',size:6118},
 stateView:{address:V4_ROBINHOOD_DEPLOYMENTS.stateView,hash:'0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6',size:3531},
 reservesLens:{address:V4_ROBINHOOD_DEPLOYMENTS.reservesLens,hash:'0x157a3174cbad65b8ff57b8fbf94253b58be07398593d7d677e4fd6051e16ca91',size:14142},
} as const);
export type V4DeploymentAuditValue=typeof V4_ROBINHOOD_DEPLOYMENTS&{verification:DeploymentVerificationResult;runtimeFingerprints:typeof V4_ROBINHOOD_RUNTIME_FINGERPRINTS};
export type V4PoolKey={currency0:Address;currency1:Address;fee:number;tickSpacing:number;hooks:Address};
export type V4FeeSemantics={
 initializeFeeRaw:number;
 dynamicFee:boolean;
 staticFeePips:number|null;
 currentLpFeePips:number|null;
 currentProtocolFee:number|null;
 displayedFeePercent:number|null;
 valid:boolean;
 blockers:string[];
};
export type V4HookSemantics={hooks:Address;hooksZero:boolean;classification:'ZERO_HOOK'|'UNSUPPORTED_NONZERO_HOOK';supported:boolean;blockers:string[]};
export type V4PoolState={id:Hex;key:V4PoolKey;sqrtPriceX96:bigint;tick:number;liquidity:bigint;initialized:boolean;blockNumber:bigint;protocolFee?:number;lpFee?:number;feeSemantics?:V4FeeSemantics;hookSemantics?:V4HookSemantics};
export type V4InitializeEvent={id:Hex;key:V4PoolKey;initializeFeeRaw:number;sqrtPriceX96:bigint;tick:number;blockNumber:bigint;transactionHash:Hex;transactionIndex:number|null;logIndex:number};
export type V4DownsideRangeRequest={upperDropPct:number;lowerDropPct:number};
export const V4_DOWNSIDE_PRESETS=Object.freeze([10,30,50,60] as const);
export const V4_DYNAMIC_FEE_FLAG=0x800000;
export const V4_MAX_STATIC_FEE_PIPS=1_000_000;
export const v4StateViewAbi=[{type:'function',name:'getSlot0',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'uint160'},{type:'int24'},{type:'uint24'},{type:'uint24'}]},{type:'function',name:'getLiquidity',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'uint128'}]},{type:'function',name:'getFeeGrowthInside',stateMutability:'view',inputs:[{type:'bytes32'},{type:'int24'},{type:'int24'}],outputs:[{type:'uint256'},{type:'uint256'}]},{type:'function',name:'getPositionInfo',stateMutability:'view',inputs:[{type:'bytes32'},{type:'address'},{type:'int24'},{type:'int24'},{type:'bytes32'}],outputs:[{type:'uint128'},{type:'uint256'},{type:'uint256'}]}] as const;
const stateViewAbi=v4StateViewAbi;
const initializeEvent=parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
export const permit2Abi=[{type:'function',name:'allowance',stateMutability:'view',inputs:[{type:'address',name:'owner'},{type:'address',name:'token'},{type:'address',name:'spender'}],outputs:[{type:'uint160',name:'amount'},{type:'uint48',name:'expiration'},{type:'uint48',name:'nonce'}]}] as const;
/** Custom errors from the verified chain-4663 deployment ABIs at the exact
 * addresses pinned above. These are diagnostic-only and never select a route. */
export const v4RobinhoodUniversalRouterErrorAbi=parseAbi([
 'error AddressEmptyCode(address target)','error AddressInsufficientBalance(address account)','error BalanceTooLow()','error ContractLocked()','error DeltaNotNegative(address currency)','error DeltaNotPositive(address currency)','error ECDSAInvalidSignature()','error ECDSAInvalidSignatureLength(uint256 length)','error ECDSAInvalidSignatureS(bytes32 s)','error ETHNotAccepted()','error ExecutionFailed(uint256 commandIndex, bytes message)','error FailedInnerCall()','error FromAddressIsNotOwner()','error InputLengthMismatch()','error InsufficientBalance()','error InsufficientETH()','error InsufficientToken()','error InvalidAction(bytes4 action)','error InvalidBips()','error InvalidCommandType(uint256 commandType)','error InvalidEthSender()','error InvalidHopPriceLength()','error InvalidPath()','error InvalidPortion()','error InvalidReserves()','error InvalidShortString()','error LengthMismatch()','error NonceAlreadyUsed()','error NotAuthorizedForToken(uint256 tokenId)','error NotPoolManager()','error OnlyMintAllowed()','error SafeERC20FailedOperation(address token)','error SliceOutOfBounds()','error StringTooLong(string str)','error TransactionDeadlinePassed()','error UnsafeCast()','error UnsupportedAction(uint256 action)','error V2InvalidHopPriceLength()','error V2InvalidPath()','error V2TooLittleReceived()','error V2TooLittleReceivedPerHop(uint256 hopIndex, uint256 minPrice, uint256 price)','error V2TooMuchRequested()','error V3HopPriceAndPathLengthMismatch()','error V3InvalidAmountOut()','error V3InvalidCaller()','error V3InvalidSwap()','error V3TooLittleReceived()','error V3TooLittleReceivedPerHop(uint256 hopIndex, uint256 minPrice, uint256 price)','error V3TooMuchRequested()','error V3TooMuchRequestedPerHop(uint256 hopIndex, uint256 minPrice, uint256 price)','error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)','error V4TooLittleReceivedPerHop(uint256 hopIndex, uint256 minPrice, uint256 price)','error V4TooLittleReceivedPerHopSingle(uint256 minPrice, uint256 price)','error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)','error V4TooMuchRequestedPerHop(uint256 hopIndex, uint256 minPrice, uint256 price)','error V4TooMuchRequestedPerHopSingle(uint256 minPrice, uint256 price)',
]);
export const v4RobinhoodPoolManagerErrorAbi=parseAbi([
 'error AlreadyUnlocked()','error CurrenciesOutOfOrderOrEqual(address currency0, address currency1)','error CurrencyNotSettled()','error DelegateCallNotAllowed()','error InvalidCaller()','error ManagerLocked()','error MustClearExactPositiveDelta()','error NonzeroNativeValue()','error PoolNotInitialized()','error ProtocolFeeCurrencySynced()','error ProtocolFeeTooLarge(uint24 fee)','error SwapAmountCannotBeZero()','error TickSpacingTooLarge(int24 tickSpacing)','error TickSpacingTooSmall(int24 tickSpacing)','error UnauthorizedDynamicLPFeeUpdate()',
]);
export const v4RobinhoodPermit2ErrorAbi=parseAbi([
 'error AllowanceExpired(uint256 deadline)','error ExcessiveInvalidation()','error InsufficientAllowance(uint256 amount)','error InvalidAmount(uint256 maxAmount)','error InvalidContractSignature()','error InvalidNonce()','error InvalidSignature()','error InvalidSignatureLength()','error InvalidSigner()','error LengthMismatch()','error SignatureExpired(uint256 signatureDeadline)',
]);
const positionManagerVerifyAbi=[{type:'function',name:'nextTokenId',stateMutability:'view',inputs:[],outputs:[{type:'uint256'}]},{type:'function',name:'poolManager',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},{type:'function',name:'permit2',stateMutability:'view',inputs:[],outputs:[{type:'address'}]}] as const;
const poolManagerRelationshipAbi=[{type:'function',name:'poolManager',stateMutability:'view',inputs:[],outputs:[{type:'address'}]}] as const;
export function poolId(key:V4PoolKey):Hex{const a=key.currency0.toLowerCase(),b=key.currency1.toLowerCase();if(a>=b)throw new Error('V4_POOL_KEY_CURRENCIES_NOT_SORTED');return keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],[key.currency0,key.currency1,key.fee,key.tickSpacing,key.hooks]));}
export function decodeV4Fee(initializeFeeRaw:number,currentLpFeePips?:number,currentProtocolFee?:number):V4FeeSemantics{
 const blockers:string[]=[];
 if(!Number.isInteger(initializeFeeRaw)||initializeFeeRaw<0||initializeFeeRaw>0xffffff)blockers.push('MALFORMED_INITIALIZE_FEE');
 const dynamicFee=(initializeFeeRaw&V4_DYNAMIC_FEE_FLAG)!==0;
 const staticFeePips=dynamicFee?null:initializeFeeRaw;
 if(dynamicFee&&initializeFeeRaw!==V4_DYNAMIC_FEE_FLAG)blockers.push('UNKNOWN_DYNAMIC_FEE_BITS');
 if(staticFeePips!==null&&staticFeePips>V4_MAX_STATIC_FEE_PIPS)blockers.push('STATIC_FEE_OUT_OF_RANGE');
 if(currentLpFeePips!==undefined&&(!Number.isInteger(currentLpFeePips)||currentLpFeePips<0||currentLpFeePips>V4_MAX_STATIC_FEE_PIPS))blockers.push('CURRENT_LP_FEE_OUT_OF_RANGE');
 if(dynamicFee)blockers.push('DYNAMIC_FEE_UNSUPPORTED');
 const displayed=dynamicFee?(currentLpFeePips??null):staticFeePips;
 return {initializeFeeRaw,dynamicFee,staticFeePips,currentLpFeePips:currentLpFeePips??null,currentProtocolFee:currentProtocolFee??null,displayedFeePercent:displayed===null?null:displayed/10_000,valid:!blockers.some(x=>x.startsWith('MALFORMED')||x.startsWith('UNKNOWN')||x.endsWith('OUT_OF_RANGE')),blockers};
}
export function classifyV4Hooks(hooks:Address):V4HookSemantics{const hooksZero=hooks.toLowerCase()===zeroAddress;return {hooks,hooksZero,classification:hooksZero?'ZERO_HOOK':'UNSUPPORTED_NONZERO_HOOK',supported:hooksZero,blockers:hooksZero?[]:['NONZERO_HOOK_UNSUPPORTED']};}
export const V4_MAX_EXECUTION_STATIC_FEE_PIPS=50_000;
export function v4ExecutionBlockers(state:V4PoolState,extremeFeePips=V4_MAX_EXECUTION_STATIC_FEE_PIPS):string[]{
 const fee=state.feeSemantics??decodeV4Fee(state.key.fee,state.lpFee,state.protocolFee),hooks=state.hookSemantics??classifyV4Hooks(state.key.hooks),blockers=[...fee.blockers,...hooks.blockers];
 if(!state.initialized)blockers.push('POOL_NOT_INITIALIZED');
 // StateView.getLiquidity is current active liquidity, not whole-pool TVL or
 // a protocol capability signal. It must never make an otherwise valid PoolKey
 // unsupported; final execution still revalidates the selected pool.
 if(fee.staticFeePips!==null&&fee.staticFeePips>extremeFeePips)blockers.push('EXTREME_STATIC_FEE');
 return [...new Set(blockers)];
}
export async function auditRobinhoodV4Deployments(rpc:FallbackRpc,fetcher:typeof fetch=fetch):Promise<Availability<V4DeploymentAuditValue>>{try{
 const [chainId,block]=await rpc.withClient(client=>Promise.all([client.getChainId(),client.getBlockNumber()]),{stage:'v4_deployment_audit',method:'eth_chainId+eth_blockNumber'}).then(([id,number])=>[id,number] as const);
 const entries=Object.entries(V4_ROBINHOOD_RUNTIME_FINGERPRINTS) as [keyof typeof V4_ROBINHOOD_RUNTIME_FINGERPRINTS,(typeof V4_ROBINHOOD_RUNTIME_FINGERPRINTS)[keyof typeof V4_ROBINHOOD_RUNTIME_FINGERPRINTS]][];
 const observations=await Promise.all(entries.map(async([name,expected])=>{const [code,explorer]=await Promise.all([
  rpc.withClient(client=>client.getBytecode({address:expected.address}),{stage:'v4_deployment_audit',method:`eth_getCode:${name}`}),
  fetcher(`https://robinhoodchain.blockscout.com/api?module=contract&action=getsourcecode&address=${expected.address}`,{signal:AbortSignal.timeout(1_500)}).then(async response=>{if(response.status===429)return {status:'RATE_LIMITED' as ExplorerStatus,match:false};if(!response.ok)return {status:'UNAVAILABLE' as ExplorerStatus,match:false};try{const data=await response.json() as {message?:string;result?:unknown[]};const match=data.message==='OK'&&Array.isArray(data.result)&&data.result.length>0;return {status:(match?'VERIFIED':'MISMATCH') as ExplorerStatus,match};}catch{return {status:'UNKNOWN' as ExplorerStatus,match:false};}}).catch(()=>({status:'UNAVAILABLE' as ExplorerStatus,match:false})),
 ]);const present=!!code&&code!=='0x',hash=present?keccak256(code!):undefined,size=present?(code!.length-2)/2:0;return {name,expected,present,hash,size,hashMatch:hash===expected.hash&&size===expected.size,explorer};}));
 let interfaceProbeMatch=true;let relationships={positionManagerPoolManager:false,positionManagerPermit2:false,stateViewPoolManager:false,quoterPoolManager:false,universalRouterPoolManager:false};
 try{const [state,nextTokenId,pm,p2,statePm,quoterPm,routerPm]=await Promise.all([
  rpc.withClient(client=>client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:stateViewAbi,functionName:'getLiquidity',args:['0x0000000000000000000000000000000000000000000000000000000000000000']}),{stage:'v4_deployment_audit',method:'StateView.getLiquidity'}),
  rpc.withClient(client=>client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.positionManager,abi:positionManagerVerifyAbi,functionName:'nextTokenId'}),{stage:'v4_deployment_audit',method:'PositionManager.nextTokenId'}),
  rpc.withClient(client=>client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.positionManager,abi:positionManagerVerifyAbi,functionName:'poolManager'}),{stage:'v4_deployment_audit',method:'PositionManager.poolManager'}),
  rpc.withClient(client=>client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.positionManager,abi:positionManagerVerifyAbi,functionName:'permit2'}),{stage:'v4_deployment_audit',method:'PositionManager.permit2'}),
  rpc.withClient(client=>client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:poolManagerRelationshipAbi,functionName:'poolManager'}),{stage:'v4_deployment_audit',method:'StateView.poolManager'}),
  rpc.withClient(client=>client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.quoter,abi:poolManagerRelationshipAbi,functionName:'poolManager'}),{stage:'v4_deployment_audit',method:'Quoter.poolManager'}),
  rpc.withClient(client=>client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.universalRouter,abi:poolManagerRelationshipAbi,functionName:'poolManager'}),{stage:'v4_deployment_audit',method:'UniversalRouter.poolManager'}),
 ]);interfaceProbeMatch=BigInt(String(state))>=0n&&BigInt(String(nextTokenId))>0n;relationships={positionManagerPoolManager:String(pm).toLowerCase()===V4_ROBINHOOD_DEPLOYMENTS.poolManager.toLowerCase(),positionManagerPermit2:String(p2).toLowerCase()===V4_ROBINHOOD_DEPLOYMENTS.permit2.toLowerCase(),stateViewPoolManager:String(statePm).toLowerCase()===V4_ROBINHOOD_DEPLOYMENTS.poolManager.toLowerCase(),quoterPoolManager:String(quoterPm).toLowerCase()===V4_ROBINHOOD_DEPLOYMENTS.poolManager.toLowerCase(),universalRouterPoolManager:String(routerPm).toLowerCase()===V4_ROBINHOOD_DEPLOYMENTS.poolManager.toLowerCase()};}catch(error){if(isRetryableRpcFailure(error))throw error;interfaceProbeMatch=false;}
 const statuses=observations.map(x=>x.explorer.status),explorerStatus:ExplorerStatus=statuses.every(x=>x==='VERIFIED')?'VERIFIED':statuses.includes('RATE_LIMITED')?'RATE_LIMITED':statuses.includes('UNAVAILABLE')?'UNAVAILABLE':statuses.includes('MISMATCH')?'MISMATCH':'UNKNOWN';
 const verification=evaluateDeploymentVerification({officialRegistryMatch:entries.every(([name,expected])=>V4_ROBINHOOD_DEPLOYMENTS[name].toLowerCase()===expected.address.toLowerCase()),chainIdMatch:chainId===RH_MAINNET,addressMatch:entries.every(([name,expected])=>V4_ROBINHOOD_DEPLOYMENTS[name].toLowerCase()===expected.address.toLowerCase()),codePresent:observations.every(x=>x.present),runtimeCodeHashMatch:observations.every(x=>x.hashMatch),interfaceProbeMatch,relationshipMatch:Object.values(relationships).every(Boolean),explorerStatus,explorerContractMatch:observations.every(x=>x.explorer.match)});
 const confidence:'verified'|'partial'=verification.executionAllowedByDeploymentAudit?'verified':'partial',provenance={provider:'official persisted Uniswap v4 registry + exact rpc runtime fingerprints + interface/relationship probes; explorer informational',observedAt:new Date().toISOString(),blockNumber:block,confidence};
 if(!verification.executionAllowedByDeploymentAudit)return {status:'unavailable',reason:`V4_DEPLOYMENT_UNAVAILABLE: ${verification.blockingReasons.join(',')}`,details:{verification,observations,relationships},provenance};
 return {status:'available',value:Object.freeze({...V4_ROBINHOOD_DEPLOYMENTS,verification,runtimeFingerprints:V4_ROBINHOOD_RUNTIME_FINGERPRINTS}),provenance};
 }catch(error){if(isRetryableRpcFailure(error))throw error;return {status:'unavailable',reason:`V4_DEPLOYMENT_UNAVAILABLE: ${sanitizeRpcError(error,{stage:'v4_deployment_audit',method:'deployment_verification'})}`};}}
export async function inspectV4Pool(rpc:FallbackRpc,key:V4PoolKey,atBlock?:bigint):Promise<Availability<V4PoolState>>{
 try{return await rpc.withClient(async client=>{const id=poolId(key),blockNumber=atBlock??await client.getBlockNumber(),[slot,liquidity]=await Promise.all([client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:stateViewAbi,functionName:'getSlot0',args:[id],blockNumber}),client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:stateViewAbi,functionName:'getLiquidity',args:[id],blockNumber})]);const protocolFee=Number(slot[2]),lpFee=Number(slot[3]),feeSemantics=decodeV4Fee(key.fee,lpFee,protocolFee),hookSemantics=classifyV4Hooks(key.hooks);return {status:'available' as const,value:{id,key,sqrtPriceX96:slot[0],tick:Number(slot[1]),liquidity,initialized:slot[0]!==0n,blockNumber,protocolFee,lpFee,feeSemantics,hookSemantics},provenance:{provider:'v4 StateView.getSlot0/getLiquidity',observedAt:new Date().toISOString(),blockNumber,confidence:'verified' as const}};},{stage:'v4_pool_inspection',method:'StateView.getSlot0'});}
 catch(error){if(isRetryableRpcFailure(error))throw error;return {status:'unavailable',reason:`v4 pool inspection failed: ${sanitizeRpcError(error,{stage:'v4_pool_inspection',method:'StateView.getSlot0'})}`};}
}
/** Bounded Initialize reader used by the durable registry. It never chooses a genesis range for the caller. */
export async function readV4InitializeEvents(rpc:FallbackRpc,fromBlock:bigint,toBlock:bigint):Promise<Availability<V4InitializeEvent[]>>{
 if(fromBlock<0n||toBlock<fromBlock) return {status:'unavailable',reason:'V4_INVALID_BLOCK_WINDOW'};
 return rpc.withClient(async client=>{try{const logs=await client.getLogs({address:V4_ROBINHOOD_DEPLOYMENTS.poolManager,event:initializeEvent,fromBlock,toBlock});const value=logs.map(log=>{const key:V4PoolKey={currency0:getAddress(log.args.currency0!),currency1:getAddress(log.args.currency1!),fee:Number(log.args.fee),tickSpacing:Number(log.args.tickSpacing),hooks:getAddress(log.args.hooks??zeroAddress)},computed=poolId(key),eventId=log.args.id!;if(computed.toLowerCase()!==eventId.toLowerCase())throw new Error('V4_INITIALIZE_POOL_ID_MISMATCH');return {id:eventId,key,initializeFeeRaw:key.fee,sqrtPriceX96:log.args.sqrtPriceX96!,tick:Number(log.args.tick),blockNumber:log.blockNumber!,transactionHash:log.transactionHash!,transactionIndex:log.transactionIndex===null?null:Number(log.transactionIndex),logIndex:Number(log.logIndex)};});return {status:'available',value,provenance:{provider:'PoolManager.Initialize bounded eth_getLogs',observedAt:new Date().toISOString(),blockNumber:toBlock,confidence:'verified'}};}catch(error){return {status:'unavailable',reason:`v4 Initialize read failed: ${error instanceof Error?error.message:String(error)}`};}});
}
export async function discoverV4Pools(rpc:FallbackRpc,token:Address):Promise<Availability<V4PoolState[]>>{const audit=await auditRobinhoodV4Deployments(rpc);if(audit.status==='unavailable')return audit;return rpc.withClient(async client=>{try{const target=getAddress(token),quotes=Object.values(robinhoodMainnet.assets).filter(q=>q.toLowerCase()!==target.toLowerCase()),states:V4PoolState[]=[];for(const quote of quotes){const [currency0,currency1]=[target,quote].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())) as [Address,Address];const logs=await client.getLogs({address:audit.value.poolManager,event:initializeEvent,args:{currency0,currency1},fromBlock:0n,toBlock:'latest'});for(const log of logs){const key:V4PoolKey={currency0,currency1,fee:Number(log.args.fee),tickSpacing:Number(log.args.tickSpacing),hooks:getAddress(log.args.hooks??zeroAddress)};const state=await inspectV4Pool(rpc,key);if(state.status==='available')states.push(state.value);}}return {status:'available',value:states,provenance:{provider:'PoolManager Initialize logs + StateView',observedAt:new Date().toISOString(),confidence:'verified'}};}catch(error){return {status:'unavailable',reason:`v4 pool discovery failed: ${error instanceof Error?error.message:String(error)}`};}});}
export async function permit2Allowance(rpc:FallbackRpc,owner:Address,token:Address,spender:Address){return rpc.withClient(client=>client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.permit2,abi:permit2Abi,functionName:'allowance',args:[owner,token,spender]}),{stage:'allowance_preflight',method:'Permit2.allowance'});}

export const V4_ACTIONS=Object.freeze({INCREASE_LIQUIDITY:0x00,DECREASE_LIQUIDITY:0x01,MINT_POSITION:0x02,BURN_POSITION:0x03,MINT_POSITION_FROM_DELTAS:0x05,SWAP_EXACT_IN_SINGLE:0x06,SETTLE_ALL:0x0c,SETTLE_PAIR:0x0d,TAKE_ALL:0x0f,TAKE_PAIR:0x11});
const poolKeyParam={type:'tuple',components:[{type:'address',name:'currency0'},{type:'address',name:'currency1'},{type:'uint24',name:'fee'},{type:'int24',name:'tickSpacing'},{type:'address',name:'hooks'}]} as const;
const mintParamTypes=[poolKeyParam,{type:'int24'},{type:'int24'},{type:'uint256'},{type:'uint128'},{type:'uint128'},{type:'address'},{type:'bytes'}] as const;
const pairParamTypes=[{type:'address'},{type:'address'}] as const;
export const positionManagerAbi=[
 {type:'function',name:'modifyLiquidities',stateMutability:'payable',inputs:[{type:'bytes',name:'unlockData'},{type:'uint256',name:'deadline'}],outputs:[]},
 {type:'function',name:'nextTokenId',stateMutability:'view',inputs:[],outputs:[{type:'uint256'}]},
 {type:'function',name:'ownerOf',stateMutability:'view',inputs:[{type:'uint256'}],outputs:[{type:'address'}]},
 {type:'function',name:'getPositionLiquidity',stateMutability:'view',inputs:[{type:'uint256'}],outputs:[{type:'uint128'}]},
 {type:'function',name:'getPoolAndPositionInfo',stateMutability:'view',inputs:[{type:'uint256'}],outputs:[poolKeyParam,{type:'uint256'}]},
 {type:'event',name:'Transfer',inputs:[{indexed:true,type:'address',name:'from'},{indexed:true,type:'address',name:'to'},{indexed:true,type:'uint256',name:'id'}]},
] as const;
export const permit2ApproveAbi=[...permit2Abi,{type:'function',name:'approve',stateMutability:'nonpayable',inputs:[{type:'address',name:'token'},{type:'address',name:'spender'},{type:'uint160',name:'amount'},{type:'uint48',name:'expiration'}],outputs:[]}] as const;
export function v4ApprovalRequirement(erc20Allowance:bigint,permitAllowance:readonly [bigint,number,number],required:bigint,now:bigint){if(erc20Allowance<required)return 'ERC20_TO_PERMIT2_REQUIRED' as const;if(permitAllowance[0]<required||BigInt(permitAllowance[1])<=now)return 'PERMIT2_TO_POSITION_MANAGER_REQUIRED' as const;return 'READY_TO_MINT' as const;}
export function buildPermit2Approval(token:Address,amount:bigint,expiration:bigint){if(amount<=0n||amount>2n**160n-1n)throw new Error('V4_PERMIT2_AMOUNT_INVALID');if(expiration<=0n||expiration>2n**48n-1n)throw new Error('V4_PERMIT2_EXPIRATION_INVALID');return {to:V4_ROBINHOOD_DEPLOYMENTS.permit2,data:encodeFunctionData({abi:permit2ApproveAbi,functionName:'approve',args:[token,V4_ROBINHOOD_DEPLOYMENTS.positionManager,amount,Number(expiration)]}),amount,expiration,spender:V4_ROBINHOOD_DEPLOYMENTS.positionManager};}
export type V4MintPlan={key:V4PoolKey;tickLower:number;tickUpper:number;liquidity:bigint;amount0Max:bigint;amount1Max:bigint;owner:Address;hookData:Hex;deadline:bigint;fundingIndex?:0|1;actions:Hex;params:readonly Hex[];unlockData:Hex;calldata:Hex;calldataHash:Hex};
export function buildV4Mint(input:Omit<V4MintPlan,'actions'|'params'|'unlockData'|'calldata'|'calldataHash'>):V4MintPlan{const fundingIndex=input.fundingIndex??1;if((fundingIndex===0&&input.amount1Max!==0n)||(fundingIndex===1&&input.amount0Max!==0n))throw new Error('V4_TARGET_AMOUNT_MUST_BE_ZERO');if((input.amount0Max===0n)===(input.amount1Max===0n))throw new Error('V4_EXACTLY_ONE_FUNDING_TOKEN_REQUIRED');if(input.amount0Max<0n||input.amount1Max<0n||input.liquidity<=0n)throw new Error('V4_FUNDING_OR_LIQUIDITY_ZERO');const actions='0x020d' as Hex,mint=encodeAbiParameters(mintParamTypes,[input.key,input.tickLower,input.tickUpper,input.liquidity,input.amount0Max,input.amount1Max,input.owner,input.hookData]),settle=encodeAbiParameters(pairParamTypes,[input.key.currency0,input.key.currency1]),params=[mint,settle] as const,unlockData=encodeAbiParameters([{type:'bytes'},{type:'bytes[]'}],[actions,params]),calldata=encodeFunctionData({abi:positionManagerAbi,functionName:'modifyLiquidities',args:[unlockData,input.deadline]});return {...input,fundingIndex,actions,params,unlockData,calldata,calldataHash:keccak256(calldata)};}
export function decodeV4Mint(calldata:Hex){const call=decodeFunctionData({abi:positionManagerAbi,data:calldata});if(call.functionName!=='modifyLiquidities')throw new Error('NOT_MODIFY_LIQUIDITIES');const [unlockData,deadline]=call.args;const [actions,params]=decodeAbiParameters([{type:'bytes'},{type:'bytes[]'}],unlockData);if(actions!=='0x020d'||params.length!==2)throw new Error('INVALID_V4_MINT_ACTIONS');const mint=decodeAbiParameters(mintParamTypes,params[0]!),settle=decodeAbiParameters(pairParamTypes,params[1]!);return {deadline,actions,params,mint:{key:mint[0],tickLower:mint[1],tickUpper:mint[2],liquidity:mint[3],amount0Max:mint[4],amount1Max:mint[5],owner:mint[6],hookData:mint[7]},settle};}

const Q96=2n**96n,MAX_TICK=887272;
export const V4_MIN_TICK=-MAX_TICK, V4_MAX_TICK=MAX_TICK;
/** Exact Solidity TickMath port: returns sqrt(1.0001^tick)*2^96 without floating point. */
export function sqrtPriceAtTick(tick:number):bigint{if(!Number.isInteger(tick)||tick < -MAX_TICK||tick>MAX_TICK)throw new Error('V4_TICK_OVERFLOW');let abs=tick<0?-tick:tick,ratio=(abs&1)?0xfffcb933bd6fad37aa2d162d1a594001n:0x100000000000000000000000000000000n;const cs=[[2,0xfff97272373d413259a46990580e213an],[4,0xfff2e50f5f656932ef12357cf3c7fdccn],[8,0xffe5caca7e10e4e61c3624eaa0941cd0n],[16,0xffcb9843d60f6159c9db58835c926644n],[32,0xff973b41fa98c081472e6896dfb254c0n],[64,0xff2ea16466c96a3843ec78b326b52861n],[128,0xfe5dee046a99a2a811c461f1969c3053n],[256,0xfcbe86c7900a88aedcffc83b479aa3a4n],[512,0xf987a7253ac413176f2b074cf7815e54n],[1024,0xf3392b0822b70005940c7a398e4b70f3n],[2048,0xe7159475a2c29b7443b29c7fa6e889d9n],[4096,0xd097f3bdfd2022b8845ad8f792aa5825n],[8192,0xa9f746462d870fdf8a65dc1f90e061e5n],[16384,0x70d869a156d2a1b890bb3df62baf32f7n],[32768,0x31be135f97d08fd981231505542fcfa6n],[65536,0x9aa508b5b7a84e1c677de54f3e99bc9n],[131072,0x5d6af8dedb81196699c329225ee604n],[262144,0x2216e584f5fa1ea926041bedfe98n],[524288,0x48a170391f7dc42444e8fa2n]] as const;for(const [bit,c] of cs)if(abs&bit)ratio=ratio*c>>128n;if(tick>0)ratio=((1n<<256n)-1n)/ratio;return (ratio>>32n)+(ratio%(1n<<32n)===0n?0n:1n);}
const ceilDiv=(a:bigint,b:bigint)=>a/b+(a%b===0n?0n:1n);
export function validateV4DownsideRange(request:V4DownsideRangeRequest){
 const {upperDropPct,lowerDropPct}=request;
 if(!Number.isFinite(upperDropPct)||!Number.isFinite(lowerDropPct)||upperDropPct<0||upperDropPct>=lowerDropPct||lowerDropPct>=100)throw new Error('downside percentages must satisfy 0 <= upperDropPct < lowerDropPct < 100');
 return request;
}
export function buildV4SingleSidedDownsidePlan(pool:V4PoolState,fundingAmount:bigint,owner:Address,deadline:bigint,request:V4DownsideRangeRequest):V4MintPlan&{currentTick:number;sqrtPriceX96:bigint;amount0Expected:bigint;amount1Expected:bigint;requestedRange:V4DownsideRangeRequest;effectiveRange:V4DownsideRangeRequest}{
 validateV4DownsideRange(request);if(!pool.initialized||pool.liquidity<=0n)throw new Error('V4_POOL_ZERO_ACTIVE_LIQUIDITY');const spacing=pool.key.tickSpacing;if(!Number.isSafeInteger(spacing)||spacing<=0)throw new Error('V4_TICK_SPACING_INVALID');
 const offset=(drop:number)=>Math.log(1-drop/100)/Math.log(1.0001),rawUpper=pool.tick+offset(request.upperDropPct),rawLower=pool.tick+offset(request.lowerDropPct),tickUpper=Math.floor(rawUpper/spacing)*spacing,tickLower=Math.floor(rawLower/spacing)*spacing;
 if(tickLower<=-MAX_TICK||tickUpper>MAX_TICK||tickLower>=tickUpper||pool.tick<tickUpper)throw new Error('V4_NOT_STRICT_TOKEN1_ONLY');const lower=sqrtPriceAtTick(tickLower),upper=sqrtPriceAtTick(tickUpper),liquidity=fundingAmount*Q96/(upper-lower),amount1Expected=ceilDiv(liquidity*(upper-lower),Q96);if(liquidity<=0n||amount1Expected<=0n||amount1Expected>fundingAmount)throw new Error('V4_FUNDING_CAP_EXCEEDED');
 const actual=(tick:number)=>(1-Math.pow(1.0001,tick-pool.tick))*100,effectiveRange={upperDropPct:Math.max(0,actual(tickUpper)),lowerDropPct:Math.max(0,actual(tickLower))};
 return {...buildV4Mint({key:pool.key,tickLower,tickUpper,liquidity,amount0Max:0n,amount1Max:fundingAmount,owner,hookData:'0x',deadline}),currentTick:pool.tick,sqrtPriceX96:pool.sqrtPriceX96,amount0Expected:0n,amount1Expected,requestedRange:{...request},effectiveRange};
}
type GenericV4SingleSidedInput={pool:V4PoolState;target:Address;funding:Address;fundingAmount:bigint;owner:Address;deadline:bigint;range:V4DownsideRangeRequest};
type GenericV4SingleSidedPlan=V4MintPlan&{targetIndex:0|1;fundingIndex:0|1;currentTick:number;sqrtPriceX96:bigint;amount0Expected:bigint;amount1Expected:bigint;requestedRange:V4DownsideRangeRequest;effectiveRange:V4DownsideRangeRequest};
function genericV4Roles(input:Pick<GenericV4SingleSidedInput,'pool'|'target'|'funding'>){
 const {pool,target,funding}=input;
 const targetIndex=pool.key.currency0.toLowerCase()===target.toLowerCase()?0:pool.key.currency1.toLowerCase()===target.toLowerCase()?1:-1;
 const fundingIndex=pool.key.currency0.toLowerCase()===funding.toLowerCase()?0:pool.key.currency1.toLowerCase()===funding.toLowerCase()?1:-1;
 if(targetIndex<0||fundingIndex<0||targetIndex===fundingIndex)throw new Error('V4_SELECTED_TOKEN_ORIENTATION_MISMATCH');
 if(v4ExecutionBlockers(pool).length)throw new Error(`V4_POOL_EXECUTION_BLOCKED:${v4ExecutionBlockers(pool).join(',')}`);
 return {targetIndex:targetIndex as 0|1,fundingIndex:fundingIndex as 0|1};
}
export function buildGenericV4SingleSidedPlanAtTicks(input:GenericV4SingleSidedInput&{tickLower:number;tickUpper:number}):GenericV4SingleSidedPlan{
 const {pool,fundingAmount,owner,deadline,range,tickLower,tickUpper}=input;validateV4DownsideRange(range);
 const {targetIndex,fundingIndex}=genericV4Roles(input);
 const spacing=pool.key.tickSpacing;if(!Number.isSafeInteger(spacing)||spacing<=0)throw new Error('V4_TICK_SPACING_INVALID');
 if(tickLower%spacing!==0||tickUpper%spacing!==0)throw new Error('V4_TICK_SPACING_INVALID');
 if(targetIndex===0&&pool.tick<tickUpper)throw new Error('V4_NOT_STRICT_FUNDING_ONLY');
 if(targetIndex===1&&pool.tick>tickLower)throw new Error('V4_NOT_STRICT_FUNDING_ONLY');
 if(tickLower<=-MAX_TICK||tickUpper>MAX_TICK||tickLower>=tickUpper)throw new Error('V4_TICK_RANGE_INVALID');
 const lower=sqrtPriceAtTick(tickLower),upper=sqrtPriceAtTick(tickUpper);
 const liquidity=fundingIndex===1?fundingAmount*Q96/(upper-lower):fundingAmount*lower*upper/(Q96*(upper-lower));
 const expected=fundingIndex===1?ceilDiv(liquidity*(upper-lower),Q96):ceilDiv(liquidity*(upper-lower)*Q96,lower*upper);
 if(liquidity<=0n||expected<=0n||expected>fundingAmount)throw new Error('V4_FUNDING_CAP_EXCEEDED');
 const amount0Expected=fundingIndex===0?expected:0n,amount1Expected=fundingIndex===1?expected:0n;
 const actual=(tick:number)=>targetIndex===0?(1-Math.pow(1.0001,tick-pool.tick))*100:(1-Math.pow(1.0001,pool.tick-tick))*100;
 const effectiveRange={upperDropPct:Math.max(0,actual(targetIndex===0?tickUpper:tickLower)),lowerDropPct:Math.max(0,actual(targetIndex===0?tickLower:tickUpper))};
 return {...buildV4Mint({key:pool.key,tickLower,tickUpper,liquidity,amount0Max:fundingIndex===0?fundingAmount:0n,amount1Max:fundingIndex===1?fundingAmount:0n,owner,hookData:'0x',deadline,fundingIndex}),targetIndex,fundingIndex,currentTick:pool.tick,sqrtPriceX96:pool.sqrtPriceX96,amount0Expected,amount1Expected,requestedRange:{...range},effectiveRange};
}
export function buildGenericV4SingleSidedDownsidePlan(input:GenericV4SingleSidedInput):GenericV4SingleSidedPlan{
 const {pool,range}=input;validateV4DownsideRange(range);
 const {targetIndex}=genericV4Roles(input),spacing=pool.key.tickSpacing;
 if(!Number.isSafeInteger(spacing)||spacing<=0)throw new Error('V4_TICK_SPACING_INVALID');
 const offset=(drop:number)=>Math.log(1-drop/100)/Math.log(1.0001);
 const ticks=targetIndex===0?{tickUpper:Math.floor((pool.tick+offset(range.upperDropPct))/spacing)*spacing,tickLower:Math.floor((pool.tick+offset(range.lowerDropPct))/spacing)*spacing}:{tickLower:Math.ceil((pool.tick-offset(range.upperDropPct))/spacing)*spacing,tickUpper:Math.ceil((pool.tick-offset(range.lowerDropPct))/spacing)*spacing};
 return buildGenericV4SingleSidedPlanAtTicks({...input,...ticks});
}
export function buildStrictToken1Plan(pool:V4PoolState,fundingAmount:bigint,owner:Address,deadline:bigint,dropPct=10){return buildV4SingleSidedDownsidePlan(pool,fundingAmount,owner,deadline,{upperDropPct:0,lowerDropPct:dropPct});}
export function decodePositionInfo(info:bigint){const signed24=(x:bigint)=>{const n=Number(x&0xffffffn);return n&0x800000?n-0x1000000:n;};return {tickLower:signed24(info>>8n),tickUpper:signed24(info>>32n),hasSubscriber:Boolean(info&0xffn)};}
export async function inspectV4Position(rpc:FallbackRpc,tokenId:bigint){return rpc.withClient(async client=>{const [owner,p,liquidity]=await Promise.all([client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.positionManager,abi:positionManagerAbi,functionName:'ownerOf',args:[tokenId]}),client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.positionManager,abi:positionManagerAbi,functionName:'getPoolAndPositionInfo',args:[tokenId]}),client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.positionManager,abi:positionManagerAbi,functionName:'getPositionLiquidity',args:[tokenId]})]);return {tokenId,owner,key:p[0],info:p[1],...decodePositionInfo(p[1]),liquidity};},{stage:'v4_position_inspection',method:'PositionManager.ownerOf+positionInfo+liquidity'});}
function errorData(error:unknown,seen=new Set<unknown>()):Hex|undefined{if(error===null||typeof error!=='object'||seen.has(error))return;seen.add(error);const row=error as Record<string,unknown>;if(typeof row.data==='string'&&/^0x[0-9a-fA-F]+$/.test(row.data))return row.data as Hex;if(row.data&&typeof row.data==='object'){const nested=errorData(row.data,seen);if(nested)return nested;}return errorData(row.cause,seen);}
/** Canonical deployed PositionManager burn/not-found signal: Error("NOT_MINTED"). */
export function isCanonicalV4NotMinted(error:unknown){const data=errorData(error);if(!data||!data.startsWith('0x08c379a0'))return false;try{return decodeAbiParameters([{type:'string'}],`0x${data.slice(10)}` as Hex)[0]==='NOT_MINTED';}catch{return false;}}
export type V4BurnEvidence={previouslyMinted:boolean;burnConfirmed:boolean;burnTxHash?:Hex};
export type V4TerminalPositionResult=
 | {tokenId:bigint;status:'burned';terminal:true;owner:null;onchainLiquidity:0n;nftExists:false;burnTxHash:Hex}
 | {tokenId:bigint;status:'not_found';terminal:false;owner:null;onchainLiquidity:null;nftExists:false};
/** Converts NOT_MINTED into a terminal result only when receipt-backed durable burn evidence is supplied. */
export async function inspectV4PositionTerminalAware(rpc:FallbackRpc,tokenId:bigint,evidence?:V4BurnEvidence){try{return await inspectV4Position(rpc,tokenId);}catch(error){if(!isCanonicalV4NotMinted(error))throw error;if(evidence?.previouslyMinted&&evidence.burnConfirmed&&evidence.burnTxHash)return {tokenId,status:'burned',terminal:true,owner:null,onchainLiquidity:0n,nftExists:false,burnTxHash:evidence.burnTxHash} as const;return {tokenId,status:'not_found',terminal:false,owner:null,onchainLiquidity:null,nftExists:false} as const;}}
export function parseV4MintTokenId(logs:readonly {address:Address;data:Hex;topics:readonly Hex[]}[],owner:Address){for(const log of logs){if(log.address.toLowerCase()!==V4_ROBINHOOD_DEPLOYMENTS.positionManager.toLowerCase())continue;try{const event=decodeEventLog({abi:positionManagerAbi,data:log.data,topics:log.topics as [Hex,...Hex[]]});if(event.eventName==='Transfer'&&event.args.from===zeroAddress&&event.args.to.toLowerCase()===owner.toLowerCase())return event.args.id;}catch{}}throw new Error('V4_MINT_TRANSFER_EVENT_MISSING');}

const decreaseParamTypes=[{type:'uint256'},{type:'uint256'},{type:'uint128'},{type:'uint128'},{type:'bytes'}] as const;
const burnParamTypes=[{type:'uint256'},{type:'uint128'},{type:'uint128'},{type:'bytes'}] as const;
const takePairParamTypes=[{type:'address'},{type:'address'},{type:'address'}] as const;
export type V4LifecyclePlan={kind:'collect'|'decrease'|'burn';tokenId:bigint;liquidity:bigint;amount0Min:bigint;amount1Min:bigint;recipient:Address;hookData:Hex;key:V4PoolKey;deadline:bigint;actions:Hex;params:readonly Hex[];unlockData:Hex;calldata:Hex;calldataHash:Hex};
function encodeLifecycle(kind:V4LifecyclePlan['kind'],input:Omit<V4LifecyclePlan,'kind'|'actions'|'params'|'unlockData'|'calldata'|'calldataHash'>):V4LifecyclePlan{if(input.tokenId<0n||input.liquidity<0n||input.amount0Min<0n||input.amount1Min<0n)throw new Error('V4_LIFECYCLE_AMOUNT_INVALID');let action:number,primary:Hex;if(kind==='burn'){if(input.liquidity!==0n)throw new Error('V4_BURN_REQUIRES_ZERO_LEDGER_LIQUIDITY');action=V4_ACTIONS.BURN_POSITION;primary=encodeAbiParameters(burnParamTypes,[input.tokenId,input.amount0Min,input.amount1Min,input.hookData]);}else{action=V4_ACTIONS.DECREASE_LIQUIDITY;primary=encodeAbiParameters(decreaseParamTypes,[input.tokenId,input.liquidity,input.amount0Min,input.amount1Min,input.hookData]);}const actions=`0x${action.toString(16).padStart(2,'0')}${V4_ACTIONS.TAKE_PAIR.toString(16).padStart(2,'0')}` as Hex,params=[primary,encodeAbiParameters(takePairParamTypes,[input.key.currency0,input.key.currency1,input.recipient])] as const,unlockData=encodeAbiParameters([{type:'bytes'},{type:'bytes[]'}],[actions,params]),calldata=encodeFunctionData({abi:positionManagerAbi,functionName:'modifyLiquidities',args:[unlockData,input.deadline]});return {...input,kind,actions,params,unlockData,calldata,calldataHash:keccak256(calldata)};}
export function buildV4Collect(input:Omit<V4LifecyclePlan,'kind'|'actions'|'params'|'unlockData'|'calldata'|'calldataHash'|'liquidity'|'amount0Min'|'amount1Min'>){return encodeLifecycle('collect',{...input,liquidity:0n,amount0Min:0n,amount1Min:0n});}
export function buildV4Decrease(input:Omit<V4LifecyclePlan,'kind'|'actions'|'params'|'unlockData'|'calldata'|'calldataHash'>){if(input.liquidity<=0n)throw new Error('V4_DECREASE_LIQUIDITY_ZERO');return encodeLifecycle('decrease',input);}
export function buildV4Burn(input:Omit<V4LifecyclePlan,'kind'|'actions'|'params'|'unlockData'|'calldata'|'calldataHash'|'liquidity'>){return encodeLifecycle('burn',{...input,liquidity:0n});}
export function decodeV4Lifecycle(calldata:Hex){const call=decodeFunctionData({abi:positionManagerAbi,data:calldata});if(call.functionName!=='modifyLiquidities')throw new Error('NOT_MODIFY_LIQUIDITIES');const [unlockData,deadline]=call.args,[actions,params]=decodeAbiParameters([{type:'bytes'},{type:'bytes[]'}],unlockData);if(params.length!==2||actions.length!==6||Number.parseInt(actions.slice(2,4),16)===V4_ACTIONS.MINT_POSITION_FROM_DELTAS||Number.parseInt(actions.slice(4,6),16)!==V4_ACTIONS.TAKE_PAIR)throw new Error('INVALID_V4_LIFECYCLE_ACTIONS');const action=Number.parseInt(actions.slice(2,4),16),take=decodeAbiParameters(takePairParamTypes,params[1]!);if(action===V4_ACTIONS.BURN_POSITION){const p=decodeAbiParameters(burnParamTypes,params[0]!);return {kind:'burn' as const,deadline,actions,tokenId:p[0],liquidity:0n,amount0Min:p[1],amount1Min:p[2],hookData:p[3],take};}if(action!==V4_ACTIONS.DECREASE_LIQUIDITY)throw new Error('UNSUPPORTED_V4_LIFECYCLE_ACTION');const p=decodeAbiParameters(decreaseParamTypes,params[0]!);return {kind:p[1]===0n?'collect' as const:'decrease' as const,deadline,actions,tokenId:p[0],liquidity:p[1],amount0Min:p[2],amount1Min:p[3],hookData:p[4],take};}
export function amountsForLiquidity(sqrtPriceX96:bigint,tickLower:number,tickUpper:number,liquidity:bigint){if(liquidity<0n||tickLower>=tickUpper)throw new Error('V4_POSITION_AMOUNT_INPUT_INVALID');const lower=sqrtPriceAtTick(tickLower),upper=sqrtPriceAtTick(tickUpper);if(sqrtPriceX96<=lower)return {token0:liquidity*(upper-lower)*Q96/(lower*upper),token1:0n};if(sqrtPriceX96<upper)return {token0:liquidity*(upper-sqrtPriceX96)*Q96/(sqrtPriceX96*upper),token1:liquidity*(sqrtPriceX96-lower)/Q96};return {token0:0n,token1:liquidity*(upper-lower)/Q96};}
export function slippageMinimums(amounts:{token0:bigint;token1:bigint},slippageBps:number){if(!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>10_000)throw new Error('V4_SLIPPAGE_INVALID');const keep=10_000n-BigInt(slippageBps);return {amount0Min:amounts.token0*keep/10_000n,amount1Min:amounts.token1*keep/10_000n};}
export type V4RangeState='below_range'|'in_range'|'above_range';
/** Geometric V4 range semantics: lower inclusive, upper exclusive. */
export function classifyV4RangeState(currentTick:number,tickLower:number,tickUpper:number):V4RangeState{
 if(!Number.isInteger(currentTick)||!Number.isInteger(tickLower)||!Number.isInteger(tickUpper)||tickLower>=tickUpper)throw new Error('V4_RANGE_STATE_INVALID');
 return currentTick<tickLower?'below_range':currentTick>=tickUpper?'above_range':'in_range';
}
export async function inspectV4PositionState(rpc:FallbackRpc,tokenId:bigint){
 const position=await inspectV4Position(rpc,tokenId),id=poolId(position.key),{blockNumber,snapshot}=await rpc.withClient(async client=>{const blockNumber=await client.getBlockNumber({cacheTime:0}),snapshot=await client.multicall({multicallAddress:getAddress('0xca11bde05977b3631167028862be2a173976ca11'),allowFailure:true,blockNumber,contracts:[
  {address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:stateViewAbi,functionName:'getSlot0',args:[id]},
  {address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:stateViewAbi,functionName:'getLiquidity',args:[id]},
  {address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:stateViewAbi,functionName:'getPositionInfo',args:[id,V4_ROBINHOOD_DEPLOYMENTS.positionManager,position.tickLower,position.tickUpper,toHex(tokenId,{size:32})]},
  {address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:stateViewAbi,functionName:'getFeeGrowthInside',args:[id,position.tickLower,position.tickUpper]},
 ]});return {blockNumber,snapshot};},{stage:'v4_position_state_snapshot',method:'eth_blockNumber+Multicall3.aggregate3:pinned pool+position+fee'});
 if(snapshot.length!==4||snapshot.some(value=>value.status!=='success'))throw new Error('V4_POSITION_STATE_SNAPSHOT_PARTIAL_OR_MALFORMED');
 const slot=snapshot[0]!.result,activeLiquidity=snapshot[1]!.result,stored=snapshot[2]!.result,growth=snapshot[3]!.result;
 if(!Array.isArray(slot)||slot.length!==4||typeof slot[0]!=='bigint'||typeof slot[1]!=='number'||typeof slot[2]!=='number'||typeof slot[3]!=='number'||typeof activeLiquidity!=='bigint'||!Array.isArray(stored)||stored.length!==3||!Array.isArray(growth)||growth.length!==2||![...stored,...growth].every(value=>typeof value==='bigint')||slot[0]===0n)throw new Error('V4_POSITION_STATE_SNAPSHOT_PARTIAL_OR_MALFORMED');
 if(stored[0]!==position.liquidity)throw new Error('V4_POSITION_STATE_SNAPSHOT_LIQUIDITY_MISMATCH');
 const pool:V4PoolState={id,key:position.key,sqrtPriceX96:slot[0],tick:slot[1],liquidity:activeLiquidity,initialized:true,blockNumber,protocolFee:slot[2],lpFee:slot[3],feeSemantics:decodeV4Fee(position.key.fee,slot[3],slot[2]),hookSemantics:classifyV4Hooks(position.key.hooks)};
 const [token0,token1]=await Promise.all([inspectErc20(rpc,position.key.currency0),inspectErc20(rpc,position.key.currency1)]);
 if(token0.status==='unavailable'||token1.status==='unavailable')throw new Error('V4_POSITION_TOKEN_METADATA_UNAVAILABLE');
 const amounts=amountsForLiquidity(pool.sqrtPriceX96,position.tickLower,position.tickUpper,position.liquidity);
 const rangeState=classifyV4RangeState(pool.tick,position.tickLower,position.tickUpper);
 const price1Per0=priceFromSqrtX96(pool.sqrtPriceX96,token0.value.decimals,token1.value.decimals),stableIndex=position.key.currency0.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()?0:position.key.currency1.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()?1:null,spotExecutable=pool.liquidity>0n;
 const currentUsdValue=stableIndex===null?null:!spotExecutable?(stableIndex===0&&amounts.token1===0n?Number(amounts.token0)/10**token0.value.decimals:stableIndex===1&&amounts.token0===0n?Number(amounts.token1)/10**token1.value.decimals:null):stableIndex===0?Number(amounts.token0)/10**token0.value.decimals+Number(amounts.token1)/10**token1.value.decimals/price1Per0:Number(amounts.token0)/10**token0.value.decimals*price1Per0+Number(amounts.token1)/10**token1.value.decimals;
 const valuation=currentUsdValue===null
  ?{status:'USD_PNL_UNAVAILABLE' as const,source:'StateView token-denominated amounts',reason:'position has no direct verified USDG valuation'}
  :{status:'available' as const,source:'StateView direct USDG pool',valueUsd:currentUsdValue};
 const mod=2n**256n,q128=2n**128n,delta0=(growth[0]-stored[1]+mod)%mod,delta1=(growth[1]-stored[2]+mod)%mod;
 const claimableFees={status:'available' as const,token0:position.liquidity*delta0/q128,token1:position.liquidity*delta1/q128,feeGrowthInside0X128:growth[0],feeGrowthInside1X128:growth[1],feeGrowthInside0LastX128:stored[1],feeGrowthInside1LastX128:stored[2]};
 return {...position,pool,token0:token0.value,token1:token1.value,currentAmounts:amounts,rangeState,price1Per0,currentUsdValue,valuation,claimableFees};
}
const MULTICALL3=getAddress('0xca11bde05977b3631167028862be2a173976ca11');
export type V4ClaimableFeeBatchPosition={tokenId:bigint;key:V4PoolKey;tickLower:number;tickUpper:number;liquidity:bigint};
function sameV4PoolKey(a:V4PoolKey,b:V4PoolKey){return a.currency0.toLowerCase()===b.currency0.toLowerCase()&&a.currency1.toLowerCase()===b.currency1.toLowerCase()&&a.fee===b.fee&&a.tickSpacing===b.tickSpacing&&a.hooks.toLowerCase()===b.hooks.toLowerCase();}
/** One bounded Multicall3 eth_call returning pool, PositionManager identity,
 * and StateView fee-growth evidence from one block for five persisted NFTs. */
export async function inspectV4ClaimableFeesBatch(rpc:FallbackRpc,positions:readonly V4ClaimableFeeBatchPosition[]){
 if(positions.length!==5||new Set(positions.map(position=>position.tokenId.toString())).size!==5)throw new Error('V4_FEE_BATCH_REQUIRES_FIVE_UNIQUE_POSITIONS');
 for(const position of positions)if(position.tokenId<0n||position.liquidity<0n||!Number.isInteger(position.tickLower)||!Number.isInteger(position.tickUpper)||position.tickLower>=position.tickUpper)throw new Error('V4_FEE_BATCH_POSITION_INVALID');
 const key=positions[0]!.key,id=poolId(key);
 if(positions.some(position=>poolId(position.key)!==id))throw new Error('V4_FEE_BATCH_POOL_MISMATCH');
 const contracts=[
  {address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:stateViewAbi,functionName:'getSlot0' as const,args:[id]},
  {address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:stateViewAbi,functionName:'getLiquidity' as const,args:[id]},
  ...positions.flatMap(position=>[
   {address:V4_ROBINHOOD_DEPLOYMENTS.positionManager,abi:positionManagerAbi,functionName:'getPoolAndPositionInfo' as const,args:[position.tokenId]},
   {address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:stateViewAbi,functionName:'getPositionInfo' as const,args:[id,V4_ROBINHOOD_DEPLOYMENTS.positionManager,position.tickLower,position.tickUpper,toHex(position.tokenId,{size:32})]},
   {address:V4_ROBINHOOD_DEPLOYMENTS.stateView,abi:stateViewAbi,functionName:'getFeeGrowthInside' as const,args:[id,position.tickLower,position.tickUpper]},
  ]),
 ];
 const startedAtMs=Date.now(),{blockNumber,results}=await rpc.withClient(async client=>{const blockNumber=await client.getBlockNumber({cacheTime:0}),results=await client.multicall({multicallAddress:MULTICALL3,allowFailure:true,blockNumber,contracts} as never);return {blockNumber,results};},{stage:'v4_bid_ladder_fee_batch',method:'eth_blockNumber+Multicall3.aggregate3:pinned pool+position+fee snapshot'}),latencyMs=Date.now()-startedAtMs;
 const values=results as readonly {status:string;result?:unknown}[];
 if(values.length!==17||values.some(value=>value?.status!=='success'))throw new Error('V4_FEE_BATCH_PARTIAL_OR_MALFORMED');
 const slot=values[0]!.result,activeLiquidity=values[1]!.result;
 if(!Array.isArray(slot)||slot.length!==4||typeof slot[0]!=='bigint'||typeof slot[1]!=='number'||typeof slot[2]!=='number'||typeof slot[3]!=='number'||typeof activeLiquidity!=='bigint'||slot[0]===0n)throw new Error('V4_FEE_BATCH_PARTIAL_OR_MALFORMED');
 const mod=2n**256n,q128=2n**128n,perPosition=positions.map((position,index)=>{
  const authoritative=values[2+index*3]!.result,stored=values[3+index*3]!.result,growth=values[4+index*3]!.result;
  if(!Array.isArray(authoritative)||authoritative.length!==2||typeof authoritative[0]!=='object'||authoritative[0]===null||typeof authoritative[1]!=='bigint')throw new Error('V4_FEE_BATCH_PARTIAL_OR_MALFORMED');
  const authoritativeKey=authoritative[0] as V4PoolKey,decoded=decodePositionInfo(authoritative[1]);
  if(!sameV4PoolKey(authoritativeKey,key)||decoded.tickLower!==position.tickLower||decoded.tickUpper!==position.tickUpper)throw new Error('V4_FEE_BATCH_POSITION_ASSOCIATION_MISMATCH');
  if(!Array.isArray(stored)||stored.length!==3||!Array.isArray(growth)||growth.length!==2||![...stored,...growth].every(value=>typeof value==='bigint'))throw new Error('V4_FEE_BATCH_PARTIAL_OR_MALFORMED');
  const [onchainLiquidity,last0,last1]=stored as [bigint,bigint,bigint],[growth0,growth1]=growth as [bigint,bigint];
  if(onchainLiquidity!==position.liquidity)throw new Error('V4_FEE_BATCH_LIQUIDITY_MISMATCH');
  return {tokenId:position.tokenId,token0:position.liquidity*((growth0-last0+mod)%mod)/q128,token1:position.liquidity*((growth1-last1+mod)%mod)/q128};
 });
 const pool:V4PoolState={id,key,sqrtPriceX96:slot[0],tick:slot[1],liquidity:activeLiquidity,initialized:true,blockNumber,protocolFee:slot[2],lpFee:slot[3],feeSemantics:decodeV4Fee(key.fee,slot[3],slot[2]),hookSemantics:classifyV4Hooks(key.hooks)};
 return {positions:perPosition,token0:perPosition.reduce((sum,value)=>sum+value.token0,0n),token1:perPosition.reduce((sum,value)=>sum+value.token1,0n),pool,rpcRoundTrips:2 as const,latencyMs};
}
export function parseCurrencyTransfers(logs:readonly {address:Address;data:Hex;topics:readonly Hex[]}[],recipient:Address,key:V4PoolKey){const result={token0:0n,token1:0n},transfer=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');for(const log of logs){const index=log.address.toLowerCase()===key.currency0.toLowerCase()?0:log.address.toLowerCase()===key.currency1.toLowerCase()?1:-1;if(index<0)continue;try{const event=decodeEventLog({abi:[transfer],data:log.data,topics:log.topics as [Hex,...Hex[]]});if(event.eventName==='Transfer'&&event.args.to.toLowerCase()===recipient.toLowerCase()){if(index===0)result.token0+=event.args.value;else result.token1+=event.args.value;}}catch{}}return result;}

const universalRouterAbi=[{type:'function',name:'execute',stateMutability:'payable',inputs:[{type:'bytes'},{type:'bytes[]'},{type:'uint256'}],outputs:[]}] as const;
const exactInputSingleType={type:'tuple',components:[poolKeyParam,{type:'bool'},{type:'uint128'},{type:'uint128'},{type:'uint256'},{type:'bytes'}]} as const;
const v4QuoterAbi=[{type:'function',name:'quoteExactInputSingle',stateMutability:'nonpayable',inputs:[{type:'tuple',components:[{...poolKeyParam,name:'poolKey'},{type:'bool',name:'zeroForOne'},{type:'uint128',name:'exactAmount'},{type:'bytes',name:'hookData'}]}],outputs:[{type:'uint256',name:'amountOut'},{type:'uint256',name:'gasEstimate'}]}] as const;
export async function quoteV4ExactInputSingle(rpc:FallbackRpc,input:{key:V4PoolKey;zeroForOne:boolean;amountIn:bigint;account?:Address}){
 if(input.amountIn<=0n)throw new Error('V4_QUOTE_AMOUNT_INVALID');
 const tokenIn=input.zeroForOne?input.key.currency0:input.key.currency1,tokenOut=input.zeroForOne?input.key.currency1:input.key.currency0;
 return rpc.withClient(async client=>{const simulation=await client.simulateContract({account:input.account,address:V4_ROBINHOOD_DEPLOYMENTS.quoter,abi:v4QuoterAbi,functionName:'quoteExactInputSingle',args:[{poolKey:input.key,zeroForOne:input.zeroForOne,exactAmount:input.amountIn,hookData:'0x'}]});const [amountOut,gasEstimate]=simulation.result;if(amountOut<=0n)throw new Error('V4_QUOTE_OUTPUT_ZERO');return {amountOut,gasEstimate,tokenIn,tokenOut,amountIn:input.amountIn};},{stage:'quote_preflight',method:'V4Quoter.quoteExactInputSingle'});
}
export function buildV4ExactInputSingle(input:{key:V4PoolKey;zeroForOne:boolean;amountIn:bigint;amountOutMinimum:bigint;deadline:bigint}){if(input.amountIn<=0n||input.amountOutMinimum<0n)throw new Error('V4_SWAP_AMOUNT_INVALID');const actions='0x060c0f' as Hex,params=[encodeAbiParameters([exactInputSingleType],[[input.key,input.zeroForOne,input.amountIn,input.amountOutMinimum,0n,'0x']]),encodeAbiParameters([{type:'address'},{type:'uint256'}],[input.zeroForOne?input.key.currency0:input.key.currency1,input.amountIn]),encodeAbiParameters([{type:'address'},{type:'uint256'}],[input.zeroForOne?input.key.currency1:input.key.currency0,input.amountOutMinimum])] as const,routerInput=encodeAbiParameters([{type:'bytes'},{type:'bytes[]'}],[actions,params]),calldata=encodeFunctionData({abi:universalRouterAbi,functionName:'execute',args:['0x10',[routerInput],input.deadline]});return {to:V4_ROBINHOOD_DEPLOYMENTS.universalRouter,data:calldata,value:0n,actions,params,calldataHash:keccak256(calldata)};}

export * from './batch.js';
