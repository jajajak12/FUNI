import { describe,expect,it } from 'vitest';
import { finalActionDisposition } from '../apps/telegram-lp-bot/src/final-action.js';
import { parseV4CustomRange, parseV4RangeChoice, v4RangeButtons } from '../apps/telegram-lp-bot/src/v4-range-ux.js';

describe('single final Telegram action',()=>{
 it('allows one unexpired final action and treats expiry as nonfatal',()=>{expect(finalActionDisposition({expiresAtMs:2_000,nowMs:1_000,state:'PREVIEWED'}).status).toBe('CLAIMABLE');expect(finalActionDisposition({expiresAtMs:1_000,nowMs:1_000,state:'PREVIEWED'}).status).toBe('PREVIEW_EXPIRED');});
 it('never treats duplicate or recovered callbacks as a new claim',()=>{expect(finalActionDisposition({expiresAtMs:0,nowMs:1_000,state:'PROCESSING'}).status).toBe('ALREADY_PROCESSING');expect(finalActionDisposition({expiresAtMs:0,nowMs:1_000,state:'COMPLETED'}).status).toBe('ALREADY_COMPLETED');});
});
describe('v4 range Telegram parity',()=>{
 it('offers exactly the v3-parity presets plus custom',()=>{expect(v4RangeButtons('selection').flat().map(x=>x.label)).toEqual(['USDG-only current → -10%','USDG-only current → -30%','USDG-only current → -50%','USDG-only current → -60%','USDG-only Custom range']);expect(parseV4RangeChoice('30')).toEqual({upperDropPct:0,lowerDropPct:30});});
 it('uses the shared custom semantics and validation wording',()=>{expect(parseV4CustomRange('30,60')).toEqual({upperDropPct:30,lowerDropPct:60});expect(()=>parseV4CustomRange('60,30')).toThrow('0 <= upperDropPct');expect(()=>parseV4CustomRange('bad')).toThrow('Enter two percentages');});
});
