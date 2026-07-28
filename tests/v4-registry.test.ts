import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAddress, zeroAddress } from 'viem';
import { migrateSqlite, SqliteLedgerRepository } from '@robin/ledger';
import { classifyV4Hooks, decodeV4Fee, poolId, V4_DYNAMIC_FEE_FLAG, type V4InitializeEvent, type V4PoolKey } from '@robin/v4';
import { bootstrapV4PoolRegistry, cachedV4PoolsForToken, rankV4Candidates, syncV4PoolRegistry, type V4Candidate } from '../apps/cli/src/v4-registry.js';

const currency0=getAddress('0x0000000000000000000000000000000000000001');
const currency1=getAddress('0x0000000000000000000000000000000000000002');
const key:V4PoolKey={currency0,currency1,fee:10_000,tickSpacing:200,hooks:zeroAddress};
function event(blockNumber:bigint,logIndex=0):V4InitializeEvent{return {id:poolId(key),key,initializeFeeRaw:key.fee,sqrtPriceX96:2n**96n,tick:0,blockNumber,transactionHash:`0x${'1'.repeat(64)}`,transactionIndex:0,logIndex};}
function fixture(){const path=join(mkdtempSync(join(tmpdir(),'v4-registry-')),'db.sqlite');migrateSqlite(path,join(process.cwd(),'infra/migrations'));return new SqliteLedgerRepository(path);}

describe('durable v4 registry',()=>{
 it('uses bounded windows, overlaps idempotently, and resumes after restart',async()=>{
  let repo=fixture(),windows:Array<[bigint,bigint]>=[];const reader=async(from:bigint,to:bigint)=>{windows.push([from,to]);return from<=10n&&to>=10n?[event(10n)]:[];};
  const first=await bootstrapV4PoolRegistry({repo,rpc:{} as never,fromBlock:0n,toBlock:25n,windowSize:10,overlapBlocks:2,reader});
  expect(windows).toEqual([[0n,9n],[10n,19n],[20n,25n]]);expect(first.inserted).toBe(1);expect(repo.v4RegistryStatus().counts.total).toBe(1);const path=repo.path;repo.close();
  repo=new SqliteLedgerRepository(path);windows=[];const second=await syncV4PoolRegistry({repo,rpc:{} as never,toBlock:30n,confirmations:0,reader});
  expect(windows[0]).toEqual([24n,30n]);expect(second.inserted).toBe(0);expect(BigInt(String(repo.v4RegistryCursor()!.next_block))).toBe(31n);repo.close();
 });
 it('updates an overlapping event without duplicating its PoolId',async()=>{const repo=fixture();await bootstrapV4PoolRegistry({repo,rpc:{} as never,fromBlock:10n,toBlock:10n,windowSize:10,overlapBlocks:2,reader:async()=>[event(10n)]});await syncV4PoolRegistry({repo,rpc:{} as never,toBlock:12n,confirmations:0,reader:async()=>[event(10n)]});expect(repo.v4RegistryStatus().counts.total).toBe(1);repo.close();});
 it('requires fresh positive active liquidity but not TVL for indexed eligibility',async()=>{const repo=fixture();try{repo.upsertV4RegistryPool({poolId:poolId(key),currency0, currency1,initializeFeeRaw:key.fee,tickSpacing:key.tickSpacing,hooks:key.hooks,initializationBlock:10n,dynamicFee:false,staticFeePips:key.fee,hookClassification:'ZERO_HOOK'});repo.refreshV4RegistryPool({poolId:poolId(key),sqrtPriceX96:2n**96n,tick:0,liquidity:1n,protocolFee:0,lpFeePips:key.fee,initialized:true,refreshBlock:20n,validationStatus:'ELIGIBLE',blockers:[]});const before=repo.v4RegistryCursor(),now=Date.now();repo.updateV4RegistryTvl(poolId(key),{status:'missing'});const result=cachedV4PoolsForToken({repo,token:currency0,fundingAssets:[currency1],now});expect(result.candidates[0]!.executionEligible).toBe(true);expect(repo.v4RegistryCursor()).toEqual(before);repo.refreshV4RegistryPool({poolId:poolId(key),sqrtPriceX96:2n**96n,tick:0,liquidity:0n,protocolFee:0,lpFeePips:key.fee,initialized:true,refreshBlock:20n,validationStatus:'BLOCKED',blockers:['ZERO_ACTIVE_LIQUIDITY']});expect(cachedV4PoolsForToken({repo,token:currency0,fundingAssets:[currency1],now}).candidates[0]!.executionEligible).toBe(false);}finally{repo.close();}});
 it('hides zero-active-liquidity pools despite otherwise fresh TVL and reports the terminal state',()=>{const repo=fixture();try{repo.upsertV4RegistryPool({poolId:poolId(key),currency0,currency1,initializeFeeRaw:key.fee,tickSpacing:key.tickSpacing,hooks:key.hooks,initializationBlock:10n,dynamicFee:false,staticFeePips:key.fee,hookClassification:'ZERO_HOOK'});repo.refreshV4RegistryPool({poolId:poolId(key),sqrtPriceX96:2n**96n,tick:0,liquidity:0n,protocolFee:0,lpFeePips:key.fee,initialized:true,refreshBlock:20n,validationStatus:'BLOCKED',blockers:['ZERO_ACTIVE_LIQUIDITY']});const now=Date.now();repo.updateV4RegistryTvl(poolId(key),{tvlUsd:1,tvlSource:'uniswap-test',observedAtMs:now,freshUntilMs:now+60_000,status:'fresh'});const candidate=cachedV4PoolsForToken({repo,token:currency0,fundingAssets:[currency1],now}).candidates[0]!;expect(candidate.executionEligible).toBe(false);expect(candidate.uiState).toBe('SUPPORTED_NO_ACTIVE_LIQUIDITY');}finally{repo.close();}});
});

describe('v4 fee, hooks, and ranking',()=>{
 it('decodes static and dynamic fees without displaying the flag as a percentage',()=>{
  expect(decodeV4Fee(10_000,10_000).displayedFeePercent).toBe(1);
  const dynamic=decodeV4Fee(V4_DYNAMIC_FEE_FLAG,500);expect(dynamic.dynamicFee).toBe(true);expect(dynamic.staticFeePips).toBeNull();expect(dynamic.displayedFeePercent).toBe(.05);expect(dynamic.blockers).toContain('DYNAMIC_FEE_UNSUPPORTED');
  expect(classifyV4Hooks(zeroAddress).supported).toBe(true);expect(classifyV4Hooks(currency0).blockers).toContain('NONZERO_HOOK_UNSUPPORTED');
 });
 it('ranks eligibility and reliable valuation before raw liquidity',()=>{
  const base={protocolVersion:'v4' as const,poolId:`0x${'2'.repeat(64)}`,key,target:{address:currency0,symbol:'AI',decimals:18},funding:{address:currency1,symbol:'USDG',decimals:6},targetIndex:0 as const,fundingIndex:1 as const,priceFundingPerTarget:1,priceProvenance:'test',feeLabel:'1%',tickSpacing:200,feeSemantics:decodeV4Fee(10_000,10_000),hookStatus:classifyV4Hooks(zeroAddress),refreshBlock:1n,blockers:[],initializationBlock:1n} satisfies Omit<V4Candidate,'liquidity'|'valuation'|'executionEligible'>;
  const ineligible={...base,poolId:`0x${'3'.repeat(64)}`,liquidity:10n**30n,valuation:{status:'unavailable' as const,reason:'not TVL',provenance:'active liquidity only'},executionEligible:false,blockers:['EXTREME_STATIC_FEE']};
  const eligible={...base,liquidity:1n,valuation:{status:'available' as const,estimatedTvlUsd:10,provenance:'verified reserves'},executionEligible:true};
  expect(rankV4Candidates([ineligible,eligible])[0]!.poolId).toBe(eligible.poolId);
 });
});
