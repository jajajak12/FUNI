import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSqlite, SqliteLedgerRepository } from '@robin/ledger';
import { robinhoodMainnet } from '@robin/core';
import { poolId, sqrtPriceAtTick, type V4PoolKey } from '@robin/v4';
import { buildPortfolioAudit } from '../apps/cli/src/portfolio.js';
import { rebalanceExecutionBlockers } from '../apps/cli/src/v4-rebalance-executor.js';

const owner='0x00000000000000000000000000000000000000AA' as const;
const key:V4PoolKey={currency0:robinhoodMainnet.assets.WETH,currency1:robinhoodMainnet.assets.USDG,fee:500,tickSpacing:10,hooks:'0x0000000000000000000000000000000000000000'};

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'v4-rebalance-protocol-scope-')),path=join(dir,'db.sqlite');migrateSqlite(path,'infra/migrations');const repo=new SqliteLedgerRepository(path),id=poolId(key);
 repo.ensurePosition('v4:358237','358237',id);
 repo.upsertV4Position({tokenId:358237n,owner,poolId:id,poolKey:key,currency0:key.currency0,currency1:key.currency1,fee:key.fee,tickSpacing:key.tickSpacing,hooks:key.hooks,tickLower:-201000,tickUpper:-199000,liquidity:1_000_000n,initialAmount0:0n,initialAmount1:25_000_000n,mintHash:`0x${'1'.repeat(64)}`,targetToken:key.currency0,fundingToken:key.currency1,targetSymbol:'WETH',fundingSymbol:'USDG',targetDecimals:18,fundingDecimals:6,targetIndex:0,fundingIndex:1,openIntentId:'v4-open'});
 repo.ingestDeposit({id:'open',positionId:'v4:358237',txHash:`0x${'1'.repeat(64)}`,logIndex:0,amounts:{token0:0n,token1:25_000_000n},blockNumber:100n,blockTimestamp:new Date().toISOString()});
 return {repo,id,close(){repo.close();rmSync(dir,{recursive:true,force:true});}};
}

describe('v4 rebalance protocol-scoped preflight',()=>{
 it('prices a direct v4 WETH/USDG position without starting a hanging v3 reference operation',async()=>{
  const f=fixture(),stages:string[]=[];let unrelatedReferenceCalls=0;
  const rpc={withClient:async(work:any,context?:{stage?:string})=>{stages.push(String(context?.stage??'unattributed'));return work({getBlock:async()=>({number:100n,timestamp:BigInt(Math.floor(Date.now()/1000))})});}} as any;
  const sqrtPriceX96=sqrtPriceAtTick(-200000),state=Promise.resolve({owner,liquidity:1_000_000n,tickLower:-201000,tickUpper:-199000,key,pool:{id:f.id,key,sqrtPriceX96,tick:-200000,liquidity:10_000_000n,initialized:true,blockNumber:100n},token0:{address:key.currency0,symbol:'WETH',decimals:18},token1:{address:key.currency1,symbol:'USDG',decimals:6},currentAmounts:{token0:1_000_000_000_000_000n,token1:20_000_000n},rangeState:'in_range',price1Per0:2063,claimableFees:{token0:0n,token1:0n}});
  try{
   const result=await Promise.race([
    buildPortfolioAudit({rpc,repo:f.repo,wallet:owner,positionIds:['v4:358237'],v4PositionStates:new Map([['358237',state as any]]),protocolScope:'v4',wethUsdReference:()=>{unrelatedReferenceCalls++;return new Promise(()=>{});}}),
    new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('v4 portfolio was blocked by unrelated reference')),200)),
   ]);
   expect(result.positions[0]).toMatchObject({protocol:'v4',valuationStatus:'PRICED'});
   expect(unrelatedReferenceCalls).toBe(0);
   expect(stages.some(stage=>stage.startsWith('v3_'))).toBe(false);
   expect(f.repo.db.prepare('SELECT COUNT(*) n FROM rebalance_transactions').get()).toMatchObject({n:0});
  }finally{f.close();}
 });

 it('keeps final execution preparation v4-only and emits the zero-v3 protocol scope before close',()=>{
  const executor=readFileSync('apps/cli/src/v4-rebalance-executor.ts','utf8'),prepare=executor.slice(executor.indexOf('async function prepareInitial'),executor.indexOf('async function lifecycle')),telegram=readFileSync('apps/telegram-lp-bot/src/index.ts','utf8'),finalHandler=telegram.slice(telegram.indexOf('async function executeRebalanceFromTelegram'),telegram.indexOf('async function handleText'));
  for(const forbidden of ['trustedWethUsdReference','auditRobinhoodV3Deployments','discoverV3Pools','inspectV3Pool','v3_deployment_audit','v3_pool_discovery','v3_pool_inspection'])expect(prepare).not.toContain(forbidden);
  expect(prepare).toContain("protocolScope:'v4'");
  expect(prepare).toContain("'PREFLIGHT_PROTOCOL_SCOPE',{protocol:'v4',v3OperationCount:0}");
  expect(prepare.indexOf("'PREFLIGHT_PROTOCOL_SCOPE'")).toBeLessThan(executor.indexOf("nextState:'CLOSE_STARTED'")-executor.indexOf('async function prepareInitial'));
  expect(finalHandler).not.toContain('trustedWethUsdReference');
  expect(finalHandler).toMatch(/log\(\s*["']rebalance_preflight_protocol_scope["']\s*,/);
 });

 it('retains the v4 deployment gate while preserving the independent v3 portfolio audit',()=>{
  expect(rebalanceExecutionBlockers({executionEnabled:true,dryRun:false,emergencyPause:false,authorized:true,signerConfigured:true,chainId:4663,deploymentVerified:false})).toContain('V4_DEPLOYMENT_UNVERIFIED');
  const portfolio=readFileSync('apps/cli/src/portfolio.ts','utf8');
  expect(portfolio).toContain("v3Rows.length?await auditRobinhoodV3Deployments(input.rpc)");
  expect(portfolio).toContain("input.protocolScope==='v4'");
 });
});
