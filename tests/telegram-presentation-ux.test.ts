import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  formatPortfolioSnapshot,
  persistedPositionDisplayCard,
  persistedPositionDisplayItems,
  persistedPositionCard,
  persistedPositionDetail,
  persistedPositionTechnicalDetails,
  type PersistedPositionView,
} from "../apps/telegram-lp-bot/src/persisted-portfolio.js";
import {
  buildV4RangePricing,
  formatV4RangePricing,
  orientedTokenPrice,
  type TrustedMarketMetric,
} from "../apps/telegram-lp-bot/src/v4-range-ux.js";

const accountCard = {
  externalCapitalUsd: 100,
  activePrincipalUsd: 82,
  uncollectedFeesUsd: 4,
  collectedFeesUsd: 3,
  realizedProceedsUsd: 12,
  gasSpentUsd: 1,
  currentEquityUsd: 86,
  grossPnlUsd: 3,
  grossPnlPct: 3,
  netPnlUsd: 2,
  netPnlPct: 2,
  warnings: [] as string[],
};
const account = {
  externalCapitalUsd: 100,
  activePrincipalUsd: 82,
  uncollectedFeesUsd: 4,
  collectedFeesUsd: null,
  realizedProceedsUsd: 12,
  gasSpentUsd: 1,
  currentEquityUsd: 86,
  grossPnlUsd: 3,
  grossPnlPct: 3,
  netPnlUsd: null,
  netPnlPct: null,
  warnings: [] as string[],
};
const position: PersistedPositionView = {
  protocol: "v4",
  tokenId: "42",
  positionId: "v4:42",
  pair: "TOKEN/USDG",
  poolId: `0x${"a".repeat(64)}`,
  status: "open",
  range: "$0.000445 → $0.000890",
  rangeStatus: "OUT_OF_RANGE",
  currentPriceUsd: 0.00091,
  marketRange: {
    label: "MC",
    currentUsd: 910_000,
    lowerUsd: 445_000,
    upperUsd: 890_000,
    rangeStatus: "ABOVE_RANGE",
    supply: {
      raw: "1000000000000000000",
      normalized: 1_000_000_000,
      kind: "CIRCULATING",
      source: "fixture",
      observedAt: "2026-07-28T00:00:00.000Z",
      decimals: 18,
    },
  },
  source: "BOT_OPERATIONAL",
  accountingStatus: "RECEIPT_ACCOUNTED",
  accounting: accountCard as never,
  openedAt: "2026-07-25T12:00:00.000Z",
  lifecycle: "CONFIRMED_ACTIVE_FRESH",
  terminalReason: null,
  ownerResult: "0x0000000000000000000000000000000000000001",
  liquidityRaw: "12345678901234567890",
  tickLower: -100,
  tickUpper: -50,
  claimable0Raw: "11",
  claimable1Raw: "22",
  lastReconciledAt: "2026-07-25T12:05:00.000Z",
  baselineProvenance: "OPERATIONAL_OPEN_RECEIPT",
  fundingProvenance: "OPERATIONAL_OPEN_SELECTION",
  openIntentId: "internal-workflow-id",
  priceSource: "StateView.sqrtPriceX96",
  priceBlock: "100",
  priceObservedAt: "2026-07-25T12:05:00.000Z",
  reconciliation: "BOT_OPERATIONAL_RECEIPT_LEDGER",
  excludedFromAggregateReason: null,
};

const ladderId = "v4bid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ladderLegs = (ids: string[], lower = 3000) =>
  ids.map((tokenId, legIndex) => ({
    leg_index: legIndex,
    token_id: tokenId,
    status: "OPEN",
    upper_drop_bps: [60, 300, 720, 1320, 2100][legIndex],
    lower_drop_bps: [300, 720, 1320, 2100, lower][legIndex],
  }));
const ladderRepo = (
  ladders: Record<string, { ids: string[]; lower?: number }> = {},
) => ({
  loadBidLadder: (id: string) =>
    ladders[id]
      ? {
          strategy_version: "V4_BID_LADDER_V1",
          execution_mode: "LIVE",
          status: "OPEN",
          total_funding_amount_raw: "500000000",
        }
      : undefined,
  listBidLadderLegs: (id: string) =>
    ladders[id] ? ladderLegs(ladders[id]!.ids, ladders[id]!.lower) : [],
  v4Position: () => ({ funding_decimals: 6, funding_symbol: "USDG" }),
});
const ladderView = (
  tokenId: string,
  id = ladderId,
  equity = 100,
): PersistedPositionView => ({
  ...position,
  tokenId,
  positionId: `v4:${tokenId}`,
  openIntentId: id,
  accounting: {
    ...accountCard,
    currentEquityUsd: equity,
    uncollectedFeesUsd: equity / 100,
  } as never,
});

describe("Telegram position and portfolio presentation", () => {
  it("renders compact cards with readable status/provenance labels and no technical internals", () => {
    const text = persistedPositionCard(position);
    expect(text).toContain("TOKEN/USDG · v4 · NFT 42");
    expect(text).toContain("Current value: $86.00");
    expect(text).toContain("PnL: 2.00% ($2.00)");
    expect(text).toContain("Out of range");
    expect(text).toContain("Bot-managed");
    for (const hidden of [
      position.poolId,
      position.liquidityRaw!,
      "CONFIRMED_ACTIVE_FRESH",
      "BOT_OPERATIONAL",
      "OUT_OF_RANGE",
      position.openIntentId!,
    ])
      expect(text).not.toContain(hidden);
  });
  it("groups only complete proven BID ladder legs into one logical card with aggregate accounting", () => {
    const ids = ["720184", "720185", "720186", "720187", "720188"],
      views = ids.map((id, index) =>
        ladderView(id, ladderId, [40, 60, 90, 125, 185][index]!),
      ),
      items = persistedPositionDisplayItems(
        ladderRepo({ [ladderId]: { ids, lower: 3000 } }) as never,
        views,
      );
    expect(views).toHaveLength(5); // canonical persisted positions remain five.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "bid_ladder",
      ladderId,
      tokenIds: ids,
      equityUsd: 500,
      upperDropBps: 60,
      lowerDropBps: 3000,
    });
    const card = persistedPositionDisplayCard(items[0]!);
    for (const text of [
      "V4 BID Ladder V1",
      "Capital: 500 USDG",
      "Legs: 5",
      "NFTs: 720184–720188",
      "Range: -0.6% → -30%",
      "Mode: LIVE",
    ])
      expect(card).toContain(text);
  });
  it("groups five OPEN_CONFIRMING ladder legs as one active refreshing managed position", () => {
    const ids = ["720184", "720185", "720186", "720187", "720188"],
      views = ids.map((id) => ({
        ...ladderView(id, ladderId),
        lifecycle: "OPEN_CONFIRMING" as const,
        accounting: { ...ladderView(id, ladderId).accounting, currentEquityUsd: null, uncollectedFeesUsd: null },
      })),
      items = persistedPositionDisplayItems(
        ladderRepo({ [ladderId]: { ids, lower: 3000 } }) as never,
        views,
      );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({kind:"bid_ladder",ladderId,lifecycle:"OPEN_CONFIRMING",tokenIds:ids,equityUsd:null,unclaimedFeesUsd:null});
    expect(persistedPositionDisplayCard(items[0]!)).toContain("Status: OPEN / REFRESHING");
    expect(persistedPositionDisplayCard(items[0]!)).toContain("Equity: Refreshing...");
  });
  it("keeps unrelated positions separate and supports one logical item per distinct ladder", () => {
    const second = "v4bid_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      firstIds = ["1", "2", "3", "4", "5"],
      secondIds = ["6", "7", "8", "9", "10"],
      standalone = {
        ...ladderView("99", "normal-open"),
        source: "BOT_OPERATIONAL" as const,
      },
      items = persistedPositionDisplayItems(
        ladderRepo({
          [ladderId]: { ids: firstIds },
          [second]: { ids: secondIds },
        }) as never,
        [
          ...firstIds.map((id) => ladderView(id)),
          ...secondIds.map((id) => ladderView(id, second)),
          standalone,
        ],
      );
    expect(items.filter((item) => item.kind === "bid_ladder")).toHaveLength(2);
    expect(items.filter((item) => item.kind === "position")).toHaveLength(1);
    expect(items).toHaveLength(3); // pagination receives logical items after grouping.
  });
  it("fails conservatively when ladder provenance is incomplete or ambiguous", () => {
    const ids = ["1", "2", "3", "4", "5"],
      complete = ids.map((id) => ladderView(id)),
      missing = complete.slice(0, 4),
      wrongIntent = complete.map((view, index) =>
        index === 4 ? { ...view, openIntentId: "other" } : view,
      );
    expect(
      persistedPositionDisplayItems(
        ladderRepo({ [ladderId]: { ids } }) as never,
        missing,
      ),
    ).toHaveLength(4);
    expect(
      persistedPositionDisplayItems(
        ladderRepo({ [ladderId]: { ids } }) as never,
        wrongIntent,
      ),
    ).toHaveLength(5);
  });
  it("renders required accounting and market-range fields while preserving unavailable values honestly", () => {
    const text = persistedPositionDetail({ ...position, accounting: account });
    for (const label of [
      "Current value:",
      "Cost basis:",
      "Current principal:",
      "Unclaimed fees:",
      "Collected fees:",
      "Realized proceeds:",
      "Gross PnL:",
      "Gas spent:",
      "Net PnL:",
      "ROI:",
      "Current MC:",
      "LP MC range:",
      "Range status:",
      "Opened:",
    ])
      expect(text).toContain(label);
    expect(text).toContain("LP MC range: $445K – $890K");
    expect(text).toContain("Range status: Above range");
    expect(text).toContain("Collected fees: Unavailable");
    expect(text).toContain("Net PnL: Unavailable");
    expect(text).not.toMatch(/\$[0]+\.00(?!\d)/);
    for (const hidden of [
      "Pool:",
      "Owner:",
      "Liquidity:",
      "Ticks:",
      "Accounting:",
      "Source provenance:",
      "Reconciliation:",
      "Price block/time",
    ])
      expect(text).not.toContain(hidden);
  });
  it("moves raw and provenance fields to a dedicated technical details render", () => {
    const text = persistedPositionTechnicalDetails({
      ...position,
      accounting: account,
    });
    for (const value of [
      "Technical details",
      position.poolId,
      "Owner:",
      position.liquidityRaw!,
      "Ticks: -100 → -50",
      "Source provenance:",
      "Accounting state:",
      "Funding provenance:",
      "Internal status:",
    ])
      expect(text).toContain(value);
  });
  it("formats the complete canonical persisted portfolio snapshot", () => {
    const text = formatPortfolioSnapshot({
      totalEquityUsd: 220,
      originalCapitalUsd: 200,
      grossPnlUsd: 25,
      netPnlUsd: 20,
      roiPct: 10,
      uncollectedFeesUsd: 4,
      collectedFeesUsd: 6,
      realizedProceedsUsd: 30,
      gasSpentUsd: 5,
      activePositions: 2,
      inRange: 1,
      outOfRange: 1,
      openConfirmingCount: 0,
      pendingReconciliationCount: 0,
      lastReconciliationAt: "2026-07-25T12:05:00.000Z",
    });
    for (const expected of [
      "Total equity: $220.00",
      "Original capital: $200.00",
      "Gross PnL: $25.00",
      "Net PnL: $20.00",
      "ROI: 10.00%",
      "Unclaimed fees: $4.00",
      "Collected fees: $6.00",
      "Realized proceeds: $30.00",
      "Gas spent: $5.00",
      "Active positions: 2",
      "In range: 1",
      "Out of range: 1",
    ])
      expect(text).toContain(expected);
  });
  it("labels managed, external, total, and ambiguous exposure without treating external equity as zero", () => {
    const text = formatPortfolioSnapshot(
      {
        totalEquityUsd: 220,
        originalCapitalUsd: 200,
        grossPnlUsd: 25,
        netPnlUsd: 20,
        roiPct: 10,
        uncollectedFeesUsd: 4,
        collectedFeesUsd: 6,
        realizedProceedsUsd: 30,
        gasSpentUsd: 5,
        activePositions: 2,
        inRange: 1,
        outOfRange: 1,
        openConfirmingCount: 0,
        pendingReconciliationCount: 0,
        lastReconciliationAt: "2026-07-25T12:05:00.000Z",
      },
      {
        activeBotManagedEquityUsd: 120,
        externalEquityUsd: 100,
        totalWalletEquityUsd: 220,
        ambiguityReasons: ["ACTIVE_POSITION_SOURCE_AMBIGUOUS:v4:9:TRACKED"],
      },
    );
    for (const expected of [
      "FUNI-tracked equity: $120.00",
      "External equity (informational): $100.00",
      "Total wallet LP equity: $220.00",
      "Ambiguous provenance: 1 position(s)",
    ])
      expect(text).toContain(expected);
  });
});

describe("transparent USDG-only v4 range pricing", () => {
  const marketCap: TrustedMarketMetric = {
    kind: "market_cap",
    valueUsd: 890000,
    observedAtMs: 1700000000000,
    provenance: "trusted cache",
    constantSupplyBasis: { kind: "circulating", value: 1000000000 },
  };
  const fdv: TrustedMarketMetric = {
    kind: "fdv",
    valueUsd: 2000000,
    observedAtMs: 1700000000000,
    provenance: "trusted cache",
    constantSupplyBasis: { kind: "total", value: 2000000000 },
  };
  const noSupply: TrustedMarketMetric = {
    kind: "market_cap",
    valueUsd: 890000,
    observedAtMs: 1700000000000,
    provenance: "trusted cache",
    constantSupplyBasis: null,
  };
  const Q = BigInt(100);
  void Q;
  it("normalizes token orientation before deriving requested price boundaries", () => {
    expect(orientedTokenPrice(2, 0)).toBe(2);
    expect(orientedTokenPrice(2, 1)).toBe(0.5);
    const quote = buildV4RangePricing({
      currentPriceUsd: 0.00089,
      range: { upperDropPct: 0, lowerDropPct: 50 },
      marketMetric: marketCap,
      quoteBlock: 100n,
      quoteTimestampMs: 1_700_000_000_000,
    });
    expect(quote.upperPriceUsd).toBeCloseTo(0.00089);
    expect(quote.lowerPriceUsd).toBeCloseTo(0.000445);
  });
  it("derives market-cap boundaries proportionally only from a constant trusted supply basis", () => {
    const quote = buildV4RangePricing({
      currentPriceUsd: 0.00089,
      range: { upperDropPct: 0, lowerDropPct: 50 },
      marketMetric: marketCap,
      quoteBlock: 100n,
      quoteTimestampMs: 1_700_000_000_000,
    });
    expect(quote.upperMetricUsd).toBeCloseTo(890_000);
    expect(quote.lowerMetricUsd).toBeCloseTo(445_000);
    expect(formatV4RangePricing(quote)).toContain(
      "Estimated market cap range: ~$890k → ~$445k",
    );
  });
  it("labels FDV as FDV and never as market cap", () => {
    const fdv: TrustedMarketMetric = {
      kind: "fdv",
      valueUsd: 2_000_000,
      observedAtMs: 1_700_000_000_000,
      provenance: "trusted cache",
      constantSupplyBasis: { kind: "total", value: 2_000_000_000 },
    };
    const text = formatV4RangePricing(
      buildV4RangePricing({
        currentPriceUsd: 0.001,
        range: { upperDropPct: 10, lowerDropPct: 50 },
        marketMetric: fdv,
        quoteBlock: 100n,
        quoteTimestampMs: 1_700_000_000_000,
      }),
    );
    expect(text).toContain("Current FDV:");
    expect(text).toContain("Estimated FDV range:");
    expect(text).not.toContain("market cap");
  });
  it("keeps the price range but marks estimated capitalization unavailable without trusted supply", () => {
    const noSupply: TrustedMarketMetric = {
      kind: "market_cap",
      valueUsd: 890_000,
      observedAtMs: 1_700_000_000_000,
      provenance: "trusted cache",
      constantSupplyBasis: null,
    };
    const text = formatV4RangePricing(
      buildV4RangePricing({
        currentPriceUsd: 0.00089,
        range: { upperDropPct: 0, lowerDropPct: 50 },
        marketMetric: noSupply,
        quoteBlock: 100n,
        quoteTimestampMs: 1_700_000_000_000,
      }),
    );
    expect(text).toContain("LP price range:");
    expect(text).toContain("Estimated market cap range: Unavailable");
  });
  it("shows selection-to-final drift and states that boundaries were recalculated", () => {
    const quote = buildV4RangePricing({
      currentPriceUsd: 0.00089,
      range: { upperDropPct: 0, lowerDropPct: 50 },
      marketMetric: marketCap,
      quoteBlock: 110n,
      quoteTimestampMs: 1_700_000_060_000,
      selected: {
        currentPriceUsd: 0.001,
        marketMetric: { ...marketCap, valueUsd: 1_000_000 },
        quoteBlock: 100n,
        quoteTimestampMs: 1_700_000_000_000,
      },
      recalculated: true,
    });
    const text = formatV4RangePricing(quote);
    expect(text).toContain(
      "Market movement since selection: ~$1.00M → ~$890k (-11.0%)",
    );
    expect(text).toContain("Range recalculated from the fresh current price.");
    expect(text).toContain("Quote: 2023-11-14T22:14:20.000Z · block 110");
  });
});
