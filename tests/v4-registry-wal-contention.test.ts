import {describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {migrateSqlite,SqliteLedgerRepository} from '@funi/ledger';
import {persistedPositionViews} from '../apps/telegram-lp-bot/src/persisted-portfolio.js';

describe('V4 registry WAL ownership',()=>{
 it('keeps position first-paint reads available while a registry writer is active',()=>{const dir=mkdtempSync(join(tmpdir(),'registry-wal-')),path=join(dir,'db.sqlite');migrateSqlite(path,'infra/migrations');const writer=new SqliteLedgerRepository(path),telegram=new SqliteLedgerRepository(path);try{writer.ensurePosition('v4:1','1','pool');writer.db.exec('BEGIN IMMEDIATE');writer.db.prepare("UPDATE v4_pool_registry SET updated_at=updated_at WHERE 0").run();expect(()=>persistedPositionViews(telegram)).not.toThrow();expect(telegram.db.prepare("SELECT COUNT(*) count FROM positions").get()).toEqual({count:1});writer.db.exec('ROLLBACK');}finally{try{writer.db.exec('ROLLBACK');}catch{}telegram.close();writer.close();rmSync(dir,{recursive:true,force:true});}});
 it('does not wrap a registry event window in one WAL-writer transaction',()=>{const source=readFileSync('apps/cli/src/v4-registry.ts','utf8'),sync=source.slice(source.indexOf('export async function syncV4PoolRegistry'),source.indexOf('/** Explicit one-time bootstrap'));expect(sync).not.toContain('persistWindow');expect(sync).not.toContain('repo.db.transaction');expect(source).toContain('V4_REGISTRY_WRITER_ROWS_PER_WINDOW=1');expect(sync.indexOf('for(const event of events)')).toBeLessThan(sync.indexOf('commitV4RegistryWindow'));expect(source).toContain("busy_timeout=${V4_REGISTRY_BACKGROUND_BUSY_TIMEOUT_MS}");});
});
