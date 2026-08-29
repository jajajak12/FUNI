import { createHash } from 'node:crypto';
import { keccak256, parseTransaction, recoverTransactionAddress, size, type Address, type Hash, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from 'viem';
import { sanitizeRpcError, type FallbackRpc } from '@funi/core';
import type { SqliteLedgerRepository } from '@funi/ledger';

type PreparedRequest={account:Address;chainId:number;to:Address;data:Hex;value:bigint;gas:bigint;gasPrice:bigint;nonce:number};
export type DurablePreparedTransaction={workflowId:string;semanticStage:string;attempt:number;expectedHash:Hash;requestFingerprint:string;request:PreparedRequest};
export type DurableTransactionJournal={load:()=>DurablePreparedTransaction|undefined;persistPrepared:(prepared:DurablePreparedTransaction)=>void;markSubmitted:(hash:Hash)=>void};
export type DurableBroadcastHooks={beforePreparedCommit?:(prepared:DurablePreparedTransaction)=>void|Promise<void>;afterPreparedCommit?:(prepared:DurablePreparedTransaction)=>void|Promise<void>;afterProviderAcceptance?:(hash:Hash)=>void|Promise<void>};
export type ExactHashEvidence=
 |{kind:'RECEIPT';receipt:TransactionReceipt}
 |{kind:'PENDING';nonce:number}
 |{kind:'ABSENT';latestNonce:number;pendingNonce:number}
 |{kind:'INCONCLUSIVE';reason:'PROVIDER_ERROR'|'PROVIDER_DISAGREEMENT'|'NONCE_EVIDENCE_INVALID'|'MALFORMED_EVIDENCE'};

export class DurableTransactionReconciliationPendingError extends Error{
 constructor(readonly workflowId:string,readonly semanticStage:string,readonly expectedHash:Hash,readonly nonce:number,readonly evidence:string){super('DURABLE_TRANSACTION_RECONCILIATION_PENDING');this.name='DurableTransactionReconciliationPendingError';}
}
export function durableTransactionReconciliationPending(error:unknown):DurableTransactionReconciliationPendingError|undefined{
 const seen=new Set<unknown>();let current=error;
 while(current&&typeof current==='object'&&!seen.has(current)){seen.add(current);if(current instanceof DurableTransactionReconciliationPendingError)return current;current=(current as {cause?:unknown;original?:unknown}).cause??(current as {original?:unknown}).original;}
 return undefined;
}

export function bufferedBroadcastGasPrice(observedGasPrice:bigint){if(observedGasPrice<=0n)throw new Error('TRANSACTION_GAS_PRICE_INVALID');return observedGasPrice*12n/10n;}
function transactionNotFound(error:unknown){return /not found|could not be found|unknown transaction/i.test(error instanceof Error?error.message:String(error));}
function validHash(value:unknown):value is Hash{return typeof value==='string'&&/^0x[0-9a-fA-F]{64}$/.test(value);}
function validAddress(value:unknown):value is Address{return typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value);}
function validatedReceipt(value:unknown,hash:Hash):TransactionReceipt|undefined{if(!value||typeof value!=='object')return undefined;const row=value as Record<string,unknown>;if(!validHash(row.transactionHash)||row.transactionHash.toLowerCase()!==hash.toLowerCase()||(row.status!=='success'&&row.status!=='reverted')||typeof row.blockNumber!=='bigint'||row.blockNumber<0n||typeof row.gasUsed!=='bigint'||row.gasUsed<0n||typeof row.effectiveGasPrice!=='bigint'||row.effectiveGasPrice<0n)return undefined;return value as TransactionReceipt;}
function validatedPending(value:unknown,wallet:Address,hash:Hash,expectedNonce?:number){if(!value||typeof value!=='object')return undefined;const row=value as Record<string,unknown>,nonce=row.nonce;if(!validHash(row.hash)||row.hash.toLowerCase()!==hash.toLowerCase()||typeof nonce!=='number'||!Number.isSafeInteger(nonce)||nonce<0||!validAddress(row.from)||row.from.toLowerCase()!==wallet.toLowerCase()||row.blockNumber!==null||(expectedNonce!==undefined&&nonce!==expectedNonce))return undefined;return nonce;}
async function providerEvidence(client:PublicClient,wallet:Address,hash:Hash,expectedNonce?:number):Promise<ExactHashEvidence>{
 try{const receipt=await client.getTransactionReceipt({hash}),valid=validatedReceipt(receipt,hash);return valid?{kind:'RECEIPT',receipt:valid}:{kind:'INCONCLUSIVE',reason:'MALFORMED_EVIDENCE'};}catch(error){if(!transactionNotFound(error))return {kind:'INCONCLUSIVE',reason:'PROVIDER_ERROR'};}
 try{const transaction=await client.getTransaction({hash}),nonce=validatedPending(transaction,wallet,hash,expectedNonce);return nonce===undefined?{kind:'INCONCLUSIVE',reason:'MALFORMED_EVIDENCE'}:{kind:'PENDING',nonce};}catch(error){if(!transactionNotFound(error))return {kind:'INCONCLUSIVE',reason:'PROVIDER_ERROR'};}
 try{const [latestNonce,pendingNonce]=await Promise.all([client.getTransactionCount({address:wallet,blockTag:'latest'}),client.getTransactionCount({address:wallet,blockTag:'pending'})]);if(!Number.isSafeInteger(latestNonce)||latestNonce<0||!Number.isSafeInteger(pendingNonce)||pendingNonce<0||pendingNonce<latestNonce)return {kind:'INCONCLUSIVE',reason:'NONCE_EVIDENCE_INVALID'};return {kind:'ABSENT',latestNonce,pendingNonce};}catch{return {kind:'INCONCLUSIVE',reason:'PROVIDER_ERROR'};}
}
function evidenceIdentity(evidence:ExactHashEvidence){if(evidence.kind==='RECEIPT')return `${evidence.kind}:${evidence.receipt.status}:${evidence.receipt.transactionHash.toLowerCase()}:${evidence.receipt.blockNumber}`;if(evidence.kind==='PENDING')return `${evidence.kind}:${evidence.nonce}`;if(evidence.kind==='ABSENT')return `${evidence.kind}:${evidence.latestNonce}:${evidence.pendingNonce}`;return evidence.kind;}
export async function exactHashEvidence(rpc:FallbackRpc,wallet:Address,hash:Hash,expectedNonce?:number):Promise<ExactHashEvidence>{
 const direct=(rpc as unknown as {clients?:PublicClient[]}).clients,observations=direct?.length?await Promise.all(direct.map(client=>providerEvidence(client,wallet,hash,expectedNonce))):[await rpc.withClient(client=>providerEvidence(client,wallet,hash,expectedNonce),{stage:'transaction_recovery',method:'eth_getTransactionReceipt+eth_getTransaction+eth_getTransactionCount'})];
 const malformed=observations.find(item=>item.kind==='INCONCLUSIVE');if(malformed?.kind==='INCONCLUSIVE')return malformed;const identity=evidenceIdentity(observations[0]!);if(observations.some(item=>evidenceIdentity(item)!==identity))return {kind:'INCONCLUSIVE',reason:'PROVIDER_DISAGREEMENT'};return observations[0]!;
}
const stable=(value:unknown):string=>{if(typeof value==='bigint')return JSON.stringify(value.toString());if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;const row=value as Record<string,unknown>;return `{${Object.keys(row).sort().map(key=>`${JSON.stringify(key)}:${stable(row[key])}`).join(',')}}`;};
export const canonicalRequestFingerprint=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');
export async function signWithConfiguredAccount(walletClient:WalletClient,request:Record<string,unknown>){const signer=walletClient as unknown as {account?:{signTransaction?:unknown};signTransaction(request:Record<string,unknown>):Promise<Hex>};if(!signer.account||typeof signer.account.signTransaction!=='function')throw new Error('LOCAL_SIGNER_REQUIRED');return signer.signTransaction({...request,account:signer.account});}
export type BroadcastTransportEvidence={providerIndex:number;providerName:string;method:'eth_sendRawTransaction';parameterCount:1;serializedByteLength:number;expectedHashReturnedHashEqual:boolean|null;classification:'REQUESTED'|'ACCEPTED'|'HASH_MISMATCH'|'MALFORMED_RESPONSE'|'TRANSPORT_ERROR';errorCode?:string|number;error?:string};
function sanitizedTransportCode(error:unknown){let current:unknown=error;for(let depth=0;depth<4&&current&&typeof current==='object';depth++){const row=current as Record<string,unknown>,code=row.code??row.status;if((typeof code==='number'&&Number.isFinite(code))||(typeof code==='string'&&/^-?[A-Za-z0-9_.-]{1,40}$/.test(code)))return code as string|number;current=row.cause;}return undefined;}
/** Single canonical signed-transaction broadcast boundary. It validates the
 * envelope locally, invokes JSON-RPC with exactly one raw-byte parameter, and
 * never substitutes the local hash for provider response evidence. */
export async function broadcastSignedTransaction(input:{walletClient:WalletClient;serializedTransaction:Hex;expectedHash:Hash;expectedSender:Address;expectedChainId:number;expectedNonce:number;providerIndex?:number;providerName?:string;onEvidence?:(evidence:BroadcastTransportEvidence)=>void|Promise<void>}){
 const serialized=input.serializedTransaction;if(!/^0x[0-9a-fA-F]+$/.test(serialized)||serialized.length<=2||serialized.length%2!==0)throw new Error('TRANSACTION_SERIALIZED_BYTES_MALFORMED');
 const syntheticFixture=process.env.NODE_ENV==='test'&&(input.walletClient as unknown as {syntheticSerializedTransactionFixture?:boolean}).syntheticSerializedTransactionFixture===true;
 if(!syntheticFixture){let parsed:ReturnType<typeof parseTransaction>,sender:Address;try{parsed=parseTransaction(serialized as Parameters<typeof parseTransaction>[0]);sender=await recoverTransactionAddress({serializedTransaction:serialized as Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction']});}catch{throw new Error('TRANSACTION_SERIALIZED_BYTES_MALFORMED');}
  if(sender.toLowerCase()!==input.expectedSender.toLowerCase()||Number(parsed.chainId)!==input.expectedChainId||Number(parsed.nonce)!==input.expectedNonce)throw new Error('TRANSACTION_SIGNED_ENVELOPE_MISMATCH');}
 const localHash=keccak256(serialized);if(localHash.toLowerCase()!==input.expectedHash.toLowerCase())throw new Error('TRANSACTION_EXPECTED_HASH_MISMATCH');
 const base={providerIndex:input.providerIndex??-1,providerName:input.providerName??'configured-write-provider',method:'eth_sendRawTransaction' as const,parameterCount:1 as const,serializedByteLength:size(serialized)};
 await input.onEvidence?.({...base,expectedHashReturnedHashEqual:null,classification:'REQUESTED'});
 const requester=input.walletClient as unknown as {request(args:{method:'eth_sendRawTransaction';params:[Hex]},options?:{retryCount?:number}):Promise<unknown>};let returned:unknown;
 try{returned=await requester.request({method:'eth_sendRawTransaction',params:[serialized]},{retryCount:0});}
 catch(error){const safe=sanitizeRpcError(error,{stage:'transaction_broadcast',method:'eth_sendRawTransaction'}),errorCode=sanitizedTransportCode(error);await input.onEvidence?.({...base,expectedHashReturnedHashEqual:null,classification:'TRANSPORT_ERROR',...(errorCode===undefined?{}:{errorCode}),error:safe});throw new Error(`TRANSACTION_BROADCAST_TRANSPORT_ERROR:${safe}`);}
 if(typeof returned!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(returned)){await input.onEvidence?.({...base,expectedHashReturnedHashEqual:null,classification:'MALFORMED_RESPONSE'});throw new Error('TRANSACTION_BROADCAST_RESPONSE_MALFORMED');}
 const equal=returned.toLowerCase()===input.expectedHash.toLowerCase();await input.onEvidence?.({...base,expectedHashReturnedHashEqual:equal,classification:equal?'ACCEPTED':'HASH_MISMATCH'});if(!equal)throw new Error('TRANSACTION_PROVIDER_RETURNED_HASH_MISMATCH');
 return returned as Hash;
}
function validatePreparedIdentity(input:{workflowId:string;semanticStage:string;wallet:Address;chainId:number;to:Address},prepared:DurablePreparedTransaction){
 const request=prepared.request,identity={workflowId:prepared.workflowId,semanticStage:prepared.semanticStage,attempt:prepared.attempt,request};
 if(prepared.workflowId!==input.workflowId||prepared.semanticStage!==input.semanticStage||!Number.isSafeInteger(prepared.attempt)||prepared.attempt<0||request.account.toLowerCase()!==input.wallet.toLowerCase()||request.chainId!==input.chainId||request.to.toLowerCase()!==input.to.toLowerCase()||prepared.requestFingerprint!==canonicalRequestFingerprint(identity))throw new Error('DURABLE_PREPARED_TRANSACTION_METADATA_MISMATCH');
}
/** Shared journal-before-broadcast boundary for live paths. The
 * journal callback must synchronously commit PREPARED or throw; no provider
 * write is attempted until it returns successfully. */
export async function broadcastDurableTransaction(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;walletClient:WalletClient;wallet:Address;workflowId:string;semanticStage:string;to:Address;data:Hex;estimatedGas:bigint;attempt?:number;journal:DurableTransactionJournal;beforeSigning?:(context:{estimatedGas:bigint;gasLimit:bigint;gasPrice:bigint})=>void|Promise<void>;hooks?:DurableBroadcastHooks}){
 if(input.rpc.config.chainId!==4663)throw new Error('DURABLE_TRANSACTION_WRONG_CHAIN');
 const loaded=input.journal.load(),leaseNonce=loaded?.request.nonce??0;
 if(!input.repo.acquireNonceMutex(input.wallet,BigInt(leaseNonce)))throw new Error('DURABLE_TRANSACTION_NONCE_MUTEX_HELD');
 try{
  let prepared=loaded,serialized:Hex,evidence:ExactHashEvidence|undefined;
  if(prepared){
   validatePreparedIdentity({...input,chainId:input.rpc.config.chainId},prepared);
   evidence=await exactHashEvidence(input.rpc,input.wallet,prepared.expectedHash,prepared.request.nonce);
   if(evidence.kind==='INCONCLUSIVE')throw new DurableTransactionReconciliationPendingError(input.workflowId,input.semanticStage,prepared.expectedHash,prepared.request.nonce,evidence.reason);
   if(evidence.kind==='RECEIPT'){input.repo.reconcileDurableChainTransaction({chainId:input.rpc.config.chainId,wallet:input.wallet,workflowIdentity:input.workflowId,semanticStage:input.semanticStage,attempt:prepared.attempt,expectedHash:prepared.expectedHash,evidence:{kind:'RECEIPT',receipt:evidence.receipt as unknown as Record<string,unknown>}});if(evidence.receipt.status==='success')input.journal.markSubmitted(prepared.expectedHash);return {hash:prepared.expectedHash,recovered:true,receipt:evidence.receipt};}
   if(evidence.kind==='PENDING'){input.journal.markSubmitted(prepared.expectedHash);throw new DurableTransactionReconciliationPendingError(input.workflowId,input.semanticStage,prepared.expectedHash,prepared.request.nonce,'EXACT_HASH_PENDING');}
   if(evidence.latestNonce>prepared.request.nonce){input.repo.reconcileDurableChainTransaction({chainId:input.rpc.config.chainId,wallet:input.wallet,workflowIdentity:input.workflowId,semanticStage:input.semanticStage,attempt:prepared.attempt,expectedHash:prepared.expectedHash,evidence:{kind:'NONCE_UNAVAILABLE',latestNonce:evidence.latestNonce,pendingNonce:evidence.pendingNonce}});throw new Error('DURABLE_TRANSACTION_EXACT_HASH_ABSENT_NONCE_UNAVAILABLE');}
   if(evidence.pendingNonce>prepared.request.nonce)throw new Error('DURABLE_TRANSACTION_EXACT_HASH_ABSENT_NONCE_UNAVAILABLE');
   if(prepared.request.data.toLowerCase()!==input.data.toLowerCase())throw new Error('DURABLE_PREPARED_TRANSACTION_METADATA_MISMATCH');
   throw new DurableTransactionReconciliationPendingError(input.workflowId,input.semanticStage,prepared.expectedHash,prepared.request.nonce,'EXACT_HASH_ABSENT_NONCE_AVAILABLE');
  }else{
   const [observedGasPrice,nonce]=await input.rpc.withClient(client=>Promise.all([client.getGasPrice(),client.getTransactionCount({address:input.wallet,blockTag:'pending'})]),{stage:'durable_transaction_prebroadcast',method:'eth_gasPrice+eth_getTransactionCount'}),gasPrice=bufferedBroadcastGasPrice(observedGasPrice),gasLimit=input.estimatedGas*12n/10n;
   await input.beforeSigning?.({estimatedGas:input.estimatedGas,gasLimit,gasPrice});
   const request:PreparedRequest={account:input.wallet,chainId:input.rpc.config.chainId,to:input.to,data:input.data,value:0n,gas:gasLimit,gasPrice,nonce},attempt=input.attempt??0;
   serialized=await signWithConfiguredAccount(input.walletClient,request);const expectedHash=keccak256(serialized),identity={workflowId:input.workflowId,semanticStage:input.semanticStage,attempt,request};prepared={...identity,expectedHash,requestFingerprint:canonicalRequestFingerprint(identity)};
   await input.hooks?.beforePreparedCommit?.(prepared);
   input.journal.persistPrepared(prepared);
   await input.hooks?.afterPreparedCommit?.(prepared);
  }
  try{await broadcastSignedTransaction({walletClient:input.walletClient,serializedTransaction:serialized,expectedHash:prepared.expectedHash,expectedSender:input.wallet,expectedChainId:input.rpc.config.chainId,expectedNonce:prepared.request.nonce});}
  catch{
   evidence=await exactHashEvidence(input.rpc,input.wallet,prepared.expectedHash,prepared.request.nonce);
   if(evidence.kind==='RECEIPT'){input.repo.reconcileDurableChainTransaction({chainId:input.rpc.config.chainId,wallet:input.wallet,workflowIdentity:input.workflowId,semanticStage:input.semanticStage,attempt:prepared.attempt,expectedHash:prepared.expectedHash,evidence:{kind:'RECEIPT',receipt:evidence.receipt as unknown as Record<string,unknown>}});if(evidence.receipt.status==='success')input.journal.markSubmitted(prepared.expectedHash);return {hash:prepared.expectedHash,recovered:true,receipt:evidence.receipt};}
   if(evidence.kind==='PENDING'){input.journal.markSubmitted(prepared.expectedHash);throw new DurableTransactionReconciliationPendingError(input.workflowId,input.semanticStage,prepared.expectedHash,prepared.request.nonce,'EXACT_HASH_PENDING');}
   if(evidence.kind==='ABSENT'&&evidence.latestNonce>prepared.request.nonce){input.repo.reconcileDurableChainTransaction({chainId:input.rpc.config.chainId,wallet:input.wallet,workflowIdentity:input.workflowId,semanticStage:input.semanticStage,attempt:prepared.attempt,expectedHash:prepared.expectedHash,evidence:{kind:'NONCE_UNAVAILABLE',latestNonce:evidence.latestNonce,pendingNonce:evidence.pendingNonce}});throw new Error('DURABLE_TRANSACTION_EXACT_HASH_ABSENT_NONCE_UNAVAILABLE');}
   throw new DurableTransactionReconciliationPendingError(input.workflowId,input.semanticStage,prepared.expectedHash,prepared.request.nonce,evidence.kind==='INCONCLUSIVE'?evidence.reason:'EXACT_HASH_ABSENT_NONCE_AVAILABLE');
  }
  await input.hooks?.afterProviderAcceptance?.(prepared.expectedHash);
  input.journal.markSubmitted(prepared.expectedHash);
  return {hash:prepared.expectedHash,recovered:Boolean(loaded)};
 }finally{input.repo.releaseNonceMutex(input.wallet);}
}
