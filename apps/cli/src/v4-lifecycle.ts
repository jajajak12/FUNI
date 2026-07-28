import { type Address, type Hash, type WalletClient } from 'viem';
import { FallbackRpc, sanitizeRpcError } from '@robin/core';
import { SqliteLedgerRepository } from '@robin/ledger';
import {
  amountsForLiquidity, buildV4Burn, buildV4Collect, buildV4Decrease,
  classifyV4Hooks, decodeV4Fee, inspectV4PositionState, parseCurrencyTransfers, slippageMinimums,
  V4_ROBINHOOD_DEPLOYMENTS,
} from '@robin/v4';

export type V4LifecycleAction = 'collect'|'partial_close'|'full_close'|'burn';
export type V4LifecycleHooks = { beforeReceiptWait?: (context:{intentId:string;action:V4LifecycleAction;hash:Hash})=>void|Promise<void> };
export type V4LifecycleGasPolicy = {
  beforeSigning(context:{intentId:string;action:V4LifecycleAction;estimatedGas:bigint;gasPrice:bigint}):void|Promise<void>;
  afterConfirmation(context:{intentId:string;action:V4LifecycleAction;hash:Hash;gasUsed:bigint;effectiveGasPrice:bigint}):void|Promise<void>;
};
export type V4LifecycleInput = {
  repo:SqliteLedgerRepository; rpc:FallbackRpc; walletClient:WalletClient; wallet:Address;
  tokenId:bigint; action:V4LifecycleAction; percent?:25|50|75; slippageBps:number;
  deadlineSeconds:number; idempotencyKey:string; hooks?:V4LifecycleHooks; receiptTimeoutMs?:number;
  allowPublicWrites?:boolean; gasPolicy?:V4LifecycleGasPolicy;
  preflightState?:Awaited<ReturnType<typeof inspectV4PositionState>>;
  transactionSender?:(context:{intentId:string;action:V4LifecycleAction;to:Address;data:`0x${string}`;estimatedGas:bigint})=>Promise<Hash>;
};
export class V4ReceiptWaitInterrupted extends Error {
  constructor(){super('deterministic v4 receipt interruption');this.name='V4ReceiptWaitInterrupted';}
}
type PersistedPreparation={
  key:{currency0:Address;currency1:Address;fee:number;tickSpacing:number;hooks:Address};
  tickLower:number;tickUpper:number;price1Per0:number;removedLiquidity:string;
  principal:{token0:string;token1:string};calldataHash:string;
};
function savedPreparation(row:Record<string,unknown>):PersistedPreparation|undefined{
  try{return (JSON.parse(String(row.payload_json)) as {prepared?:PersistedPreparation}).prepared;}catch{return undefined;}
}
function persistPreparation(repo:SqliteLedgerRepository,intentId:string,row:Record<string,unknown>,prepared:Awaited<ReturnType<typeof prepareV4Lifecycle>>){
  const base=JSON.parse(String(row.payload_json)) as Record<string,unknown>;
  const snapshot:PersistedPreparation={key:prepared.state.key,tickLower:prepared.state.tickLower,tickUpper:prepared.state.tickUpper,price1Per0:prepared.state.price1Per0,removedLiquidity:prepared.removedLiquidity.toString(),principal:{token0:prepared.principal.token0.toString(),token1:prepared.principal.token1.toString()},calldataHash:prepared.plan.calldataHash};
  repo.db.prepare('UPDATE v4_lifecycle_intents SET liquidity_raw=?,payload_json=?,updated_at=? WHERE id=?').run(snapshot.removedLiquidity,JSON.stringify({...base,prepared:snapshot}),new Date().toISOString(),intentId);
}
function loopback(value:string){try{const h=new URL(value).hostname;return h==='127.0.0.1'||h==='localhost'||h==='::1'||h==='[::1]';}catch{return false;}}
async function waitReceipt(client:any,hash:Hash,timeoutMs:number){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([
    client.waitForTransactionReceipt({hash,timeout:timeoutMs}),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`V4_RECEIPT_TIMEOUT_AFTER_${timeoutMs}MS`)),timeoutMs);}),
  ]);}finally{if(timer)clearTimeout(timer);}
}

export async function prepareV4Lifecycle(input:Pick<V4LifecycleInput,'rpc'|'wallet'|'tokenId'|'action'|'percent'|'slippageBps'|'deadlineSeconds'|'preflightState'>){
  const state=input.preflightState??await inspectV4PositionState(input.rpc,input.tokenId);
  if(state.owner.toLowerCase()!==input.wallet.toLowerCase())throw new Error('V4_POSITION_OWNER_MISMATCH');
  const fee=decodeV4Fee(state.key.fee,state.pool.lpFee,state.pool.protocolFee),hooks=classifyV4Hooks(state.key.hooks);
  if(fee.dynamicFee||!hooks.supported)throw new Error(`V4_LIFECYCLE_POOL_UNSUPPORTED:${[...fee.blockers,...hooks.blockers].join(',')}`);
  if(input.action!=='burn'&&state.liquidity<=0n)throw new Error('V4_POSITION_LIQUIDITY_ZERO');
  const block=await input.rpc.withClient(client=>client.getBlock(),{stage:'lifecycle_preflight',method:'eth_getBlockByNumber'}),deadline=block.timestamp+BigInt(input.deadlineSeconds);
  if(input.action==='collect')return {state,removedLiquidity:0n,principal:{token0:0n,token1:0n},plan:buildV4Collect({tokenId:input.tokenId,recipient:input.wallet,hookData:'0x',key:state.key,deadline})};
  if(input.action==='burn'){
    if(state.liquidity!==0n)throw new Error('V4_BURN_POSITION_NOT_EMPTY');
    return {state,removedLiquidity:0n,principal:{token0:0n,token1:0n},plan:buildV4Burn({tokenId:input.tokenId,amount0Min:0n,amount1Min:0n,recipient:input.wallet,hookData:'0x',key:state.key,deadline})};
  }
  const removedLiquidity=input.action==='full_close'?state.liquidity:state.liquidity*BigInt(input.percent??50)/100n;
  if(removedLiquidity<=0n||removedLiquidity>state.liquidity)throw new Error('V4_CLOSE_LIQUIDITY_INVALID');
  const principal=amountsForLiquidity(state.pool.sqrtPriceX96,state.tickLower,state.tickUpper,removedLiquidity),mins=slippageMinimums(principal,input.slippageBps);
  return {state,removedLiquidity,principal,plan:buildV4Decrease({tokenId:input.tokenId,liquidity:removedLiquidity,...mins,recipient:input.wallet,hookData:'0x',key:state.key,deadline})};
}

export async function executeV4Lifecycle(input:V4LifecycleInput):Promise<any>{
  if(input.rpc.config.rpcUrls.some(url=>!loopback(url))&&!input.allowPublicWrites)throw new Error('V4_LIFECYCLE_PUBLIC_RPC_WRITES_DISABLED');
  const existing=input.repo.createV4LifecycleIntent({tokenId:input.tokenId,action:input.action,idempotencyKey:input.idempotencyKey,payload:{percent:input.percent,slippageBps:input.slippageBps}}),intentId=String(existing.id),row=input.repo.v4LifecycleIntent(intentId)!;
  if(row.state==='RECONCILED'||row.state==='BURNED')return {ok:true as const,status:'ALREADY_COMPLETED' as const,intentId,hash:row.tx_hash as Hash};
  if(row.state==='FAILED')return {ok:false as const,status:'TERMINAL' as const,intentId,reason:String(row.failure_reason)};
  if(row.state==='PREVIEWED'&&!input.repo.claimV4LifecycleIntent(intentId))return {ok:false as const,status:'ALREADY_PROCESSING' as const,intentId};
  if(row.state!=='PREVIEWED'&&row.state!=='SUBMITTED')return {ok:false as const,status:'ALREADY_PROCESSING' as const,intentId};
  try{
    let hash=input.repo.v4LifecycleIntent(intentId)?.tx_hash as Hash|undefined;
    const currentRow=input.repo.v4LifecycleIntent(intentId)!;
    const persisted=hash?savedPreparation(currentRow):undefined;
    if(hash&&!persisted)throw new Error('V4_RECOVERY_PREPARATION_MISSING');
    const prepared=hash?{
      state:{key:persisted!.key,tickLower:persisted!.tickLower,tickUpper:persisted!.tickUpper,price1Per0:persisted!.price1Per0},
      removedLiquidity:BigInt(persisted!.removedLiquidity),
      principal:{token0:BigInt(persisted!.principal.token0),token1:BigInt(persisted!.principal.token1)},
      plan:undefined,
    }:await prepareV4Lifecycle(input);
    if(!hash){
      const lifecyclePlan=prepared.plan!;
      const {gas,gasPrice}=await input.rpc.withClient(async client=>({gas:await client.estimateGas({account:input.wallet,to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,data:lifecyclePlan.calldata,value:0n}),gasPrice:await client.getGasPrice()}),{stage:'lifecycle_preflight',method:'eth_estimateGas+eth_gasPrice'});
      await input.gasPolicy?.beforeSigning({intentId,action:input.action,estimatedGas:gas,gasPrice});
      persistPreparation(input.repo,intentId,currentRow,prepared as Awaited<ReturnType<typeof prepareV4Lifecycle>>);
      input.repo.transitionV4LifecycleIntent(intentId,'SIMULATION_PASSED',{details:{gas,calldataHash:lifecyclePlan.calldataHash,removedLiquidity:prepared.removedLiquidity,principal:prepared.principal}});
      hash=input.transactionSender?await input.transactionSender({intentId,action:input.action,to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,data:lifecyclePlan.calldata,estimatedGas:gas}):await (input.walletClient as any).sendTransaction({to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,data:lifecyclePlan.calldata,value:0n,gas:gas*12n/10n}) as Hash;
      input.repo.transitionV4LifecycleIntent(intentId,'SUBMITTED',{txHash:hash,details:{calldataHash:lifecyclePlan.calldataHash}});
    }
    await input.hooks?.beforeReceiptWait?.({intentId,action:input.action,hash});
    const receipt:any=await input.rpc.withClient(client=>waitReceipt(client,hash!,input.receiptTimeoutMs??60_000),{stage:'receipt_recovery',method:'eth_getTransactionReceipt'});
    input.repo.persistV4LifecycleReceipt(hash,intentId,receipt);
    if(receipt.status!=='success')throw new Error('V4_LIFECYCLE_TRANSACTION_REVERTED');
    await input.gasPolicy?.afterConfirmation({intentId,action:input.action,hash,gasUsed:BigInt(receipt.gasUsed),effectiveGasPrice:BigInt(receipt.effectiveGasPrice)});
    input.repo.transitionV4LifecycleIntent(intentId,'CONFIRMED',{details:{blockNumber:receipt.blockNumber,gasUsed:receipt.gasUsed}});
    const positionId=`v4:${input.tokenId}`,transfers=parseCurrencyTransfers(receipt.logs,input.wallet,prepared.state.key);
    if(input.action==='partial_close'||input.action==='full_close')input.repo.ingestLiquidityChange({id:`v4:${hash}:decrease`,positionId,txHash:hash,logIndex:0,kind:'decrease',amounts:prepared.principal});
    input.repo.ingestCollection({id:`v4:${hash}:collect`,positionId,txHash:hash,logIndex:1,amounts:transfers,pending:input.repo.positionAccounting(positionId).pendingPrincipal});
    const gasNative=BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice);
    input.repo.ingestGas(positionId,hash,gasNative);
    if(input.action==='burn'){
      input.repo.updateV4Position({tokenId:input.tokenId,liquidity:0n,status:'burned'});
      input.repo.transitionV4LifecycleIntent(intentId,'BURNED',{details:{transfers}});
      return {ok:true as const,status:'COMPLETED' as const,intentId,hash,transfers,remainingLiquidity:0n};
    }
    const refreshed=await inspectV4PositionState(input.rpc,input.tokenId),totals=input.repo.collectionTotals(positionId),current=input.repo.v4Position(input.tokenId)!;
    const status=refreshed.liquidity===0n?'closed':input.action==='partial_close'?'partially_closed':String(current.status);
    input.repo.db.prepare('UPDATE v4_positions SET liquidity_raw=?,status=?,claimed_fee0_raw=?,claimed_fee1_raw=?,withdrawn_principal0_raw=?,withdrawn_principal1_raw=?,updated_at=? WHERE token_id=?').run(refreshed.liquidity.toString(),status,totals.fees.token0.toString(),totals.fees.token1.toString(),totals.principal.token0.toString(),totals.principal.token1.toString(),new Date().toISOString(),input.tokenId.toString());
    input.repo.transitionV4LifecycleIntent(intentId,'RECONCILED',{details:{transfers,remainingLiquidity:refreshed.liquidity}});
    return {ok:true as const,status:'COMPLETED' as const,intentId,hash,transfers,remainingLiquidity:refreshed.liquidity,principal:prepared.principal};
  }catch(error){
    if(error instanceof V4ReceiptWaitInterrupted||String(error).includes('V4_RECEIPT_TIMEOUT'))return {ok:false as const,status:'RECOVERY_REQUIRED' as const,intentId,hash:input.repo.v4LifecycleIntent(intentId)?.tx_hash as Hash};
    const durable=input.repo.v4LifecycleIntent(intentId),durableHash=durable?.tx_hash as Hash|undefined,hasReceipt=durableHash?Boolean(input.repo.db.prepare('SELECT 1 FROM v4_lifecycle_receipts WHERE intent_id=? AND tx_hash=? LIMIT 1').get(intentId,durableHash)):false;
    if(durableHash&&!hasReceipt)return {ok:false as const,status:'RECOVERY_REQUIRED' as const,intentId,hash:durableHash};
    const reason=sanitizeRpcError(error,{stage:`v4_lifecycle_${input.action}`,method:'lifecycle_execution'});input.repo.transitionV4LifecycleIntent(intentId,'FAILED',{failureReason:reason});return {ok:false as const,status:'FAILED' as const,intentId,reason};
  }
}
export function recoverV4Lifecycle(input:V4LifecycleInput):Promise<any>{return executeV4Lifecycle({...input,hooks:undefined});}
