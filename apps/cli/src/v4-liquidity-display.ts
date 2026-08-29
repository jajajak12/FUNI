export type V4PoolTvlRecord = {
  tvl_usd?: unknown;
  tvl_source?: unknown;
  tvl_observed_at_ms?: unknown;
  tvl_fresh_until_ms?: unknown;
  tvl_status?: unknown;
};

export type V4PoolUsdMetric = {
  label: "Pool TVL";
  usd: number | null;
  formatted: string;
};

export function formatCompactUsd(value: number) {
  const units = [[1_000_000_000, "B"], [1_000_000, "M"], [1_000, "K"]] as const;
  for (const [threshold, suffix] of units) {
    if (value >= threshold) {
      const scaled = value / threshold;
      return `$${scaled.toLocaleString("en-US", { maximumFractionDigits: scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2 })}${suffix}`;
    }
  }
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Strict TVL is a separately sourced, time-bounded pool metric; never a StateView-liquidity conversion. */
export function trustedV4PoolUsdMetric(
  row: V4PoolTvlRecord | undefined,
  now = Date.now(),
): V4PoolUsdMetric {
  const value = Number(row?.tvl_usd),
    observedAt = Number(row?.tvl_observed_at_ms),
    freshUntil = Number(row?.tvl_fresh_until_ms),
    source = typeof row?.tvl_source === "string" ? row.tvl_source.trim() : "";
  if (
    row?.tvl_status !== "fresh" ||
    !source ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isSafeInteger(observedAt) ||
    observedAt <= 0 ||
    !Number.isSafeInteger(freshUntil) ||
    freshUntil <= now ||
    freshUntil < observedAt
  )
    return { label: "Pool TVL", usd: null, formatted: "Unavailable" };
  return { label: "Pool TVL", usd: value, formatted: formatCompactUsd(value) };
}

export function formatV4PoolUsdMetric(row: V4PoolTvlRecord | undefined, now = Date.now()) {
  const metric = trustedV4PoolUsdMetric(row, now);
  return `${metric.label}: ${metric.formatted}`;
}
