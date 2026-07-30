import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSqlite, SqliteLedgerRepository } from '@robin/ledger';
import { dispatchRangeCallback, parseRangeCallback, v4AmountRangeSelection } from '../apps/telegram-lp-bot/src/range-callbacks.js';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'robin-range-callback-')),path=join(dir,'db.sqlite');migrateSqlite(path,'infra/migrations');const repo=new SqliteLedgerRepository(path);return {dir,repo,close(){repo.close();rmSync(dir,{recursive:true,force:true});}};}

describe('Telegram range callback isolation',()=>{
 it('routes an open v4 range only to the open flow, transitions once, and renders the amount prompt',async()=>{
  const f=fixture();try{const flow=f.repo.createTelegramFlow({userId:'u',chatId:'c',state:{kind:'v4_mode',v4SelectionId:'selection-1'},now:1_700_000_000_000,ttlMs:600_000});let openCalls=0,rebalanceCalls=0,prompt='';
   await dispatchRangeCallback('v4-range:selection-1:30',{open:async(selectionId,value)=>{openCalls++;expect(selectionId).toBe('selection-1');expect(value).toBe('30');const selected=v4AmountRangeSelection({state:flow.state,range:{upperDropPct:0,lowerDropPct:30},selectionQuote:{quoteBlock:'1'},fundingBalance:12_500_000n,funding:{symbol:'USDG',address:'0x0000000000000000000000000000000000000001',decimals:6},rangePricing:'LP price range: $1 → $0.70'});prompt=selected.prompt;f.repo.transitionTelegramFlow({userId:'u',chatId:'c',sessionId:flow.sessionId,state:selected.state,now:1_700_000_000_001,ttlMs:600_000});},rebalance:async()=>{rebalanceCalls++;}});
   expect(openCalls).toBe(1);expect(rebalanceCalls).toBe(0);expect(f.repo.activeTelegramFlow({userId:'u',chatId:'c',now:1_700_000_000_002})?.state.kind).toBe('v4_amount');expect(prompt).toContain('Enter USDG amount');expect(prompt).toContain('Available capital: 12.5 USDG');
  }finally{f.close();}}
 );

 it('routes a rebalance range only to the rebalance flow',async()=>{
  let openCalls=0,rebalanceCalls=0;
  await dispatchRangeCallback('rebalance-range:50',{open:async()=>{openCalls++;},rebalance:async value=>{rebalanceCalls++;expect(value).toBe('50');}});
  expect(rebalanceCalls).toBe(1);expect(openCalls).toBe(0);expect(parseRangeCallback('v4-range:selection-1:50')?.kind).toBe('v4_open_range');expect(parseRangeCallback('rebalance-range:50')?.kind).toBe('rebalance_range');expect(parseRangeCallback('v4-range:selection-1:50:extra')).toBeUndefined();
 });

 it('acknowledges every callback before routing and guards duplicate acknowledgements',()=>{
  const source=readFileSync('apps/telegram-lp-bot/src/index.ts','utf8');
  expect(source).toMatch(/bot\.use\s*\(\s*async\s*\(\s*ctx\s*,\s*next\s*\)\s*=>\s*\{\s*if\s*\(\s*ctx\.callbackQuery\s*\)\s*await\s+acknowledgeCallback\s*\(\s*ctx\s*\)\s*;?\s*return\s+next\s*\(\s*\)/);
  expect(source).toMatch(/if\s*\(\s*!ctx\.callbackQuery\s*\|\|\s*acknowledgedCallbacks\.has\s*\(\s*String\s*\(\s*ctx\.callbackQuery\.id\s*\)\s*\)\s*\)\s*return\s+0/);
 });
});
