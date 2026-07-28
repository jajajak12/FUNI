import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { keccak256, type Address, type Hex } from 'viem';
import { deploymentSnapshotChecksum, diagnoseV3SwapReadiness, FallbackRpc, robinhoodMainnet, ROBINHOOD_V3_DEPLOYMENT_SPECS } from '@robin/core';

const code='0x6001600055' as const,zero='0x0000000000000000000000000000000000000000',pool='0x0000000000000000000000000000000000000020';
function snapshot(){const dir=mkdtempSync(join(tmpdir(),'v3-cli-')),path=join(dir,'snapshot.json'),contracts:Record<string,{address:Address;runtimeCodeHash:Hex;runtimeCodeSize:number}>={};for(const spec of ROBINHOOD_V3_DEPLOYMENT_SPECS)contracts[spec.name]={address:spec.address,runtimeCodeHash:keccak256(code),runtimeCodeSize:(code.length-2)/2};for(const [name,address] of Object.entries(robinhoodMainnet.assets))contracts[name]={address,runtimeCodeHash:keccak256(code),runtimeCodeSize:(code.length-2)/2};const body={schemaVersion:1 as const,chainId:4663,verificationBlock:'16574811',blockTimestamp:'2025-01-01T00:00:00.000Z',snapshotCreatedAt:'2025-01-01T00:00:00.000Z',officialSourceUrls:['test'],contracts,relationships:{factory:contracts.factory!.address,weth:robinhoodMainnet.assets.WETH,factoryConsumers:[] as string[],wethConsumers:[] as string[],feeTierTickSpacing:{}}};writeFileSync(path,JSON.stringify({...body,checksum:deploymentSnapshotChecksum(body)}));return {path,close:()=>rmSync(dir,{recursive:true,force:true})};}
function healthy(){return {getChainId:async()=>4663,getBlock:async()=>({number:16574811n,timestamp:1n}),getBlockNumber:async()=>16574811n,getBytecode:async()=>code,readContract:async(input:any)=>{if(input.functionName==='getPool')return Number(input.args?.[2])===500?pool:zero;if(input.functionName==='factory')return ROBINHOOD_V3_DEPLOYMENT_SPECS.find(item=>item.name==='factory')!.address;if(input.functionName==='token0')return robinhoodMainnet.assets.WETH;if(input.functionName==='token1')return robinhoodMainnet.assets.USDG;if(input.functionName==='fee')return 500;if(input.functionName==='tickSpacing')return 10;if(input.functionName==='liquidity')return 1n;if(input.functionName==='slot0')return [2n**96n,0,0,0,0,0,true];throw new Error('broad audit interface read must not run');}} as any;}
function rpc(clients:any[]){return new FallbackRpc({...robinhoodMainnet,rpcUrls:clients.map((_,index)=>`https://test-${index}.example`)},undefined,{clients,attemptTimeoutMs:25});}

describe('v3-swap-readiness CLI diagnostic',()=>{
 it('uses scoped readiness then reaches Factory.getPool with structured read-only output',async()=>{
  const f=snapshot();try{const result=await diagnoseV3SwapReadiness(rpc([healthy()]),{snapshotPath:f.path});expect(result).toEqual(expect.objectContaining({chainId:4663,readinessStatus:'available',factoryGetPoolReached:true,feeTiersQueried:[100,500,3000,10000],validPools:[{address:pool,fee:500}],errorCode:null}));expect(Object.keys(result).sort()).toEqual(['cache','chainId','durationMs','errorCode','factoryGetPoolReached','feeTiersQueried','providerAttemptIndexes','readinessStatus','validPools']);}finally{f.close();}
 });
 it('succeeds through one healthy provider after bounded failover',async()=>{
  const f=snapshot(),failed={getChainId:async()=>await new Promise<never>(()=>{})} as any;try{const result=await diagnoseV3SwapReadiness(rpc([failed,healthy()]),{snapshotPath:f.path});expect(result).toMatchObject({readinessStatus:'available',factoryGetPoolReached:true});expect(result.providerAttemptIndexes).toEqual([0,1]);}finally{f.close();}
 });
 it('reports readiness failure without a signer, broadcast, SQLite, or nonce operation',async()=>{
  const f=snapshot(),bad={...healthy(),getBytecode:async()=>'0x'};try{const result=await diagnoseV3SwapReadiness(rpc([bad]),{snapshotPath:f.path});expect(result).toMatchObject({readinessStatus:'unavailable',factoryGetPoolReached:false,errorCode:'V3_SWAP_READINESS_factory_BYTECODE_MISSING'});}finally{f.close();}
 });
 it('CLI command dispatch uses the diagnostic helper and sets non-zero failure without startup',()=>{
  const source=readFileSync('apps/cli/src/index.ts','utf8'),start=source.indexOf("if(cmd==='v3-swap-readiness')"),end=source.indexOf("if(cmd==='db-status')",start),command=source.slice(start,end);expect(command).toContain('diagnoseV3SwapReadiness(rpc)');expect(command).toContain("process.exitCode=1");expect(command).not.toMatch(/startup\(|repository\(|guardedWalletClient|sendRawTransaction|acquireNonceMutex|auditRobinhoodV3Deployments/);
 });
});
