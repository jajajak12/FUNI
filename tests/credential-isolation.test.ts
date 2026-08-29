import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe,expect,it } from 'vitest';
import {
  NOVA_ONLY_CREDENTIALS,
  assertFuniCredentialIsolation
} from '../apps/shared/credential-isolation.js';

const require=createRequire(import.meta.url);

describe('NOVA/FUNI credential isolation',()=>{
  it('rejects every explicit NOVA credential without logging its value',()=>{
    for(const name of NOVA_ONLY_CREDENTIALS){
      const sentinel=`credential-sentinel-${name}`;
      expect(()=>assertFuniCredentialIsolation({[name]:sentinel})).toThrow(name);
      try{assertFuniCredentialIsolation({[name]:sentinel});}catch(error){
        expect(String(error)).not.toContain(sentinel);
      }
    }
  });

  it('rejects a future NOVA-prefixed signing alias',()=>{
    expect(()=>assertFuniCredentialIsolation({NOVA_FUTURE_SIGNING_KEY:'credential-sentinel'})).toThrow('NOVA_FUTURE_SIGNING_KEY');
  });

  it('strips only the exact FUNI project GMGN value loaded into a worker parent',()=>{
    const dir=mkdtempSync(join(tmpdir(),'funi-isolation-')),path=join(dir,'.env');
    try{
      writeFileSync(path,'GMGN_API_KEY=funi-project-secret\n');
      const local={GMGN_API_KEY:'funi-project-secret'};expect(()=>assertFuniCredentialIsolation(local,path)).not.toThrow();expect(local).not.toHaveProperty('GMGN_API_KEY');
      const foreign={GMGN_API_KEY:'foreign-project-secret'};expect(()=>assertFuniCredentialIsolation(foreign,path)).toThrow('GMGN_API_KEY');expect(foreign.GMGN_API_KEY).toBe('foreign-project-secret');
    }finally{rmSync(dir,{recursive:true,force:true});}
  });

  it('filters NOVA credential sources from every FUNI PM2 app',()=>{
    const config=require('../infra/pm2/ecosystem.config.cjs') as {apps:Array<{filter_env:string[]}>};
    expect(config.apps.length).toBeGreaterThan(0);
    for(const app of config.apps){
      expect(app.filter_env).toContain('NOVA_');
      expect(app.filter_env).toContain('GMGN_API_KEY');
    }
  });

  it('fails closed through FUNI Telegram env loading',()=>{
    const sentinel='credential-sentinel-import';
    const result=spawnSync('./node_modules/.bin/tsx',['-e',"import './apps/telegram-lp-bot/src/load-env.ts'"],{
      cwd:process.cwd(),
      env:{...process.env,NOVA_TELEGRAM_BOT_TOKEN:sentinel},
      encoding:'utf8'
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FUNI startup rejected: forbidden NOVA variable NOVA_TELEGRAM_BOT_TOKEN is present');
    expect(result.stderr).not.toContain(sentinel);
  });
});
