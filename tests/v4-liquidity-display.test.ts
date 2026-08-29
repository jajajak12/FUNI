import { describe, expect, it } from "vitest";
import {
  formatCompactUsd,
  formatV4PoolUsdMetric,
  trustedV4PoolUsdMetric,
} from "../apps/cli/src/v4-liquidity-display.js";

describe("V4 pool USD liquidity display", () => {
  const now = 1_700_000_000_000;
  const freshTvl = { tvl_usd: 30_400, tvl_source: "uniswap-graphql:example:v4", tvl_observed_at_ms: now - 1_000, tvl_fresh_until_ms: now + 1_000, tvl_status: "fresh" };

  it("uses fresh trusted pool TVL when no canonical pool liquidity_usd exists", () => {
    expect(trustedV4PoolUsdMetric(freshTvl, now)).toEqual({ label: "Pool TVL", usd: 30_400, formatted: "$30.4K" });
    expect(formatV4PoolUsdMetric(freshTvl, now)).toBe("Pool TVL: $30.4K");
  });

  it("renders unavailable for missing or stale metrics without a raw-L conversion", () => {
    expect(formatV4PoolUsdMetric(undefined, now)).toBe("Pool TVL: Unavailable");
    expect(formatV4PoolUsdMetric({ ...freshTvl, tvl_fresh_until_ms: now - 1 }, now)).toBe("Pool TVL: Unavailable");
  });

  it("formats compact USD deterministically without scientific notation", () => {
    expect([0, 842, 1_250, 30_400, 438_000, 2_310_000, 1_420_000_000].map(formatCompactUsd)).toEqual(["$0", "$842", "$1.25K", "$30.4K", "$438K", "$2.31M", "$1.42B"]);
  });
});
