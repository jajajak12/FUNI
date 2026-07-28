import { describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  formatPortfolioSnapshot,
  formatRebalanceExposurePreview,
 persistedPositionCard,
 persistedPositionDetail,
 persistedPositionTechnicalDetails,
 type PersistedPositionView,
} from '../apps/telegram-lp-bot/src/persisted-portfolio.js';
import {
 buildV4RangePricing,
 formatV4RangePricing,
 orientedTokenPrice,
 type TrustedMarketMetric,
} from '../apps/telegram-lp-bot/src/v4-range-ux.js';
import type { BotManagedExposureResult } from '../apps/cli/src/bot-managed-exposure.js';

const accountCard={externalCapitalUsd:100,activePrincipalUsd:82,uncollectedFeesUsd:4,collectedFeesUsd:3,realizedProceedsUsd:12,gasSpentUsd:1,currentEquityUsd:86,grossPnlUsd:3,grossPnlPct:3,netPnlUsd:2,netPnlPct:2,warnings:[] as string[]};
const account={externalCapitalUsd:100,activePrincipalUsd:82,uncollectedFeesUsd:4,collectedFeesUsd:null,realizedProceedsUsd:12,gasSpentUsd:1,currentEquityUsd:86,grossPnlUsd:3,grossPnlPct:3,netPnlUsd:null,netPnlPct:null,warnings:[] as string[]};
const position:PersistedPositionView={
 protocol:'v4',tokenId:'42',positionId:'v4:42',pair:'TOKEN/USDG',poolId:`0x${'a'.repeat(64)}`,status:'open',range:'$0.000445 → $0.000890',rangeStatus:'OUT_OF_RANGE',currentPriceUsd:0.00091,marketRange:{label:'MC',currentUsd:910_000,lowerUsd:445_000,upperUsd:890_000,rangeStatus:'ABOVE_RANGE',supply:{raw:'1000000000000000000',normalized:1_000_000_000,kind:'CIRCULATING',source:'fixture',observedAt:'2026-07-28T00:00:00.000Z',decimals:18}},
 source:'BOT_OPERATIONAL',accountingStatus:'RECEIPT_ACCOUNTED',accounting:accountCard as never,openedAt:'2026-07-25T12:00:00.000Z',
 lifecycle:'CONFIRMED_ACTIVE_FRESH',terminalReason:null,ownerResult:'0x0000000000000000000000000000000000000001',liquidityRaw:'12345678901234567890',tickLower:-100,tickUpper:-50,claimable0Raw:'11',claimable1Raw:'22',lastReconciledAt:'2026-07-25T12:05:00.000Z',
 baselineProvenance:'OPERATIONAL_OPEN_RECEIPT',fundingProvenance:'OPERATIONAL_OPEN_SELECTION',openIntentId:'internal-workflow-id',priceSource:'StateView.sqrtPriceX96',priceBlock:'100',priceObservedAt:'2026-07-25T12:05:00.000Z',reconciliation:'BOT_OPERATIONAL_RECEIPT_LEDGER',excludedFromAggregateReason:null,
};

describe('Telegram position and portfolio presentation',()=>{
 const exposure=(overrides:Partial<BotManagedExposureResult>={}):BotManagedExposureResult=>({breakdown:{activeBotManagedEquityUsd:100,pendingOpenCommitmentUsd:5,pendingReplacementCommitmentUsd:0,incrementalActionCapitalUsd:10,projectedExposureUsd:115,includedPositionIds:['v4:1'],includedCommitmentIds:['open:a'],externalEquityUsd:40,totalWalletEquityUsd:140,ambiguityReasons:[],releasedHistoricalCommitmentUsd:0,releasedWorkflowIds:[]},...overrides});
 it('renders compact cards with readable status/provenance labels and no technical internals',()=>{
  const text=persistedPositionCard(position);
  expect(text).toContain('TOKEN/USDG · v4 · NFT 42');
  expect(text).toContain('Current value: $86.00');
  expect(text).toContain('PnL: 2.00% ($2.00)');
  expect(text).toContain('Out of range');
  expect(text).toContain('Bot-managed');
  for(const hidden of [position.poolId,position.liquidityRaw!,'CONFIRMED_ACTIVE_FRESH','BOT_OPERATIONAL','OUT_OF_RANGE',position.openIntentId!])expect(text).not.toContain(hidden);
 });
 it('renders required accounting and market-range fields while preserving unavailable values honestly',()=>{
 const text=persistedPositionDetail({...position,accounting:account});
  for(const label of ['Current value:','Cost basis:','Current principal:','Unclaimed fees:','Collected fees:','Realized proceeds:','Gross PnL:','Gas spent:','Net PnL:','ROI:','Current MC:','LP MC range:','Range status:','Opened:'])expect(text).toContain(label);
  expect(text).toContain('LP MC range: $445K – $890K');
  expect(text).toContain('Range status: Above range');
  expect(text).toContain('Collected fees: Unavailable');
  expect(text).toContain('Net PnL: Unavailable');
  expect(text).not.toMatch(/\$[0]+\.00(?!\d)/);
  for(const hidden of ['Pool:','Owner:','Liquidity:','Ticks:','Accounting:','Source provenance:','Reconciliation:','Price block/time'])expect(text).not.toContain(hidden);
 });
 it('moves raw and provenance fields to a dedicated technical details render',()=>{
  const text=persistedPositionTechnicalDetails({...position,accounting:account});
  for(const value of ['Technical details',position.poolId,'Owner:',position.liquidityRaw!,'Ticks: -100 → -50','Source provenance:','Accounting state:','Funding provenance:','Internal status:'])expect(text).toContain(value);
 });
 it('formats the complete canonical persisted portfolio snapshot',()=>{
  const text=formatPortfolioSnapshot({totalEquityUsd:220,originalCapitalUsd:200,grossPnlUsd:25,netPnlUsd:20,roiPct:10,uncollectedFeesUsd:4,collectedFeesUsd:6,realizedProceedsUsd:30,gasSpentUsd:5,activePositions:2,inRange:1,outOfRange:1,openConfirmingCount:0,pendingReconciliationCount:0,lastReconciliationAt:'2026-07-25T12:05:00.000Z'});
  for(const expected of ['Total equity: $220.00','Original capital: $200.00','Gross PnL: $25.00','Net PnL: $20.00','ROI: 10.00%','Unclaimed fees: $4.00','Collected fees: $6.00','Realized proceeds: $30.00','Gas spent: $5.00','Active positions: 2','In range: 1','Out of range: 1'])expect(text).toContain(expected);
 });
 it('labels managed, external, total, and ambiguous exposure without treating external equity as zero',()=>{
  const text=formatPortfolioSnapshot({totalEquityUsd:220,originalCapitalUsd:200,grossPnlUsd:25,netPnlUsd:20,roiPct:10,uncollectedFeesUsd:4,collectedFeesUsd:6,realizedProceedsUsd:30,gasSpentUsd:5,activePositions:2,inRange:1,outOfRange:1,openConfirmingCount:0,pendingReconciliationCount:0,lastReconciliationAt:'2026-07-25T12:05:00.000Z'},{activeBotManagedEquityUsd:120,externalEquityUsd:100,totalWalletEquityUsd:220,ambiguityReasons:['ACTIVE_POSITION_SOURCE_AMBIGUOUS:v4:9:TRACKED']},150);
  for(const expected of ['Robin-managed equity: $120.00','External equity (informational): $100.00','Total wallet LP equity: $220.00','Robin aggregate cap: $150.00','Ambiguous provenance: 1 position(s)'])expect(text).toContain(expected);
 });
 it('renders the canonical rebalance exposure fields, including only incremental top-up and headroom',()=>{
  const text=formatRebalanceExposurePreview(exposure(),150);
  for(const expected of ['Current Robin-managed equity: $100.00','Unresolved Robin-funded commitments: $5.00','Incremental Robin capital for this action: $10.00','Projected Robin-managed exposure: $115.00','Robin aggregate cap: $150.00','Remaining headroom: $35.00','External wallet equity (informational): $40.00','Total wallet LP equity: $140.00','External positions are excluded'])expect(text).toContain(expected);
  expect(text).not.toContain('Target reopened value: $');
 });
 it('renders fail-closed canonical reasons without zero substitution',()=>{
  expect(formatRebalanceExposurePreview(exposure(),undefined)).toContain('BOT_MANAGED_EXPOSURE_CAP_UNCONFIGURED');
  const ambiguous=formatRebalanceExposurePreview(exposure({reason:'BOT_MANAGED_EXPOSURE_SOURCE_AMBIGUOUS',breakdown:{...exposure().breakdown,ambiguityReasons:['ACTIVE_POSITION_SOURCE_AMBIGUOUS:v4:9:TRACKED']}}),150);
  expect(ambiguous).toContain('Live execution blocked: BOT_MANAGED_EXPOSURE_SOURCE_AMBIGUOUS');
  expect(ambiguous).toContain('Ambiguous/TRACKED position: ACTIVE_POSITION_SOURCE_AMBIGUOUS:v4:9:TRACKED');
  expect(ambiguous).not.toContain('$0.00');
  const stale=formatRebalanceExposurePreview({reason:'BOT_MANAGED_EXPOSURE_DATA_STALE',breakdown:{...exposure().breakdown,activeBotManagedEquityUsd:null,projectedExposureUsd:null}},150);
  expect(stale).toContain('Live execution blocked: BOT_MANAGED_EXPOSURE_DATA_STALE');
  expect(stale).not.toContain('$0.00');
 });
 it('wires the rebalance message to the canonical aggregation result without formatter recomputation or write paths',()=>{
  const source=readFileSync('apps/telegram-lp-bot/src/index.ts','utf8'),start=source.indexOf('async function rebalancePreview'),end=source.indexOf('async function executeRebalanceFromTelegram',start),preview=source.slice(start,end);
  expect(preview).toContain('botManagedProjectedExposure(db');
  expect(preview).toContain('proposedCommitmentId: String(workflow.id)');
  expect(preview).toContain('formatRebalanceExposurePreview(\n        exposure');
  expect(preview).not.toContain('guardedWalletClient');
  expect(preview).not.toContain('executeV4Rebalance');
  expect(preview).not.toContain('transitionRebalance');
 });
 it('removes every recoverable/resume affordance and exposes only normal fresh rebalance entry',()=>{
  const source=readFileSync('apps/telegram-lp-bot/src/index.ts','utf8');
  expect(source).not.toContain('Recoverable rebalances');
  expect(source).not.toContain('Resume Rebalance');
  expect(source).not.toContain('rebalance-resume:');
  expect(source).toContain('Experimental Rebalance V1');
  expect(source).toContain('remains experimental until one complete mainnet rebalance lifecycle is confirmed');
  expect(source).toContain('Rebalance failed. No transaction was sent. Start a new rebalance when ready.');
  expect(source).toContain('label: "Set cost basis"');
  expect(source).not.toContain('label: "Set Original Capital"');
 });
});

describe('transparent USDG-only v4 range pricing',()=>{
 const marketCap:TrustedMarketMetric={kind:'market_cap',valueUsd:890000,observedAtMs:1700000000000,provenance:'trusted cache',constantSupplyBasis:{kind:'circulating',value:1000000000}};
 const fdv:TrustedMarketMetric={kind:'fdv',valueUsd:2000000,observedAtMs:1700000000000,provenance:'trusted cache',constantSupplyBasis:{kind:'total',value:2000000000}};
 const noSupply:TrustedMarketMetric={kind:'market_cap',valueUsd:890000,observedAtMs:1700000000000,provenance:'trusted cache',constantSupplyBasis:null};
 const Q=BigInt(100);void Q;
 it('normalizes token orientation before deriving requested price boundaries',()=>{
  expect(orientedTokenPrice(2,0)).toBe(2);
  expect(orientedTokenPrice(2,1)).toBe(.5);
  const quote=buildV4RangePricing({currentPriceUsd:.00089,range:{upperDropPct:0,lowerDropPct:50},marketMetric:marketCap,quoteBlock:100n,quoteTimestampMs:1_700_000_000_000});
  expect(quote.upperPriceUsd).toBeCloseTo(.00089);
  expect(quote.lowerPriceUsd).toBeCloseTo(.000445);
 });
 it('derives market-cap boundaries proportionally only from a constant trusted supply basis',()=>{
  const quote=buildV4RangePricing({currentPriceUsd:.00089,range:{upperDropPct:0,lowerDropPct:50},marketMetric:marketCap,quoteBlock:100n,quoteTimestampMs:1_700_000_000_000});
  expect(quote.upperMetricUsd).toBeCloseTo(890_000);
  expect(quote.lowerMetricUsd).toBeCloseTo(445_000);
  expect(formatV4RangePricing(quote)).toContain('Estimated market cap range: ~$890k → ~$445k');
 });
 it('labels FDV as FDV and never as market cap',()=>{
  const fdv:TrustedMarketMetric={kind:'fdv',valueUsd:2_000_000,observedAtMs:1_700_000_000_000,provenance:'trusted cache',constantSupplyBasis:{kind:'total',value:2_000_000_000}};
  const text=formatV4RangePricing(buildV4RangePricing({currentPriceUsd:.001,range:{upperDropPct:10,lowerDropPct:50},marketMetric:fdv,quoteBlock:100n,quoteTimestampMs:1_700_000_000_000}));
  expect(text).toContain('Current FDV:');
  expect(text).toContain('Estimated FDV range:');
  expect(text).not.toContain('market cap');
 });
 it('keeps the price range but marks estimated capitalization unavailable without trusted supply',()=>{
  const noSupply:TrustedMarketMetric={kind:'market_cap',valueUsd:890_000,observedAtMs:1_700_000_000_000,provenance:'trusted cache',constantSupplyBasis:null};
  const text=formatV4RangePricing(buildV4RangePricing({currentPriceUsd:.00089,range:{upperDropPct:0,lowerDropPct:50},marketMetric:noSupply,quoteBlock:100n,quoteTimestampMs:1_700_000_000_000}));
  expect(text).toContain('LP price range:');
  expect(text).toContain('Estimated market cap range: Unavailable');
 });
 it('shows selection-to-final drift and states that boundaries were recalculated',()=>{
  const quote=buildV4RangePricing({currentPriceUsd:.00089,range:{upperDropPct:0,lowerDropPct:50},marketMetric:marketCap,quoteBlock:110n,quoteTimestampMs:1_700_000_060_000,selected:{currentPriceUsd:.001,marketMetric:{...marketCap,valueUsd:1_000_000},quoteBlock:100n,quoteTimestampMs:1_700_000_000_000},recalculated:true});
  const text=formatV4RangePricing(quote);
  expect(text).toContain('Market movement since selection: ~$1.00M → ~$890k (-11.0%)');
  expect(text).toContain('Range recalculated from the fresh current price.');
  expect(text).toContain('Quote: 2023-11-14T22:14:20.000Z · block 110');
 });
});
