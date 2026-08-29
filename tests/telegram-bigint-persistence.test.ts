import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsonStringify, migrateSqlite, SqliteLedgerRepository } from '@funi/ledger';
import { safeTelegramError, safeTelegramOperation } from '../apps/telegram-lp-bot/src/telegram-error.js';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'funi-telegram-bigint-')),path=join(dir,'db.sqlite');migrateSqlite(path,'infra/migrations');const repo=new SqliteLedgerRepository(path);return {repo,close(){repo.close();rmSync(dir,{recursive:true,force:true});}};}
describe('Telegram durable BigInt persistence',()=>{
 it('serializes direct, nested, array, pricing, pool, tick and amount BigInts exactly without mutating input',()=>{
  const f=fixture();try{const state:any={kind:'v4_mode',poolKey:{sqrtPriceX96:12345678901234567890n},rangeSelectionQuote:{quoteBlock:9876543210987654321n,pricing:{ticks:[-120,120],amounts:[1n,{raw:2n}]}},provenance:[{block:3n}],fundingBalance:4n};const original=state.rangeSelectionQuote.quoteBlock;const flow=f.repo.createTelegramFlow({userId:'u',chatId:'c',state:{kind:'pool'},now:1_700_000_000_000,ttlMs:600_000});const result=f.repo.transitionTelegramFlowCAS({userId:'u',chatId:'c',sessionId:flow.sessionId,expectedRevision:flow.flowRevision,expectedStatus:'active',nextState:{...state,kind:'v4_amount'},now:1_700_000_000_001,ttlMs:600_000}),next=result.flow!;const raw=f.repo.db.prepare('select state_json from telegram_flow_sessions where session_id=?').get(flow.sessionId) as {state_json:string};expect(raw.state_json).toContain('"9876543210987654321"');expect(raw.state_json).toContain('"12345678901234567890"');expect(result.result).toBe('APPLIED');expect(next.state.kind).toBe('v4_amount');expect((next.state.rangeSelectionQuote as any).quoteBlock).toBe('9876543210987654321');expect(state.rangeSelectionQuote.quoteBlock).toBe(original);expect(typeof state.poolKey.sqrtPriceX96).toBe('bigint');}finally{f.close();}
 });
 it('uses deterministic BigInt-safe JSON for every Telegram flow/session boundary',()=>{const payload={a:1n,nested:[2n,{b:3n}],nil:null,ok:true,text:'x',finite:1.25};expect(jsonStringify(payload)).toBe('{"a":"1","nested":["2",{"b":"3"}],"nil":null,"ok":true,"text":"x","finite":1.25}');});
 it('never includes a synthetic context secret in scalar error metadata',()=>{const secret=['123456','synthetic_secret_value_that_must_not_appear'].join(':');const details=safeTelegramError(new Error(`failure ${secret}`));const rendered=JSON.stringify({operation:safeTelegramOperation({callbackQuery:{data:'v4-range:session:10'},api:{token:secret}}),...details});expect(rendered).not.toContain(secret);expect(rendered).toContain('v4-range');});
});
