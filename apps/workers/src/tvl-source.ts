/**
 * The configured Uniswap indexer is authoritative for USD TVL.  This module
 * deliberately has no price/reserve fallback: without a source timestamp and
 * an explicitly positive finite value, the result is unusable.
 */
export const TVL_FRESHNESS_TTL_MS=Number(process.env.UNISWAP_TVL_TTL_MS??60_000);
export type TrustedTvl={tvlUsd:number;tvlSource:string;observedAtMs:number;freshUntilMs:number;status:'fresh'};
export type TvlResult=TrustedTvl|{status:'missing'|'invalid';reason:string};

export async function configuredUniswapTvl(protocol:'v3'|'v4',pool:string):Promise<TvlResult>{
 const endpoint=process.env.UNISWAP_TVL_GRAPHQL_URL;
 if(!endpoint)return {status:'missing',reason:'UNISWAP_TVL_GRAPHQL_URL_NOT_CONFIGURED'};
 if(!Number.isSafeInteger(TVL_FRESHNESS_TTL_MS)||TVL_FRESHNESS_TTL_MS<1)return {status:'invalid',reason:'UNISWAP_TVL_TTL_MS_INVALID'};
 try{
  // The operator-configured endpoint must expose a canonical pool(id) TVL
  // record.  We ask for observedAt so freshness belongs to the source, not
  // merely to this HTTP request.
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query StrictTvl($id: String!) { pool(id: $id) { totalValueLockedUSD tvlUsd observedAt timestamp } }',variables:{id:pool.toLowerCase()}})});
  const body=await response.json() as any,poolRow=body?.data?.pool;
  const tvlUsd=Number(poolRow?.totalValueLockedUSD??poolRow?.tvlUsd),observedAtRaw=poolRow?.observedAt??poolRow?.timestamp,observedAtMs=typeof observedAtRaw==='number'?(observedAtRaw<10_000_000_000?observedAtRaw*1000:observedAtRaw):Date.parse(String(observedAtRaw));
  if(!response.ok||!Number.isFinite(tvlUsd)||tvlUsd<=0||!Number.isFinite(observedAtMs)||observedAtMs<=0)return {status:'invalid',reason:'UNISWAP_TVL_RESPONSE_INVALID'};
  const freshUntilMs=observedAtMs+TVL_FRESHNESS_TTL_MS;
  if(freshUntilMs<=Date.now())return {status:'missing',reason:'UNISWAP_TVL_STALE'};
  return {tvlUsd,tvlSource:`uniswap-graphql:${new URL(endpoint).host}:${protocol}`,observedAtMs,freshUntilMs,status:'fresh'};
 }catch(error){return {status:'missing',reason:`UNISWAP_TVL_UNAVAILABLE:${error instanceof Error?error.message:'unknown'}`};}
}
