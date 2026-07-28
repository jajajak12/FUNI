import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import dotenv from 'dotenv';

const require=createRequire(import.meta.url);

describe('Telegram PM2 operational flags',()=>{
  it('forwards authoritative execution flags and only project-specific Telegram credentials',()=>{
    const authoritative=dotenv.parse(readFileSync('.env'));
    const config=require('../infra/pm2/ecosystem.config.cjs') as {apps:Array<{name:string;env:Record<string,unknown>}>};
    const telegram=config.apps.find(app=>app.name==='robinhood-lp-telegram');
    expect(telegram).toBeDefined();
    const flags=['EXECUTION_ENABLED','DRY_RUN','EMERGENCY_PAUSE','LIVE_CANARY_ENABLED','V4_LIVE_CANARY_ENABLED'];
    for(const flag of flags)expect(telegram!.env[flag]).toBe(authoritative[flag]);
    expect(telegram!.env.ROBIN_TELEGRAM_BOT_TOKEN).toBe(authoritative.ROBIN_TELEGRAM_BOT_TOKEN);
    expect(telegram!.env.ROBIN_TELEGRAM_CHAT_ID).toBe(authoritative.ROBIN_TELEGRAM_CHAT_ID);
    expect(telegram!.env.TELEGRAM_BOT_TOKEN).toBe('');
    expect(telegram!.env.TELEGRAM_CHAT_ID).toBe('');
    expect(telegram!.env.ALCHEMY_RPC_URL).toBe(authoritative.ALCHEMY_RPC_URL);
    expect(telegram!.env.ALCHEMY_RPC_URLS).toBe(authoritative.ALCHEMY_RPC_URLS);
    expect(Object.keys(telegram!.env).filter(key=>/(PRIVATE|MNEMONIC|SEED|SECRET)/i.test(key))).toEqual([]);
    const stateCache=config.apps.find(app=>app.name==='robin-v4-state-cache-worker');
    expect(stateCache!.env.ALCHEMY_RPC_URL).toBe(authoritative.ALCHEMY_RPC_URL);
    expect(stateCache!.env.ALCHEMY_RPC_URLS).toBe(authoritative.ALCHEMY_RPC_URLS);
  });
});
