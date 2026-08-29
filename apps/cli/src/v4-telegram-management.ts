import type { Address, WalletClient } from 'viem';
import type { FallbackRpc } from '@funi/core';
import type { SqliteLedgerRepository } from '@funi/ledger';
import { prepareV4Lifecycle, executeV4Lifecycle, type V4LifecycleAction, type V4LifecycleGasPolicy, type V4LifecycleHooks } from './v4-lifecycle.js';

export type V4TelegramActionInput={repo:SqliteLedgerRepository;rpc:FallbackRpc;walletClient:WalletClient;wallet:Address;tokenId:bigint;action:V4LifecycleAction;percent?:25|50|75;slippageBps:number;deadlineSeconds:number;userId:string;chatId:string;messageId:string;hooks?:V4LifecycleHooks;gasPolicy?:V4LifecycleGasPolicy;receiptTimeoutMs?:number;allowPublicWrites?:boolean};
export async function prepareV4TelegramManagement(input:V4TelegramActionInput){
  const prepared=await prepareV4Lifecycle(input),idempotencyKey=`telegram-v4:${input.chatId}:${input.messageId}:${input.tokenId}:${input.action}:${input.percent??0}`;
  const intent=input.repo.createV4LifecycleIntent({tokenId:input.tokenId,action:input.action,idempotencyKey,payload:{telegram:{userId:input.userId,chatId:input.chatId,messageId:input.messageId},percent:input.percent,slippageBps:input.slippageBps,preview:{liquidity:prepared.removedLiquidity,principal:prepared.principal,calldataHash:prepared.plan.calldataHash}}});
  return {intentId:String(intent.id),idempotencyKey,tokenId:input.tokenId,action:input.action,percent:input.percent,liquidity:prepared.removedLiquidity,amountMinimums:{amount0:prepared.plan.amount0Min,amount1:prepared.plan.amount1Min},calldataHash:prepared.plan.calldataHash,confirmationButton:`v4-confirm:${String(intent.id)}`};
}
export async function confirmV4TelegramManagement(input:Omit<V4TelegramActionInput,'messageId'>&{intentId:string}){
  const intent=input.repo.v4LifecycleIntent(input.intentId);if(!intent)return {ok:false as const,status:'INVALID_INTENT' as const};
  let payload:any;try{payload=JSON.parse(String(intent.payload_json));}catch{return {ok:false as const,status:'INVALID_INTENT' as const};}
  if(payload.telegram?.userId!==input.userId||payload.telegram?.chatId!==input.chatId)return {ok:false as const,status:'INVALID_OWNER' as const};
  const result=await executeV4Lifecycle({...input,idempotencyKey:String(intent.idempotency_key),deferReconciliation:true});
  if(input.action!=='full_close'||(!result.ok&&!result.closeConfirmed))return result;
  const burn=await executeV4Lifecycle({...input,action:'burn',percent:undefined,idempotencyKey:`${String(intent.idempotency_key)}:burn`});
  if(!burn.ok)return {...burn,fullClose:result};
  return result.ok?{...result,burn,status:result.status==='ECONOMIC_CONFIRMED_RECONCILIATION_PENDING'?result.status:'COMPLETED'}:{...result,burn};
}
