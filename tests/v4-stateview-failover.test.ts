import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FallbackRpc, robinhoodMainnet, type RpcFailoverEvent } from '@robin/core';
import { auditRobinhoodV4Deployments, inspectV4Pool, V4_ROBINHOOD_DEPLOYMENTS, type V4PoolKey } from '@robin/v4';

const key:V4PoolKey={
 currency0:'0x0000000000000000000000000000000000000001',
 currency1:'0x0000000000000000000000000000000000000002',
 fee:500,
 tickSpacing:10,
 hooks:'0x0000000000000000000000000000000000000000',
};
function healthyClient(){
 return {
  getBlockNumber:async()=>123n,
  readContract:async(input:any)=>input.functionName==='getSlot0'?[2n**96n,0,0,500]:100n,
 } as any;
}
const failedClient=(error:Error)=>({
 getBlockNumber:async()=>{throw error;},
 readContract:async()=>{throw error;},
}) as any;

describe('v4 StateView failover',()=>{
 it('retries StateView.getSlot0 on provider B after provider A returns 429 and cools only A',async()=>{
  const events:RpcFailoverEvent[]=[],failure=Object.assign(new Error('HTTP 429 Too Many Requests'),{name:'HttpRequestError',status:429});
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example']},undefined,{clients:[failedClient(failure),healthyClient()],cooldownMs:5_000,onProviderEvent:event=>events.push(event)});
  const inspected=await inspectV4Pool(rpc,key);
  expect(inspected.status).toBe('available');
  expect(inspected.status==='available'&&inspected.value.blockNumber).toBe(123n);
  expect(events).toEqual(expect.arrayContaining([
   expect.objectContaining({event:'rpc_provider_retry',providerIndex:0,stage:'v4_pool_inspection',method:'StateView.getSlot0',status:429,cooldownMs:5_000}),
   expect.objectContaining({event:'rpc_provider_selected',providerIndex:1,attempt:2}),
  ]));
 });

 it('fails over StateView.getSlot0 on timeout',async()=>{
  const timeout=Object.assign(new Error('request timed out'),{name:'HttpRequestError'});
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example']},undefined,{clients:[failedClient(timeout),healthyClient()]});
  await expect(inspectV4Pool(rpc,key)).resolves.toMatchObject({status:'available'});
  expect(rpc.metrics).toMatchObject({fallbackUses:1,failures:1});
 });

 it('does not let the adapter swallow an exhausted retryable provider failure',async()=>{
  const secret='synthetic-adapter-key',failure=Object.assign(new Error(`HTTP request failed https://one.example/${secret}`),{name:'HttpRequestError',code:'ECONNRESET'});
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example']},undefined,{clients:[failedClient(failure)]});
  let message='';try{await inspectV4Pool(rpc,key);}catch(error){message=String((error as Error).message);}
  expect(message).toContain('RPC_PROVIDER_FAILURE stage=v4_pool_inspection method=StateView.getSlot0 providerIndex=0');
  expect(message).not.toContain(secret);
  expect(message).not.toContain('https://');
 });

 it('bounds and attributes a hanging v4 deployment relationship eth_call',async()=>{
  const events:RpcFailoverEvent[]=[];
  const relationship=(input:any)=>{
   if(input.functionName==='getLiquidity')return 0n;
   if(input.functionName==='nextTokenId')return 1n;
   if(input.functionName==='permit2')return V4_ROBINHOOD_DEPLOYMENTS.permit2;
   if(input.functionName==='poolManager')return V4_ROBINHOOD_DEPLOYMENTS.poolManager;
   throw new Error('unexpected deployment probe');
  };
  const first={getChainId:async()=>4663,getBlockNumber:async()=>123n,getBytecode:async()=>'0x01',readContract:async(input:any)=>input.functionName==='getLiquidity'?new Promise(()=>{}):relationship(input)} as any;
  const second={getChainId:async()=>4663,getBlockNumber:async()=>123n,getBytecode:async()=>'0x01',readContract:async(input:any)=>relationship(input)} as any;
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example']},undefined,{clients:[first,second],attemptTimeoutMs:15,onProviderEvent:event=>events.push(event)});
  const response={ok:false,status:503,json:async()=>({}),text:async()=>''} as Response,started=Date.now(),audit=await auditRobinhoodV4Deployments(rpc.scoped({workflowId:'deployment-audit-timeout'}),async()=>response);
  expect(Date.now()-started).toBeLessThan(500);expect(audit.status).toBe('unavailable');
  expect(events).toEqual(expect.arrayContaining([
   expect.objectContaining({event:'rpc_preflight_operation_failed',stage:'v4_deployment_audit',method:'StateView.getLiquidity',providerIndex:0,terminalOutcome:'timed_out'}),
   expect.objectContaining({event:'rpc_preflight_operation_succeeded',stage:'v4_deployment_audit',method:'StateView.getLiquidity',providerIndex:1}),
  ]));
 });

 it('does not fail over StateView.getSlot0 on EVM revert',async()=>{
  let fallbackCalls=0;
  const fallback={getBlockNumber:async()=>{fallbackCalls++;return 123n;},readContract:async()=>{fallbackCalls++;return 1n;}} as any;
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example']},undefined,{clients:[failedClient(new Error('execution reverted: invalid pool')),fallback]});
  const inspected=await inspectV4Pool(rpc,key);
  expect(inspected).toMatchObject({status:'unavailable'});
  expect(fallbackCalls).toBe(0);
 });

 it('keeps every final-preflight read on FallbackRpc and the broadcast client separate',()=>{
  const executor=readFileSync('apps/cli/src/v4-rebalance-executor.ts','utf8'),adapter=readFileSync('packages/uniswap-v4-adapter/src/index.ts','utf8'),transaction=readFileSync('apps/cli/src/rebalance-transaction.ts','utf8');
  expect(executor).not.toMatch(/createPublicClient|http\(/);
  expect(adapter).not.toMatch(/createPublicClient|http\(/);
  expect(executor).toContain('input.rpc.withClient');
  expect(adapter).toContain("stage:'v4_pool_inspection'");
  expect(transaction).toMatch(/\bbroadcastSignedTransaction\s*\(/);
  expect(transaction).toMatch(/method\s*:\s*['"]eth_sendRawTransaction['"]/);
  expect(transaction).toMatch(/waitReceipt\s*\(\s*input\.rpc\s*,\s*hash\s*\)/);
 });
});
