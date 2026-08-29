export type DexScreenerV4Liquidity =
  | { status: "KNOWN"; valueUsd: number; volume24hUsd?:number; priceChange24hPct?:number }
  | { status: "KNOWN_ZERO"; valueUsd: 0; volume24hUsd?:number; priceChange24hPct?:number }
  | { status: "UNAVAILABLE"; reason: string };

type DexPair = {
  chainId?: unknown;
  dexId?: unknown;
  labels?: unknown;
  pairAddress?: unknown;
  baseToken?: { address?: unknown };
  quoteToken?: { address?: unknown };
  liquidity?: { usd?: unknown };
  volume?: { h24?: unknown };
  priceChange?: { h24?: unknown };
};

export type DexScreenerFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const timeoutMs = 4_000;
const unavailable = (reason: string): DexScreenerV4Liquidity => ({ status: "UNAVAILABLE", reason });
const lower = (value: unknown) => typeof value === "string" ? value.toLowerCase() : "";

/** Read-only, Telegram-only exact V4 pool metric. It intentionally has no repository or cache dependency. */
export async function fetchDexScreenerV4Liquidity(input: {
  poolId: string;
  currency0: string;
  currency1: string;
  fetcher?: DexScreenerFetch;
}): Promise<DexScreenerV4Liquidity> {
  const fetcher = input.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${encodeURIComponent(input.poolId)}`, { signal: controller.signal });
    if (!response.ok) return unavailable("HTTP_FAILURE");
    let body: unknown;
    try { body = await response.json(); } catch { return unavailable("MALFORMED_JSON"); }
    const pairs = body && typeof body === "object" && Array.isArray((body as { pairs?: unknown }).pairs)
      ? (body as { pairs: DexPair[] }).pairs
      : [];
    const pair = pairs.find(value => lower(value.pairAddress) === lower(input.poolId));
    if (!pair) return unavailable("POOL_ID_MISMATCH");
    if (pair.chainId !== "robinhood" || pair.dexId !== "uniswap") return unavailable("WRONG_DEX_OR_CHAIN");
    if (!Array.isArray(pair.labels) || !pair.labels.some(value => value === "v4")) return unavailable("NOT_V4");
    const actualTokens = [lower(pair.baseToken?.address), lower(pair.quoteToken?.address)].sort();
    const expectedTokens = [lower(input.currency0), lower(input.currency1)].sort();
    if (!actualTokens[0] || !actualTokens[1] || actualTokens[0] !== expectedTokens[0] || actualTokens[1] !== expectedTokens[1]) return unavailable("TOKEN_MISMATCH");
    const valueUsd = pair.liquidity?.usd;
    if (typeof valueUsd !== "number" || !Number.isFinite(valueUsd) || valueUsd < 0) return unavailable("INVALID_LIQUIDITY");
    const volume24hUsd=pair.volume?.h24,priceChange24hPct=pair.priceChange?.h24,extra={...(typeof volume24hUsd==='number'&&Number.isFinite(volume24hUsd)&&volume24hUsd>=0?{volume24hUsd}:{}),...(typeof priceChange24hPct==='number'&&Number.isFinite(priceChange24hPct)?{priceChange24hPct}:{})};
    return valueUsd === 0 ? { status: "KNOWN_ZERO", valueUsd: 0,...extra } : { status: "KNOWN", valueUsd,...extra };
  } catch (error) {
    return unavailable(error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "REQUEST_FAILURE");
  } finally {
    clearTimeout(timer);
  }
}

export function formatDexScreenerV4Liquidity(value: DexScreenerV4Liquidity) {
  return `Pool liquidity: ${value.status === "UNAVAILABLE" ? "Unavailable" : formatDexCompactUsd(value.valueUsd)}`;
}

function formatDexCompactUsd(value: number) {
  const units = [[1_000_000_000, "B"], [1_000_000, "M"], [1_000, "K"]] as const;
  for (const [threshold, suffix] of units) if (value >= threshold) {
    const scaled = value / threshold;
    const digits = scaled >= 100 ? 0 : 2;
    return `$${scaled.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits })}${suffix}`;
  }
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function canonicalTelegramV4RankingScore(candidate:{executionEligible:boolean;liquidity?:bigint;cacheAgeMs?:number|null;feeSemantics?:{staticFeePips?:number|null}},evidence:DexScreenerV4Liquidity){
 const external=evidence.status==='UNAVAILABLE'?null:evidence.valueUsd,volume=evidence.status==='UNAVAILABLE'?null:evidence.volume24hUsd??null,change=evidence.status==='UNAVAILABLE'?null:evidence.priceChange24hPct??null,fee=Math.max(0,Math.min(1,Number(candidate.feeSemantics?.staticFeePips??0)/50_000)),active=candidate.liquidity&&candidate.liquidity>0n?Math.min(1,Math.log10(Number(candidate.liquidity>10n**30n?10n**30n:candidate.liquidity)+1)/30):0,usableLiquidity=external===null?0:Math.min(1,Math.log10(external+1)/7),realVolume=volume===null?0:Math.min(1,Math.log10(volume+1)/7),rangeUtilization=external&&volume!==null?Math.min(1,volume/Math.max(1,external)/5):0,priceSafety=change===null?0:Math.max(0,1-Math.abs(change)/100),freshness=candidate.cacheAgeMs===null||candidate.cacheAgeMs===undefined?0:Math.max(0,1-candidate.cacheAgeMs/120_000),score=usableLiquidity*35+realVolume*20+rangeUtilization*10+priceSafety*5+freshness*10+active*10+fee*10;
 return {score,inputs:{feeOpportunity:fee,activeLiquidity:active,usableLiquidity,realVolume,rangeUtilization,priceSafety,freshness}};
}
export function rankTelegramV4ByDexLiquidity<T extends { executionEligible: boolean;liquidity?:bigint;cacheAgeMs?:number|null;feeSemantics?:{staticFeePips?:number|null} }>(items: readonly { candidate: T; liquidity: DexScreenerV4Liquidity }[]) {
  return items.map((item, index) => ({ ...item, index,ranking:canonicalTelegramV4RankingScore(item.candidate,item.liquidity) })).sort((a, b) => {
    const classOrder = Number(a.candidate.executionEligible) - Number(b.candidate.executionEligible);
    if (classOrder) return -classOrder;
    const scoreOrder=b.ranking.score-a.ranking.score;if(scoreOrder)return scoreOrder;
    return a.index - b.index;
  }).map(({ index: _index, ...item }) => item);
}
