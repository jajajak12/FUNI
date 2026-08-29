import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateSqlite, SqliteLedgerRepository } from '@funi/ledger';
import { poolId, sqrtPriceAtTick } from '@funi/v4';
import { planV4BidLadderV1, v4BidLadderPersistencePlan } from '../apps/cli/src/v4-bid-ladder-planner.js';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const a='0x0000000000000000000000000000000000000001' as const,b='0x0000000000000000000000000000000000000002' as const,owner='0x0000000000000000000000000000000000000003' as const,hooks='0x0000000000000000000000000000000000000000' as const;
describe('migration 053',()=>{
 it('preserves the original ladder and widens only approved lifecycle/flexible geometry checks',()=>{
  const root=mkdtempSync(join(tmpdir(),'ladder-053-'));roots.push(root);const path=join(root,'db.sqlite');migrateSqlite(path,'infra/migrations');const repo=new SqliteLedgerRepository(path);const key={currency0:a,currency1:b,fee:3000,tickSpacing:10,hooks} as const,pool={id:poolId(key),key,sqrtPriceX96:sqrtPriceAtTick(0),tick:0,liquidity:1_000_000_000n,initialized:true,blockNumber:1n};
  try{const original=planV4BidLadderV1({ladderId:'original',pool,fundingToken:b,targetToken:a,totalFundingAmount:10_000n,fundingDecimals:6,targetDecimals:18,owner,deadline:100n,nowMs:1});repo.createDryRunBidLadder(v4BidLadderPersistencePlan(original));const before=repo.listBidLadderLegs('original').map(row=>({...row}));const custom=planV4BidLadderV1({ladderId:'custom',pool,fundingToken:b,targetToken:a,totalFundingAmount:10_000n,fundingDecimals:6,targetDecimals:18,owner,deadline:100n,nowMs:2,maxDownsideBps:3000});expect(repo.createDryRunBidLadder(v4BidLadderPersistencePlan(custom)).legs).toHaveLength(5);repo.db.prepare("UPDATE v4_bid_ladders SET execution_mode='LIVE' WHERE ladder_id='custom'").run();repo.db.prepare("UPDATE v4_bid_ladder_legs SET status='OPEN' WHERE ladder_id='custom'").run();repo.db.prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id='custom'").run();expect(repo.listBidLadderLegs('original')).toEqual(before);expect(()=>repo.db.prepare("UPDATE v4_bid_ladders SET status='OPENING' WHERE ladder_id='custom'").run()).toThrow();expect(()=>repo.db.prepare("UPDATE v4_bid_ladder_legs SET status='CLOSING' WHERE ladder_id='custom'").run()).toThrow();expect(repo.db.pragma('quick_check',{simple:true})).toBe('ok');expect(repo.db.pragma('foreign_key_check')).toEqual([]);expect((repo.db.pragma('foreign_key_list(v4_bid_ladder_legs)') as any[])[0]).toMatchObject({table:'v4_bid_ladders',from:'ladder_id',to:'ladder_id',on_delete:'RESTRICT'});}
  finally{repo.close();}
 });
});
