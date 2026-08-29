import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gmgnCliJson } from '../apps/shared/gmgn-market.js';
import { FUNI_GMGN_CREDENTIAL_PRELOAD_PATH, resolveFuniGmgnApiKey, resolveFuniGmgnCredentialPreloadPath, funiGmgnChildEnv } from '../apps/shared/funi-gmgn-credential.js';

const dirs:string[]=[];
const envFile=(body:string)=>{const dir=mkdtempSync(join(tmpdir(),'funi-gmgn-credential-'));dirs.push(dir);const path=join(dir,'.env');writeFileSync(path,body,{mode:0o600});return path;};
afterEach(()=>{vi.restoreAllMocks();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

describe('FUNI dedicated GMGN credential propagation',()=>{
 it('resolves a project key without mutating the stripped parent environment',()=>{
  const path=envFile('GMGN_API_KEY=funi-project-secret\n');
  const parent={PATH:'/bin',HOME:'/tmp',USER:'funi'} as NodeJS.ProcessEnv;
  expect(resolveFuniGmgnApiKey(path)).toEqual({apiKey:'funi-project-secret',present:true,source:'FUNI_PROJECT_ENV'});
  expect(funiGmgnChildEnv(parent,path).GMGN_API_KEY).toBe('funi-project-secret');
  expect(parent.GMGN_API_KEY).toBeUndefined();
 });

 it('makes the FUNI project key win over a different inherited/global value',()=>{
  const path=envFile('GMGN_API_KEY=funi-project-secret\n');
  const child=funiGmgnChildEnv({GMGN_API_KEY:'foreign-or-global-secret'} as NodeJS.ProcessEnv,path);
  expect(child.GMGN_API_KEY).toBe('funi-project-secret');
  expect(child.GMGN_API_KEY).not.toBe('foreign-or-global-secret');
 });

 it('omits the child override only when the FUNI project key is genuinely absent',()=>{
  for(const body of ['', 'GMGN_API_KEY=   \n']){
   const path=envFile(body),resolution=resolveFuniGmgnApiKey(path),child=funiGmgnChildEnv({GMGN_API_KEY:'foreign-secret'} as NodeJS.ProcessEnv,path);
   expect(resolution).toEqual({present:false,source:'GLOBAL_GMGN_CLI_FALLBACK'});
   expect(child).not.toHaveProperty('GMGN_API_KEY');
  }
  const missing=join(tmpdir(),`funi-gmgn-missing-${Date.now()}`);
  expect(resolveFuniGmgnApiKey(missing)).toEqual({present:false,source:'GLOBAL_GMGN_CLI_FALLBACK'});
 });

 it('passes the project key to the shared gmgn-cli child used by public market discovery',async()=>{
  const path=envFile('GMGN_API_KEY=funi-project-secret\n'),dir=join(path,'..'),cli=join(dir,'gmgn-cli');
  writeFileSync(cli,"#!/bin/sh\nif [ \"$GMGN_API_KEY\" = \"funi-project-secret\" ]; then printf '{\"credential\":\"FUNI_PROJECT_ENV\"}'; else printf '{\"credential\":\"wrong\"}'; fi\n",{mode:0o700});
  const priorPath=process.env.PATH;process.env.PATH=`${dir}:${priorPath??''}`;
  try{await expect(gmgnCliJson(['market','trending'],2_000,path)).resolves.toEqual({credential:'FUNI_PROJECT_ENV'});}
  finally{priorPath===undefined?delete process.env.PATH:process.env.PATH=priorPath;}
 });

 it('does not expose either raw credential through resolver diagnostics or errors',()=>{
  const path=envFile('GMGN_API_KEY=funi-project-secret\n'),diagnostic=resolveFuniGmgnApiKey(path);
  expect(JSON.stringify({present:diagnostic.present,source:diagnostic.source})).not.toContain('funi-project-secret');
  expect(()=>resolveFuniGmgnApiKey(join(path,'nested'))).not.toThrowError(/funi-project-secret|foreign-secret/);
 });

 it('uses the package-relative bundled preload by default and keeps it wired without a project key',()=>{
  expect(FUNI_GMGN_CREDENTIAL_PRELOAD_PATH).toMatch(/apps\/shared\/gmgn-cli-credential-preload\.cjs$/);
  expect(readFileSync(FUNI_GMGN_CREDENTIAL_PRELOAD_PATH,'utf8')).not.toMatch(/\/home\/[^/]+/);
  expect(resolveFuniGmgnCredentialPreloadPath()).toBe(FUNI_GMGN_CREDENTIAL_PRELOAD_PATH);
  expect(funiGmgnChildEnv({},envFile('')).NODE_OPTIONS).toBe(`--require=${FUNI_GMGN_CREDENTIAL_PRELOAD_PATH}`);
 });

 it('accepts a valid preload override and rejects an invalid one before child spawn',()=>{
  const override=envFile('module.exports={};\n');
  expect(resolveFuniGmgnCredentialPreloadPath(override)).toBe(override);
  expect(()=>resolveFuniGmgnCredentialPreloadPath(join(override,'missing'))).toThrow('must be an existing file');
 });

 it('matches GMGN preload precedence semantics using only synthetic HOME and dummy values',()=>{
  const home=mkdtempSync(join(tmpdir(),'funi-gmgn-home-'));dirs.push(home);
  const globalDir=join(home,'.config','gmgn');
  mkdirSync(globalDir,{recursive:true});
  const global=join(globalDir,'.env');
  writeFileSync(global,'GMGN_API_KEY=global-dummy\nexport GMGN_API_KEY=global-export-dummy\nGMGN_PRIVATE_KEY=private-dummy\nOTHER_KEY=retained\n');
  const script="const fs=require('node:fs');const p=process.env.TARGET;const a=fs.readFileSync(p,'utf8');const b=fs.readFileSync(p);process.stdout.write(JSON.stringify({a,b:b.toString(),isBuffer:Buffer.isBuffer(b)}));";
  const run=(apiKey:string|undefined)=>spawnSync(process.execPath,['-r',FUNI_GMGN_CREDENTIAL_PRELOAD_PATH,'-e',script],{env:{HOME:home,TARGET:global,...(apiKey===undefined?{}:{GMGN_API_KEY:apiKey})},encoding:'utf8'});
  const explicit=run('funi-dummy');
  expect(explicit.status).toBe(0);
  expect(JSON.parse(explicit.stdout)).toEqual({a:'GMGN_PRIVATE_KEY=private-dummy\nOTHER_KEY=retained\n',b:'GMGN_PRIVATE_KEY=private-dummy\nOTHER_KEY=retained\n',isBuffer:true});
  for(const empty of [undefined,'']){
   const result=run(empty);expect(result.status).toBe(0);expect(JSON.parse(result.stdout).a).toContain('GMGN_API_KEY=global-dummy');expect(JSON.parse(result.stdout).a).toContain('export GMGN_API_KEY=global-export-dummy');
  }
  const whitespace=run('   ');expect(whitespace.status).toBe(0);expect(JSON.parse(whitespace.stdout).a).not.toContain('GMGN_API_KEY=');
 });
});
