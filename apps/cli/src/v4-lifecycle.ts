import { type Address, type Hash, type Hex, type TransactionReceipt, type WalletClient } from 'viem';
import { FallbackRpc, sanitizeRpcError } from '@funi/core';
import { SqliteLedgerRepository, sqliteTransientCode } from '@funi/ledger';
import {
  amountsForLiquidity, buildV4Burn, buildV4Collect, buildV4Decrease,
  classifyV4Hooks, decodeV4Fee, inspectV4PositionState, parseCurrencyTransfers, slippageMinimums,
  V4_ROBINHOOD_DEPLOYMENTS,
} from '@funi/v4';
import { broadcastDurableTransaction, type DurablePreparedTransaction } from './transaction-boundary.js';
import { consumeGenericV4Basis, usdMicrosToText, valueGenericV4Returns } from './v4-realized-accounting.js';
import { ensureEconomicReconciliationWork } from './economic-reconciliation-work.js';
import { enqueuePortfolioRefresh, enqueueTargetedPositionReconciliation } from './active-position-reconciliation.js';

export type V4LifecycleAction = 'collect'|'partial_close'|'full_close'|'burn';
export type V4LifecycleHooks = {
  afterPreparedCommit?: (context:{intentId:string;action:V4LifecycleAction;hash:Hash})=>void|Promise<void>;
  afterProviderAcceptance?: (context:{intentId:string;action:V4LifecycleAction;hash:Hash})=>void|Promise<void>;
  beforeReceiptWait?: (context:{intentId:string;action:V4LifecycleAction;hash:Hash})=>void|Promise<void>;
};
export type V4LifecycleGasPolicy = {
  beforeSigning(context:{intentId:string;action:V4LifecycleAction;estimatedGas:bigint;gasPrice:bigint}):void|Promise<void>;
  afterConfirmation(context:{intentId:string;action:V4LifecycleAction;hash:Hash;gasUsed:bigint;effectiveGasPrice:bigint}):void|{breach:string}|Promise<void|{breach:string}>;
};
export type V4LifecycleInput = {
  repo:SqliteLedgerRepository; rpc:FallbackRpc; walletClient:WalletClient; wallet:Address;
  tokenId:bigint; action:V4LifecycleAction; percent?:25|50|75; slippageBps:number;
  deadlineSeconds:number; idempotencyKey:string; hooks?:V4LifecycleHooks; receiptTimeoutMs?:number;
  allowPublicWrites?:boolean; gasPolicy?:V4LifecycleGasPolicy;
  deferReconciliation?:boolean;
  preflightState?:Awaited<ReturnType<typeof inspectV4PositionState>>;
  transactionSender?:(context:{intentId:string;action:V4LifecycleAction;to:Address;data:`0x${string}`;estimatedGas:bigint})=>Promise<Hash>;
};
export class V4ReceiptWaitInterrupted extends Error {
  constructor(){super('deterministic v4 receipt interruption');this.name='V4ReceiptWaitInterrupted';}
}
type PersistedPreparation={
  key:{currency0:Address;currency1:Address;fee:number;tickSpacing:number;hooks:Address};
  tickLower:number;tickUpper:number;price1Per0:number;priceBlockNumber?:string;removedLiquidity:string;
  principal:{token0:string;token1:string};calldataHash:string;calldata:Hex;
  journal?:DurablePreparedTransaction;
};
const json=(value:unknown)=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?item.toString():item);
const parse=<T>(value:string)=>JSON.parse(value,(key,item)=>/^(gas|gasPrice|value|blockNumber|gasUsed|effectiveGasPrice)$/.test(key)&&typeof item==='string'?BigInt(item):item) as T;
function savedPreparation(row:Record<string,unknown>):PersistedPreparation|undefined{
  try{return (JSON.parse(String(row.payload_json)) as {prepared?:PersistedPreparation}).prepared;}catch{return undefined;}
}
function preparationSnapshot(prepared:Awaited<ReturnType<typeof prepareV4Lifecycle>>):PersistedPreparation{
  return {key:prepared.state.key,tickLower:prepared.state.tickLower,tickUpper:prepared.state.tickUpper,price1Per0:prepared.state.price1Per0,priceBlockNumber:prepared.state.pool.blockNumber?.toString(),removedLiquidity:prepared.removedLiquidity.toString(),principal:{token0:prepared.principal.token0.toString(),token1:prepared.principal.token1.toString()},calldataHash:prepared.plan.calldataHash,calldata:prepared.plan.calldata};
}
function persistPreparation(repo:SqliteLedgerRepository,intentId:string,row:Record<string,unknown>,prepared:Awaited<ReturnType<typeof prepareV4Lifecycle>>){
  const base=JSON.parse(String(row.payload_json)) as Record<string,unknown>;
  const snapshot=preparationSnapshot(prepared);
  repo.db.prepare('UPDATE v4_lifecycle_intents SET liquidity_raw=?,payload_json=?,updated_at=? WHERE id=?').run(snapshot.removedLiquidity,JSON.stringify({...base,prepared:snapshot}),new Date().toISOString(),intentId);
}
function persistedJournal(row:Record<string,unknown>):DurablePreparedTransaction|undefined{const prepared=savedPreparation(row);if(!prepared?.journal)return undefined;return parse<DurablePreparedTransaction>(json(prepared.journal));}
function persistPreparedTransaction(repo:SqliteLedgerRepository,intentId:string,snapshot:PersistedPreparation,prepared:DurablePreparedTransaction){
  const at=new Date().toISOString();repo.db.transaction(()=>{const row=repo.v4LifecycleIntent(intentId);if(!row)throw new Error('V4_LIFECYCLE_INTENT_NOT_FOUND');if(row.tx_hash&&String(row.tx_hash).toLowerCase()!==prepared.expectedHash.toLowerCase())throw new Error('V4_LIFECYCLE_PREPARED_HASH_CONFLICT');const base=JSON.parse(String(row.payload_json)) as Record<string,unknown>,payload=json({...base,prepared:{...snapshot,journal:prepared}}),changed=repo.db.prepare("UPDATE v4_lifecycle_intents SET state='PREPARED',tx_hash=?,liquidity_raw=?,payload_json=?,failure_reason=NULL,updated_at=? WHERE id=? AND state IN ('CLAIMED','SIMULATION_PASSED','PREPARED')").run(prepared.expectedHash,snapshot.removedLiquidity,payload,at,intentId).changes;if(changed!==1)throw new Error('V4_LIFECYCLE_PREPARED_COMMIT_CONFLICT');repo.db.prepare("INSERT OR IGNORE INTO v4_lifecycle_transitions(intent_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,'PREPARED',?,? FROM v4_lifecycle_transitions WHERE intent_id=?").run(intentId,json({semanticStage:prepared.semanticStage,attempt:prepared.attempt,nonce:prepared.request.nonce,exactHash:prepared.expectedHash,requestFingerprint:prepared.requestFingerprint,request:prepared.request}),at,intentId);})();
}
function lifecycleReceipt(repo:SqliteLedgerRepository,intentId:string,hash:Hash){const row=repo.db.prepare('SELECT receipt_json FROM v4_lifecycle_receipts WHERE intent_id=? AND tx_hash=?').get(intentId,hash) as {receipt_json:string}|undefined;return row?parse<TransactionReceipt>(row.receipt_json):undefined;}
function validReceipt(receipt:unknown,hash:Hash):receipt is TransactionReceipt{if(!receipt||typeof receipt!=='object')return false;const row=receipt as Record<string,unknown>;return typeof row.transactionHash==='string'&&row.transactionHash.toLowerCase()===hash.toLowerCase()&&(row.status==='success'||row.status==='reverted')&&typeof row.blockNumber==='bigint'&&typeof row.gasUsed==='bigint'&&typeof row.effectiveGasPrice==='bigint';}
function persistReceiptTruth(repo:SqliteLedgerRepository,intentId:string,hash:Hash,receipt:TransactionReceipt){
  if(!validReceipt(receipt,hash))throw new Error('V4_LIFECYCLE_RECEIPT_EVIDENCE_INVALID');const at=new Date().toISOString(),state=receipt.status==='success'?'CONFIRMED_RECONCILIATION_REQUIRED':'FAILED';repo.db.transaction(()=>{const existing=lifecycleReceipt(repo,intentId,hash);if(existing&&!validReceipt(existing,hash))throw new Error('V4_LIFECYCLE_DURABLE_RECEIPT_INVALID');repo.db.prepare('INSERT OR IGNORE INTO v4_lifecycle_receipts(tx_hash,intent_id,receipt_json,created_at) VALUES(?,?,?,?)').run(hash,intentId,json(receipt),at);repo.db.prepare('UPDATE v4_lifecycle_intents SET state=?,tx_hash=?,failure_reason=?,updated_at=? WHERE id=?').run(state,hash,receipt.status==='success'?null:'V4_LIFECYCLE_TRANSACTION_REVERTED',at,intentId);repo.db.prepare('INSERT OR IGNORE INTO v4_lifecycle_transitions(intent_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,?,?,? FROM v4_lifecycle_transitions WHERE intent_id=?').run(intentId,state,json({exactHash:hash,blockNumber:receipt.blockNumber,gasUsed:receipt.gasUsed,status:receipt.status}),at,intentId);})();
}
function hasSuccessfulReceipt(repo:SqliteLedgerRepository,intentId:string,hash?:Hash){if(!hash)return false;const receipt=lifecycleReceipt(repo,intentId,hash);return Boolean(receipt&&validReceipt(receipt,hash)&&receipt.status==='success');}
function failBeforeConfirmation(repo:SqliteLedgerRepository,intentId:string,reason:string){return repo.db.transaction(()=>{const row=repo.v4LifecycleIntent(intentId),hash=row?.tx_hash as Hash|undefined;if(hasSuccessfulReceipt(repo,intentId,hash))return false;const at=new Date().toISOString();repo.db.prepare("UPDATE v4_lifecycle_intents SET state='FAILED',failure_reason=?,updated_at=? WHERE id=?").run(reason,at,intentId);repo.db.prepare("INSERT OR IGNORE INTO v4_lifecycle_transitions(intent_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,'FAILED',?,? FROM v4_lifecycle_transitions WHERE intent_id=?").run(intentId,json({reason}),at,intentId);return true;})();}
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

export async function reconcileConfirmedV4Lifecycle(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;intentId:string;wallet:Address}){
 const intent=input.repo.v4LifecycleIntent(input.intentId) as Record<string,unknown>|undefined;if(!intent||!intent.tx_hash)throw new Error('V4_LIFECYCLE_INTENT_NOT_FOUND');const action=String(intent.action) as V4LifecycleAction;if(!['collect','full_close'].includes(action))throw new Error('V4_ECONOMIC_RECONCILIATION_ACTION_UNSUPPORTED');const hash=String(intent.tx_hash) as Hash,receipt=lifecycleReceipt(input.repo,input.intentId,hash),persisted=savedPreparation(intent);if(!receipt||!validReceipt(receipt,hash)||receipt.status!=='success')throw new Error('V4_LIFECYCLE_SUCCESS_RECEIPT_REQUIRED');if(!persisted)throw new Error('V4_RECOVERY_PREPARATION_MISSING');const tokenId=BigInt(String(intent.token_id)),positionId=`v4:${tokenId}`,current=input.repo.v4Position(tokenId);if(!current)throw new Error('V4_POSITION_NOT_FOUND');const prepared={state:{key:persisted.key,tickLower:persisted.tickLower,tickUpper:persisted.tickUpper,price1Per0:persisted.price1Per0,priceBlockNumber:persisted.priceBlockNumber},removedLiquidity:BigInt(persisted.removedLiquidity),principal:{token0:BigInt(persisted.principal.token0),token1:BigInt(persisted.principal.token1)}},transfers=parseCurrencyTransfers(receipt.logs,input.wallet,prepared.state.key);
 if(action==='full_close')input.repo.ingestLiquidityChange({id:`v4:${hash}:decrease`,positionId,txHash:hash,logIndex:0,kind:'decrease',amounts:prepared.principal});input.repo.ingestCollection({id:`v4:${hash}:collect`,positionId,txHash:hash,logIndex:1,amounts:transfers,pending:input.repo.positionAccounting(positionId).pendingPrincipal});input.repo.ingestGas(positionId,hash,BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice));
 const totals=input.repo.collectionTotals(positionId),liquidityAfter=action==='full_close'?0n:BigInt(String(current.liquidity_raw)),status=action==='full_close'?(String(current.status)==='burned'?'burned':'closed'):String(current.status),finalBlock=await input.rpc.withClient(client=>client.getBlock({blockNumber:receipt.blockNumber}),{stage:'v4_realized_pnl_finality',method:'eth_getBlockByNumber'}),finalAtMs=Number(finalBlock.timestamp)*1000;if(!Number.isSafeInteger(finalAtMs)||finalAtMs<0)throw new Error('V4_REALIZED_PNL_BLOCK_TIMESTAMP_INVALID');const decimals0=Number(String(current.currency0).toLowerCase()===String(current.target_token).toLowerCase()?current.target_decimals:current.funding_decimals),decimals1=Number(String(current.currency1).toLowerCase()===String(current.target_token).toLowerCase()?current.target_decimals:current.funding_decimals),calculated=valueGenericV4Returns({token0:prepared.state.key.currency0,token1:prepared.state.key.currency1,decimals0,decimals1,amount0:transfers.token0,amount1:transfers.token1,price1Per0:String(prepared.state.price1Per0)}),valuation=prepared.state.priceBlockNumber?calculated:{status:'INCOMPLETE' as const,reason:'PREFLIGHT_PRICE_BLOCK_IDENTITY_UNAVAILABLE'},stage=`V4_LIFECYCLE:${action}`,basis=action==='full_close'?consumeGenericV4Basis({repo:input.repo,positionId,tokenId:tokenId.toString(),intentId:input.intentId,stage,receipt,liquidityBefore:prepared.removedLiquidity,liquidityRemoved:prepared.removedLiquidity,liquidityAfter}):undefined,basisMicros=basis?BigInt(String(basis.basis_delta_usd_micros)):undefined,returnMicros=valuation.status==='AVAILABLE'?valuation.totalUsdMicros:undefined,realizedMicros=action==='collect'?returnMicros:basisMicros!==undefined&&returnMicros!==undefined?returnMicros-basisMicros:undefined;
 input.repo.appendRealizedPnlEvent({eventId:`${input.intentId}:${stage}:${hash.toLowerCase()}:${action==='collect'?'CLAIM':'CLOSE'}`,eventKind:action==='collect'?'CLAIM':'CLOSE',protocol:'v4',strategyType:'GENERIC_V4',positionIdentity:positionId,workflowIdentity:input.intentId,journalStage:stage,transactionHash:hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,economicFinalAtMs:finalAtMs,capitalBasisUsd:basisMicros===undefined?undefined:usdMicrosToText(basisMicros),newlyRealizedFeesUsd:action==='collect'&&returnMicros!==undefined?usdMicrosToText(returnMicros):undefined,realizedPnlUsd:realizedMicros===undefined?undefined:usdMicrosToText(realizedMicros),token0Raw:transfers.token0,token1Raw:transfers.token1,token0Decimals:decimals0,token1Decimals:decimals1,valuationStatus:realizedMicros===undefined?'INCOMPLETE':'AVAILABLE',valuationEvidence:{...('evidence' in valuation?valuation.evidence:{reason:valuation.reason}),priceCapturedBeforeSubmission:true,priceObservationBlock:prepared.state.priceBlockNumber??null,receiptBlockNumber:receipt.blockNumber,receiptBlockHash:receipt.blockHash,basisEventId:basis?.basis_event_id??null},closeReason:action==='collect'?undefined:'FULL_CLOSE',presentationMetadata:{pair:`${String(current.target_symbol??'TOKEN')}/${String(current.funding_symbol??'FUNDING')}`,strategy:'V4',mode:'LIVE',openedAt:current.created_at,returnedValueUsd:returnMicros===undefined?null:usdMicrosToText(returnMicros),basisSplitAvailable:Boolean(basis)}});input.repo.db.prepare('UPDATE v4_positions SET liquidity_raw=?,status=?,claimed_fee0_raw=?,claimed_fee1_raw=?,withdrawn_principal0_raw=?,withdrawn_principal1_raw=?,updated_at=? WHERE token_id=?').run(liquidityAfter.toString(),status,totals.fees.token0.toString(),totals.fees.token1.toString(),totals.principal.token0.toString(),totals.principal.token1.toString(),new Date().toISOString(),tokenId.toString());input.repo.transitionV4LifecycleIntent(input.intentId,'RECONCILED',{details:{transfers,remainingLiquidity:liquidityAfter,closeReceiptDurable:true}});if(action==='full_close')enqueueTargetedPositionReconciliation(input.repo,{positionId,tokenId:tokenId.toString(),protocol:'v4',reason:'ECONOMIC_CLOSE_RECEIPT_CONFIRMED',priority:1_000});enqueuePortfolioRefresh(input.repo,action==='collect'?'ECONOMIC_CLAIM_RECONCILED':'ECONOMIC_CLOSE_RECONCILED');return {ok:true as const,status:'COMPLETED' as const,intentId:input.intentId,hash,transfers,remainingLiquidity:liquidityAfter,principal:prepared.principal};
}

export async function executeV4Lifecycle(input:V4LifecycleInput):Promise<any>{
  if(input.rpc.config.rpcUrls.some(url=>!loopback(url))&&!input.allowPublicWrites)throw new Error('V4_LIFECYCLE_PUBLIC_RPC_WRITES_DISABLED');
  const existing=input.repo.createV4LifecycleIntent({tokenId:input.tokenId,action:input.action,idempotencyKey:input.idempotencyKey,payload:{percent:input.percent,slippageBps:input.slippageBps}}),intentId=String(existing.id),row=input.repo.v4LifecycleIntent(intentId)!;
  if(row.state==='CANCELLED')return {ok:false as const,status:'TERMINAL' as const,intentId,reason:'OPERATOR_CANCELLED_PRE_EXECUTION_PREVIEW'};
  if(row.state==='BURNED'||row.state==='RECONCILED')return {ok:true as const,status:'ALREADY_COMPLETED' as const,intentId,hash:row.tx_hash as Hash,gasPolicyBreach:typeof row.failure_reason==='string'&&row.failure_reason.startsWith('ACTUAL_GAS_POLICY_BREACH:')?row.failure_reason:undefined};
  if(row.state==='FAILED'&&!hasSuccessfulReceipt(input.repo,intentId,row.tx_hash as Hash|undefined))return {ok:false as const,status:'TERMINAL' as const,intentId,reason:String(row.failure_reason)};
  if(row.state==='PREVIEWED'&&!input.repo.claimV4LifecycleIntent(intentId))return {ok:false as const,status:'ALREADY_PROCESSING' as const,intentId};
  if(!['PREVIEWED','CLAIMED','SIMULATION_PASSED','PREPARED','SUBMITTED','CONFIRMED_RECONCILIATION_REQUIRED','CONFIRMED','RECONCILED','FAILED'].includes(String(row.state)))return {ok:false as const,status:'ALREADY_PROCESSING' as const,intentId};
  try{
    let currentRow=input.repo.v4LifecycleIntent(intentId)!,hash=currentRow.tx_hash as Hash|undefined,persisted=savedPreparation(currentRow),fresh:Awaited<ReturnType<typeof prepareV4Lifecycle>>|undefined;
    if(!persisted||(!hash&&!persisted.calldata)){fresh=await prepareV4Lifecycle(input);const refreshed=preparationSnapshot(fresh);if(persisted&&persisted.calldataHash!==refreshed.calldataHash)throw new Error('V4_RECOVERY_PREPARATION_CHANGED');persisted={...persisted,...refreshed};}
    if(hash&&!persisted)throw new Error('V4_RECOVERY_PREPARATION_MISSING');
    const prepared={state:{key:persisted.key,tickLower:persisted.tickLower,tickUpper:persisted.tickUpper,price1Per0:persisted.price1Per0,priceBlockNumber:persisted.priceBlockNumber},removedLiquidity:BigInt(persisted.removedLiquidity),principal:{token0:BigInt(persisted.principal.token0),token1:BigInt(persisted.principal.token1)},plan:{calldata:persisted.calldata,calldataHash:persisted.calldataHash}};
    let observedReceipt:TransactionReceipt|undefined;
    if(input.transactionSender){
      if(!hash){
        const gas=await input.rpc.withClient(client=>client.estimateGas({account:input.wallet,to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,data:prepared.plan.calldata,value:0n}),{stage:'lifecycle_preflight',method:'eth_estimateGas'}),gasPrice=await input.rpc.withClient(client=>client.getGasPrice(),{stage:'lifecycle_preflight',method:'eth_gasPrice'});
        await input.gasPolicy?.beforeSigning({intentId,action:input.action,estimatedGas:gas*12n/10n,gasPrice});
        if(fresh){persistPreparation(input.repo,intentId,currentRow,fresh);input.repo.transitionV4LifecycleIntent(intentId,'SIMULATION_PASSED',{details:{gas,calldataHash:prepared.plan.calldataHash,removedLiquidity:prepared.removedLiquidity,principal:prepared.principal}});}
        hash=await input.transactionSender({intentId,action:input.action,to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,data:prepared.plan.calldata,estimatedGas:gas});input.repo.transitionV4LifecycleIntent(intentId,'SUBMITTED',{txHash:hash,details:{calldataHash:prepared.plan.calldataHash}});
      }
    }else if(!hash||String(currentRow.state)==='PREPARED'){
      const gas=hash?0n:await input.rpc.withClient(client=>client.estimateGas({account:input.wallet,to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,data:prepared.plan.calldata,value:0n}),{stage:'lifecycle_preflight',method:'eth_estimateGas'}),snapshot=persisted;
      const sent=await broadcastDurableTransaction({repo:input.repo,rpc:input.rpc,walletClient:input.walletClient,wallet:input.wallet,workflowId:intentId,semanticStage:`V4_LIFECYCLE:${input.action}`,to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,data:prepared.plan.calldata,estimatedGas:gas,journal:{load:()=>{const durable=input.repo.v4LifecycleIntent(intentId);return durable?persistedJournal(durable):undefined;},persistPrepared:value=>persistPreparedTransaction(input.repo,intentId,snapshot,value),markSubmitted:value=>input.repo.transitionV4LifecycleIntent(intentId,'SUBMITTED',{txHash:value,details:{calldataHash:prepared.plan.calldataHash}})},beforeSigning:context=>input.gasPolicy?.beforeSigning({intentId,action:input.action,estimatedGas:context.gasLimit,gasPrice:context.gasPrice}),hooks:{afterPreparedCommit:value=>input.hooks?.afterPreparedCommit?.({intentId,action:input.action,hash:value.expectedHash}),afterProviderAcceptance:value=>input.hooks?.afterProviderAcceptance?.({intentId,action:input.action,hash:value})}});hash=sent.hash;observedReceipt=sent.receipt;
    }
    if(!hash)throw new Error('V4_LIFECYCLE_EXPECTED_HASH_MISSING');
    let receipt=lifecycleReceipt(input.repo,intentId,hash);
    if(!receipt){await input.hooks?.beforeReceiptWait?.({intentId,action:input.action,hash});const observed=observedReceipt??await input.rpc.withClient(client=>waitReceipt(client,hash!,input.receiptTimeoutMs??60_000),{stage:'receipt_recovery',method:'eth_getTransactionReceipt'});if(!observed)throw new Error('V4_LIFECYCLE_RECEIPT_EVIDENCE_INVALID');receipt=observed as TransactionReceipt;persistReceiptTruth(input.repo,intentId,hash,observed as TransactionReceipt);}
    if(!validReceipt(receipt,hash))throw new Error('V4_LIFECYCLE_RECEIPT_EVIDENCE_INVALID');
    if(receipt.status!=='success')throw new Error('V4_LIFECYCLE_TRANSACTION_REVERTED');
    const gasPolicyResult=await input.gasPolicy?.afterConfirmation({intentId,action:input.action,hash,gasUsed:receipt.gasUsed,effectiveGasPrice:receipt.effectiveGasPrice}),gasPolicyBreach=gasPolicyResult?.breach;if(gasPolicyBreach)input.repo.db.prepare('UPDATE v4_lifecycle_intents SET failure_reason=?,updated_at=? WHERE id=?').run(gasPolicyBreach,new Date().toISOString(),intentId);
    if(String(input.repo.v4LifecycleIntent(intentId)?.state)==='CONFIRMED_RECONCILIATION_REQUIRED')input.repo.transitionV4LifecycleIntent(intentId,'CONFIRMED',{details:{blockNumber:receipt.blockNumber,gasUsed:receipt.gasUsed}});
    if(input.deferReconciliation&&(input.action==='collect'||input.action==='full_close')){let durableHandoff=true;try{ensureEconomicReconciliationWork(input.repo,{chainId:4663,workflowKind:input.action==='collect'?'V4_GENERIC_CLAIM':'V4_GENERIC_CLOSE',workflowIdentity:intentId,semanticStage:`V4_LIFECYCLE:${input.action}`,transactionHash:hash,sourceTable:'v4_lifecycle_intents',sourceIdentity:intentId,priority:500});}catch(error){if(!sqliteTransientCode(error))throw error;durableHandoff=false;}return {ok:true as const,status:'ECONOMIC_CONFIRMED_RECONCILIATION_PENDING' as const,intentId,hash,closeConfirmed:input.action==='full_close',durableHandoff,gasPolicyBreach};}
    if(input.action==='collect'||input.action==='full_close')return {...await reconcileConfirmedV4Lifecycle({repo:input.repo,rpc:input.rpc,intentId,wallet:input.wallet}),gasPolicyBreach};
    const positionId=`v4:${input.tokenId}`,transfers=parseCurrencyTransfers(receipt.logs,input.wallet,prepared.state.key);
    if(input.action==='partial_close')input.repo.ingestLiquidityChange({id:`v4:${hash}:decrease`,positionId,txHash:hash,logIndex:0,kind:'decrease',amounts:prepared.principal});
    input.repo.ingestCollection({id:`v4:${hash}:collect`,positionId,txHash:hash,logIndex:1,amounts:transfers,pending:input.repo.positionAccounting(positionId).pendingPrincipal});
    const gasNative=BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice);
    input.repo.ingestGas(positionId,hash,gasNative);
    if(input.action==='burn'){
      input.repo.updateV4Position({tokenId:input.tokenId,liquidity:0n,status:'burned'});
      input.repo.transitionV4LifecycleIntent(intentId,'BURNED',{details:{transfers}});
      return {ok:true as const,status:'COMPLETED' as const,intentId,hash,transfers,remainingLiquidity:0n,gasPolicyBreach};
    }
    const refreshed=await inspectV4PositionState(input.rpc,input.tokenId),totals=input.repo.collectionTotals(positionId),current=input.repo.v4Position(input.tokenId)!;
    const status=refreshed.liquidity===0n?'closed':input.action==='partial_close'?'partially_closed':String(current.status);
    const finalBlock=await input.rpc.withClient(client=>client.getBlock({blockNumber:receipt.blockNumber}),{stage:'v4_realized_pnl_finality',method:'eth_getBlockByNumber'}),finalAtMs=Number(finalBlock.timestamp)*1000;
    if(!Number.isSafeInteger(finalAtMs)||finalAtMs<0)throw new Error('V4_REALIZED_PNL_BLOCK_TIMESTAMP_INVALID');
    const calculatedValuation=valueGenericV4Returns({token0:prepared.state.key.currency0,token1:prepared.state.key.currency1,decimals0:refreshed.token0.decimals,decimals1:refreshed.token1.decimals,amount0:transfers.token0,amount1:transfers.token1,price1Per0:String(prepared.state.price1Per0)}),valuation=prepared.state.priceBlockNumber?calculatedValuation:{status:'INCOMPLETE' as const,reason:'PREFLIGHT_PRICE_BLOCK_IDENTITY_UNAVAILABLE'},stage=`V4_LIFECYCLE:${input.action}`;
    const basis=consumeGenericV4Basis({repo:input.repo,positionId,tokenId:input.tokenId.toString(),intentId,stage,receipt,liquidityBefore:BigInt(String(current.liquidity_raw)),liquidityRemoved:prepared.removedLiquidity,liquidityAfter:refreshed.liquidity});if(!basis)throw new Error('V4_PARTIAL_CLOSE_BASIS_MISSING');const basisMicros=BigInt(String(basis.basis_delta_usd_micros)),returnMicros=valuation.status==='AVAILABLE'?valuation.totalUsdMicros:undefined,realizedMicros=returnMicros!==undefined?returnMicros-basisMicros:undefined;
    input.repo.appendRealizedPnlEvent({eventId:`${intentId}:${stage}:${hash.toLowerCase()}:CLOSE`,eventKind:'CLOSE',protocol:'v4',strategyType:'GENERIC_V4',positionIdentity:positionId,workflowIdentity:intentId,journalStage:stage,transactionHash:hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,economicFinalAtMs:finalAtMs,capitalBasisUsd:usdMicrosToText(basisMicros),returnedPrincipalUsd:undefined,realizedPnlUsd:realizedMicros===undefined?undefined:usdMicrosToText(realizedMicros),token0Raw:transfers.token0,token1Raw:transfers.token1,token0Decimals:refreshed.token0.decimals,token1Decimals:refreshed.token1.decimals,valuationStatus:realizedMicros===undefined?'INCOMPLETE':'AVAILABLE',valuationEvidence:{...('evidence' in valuation?valuation.evidence:{reason:valuation.reason}),priceCapturedBeforeSubmission:true,priceObservationBlock:prepared.state.priceBlockNumber??null,priceFinalityRelation:'PERSISTED_PREFLIGHT_PRICE_FOR_EXACT_RECEIPT',receiptBlockNumber:receipt.blockNumber,receiptBlockHash:receipt.blockHash,closeReturnUsd:returnMicros===undefined?null:usdMicrosToText(returnMicros),basisEventId:basis.basis_event_id},closeReason:'PARTIAL_CLOSE',presentationMetadata:{pair:`${refreshed.token0.symbol}/${refreshed.token1.symbol}`,strategy:'V4',mode:'LIVE',openedAt:current.created_at,returnedValueUsd:returnMicros===undefined?null:usdMicrosToText(returnMicros),basisSplitAvailable:true}});
    input.repo.db.prepare('UPDATE v4_positions SET liquidity_raw=?,status=?,claimed_fee0_raw=?,claimed_fee1_raw=?,withdrawn_principal0_raw=?,withdrawn_principal1_raw=?,updated_at=? WHERE token_id=?').run(refreshed.liquidity.toString(),status,totals.fees.token0.toString(),totals.fees.token1.toString(),totals.principal.token0.toString(),totals.principal.token1.toString(),new Date().toISOString(),input.tokenId.toString());
    input.repo.transitionV4LifecycleIntent(intentId,'RECONCILED',{details:{transfers,remainingLiquidity:refreshed.liquidity,closeReceiptDurable:true}});
    return {ok:true as const,status:'COMPLETED' as const,intentId,hash,transfers,remainingLiquidity:refreshed.liquidity,principal:prepared.principal,gasPolicyBreach};
  }catch(error){
    if(error instanceof V4ReceiptWaitInterrupted||String(error).includes('V4_RECEIPT_TIMEOUT'))return {ok:false as const,status:'RECOVERY_REQUIRED' as const,intentId,hash:input.repo.v4LifecycleIntent(intentId)?.tx_hash as Hash};
    const durable=input.repo.v4LifecycleIntent(intentId),durableHash=durable?.tx_hash as Hash|undefined,hasReceipt=durableHash?Boolean(input.repo.db.prepare('SELECT 1 FROM v4_lifecycle_receipts WHERE intent_id=? AND tx_hash=? LIMIT 1').get(intentId,durableHash)):false;
    const reason=sanitizeRpcError(error,{stage:`v4_lifecycle_${input.action}`,method:'lifecycle_execution'});
    if((durableHash&&!hasReceipt)||hasSuccessfulReceipt(input.repo,intentId,durableHash))return {ok:false as const,status:'RECOVERY_REQUIRED' as const,intentId,hash:durableHash,reason};
    if(!failBeforeConfirmation(input.repo,intentId,reason))return {ok:false as const,status:'RECOVERY_REQUIRED' as const,intentId,hash:durableHash,reason};return {ok:false as const,status:'FAILED' as const,intentId,reason};
  }
}
export function recoverV4Lifecycle(input:V4LifecycleInput):Promise<any>{return executeV4Lifecycle({...input,hooks:undefined});}
