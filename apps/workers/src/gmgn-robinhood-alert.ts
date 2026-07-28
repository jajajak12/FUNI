/** Read-only GMGN Robinhood discovery.  It deliberately owns no signer, wallet, or RPC sync path. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { getAddress, type Address } from 'viem';
import { cachedV4PoolsForToken } from '../../cli/src/v4-registry.js';
import { robinhoodMainnet } from '@robin/core';
import type { SqliteLedgerRepository } from '@robin/ledger';

export const GMGN_FEE_SEMANTIC_STATUS='EMPIRICALLY_VERIFIED_GMGN_UI' as const;
export const GMGN_SOURCE_VERSION='gmgn-cli-robinhood-token-info-v1' as const;
export const GMGN_LIMITS={marketCapUsd:500_000,liquidityUsd:30_000,volume1hUsd:500_000,holderCount:700,totalFeeEth:1} as const;

/**
 * Material-change thresholds for re-alert.  A re-alert requires the candidate
 * metrics to have moved by at least one of these deltas relative to the
 * previously alerted snapshot, AND the re-alert cooldown to have elapsed.
 */
export const RE_ALERT_MATERIAL_CHANGE={marketCapUsd:0.20,liquidityUsd:0.20,volume1hUsd:0.30,totalFeeEth:0.25} as const;
export const DEFAULT_RE_ALERT_INTERVAL_MS=30*60*1000;
export const RE_ALERT_INTERVAL_ENV='GMGN_ALERT_REALERT_INTERVAL_MS';

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const numeric=(value:unknown)=>{const n=typeof value==='number'?value:typeof value==='string'?Number(value):NaN;return Number.isFinite(n)?n:undefined;};
const object=z.object({}).passthrough();

/**
 * Trending envelope from gmgn-cli:
 *   {"code":0,"data":{"rank":[ {address, market_cap, liquidity, volume, holder_count, gas_fee, history_highest_market_cap, launchpad_platform, name, symbol, ...} ]}}
 * Other discovery sources (new_creation, pump, completed, near_completion) are
 * intentionally NOT used as natural-alert discovery sources per policy.
 */
const trendingRankSchema=object.extend({
  address:z.string(),
  symbol:z.string().optional(),
  name:z.string().optional(),
  market_cap:z.union([z.number(),z.string()]).optional(),
  liquidity:z.union([z.number(),z.string()]).optional(),
  volume:z.union([z.number(),z.string()]).optional(),
  holder_count:z.union([z.number(),z.string()]).optional(),
  gas_fee:z.union([z.number(),z.string()]).optional(),
  history_highest_market_cap:z.union([z.number(),z.string()]).optional(),
  launchpad_platform:z.string().optional(),
  launchpad:z.string().optional(),
  price:z.union([z.number(),z.string()]).optional(),
  total_supply:z.union([z.number(),z.string()]).optional(),
  circulating_supply:z.union([z.number(),z.string()]).optional(),
});

const trendingEnvelopeSchema=object.extend({
  code:z.union([z.number(),z.string()]).optional(),
  data:object.optional(),
}).passthrough();

/**
 * Token info schema (post-hydration).  Kept for compatibility with the
 * hydrate path.  We deliberately do NOT use ath_mc / history_highest_market_cap
 * to satisfy the current market-cap admission gate.
 */
const tokenInfoSchema=object.extend({
  address:z.string(),
  symbol:z.string().optional(),
  name:z.string().optional(),
  holder_count:z.union([z.number(),z.string()]).optional(),
  liquidity:z.union([z.number(),z.string()]).optional(),
  total_fee:z.union([z.number(),z.string()]).optional(),
  trade_fee:z.union([z.number(),z.string()]).optional(),
  priority_fee:z.union([z.number(),z.string()]).optional(),
  creation_timestamp:z.union([z.number(),z.string()]).optional(),
  price:object.optional(),
  stat:object.optional(),
  market_cap:z.union([z.number(),z.string()]).optional(),
  usd_market_cap:z.union([z.number(),z.string()]).optional(),
  history_highest_market_cap:z.union([z.number(),z.string()]).optional(),
});

export type Admission={status:'PASS'|'REJECT';reasons:string[]};
export type NormalizedObservation={
  tokenAddress:Address;
  symbol?:string;
  name?:string;
  observedAt:number;
  sourceTimestamp?:number;
  marketCapUsd?:number;
  liquidityUsd?:number;
  volume1hUsd?:number;
  holderCount?:number;
  totalFeeEth?:number;
  tradeFeeRaw?:string;
  priorityFeeRaw?:string;
  feeSemanticStatus:typeof GMGN_FEE_SEMANTIC_STATUS;
  feeObservedAt:number;
  tokenAgeSeconds?:number;
  launchPlatform?:string;
  top10Pct?:number;
  insiderPct?:number;
  bundledPct?:number;
  devHoldingPct?:number;
  security:Record<string,unknown>;
  missingReasons:string[];
  admission:Admission;
  source:Record<string,unknown>;
  // Persisted context only; never used to satisfy market-cap admission.
  historicalHighestMarketCapUsd?:number;
  marketCapProvenance:'trending_market_cap'|'price_x_supply'|'missing';
};

function pick(record:Record<string,unknown>|undefined,...keys:string[]){for(const key of keys){const value=record?.[key];if(value!==undefined)return numeric(value);}return undefined;}

/**
 * Resolve current market cap from a trending row using the policy:
 *   1. Use a finite positive market_cap field; otherwise
 *   2. Derive from price × (circulating_supply ?? total_supply) when both are
 *      finite positive; otherwise
 *   3. Fail closed.
 * `history_highest_market_cap` (and any ath_mc) is NEVER used to satisfy the
 * current market-cap admission gate and is returned as context only.
 */
export function resolveCurrentMarketCapUsd(row:Record<string,unknown>):{value:number|undefined;provenance:NormalizedObservation['marketCapProvenance'];historicalHighestMarketCapUsd:number|undefined}{
  const spot=numeric(row.market_cap);
  if(finite(spot)&&spot>0)return {value:spot,provenance:'trending_market_cap',historicalHighestMarketCapUsd:numeric(row.history_highest_market_cap)};
  const price=numeric(row.price);
  const supplyRaw=row.circulating_supply??row.total_supply;
  const supply=numeric(supplyRaw);
  if(finite(price)&&price>0&&finite(supply)&&supply>0){
    const derived=price*supply;
    if(finite(derived)&&derived>0)return {value:derived,provenance:'price_x_supply',historicalHighestMarketCapUsd:numeric(row.history_highest_market_cap)};
  }
  return {value:undefined,provenance:'missing',historicalHighestMarketCapUsd:numeric(row.history_highest_market_cap)};
}

function epochMs(value:unknown){const n=numeric(value);if(!n||n<=0)return undefined;return n<10_000_000_000?n*1000:n;}

export function admitGmgn(input:Pick<NormalizedObservation,'marketCapUsd'|'liquidityUsd'|'volume1hUsd'|'holderCount'|'totalFeeEth'|'launchPlatform'|'name'>):Admission{
 const reasons:string[]=[];
 const required:ReadonlyArray<readonly [keyof typeof GMGN_LIMITS,number|undefined]>=[['marketCapUsd',input.marketCapUsd],['liquidityUsd',input.liquidityUsd],['volume1hUsd',input.volume1hUsd],['holderCount',input.holderCount],['totalFeeEth',input.totalFeeEth]];
 for(const [field,value] of required){if(!finite(value)||value<0)reasons.push(`MISSING_OR_INVALID_${field}`);else if(value<GMGN_LIMITS[field])reasons.push(`BELOW_${field}`);}
 if(String(input.launchPlatform??'').trim().toLowerCase()==='flap.fun')reasons.push('EXCLUDED_FLAP_FUN');
 if(String(input.name??'').trim().toLowerCase()==='flap stocks')reasons.push('EXCLUDED_FLAP_STOCKS');
 return {status:reasons.length?'REJECT':'PASS',reasons};
}

/**
 * Build a normalized observation from a trending-rank row.
 * Used by the discovery path; treats the trending row as authoritative for
 * the spot market cap and the spot 1h volume.
 */
export function normalizeTrendingObservation(rankRaw:unknown,observedAt=Date.now()):NormalizedObservation{
 const rank=trendingRankSchema.parse(rankRaw);
 const tokenAddress=getAddress(rank.address);
 const marketCap=resolveCurrentMarketCapUsd(rank as unknown as Record<string,unknown>);
 const marketCapUsd=marketCap.value;
 const liquidityUsd=pick(rank as unknown as Record<string,unknown>,'liquidity');
 const volume1hUsd=pick(rank as unknown as Record<string,unknown>,'volume');
 const holderCount=pick(rank as unknown as Record<string,unknown>,'holder_count');
 const totalFeeEth=pick(rank as unknown as Record<string,unknown>,'gas_fee');
 const createdAt=epochMs(rank.creation_timestamp);
 const missingReasons:string[]=[];
 const critical:Record<string,number|undefined>={marketCapUsd,liquidityUsd,volume1hUsd,holderCount,totalFeeEth};
 for(const [name,value] of Object.entries(critical))if(!finite(value)||value<0)missingReasons.push(`MISSING_OR_INVALID_${name}`);
 const launchPlatform=String(rank.launchpad_platform??rank.launchpad??'')||undefined;
 const observation:Omit<NormalizedObservation,'admission'>={
  tokenAddress,
  symbol:rank.symbol,
  name:rank.name,
  observedAt,
  sourceTimestamp:undefined,
  marketCapUsd,
  liquidityUsd,
  volume1hUsd,
  holderCount,
  totalFeeEth,
  tradeFeeRaw:undefined,
  priorityFeeRaw:undefined,
  feeSemanticStatus:GMGN_FEE_SEMANTIC_STATUS,
  feeObservedAt:observedAt,
  tokenAgeSeconds:createdAt?Math.max(0,Math.floor((observedAt-createdAt)/1000)):undefined,
  launchPlatform,
  top10Pct:undefined,
  insiderPct:undefined,
  bundledPct:undefined,
  devHoldingPct:undefined,
  security:{},
  missingReasons,
  source:{route:'gmgn-cli market trending --chain robinhood',sourceVersion:GMGN_SOURCE_VERSION,tokenInfoObservedAt:observedAt,sourceTimestampAvailable:false},
  historicalHighestMarketCapUsd:marketCap.historicalHighestMarketCapUsd,
  marketCapProvenance:marketCap.provenance,
 };
 return {...observation,admission:admitGmgn(observation)};
}

/**
 * Hydrate-time normalizer (for the rehydration path that re-checks a known
 * candidate via `gmgn-cli token info`).  Kept for completeness; not used in
 * the new trending-only discovery flow.
 */
export function normalizeGmgnObservation(infoRaw:unknown,observedAt=Date.now()):NormalizedObservation{
 const info=tokenInfoSchema.parse(infoRaw);
 const price=object.parse(info.price??{});
 const stat=object.parse(info.stat??{});
 const tokenAddress=getAddress(info.address);
 const rankLike:Record<string,unknown>={market_cap:info.usd_market_cap??info.market_cap,liquidity:info.liquidity,holder_count:info.holder_count,gas_fee:info.total_fee,price:(price as Record<string,unknown>).price,total_supply:undefined,circulating_supply:undefined,history_highest_market_cap:info.history_highest_market_cap};
 const marketCap=resolveCurrentMarketCapUsd(rankLike);
 const marketCapUsd=marketCap.value;
 const liquidityUsd=numeric(info.liquidity);
 const volume1hUsd=numeric((price as Record<string,unknown>).volume_1h);
 const holderCount=numeric(info.holder_count)??numeric((stat as Record<string,unknown>).holder_count);
 const totalFeeEth=numeric(info.total_fee);
 const createdAt=epochMs(info.creation_timestamp);
 const missingReasons:string[]=[];
 const critical:Record<string,number|undefined>={marketCapUsd,liquidityUsd,volume1hUsd,holderCount,totalFeeEth};
 for(const [name,value] of Object.entries(critical))if(!finite(value)||value<0)missingReasons.push(`MISSING_OR_INVALID_${name}`);
 const launchPlatform=String((info as Record<string,unknown>).launchpad_platform??(info as Record<string,unknown>).launchpad??'')||undefined;
 const observation:Omit<NormalizedObservation,'admission'>={
  tokenAddress,
  symbol:info.symbol,
  name:info.name,
  observedAt,
  sourceTimestamp:undefined,
  marketCapUsd,
  liquidityUsd,
  volume1hUsd,
  holderCount,
  totalFeeEth,
  tradeFeeRaw:info.trade_fee===undefined?undefined:String(info.trade_fee),
  priorityFeeRaw:info.priority_fee===undefined?undefined:String(info.priority_fee),
  feeSemanticStatus:GMGN_FEE_SEMANTIC_STATUS,
  feeObservedAt:observedAt,
  tokenAgeSeconds:createdAt?Math.max(0,Math.floor((observedAt-createdAt)/1000)):undefined,
  launchPlatform,
  top10Pct:numeric((stat as Record<string,unknown>).top_10_holder_rate),
  insiderPct:undefined,
  bundledPct:undefined,
  devHoldingPct:numeric((stat as Record<string,unknown>).dev_team_hold_rate),
  security:{},
  missingReasons,
  source:{route:'gmgn-cli token info --chain robinhood',sourceVersion:GMGN_SOURCE_VERSION,tokenInfoObservedAt:observedAt,sourceTimestampAvailable:false},
  historicalHighestMarketCapUsd:marketCap.historicalHighestMarketCapUsd,
  marketCapProvenance:marketCap.provenance,
 };
 return {...observation,admission:admitGmgn(observation)};
}

/**
 * Per-token natural-alert identity.  Keyed by (token_address, source_version)
 * so worker restarts do not reset it and metric churn cannot generate new
 * identities.  This is the row written when a token first passes the
 * admission gate.  Subsequent cycles look this row up to decide whether to
 * deliver, re-alert, or stay silent.
 */
export function naturalAlertKey(token:Address,version=GMGN_SOURCE_VERSION):string{
 return createHash('sha256').update(`${token.toLowerCase()}|${version}`).digest('hex');
}

export function snapshotHash(observation:NormalizedObservation):string{
 return createHash('sha256').update(JSON.stringify({
  token:observation.tokenAddress.toLowerCase(),
  marketCapUsd:observation.marketCapUsd,
  liquidityUsd:observation.liquidityUsd,
  volume1hUsd:observation.volume1hUsd,
  holderCount:observation.holderCount,
  totalFeeEth:observation.totalFeeEth,
  version:GMGN_SOURCE_VERSION,
 })).digest('hex');
}

export type NaturalDedupeRow={
 token_address:string;
 natural_key:string;
 last_alerted_at_ms:number;
 last_alerted_market_cap_usd:number|null;
 last_alerted_liquidity_usd:number|null;
 last_alerted_volume_1h_usd:number|null;
 last_alerted_total_fee_eth:number|null;
 last_alerted_holder_count:number|null;
};

export type RealertDecision={eligible:boolean;reasons:string[];cooldownRemainingMs:number;materialChange:boolean};

export function loadNaturalDedupe(repo:SqliteLedgerRepository,token:Address):NaturalDedupeRow|undefined{
 const key=naturalAlertKey(token);
 return repo.db.prepare(`SELECT token_address,natural_key,last_alerted_at_ms,last_alerted_market_cap_usd,last_alerted_liquidity_usd,last_alerted_volume_1h_usd,last_alerted_total_fee_eth,last_alerted_holder_count FROM gmgn_robinhood_alert_dedupe WHERE token_address=? AND natural_key=?`).get(token,key) as NaturalDedupeRow|undefined;
}

/**
 * Decide whether a passing observation is eligible to alert.
 *  - never alerted: ALERT once.
 *  - re-alert: requires BOTH cooldown elapsed AND a material metric change
 *    in at least one of {marketCap, liquidity, volume1h, totalFee}.
 * Pure function; does not mutate the database.
 */
export function decideRealert(input:{now:number;previous:NaturalDedupeRow|undefined;candidate:{marketCapUsd:number|undefined;liquidityUsd:number|undefined;volume1hUsd:number|undefined;totalFeeEth:number|undefined};reAlertIntervalMs:number}):RealertDecision{
 const reasons:string[]=[];
 if(!input.previous)return {eligible:true,reasons:['INITIAL_ALERT'],cooldownRemainingMs:0,materialChange:true};
 const elapsed=input.now-input.previous.last_alerted_at_ms;
 const cooldownRemainingMs=Math.max(0,input.reAlertIntervalMs-elapsed);
 if(elapsed<input.reAlertIntervalMs){reasons.push(`COOLDOWN_ACTIVE(${cooldownRemainingMs}ms remaining)`);}
 const material=isMaterialChange(input.previous,input.candidate);
 if(!material)reasons.push('NO_MATERIAL_METRIC_CHANGE');
 return {eligible:elapsed>=input.reAlertIntervalMs&&material,reasons,cooldownRemainingMs,materialChange:material};
}

function pctChange(prev:number|null,cur:number|undefined):number|null{
 if(prev===null||prev<=0||!finite(cur)||cur===undefined)return null;
 return Math.abs((cur-prev)/prev);
}

export function isMaterialChange(previous:NaturalDedupeRow,candidate:{marketCapUsd:number|undefined;liquidityUsd:number|undefined;volume1hUsd:number|undefined;totalFeeEth:number|undefined}):boolean{
 const deltas:Array<[number|null,number|undefined,number]>=[
  [pctChange(previous.last_alerted_market_cap_usd,candidate.marketCapUsd),candidate.marketCapUsd,RE_ALERT_MATERIAL_CHANGE.marketCapUsd],
  [pctChange(previous.last_alerted_liquidity_usd,candidate.liquidityUsd),candidate.liquidityUsd,RE_ALERT_MATERIAL_CHANGE.liquidityUsd],
  [pctChange(previous.last_alerted_volume_1h_usd,candidate.volume1hUsd),candidate.volume1hUsd,RE_ALERT_MATERIAL_CHANGE.volume1hUsd],
  [pctChange(previous.last_alerted_total_fee_eth,candidate.totalFeeEth),candidate.totalFeeEth,RE_ALERT_MATERIAL_CHANGE.totalFeeEth],
 ];
 for(const [delta,cur,threshold] of deltas){
  if(delta===null)continue; // no prior to compare (or no current) — do not credit
  if(delta>=threshold)return true;
 }
 return false;
}

/**
 * Persist a fresh natural-dedupe row OR update the existing one.  Returns
 * the resulting row.  Call this ONLY when the observation is being delivered.
 */
export function recordNaturalAlert(repo:SqliteLedgerRepository,token:Address,observation:NormalizedObservation,now:number):NaturalDedupeRow{
 const key=naturalAlertKey(token);
 repo.db.prepare(`INSERT INTO gmgn_robinhood_alert_dedupe(token_address,natural_key,last_alerted_at_ms,last_alerted_market_cap_usd,last_alerted_liquidity_usd,last_alerted_volume_1h_usd,last_alerted_total_fee_eth,last_alerted_holder_count)
   VALUES(?,?,?,?,?,?,?,?)
   ON CONFLICT(token_address,natural_key) DO UPDATE SET
     last_alerted_at_ms=excluded.last_alerted_at_ms,
     last_alerted_market_cap_usd=excluded.last_alerted_market_cap_usd,
     last_alerted_liquidity_usd=excluded.last_alerted_liquidity_usd,
     last_alerted_volume_1h_usd=excluded.last_alerted_volume_1h_usd,
     last_alerted_total_fee_eth=excluded.last_alerted_total_fee_eth,
     last_alerted_holder_count=excluded.last_alerted_holder_count`).run(
  token,key,now,
  observation.marketCapUsd??null,
  observation.liquidityUsd??null,
  observation.volume1hUsd??null,
  observation.totalFeeEth??null,
  observation.holderCount??null,
 );
 return loadNaturalDedupe(repo,token)!;
}

export function persistGmgnObservation(repo:SqliteLedgerRepository,observation:NormalizedObservation):void{
 repo.db.prepare(`INSERT INTO gmgn_robinhood_observations (token_address,symbol,name,observed_at_ms,source_timestamp_ms,market_cap_usd,liquidity_usd,volume_1h_usd,holder_count,total_fee_eth,trade_fee_raw,priority_fee_raw,fee_semantic_status,fee_observed_at_ms,token_age_seconds,launch_platform,top10_pct,insider_pct,bundled_pct,dev_holding_pct,security_json,raw_status,raw_version,missing_reasons_json,admission_status,admission_reasons_json,source_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  observation.tokenAddress,
  observation.symbol??null,
  observation.name??null,
  observation.observedAt,
  observation.sourceTimestamp??null,
  observation.marketCapUsd??null,
  observation.liquidityUsd??null,
  observation.volume1hUsd??null,
  observation.holderCount??null,
  observation.totalFeeEth??null,
  observation.tradeFeeRaw??null,
  observation.priorityFeeRaw??null,
  observation.feeSemanticStatus,
  observation.feeObservedAt,
  observation.tokenAgeSeconds??null,
  observation.launchPlatform??null,
  observation.top10Pct??null,
  observation.insiderPct??null,
  observation.bundledPct??null,
  observation.devHoldingPct??null,
  JSON.stringify(observation.security),
  'OK',
  GMGN_SOURCE_VERSION,
  JSON.stringify(observation.missingReasons),
  observation.admission.status,
  JSON.stringify(observation.admission.reasons),
  JSON.stringify({...observation.source,marketCapProvenance:observation.marketCapProvenance,historicalHighestMarketCapUsd:observation.historicalHighestMarketCapUsd??null}),
 );
}

export function enrichLocalPools(repo:SqliteLedgerRepository,token:Address):{version:'v3'|'v4';id:string}[]{
 const v4=cachedV4PoolsForToken({repo,token}).candidates.filter(x=>x.executionEligible).map(x=>({version:'v4' as const,id:x.poolId}));
 const v3=repo.v3CachedPoolsForToken(token,[robinhoodMainnet.assets.USDG,robinhoodMainnet.assets.WETH]).map(x=>({version:'v3' as const,id:String(x.pool_address)}));
 return [...v4,...v3];
}

const amount=(value:number|undefined)=>value===undefined?'unavailable':value.toLocaleString('en-US',{maximumFractionDigits:2});
export function formatGmgnAlert(observation:NormalizedObservation,pools:{version:'v3'|'v4';id:string}[]):string{
 return [
  `${observation.name??'Unknown'} / ${observation.symbol??'Unknown'}`,
  `Contract: ${observation.tokenAddress}`,
  `Market cap: $${amount(observation.marketCapUsd)}`,
  `Global liquidity: $${amount(observation.liquidityUsd)}`,
  `1h volume: $${amount(observation.volume1hUsd)}`,
  `Holders: ${amount(observation.holderCount)}`,
  `GMGN Total Fees: ${amount(observation.totalFeeEth)} ETH`,
  `Token age: ${observation.tokenAgeSeconds===undefined?'unavailable':`${observation.tokenAgeSeconds}s`}`,
  `Top-10 / insider / bundled / developer: ${amount(observation.top10Pct)} / ${amount(observation.insiderPct)} / ${amount(observation.bundledPct)} / ${amount(observation.devHoldingPct)}`,
  `Eligible active-liquidity pools: ${pools.length} (v4 ${pools.filter(x=>x.version==='v4').length}, v3 ${pools.filter(x=>x.version==='v3').length})`,
 ].join('\n');
}
export function formatGmgnGroupAlert(observation:NormalizedObservation,pools:{version:'v3'|'v4';id:string}[]):string{
 return `ALERT-ONLY\n${formatGmgnAlert(observation,pools)}`;
}
export const gmgnOpenLpCallback=(token:Address):string=>`gmgn-open-lp:${token}`;
export const gmgnTokenUrl=(token:Address):string=>`https://gmgn.ai/robinhood/token/${token}`;
export function gmgnAlertButtons(destination:'private'|'group',token:Address,eligiblePoolCount:number){
 const buttons:Array<{text:string;url?:string;callback_data?:string}>=[{text:'View GMGN',url:gmgnTokenUrl(token)}];
 if(destination==='private'&&eligiblePoolCount>0)buttons.push({text:'Open LP',callback_data:gmgnOpenLpCallback(token)});
 return [buttons];
}

/**
 * Envelope-aware extraction for `gmgn-cli market trending`.  Accepts a
 * already-parsed JSON value (gmgn-cli returns
 * `{"code":0,"data":{"rank":[...]}}` on success).  Returns the `rank` array
 * (or empty list on malformed response) without throwing.
 */
export function extractTrendingRank(parsed:unknown):unknown[]{
 const envelope=trendingEnvelopeSchema.safeParse(parsed);
 if(!envelope.success)return [];
 const data=parsed&&typeof parsed==='object'?(parsed as Record<string,unknown>).data:undefined;
 if(!data||typeof data!=='object')return [];
 const rank=(data as Record<string,unknown>).rank;
 return Array.isArray(rank)?rank:[];
}

/**
 * Spawn `gmgn-cli` and return the parsed JSON.  Strict timeout + size caps
 * to keep one cycle bounded.
 */
export async function gmgnCliJson(args:string[],timeoutMs=15_000):Promise<unknown>{
 return new Promise((resolve,reject)=>{
  const child=spawn('gmgn-cli',args,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,USER:process.env.USER}});
  let stdout='';
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('GMGN_CLI_TIMEOUT'));},timeoutMs);
  child.stdout.on('data',chunk=>{stdout+=String(chunk);if(stdout.length>2_000_000){child.kill('SIGTERM');reject(new Error('GMGN_CLI_RESPONSE_TOO_LARGE'));}});
  child.on('error',()=>reject(new Error('GMGN_CLI_UNAVAILABLE')));
  child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error('GMGN_CLI_FAILED'));try{resolve(JSON.parse(stdout));}catch{reject(new Error('GMGN_CLI_INVALID_JSON'));}});
 });
}
