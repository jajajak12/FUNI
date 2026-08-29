import { describe, expect, it } from "vitest";
import {
  fetchDexScreenerV4Liquidity,
  canonicalTelegramV4RankingScore,
  formatDexScreenerV4Liquidity,
  rankTelegramV4ByDexLiquidity,
  type DexScreenerFetch,
} from "../apps/telegram-lp-bot/src/dexscreener-v4-liquidity.js";

const poolId = `0x${"a".repeat(64)}`;
const currency0 = "0x0000000000000000000000000000000000000001";
const currency1 = "0x0000000000000000000000000000000000000002";
const pair = (overrides: Record<string, unknown> = {}) => ({
  chainId: "robinhood", dexId: "uniswap", labels: ["v4"], pairAddress: poolId,
  baseToken: { address: currency1 }, quoteToken: { address: currency0 }, liquidity: { usd: 42_554.9 }, ...overrides,
});
const response = (body: unknown, ok = true): DexScreenerFetch => async () => ({ ok, json: async () => body });
const read = (fetcher: DexScreenerFetch) => fetchDexScreenerV4Liquidity({ poolId, currency0, currency1, fetcher });

describe("Telegram DexScreener exact V4 liquidity", () => {
  it("accepts only a valid exact Robinhood Uniswap V4 pool", async () => {
    await expect(read(response({ pairs: [pair()] }))).resolves.toEqual({ status: "KNOWN", valueUsd: 42_554.9 });
  });
  it.each([
    ["PoolId mismatch", pair({ pairAddress: `0x${"b".repeat(64)}` }), "POOL_ID_MISMATCH"],
    ["token mismatch", pair({ baseToken: { address: currency0 }, quoteToken: { address: "0x0000000000000000000000000000000000000003" } }), "TOKEN_MISMATCH"],
    ["dex mismatch", pair({ dexId: "other" }), "WRONG_DEX_OR_CHAIN"],
    ["missing V4 label", pair({ labels: [] }), "NOT_V4"],
    ["missing liquidity", pair({ liquidity: {} }), "INVALID_LIQUIDITY"],
  ])("returns unavailable for %s", async (_name, invalid, reason) => {
    await expect(read(response({ pairs: [invalid] }))).resolves.toEqual({ status: "UNAVAILABLE", reason });
  });
  it("preserves an exact known zero", async () => {
    await expect(read(response({ pairs: [pair({ liquidity: { usd: 0 } })] }))).resolves.toEqual({ status: "KNOWN_ZERO", valueUsd: 0 });
    expect(formatDexScreenerV4Liquidity({ status: "KNOWN_ZERO", valueUsd: 0 })).toBe("Pool liquidity: $0");
  });
  it("formats compact USD without collapsing small positive liquidity to zero", () => {
    expect([16.56, 509.58, 842, 1_250, 30_400, 42_554.9, 438_000, 2_310_000, 1_420_000_000].map(value => formatDexScreenerV4Liquidity({ status: "KNOWN", valueUsd: value }))).toEqual([
      "Pool liquidity: $16.56", "Pool liquidity: $509.58", "Pool liquidity: $842", "Pool liquidity: $1.25K", "Pool liquidity: $30.4K", "Pool liquidity: $42.55K", "Pool liquidity: $438K", "Pool liquidity: $2.31M", "Pool liquidity: $1.42B",
    ]);
    expect(formatDexScreenerV4Liquidity({ status: "UNAVAILABLE", reason: "failure" })).toBe("Pool liquidity: Unavailable");
  });
  it("returns unavailable for HTTP failure, empty pairs, malformed JSON, and timeout", async () => {
    await expect(read(response({}, false))).resolves.toEqual({ status: "UNAVAILABLE", reason: "HTTP_FAILURE" });
    await expect(read(response({ pairs: [] }))).resolves.toEqual({ status: "UNAVAILABLE", reason: "POOL_ID_MISMATCH" });
    await expect(read(async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }))).resolves.toEqual({ status: "UNAVAILABLE", reason: "MALFORMED_JSON" });
    await expect(read(async () => { throw Object.assign(new Error("timeout"), { name: "AbortError" }); })).resolves.toEqual({ status: "UNAVAILABLE", reason: "TIMEOUT" });
  });
  it("ranks known values in an existing V4 eligibility class and keeps unknown visible", () => {
    const candidate = (id: string, executionEligible = true) => ({ id, executionEligible });
    const ranked = rankTelegramV4ByDexLiquidity([
      { candidate: candidate("D"), liquidity: { status: "UNAVAILABLE" as const, reason: "failure" } },
      { candidate: candidate("C"), liquidity: { status: "KNOWN" as const, valueUsd: 509.58 } },
      { candidate: candidate("B"), liquidity: { status: "KNOWN" as const, valueUsd: 42_554.9 } },
      { candidate: candidate("A"), liquidity: { status: "KNOWN" as const, valueUsd: 500_000 } },
      { candidate: candidate("unsupported", false), liquidity: { status: "KNOWN" as const, valueUsd: 2_000_000 } },
    ]);
    expect(ranked.map(value => value.candidate.id)).toEqual(["A", "B", "C", "D", "unsupported"]);
    expect(ranked).toHaveLength(5);
  });
  it('scores every canonical ranking input and does not let fee alone beat unusable liquidity',()=>{const healthy={executionEligible:true,liquidity:1_000_000n,cacheAgeMs:1_000,feeSemantics:{staticFeePips:30_000}},highFee={executionEligible:true,liquidity:1n,cacheAgeMs:110_000,feeSemantics:{staticFeePips:50_000}},healthyEvidence={status:'KNOWN' as const,valueUsd:100_000,volume24hUsd:250_000,priceChange24hPct:2},weakEvidence={status:'KNOWN' as const,valueUsd:10,volume24hUsd:0,priceChange24hPct:80};const score=canonicalTelegramV4RankingScore(healthy,healthyEvidence);expect(Object.keys(score.inputs).sort()).toEqual(['activeLiquidity','feeOpportunity','freshness','priceSafety','rangeUtilization','realVolume','usableLiquidity']);expect(score.score).toBeGreaterThan(canonicalTelegramV4RankingScore(highFee,weakEvidence).score);const ranked=rankTelegramV4ByDexLiquidity([{candidate:{...highFee,id:'5%'},liquidity:weakEvidence},{candidate:{...healthy,id:'3%'},liquidity:healthyEvidence}]);expect(ranked.map(item=>item.candidate.id)).toEqual(['3%','5%']);expect(ranked).toHaveLength(2);});
});
