import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateSqlite, SqliteLedgerRepository } from '@funi/ledger';
import { poolId, sqrtPriceAtTick, type V4PoolState } from '@funi/v4';
import { evaluateV4BidLadderV1, planV4BidLadderV1, V4_BID_LADDER_SLICES, v4BidLadderGeometry, v4BidLadderPersistencePlan, v4BidLadderSlices } from '../apps/cli/src/v4-bid-ladder-planner.js';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const currency0='0x0000000000000000000000000000000000000001' as const;
const currency1='0x0000000000000000000000000000000000000002' as const;
const owner='0x0000000000000000000000000000000000000003' as const;
const zeroHook='0x0000000000000000000000000000000000000000' as const;

function pool(spacing=10,overrides:Partial<V4PoolState>={}){
 const key={currency0,currency1,fee:3000,tickSpacing:spacing,hooks:zeroHook} as const;
 return {id:poolId(key),key,sqrtPriceX96:sqrtPriceAtTick(0),tick:0,liquidity:1_000_000_000_000n,initialized:true,blockNumber:123n,...overrides};
}
function plan(input:Partial<Parameters<typeof planV4BidLadderV1>[0]>={}){const state=input.pool??pool();return planV4BidLadderV1({ladderId:'ladder-a',pool:state,fundingToken:currency1,targetToken:currency0,totalFundingAmount:10_003n,fundingDecimals:6,targetDecimals:18,owner,deadline:999_999n,nowMs:1000,...input});}
const tendies='0x45242320DBB855EeA8Fd36804C6487E10E97FCF9' as const;
const usdg='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const;
function tendiesPool(){const key={currency0:tendies,currency1:usdg,fee:25400,tickSpacing:508,hooks:zeroHook} as const;return {id:poolId(key),key,sqrtPriceX96:sqrtPriceAtTick(-318058),tick:-318058,liquidity:178937356911533n,initialized:true,blockNumber:40881240n};}

describe('V4 BID ladder V1',()=>{
 it('floor-scales 20/30/50/custom depth into exactly five strict slices',()=>{
  expect([2000,3000,5000,7000].map(max=>v4BidLadderSlices(max).flatMap((slice,index)=>index?[slice.lowerDropBps]:[slice.upperDropBps,slice.lowerDropBps]))).toEqual([
   [40,200,480,880,1400,2000],[60,300,720,1320,2100,3000],[100,500,1200,2200,3500,5000],[140,700,1680,3080,4900,7000],
  ]);
  for(const maxDownsideBps of [2000,3000,5000,7000]){const value=plan({maxDownsideBps,totalFundingAmount:10_003n});expect(value.legs).toHaveLength(5);expect(value.legs.map(x=>x.weightBps)).toEqual([800,1200,1800,2500,3700]);expect(value.legs.reduce((sum,x)=>sum+x.fundingAmount,0n)).toBe(10_003n);}
  expect(()=>v4BidLadderSlices(4)).toThrow('V4_BID_LADDER_SCALED_BOUNDARY_COLLAPSE');
 });
 it('generates the approved five slices, exact weights, and deterministic remainder',()=>{
  const value=plan();
  expect(value.legs.map(leg=>[leg.upperDropBps,leg.lowerDropBps,leg.weightBps])).toEqual(V4_BID_LADDER_SLICES.map(slice=>[slice.upperDropBps,slice.lowerDropBps,slice.weightBps]));
  expect(value.legs.map(leg=>leg.fundingAmount)).toEqual([800n,1200n,1800n,2500n,3703n]);
  expect(value.legs.reduce((sum,leg)=>sum+leg.fundingAmount,0n)).toBe(10_003n);
  expect(value.legs.every(leg=>leg.mint.amount0Max===0n&&leg.mint.amount1Max>0n)).toBe(true);
 });
 it('keeps every BID range strictly below reference in both token orientations and supported spacings',()=>{
  for(const spacing of [1,10,60,200])for(const [funding,target] of [[currency1,currency0],[currency0,currency1]] as const){
   const value=plan({ladderId:`${spacing}-${funding}`,pool:pool(spacing),fundingToken:funding,targetToken:target,totalFundingAmount:10_000_000n});
   expect(value.legs).toHaveLength(5);
   for(const leg of value.legs){expect(leg.tickLower).toBeLessThan(leg.tickUpper);expect(Math.abs(leg.tickLower%spacing)).toBe(0);expect(Math.abs(leg.tickUpper%spacing)).toBe(0);expect(leg.targetIndex===0?leg.tickUpper<0:leg.tickLower>0).toBe(true);expect(leg.targetIndex===0?leg.mint.amount0Expected:leg.mint.amount1Expected).toBe(0n);}
  }
 });
 it('fails closed for collapsed spacing and unsupported pool semantics',()=>{
  expect(()=>plan({pool:pool(10_000),totalFundingAmount:10_000_000n})).toThrow(/V4_(TICK_RANGE_INVALID|BID_LADDER)/);
  expect(()=>plan({pool:pool(10,{key:{...pool(10).key,hooks:'0x0000000000000000000000000000000000000001'}})})).toThrow('V4_BID_LADDER_POOL_BLOCKED');
  expect(()=>plan({pool:pool(10,{key:{...pool(10).key,fee:0x800000}})})).toThrow('V4_BID_LADDER_POOL_BLOCKED');
 });
 it('adaptively resolves the TENDIES 40% collision without exceeding the selected downside cap',()=>{
  const state=tendiesPool(),geometry=v4BidLadderGeometry({pool:state,fundingToken:usdg,targetToken:tendies,maxDownsideBps:4000});
  expect(geometry.representable).toBe(true);
  expect(geometry.desiredBps).toEqual([80,400,960,1760,2800,4000]);
  expect(geometry.desiredSnappedTicks).toEqual([-318516,-318516,-319532,-320040,-321564,-323596]);
  expect(geometry.boundaries).toEqual([-318516,-319024,-319532,-320040,-321564,-323088]);
  expect(geometry.effectiveMaxDownsideBps).toBeLessThanOrEqual(4000);
  const low=plan({pool:state,fundingToken:usdg,targetToken:tendies,totalFundingAmount:100_000_000n,maxDownsideBps:4000}),high=plan({pool:state,fundingToken:usdg,targetToken:tendies,totalFundingAmount:900_000_000n,maxDownsideBps:4000});
  expect(low.legs.map(x=>[x.tickLower,x.tickUpper])).toEqual([[-319024,-318516],[-319532,-319024],[-320040,-319532],[-321564,-320040],[-323088,-321564]]);
  expect(high.legs.map(x=>[x.tickLower,x.tickUpper])).toEqual(low.legs.map(x=>[x.tickLower,x.tickUpper]));
 });
 it('uses the same constrained geometry for representability, both orientations, and coarse grids',()=>{
  const state=tendiesPool();
  expect(Object.fromEntries([2000,3000,4000,5000,7000].map(depth=>[depth,v4BidLadderGeometry({pool:state,fundingToken:usdg,targetToken:tendies,maxDownsideBps:depth}).representable]))).toEqual({2000:false,3000:true,4000:true,5000:true,7000:true});
  for(const [funding,target] of [[currency1,currency0],[currency0,currency1]] as const) for(const spacing of [1,10,60,200,508,1000]){
   const state=pool(spacing),geometry=v4BidLadderGeometry({pool:state,fundingToken:funding,targetToken:target,maxDownsideBps:5000});
   if(!geometry.representable){expect(geometry.reason).toBe('V4_BID_LADDER_DEPTH_NOT_REPRESENTABLE');continue;}
   const boundaries=geometry.boundaries!;expect(boundaries).toHaveLength(6);expect(new Set(boundaries).size).toBe(6);expect(boundaries.every(tick=>tick%spacing===0&&tick>-887272&&tick<=887272)).toBe(true);
   expect(boundaries.every((tick,index)=>index===0||(geometry.targetIndex===0?tick<boundaries[index-1]!:tick>boundaries[index-1]!))).toBe(true);
   expect(geometry.effectiveMaxDownsideBps).toBeLessThanOrEqual(5000);
   expect(v4BidLadderGeometry({pool:state,fundingToken:funding,targetToken:target,maxDownsideBps:5000}).boundaries).toEqual(boundaries);
  }
 });
 it('persists a parent and exactly five legs atomically, idempotently, without live state',()=>{
  const root=mkdtempSync(join(tmpdir(),'v4-bid-ladder-'));roots.push(root);const path=join(root,'ledger.sqlite');migrateSqlite(path,'infra/migrations');const repo=new SqliteLedgerRepository(path);try{
   const value=plan({ladderId:'durable',totalFundingAmount:10_000_000n}),stored=repo.createDryRunBidLadder(v4BidLadderPersistencePlan(value));
   expect(stored.created).toBe(true);expect(stored.legs).toHaveLength(5);expect(repo.createDryRunBidLadder(v4BidLadderPersistencePlan(value)).created).toBe(false);
   const conflict={...value,referenceTick:value.referenceTick+1};expect(()=>repo.createDryRunBidLadder(v4BidLadderPersistencePlan(conflict))).toThrow('V4_BID_LADDER_PLAN_CONFLICT');
   const invalid=v4BidLadderPersistencePlan({...value,ladderId:'atomic-failure'}),duplicate=invalid.legs[3]!;invalid.legs=[...invalid.legs.slice(0,4),{...invalid.legs[4]!,tickLower:duplicate.tickLower,tickUpper:duplicate.tickUpper}];expect(()=>repo.createDryRunBidLadder(invalid)).toThrow();expect(repo.loadBidLadder('atomic-failure')).toBeUndefined();
   for(const table of ['v4_live_open_intents','v4_positions','v4_lifecycle_intents','chain_transaction_journal'])expect(repo.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get()).toEqual({count:0});
  }finally{repo.close();}
 });
 it('evaluates principal inventory only, range states, aggregation, and never invents fees',()=>{
  const value=plan({totalFundingAmount:10_000_000n});
  const above=evaluateV4BidLadderV1(value,{tick:0,sqrtPriceX96:sqrtPriceAtTick(0)});
  expect(above.rangeCounts).toEqual({above:5,in:0,below:0});expect(above.aggregateFundingTokenAmount).toBeGreaterThan(0n);expect(above.aggregateTargetTokenAmount).toBe(0n);expect(above.feeAccountingMode).toBe('NOT_MODELED_PHASE1');expect(above.pnlMode).toBe('PRINCIPAL_INVENTORY_ONLY_NOT_PNL');
  expect(above.aggregateFundingTokenAmount).toBe(above.legs.reduce((sum,leg)=>sum+leg.fundingAmount,0n));expect(above.aggregateTargetTokenAmount).toBe(above.legs.reduce((sum,leg)=>sum+leg.targetAmount,0n));
  const middleTick=value.legs[1]!.tickLower;const inside=evaluateV4BidLadderV1(value,{tick:middleTick,sqrtPriceX96:sqrtPriceAtTick(middleTick)});
  expect(inside.rangeCounts.in).toBeGreaterThan(0);expect(inside.aggregateFundingTokenAmount+inside.aggregateTargetTokenAmount).toBeGreaterThan(0n);
  const belowTick=Math.min(...value.legs.map(leg=>leg.tickLower))-1;const below=evaluateV4BidLadderV1(value,{tick:belowTick,sqrtPriceX96:sqrtPriceAtTick(belowTick)});
  expect(below.rangeCounts).toEqual({above:0,in:0,below:5});expect(below.aggregateFundingTokenAmount).toBe(0n);expect(below.aggregateTargetTokenAmount).toBeGreaterThan(0n);
 });
});
