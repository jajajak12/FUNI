import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,expect,it,vi } from 'vitest';
import { getAddress } from 'viem';
import { migrateSqlite,SqliteLedgerRepository } from '@robin/ledger';
import { robinhoodMainnet } from '@robin/core';
import { poolId,V4_ROBINHOOD_DEPLOYMENTS,type V4PoolKey } from '@robin/v4';
import { v4OperationalOpenPreflight } from '../apps/cli/src/v4-operational-executor.js';

const owner=getAddress('0x00000000000000000000000000000000000000AA');
const target=getAddress('0x0000000000000000000000000000000000000011');
const funding=robinhoodMainnet.assets.USDG;
const key:V4PoolKey={currency0:target,currency1:funding,fee:500,tickSpacing:10,hooks:getAddress('0x0000000000000000000000000000000000000000')};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(latencyMs:number){
 const dir=mkdtempSync(join(tmpdir(),'v4-preview-latency-')),path=join(dir,'db.sqlite');migrateSqlite(path,'infra/migrations');const repo=new SqliteLedgerRepository(path),id=poolId(key);
 repo.upsertV4RegistryPool({poolId:id,currency0:key.currency0,currency1:key.currency1,initializeFeeRaw:key.fee,tickSpacing:key.tickSpacing,hooks:key.hooks,initializationBlock:1n,dynamicFee:false,staticFeePips:500,hookClassification:'ZERO_HOOK'});
 repo.db.prepare("UPDATE v4_pool_registry SET validation_status='ELIGIBLE',initialized=1,active_liquidity_raw='1000' WHERE pool_id=?").run(id);
 const client={
  getChainId:async()=>{await delay(latencyMs);return 4663;},getBlockNumber:async()=>{await delay(latencyMs);return 100n;},
  getBytecode:async()=>{await delay(latencyMs);return '0x00';},getBalance:async()=>{await delay(latencyMs);return 10n**18n;},getGasPrice:async()=>{await delay(latencyMs);return 100_000_000n;},
  getBlock:async()=>{await delay(latencyMs);return {number:100n,timestamp:2_000_000_000n};},estimateGas:async()=>{await delay(latencyMs);return 100_000n;},
  readContract:async(input:any)=>{await delay(latencyMs);switch(input.functionName){case 'getSlot0':return [2n**96n,0,0,500];case 'getLiquidity':return 1_000n;case 'nextTokenId':return 1n;case 'poolManager':return V4_ROBINHOOD_DEPLOYMENTS.poolManager;case 'permit2':return V4_ROBINHOOD_DEPLOYMENTS.permit2;case 'balanceOf':return 5_000_000n;case 'allowance':return String(input.address).toLowerCase()===V4_ROBINHOOD_DEPLOYMENTS.permit2.toLowerCase()?[0n,2_000_003_600,0n]:0n;default:return 0n;}},
 };
 const rpc={withClient:async(work:any)=>work(client),config:robinhoodMainnet,metrics:{primaryUses:0,fallbackUses:0,failures:0}} as any;
 return {repo,rpc,id,close(){repo.close();rmSync(dir,{recursive:true,force:true});}};
}
describe('operational amount preview latency',()=>{
 it('keeps cold and warm mocked previews bounded and accounts all safety stages',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:404,json:async()=>({}),text:async()=>''})));
  const f=fixture(40);try{
   const input={repo:f.repo,rpc:f.rpc,wallet:owner,runtime:{executionEnabled:false,dryRun:true,emergencyPause:true,signerConfigured:false,allowlisted:true},selection:{poolId:f.id,key,target,funding,targetIndex:0 as const,fundingIndex:1 as const,amount:5_000_000n,targetSymbol:'TOKEN',fundingSymbol:'USDG',targetDecimals:18,fundingDecimals:6},range:{upperDropPct:0,lowerDropPct:30},maxPositionUsd:1_000,maxApprovalUsd:1_000,maxTxGasUsd:.25,maxLifecycleGasUsd:1,slippageBps:50,maxSlippageBps:50,nativeUsd:1_800,nativeUsdSource:'fixture',nativeUsdObservedAtMs:Date.now()-1_000,nativeUsdFreshUntilMs:Date.now()+60_000,fundingUsd:1,priceObservedAtMs:Date.now()-1_000,priceFreshUntilMs:Date.now()+60_000};
   const coldStarted=Date.now(),cold=await v4OperationalOpenPreflight(input),coldMs=Date.now()-coldStarted,warmStarted=Date.now(),warm=await v4OperationalOpenPreflight(input),warmMs=Date.now()-warmStarted;
   expect(coldMs).toBeLessThan(5_000);expect(warmMs).toBeLessThan(3_000);expect(cold.mainnetTransactionsSent).toBe(0);expect(warm.timing.deploymentCacheHit).toBe(true);
   for(const stage of ['deploymentCacheMs','poolStateMs','balanceMs','allowanceMs','approvalEstimateMs','mintEstimateMs','lifecycleProjectionMs','databaseMs'])expect(cold.timing).toHaveProperty(stage);
  }finally{vi.unstubAllGlobals();f.close();}
 });
});
