import { getAddress, type Address } from 'viem';
import type { FallbackRpc } from '@funi/core';
import type { SqliteLedgerRepository } from '@funi/ledger';
import { completeEconomicReconciliationWork, discoverMissingEconomicReconciliationWork, leaseEconomicReconciliationWork, retryEconomicReconciliationWork } from './economic-reconciliation-work.js';
import { reconcileDurableV4Journals } from './v4-durable-journal-reconcile.js';
import { persistConfirmedV4OperationalOpenProjection } from './v4-operational-executor.js';
import { reconcileConfirmedV4Lifecycle } from './v4-lifecycle.js';

function failureCode(error:unknown){return error instanceof Error?error.message:String(error);}
function completeOperationalOpen(repo:SqliteLedgerRepository,intentId:string){const projection=persistConfirmedV4OperationalOpenProjection(repo,intentId),positionId=`v4:${projection.tokenId}`;for(const gas of repo.v4LiveGas().filter(row=>String(row.intent_id)===intentId&&row.actual_eth_raw!==null)){repo.ingestGas(positionId,String(gas.tx_hash),BigInt(String(gas.actual_eth_raw)));repo.db.prepare('UPDATE gas_costs SET usd_value=? WHERE tx_hash=?').run(Number(gas.actual_usd),String(gas.tx_hash));}repo.transitionV4LiveOpenIntent(intentId,'POSITION_RECONCILED',{tokenId:projection.tokenId.toString(),details:{economicReconciliationWork:true}});return projection;}
function lifecycleWallet(repo:SqliteLedgerRepository,intentId:string){const row=repo.db.prepare('SELECT p.owner FROM v4_lifecycle_intents i JOIN v4_positions p ON p.token_id=i.token_id WHERE i.id=?').get(intentId) as {owner:string}|undefined;if(!row)throw new Error('V4_LIFECYCLE_WALLET_MISSING');return getAddress(row.owner);}

/** Canonical reconciliation-owner cycle. No wallet client or signing primitive
 * is accepted by this API, so retries cannot acquire execution authority. */
export async function runEconomicReconciliationCycle(input:{repo:SqliteLedgerRepository;rpc:FallbackRpc;owner?:string;nowMs?:number;limit?:number}){
 const now=input.nowMs??Date.now(),owner=input.owner??`funi-reconcile:${process.pid}`,discovery=discoverMissingEconomicReconciliationWork(input.repo,now),leased=leaseEconomicReconciliationWork(input.repo,{owner,limit:input.limit??8,leaseMs:120_000,nowMs:now}),results:Array<Record<string,unknown>>=[];
 for(const work of leased){const id=String(work.work_id),kind=String(work.workflow_kind);try{let reconciliation:unknown;if(kind.startsWith('V4_BID_LADDER_')){const result=await reconcileDurableV4Journals({repo:input.repo,rpc:input.rpc,limit:64,journalIds:[String(work.source_identity)]}),outcome=String((result.results[0] as any)?.outcome??'');if(outcome==='UNRESOLVED'){retryEconomicReconciliationWork(input.repo,{workId:id,owner,errorCode:'EXACT_HASH_RECEIPT_UNRESOLVED',nowMs:now});results.push({workId:id,status:'RETRYABLE',outcome});continue;}if(outcome==='FINALIZATION_FAILED')throw new Error(String((result.results[0] as any)?.error??outcome));if(outcome==='FAILED'){retryEconomicReconciliationWork(input.repo,{workId:id,owner,errorCode:String((result.results[0] as any)?.failureReason??'TRANSACTION_FAILED'),terminal:true,nowMs:now});results.push({workId:id,status:'FAILED_CLOSED',outcome});continue;}reconciliation=result;}
   else if(kind==='V4_OPERATIONAL_OPEN')reconciliation=completeOperationalOpen(input.repo,String(work.workflow_identity));
   else if(kind==='V4_GENERIC_CLOSE'||kind==='V4_GENERIC_CLAIM')reconciliation=await reconcileConfirmedV4Lifecycle({repo:input.repo,rpc:input.rpc,intentId:String(work.workflow_identity),wallet:lifecycleWallet(input.repo,String(work.workflow_identity)) as Address});
   else throw new Error('ECONOMIC_RECONCILIATION_KIND_UNSUPPORTED');
   if(!completeEconomicReconciliationWork(input.repo,{workId:id,owner,nowMs:Date.now()}))throw new Error('ECONOMIC_RECONCILIATION_LEASE_LOST');results.push({workId:id,status:'COMPLETED',reconciliation});
  }catch(error){retryEconomicReconciliationWork(input.repo,{workId:id,owner,errorCode:failureCode(error),nowMs:Date.now()});results.push({workId:id,status:'RETRYABLE',error:failureCode(error)});}}
 return {discovery,leased:leased.length,results,signingAttempts:0 as const,broadcasts:0 as const,mainnetTransactionsSent:0 as const};
}
