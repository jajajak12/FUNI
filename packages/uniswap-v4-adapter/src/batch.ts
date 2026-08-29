import { decodeAbiParameters, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, parseAbiItem, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { V4_ACTIONS, V4_MAX_EXECUTION_STATIC_FEE_PIPS, V4_ROBINHOOD_DEPLOYMENTS, buildV4Mint, classifyV4Hooks, decodeV4Fee, poolId, positionManagerAbi, type V4PoolKey } from './index.js';

const poolKeyParam={type:'tuple',components:[{type:'address',name:'currency0'},{type:'address',name:'currency1'},{type:'uint24',name:'fee'},{type:'int24',name:'tickSpacing'},{type:'address',name:'hooks'}]} as const;
const mintParamTypes=[poolKeyParam,{type:'int24'},{type:'int24'},{type:'uint256'},{type:'uint128'},{type:'uint128'},{type:'address'},{type:'bytes'}] as const;
const pairParamTypes=[{type:'address'},{type:'address'}] as const;
const decreaseParamTypes=[{type:'uint256'},{type:'uint256'},{type:'uint128'},{type:'uint128'},{type:'bytes'}] as const;
const takePairParamTypes=[{type:'address'},{type:'address'},{type:'address'}] as const;
const transferEvent=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed id)');
const erc20TransferEvent=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const modifyLiquidityEvent=parseAbiItem('event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)');

export type V4BatchMintLeg={key:V4PoolKey;tickLower:number;tickUpper:number;liquidity:bigint;amount0Max:bigint;amount1Max:bigint;owner:Address;hookData:Hex;fundingIndex?:0|1};
export type V4BatchMintPlan={kind:'batch_mint';legs:readonly V4BatchMintLeg[];deadline:bigint;actions:Hex;params:readonly Hex[];unlockData:Hex;calldata:Hex;calldataHash:Hex};
export type V4BatchFullDecreaseLeg={key:V4PoolKey;tokenId:bigint;liquidity:bigint;amount0Min:bigint;amount1Min:bigint;hookData:Hex};
export type V4BatchFullDecreasePlan={kind:'batch_full_decrease';legs:readonly V4BatchFullDecreaseLeg[];recipient:Address;deadline:bigint;actions:Hex;params:readonly Hex[];unlockData:Hex;calldata:Hex;calldataHash:Hex};
export type V4BatchCollectLeg={key:V4PoolKey;tokenId:bigint;hookData:Hex};
export type V4BatchCollectPlan={kind:'batch_collect';legs:readonly V4BatchCollectLeg[];recipient:Address;deadline:bigint;actions:Hex;params:readonly Hex[];unlockData:Hex;calldata:Hex;calldataHash:Hex};

const sameAddress=(a:Address,b:Address)=>a.toLowerCase()===b.toLowerCase();
const sameKey=(a:V4PoolKey,b:V4PoolKey)=>sameAddress(a.currency0,b.currency0)&&sameAddress(a.currency1,b.currency1)&&a.fee===b.fee&&a.tickSpacing===b.tickSpacing&&sameAddress(a.hooks,b.hooks);
const actionHex=(actions:readonly number[])=>`0x${actions.map(action=>action.toString(16).padStart(2,'0')).join('')}` as Hex;
function actionBytes(actions:Hex){if((actions.length-2)%2!==0)throw new Error('V4_BATCH_ACTIONS_MALFORMED');const values:number[]=[];for(let offset=2;offset<actions.length;offset+=2)values.push(Number.parseInt(actions.slice(offset,offset+2),16));return values;}
function decodeModifyLiquidities(calldata:Hex){const call=decodeFunctionData({abi:positionManagerAbi,data:calldata});if(call.functionName!=='modifyLiquidities')throw new Error('NOT_MODIFY_LIQUIDITIES');const [unlockData,deadline]=call.args,[actions,params]=decodeAbiParameters([{type:'bytes'},{type:'bytes[]'}],unlockData),bytes=actionBytes(actions);if(bytes.length!==params.length)throw new Error('V4_BATCH_ACTION_PARAM_LENGTH_MISMATCH');return {deadline,actions,params,bytes};}
function assertSupportedKey(key:V4PoolKey){poolId(key);const fee=decodeV4Fee(key.fee),hooks=classifyV4Hooks(key.hooks);if(!hooks.supported||fee.blockers.length||(fee.staticFeePips??0)>V4_MAX_EXECUTION_STATIC_FEE_PIPS)throw new Error('V4_BATCH_POOL_UNSUPPORTED');}
function assertCompatibleKeys<T extends {key:V4PoolKey}>(legs:readonly T[]){if(!legs.length)throw new Error('V4_BATCH_LEGS_REQUIRED');const key=legs[0]!.key;assertSupportedKey(key);for(const leg of legs){assertSupportedKey(leg.key);if(!sameKey(key,leg.key))throw new Error('V4_BATCH_POOL_KEY_MISMATCH');}return key;}

/** Generic N-leg PositionManager batch. V4 BID Ladder V1 supplies exactly five legs. */
export function buildV4BatchMint(input:{legs:readonly V4BatchMintLeg[];deadline:bigint}):V4BatchMintPlan{
 const key=assertCompatibleKeys(input.legs),fundingIndex=input.legs[0]!.fundingIndex??(input.legs[0]!.amount0Max>0n?0:1);
 const params=input.legs.map(leg=>{const validated=buildV4Mint({...leg,deadline:input.deadline});if(validated.fundingIndex!==fundingIndex)throw new Error('V4_BATCH_FUNDING_ORIENTATION_MISMATCH');return encodeAbiParameters(mintParamTypes,[leg.key,leg.tickLower,leg.tickUpper,leg.liquidity,leg.amount0Max,leg.amount1Max,leg.owner,leg.hookData]);});
 const actions=actionHex([...input.legs.map(()=>V4_ACTIONS.MINT_POSITION),V4_ACTIONS.SETTLE_PAIR]),allParams=[...params,encodeAbiParameters(pairParamTypes,[key.currency0,key.currency1])] as readonly Hex[],unlockData=encodeAbiParameters([{type:'bytes'},{type:'bytes[]'}],[actions,allParams]),calldata=encodeFunctionData({abi:positionManagerAbi,functionName:'modifyLiquidities',args:[unlockData,input.deadline]});
 return {kind:'batch_mint',legs:[...input.legs],deadline:input.deadline,actions,params:allParams,unlockData,calldata,calldataHash:keccak256(calldata)};
}

export function decodeV4BatchMint(calldata:Hex){
 const decoded=decodeModifyLiquidities(calldata);if(decoded.bytes.length<2||decoded.bytes.at(-1)!==V4_ACTIONS.SETTLE_PAIR||decoded.bytes.slice(0,-1).some(action=>action!==V4_ACTIONS.MINT_POSITION))throw new Error('INVALID_V4_BATCH_MINT_ACTIONS');
 const legs=decoded.params.slice(0,-1).map(param=>{const mint=decodeAbiParameters(mintParamTypes,param);return {key:mint[0],tickLower:mint[1],tickUpper:mint[2],liquidity:mint[3],amount0Max:mint[4],amount1Max:mint[5],owner:mint[6],hookData:mint[7],fundingIndex:(mint[4]>0n?0:1) as 0|1};});
 const key=assertCompatibleKeys(legs),fundingIndex=legs[0]!.fundingIndex;if(legs.some(leg=>(leg.amount0Max===0n)===(leg.amount1Max===0n)||leg.liquidity<=0n||leg.fundingIndex!==fundingIndex))throw new Error('V4_BATCH_MINT_LEG_INVALID');const settle=decodeAbiParameters(pairParamTypes,decoded.params.at(-1)!);if(!sameAddress(settle[0],key.currency0)||!sameAddress(settle[1],key.currency1))throw new Error('V4_BATCH_SETTLE_PAIR_MISMATCH');
 return {...decoded,legs,settle};
}

/** Full-decrease only: no BURN_POSITION, swap, fee cleanup, or router call. */
export function buildV4BatchFullDecrease(input:{legs:readonly V4BatchFullDecreaseLeg[];recipient:Address;deadline:bigint}):V4BatchFullDecreasePlan{
 const key=assertCompatibleKeys(input.legs),seen=new Set<string>(),params=input.legs.map(leg=>{if(leg.tokenId<0n||leg.liquidity<=0n||leg.amount0Min<0n||leg.amount1Min<0n)throw new Error('V4_BATCH_DECREASE_LEG_INVALID');const id=leg.tokenId.toString();if(seen.has(id))throw new Error('V4_BATCH_DECREASE_TOKEN_ID_DUPLICATE');seen.add(id);return encodeAbiParameters(decreaseParamTypes,[leg.tokenId,leg.liquidity,leg.amount0Min,leg.amount1Min,leg.hookData]);});
 const actions=actionHex([...input.legs.map(()=>V4_ACTIONS.DECREASE_LIQUIDITY),V4_ACTIONS.TAKE_PAIR]),allParams=[...params,encodeAbiParameters(takePairParamTypes,[key.currency0,key.currency1,input.recipient])] as readonly Hex[],unlockData=encodeAbiParameters([{type:'bytes'},{type:'bytes[]'}],[actions,allParams]),calldata=encodeFunctionData({abi:positionManagerAbi,functionName:'modifyLiquidities',args:[unlockData,input.deadline]});
 return {kind:'batch_full_decrease',legs:[...input.legs],recipient:input.recipient,deadline:input.deadline,actions,params:allParams,unlockData,calldata,calldataHash:keccak256(calldata)};
}

export function decodeV4BatchFullDecrease(calldata:Hex,expected?:{key?:V4PoolKey;recipient?:Address}){
 const decoded=decodeModifyLiquidities(calldata);if(decoded.bytes.length<2||decoded.bytes.at(-1)!==V4_ACTIONS.TAKE_PAIR||decoded.bytes.slice(0,-1).some(action=>action!==V4_ACTIONS.DECREASE_LIQUIDITY))throw new Error('INVALID_V4_BATCH_DECREASE_ACTIONS');
 const seen=new Set<string>(),legs=decoded.params.slice(0,-1).map(param=>{const value=decodeAbiParameters(decreaseParamTypes,param),id=value[0].toString();if(value[1]<=0n)throw new Error('V4_BATCH_DECREASE_LIQUIDITY_ZERO');if(seen.has(id))throw new Error('V4_BATCH_DECREASE_TOKEN_ID_DUPLICATE');seen.add(id);return {tokenId:value[0],liquidity:value[1],amount0Min:value[2],amount1Min:value[3],hookData:value[4]};}),take=decodeAbiParameters(takePairParamTypes,decoded.params.at(-1)!);
 if(expected?.key&&(!sameAddress(take[0],expected.key.currency0)||!sameAddress(take[1],expected.key.currency1)))throw new Error('V4_BATCH_TAKE_PAIR_MISMATCH');if(expected?.recipient&&!sameAddress(take[2],expected.recipient))throw new Error('V4_BATCH_TAKE_RECIPIENT_MISMATCH');return {...decoded,legs,take};
}

/** Canonical collect-only path: zero-liquidity DECREASE_LIQUIDITY plus one TAKE_PAIR. */
export function buildV4BatchCollect(input:{legs:readonly V4BatchCollectLeg[];recipient:Address;deadline:bigint}):V4BatchCollectPlan{
 const key=assertCompatibleKeys(input.legs),seen=new Set<string>(),params=input.legs.map(leg=>{if(leg.tokenId<0n)throw new Error('V4_BATCH_COLLECT_LEG_INVALID');const id=leg.tokenId.toString();if(seen.has(id))throw new Error('V4_BATCH_COLLECT_TOKEN_ID_DUPLICATE');seen.add(id);return encodeAbiParameters(decreaseParamTypes,[leg.tokenId,0n,0n,0n,leg.hookData]);});
 const actions=actionHex([...input.legs.map(()=>V4_ACTIONS.DECREASE_LIQUIDITY),V4_ACTIONS.TAKE_PAIR]),allParams=[...params,encodeAbiParameters(takePairParamTypes,[key.currency0,key.currency1,input.recipient])] as readonly Hex[],unlockData=encodeAbiParameters([{type:'bytes'},{type:'bytes[]'}],[actions,allParams]),calldata=encodeFunctionData({abi:positionManagerAbi,functionName:'modifyLiquidities',args:[unlockData,input.deadline]});
 return {kind:'batch_collect',legs:[...input.legs],recipient:input.recipient,deadline:input.deadline,actions,params:allParams,unlockData,calldata,calldataHash:keccak256(calldata)};
}

export function decodeV4BatchCollect(calldata:Hex,expected?:{key?:V4PoolKey;recipient?:Address}){
 const decoded=decodeModifyLiquidities(calldata);if(decoded.bytes.length<2||decoded.bytes.at(-1)!==V4_ACTIONS.TAKE_PAIR||decoded.bytes.slice(0,-1).some(action=>action!==V4_ACTIONS.DECREASE_LIQUIDITY))throw new Error('INVALID_V4_BATCH_COLLECT_ACTIONS');
 const seen=new Set<string>(),legs=decoded.params.slice(0,-1).map(param=>{const value=decodeAbiParameters(decreaseParamTypes,param),id=value[0].toString();if(value[1]!==0n||value[2]!==0n||value[3]!==0n)throw new Error('V4_BATCH_COLLECT_NONZERO_LIQUIDITY');if(seen.has(id))throw new Error('V4_BATCH_COLLECT_TOKEN_ID_DUPLICATE');seen.add(id);return {tokenId:value[0],liquidity:value[1],amount0Min:value[2],amount1Min:value[3],hookData:value[4]};}),take=decodeAbiParameters(takePairParamTypes,decoded.params.at(-1)!);
 if(expected?.key&&(!sameAddress(take[0],expected.key.currency0)||!sameAddress(take[1],expected.key.currency1)))throw new Error('V4_BATCH_TAKE_PAIR_MISMATCH');if(expected?.recipient&&!sameAddress(take[2],expected.recipient))throw new Error('V4_BATCH_TAKE_RECIPIENT_MISMATCH');return {...decoded,legs,take};
}

export type V4ReceiptLog={address:Address;data:Hex;topics:readonly Hex[];logIndex:number;transactionHash:Hex};
export type V4ConfirmedReceipt={status:'success';transactionHash:Hex;logs:readonly V4ReceiptLog[]};
export type V4PositionProof={tokenId:bigint;owner:Address;key:V4PoolKey;tickLower:number;tickUpper:number;liquidity:bigint};
export type V4ExpectedMintIdentity={key:V4PoolKey;tickLower:number;tickUpper:number;liquidity:bigint;owner:Address};
export type V4ExpectedCloseIdentity=V4PositionProof;

function orderedReceiptLogs(receipt:V4ConfirmedReceipt){if(receipt.status!=='success')throw new Error('V4_BATCH_RECEIPT_NOT_CONFIRMED');const seen=new Set<number>();for(const log of receipt.logs){if(log.transactionHash.toLowerCase()!==receipt.transactionHash.toLowerCase())throw new Error('V4_BATCH_RECEIPT_TRANSACTION_MISMATCH');if(!Number.isSafeInteger(log.logIndex)||log.logIndex<0||seen.has(log.logIndex))throw new Error('V4_BATCH_RECEIPT_LOG_ORDER_AMBIGUOUS');seen.add(log.logIndex);}return [...receipt.logs].sort((a,b)=>a.logIndex-b.logIndex);}
function assertPositionIdentity(actual:V4PositionProof,expected:V4ExpectedMintIdentity,tokenId:bigint){if(actual.tokenId!==tokenId||!sameAddress(actual.owner,expected.owner)||!sameKey(actual.key,expected.key)||actual.tickLower!==expected.tickLower||actual.tickUpper!==expected.tickUpper)throw new Error('V4_BATCH_POSITION_IDENTITY_MISMATCH');}

/** Returns no partial result: every mint event and every read-only position identity must prove first. */
export async function reconcileV4BatchMintReceipt(input:{receipt:V4ConfirmedReceipt;expectedLegs:readonly V4ExpectedMintIdentity[];inspectPosition:(tokenId:bigint)=>Promise<V4PositionProof>}){
 if(!input.expectedLegs.length)throw new Error('V4_BATCH_LEGS_REQUIRED');const logs=orderedReceiptLogs(input.receipt),mints:{tokenId:bigint;owner:Address;logIndex:number}[]=[];
 for(const log of logs){if(!sameAddress(log.address,V4_ROBINHOOD_DEPLOYMENTS.positionManager))continue;try{const event=decodeEventLog({abi:[transferEvent],data:log.data,topics:log.topics as [Hex,...Hex[]]});if(event.eventName==='Transfer'&&sameAddress(event.args.from,zeroAddress))mints.push({tokenId:event.args.id,owner:event.args.to,logIndex:log.logIndex});}catch{/* unrelated PositionManager log */}}
 if(mints.length!==input.expectedLegs.length)throw new Error('V4_BATCH_MINT_TRANSFER_COUNT_AMBIGUOUS');for(let index=0;index<mints.length;index++)if(!sameAddress(mints[index]!.owner,input.expectedLegs[index]!.owner))throw new Error('V4_BATCH_MINT_RECIPIENT_ORDER_MISMATCH');
 const proofs=await Promise.all(mints.map(mint=>input.inspectPosition(mint.tokenId)));return {status:'FULLY_RECONCILED' as const,transactionHash:input.receipt.transactionHash,bindings:proofs.map((proof,index)=>{const event=mints[index]!,expected=input.expectedLegs[index]!;assertPositionIdentity(proof,expected,event.tokenId);if(proof.liquidity!==expected.liquidity)throw new Error('V4_BATCH_MINT_LIQUIDITY_MISMATCH');return {legIndex:index,tokenId:event.tokenId,logIndex:event.logIndex,owner:proof.owner,key:proof.key,tickLower:proof.tickLower,tickUpper:proof.tickUpper,liquidity:proof.liquidity};})};
}

function aggregateTakePair(logs:readonly V4ReceiptLog[],recipient:Address,key:V4PoolKey){const values:{token0:bigint|null;token1:bigint|null}={token0:sameAddress(key.currency0,zeroAddress)?null:0n,token1:sameAddress(key.currency1,zeroAddress)?null:0n};for(const log of logs){const index=sameAddress(log.address,key.currency0)?0:sameAddress(log.address,key.currency1)?1:-1;if(index<0)continue;try{const event=decodeEventLog({abi:[erc20TransferEvent],data:log.data,topics:log.topics as [Hex,...Hex[]]});if(event.eventName==='Transfer'&&sameAddress(event.args.from,V4_ROBINHOOD_DEPLOYMENTS.poolManager)&&sameAddress(event.args.to,recipient)){if(index===0&&values.token0!==null)values.token0+=event.args.value;if(index===1&&values.token1!==null)values.token1+=event.args.value;}}catch{/* unrelated token log */}}return {...values,evidence:values.token0===null||values.token1===null?'NATIVE_VALUE_REQUIRES_BALANCE_OR_TRACE_EVIDENCE' as const:'POOL_MANAGER_ERC20_TRANSFERS' as const};}

/** Receipt + read-only state proof for manual full decrease. The NFT must remain owned and alive. */
export async function reconcileV4BatchFullDecreaseReceipt(input:{receipt:V4ConfirmedReceipt;expectedLegs:readonly V4ExpectedCloseIdentity[];recipient:Address;inspectPosition:(tokenId:bigint)=>Promise<V4PositionProof>}){
 if(!input.expectedLegs.length)throw new Error('V4_BATCH_LEGS_REQUIRED');const key=assertCompatibleKeys(input.expectedLegs),logs=orderedReceiptLogs(input.receipt),changes:{id:Hex;tickLower:number;tickUpper:number;liquidityDelta:bigint;salt:Hex;logIndex:number}[]=[];
 for(const log of logs){if(!sameAddress(log.address,V4_ROBINHOOD_DEPLOYMENTS.poolManager))continue;try{const event=decodeEventLog({abi:[modifyLiquidityEvent],data:log.data,topics:log.topics as [Hex,...Hex[]]});if(event.eventName==='ModifyLiquidity'&&sameAddress(event.args.sender,V4_ROBINHOOD_DEPLOYMENTS.positionManager))changes.push({...event.args,logIndex:log.logIndex});}catch{/* unrelated PoolManager log */}}
 if(changes.length!==input.expectedLegs.length)throw new Error('V4_BATCH_CLOSE_LIQUIDITY_EVENT_COUNT_AMBIGUOUS');for(let index=0;index<changes.length;index++){const event=changes[index]!,expected=input.expectedLegs[index]!;if(event.id.toLowerCase()!==poolId(expected.key).toLowerCase()||event.tickLower!==expected.tickLower||event.tickUpper!==expected.tickUpper||event.salt.toLowerCase()!==toHex(expected.tokenId,{size:32}).toLowerCase()||event.liquidityDelta!==-expected.liquidity)throw new Error('V4_BATCH_CLOSE_LIQUIDITY_EVENT_MISMATCH');}
 const burned=new Set<string>();for(const log of logs){if(!sameAddress(log.address,V4_ROBINHOOD_DEPLOYMENTS.positionManager))continue;try{const event=decodeEventLog({abi:[transferEvent],data:log.data,topics:log.topics as [Hex,...Hex[]]});if(event.eventName==='Transfer'&&sameAddress(event.args.to,zeroAddress))burned.add(event.args.id.toString());}catch{/* unrelated PositionManager log */}}if(input.expectedLegs.some(leg=>burned.has(leg.tokenId.toString())))throw new Error('V4_BATCH_CLOSE_NFT_BURN_DETECTED');
 const proofs=await Promise.all(input.expectedLegs.map(leg=>input.inspectPosition(leg.tokenId))),legs=proofs.map((proof,index)=>{const expected=input.expectedLegs[index]!,event=changes[index]!;assertPositionIdentity(proof,expected,expected.tokenId);if(proof.liquidity!==0n)throw new Error('V4_BATCH_CLOSE_NONZERO_ONCHAIN_LIQUIDITY');return {legIndex:index,tokenId:proof.tokenId,liquidityRemoved:-event.liquidityDelta,onchainLiquidity:proof.liquidity,nftExists:true,owner:proof.owner,logIndex:event.logIndex};});
 return {status:'FULLY_RECONCILED' as const,transactionHash:input.receipt.transactionHash,legs,aggregateTransfers:aggregateTakePair(logs,input.recipient,key),perLegAssetAttribution:'UNAVAILABLE_FROM_AGGREGATE_TAKE_PAIR' as const,nftBurned:false,swapInvoked:false};
}

/** Receipt + state proof for collect-only. Every NFT remains owned, alive, and at identical liquidity. */
export async function reconcileV4BatchCollectReceipt(input:{receipt:V4ConfirmedReceipt;expectedLegs:readonly V4ExpectedCloseIdentity[];recipient:Address;inspectPosition:(tokenId:bigint)=>Promise<V4PositionProof>}){
 if(input.expectedLegs.length!==5)throw new Error('V4_BATCH_COLLECT_REQUIRES_FIVE_LEGS');const key=assertCompatibleKeys(input.expectedLegs),logs=orderedReceiptLogs(input.receipt),burned=new Set<string>();
 for(const log of logs){if(!sameAddress(log.address,V4_ROBINHOOD_DEPLOYMENTS.positionManager))continue;try{const event=decodeEventLog({abi:[transferEvent],data:log.data,topics:log.topics as [Hex,...Hex[]]});if(event.eventName==='Transfer'&&sameAddress(event.args.to,zeroAddress))burned.add(event.args.id.toString());}catch{/* unrelated PositionManager log */}}
 if(input.expectedLegs.some(leg=>burned.has(leg.tokenId.toString())))throw new Error('V4_BATCH_COLLECT_NFT_BURN_DETECTED');
 const proofs=await Promise.all(input.expectedLegs.map(leg=>input.inspectPosition(leg.tokenId))),legs=proofs.map((proof,index)=>{const expected=input.expectedLegs[index]!;assertPositionIdentity(proof,expected,expected.tokenId);if(proof.liquidity!==expected.liquidity)throw new Error('V4_BATCH_COLLECT_LIQUIDITY_CHANGED');return {legIndex:index,tokenId:proof.tokenId,onchainLiquidity:proof.liquidity,nftExists:true,owner:proof.owner};});
 return {status:'FULLY_RECONCILED' as const,transactionHash:input.receipt.transactionHash,legs,aggregateTransfers:aggregateTakePair(logs,input.recipient,key),nftBurned:false,swapInvoked:false};
}
