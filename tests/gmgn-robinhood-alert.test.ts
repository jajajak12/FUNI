import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateSqlite, SqliteLedgerRepository } from '@robin/ledger';
import {
  DEFAULT_RE_ALERT_INTERVAL_MS,
  GMGN_FEE_SEMANTIC_STATUS,
  RE_ALERT_MATERIAL_CHANGE,
  admitGmgn,
  decideRealert,
  extractTrendingRank,
  formatGmgnAlert,
  gmgnAlertButtons,
  gmgnOpenLpCallback,
  isMaterialChange,
  loadNaturalDedupe,
  naturalAlertKey,
  normalizeGmgnObservation,
  normalizeTrendingObservation,
  recordNaturalAlert,
  resolveCurrentMarketCapUsd,
} from '../apps/workers/src/gmgn-robinhood-alert.js';

const fixture = (): { dir: string; repo: SqliteLedgerRepository; close: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-gmgn-test-'));
  const dbPath = join(dir, 'test.sqlite');
  const rawDb = new Database(dbPath);
  rawDb.pragma('journal_mode = WAL');
  rawDb.close();
  migrateSqlite(dbPath, 'infra/migrations');
  const repo = new SqliteLedgerRepository(dbPath);
  return { dir, repo, close: () => { repo.close(); rmSync(dir, { recursive: true, force: true }); } };
};

const baseInfo = {
  address: '0x56910d4409f3a0c78c64dd8d0545ff0705389870',
  symbol: 'Index',
  name: 'The Index',
  holder_count: 800,
  liquidity: 40000,
  total_fee: 74.78660649643254,
  trade_fee: 69.5396664918084,
  creation_timestamp: 1_700_000_000,
  price: { volume_1h: 600000 },
  stat: { top_10_holder_rate: 70, dev_team_hold_rate: 1 },
  // Trending-shaped fields the normalizer reads for current market cap.
  market_cap: 600000,
  usd_market_cap: 600000,
  history_highest_market_cap: 1_200_000,
};

const baseRank = {
  address: '0x56910d4409f3a0c78c64dd8d0545ff0705389870',
  symbol: 'Index',
  name: 'The Index',
  market_cap: 600000,
  liquidity: 40000,
  volume: 600000,
  holder_count: 800,
  gas_fee: 74.78660649643254,
  launchpad_platform: 'uniswap',
};

describe('GMGN Robinhood admission', () => {
  it('uses the empirically verified Index total_fee directly and passes the fee gate', () => {
    const item = normalizeGmgnObservation(baseInfo, 1_700_001_000_000);
    expect(item.totalFeeEth).toBeCloseTo(74.78660649643254);
    expect(item.tradeFeeRaw).toBe('69.5396664918084');
    expect(item.priorityFeeRaw).toBeUndefined();
    expect(item.feeSemanticStatus).toBe(GMGN_FEE_SEMANTIC_STATUS);
    expect(item.admission.status).toBe('PASS');
  });

  it.each([[0.999999, 'REJECT'], [1, 'PASS'], [1.000001, 'PASS']] as const)(
    'applies exact total_fee boundary %s',
    (fee, status) =>
      expect(admitGmgn({
        marketCapUsd: 500000,
        liquidityUsd: 30000,
        volume1hUsd: 500000,
        holderCount: 700,
        totalFeeEth: fee,
        name: 'ok',
        launchPlatform: 'uniswap',
      }).status).toBe(status),
  );

  it('fails closed for missing total_fee and does not reconstruct it from raw fee fields', () => {
    const item = normalizeGmgnObservation({ ...baseInfo, total_fee: undefined, trade_fee: 999, priority_fee: 999 }, 1_700_001_000_000);
    expect(item.admission.status).toBe('REJECT');
    expect(item.admission.reasons).toContain('MISSING_OR_INVALID_totalFeeEth');
  });

  it('keeps risk context non-blocking but excludes the two approved launch/name cases', () => {
    expect(admitGmgn({
      marketCapUsd: 500000,
      liquidityUsd: 30000,
      volume1hUsd: 500000,
      holderCount: 700,
      totalFeeEth: 1,
      name: 'ok',
      launchPlatform: 'flap.fun',
    }).reasons).toContain('EXCLUDED_FLAP_FUN');
    expect(admitGmgn({
      marketCapUsd: 500000,
      liquidityUsd: 30000,
      volume1hUsd: 500000,
      holderCount: 700,
      totalFeeEth: 1,
      name: 'Flap Stocks',
      launchPlatform: 'uniswap',
    }).reasons).toContain('EXCLUDED_FLAP_STOCKS');
  });

  it('formats a manual-only Open LP callback', () => {
    const item = normalizeGmgnObservation(baseInfo, 1_700_001_000_000);
    expect(gmgnOpenLpCallback(item.tokenAddress).toLowerCase()).toBe(`gmgn-open-lp:${baseInfo.address}`);
    expect(formatGmgnAlert(item, [{ version: 'v4', id: 'p' }])).toContain('GMGN Total Fees: 74.79 ETH');
  });
  it('shows Open LP only for private alerts with a verified eligible pool',()=>{
    const token=baseInfo.address as `0x${string}`;
    expect(gmgnAlertButtons('private',token,0).flat().map(x=>x.text)).toEqual(['View GMGN']);
    expect(gmgnAlertButtons('private',token,1).flat().map(x=>x.text)).toEqual(['View GMGN','Open LP']);
    expect(gmgnAlertButtons('group',token,5).flat().map(x=>x.text)).toEqual(['View GMGN']);
  });
});

describe('GMGN Robinhood current market-cap provenance', () => {
  it('uses the trending market_cap field as the primary provenance', () => {
    const r = resolveCurrentMarketCapUsd({ market_cap: 600_000, price: 0.1, total_supply: 1_000_000 });
    expect(r.value).toBe(600_000);
    expect(r.provenance).toBe('trending_market_cap');
  });

  it('derives market cap from price * total_supply when the spot field is missing or zero', () => {
    const r = resolveCurrentMarketCapUsd({ market_cap: 0, price: 0.1, total_supply: 1_000_000 });
    expect(r.value).toBeCloseTo(100_000);
    expect(r.provenance).toBe('price_x_supply');
  });

  it('prefers circulating_supply over total_supply for the price-derived path', () => {
    const r = resolveCurrentMarketCapUsd({ market_cap: 0, price: 0.1, circulating_supply: 500_000, total_supply: 1_000_000 });
    expect(r.value).toBeCloseTo(50_000);
    expect(r.provenance).toBe('price_x_supply');
  });

  it('fails closed (provenance=missing) when neither spot nor a derivable price*supply is available', () => {
    const r = resolveCurrentMarketCapUsd({ market_cap: 0 });
    expect(r.value).toBeUndefined();
    expect(r.provenance).toBe('missing');
  });

  it('NEVER uses history_highest_market_cap / ath_mc to satisfy the spot market-cap gate', () => {
    const r = resolveCurrentMarketCapUsd({ market_cap: 0, history_highest_market_cap: 1_000_000 });
    expect(r.value).toBeUndefined();
    expect(r.provenance).toBe('missing');
    expect(r.historicalHighestMarketCapUsd).toBe(1_000_000);
  });

  it('rejects admission when only ath_mc / history_highest_market_cap is present in the trending row', () => {
    const item = normalizeTrendingObservation({
      ...baseRank,
      market_cap: 0,
      history_highest_market_cap: 1_000_000,
    });
    expect(item.marketCapUsd).toBeUndefined();
    expect(item.marketCapProvenance).toBe('missing');
    expect(item.admission.status).toBe('REJECT');
    expect(item.admission.reasons).toContain('MISSING_OR_INVALID_marketCapUsd');
  });
});

describe('GMGN Robinhood extractTrendingRank', () => {
  it('returns the rank array from a well-formed envelope', () => {
    const rank = extractTrendingRank({ code: 0, data: { rank: [baseRank, { ...baseRank, address: '0x1234567890123456789012345678901234567890' }] } });
    expect(rank).toHaveLength(2);
  });
  it('returns [] on malformed envelope', () => {
    expect(extractTrendingRank({ not: 'an envelope' })).toEqual([]);
    expect(extractTrendingRank(null)).toEqual([]);
    expect(extractTrendingRank('not-json')).toEqual([]);
  });
});

describe('GMGN Robinhood natural dedup', () => {
  let dir = '';
  let repo: SqliteLedgerRepository | null = null;
  let close = (): void => {};

  beforeEach(() => {
    const f = fixture();
    dir = f.dir;
    repo = f.repo;
    close = f.close;
  });
  afterEach(() => { close(); });

  it('re-alerts ONCE for a never-seen PASS (initial alert)', () => {
    const item = normalizeTrendingObservation(baseRank, 1_700_001_000_000);
    expect(item.admission.status).toBe('PASS');
    const decision = decideRealert({
      now: 1_700_001_000_000,
      previous: undefined,
      candidate: { marketCapUsd: item.marketCapUsd, liquidityUsd: item.liquidityUsd, volume1hUsd: item.volume1hUsd, totalFeeEth: item.totalFeeEth },
      reAlertIntervalMs: DEFAULT_RE_ALERT_INTERVAL_MS,
    });
    expect(decision.eligible).toBe(true);
    expect(decision.reasons).toContain('INITIAL_ALERT');
  });

  it('repeated identical GME PASS cycles produce one alert (snapshot-hash churn does not generate new identities)', () => {
    const token = '0xc2362aff2a2a4cc1f48cf3dab2c4e2605eb94ba3' as `0x${string}`;
    const itemA = normalizeTrendingObservation({ ...baseRank, address: token }, 1_700_000_000_000);
    recordNaturalAlert(repo!, token, itemA, 1_700_000_000_000);
    const stored = loadNaturalDedupe(repo!, token)!;
    expect(stored).toBeDefined();
    expect(stored.natural_key).toBe(naturalAlertKey(token));

    // Cycle N+1: identical metrics (same snapshot) but worker process restarted
    // 30 seconds later.  The natural key remains the same → re-alert is
    // suppressed by cooldown.
    const itemB = normalizeTrendingObservation({ ...baseRank, address: token }, 1_700_000_030_000);
    const decision = decideRealert({
      now: 1_700_000_030_000,
      previous: stored,
      candidate: { marketCapUsd: itemB.marketCapUsd, liquidityUsd: itemB.liquidityUsd, volume1hUsd: itemB.volume1hUsd, totalFeeEth: itemB.totalFeeEth },
      reAlertIntervalMs: DEFAULT_RE_ALERT_INTERVAL_MS,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.cooldownRemainingMs).toBeGreaterThan(0);
  });

  it('timestamp-only changes produce no re-alert (no material metric change)', () => {
    const token = '0xc2362aff2a2a4cc1f48cf3dab2c4e2605eb94ba3' as `0x${string}`;
    const itemA = normalizeTrendingObservation({ ...baseRank, address: token }, 1_700_000_000_000);
    recordNaturalAlert(repo!, token, itemA, 1_700_000_000_000);
    const stored = loadNaturalDedupe(repo!, token)!;

    // 31 minutes later (past default cooldown of 30 min) but with IDENTICAL metrics.
    const later = 1_700_000_000_000 + DEFAULT_RE_ALERT_INTERVAL_MS + 60_000;
    const decision = decideRealert({
      now: later,
      previous: stored,
      candidate: { marketCapUsd: itemA.marketCapUsd, liquidityUsd: itemA.liquidityUsd, volume1hUsd: itemA.volume1hUsd, totalFeeEth: itemA.totalFeeEth },
      reAlertIntervalMs: DEFAULT_RE_ALERT_INTERVAL_MS,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reasons.join(' ')).toContain('NO_MATERIAL_METRIC_CHANGE');
  });

  it('material change after the re-alert interval produces one new alert', () => {
    const token = '0xc2362aff2a2a4cc1f48cf3dab2c4e2605eb94ba3' as `0x${string}`;
    const itemA = normalizeTrendingObservation({ ...baseRank, address: token }, 1_700_000_000_000);
    recordNaturalAlert(repo!, token, itemA, 1_700_000_000_000);
    const stored = loadNaturalDedupe(repo!, token)!;

    // Market cap doubles — well above the 20% threshold.
    const itemB = normalizeTrendingObservation({ ...baseRank, address: token, market_cap: 1_500_000 }, 1_700_000_000_000);
    const later = 1_700_000_000_000 + DEFAULT_RE_ALERT_INTERVAL_MS + 60_000;
    const decision = decideRealert({
      now: later,
      previous: stored,
      candidate: { marketCapUsd: itemB.marketCapUsd, liquidityUsd: itemB.liquidityUsd, volume1hUsd: itemB.volume1hUsd, totalFeeEth: itemB.totalFeeEth },
      reAlertIntervalMs: DEFAULT_RE_ALERT_INTERVAL_MS,
    });
    expect(decision.eligible).toBe(true);
    expect(decision.materialChange).toBe(true);
  });

  it('worker restart preserves dedup (table-backed, deterministic key)', () => {
    const token = '0xc2362aff2a2a4cc1f48cf3dab2c4e2605eb94ba3' as `0x${string}`;
    const itemA = normalizeTrendingObservation({ ...baseRank, address: token }, 1_700_000_000_000);
    recordNaturalAlert(repo!, token, itemA, 1_700_000_000_000);
    const before = loadNaturalDedupe(repo!, token)!;

    // Simulate restart by closing the repo and reopening it.
    repo!.close();
    const reopened = new SqliteLedgerRepository(join(dir, 'test.sqlite'));
    const after = loadNaturalDedupe(reopened, token)!;
    expect(after).toBeDefined();
    expect(after.natural_key).toBe(before.natural_key);
    expect(after.last_alerted_at_ms).toBe(before.last_alerted_at_ms);
    reopened.close();
    // Reopen for afterEach cleanup to succeed.
    repo = new SqliteLedgerRepository(join(dir, 'test.sqlite'));
  });

  it('rejected → admitted transition alerts once (no prior PASS exists)', () => {
    const token = '0xc2362aff2a2a4cc1f48cf3dab2c4e2605eb94ba3' as `0x${string}`;
    // No prior dedup row → initial alert.
    const item = normalizeTrendingObservation({ ...baseRank, address: token }, 1_700_000_000_000);
    const decision = decideRealert({
      now: 1_700_000_000_000,
      previous: undefined,
      candidate: { marketCapUsd: item.marketCapUsd, liquidityUsd: item.liquidityUsd, volume1hUsd: item.volume1hUsd, totalFeeEth: item.totalFeeEth },
      reAlertIntervalMs: DEFAULT_RE_ALERT_INTERVAL_MS,
    });
    expect(decision.eligible).toBe(true);
    expect(decision.reasons).toContain('INITIAL_ALERT');
  });

  it('isMaterialChange returns false for holder_count-only changes (no metric moved past threshold)', () => {
    const prev = {
      token_address: '0xabc',
      natural_key: 'k',
      last_alerted_at_ms: 0,
      last_alerted_market_cap_usd: 1_000_000,
      last_alerted_liquidity_usd: 50_000,
      last_alerted_volume_1h_usd: 600_000,
      last_alerted_total_fee_eth: 1.5,
      last_alerted_holder_count: 800,
    };
    expect(isMaterialChange(prev, {
      marketCapUsd: 1_000_000,
      liquidityUsd: 50_000,
      volume1hUsd: 600_000,
      totalFeeEth: 1.5,
    })).toBe(false);
  });

  it('isMaterialChange returns true on a 25% fee change (>= fee threshold of 0.25)', () => {
    const prev = {
      token_address: '0xabc',
      natural_key: 'k',
      last_alerted_at_ms: 0,
      last_alerted_market_cap_usd: 1_000_000,
      last_alerted_liquidity_usd: 50_000,
      last_alerted_volume_1h_usd: 600_000,
      last_alerted_total_fee_eth: 1.0,
      last_alerted_holder_count: 800,
    };
    expect(isMaterialChange(prev, {
      marketCapUsd: 1_000_000,
      liquidityUsd: 50_000,
      volume1hUsd: 600_000,
      totalFeeEth: 1.25,
    })).toBe(true);
  });

  it('isMaterialChange returns true on 30% volume change (>= volume threshold of 0.30)', () => {
    const prev = {
      token_address: '0xabc',
      natural_key: 'k',
      last_alerted_at_ms: 0,
      last_alerted_market_cap_usd: 1_000_000,
      last_alerted_liquidity_usd: 50_000,
      last_alerted_volume_1h_usd: 500_000,
      last_alerted_total_fee_eth: 1.5,
      last_alerted_holder_count: 800,
    };
    expect(isMaterialChange(prev, {
      marketCapUsd: 1_000_000,
      liquidityUsd: 50_000,
      volume1hUsd: 650_000,
      totalFeeEth: 1.5,
    })).toBe(true);
  });

  it('publishes the canonical material-change thresholds', () => {
    expect(RE_ALERT_MATERIAL_CHANGE).toEqual({ marketCapUsd: 0.20, liquidityUsd: 0.20, volume1hUsd: 0.30, totalFeeEth: 0.25 });
  });
});
