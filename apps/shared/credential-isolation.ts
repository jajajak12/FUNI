import { resolveFuniGmgnApiKey } from './funi-gmgn-credential.js';

export const NOVA_ONLY_CREDENTIALS = Object.freeze([
  'NOVA_TELEGRAM_BOT_TOKEN',
  'NOVA_TELEGRAM_CHAT_ID',
  'BIRDEYE_API_KEY',
  'BIRDEYE_API_KEYS',
  'HELIUS_API_KEY',
  'HELIUS_API_KEYS',
  'HELIUS_FALLBACK_API_KEY',
  'GMGN_API_KEY',
  'JUPITER_API_KEY',
  'NOVA_PRIVATE_KEY',
  'NOVA_WALLET_PRIVATE_KEY',
  'NOVA_SIGNING_KEY',
  'NOVA_SIGNER_PRIVATE_KEY'
]);

export const FUNI_SIGNING_CREDENTIALS = Object.freeze(['LP_PRIVATE_KEY']);

// FUNI rejects seed-phrase aliases. They are
// listed so signer-free workers can strip all known signing material.
export const UNSUPPORTED_FUNI_SIGNING_ALIASES = Object.freeze([
  'LP_MNEMONIC',
  'MNEMONIC',
  'SEED_PHRASE',
  'PRIVATE_KEY',
  'WALLET_PRIVATE_KEY',
  'SIGNING_KEY',
  'SIGNER_PRIVATE_KEY'
]);

const hasCredential=(env:NodeJS.ProcessEnv,name:string)=>
  Object.prototype.hasOwnProperty.call(env,name)&&String(env[name]??'').trim()!=='';

export function assertFuniCredentialIsolation(env:NodeJS.ProcessEnv=process.env,funiEnvFilePath?:string):void{
  if(hasCredential(env,'GMGN_API_KEY')){
    const project=resolveFuniGmgnApiKey(funiEnvFilePath);
    if(project.apiKey&&env.GMGN_API_KEY?.trim()===project.apiKey)delete env.GMGN_API_KEY;
  }
  const explicit=NOVA_ONLY_CREDENTIALS.find(name=>hasCredential(env,name));
  const prefixed=Object.keys(env).find(name=>/^NOVA_.*(?:PRIVATE|SIGN|SECRET|TOKEN|API_KEY)/.test(name)&&hasCredential(env,name));
  const forbidden=explicit??prefixed;
  if(!forbidden)return;
  throw Object.assign(
    new Error(`FUNI startup rejected: forbidden NOVA variable ${forbidden} is present`),
    {code:'FUNI_FORBIDDEN_FOREIGN_CREDENTIAL'}
  );
}
