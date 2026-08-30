import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSqlite, SqliteLedgerRepository } from '@funi/ledger';

describe('V4 registry hot-path indexes',()=>{
 it('removes only redundant case-sensitive currency indexes and keeps the case-folded candidate plan indexed',()=>{const dir=mkdtempSync(join(tmpdir(),'v4-indexes-')),path=join(dir,'db.sqlite');migrateSqlite(path,'infra/migrations');const repo=new SqliteLedgerRepository(path);try{const names=(repo.db.prepare("PRAGMA index_list('v4_pool_registry')").all() as Array<{name:string}>).map(row=>row.name);expect(names).not.toContain('idx_v4_registry_currency0');expect(names).not.toContain('idx_v4_registry_currency1');expect(names).toEqual(expect.arrayContaining(['idx_v4_registry_currency0_lower','idx_v4_registry_currency1_lower','idx_v4_registry_eligibility','idx_v4_registry_strict_tvl']));const plan=repo.db.prepare("EXPLAIN QUERY PLAN SELECT pool_id FROM v4_pool_registry WHERE (lower(currency0)=lower(?) AND lower(currency1) IN (?,?)) OR (lower(currency1)=lower(?) AND lower(currency0) IN (?,?))").all('0x1','0x2','0x3','0x1','0x2','0x3') as Array<{detail:string}>;expect(plan.map(row=>row.detail).join('\n')).toMatch(/idx_v4_registry_currency[01]_lower/);expect(plan.map(row=>row.detail).join('\n')).not.toMatch(/SCAN v4_pool_registry/);}finally{repo.close();rmSync(dir,{recursive:true,force:true});}});
});
