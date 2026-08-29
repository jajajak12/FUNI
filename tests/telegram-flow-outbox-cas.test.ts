import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSqlite, SqliteLedgerRepository } from '@funi/ledger';

describe('Telegram direct-lookup flow CAS wiring',()=>{
 it('migrates deterministic flow revisions and durable subscriber base revisions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'funi-flow-cas-')),path=join(dir,'db.sqlite');
  migrateSqlite(path,join(process.cwd(),'infra/migrations'));
  const repo=new SqliteLedgerRepository(path);
  try{
   const flowColumns=repo.db.prepare("PRAGMA table_info('telegram_flow_sessions')").all() as Array<Record<string,unknown>>,
    subscriberColumns=repo.db.prepare("PRAGMA table_info('direct_token_lookup_subscribers')").all() as Array<Record<string,unknown>>,
    revision=flowColumns.find(column=>column.name==='flow_revision');
   expect(revision).toMatchObject({notnull:1,dflt_value:'0'});
   expect(subscriberColumns.some(column=>column.name==='base_flow_revision')).toBe(true);
  }finally{repo.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('binds the originating revision and uses it as the outbox CAS authority',()=>{
  const source=readFileSync('apps/telegram-lp-bot/src/index.ts','utf8'),
   outbox=source.slice(source.indexOf('async function deliverDirectLookupOutbox'),source.indexOf('async function directLookupOutboxConsumer'));
  expect(source).toContain('SET base_flow_revision=?');
  expect(outbox).toContain('expectedRevision: baseFlowRevision');
  expect(outbox).toContain('expectedStatus: "active"');
  expect(outbox).toContain('staleAsyncWritePrevented: true');
  expect(outbox).toContain('telegram_direct_lookup_stale_async_write_prevented');
  expect(outbox).not.toContain('transitionTelegramFlow({');
  expect(outbox.indexOf('transitionTelegramFlowCAS')).toBeLessThan(outbox.indexOf('editMessageText'));
 });
 it('covers pool and v4_strategy Back states without changing callback payload size',()=>{
  const source=readFileSync('apps/telegram-lp-bot/src/index.ts','utf8'),
   back=source.slice(source.indexOf('else if (kind === "back")'),source.indexOf('else if (kind === "cancel-flow")'));
  expect(source).toContain('poolSelectionState: flow.state');
  expect(back).toContain('state.kind === "v4_strategy"');
  expect(back).toContain('back to exact pool selection');
  expect(back).toContain('state.kind === "pool"');
  expect(back).toContain('back to token entry');
  expect(Buffer.byteLength('back:00000000-0000-0000-0000-000000000000','utf8')).toBeLessThanOrEqual(64);
 });
});
