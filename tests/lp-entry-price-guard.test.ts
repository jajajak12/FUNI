import { describe, expect, it, vi } from 'vitest';
import { evaluateLpEntryPriceGuard, fetchCanonicalGmgnEntryPrice, freshLpEntryPriceGuard, LP_ENTRY_PRICE_PREVIEW_TTL_MS, orientPoolPriceFundingPerTarget, priceGuardCooldown } from '../apps/cli/src/lp-entry-price-guard.js';

const token='0x0000000000000000000000000000000000000001' as const;
describe('LP entry GMGN price guard',()=>{
 it('enforces the exact 1000 BPS boundary without floating equality',()=>{
  expect(evaluateLpEntryPriceGuard({poolPriceFundingPerTarget:'1',gmgnTargetUsd:'1',fundingUsd:'1'}).deviationBps).toBe(0n);
  expect(evaluateLpEntryPriceGuard({poolPriceFundingPerTarget:'1.0999',gmgnTargetUsd:'1',fundingUsd:'1'}).status).toBe('PASS');
  expect(evaluateLpEntryPriceGuard({poolPriceFundingPerTarget:'1.1',gmgnTargetUsd:'1',fundingUsd:'1'}).status).toBe('BLOCK');
  expect(evaluateLpEntryPriceGuard({poolPriceFundingPerTarget:'1.1001',gmgnTargetUsd:'1',fundingUsd:'1'}).status).toBe('BLOCK');
 });
 it('orients both pool directions and accounts for funding USD value',()=>{
  expect(orientPoolPriceFundingPerTarget({priceToken1PerToken0:2,token0:token,token1:'0x0000000000000000000000000000000000000002',target:token,funding:'0x0000000000000000000000000000000000000002'})).toBe(2);
  expect(orientPoolPriceFundingPerTarget({priceToken1PerToken0:2,token0:token,token1:'0x0000000000000000000000000000000000000002',target:'0x0000000000000000000000000000000000000002',funding:token})).toBe(.5);
  expect(evaluateLpEntryPriceGuard({poolPriceFundingPerTarget:'0.5',gmgnTargetUsd:'1000',fundingUsd:'2000'}).status).toBe('PASS');
 });
 it('fails closed for missing, invalid, or failed GMGN evidence',async()=>{
  expect(evaluateLpEntryPriceGuard({poolPriceFundingPerTarget:1,gmgnTargetUsd:null,fundingUsd:1}).status).toBe('BLOCK');
  await expect(fetchCanonicalGmgnEntryPrice(token,{invoke:async()=>({address:token,price:{price:0}})})).rejects.toThrow('GMGN_TOKEN_PRICE_INVALID');
  expect((await freshLpEntryPriceGuard({target:token,poolPriceFundingPerTarget:1,fundingUsd:1,fetch:async()=>{throw new Error('GMGN_DOWN');}})).status).toBe('BLOCK');
 });
 it('uses a 30-second preview TTL and a fresh fetch for every final preflight',async()=>{
  const evidence=await fetchCanonicalGmgnEntryPrice(token,{now:()=>1000,invoke:async()=>({address:token,price:{price:'1'}})});expect(evidence.freshUntilMs-evidence.fetchedAtMs).toBe(LP_ENTRY_PRICE_PREVIEW_TTL_MS);
  const fetch=vi.fn(async()=>evidence);await freshLpEntryPriceGuard({target:token,poolPriceFundingPerTarget:1,fundingUsd:1,fetch});await freshLpEntryPriceGuard({target:token,poolPriceFundingPerTarget:1,fundingUsd:1,fetch});expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('blocks retries for exactly ten seconds and never auto-retries',()=>{
  const first=priceGuardCooldown({nowMs:1000,blocked:true});expect(first).toEqual({allowed:false,untilMs:11000,remainingMs:10000});
  expect(priceGuardCooldown({nowMs:10999,blocked:false,existingUntilMs:first.untilMs}).allowed).toBe(false);
  expect(priceGuardCooldown({nowMs:11000,blocked:false,existingUntilMs:first.untilMs}).allowed).toBe(true);
  expect(priceGuardCooldown({nowMs:11000,blocked:true,existingUntilMs:first.untilMs}).untilMs).toBe(21000);
 });
});
