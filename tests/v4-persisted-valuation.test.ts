import { describe, expect, it } from 'vitest';
import { v4CurrentValuationDecimals } from '../apps/cli/src/active-position-reconciliation.js';

const brodie='0x0000000000000000000000000000000000000011';
const usdg='0x0000000000000000000000000000000000000022';
const key={currency0:brodie,currency1:usdg,fee:500,tickSpacing:10,hooks:'0x0000000000000000000000000000000000000000'} as const;
const metadata={source:'LIVE_V4_POSITION_INSPECTION',currency0:{address:brodie,symbol:'BRODIE',decimals:18},currency1:{address:usdg,symbol:'USDG',decimals:6}};

describe('persisted external V4 valuation metadata',()=>{
 it('never lets Number(null) select currency0 decimals',()=>{
  expect(Number(null)).toBe(0);
  expect(v4CurrentValuationDecimals({target_index:null,target_decimals:null,funding_decimals:null,valuation_provenance_json:null},key)).toBeUndefined();
 });
 it('uses verified currency0/currency1 metadata for BRODIE/USDG at 18/6',()=>{
  const decimals=v4CurrentValuationDecimals({valuation_provenance_json:JSON.stringify(metadata),target_index:null,target_decimals:null,funding_decimals:null},key);
  expect(decimals).toMatchObject({currency0:18,currency1:6,source:'LIVE_V4_POSITION_INSPECTION'});
  expect(Number(917108119n)/10**decimals!.currency1).toBeCloseTo(917.108119,6);
 });
 it('does not fall back to 18/18 when verified metadata is absent or ambiguous',()=>{
  expect(v4CurrentValuationDecimals({valuation_provenance_json:JSON.stringify({...metadata,currency1:{...metadata.currency1,address:brodie}})},key)).toBeUndefined();
  expect(v4CurrentValuationDecimals({target_index:0,target_token:brodie,funding_token:usdg,target_decimals:18,funding_decimals:6},key)).toMatchObject({currency0:18,currency1:6,source:'COMPLETE_ORIENTATION_METADATA'});
 });
 it('keeps zero-liquidity geometry independent from metadata scale',()=>{
  const liquidity=0n,decimals=v4CurrentValuationDecimals({valuation_provenance_json:JSON.stringify(metadata)},key);
  expect(liquidity).toBe(0n);expect(decimals?.currency1).toBe(6);
 });
});
