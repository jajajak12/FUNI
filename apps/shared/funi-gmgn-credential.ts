import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

export const FUNI_GMGN_PROJECT_ENV_PATH=resolve(dirname(fileURLToPath(import.meta.url)),'../../.env');
export const FUNI_GMGN_CREDENTIAL_PRELOAD_PATH=resolve(dirname(fileURLToPath(import.meta.url)),'gmgn-cli-credential-preload.cjs');
export type FuniGmgnCredentialSource='FUNI_PROJECT_ENV'|'GLOBAL_GMGN_CLI_FALLBACK';
export type FuniGmgnCredentialResolution={apiKey?:string;present:boolean;source:FuniGmgnCredentialSource};

export function resolveFuniGmgnApiKey(envFilePath=FUNI_GMGN_PROJECT_ENV_PATH):FuniGmgnCredentialResolution{
 let parsed:Record<string,string>;
 try{parsed=parse(readFileSync(envFilePath));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {present:false,source:'GLOBAL_GMGN_CLI_FALLBACK'};throw error;}
 const apiKey=parsed.GMGN_API_KEY?.trim();
 return apiKey?{apiKey,present:true,source:'FUNI_PROJECT_ENV'}:{present:false,source:'GLOBAL_GMGN_CLI_FALLBACK'};
}

export function resolveFuniGmgnCredentialPreloadPath(override=process.env.FUNI_GMGN_CREDENTIAL_PRELOAD_PATH):string{
 const path=override?resolve(override):FUNI_GMGN_CREDENTIAL_PRELOAD_PATH;
 let stat;
 try{stat=statSync(path);}
 catch{throw new Error(`FUNI GMGN credential preload must be an existing file: ${path}`);}
 if(!stat.isFile())throw new Error(`FUNI GMGN credential preload must be an existing file: ${path}`);
 return path;
}

export function funiGmgnChildEnv(parentEnv:NodeJS.ProcessEnv=process.env,envFilePath=FUNI_GMGN_PROJECT_ENV_PATH):NodeJS.ProcessEnv{
 const credential=resolveFuniGmgnApiKey(envFilePath);
 const preload=resolveFuniGmgnCredentialPreloadPath();
 return {
  PATH:parentEnv.PATH,
  HOME:parentEnv.HOME,
  USER:parentEnv.USER,
  NODE_OPTIONS:`--require=${preload}`,
  ...(credential.apiKey?{GMGN_API_KEY:credential.apiKey}:{})
 };
}
