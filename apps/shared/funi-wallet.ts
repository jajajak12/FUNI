import { getAddress, type Address } from 'viem';

export type FuniWalletEnvironment=Partial<Record<'WALLET_ADDRESS'|'OPERATOR_WALLET'|'DEDICATED_WALLET_ADDRESS',string|undefined>>;

/** WALLET_ADDRESS is the canonical public execution identity. Legacy aliases
 * remain accepted only when they agree, so a reader can never silently fork
 * ownership classification from execution. */
export function resolveCanonicalFuniWallet(env:FuniWalletEnvironment,signerAddress?:string):Address|undefined{
 const configured=[env.WALLET_ADDRESS,env.OPERATOR_WALLET,env.DEDICATED_WALLET_ADDRESS].filter((value):value is string=>Boolean(value?.trim())).map(value=>getAddress(value.trim()));
 const signer=signerAddress?getAddress(signerAddress):undefined,canonical=configured[0]??signer;
 if(!canonical)return undefined;
 const mismatched=[...configured,...(signer?[signer]:[])].find(address=>address.toLowerCase()!==canonical.toLowerCase());
 if(mismatched)throw new Error(`FUNI_CANONICAL_WALLET_MISMATCH canonical=${canonical} conflicting=${mismatched}`);
 return canonical;
}
