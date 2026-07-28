import { describe,expect,it,vi } from 'vitest';
import { getAddress } from 'viem';

const auditCalls=vi.hoisted(()=>({count:0}));
vi.mock('@robin/v4',async importOriginal=>{
 const actual=await importOriginal<typeof import('@robin/v4')>();
 return {...actual,auditRobinhoodV4Deployments:vi.fn(async()=>{
  auditCalls.count++;
  return {status:'available' as const,value:{...actual.V4_ROBINHOOD_DEPLOYMENTS,verification:{executionAllowedByDeploymentAudit:true},runtimeFingerprints:{}},provenance:{provider:'fixture',observedAt:new Date().toISOString(),confidence:'verified' as const}};
 })};
});

import { robinhoodMainnet } from '@robin/core';
import { V4_ROBINHOOD_DEPLOYMENTS,type V4PoolKey } from '@robin/v4';
import { attributedRpc } from '../apps/cli/src/rpc-attribution.js';
import {
 V4_CANONICAL_NATIVE_USD_POOL,
 prepareV4OperationalPreviewContext,
 prewarmV4OperationalPreviewStaticVerification,
} from '../apps/cli/src/v4-operational-executor.js';

const owner=getAddress('0x00000000000000000000000000000000000000AA');
const target=getAddress('0x0000000000000000000000000000000000000011');
const key:V4PoolKey={currency0:target,currency1:robinhoodMainnet.assets.USDG,fee:500,tickSpacing:10,hooks:getAddress('0x0000000000000000000000000000000000000000')};
const selection={poolId:`0x${'1'.repeat(64)}`,key,target,funding:robinhoodMainnet.assets.USDG,targetIndex:0 as const,fundingIndex:1 as const,amount:5_000_000n,targetSymbol:'TOKEN',fundingSymbol:'USDG',targetDecimals:18,fundingDecimals:6};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

function fixture(blockAgeMs=1_000,latencyMs=0){
 const calls={getBytecode:0,multicall:0,members:[] as number[],getBlock:0,getBlockNumber:0,getChainId:0,readContract:0,getLogs:0};
 const client={
  getBytecode:async({address}:any)=>{calls.getBytecode++;await delay(latencyMs);expect(address).toBe(V4_CANONICAL_NATIVE_USD_POOL);return '0x01';},
  getBlock:async()=>{calls.getBlock++;await delay(latencyMs);return {number:123n,timestamp:BigInt(Math.floor((Date.now()-blockAgeMs)/1000))};},
  getGasPrice:async()=>{await delay(latencyMs);return 100_000_000n;},
  getBalance:async()=>{await delay(latencyMs);return 10n**18n;},
  multicall:async({contracts}:any)=>{
   await delay(latencyMs);
   calls.multicall++;calls.members.push(contracts.length);
   if(contracts.length===7&&contracts[0].functionName==='factory')return [
    getAddress('0x1f7d7550b1b028f7571e69a784071f0205fd2efa'),
    robinhoodMainnet.assets.WETH,robinhoodMainnet.assets.USDG,500,10,18,6,
   ];
   const values:any[]=[[2n**96n,0,0,500],1_000n,5_000_000n,0n,[0n,Number(BigInt(Math.floor(Date.now()/1000)+3600)),0n]];
   if(contracts.length===7)values.push([2n**96n,0,0,500,0,0,true],1_000n);
   return values;
  },
  getBlockNumber:async()=>{calls.getBlockNumber++;return 123n;},
  getChainId:async()=>{calls.getChainId++;return 4663;},
  readContract:async()=>{calls.readContract++;throw new Error('unexpected unbatched read');},
  getLogs:async()=>{calls.getLogs++;throw new Error('unexpected pool enumeration');},
 };
 const rpc={withClient:async(work:any)=>work(client),config:robinhoodMainnet,metrics:{primaryUses:0,fallbackUses:0,failures:0}} as any;
 return {rpc,calls};
}

describe('bounded v4 operational preview RPC context',()=>{
 it('prewarms static verification once, then uses one shared-block bounded multicall and no discovery',async()=>{
  auditCalls.count=0;
  const f=fixture(1_000,40);
  await prewarmV4OperationalPreviewStaticVerification(f.rpc);
  await prewarmV4OperationalPreviewStaticVerification(f.rpc);
  expect(f.calls.getBytecode).toBe(1);
  expect(auditCalls.count).toBe(1);
  const attributed=attributedRpc(f.rpc,'fixture',32);
  const coldStarted=Date.now(),cold=await prepareV4OperationalPreviewContext({rpc:attributed.rpc,wallet:owner,selection,staticVerificationPrewarmed:true}),coldMs=Date.now()-coldStarted;
  const warmStarted=Date.now(),warm=await prepareV4OperationalPreviewContext({rpc:attributed.rpc,wallet:owner,selection,staticVerificationPrewarmed:true}),warmMs=Date.now()-warmStarted;
  const metrics=attributed.finish();
  expect(cold).toMatchObject({deploymentCacheHit:true,staticVerificationPrewarmed:true,dynamicMulticallCount:1,dynamicMulticallMembers:7});
  expect(cold.nativeUsd.cacheHit).toBe(false);
  expect(warm).toMatchObject({deploymentCacheHit:true,dynamicMulticallCount:1,dynamicMulticallMembers:5});
  expect(warm.nativeUsd.cacheHit).toBe(true);
  expect(cold.sharedBlock.number).toBe(123n);
  expect(warm.sharedBlock.number).toBe(123n);
  expect(metrics.getCodeCount).toBe(0);
  expect(metrics.chainIdCount).toBe(0);
  expect(metrics.blockReadCount).toBe(2);
  expect(metrics.multicallCount).toBe(2);
  expect(metrics.multicallMembers).toBe(12);
  expect(f.calls.getBlockNumber).toBe(0);
  expect(f.calls.getChainId).toBe(0);
  expect(f.calls.readContract).toBe(0);
  expect(f.calls.getLogs).toBe(0);
  expect(coldMs).toBeLessThan(5_000);
  expect(warmMs).toBeLessThan(3_000);
  process.stdout.write(`${JSON.stringify({event:'v4_preview_mock_latency',coldMs,warmMs,latencyPerRpcMs:40})}\n`);
 });

 it('fails closed when the canonical observation block is stale',async()=>{
  const f=fixture(180_000);
  await prewarmV4OperationalPreviewStaticVerification(f.rpc);
  await expect(prepareV4OperationalPreviewContext({rpc:f.rpc,wallet:owner,selection,staticVerificationPrewarmed:true})).rejects.toThrow('CANONICAL_WETH_USDG_PRICE_STALE');
 });
});
