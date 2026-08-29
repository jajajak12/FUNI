import { describe,expect,it } from 'vitest';
import { deriveTokenStableMarketRange } from '../apps/cli/src/portfolio.js';
import { compactUsd,marketRangeLines } from '../apps/telegram-lp-bot/src/persisted-portfolio.js';

const jacket='0x00000000000000000000000000000000000000a1' as const,usdg='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const;
const circulating={raw:'1000000000000000000000000000',normalized:1_000_000_000,kind:'CIRCULATING' as const,source:'fixture:circulating',observedAt:'2026-07-28T00:00:00.000Z',decimals:18};
const total={...circulating,kind:'TOTAL' as const,source:'rpc:ERC20.totalSupply'};
const input={token0:jacket,token1:usdg,token0Usd:.00499,token1Usd:1,token0Decimals:18,token1Decimals:6,tickLower:-54000,tickUpper:-50000};

describe('canonical LP market-range display',()=>{
 it('renders an external JACKET/USDG-like v4 range using canonical ticks and circulating supply',()=>{
  const range=deriveTokenStableMarketRange({...input,supply:circulating});
  expect(range.label).toBe('MC');expect(range.currentUsd).toBeCloseTo(4_990_000);expect(range.lowerUsd).not.toBeNull();expect(range.upperUsd).not.toBeNull();expect(range.lowerUsd!).toBeLessThan(range.upperUsd!);
  const text=marketRangeLines(range).join('\n');expect(text).toContain('Current MC: $4.99M');expect(text).toContain('LP MC range: $');expect(text).toContain('Range status:');
 });
 it('uses the identical canonical range math for bot and external provenance',()=>{
  const bot=deriveTokenStableMarketRange({...input,supply:circulating}),external=deriveTokenStableMarketRange({...input,supply:circulating});
  expect(external).toEqual(bot);
 });
 it('inverts token orientation while keeping lower and upper valuation bounds ordered',()=>{
  const direct=deriveTokenStableMarketRange({...input,supply:circulating}),inverse=deriveTokenStableMarketRange({token0:usdg,token1:jacket,token0Usd:1,token1Usd:.00499,token0Decimals:6,token1Decimals:18,tickLower:50000,tickUpper:54000,supply:circulating});
  expect(inverse.lowerUsd!).toBeLessThan(inverse.upperUsd!);expect(inverse.currentUsd).toBeCloseTo(direct.currentUsd!);expect(inverse.rangeStatus).toBe(direct.rangeStatus);
 });
 it('labels total-supply valuation as FDV and names missing supply precisely',()=>{
  expect(deriveTokenStableMarketRange({...input,supply:total}).label).toBe('FDV');
  const missing=deriveTokenStableMarketRange(input);expect(missing.reason).toBe('SUPPLY_EVIDENCE_MISSING');expect(marketRangeLines(missing).join('\n')).toContain('Reason: Supply evidence missing');
 });
 it('reports canonical metadata failures without a generic range result',()=>{
  expect(deriveTokenStableMarketRange({...input,tickLower:null}).reason).toBe('LP_TICK_METADATA_UNAVAILABLE');
  expect(deriveTokenStableMarketRange({...input,token0Decimals:null}).reason).toBe('TOKEN_DECIMALS_UNAVAILABLE');
 });
 it('classifies below, in, and above range in volatile-token terms',()=>{
  const base=deriveTokenStableMarketRange({...input,supply:circulating}),lower=base.lowerUsd!/circulating.normalized,upper=base.upperUsd!/circulating.normalized;
  expect(deriveTokenStableMarketRange({...input,token0Usd:(lower+upper)/2,supply:circulating}).rangeStatus).toBe('IN_RANGE');
  expect(deriveTokenStableMarketRange({...input,token0Usd:lower/2,supply:circulating}).rangeStatus).toBe('BELOW_RANGE');
  expect(deriveTokenStableMarketRange({...input,token0Usd:upper*2,supply:circulating}).rangeStatus).toBe('ABOVE_RANGE');
 });
 it('uses compact K/M/B formatting without collapsing narrow ranges',()=>{
  expect(compactUsd(999.12)).toBe('$999.12');expect(compactUsd(12_340)).toBe('$12.34K');expect(compactUsd(4_990_000)).toBe('$4.99M');expect(compactUsd(1_200_000_000)).toBe('$1.20B');
 });
});
