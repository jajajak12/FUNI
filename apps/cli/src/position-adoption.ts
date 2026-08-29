import { randomUUID } from 'node:crypto';
import {
  decodeEventLog,
  getAddress,
  parseAbiItem,
  zeroAddress,
  type Address,
  type Hash,
} from 'viem';
import {
  auditRobinhoodV3Deployments,
  inspectErc20,
  inspectV3Position,
  positionManagerAbi as v3PositionManagerAbi,
  robinhoodMainnet,
  type FallbackRpc,
} from '@funi/core';
import {
  auditRobinhoodV4Deployments,
  classifyV4RangeState,
  inspectV4PositionState,
  poolId,
  positionManagerAbi as v4PositionManagerAbi,
  V4_ROBINHOOD_DEPLOYMENTS,
} from '@funi/v4';
import type { SqliteLedgerRepository, TokenAmounts } from '@funi/ledger';

export const POSITION_SYNC_DEFAULT_LOOKBACK=250_000n;
export const POSITION_SYNC_DEFAULT_WINDOW=50_000n;
export const POSITION_SYNC_MAX_WINDOWS=5;
const erc20Transfer=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const json=(value:unknown)=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?item.toString():item);
const now=()=>new Date().toISOString();
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function shouldPreserveBotOperationalPosition(row:Record<string,unknown>|undefined){return Boolean(row?.open_intent_id);}

type Protocol='v3'|'v4';
type Candidate={
 protocol_version:Protocol;
 token_id:string;
 manager_address:string;
 acquisition_tx_hash:Hash;
 acquisition_block:string;
 acquisition_log_index:number;
 acquisition_from:Address;
 last_verified_owner:string|null;
 ownership_verified_at:string|null;
 candidate_state?:'DISCOVERED'|'OWNERSHIP_VERIFIED'|'ADOPTED'|'FINALIZED_UNOWNED'|'BURNED'|'RETRYABLE_ERROR';
 retry_after_ms?:number|null;
};
export type AdoptionRecord={
 position_id:string;
 protocol_version:Protocol;
 token_id:string;
 manager_address:string;
 source:'MANUAL_EXTERNAL';
 adoption_status:'AUTO_ADOPTED';
 accounting_status:string;
 discovery_method:string;
 mint_tx_hash:string|null;
 mint_block:string|null;
 original_amount0_raw:string|null;
 original_amount1_raw:string|null;
 original_capital_usd:number|null;
 baseline_provenance:string|null;
 baseline_set_at:string|null;
 funding_token:string|null;
 funding_symbol:string|null;
 funding_provenance:string|null;
 history_json:string;
 created_at:string;
 updated_at:string;
};

function tableExists(repo:SqliteLedgerRepository,name:string){
 return Boolean(repo.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
export function positionAdoption(repo:SqliteLedgerRepository,positionId:string){
 if(!tableExists(repo,'position_adoptions'))return undefined;
 return repo.db.prepare('SELECT * FROM position_adoptions WHERE position_id=?').get(positionId) as AdoptionRecord|undefined;
}
export function adoptionAudit(repo:SqliteLedgerRepository,tokenId:string){
 if(!tableExists(repo,'position_adoptions'))return {status:'NOT_ADOPTED',tokenId,mainnetTransactionsSent:0};
 const adoption=repo.db.prepare('SELECT * FROM position_adoptions WHERE token_id=? ORDER BY created_at').get(tokenId) as AdoptionRecord|undefined;
 if(!adoption)return {status:'NOT_ADOPTED',tokenId,mainnetTransactionsSent:0};
 const candidate=repo.db.prepare('SELECT * FROM wallet_position_candidates WHERE protocol_version=? AND token_id=?').get(adoption.protocol_version,tokenId);
 const receipts=repo.db.prepare("SELECT tx_hash,receipt_json,reconciled_at FROM transaction_receipts WHERE intent_id=? OR tx_hash=? ORDER BY rowid").all(adoption.position_id,adoption.mint_tx_hash);
 return {status:'ADOPTED',adoption,candidate,receipts,reconciliation:repo.reconciliationDelta(adoption.position_id),mainnetTransactionsSent:0};
}
export function walletPositionSyncAudit(repo:SqliteLedgerRepository){
 if(!tableExists(repo,'position_adoptions'))return {status:'MIGRATION_REQUIRED',cursors:[],candidates:[],adoptions:[],mainnetTransactionsSent:0};
 return {
  status:'READ_ONLY',
  cursors:repo.db.prepare('SELECT * FROM wallet_position_sync_cursors ORDER BY protocol_version,wallet_address').all(),
  legacyCursors:tableExists(repo,'wallet_position_sync_cursors_legacy')?repo.db.prepare('SELECT * FROM wallet_position_sync_cursors_legacy ORDER BY protocol_version').all():[],
  candidates:repo.db.prepare('SELECT protocol_version,token_id,manager_address,acquisition_tx_hash,acquisition_block,last_verified_owner,ownership_verified_at,candidate_state,state_reason,retry_after_ms FROM wallet_position_candidates ORDER BY protocol_version,CAST(token_id AS INTEGER)').all(),
  adoptions:repo.db.prepare('SELECT position_id,protocol_version,token_id,source,adoption_status,accounting_status,discovery_method,baseline_provenance,funding_symbol,funding_provenance,updated_at FROM position_adoptions ORDER BY protocol_version,CAST(token_id AS INTEGER)').all(),
  mainnetTransactionsSent:0,
 };
}

export function enqueueWalletPositionSync(repo:SqliteLedgerRepository,reason:string,at=Date.now()){
 const result=repo.db.prepare(`INSERT INTO wallet_position_sync_requests(request_key,requested_at_ms,available_at_ms,reason)
 VALUES('wallet',?,?,?) ON CONFLICT(request_key) DO UPDATE SET
 requested_at_ms=max(wallet_position_sync_requests.requested_at_ms,excluded.requested_at_ms),
 available_at_ms=CASE WHEN wallet_position_sync_requests.leased_until_ms IS NULL THEN min(wallet_position_sync_requests.available_at_ms,excluded.available_at_ms) ELSE wallet_position_sync_requests.available_at_ms END,
 reason=excluded.reason`).run(at,at,reason);
 return {queued:result.changes===1,requestKey:'wallet' as const};
}
export function leaseWalletPositionSync(repo:SqliteLedgerRepository,leaseMs:number,at=Date.now()){
 const row=repo.db.prepare("SELECT * FROM wallet_position_sync_requests WHERE request_key='wallet' AND available_at_ms<=? AND (leased_until_ms IS NULL OR leased_until_ms<?)").get(at,at) as Record<string,unknown>|undefined;
 if(!row)return undefined;
 repo.db.prepare("UPDATE wallet_position_sync_requests SET leased_until_ms=? WHERE request_key='wallet'").run(at+leaseMs);
 return row;
}
export function completeWalletPositionSync(repo:SqliteLedgerRepository,at=Date.now()){
 repo.db.prepare("UPDATE wallet_position_sync_requests SET completed_at_ms=?,leased_until_ms=NULL,available_at_ms=9223372036854775807,last_error=NULL WHERE request_key='wallet'").run(at);
}
export function retryWalletPositionSync(repo:SqliteLedgerRepository,error:string,at=Date.now()){
 const row=repo.db.prepare("SELECT attempts FROM wallet_position_sync_requests WHERE request_key='wallet'").get() as {attempts:number}|undefined,attempts=Number(row?.attempts??0)+1,delay=Math.min(300_000,5_000*2**Math.min(attempts,6));
 repo.db.prepare("UPDATE wallet_position_sync_requests SET attempts=?,leased_until_ms=NULL,available_at_ms=?,last_error=? WHERE request_key='wallet'").run(attempts,at+delay,error.slice(0,500));
}
export function operationalOpenIntentAudit(repo:SqliteLedgerRepository,intentId:string){
 const intent=repo.v4LiveOpenIntent(intentId);
 if(!intent)return {status:'NOT_FOUND',intentId,mainnetTransactionsSent:0};
 const transitions=repo.v4LiveTransitions(intentId),hashes={
  erc20ToPermit2:intent.erc20_approval_hash??null,
  permit2ToPositionManager:intent.permit2_approval_hash??null,
  mint:intent.mint_hash??null,
 },persistedHashes=Object.values(hashes).filter(Boolean) as string[],receipts=persistedHashes.flatMap(hash=>[
  ...(tableExists(repo,'v4_operational_open_receipts')?repo.db.prepare('SELECT tx_hash,phase,receipt_json,created_at FROM v4_operational_open_receipts WHERE tx_hash=?').all(hash) as unknown[]:[]),
 ]),states=transitions.map(row=>String(row.state)),gas=repo.db.prepare('SELECT phase,estimated_gas,estimated_eth_raw,estimated_usd,actual_gas,actual_eth_raw,actual_usd,created_at,confirmed_at FROM v4_live_gas WHERE intent_id=? ORDER BY created_at').all(intentId);
 return {
  status:'READ_ONLY',
  intentId,
  durableState:String(intent.state),
  signatureProduced:states.some(state=>state.endsWith('_SUBMITTED'))?true:states.some(state=>state.endsWith('_SIGNING'))?'UNKNOWN_NOT_PERSISTED':false,
  rawTransactionProduced:states.some(state=>state.endsWith('_SUBMITTED'))?true:states.some(state=>state.endsWith('_SIGNING'))?'UNKNOWN_NOT_PERSISTED':false,
  rawTransactionStoragePolicy:'raw signed transactions are never persisted',
  hashes,
  submitted:persistedHashes.length>0,
  receipts,
  transitions,
  gas,
  reconciliation:{erc20Approval:Boolean(hashes.erc20ToPermit2&&receipts.length),permit2Approval:Boolean(hashes.permit2ToPositionManager&&receipts.length),mint:Boolean(hashes.mint&&receipts.length)},
  failureReason:intent.failure_reason??null,
  mainnetTransactionsSent:0,
 };
}

export function createAdoptionBaselineConfirmation(repo:SqliteLedgerRepository,input:{positionId:string;userId:string;chatId:string;baselineUsd:number;nowMs:number;ttlMs:number}){
 if(!Number.isFinite(input.baselineUsd)||input.baselineUsd<=0)throw new Error('ADOPTION_BASELINE_INVALID');
 const adoption=positionAdoption(repo,input.positionId);
 if(!adoption)throw new Error('POSITION_NOT_AUTO_ADOPTED');
 if(adoption.baseline_provenance)throw new Error('ADOPTION_BASELINE_ALREADY_VERIFIED');
 const id=randomUUID(),at=new Date(input.nowMs).toISOString();
 repo.db.prepare("UPDATE adoption_baseline_confirmations SET state='EXPIRED',updated_at=? WHERE position_id=? AND state='AWAITING_CONFIRMATION'").run(at,input.positionId);
 repo.db.prepare("INSERT INTO adoption_baseline_confirmations(id,position_id,user_id,chat_id,baseline_usd,state,expires_at_ms,created_at,updated_at) VALUES(?,?,?,?,?,'AWAITING_CONFIRMATION',?,?,?)").run(id,input.positionId,input.userId,input.chatId,input.baselineUsd,input.nowMs+input.ttlMs,at,at);
 return {id,positionId:input.positionId,baselineUsd:input.baselineUsd,expiresAtMs:input.nowMs+input.ttlMs};
}
export function confirmAdoptionBaseline(repo:SqliteLedgerRepository,input:{id:string;userId:string;chatId:string;nowMs:number}){
 const at=new Date(input.nowMs).toISOString(),run=repo.db.transaction(()=>{
  const confirmation=repo.db.prepare("SELECT * FROM adoption_baseline_confirmations WHERE id=? AND user_id=? AND chat_id=? AND state='AWAITING_CONFIRMATION'").get(input.id,input.userId,input.chatId) as Record<string,unknown>|undefined;
  if(!confirmation)return {status:'INVALID_CONFIRMATION' as const};
  if(Number(confirmation.expires_at_ms)<=input.nowMs){repo.db.prepare("UPDATE adoption_baseline_confirmations SET state='EXPIRED',updated_at=? WHERE id=?").run(at,input.id);return {status:'EXPIRED' as const};}
  const changed=repo.db.prepare("UPDATE position_adoptions SET original_capital_usd=?,baseline_provenance='USER_VERIFIED_BASELINE',baseline_set_at=?,accounting_status=CASE WHEN funding_provenance IS NULL THEN 'ADOPTED_FUNDING_SELECTION_REQUIRED' ELSE 'ADOPTED_MANAGEMENT_READY' END,updated_at=? WHERE position_id=? AND baseline_provenance IS NULL").run(Number(confirmation.baseline_usd),at,at,String(confirmation.position_id)).changes;
  if(changed!==1)return {status:'BASELINE_ALREADY_VERIFIED' as const};
  repo.db.prepare("UPDATE adoption_baseline_confirmations SET state='CONFIRMED',updated_at=? WHERE id=?").run(at,input.id);
  return {status:'CONFIRMED' as const,positionId:String(confirmation.position_id),baselineUsd:Number(confirmation.baseline_usd),provenance:'USER_VERIFIED_BASELINE' as const};
 });
 return run();
}
export function setAdoptedFundingAsset(repo:SqliteLedgerRepository,input:{positionId:string;token:Address;symbol:'USDG'|'WETH';provenance:'USER_SELECTED_FUNDING'|'CHAIN_PROVEN_SINGLE_SIDED'}){
 const adoption=positionAdoption(repo,input.positionId);
 if(!adoption)throw new Error('POSITION_NOT_AUTO_ADOPTED');
 if(adoption.funding_provenance){
  if(!same(String(adoption.funding_token),input.token))throw new Error('ADOPTION_FUNDING_ALREADY_VERIFIED');
  return adoption;
 }
 const at=now(),run=repo.db.transaction(()=>{
  repo.db.prepare("UPDATE position_adoptions SET funding_token=?,funding_symbol=?,funding_provenance=?,accounting_status=CASE WHEN baseline_provenance IS NULL THEN 'ADOPTED_ACCOUNTING_INCOMPLETE' ELSE 'ADOPTED_MANAGEMENT_READY' END,updated_at=? WHERE position_id=? AND funding_provenance IS NULL").run(getAddress(input.token),input.symbol,input.provenance,at,input.positionId);
  if(adoption.protocol_version==='v4'){
   const row=repo.v4Position(adoption.token_id);if(!row)throw new Error('V4_POSITION_NOT_FOUND');
   const key=JSON.parse(String(row.pool_key_json)) as {currency0:Address;currency1:Address};
   const fundingIndex=same(key.currency0,input.token)?0:same(key.currency1,input.token)?1:-1;if(fundingIndex<0)throw new Error('ADOPTION_FUNDING_NOT_IN_POOL');
   const target=fundingIndex===0?key.currency1:key.currency0,targetIndex=fundingIndex===0?1:0,history=JSON.parse(adoption.history_json) as {tokens?:Array<{address:string;symbol:string;decimals:number}>},fundingMeta=history.tokens?.find(item=>same(item.address,input.token)),targetMeta=history.tokens?.find(item=>same(item.address,target));
   repo.db.prepare('UPDATE v4_positions SET funding_token=?,funding_symbol=?,funding_decimals=?,funding_index=?,target_token=?,target_symbol=?,target_decimals=?,target_index=?,updated_at=? WHERE token_id=?').run(input.token,input.symbol,fundingMeta?.decimals??null,fundingIndex,target,targetMeta?.symbol??null,targetMeta?.decimals??null,targetIndex,at,adoption.token_id);
  }
  return positionAdoption(repo,input.positionId)!;
 });
 return run();
}

function upsertCandidate(repo:SqliteLedgerRepository,input:{protocol:Protocol;tokenId:bigint;manager:Address;hash:Hash;block:bigint;logIndex:number;from:Address}){
 const at=now();
 repo.db.prepare(`INSERT INTO wallet_position_candidates(protocol_version,token_id,manager_address,acquisition_tx_hash,acquisition_block,acquisition_log_index,acquisition_from,candidate_state,relevant_transfer_at,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,'DISCOVERED',?,?,?) ON CONFLICT(protocol_version,token_id) DO UPDATE SET
 manager_address=excluded.manager_address,
 candidate_state=CASE WHEN wallet_position_candidates.acquisition_tx_hash<>excluded.acquisition_tx_hash OR wallet_position_candidates.acquisition_log_index<>excluded.acquisition_log_index THEN 'DISCOVERED' ELSE wallet_position_candidates.candidate_state END,
 state_reason=CASE WHEN wallet_position_candidates.acquisition_tx_hash<>excluded.acquisition_tx_hash OR wallet_position_candidates.acquisition_log_index<>excluded.acquisition_log_index THEN NULL ELSE wallet_position_candidates.state_reason END,
 acquisition_tx_hash=excluded.acquisition_tx_hash,acquisition_block=excluded.acquisition_block,acquisition_log_index=excluded.acquisition_log_index,acquisition_from=excluded.acquisition_from,
 relevant_transfer_at=CASE WHEN wallet_position_candidates.acquisition_tx_hash<>excluded.acquisition_tx_hash OR wallet_position_candidates.acquisition_log_index<>excluded.acquisition_log_index THEN excluded.relevant_transfer_at ELSE wallet_position_candidates.relevant_transfer_at END,
 updated_at=excluded.updated_at`)
  .run(input.protocol,input.tokenId.toString(),input.manager,input.hash,input.block.toString(),input.logIndex,input.from,at,at,at);
}
export async function scanProtocol(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;protocol:Protocol;manager:Address;wallet:Address;event:any;idName:'id'|'tokenId';latest:bigint;fromBlock?:bigint;windowSize:bigint;maxWindows:number}){
 const wallet=getAddress(input.wallet);
 const initial=input.fromBlock??(input.latest>POSITION_SYNC_DEFAULT_LOOKBACK?input.latest-POSITION_SYNC_DEFAULT_LOOKBACK:0n),at=now();
 input.repo.db.prepare(`INSERT OR IGNORE INTO wallet_position_sync_cursors(protocol_version,wallet_address,manager_address,initialized_from_block,next_block,latest_observed_block,window_size,updated_at)
 VALUES(?,?,?,?,?,?,?,?)`).run(input.protocol,wallet,input.manager,initial.toString(),initial.toString(),input.latest.toString(),Number(input.windowSize),at);
 const row=input.repo.db.prepare('SELECT * FROM wallet_position_sync_cursors WHERE protocol_version=? AND wallet_address=?').get(input.protocol,wallet) as Record<string,unknown>|undefined;
 if(!row)throw new Error('WALLET_POSITION_CURSOR_INITIALIZATION_FAILED');
 let cursor=row?BigInt(String(row.next_block)):input.fromBlock??(input.latest>POSITION_SYNC_DEFAULT_LOOKBACK?input.latest-POSITION_SYNC_DEFAULT_LOOKBACK:0n),windows=0,logsSeen=0;
 const initialized=row?BigInt(String(row.initialized_from_block)):cursor;
 while(cursor<=input.latest&&windows<input.maxWindows){
  const end=cursor+input.windowSize-1n<input.latest?cursor+input.windowSize-1n:input.latest;
  const [incoming,outgoing]=await input.rpc.withClient(client=>Promise.all([client.getLogs({address:input.manager,event:input.event,args:{to:input.wallet},fromBlock:cursor,toBlock:end} as any),client.getLogs({address:input.manager,event:input.event,args:{from:input.wallet},fromBlock:cursor,toBlock:end} as any)]));
  const committed=input.repo.db.transaction(()=>{
   const advanced=input.repo.db.prepare('UPDATE wallet_position_sync_cursors SET next_block=?,latest_observed_block=?,window_size=?,manager_address=?,updated_at=? WHERE protocol_version=? AND wallet_address=? AND next_block=?').run((end+1n).toString(),input.latest.toString(),Number(input.windowSize),input.manager,now(),input.protocol,wallet,cursor.toString()).changes;
   if(advanced!==1)return false;
   for(const log of incoming as any[]){const tokenId=BigInt(log.args[input.idName]),hash=log.transactionHash as Hash,block=BigInt(log.blockNumber);upsertCandidate(input.repo,{protocol:input.protocol,tokenId,manager:input.manager,hash,block,logIndex:Number(log.logIndex),from:getAddress(log.args.from)});}
   for(const log of outgoing as any[]){const tokenId=BigInt(log.args[input.idName]),changedAt=now();input.repo.db.prepare("UPDATE wallet_position_candidates SET candidate_state='DISCOVERED',state_reason='OUTGOING_TRANSFER_EVENT',relevant_transfer_at=?,ownership_verified_at=NULL,retry_after_ms=NULL,updated_at=? WHERE protocol_version=? AND token_id=?").run(changedAt,changedAt,input.protocol,tokenId.toString());}
   return true;
  })();
  if(!committed)break;
  logsSeen+=(incoming as any[]).length+(outgoing as any[]).length;
  cursor=end+1n;windows++;
 }
 return {protocol:input.protocol,fromBlock:row?String(row.next_block):initialized.toString(),nextBlock:cursor.toString(),latestBlock:input.latest.toString(),windows,logsSeen,complete:cursor>input.latest};
}

async function outgoingAmounts(rpc:FallbackRpc,hash:Hash,wallet:Address,token0:Address,token1:Address){
 const receipt=await rpc.withClient(client=>client.getTransactionReceipt({hash})),amounts:TokenAmounts={token0:0n,token1:0n};
 for(const log of receipt.logs)try{
  if(!same(log.address,token0)&&!same(log.address,token1))continue;
  const event=decodeEventLog({abi:[erc20Transfer],data:log.data,topics:log.topics});
  if(event.eventName!=='Transfer'||!same(event.args.from,wallet))continue;
  if(same(log.address,token0))amounts.token0+=event.args.value;else amounts.token1+=event.args.value;
 }catch{/* unrelated log */}
 return {receipt,amounts};
}
function inferFunding(amounts:TokenAmounts,token0:Address,token1:Address){
 const oneSided=(amounts.token0>0n)!==(amounts.token1>0n);if(!oneSided)return undefined;
 const token=amounts.token0>0n?token0:token1;
 if(same(token,robinhoodMainnet.assets.USDG))return {token:getAddress(token),symbol:'USDG' as const};
 if(same(token,robinhoodMainnet.assets.WETH))return {token:getAddress(token),symbol:'WETH' as const};
 return undefined;
}
async function findMint(input:{rpc:FallbackRpc;protocol:Protocol;manager:Address;event:any;idName:'id'|'tokenId';tokenId:bigint;latest:bigint;fromBlock:bigint}){
 try{
  const args=input.idName==='id'?{from:zeroAddress,id:input.tokenId}:{from:zeroAddress,tokenId:input.tokenId};
  const logs=await input.rpc.withClient(client=>client.getLogs({address:input.manager,event:input.event,args,fromBlock:input.fromBlock,toBlock:input.latest} as any)) as any[];
  const log=logs[0];return log?{hash:log.transactionHash as Hash,block:BigInt(log.blockNumber),logIndex:Number(log.logIndex)}:undefined;
 }catch{return undefined;}
}
function persistAdoption(repo:SqliteLedgerRepository,input:{positionId:string;protocol:Protocol;tokenId:bigint;manager:Address;accountingStatus:string;mint?:{hash:Hash;block:bigint};amounts?:TokenAmounts;funding?:{token:Address;symbol:'USDG'|'WETH'};history:unknown}){
 const at=now();
 repo.db.prepare(`INSERT INTO position_adoptions(position_id,protocol_version,token_id,manager_address,source,adoption_status,accounting_status,discovery_method,mint_tx_hash,mint_block,original_amount0_raw,original_amount1_raw,funding_token,funding_symbol,funding_provenance,history_json,created_at,updated_at)
 VALUES(?,?,?,?,'MANUAL_EXTERNAL','AUTO_ADOPTED',?,'PERSISTED_TRANSFER_CURSOR_PLUS_OWNEROF',?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(position_id) DO UPDATE SET accounting_status=CASE WHEN position_adoptions.baseline_provenance IS NULL THEN excluded.accounting_status ELSE position_adoptions.accounting_status END,mint_tx_hash=COALESCE(position_adoptions.mint_tx_hash,excluded.mint_tx_hash),mint_block=COALESCE(position_adoptions.mint_block,excluded.mint_block),original_amount0_raw=COALESCE(position_adoptions.original_amount0_raw,excluded.original_amount0_raw),original_amount1_raw=COALESCE(position_adoptions.original_amount1_raw,excluded.original_amount1_raw),funding_token=COALESCE(position_adoptions.funding_token,excluded.funding_token),funding_symbol=COALESCE(position_adoptions.funding_symbol,excluded.funding_symbol),funding_provenance=COALESCE(position_adoptions.funding_provenance,excluded.funding_provenance),history_json=excluded.history_json,updated_at=excluded.updated_at`)
  .run(input.positionId,input.protocol,input.tokenId.toString(),input.manager,input.accountingStatus,input.mint?.hash??null,input.mint?.block.toString()??null,input.amounts?.token0.toString()??null,input.amounts?.token1.toString()??null,input.funding?.token??null,input.funding?.symbol??null,input.funding?'CHAIN_PROVEN_SINGLE_SIDED':null,json(input.history),at,at);
}

async function adoptV4(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;candidate:Candidate;wallet:Address;latest:bigint;skipHistoricalEvidence?:boolean}){
 const tokenId=BigInt(input.candidate.token_id),state=await inspectV4PositionState(input.rpc,tokenId);
 if(!same(state.owner,input.wallet))return {protocol:'v4',tokenId:input.candidate.token_id,status:'NOT_OWNED'};
 const mint=input.skipHistoricalEvidence?undefined:same(input.candidate.acquisition_from,zeroAddress)?{hash:input.candidate.acquisition_tx_hash,block:BigInt(input.candidate.acquisition_block),logIndex:input.candidate.acquisition_log_index}:await findMint({rpc:input.rpc,protocol:'v4',manager:getAddress(input.candidate.manager_address),event:v4PositionManagerAbi[5],idName:'id',tokenId,latest:input.latest,fromBlock:BigInt(input.candidate.acquisition_block)});
 const evidence=mint?await outgoingAmounts(input.rpc,mint.hash,input.wallet,state.key.currency0,state.key.currency1).catch(()=>undefined):undefined,amounts=evidence?.amounts,funding=amounts?inferFunding(amounts,state.key.currency0,state.key.currency1):undefined,positionId=`v4:${tokenId}`;
 input.repo.ensurePosition(positionId,tokenId.toString(),poolId(state.key));
 input.repo.upsertV4Position({tokenId,owner:state.owner,poolId:poolId(state.key),poolKey:state.key,currency0:state.key.currency0,currency1:state.key.currency1,fee:state.key.fee,tickSpacing:state.key.tickSpacing,hooks:state.key.hooks,tickLower:state.tickLower,tickUpper:state.tickUpper,liquidity:state.liquidity,initialAmount0:amounts?.token0??0n,initialAmount1:amounts?.token1??0n,mintHash:mint?.hash??input.candidate.acquisition_tx_hash,status:state.liquidity>0n?'open':'closed',fundingToken:funding?.token,fundingSymbol:funding?.symbol,fundingIndex:funding?(same(funding.token,state.key.currency0)?0:1):undefined,targetToken:funding?(same(funding.token,state.key.currency0)?state.key.currency1:state.key.currency0):undefined,targetSymbol:funding?(same(funding.token,state.key.currency0)?state.token1.symbol:state.token0.symbol):undefined,targetIndex:funding?(same(funding.token,state.key.currency0)?1:0):undefined,targetDecimals:funding?(same(funding.token,state.key.currency0)?state.token1.decimals:state.token0.decimals):undefined,fundingDecimals:funding?(same(funding.token,state.key.currency0)?state.token0.decimals:state.token1.decimals):undefined,valuationProvenance:currentV4ValuationMetadata(state),openEvidence:{source:'MANUAL_EXTERNAL',mintHash:mint?.hash??null,acquisitionHash:input.candidate.acquisition_tx_hash,initialAmountsKnown:Boolean(amounts),ownerVerifiedAt:now()}});
 persistCurrentV4ValuationMetadata(input.repo,state);
 if(mint&&amounts&&(amounts.token0>0n||amounts.token1>0n)){
  const block=await input.rpc.withClient(client=>client.getBlock({blockNumber:mint.block}));
  input.repo.ingestDeposit({id:`adopted-mint:${mint.hash}`,positionId,txHash:mint.hash,logIndex:mint.logIndex,amounts,blockNumber:mint.block,blockTimestamp:new Date(Number(block.timestamp)*1000).toISOString()});
  if(evidence)input.repo.ingestGas(positionId,mint.hash,evidence.receipt.gasUsed*evidence.receipt.effectiveGasPrice);
 }
 persistAdoption(input.repo,{positionId,protocol:'v4',tokenId,manager:getAddress(input.candidate.manager_address),accountingStatus:'ADOPTED_ACCOUNTING_INCOMPLETE',mint,amounts,funding,history:{mintReceiptFound:Boolean(mint),depositedAmountsReconstructed:Boolean(amounts),eventTimePriceUsd:null,missingValuesAreUnavailable:true,tokens:[{address:state.key.currency0,symbol:state.token0.symbol,decimals:state.token0.decimals},{address:state.key.currency1,symbol:state.token1.symbol,decimals:state.token1.decimals}],currentState:{poolId:poolId(state.key),liquidity:state.liquidity,tickLower:state.tickLower,tickUpper:state.tickUpper}}});
 return {protocol:'v4',tokenId:tokenId.toString(),status:'AUTO_ADOPTED',positionId,accountingStatus:'ADOPTED_ACCOUNTING_INCOMPLETE'};
}
function usdValue(state:Awaited<ReturnType<typeof inspectV4PositionState>>,amounts:TokenAmounts){
 const usd0=state.key.currency0.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()?1:state.key.currency1.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()?state.price1Per0:undefined;
 const usd1=state.key.currency1.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()?1:state.key.currency0.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()?1/state.price1Per0:undefined;
 return usd0!==undefined&&usd1!==undefined?Number(amounts.token0)/10**state.token0.decimals*usd0+Number(amounts.token1)/10**state.token1.decimals*usd1:null;
}
function currentV4ValuationMetadata(state:Awaited<ReturnType<typeof inspectV4PositionState>>){return {source:'LIVE_V4_POSITION_INSPECTION',poolBlock:state.pool.blockNumber.toString(),currency0:{address:state.key.currency0,symbol:state.token0.symbol,decimals:state.token0.decimals},currency1:{address:state.key.currency1,symbol:state.token1.symbol,decimals:state.token1.decimals}};}
function valuationMetadataComplete(row:Record<string,unknown>|undefined,key:{currency0:string;currency1:string}){try{const value=JSON.parse(String(row?.valuation_provenance_json??'')) as {currency0?:{address?:unknown;decimals?:unknown};currency1?:{address?:unknown;decimals?:unknown}};return same(String(value.currency0?.address??''),key.currency0)&&same(String(value.currency1?.address??''),key.currency1)&&Number.isInteger(value.currency0?.decimals)&&Number(value.currency0!.decimals)>=0&&Number.isInteger(value.currency1?.decimals)&&Number(value.currency1!.decimals)>=0;}catch{return false;}}
function persistCurrentV4ValuationMetadata(repo:SqliteLedgerRepository,state:Awaited<ReturnType<typeof inspectV4PositionState>>){repo.db.prepare('UPDATE v4_positions SET owner=?,pool_id=?,pool_key_json=?,currency0=?,currency1=?,tick_lower=?,tick_upper=?,liquidity_raw=?,status=?,valuation_provenance_json=?,updated_at=? WHERE token_id=?').run(state.owner,poolId(state.key),json(state.key),state.key.currency0,state.key.currency1,state.tickLower,state.tickUpper,state.liquidity.toString(),state.liquidity>0n?'open':'closed',json(currentV4ValuationMetadata(state)),now(),state.tokenId.toString());}
export function v4ImportRangeEvidence(input:{currentTick:number;tickLower:number;tickUpper:number;poolBlock:bigint;rangeState:'below_range'|'in_range'|'above_range'}){
 const canonical=classifyV4RangeState(input.currentTick,input.tickLower,input.tickUpper);
 if(input.rangeState!==canonical)throw new Error('V4_POSITION_IMPORT_RANGE_EVIDENCE_INCONSISTENT');
 return {currentTick:input.currentTick,tickLower:input.tickLower,tickUpper:input.tickUpper,poolBlock:input.poolBlock.toString(),rangeState:canonical};
}
export async function importKnownV4Position(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;wallet:Address;tokenId:bigint;apply?:boolean;confirmed?:boolean;safetyClosed?:boolean}){
 if(input.tokenId<=0n)throw new Error('V4_POSITION_TOKEN_ID_INVALID');
 const wallet=getAddress(input.wallet),deployment=await auditRobinhoodV4Deployments(input.rpc);
 if(deployment.status==='unavailable')throw new Error(`V4_DEPLOYMENT_UNVERIFIED:${deployment.reason}`);
 const owner=await input.rpc.withClient(client=>client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.positionManager,abi:v4PositionManagerAbi,functionName:'ownerOf',args:[input.tokenId]} as any),{stage:'v4_position_import_owner',method:'PositionManager.ownerOf'}) as Address;
 if(!same(owner,wallet))throw new Error('V4_POSITION_IMPORT_OWNER_MISMATCH');
 const state=await inspectV4PositionState(input.rpc,input.tokenId),range=v4ImportRangeEvidence({currentTick:state.pool.tick,tickLower:state.tickLower,tickUpper:state.tickUpper,poolBlock:state.pool.blockNumber,rangeState:state.rangeState}),positionId=`v4:${input.tokenId}`,existing=input.repo.v4Position(input.tokenId),adoption=positionAdoption(input.repo,positionId),botManaged=shouldPreserveBotOperationalPosition(existing),metadataComplete=valuationMetadataComplete(existing,state.key),action=botManaged?'NO_OP_BOT_MANAGED':adoption?(metadataComplete?'NO_OP_ALREADY_ADOPTED':'METADATA_REPAIRED'):existing?'UPDATE':'CREATE',principal={token0:state.currentAmounts.token0.toString(),token1:state.currentAmounts.token1.toString(),valueUsd:usdValue(state,state.currentAmounts)},fees={token0:state.claimableFees.token0.toString(),token1:state.claimableFees.token1.toString(),valueUsd:usdValue(state,state.claimableFees)},preview={tokenId:input.tokenId.toString(),ownerMatch:true,poolId:poolId(state.key),pair:`${state.token0.symbol}/${state.token1.symbol}`,rangeState:range.rangeState,range,liquidity:state.liquidity.toString(),principal,claimableFees:fees,valuationMetadata:currentV4ValuationMetadata(state),expectedProvenance:botManaged?'BOT_MANAGED':adoption?'MANUAL_EXTERNAL':'MANUAL_EXTERNAL',expectedAccountingStatus:botManaged?'RECEIPT_ACCOUNTED':adoption?.accounting_status??'ADOPTED_ACCOUNTING_INCOMPLETE',historicalAccounting:'INCOMPLETE_UNAVAILABLE',applyAction:action,signingUsed:false,broadcastUsed:false,mainnetTransactionsSent:0 as const};
 if(!input.apply)return {status:'PREVIEW' as const,...preview};
 if(input.confirmed!==true)throw new Error('V4_POSITION_IMPORT_CONFIRMATION_REQUIRED');
 if(input.safetyClosed!==true)throw new Error('V4_POSITION_IMPORT_SAFETY_CLOSED_REQUIRED');
 if(botManaged||(adoption&&metadataComplete))return {status:'NO_OP' as const,...preview,positionId};
 if(adoption){persistCurrentV4ValuationMetadata(input.repo,state);return {status:'METADATA_REPAIRED' as const,...preview,positionId,accountingStatus:String(adoption.accounting_status)};}
 const latest=await input.rpc.withClient(client=>client.getBlockNumber({cacheTime:0}),{stage:'v4_position_import_latest_block',method:'eth_blockNumber'}),result=await adoptV4({repo:input.repo,rpc:input.rpc,candidate:{protocol_version:'v4',token_id:input.tokenId.toString(),manager_address:V4_ROBINHOOD_DEPLOYMENTS.positionManager,acquisition_tx_hash:`0x${'0'.repeat(64)}` as Hash,acquisition_block:latest.toString(),acquisition_log_index:0,acquisition_from:wallet,last_verified_owner:owner,ownership_verified_at:now()},wallet,latest,skipHistoricalEvidence:true});
 if(result.status!=='AUTO_ADOPTED')throw new Error('V4_POSITION_IMPORT_NOT_ADOPTED');
 return {status:'ADOPTED' as const,...preview,positionId:result.positionId,accountingStatus:result.accountingStatus};
}
async function adoptV3(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;deployments:any;candidate:Candidate;wallet:Address;latest:bigint}){
 const tokenId=BigInt(input.candidate.token_id),inspected=await inspectV3Position(input.rpc,input.deployments,tokenId);
 if(inspected.status==='unavailable'||!same(inspected.value.owner,input.wallet))return {protocol:'v3',tokenId:tokenId.toString(),status:'NOT_OWNED'};
 const position=inspected.value,mint=same(input.candidate.acquisition_from,zeroAddress)?{hash:input.candidate.acquisition_tx_hash,block:BigInt(input.candidate.acquisition_block),logIndex:input.candidate.acquisition_log_index}:await findMint({rpc:input.rpc,protocol:'v3',manager:getAddress(input.candidate.manager_address),event:v3PositionManagerAbi[3],idName:'tokenId',tokenId,latest:input.latest,fromBlock:BigInt(input.candidate.acquisition_block)}),evidence=mint?await outgoingAmounts(input.rpc,mint.hash,input.wallet,position.token0,position.token1).catch(()=>undefined):undefined,amounts=evidence?.amounts,funding=amounts?inferFunding(amounts,position.token0,position.token1):undefined,positionId=`live:${tokenId}`;
 input.repo.ensurePosition(positionId,tokenId.toString(),position.pool.address);
 input.repo.db.prepare('UPDATE positions SET pool_address=?,status=? WHERE id=?').run(position.pool.address,position.liquidity>0n?'open':'closed',positionId);
 if(mint&&amounts&&(amounts.token0>0n||amounts.token1>0n)){
  const block=await input.rpc.withClient(client=>client.getBlock({blockNumber:mint.block}));
  input.repo.ingestDeposit({id:`adopted-mint:${mint.hash}`,positionId,txHash:mint.hash,logIndex:mint.logIndex,amounts,blockNumber:mint.block,blockTimestamp:new Date(Number(block.timestamp)*1000).toISOString()});
  if(evidence)input.repo.ingestGas(positionId,mint.hash,evidence.receipt.gasUsed*evidence.receipt.effectiveGasPrice);
 }
 persistAdoption(input.repo,{positionId,protocol:'v3',tokenId,manager:getAddress(input.candidate.manager_address),accountingStatus:'ADOPTED_ACCOUNTING_INCOMPLETE',mint,amounts,funding,history:{mintReceiptFound:Boolean(mint),depositedAmountsReconstructed:Boolean(amounts),eventTimePriceUsd:null,missingValuesAreUnavailable:true,currentState:{pool:position.pool.address,liquidity:position.liquidity,tickLower:position.tickLower,tickUpper:position.tickUpper}}});
 return {protocol:'v3',tokenId:tokenId.toString(),status:'AUTO_ADOPTED',positionId,accountingStatus:'ADOPTED_ACCOUNTING_INCOMPLETE'};
}

export async function syncWalletPositions(input:{repo:SqliteLedgerRepository;readRpc:FallbackRpc;logsRpc?:FallbackRpc;wallet:Address;fromBlock?:bigint;windowSize?:bigint;maxWindows?:number;candidateLimit?:number;ownershipTtlMs?:number;nowMs?:number;deploymentCache?:{v3:any;v4:any}}){
 if(!tableExists(input.repo,'position_adoptions'))throw new Error('POSITION_ADOPTION_MIGRATION_REQUIRED');
 const wallet=getAddress(input.wallet);
 const scanRpc=input.logsRpc??input.readRpc,windowSize=input.windowSize??POSITION_SYNC_DEFAULT_WINDOW,maxWindows=input.maxWindows??POSITION_SYNC_MAX_WINDOWS;
 const [latest,v3,v4]=await Promise.all([scanRpc.withClient(client=>client.getBlockNumber({cacheTime:0})),input.deploymentCache?.v3??auditRobinhoodV3Deployments(input.readRpc),input.deploymentCache?.v4??auditRobinhoodV4Deployments(input.readRpc)]);
 if(v3.status==='unavailable')throw new Error(`V3_DEPLOYMENT_UNVERIFIED:${v3.reason}`);
 if(v4.status==='unavailable')throw new Error(`V4_DEPLOYMENT_UNVERIFIED:${v4.reason}`);
 const scans=[];
 scans.push(await scanProtocol({repo:input.repo,rpc:scanRpc,protocol:'v3',manager:v3.value.positionManager,wallet,event:v3PositionManagerAbi[3],idName:'tokenId',latest,fromBlock:input.fromBlock,windowSize,maxWindows}));
 scans.push(await scanProtocol({repo:input.repo,rpc:scanRpc,protocol:'v4',manager:V4_ROBINHOOD_DEPLOYMENTS.positionManager,wallet,event:v4PositionManagerAbi[5],idName:'id',latest,fromBlock:input.fromBlock,windowSize,maxWindows}));
 const atMs=input.nowMs??Date.now(),ttl=input.ownershipTtlMs??86_400_000,limit=Math.max(1,Math.min(input.candidateLimit??24,250)),staleBefore=new Date(atMs-ttl).toISOString();
 const candidates=input.repo.db.prepare(`SELECT * FROM wallet_position_candidates
 WHERE candidate_state IN ('DISCOVERED','OWNERSHIP_VERIFIED')
 OR (candidate_state='RETRYABLE_ERROR' AND COALESCE(retry_after_ms,0)<=?)
 OR (candidate_state IN ('ADOPTED','FINALIZED_UNOWNED','BURNED') AND (ownership_verified_at IS NULL OR ownership_verified_at<?))
 ORDER BY CASE candidate_state WHEN 'DISCOVERED' THEN 0 WHEN 'RETRYABLE_ERROR' THEN 1 ELSE 2 END,updated_at DESC LIMIT ?`).all(atMs,staleBefore,limit) as Candidate[],adopted=[],skippedFinalizedCount=Number((input.repo.db.prepare(`SELECT COUNT(*) count FROM wallet_position_candidates WHERE candidate_state IN ('ADOPTED','FINALIZED_UNOWNED','BURNED') AND ownership_verified_at>=?`).get(staleBefore) as {count:number}).count);
 const verify=async(candidate:Candidate)=>{
  try{
   const owner=await input.readRpc.withClient(client=>client.readContract({address:getAddress(candidate.manager_address),abi:candidate.protocol_version==='v4'?v4PositionManagerAbi:v3PositionManagerAbi,functionName:'ownerOf',args:[BigInt(candidate.token_id)]} as any)) as Address;
   const verifiedAt=now();input.repo.db.prepare("UPDATE wallet_position_candidates SET last_verified_owner=?,ownership_verified_at=?,candidate_state='OWNERSHIP_VERIFIED',state_reason=NULL,retry_after_ms=NULL,updated_at=? WHERE protocol_version=? AND token_id=?").run(owner,verifiedAt,verifiedAt,candidate.protocol_version,candidate.token_id);
   if(!same(owner,wallet)){input.repo.db.prepare("UPDATE wallet_position_candidates SET candidate_state='FINALIZED_UNOWNED',state_reason='OWNER_MISMATCH',updated_at=? WHERE protocol_version=? AND token_id=?").run(verifiedAt,candidate.protocol_version,candidate.token_id);return {protocol:candidate.protocol_version,tokenId:candidate.token_id,status:'NOT_OWNED'};}
   const existing=candidate.protocol_version==='v4'?input.repo.v4Position(candidate.token_id):undefined;
   if(candidate.protocol_version==='v4'&&shouldPreserveBotOperationalPosition(existing)){input.repo.db.prepare("UPDATE wallet_position_candidates SET candidate_state='ADOPTED',state_reason='BOT_OPERATIONAL_PRESERVED',updated_at=? WHERE protocol_version=? AND token_id=?").run(verifiedAt,candidate.protocol_version,candidate.token_id);return {protocol:'v4',tokenId:candidate.token_id,status:'BOT_OPERATIONAL_PRESERVED',positionId:`v4:${candidate.token_id}`};}
   const result=candidate.protocol_version==='v4'?await adoptV4({repo:input.repo,rpc:input.readRpc,candidate:{...candidate,last_verified_owner:owner},wallet,latest}):await adoptV3({repo:input.repo,rpc:input.readRpc,deployments:v3,candidate:{...candidate,last_verified_owner:owner},wallet,latest});
   input.repo.db.prepare("UPDATE wallet_position_candidates SET candidate_state='ADOPTED',state_reason=NULL,updated_at=? WHERE protocol_version=? AND token_id=?").run(now(),candidate.protocol_version,candidate.token_id);return result;
  }catch(error){const reason=error instanceof Error?error.message:String(error),retryAt=atMs+60_000;input.repo.db.prepare("UPDATE wallet_position_candidates SET candidate_state='RETRYABLE_ERROR',state_reason=?,retry_after_ms=?,updated_at=? WHERE protocol_version=? AND token_id=?").run(reason.slice(0,500),retryAt,now(),candidate.protocol_version,candidate.token_id);return {protocol:candidate.protocol_version,tokenId:candidate.token_id,status:'ADOPTION_DEFERRED',reason};}
 };
 for(let offset=0;offset<candidates.length;offset+=8){const batch=await Promise.all(candidates.slice(offset,offset+8).map(verify));adopted.push(...batch.filter(Boolean));}
 return {status:'SYNCED',wallet,scans,adopted,candidateCount:candidates.length,skippedFinalizedCount,discoveryMethod:'bounded inbound Transfer-log cursor + ownerOf verification',mainnetTransactionsSent:0};
}
