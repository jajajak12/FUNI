import { describe, expect, it, vi } from 'vitest';
import { discoverV3Pools, FallbackRpc, orderedRpcUrls, robinhoodMainnet, sanitizeRpcError, type RpcFailoverEvent } from '@funi/core';

const client=(work:()=>Promise<unknown>)=>({getChainId:async()=>4663,read:work}) as any;
const retryable=(message:string)=>Object.assign(new Error(message),{name:'HttpRequestError'});

describe('bounded RPC failover',()=>{
 it('prefers ALCHEMY_RPC_URLS in order and retains the legacy single URL',()=>{
 expect(orderedRpcUrls(' https://one.example ,https://two.example ','https://legacy.example')).toEqual(['https://one.example','https://two.example']);
  expect(orderedRpcUrls(undefined,'https://legacy.example')).toEqual(['https://legacy.example']);
 });
 it('parses every non-empty configured URL in order',()=>{
  expect(orderedRpcUrls('https://one.example, ,https://two.example,https://three.example,')).toEqual(['https://one.example','https://two.example','https://three.example']);
 });
 it('supports one configured endpoint',async()=>{
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example']},undefined,{clients:[client(async()=>42)]});
  await expect(rpc.withClient(c=>(c as any).read())).resolves.toBe(42);
 });
 it.each(['HTTP 429 Too Many Requests','request timed out','fetch failed ECONNRESET'])('cools down and retries a retryable failure: %s',async message=>{
  let primaryReads=0,secondaryReads=0,clock=0;
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example']},undefined,{clients:[client(async()=>{primaryReads++;throw retryable(message)}),client(async()=>{secondaryReads++;return 'healthy';})],cooldownMs:1_000,now:()=>clock});
  await expect(rpc.withClient(c=>(c as any).read())).resolves.toBe('healthy');
  await expect(rpc.withClient(c=>(c as any).read())).resolves.toBe('healthy');
  expect(primaryReads).toBe(1);expect(secondaryReads).toBe(2);
  clock=1_000;
  await expect(rpc.withClient(c=>(c as any).read())).resolves.toBe('healthy');
 expect(primaryReads).toBe(2);
 });
 it('classifies viem low-level request failures and retains final-preflight operation attribution',async()=>{
  const secret='synthetic-operation-key',events:RpcFailoverEvent[]=[];
  const cause=Object.assign(new Error(`HTTP request failed. https://provider.example/${secret}`),{name:'HttpRequestError',code:'ECONNRESET'});
  const wrapped=Object.assign(new Error('An unknown RPC error occurred.'),{name:'UnknownRpcError',cause});
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example']},undefined,{clients:[
   client(async()=>{throw wrapped;}),
   client(async()=>55n),
  ],onProviderEvent:event=>events.push(event)});
  await expect(rpc.withClient(c=>(c as any).read(),{workflowId:'workflow-safe',stage:'wallet_balance_preflight',method:'ERC20.balanceOf'})).resolves.toBe(55n);
  expect(events).toEqual(expect.arrayContaining([
   expect.objectContaining({event:'rpc_preflight_operation_started',workflowId:'workflow-safe',providerIndex:0,attempt:1,stage:'wallet_balance_preflight',method:'ERC20.balanceOf'}),
   expect.objectContaining({event:'rpc_preflight_operation_failed',workflowId:'workflow-safe',providerIndex:0,retryable:true,outcome:'failover',errorClass:'UnknownRpcError'}),
   expect.objectContaining({event:'rpc_preflight_operation_succeeded',workflowId:'workflow-safe',providerIndex:1,attempt:2,outcome:'selected'}),
  ]));
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(events)).not.toContain('https://');
 });
 it('bounds a never-settling provider attempt, aborts it, cools it, and succeeds on provider 1',async()=>{
  const events:RpcFailoverEvent[]=[];let signal:AbortSignal|undefined,secondary=0;
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example']},undefined,{clients:[
   client(()=>new Promise(()=>{})),
   client(async()=>{secondary++;return 'recovered';}),
  ],attemptTimeoutMs:15,cooldownMs:1_000,onProviderEvent:event=>events.push(event)});
  await expect(rpc.withClient((c,attempt)=>{if(attempt.providerIndex===0)signal=attempt.signal;return (c as any).read();},{workflowId:'hung-workflow',stage:'v4_deployment_audit',method:'StateView.getLiquidity'})).resolves.toBe('recovered');
  expect(signal?.aborted).toBe(true);expect(secondary).toBe(1);
  expect(events).toEqual(expect.arrayContaining([
   expect.objectContaining({event:'rpc_preflight_operation_failed',providerIndex:0,terminalOutcome:'timed_out',retryable:true,outcome:'failover'}),
   expect.objectContaining({event:'rpc_provider_retry',providerIndex:0,outcome:'cooldown'}),
   expect.objectContaining({event:'rpc_preflight_operation_succeeded',providerIndex:1,terminalOutcome:'succeeded'}),
  ]));
 });
 it('times out two never-settling providers before provider 2 succeeds',async()=>{
  const events:RpcFailoverEvent[]=[];
  const never=client(()=>new Promise(()=>{})),rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example','https://three.example']},undefined,{clients:[never,never,client(async()=>3)],attemptTimeoutMs:10,onProviderEvent:event=>events.push(event)});
  await expect(rpc.withClient(c=>(c as any).read(),{workflowId:'three-provider-hang',stage:'gas_preflight',method:'eth_gasPrice'})).resolves.toBe(3);
  expect(events.filter(event=>event.event==='rpc_preflight_operation_failed').map(event=>[event.providerIndex,event.terminalOutcome])).toEqual([[0,'timed_out'],[1,'timed_out']]);
  expect(events).toContainEqual(expect.objectContaining({event:'rpc_preflight_operation_succeeded',providerIndex:2,attempt:3}));
 });
 it('gives every started hanging attempt exactly one terminal event when all providers time out',async()=>{
  const events:RpcFailoverEvent[]=[],never=client(()=>new Promise(()=>{})),rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example','https://three.example']},undefined,{clients:[never,never,never],attemptTimeoutMs:10,onProviderEvent:event=>events.push(event)});
  await expect(rpc.withClient(c=>(c as any).read(),{workflowId:'all-hung',stage:'wallet_balance_preflight',method:'ERC20.balanceOf'})).rejects.toThrow('RPC_PROVIDER_FAILURE stage=wallet_balance_preflight method=ERC20.balanceOf');
  const started=events.filter(event=>event.event==='rpc_preflight_operation_started'),terminals=events.filter(event=>event.event==='rpc_preflight_operation_succeeded'||event.event==='rpc_preflight_operation_failed');
  expect(started).toHaveLength(3);expect(terminals).toHaveLength(3);
  for(const start of started)expect(terminals.filter(event=>event.providerIndex===start.providerIndex&&event.attempt===start.attempt)).toHaveLength(1);
  expect(terminals.every(event=>event.terminalOutcome==='timed_out')).toBe(true);
 });
 it('propagates the attempt abort signal into the real HTTP transport',async()=>{
  let transportSignal:AbortSignal|undefined;
  const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation((_,init)=>new Promise((_,reject)=>{transportSignal=init?.signal as AbortSignal;transportSignal?.addEventListener('abort',()=>reject(transportSignal?.reason),{once:true});}));
  try{const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://transport.example']},undefined,{attemptTimeoutMs:15,timeoutMs:1_000});await expect(rpc.withClient(client=>client.getBlockNumber(),{workflowId:'transport-abort',stage:'block_preflight',method:'eth_blockNumber'})).rejects.toThrow('RPC_PROVIDER_FAILURE');expect(transportSignal?.aborted).toBe(true);}
  finally{fetchMock.mockRestore();}
 });
 it('rotates across three endpoints, skips both cooled endpoints, and safely re-admits them',async()=>{
  let clock=0,one=0,two=0,three=0;const events:RpcFailoverEvent[]=[];
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example','https://three.example']},undefined,{clients:[
   client(async()=>{one++;if(one===1)throw Object.assign(new Error('HTTP 429 synthetic-key-should-never-log'),{name:'HttpRequestError',status:429});return 'one-recovered';}),
   client(async()=>{two++;throw retryable('request timed out synthetic-key-should-never-log');}),
   client(async()=>{three++;return 'three-healthy';}),
  ],cooldownMs:1_000,now:()=>clock,onProviderEvent:event=>events.push(event)});
  await expect(rpc.withClient(c=>(c as any).read(),{stage:'v4_pool_inspection',method:'StateView.getSlot0'})).resolves.toBe('three-healthy');
  expect([one,two,three]).toEqual([1,1,1]);
  await expect(rpc.withClient(c=>(c as any).read(),{stage:'v4_pool_inspection',method:'StateView.getSlot0'})).resolves.toBe('three-healthy');
  expect([one,two,three]).toEqual([1,1,2]);
  clock=1_000;
  await expect(rpc.withClient(c=>(c as any).read(),{stage:'v4_pool_inspection',method:'StateView.getSlot0'})).resolves.toBe('one-recovered');
  expect([one,two,three]).toEqual([2,1,2]);
  expect(events).toEqual(expect.arrayContaining([
   expect.objectContaining({event:'rpc_provider_retry',providerIndex:0,attempt:1,status:429,cooldownMs:1_000,outcome:'cooldown'}),
   expect.objectContaining({event:'rpc_provider_retry',providerIndex:1,attempt:2,cooldownMs:1_000,outcome:'cooldown'}),
   expect.objectContaining({event:'rpc_provider_selected',providerIndex:2,attempt:3,outcome:'selected'}),
  ]));
  expect(JSON.stringify(events)).not.toContain('synthetic-key-should-never-log');
  expect(JSON.stringify(events)).not.toContain('https://');
 });
 it('returns a sanitized terminal error when every configured endpoint is unavailable',async()=>{
  const secret='synthetic-api-key-123',events:RpcFailoverEvent[]=[];
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example']},undefined,{clients:[
   client(async()=>{throw Object.assign(new Error(`HTTP 503 https://one.example/${secret}`),{name:'HttpRequestError',status:503});}),
   client(async()=>{throw retryable(`provider unavailable https://two.example/${secret}`);}),
  ],onProviderEvent:event=>events.push(event)});
  let message='';try{await rpc.withClient(c=>(c as any).read(),{stage:'final_preflight',method:'eth_call'});}catch(error){message=sanitizeRpcError(error);}
  expect(message).toContain('RPC_PROVIDER_FAILURE stage=final_preflight method=eth_call providerIndex=1');
  expect(message).not.toContain(secret);expect(message).not.toContain('https://');
  expect(JSON.stringify(events)).not.toContain(secret);expect(events.at(-1)).toMatchObject({event:'rpc_provider_terminal',providerIndex:1,outcome:'exhausted'});
 });
 it('does not replay a reverted preflight on another provider',async()=>{
  let fallbackCalls=0;
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example']},undefined,{clients:[client(async()=>{throw new Error('execution reverted: insufficient liquidity')}),client(async()=>{fallbackCalls++;return 'unexpected';})]});
  await expect(rpc.withClient(c=>(c as any).read())).rejects.toThrow('execution reverted');
 expect(fallbackCalls).toBe(0);
 });
 it('does not rotate a semantic validation failure',async()=>{
  let fallbackCalls=0;
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example']},undefined,{clients:[client(async()=>{throw new Error('POSITION_OR_POOL_INELIGIBLE');}),client(async()=>{fallbackCalls++;return 'unexpected';})]});
  await expect(rpc.withClient(c=>(c as any).read())).rejects.toThrow('POSITION_OR_POOL_INELIGIBLE');
  expect(fallbackCalls).toBe(0);
 });
 it('can poll a receipt on another healthy endpoint',async()=>{
  const hash='0x1234',seen:string[]=[];
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example']},undefined,{clients:[client(async()=>{seen.push(hash);throw retryable('request timed out')}),client(async()=>{seen.push(hash);return {status:'success'};})]});
  await expect(rpc.withClient(c=>(c as any).read(hash),{stage:'receipt_recovery',method:'eth_getTransactionReceipt'})).resolves.toEqual({status:'success'});
  expect(seen).toEqual([hash,hash]);
 });
 it('does not issue eth_chainId in the statically configured hot path',async()=>{
  let chainIdCalls=0;const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example']},undefined,{clients:[{getChainId:async()=>{chainIdCalls++;return 4663;},read:async()=>42}] as any});
  await expect(rpc.withClient(c=>(c as any).read())).resolves.toBe(42);
  expect(chainIdCalls).toBe(0);
 });
 it('wraps from failing provider 2 to healthy provider 0',async()=>{
  const attempted:number[]=[],clients=[0,1,2].map(index=>client(async()=>{attempted.push(index);if(index===2)throw retryable('provider unavailable');return index;}));
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example','https://three.example']},undefined,{clients});
  await expect(rpc.withClient(c=>(c as any).read())).resolves.toBe(0);await expect(rpc.withClient(c=>(c as any).read())).resolves.toBe(1);attempted.length=0;
  await expect(rpc.withClient(c=>(c as any).read(),{stage:'v3_pool_discovery',method:'Factory.getPool'})).resolves.toBe(0);expect(attempted).toEqual([2,0]);
 });
 it('attempts each failed provider at most once and returns sanitized aggregate indexes',async()=>{
  const attempted:number[]=[],secret='synthetic-secret';const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example','https://three.example']},undefined,{clients:[0,1,2].map(index=>client(async()=>{attempted.push(index);throw retryable(`provider unavailable https://example/${secret}`);}))});
  let message='';try{await rpc.withClient(c=>(c as any).read(),{stage:'v3_pool_discovery',method:'Factory.getPool'});}catch(error){message=sanitizeRpcError(error);}
  expect(attempted).toEqual([0,1,2]);expect(new Set(attempted).size).toBe(3);expect(message).toContain('stage=v3_pool_discovery method=Factory.getPool');expect(message).toContain('attemptedProviderIndexes=0,1,2');expect(message).not.toContain(secret);expect(message).not.toContain('https://');
 });
 it('advances provider cursor for the next independent operation',async()=>{
  const calls:number[]=[],rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://one.example','https://two.example']},undefined,{clients:[0,1].map(index=>client(async()=>{calls.push(index);return index;}))});
  await expect(rpc.withClient(c=>(c as any).read())).resolves.toBe(0);await expect(rpc.withClient(c=>(c as any).read())).resolves.toBe(1);expect(calls).toEqual([0,1]);
 });
 it('discoverV3Pools succeeds when provider 2 fails and another provider serves valid factory data',async()=>{
  const factory='0x0000000000000000000000000000000000000010',pool='0x0000000000000000000000000000000000000020',weth=robinhoodMainnet.assets.WETH,usdg=robinhoodMainnet.assets.USDG,provider2Calls:number[]=[];
  const healthy={getChainId:async()=>4663,getBytecode:async()=>'0x01',getBlockNumber:async()=>123n,readContract:async(input:any)=>{if(input.functionName==='getPool')return Number(input.args?.[2])===500?pool:'0x0000000000000000000000000000000000000000';if(input.functionName==='factory')return factory;if(input.functionName==='token0')return weth;if(input.functionName==='token1')return usdg;if(input.functionName==='fee')return 500;if(input.functionName==='tickSpacing')return 10;if(input.functionName==='liquidity')return 100n;if(input.functionName==='slot0')return [2n**96n,0,0,0,0,0,true];throw new Error('unexpected contract read');}} as any;
  const broken={...healthy,readContract:async()=>{provider2Calls.push(2);throw retryable('provider unavailable');}} as any,rpc=new FallbackRpc({...robinhoodMainnet,assets:{WETH:weth,USDG:usdg},rpcUrls:['https://one.example','https://two.example','https://three.example']} as any,undefined,{clients:[healthy,healthy,broken]});
  await rpc.withClient(async()=>0);await rpc.withClient(async()=>1);
  const found=await discoverV3Pools(rpc,{status:'available',value:{factory} as any,provenance:{provider:'test',observedAt:new Date().toISOString(),confidence:'verified'}} as any,weth,[500]);
  expect(found.status).toBe('available');expect(found.status==='available'&&found.value).toEqual([expect.objectContaining({address:pool,factory,fee:500,initialized:true})]);expect(provider2Calls.length).toBeGreaterThan(0);
 });
});
