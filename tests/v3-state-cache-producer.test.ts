import {describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getAddress} from 'viem';
import {migrateSqlite,SqliteLedgerRepository} from '@funi/ledger';
import {persistV3Discovery,planV3Discovery,planV3Refresh,persistV3Refresh} from '../apps/cli/src/v3-state-cache.js';
import {robinhoodMainnet} from '@funi/core';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'v3-producer-')),path=join(dir,'db.sqlite');migrateSqlite(path,'infra/migrations');const repo=new SqliteLedgerRepository(path);return {repo,close(){repo.close();rmSync(dir,{recursive:true,force:true});}};}
const pool=getAddress('0x1000000000000000000000000000000000000001'),token=getAddress('0x2000000000000000000000000000000000000002'),quote=robinhoodMainnet.assets.WETH;
describe('Robinhood V3 canonical producer',()=>{
 it('persists PoolCreated idempotently and resumes its durable cursor',()=>{const f=fixture();try{const first=planV3Discovery(f.repo,16_600_000n,100n)!;expect(first.from).toBe(16_574_811n);const event={pool,token0:token,token1:quote,fee:500,tickSpacing:10,block:first.from};persistV3Discovery(f.repo,first,[event],1_000);persistV3Discovery(f.repo,first,[event],1_001);expect(f.repo.db.prepare('SELECT COUNT(*) count FROM v3_pool_state_cache').get()).toEqual({count:1});expect(planV3Discovery(f.repo,16_600_000n,100n)!.from).toBe(first.to+1n);}finally{f.close();}});
 it('rotates refresh and resolves both orientations only while fresh and active',()=>{const f=fixture();try{const discovery={from:16_574_811n,to:16_574_811n},event={pool,token0:quote,token1:token,fee:500,tickSpacing:10,block:discovery.from};persistV3Discovery(f.repo,discovery,[event],1_000);const plan=planV3Refresh(f.repo,8),value={address:pool,factory:getAddress('0x1f7d7550b1b028f7571e69a784071f0205fd2efa'),token0:quote,token1:token,fee:500,tickSpacing:10,liquidity:9n,sqrtPriceX96:2n**96n,tick:0,initialized:true,blockNumber:99n};persistV3Refresh(f.repo,plan,[{pool,result:{status:'available',value,provenance:{}} as any}],2_000);expect(f.repo.v3CachedPoolsForToken(token,[quote],2_001)).toHaveLength(1);expect(f.repo.v3CachedPoolsForToken(quote,[token],2_001)).toHaveLength(1);expect(f.repo.v3CachedPoolsForToken(token,[quote],123_001)).toHaveLength(0);}finally{f.close();}});
});
