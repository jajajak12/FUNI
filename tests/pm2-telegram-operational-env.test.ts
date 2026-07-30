import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import dotenv from 'dotenv';

describe('Telegram PM2 operational flags',()=>{
  it('uses the sanitized public fixture with documented names and fail-closed execution defaults',()=>{
    const documented=dotenv.parse(readFileSync('.env.example'));
    const config=require('../infra/pm2/ecosystem.config.cjs') as {apps:Array<{name:string;env:Record<string,unknown>}>};
    const telegram=config.apps.find(app=>app.name==='robinhood-lp-telegram');
    expect(telegram).toBeDefined();
    const flags=['EXECUTION_ENABLED','DRY_RUN','EMERGENCY_PAUSE','LIVE_CANARY_ENABLED','V4_LIVE_CANARY_ENABLED'];
    for(const flag of flags){expect(documented).toHaveProperty(flag);expect(telegram!.env[flag]).toBe({EXECUTION_ENABLED:'false',DRY_RUN:'true',EMERGENCY_PAUSE:'true',LIVE_CANARY_ENABLED:'false',V4_LIVE_CANARY_ENABLED:'false'}[flag]);}
    expect(telegram!.env.ROBIN_TELEGRAM_BOT_TOKEN).toBe('');
    expect(telegram!.env.ROBIN_TELEGRAM_CHAT_ID).toBe('');
    expect(telegram!.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(telegram!.env.TELEGRAM_CHAT_ID).toBeUndefined();
    expect(telegram!.env.ALCHEMY_RPC_URL).toBe('');
    expect(telegram!.env.ALCHEMY_RPC_URLS).toBe('');
    expect(Object.keys(telegram!.env).filter(key=>/(PRIVATE|MNEMONIC|SEED|SECRET)/i.test(key))).toEqual([]);
    expect(Object.keys(telegram!.env).every(key=>key==='NODE_ENV'||Object.hasOwn(documented,key))).toBe(true);
    expect(JSON.stringify(config)).not.toMatch(/\/home\/|https?:\/\/|sqlite|0x[0-9a-f]{40}/i);
  });
});
