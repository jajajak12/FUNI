import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { keccak256, type Address, type Hex } from 'viem';
import { auditRobinhoodV3Deployments, deploymentSnapshotChecksum, discoverV3Pools, FallbackRpc, robinhoodMainnet, ROBINHOOD_V3_DEPLOYMENT_SPECS, v3SwapReadiness } from '@funi/core';

const zero='0x0000000000000000000000000000000000000000';
const pool='0x0000000000000000000000000000000000000020';
const code='0x6001600055' as const;

function snapshotFixture(overrides:Record<string,Hex>={}){
 const dir=mkdtempSync(join(tmpdir(),'v3-readiness-')),path=join(dir,'snapshot.json'),contracts:Record<string,{address:Address;runtimeCodeHash:Hex;runtimeCodeSize:number}>={};
 for(const spec of ROBINHOOD_V3_DEPLOYMENT_SPECS)contracts[spec.name]={address:spec.address,runtimeCodeHash:overrides[spec.name]??keccak256(code),runtimeCodeSize:(code.length-2)/2};
 for(const [name,address] of Object.entries(robinhoodMainnet.assets))contracts[name]={address,runtimeCodeHash:keccak256(code),runtimeCodeSize:(code.length-2)/2};
 const body={schemaVersion:1 as const,chainId:4663,verificationBlock:'16574811',blockTimestamp:'2025-01-01T00:00:00.000Z',snapshotCreatedAt:'2025-01-01T00:00:00.000Z',officialSourceUrls:['test'],contracts,relationships:{factory:contracts.factory!.address,weth:robinhoodMainnet.assets.WETH,factoryConsumers:[] as string[],wethConsumers:[] as string[],feeTierTickSpacing:{}}};
 writeFileSync(path,JSON.stringify({...body,checksum:deploymentSnapshotChecksum(body)}));return {path,close:()=>rmSync(dir,{recursive:true,force:true})};
}
function readinessClient(input:{codeFor?:(address:string)=>string|undefined;onCode?:(address:string)=>void;hang?:boolean;throwOnRead?:boolean}={}){return {getChainId:async()=>4663,getBlock:async()=>input.hang?new Promise(()=>{}):({number:16574811n,timestamp:1n}),getBlockNumber:async()=>16574811n,getBytecode:async({address}:{address:string})=>{input.onCode?.(address);if(input.hang)return new Promise(()=>{});return input.codeFor?.(address)??code;},readContract:async(args:any)=>{if(input.throwOnRead)throw new Error('unrelated interface probe must not run');if(args.functionName==='getPool')return Number(args.args?.[2])===500?pool:zero;if(args.functionName==='factory')return ROBINHOOD_V3_DEPLOYMENT_SPECS.find(item=>item.name==='factory')!.address;if(args.functionName==='token0')return robinhoodMainnet.assets.WETH;if(args.functionName==='token1')return robinhoodMainnet.assets.USDG;if(args.functionName==='fee')return 500;if(args.functionName==='tickSpacing')return 10;if(args.functionName==='liquidity')return 1n;if(args.functionName==='slot0')return [2n**96n,0,0,0,0,0,true];throw new Error('unexpected read');}} as any;}
function rpc(clients:any[],attemptTimeoutMs=40){return new FallbackRpc({...robinhoodMainnet,rpcUrls:clients.map((_,index)=>`https://provider-${index}.example`)},undefined,{clients,attemptTimeoutMs});}

describe('V3 execution-scoped readiness',()=>{
 it('simple reads work while the broad deployment audit exceeds its attempt deadline',async()=>{
  const f=snapshotFixture(),slow=readinessClient({hang:true}),value=rpc([slow],10);
  try{await expect(value.withClient(client=>client.getBlockNumber(),{stage:'simple_read',method:'eth_blockNumber'})).resolves.toBe(16574811n);await expect(auditRobinhoodV3Deployments(value,async()=>new Response('',{status:200}))).rejects.toThrow('RPC_PROVIDER_FAILURE');}finally{f.close();}
 });
 it('scoped readiness reaches Factory.getPool and discovers a valid WETH/USDG pool',async()=>{
  const f=snapshotFixture(),value=rpc([readinessClient()]);
  try{const readiness=await v3SwapReadiness(value,{snapshotPath:f.path});expect(readiness.status).toBe('available');const found=await discoverV3Pools(value,readiness,robinhoodMainnet.assets.WETH,[500]);expect(found).toMatchObject({status:'available'});expect(found.status==='available'&&found.value).toEqual([expect.objectContaining({address:pool,fee:500,initialized:true})]);}finally{f.close();}
 });
 it('valid cached readiness avoids repeating code verification',async()=>{
  const f=snapshotFixture();let codes=0,clock=1_000;const value=rpc([readinessClient({onCode:()=>{codes++;}})]);
  try{await v3SwapReadiness(value,{snapshotPath:f.path,now:()=>clock,ttlMs:100});await v3SwapReadiness(value,{snapshotPath:f.path,now:()=>clock+50,ttlMs:100});expect(codes).toBe(4);}finally{f.close();}
 });
 it('stale readiness cache re-verifies runtime code',async()=>{
  const f=snapshotFixture();let codes=0,clock=1_000;const value=rpc([readinessClient({onCode:()=>{codes++;}})]);
  try{await v3SwapReadiness(value,{snapshotPath:f.path,now:()=>clock,ttlMs:100});clock+=101;await v3SwapReadiness(value,{snapshotPath:f.path,now:()=>clock,ttlMs:100});expect(codes).toBe(8);}finally{f.close();}
 });
 it('deployment fingerprint mismatch bypasses cache and fails closed',async()=>{
  const first=snapshotFixture(),second=snapshotFixture({factory:keccak256('0x6000')}),value=rpc([readinessClient()]);
  try{expect((await v3SwapReadiness(value,{snapshotPath:first.path})).status).toBe('available');expect(await v3SwapReadiness(value,{snapshotPath:second.path})).toMatchObject({status:'unavailable',reason:'V3_SWAP_READINESS_factory_RUNTIME_CODE_MISMATCH'});}finally{first.close();second.close();}
 });
 it('runtime code mismatches for factory, router, or Permit2 fail closed',async()=>{
  for(const name of ['factory','swapRouter02','permit2'] as const){const f=snapshotFixture(),address=ROBINHOOD_V3_DEPLOYMENT_SPECS.find(item=>item.name===name)!.address,value=rpc([readinessClient({codeFor:seen=>seen.toLowerCase()===address.toLowerCase()?'0x6000':code})]);try{const result=await v3SwapReadiness(value,{snapshotPath:f.path});expect(result).toMatchObject({status:'unavailable',reason:`V3_SWAP_READINESS_${name}_RUNTIME_CODE_MISMATCH`});}finally{f.close();}}
 });
 it('unrelated V3 NFT and descriptor reads cannot block the swap-only proof',async()=>{
  const f=snapshotFixture(),value=rpc([readinessClient({throwOnRead:true})]);
  try{const result=await v3SwapReadiness(value,{snapshotPath:f.path});expect(result.status).toBe('available');}finally{f.close();}
 });
 it('all provider timeouts remain bounded and fail closed',async()=>{
  const f=snapshotFixture(),value=rpc([readinessClient({hang:true}),readinessClient({hang:true}),readinessClient({hang:true})],10);
  try{await expect(v3SwapReadiness(value,{snapshotPath:f.path})).rejects.toThrow('attemptedProviderIndexes=0,1,2');}finally{f.close();}
 });
 it('the explicit full audit still performs its broader deployment code sweep',async()=>{
  let codeReads=0;const value=rpc([readinessClient({onCode:()=>{codeReads++;}})]);
  await auditRobinhoodV3Deployments(value,async()=>new Response('',{status:200}));expect(codeReads).toBe(ROBINHOOD_V3_DEPLOYMENT_SPECS.length);
 });
});
