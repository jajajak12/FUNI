import type { TransactionReceipt } from "viem";
import { robinhoodMainnet } from "@funi/core";
import { createHash } from "node:crypto";
import type { SqliteLedgerRepository } from "@funi/ledger";
import {
  V4_MAX_TICK,
  V4_MIN_TICK,
  poolId,
  sqrtPriceAtTick,
  type V4PoolKey,
} from "@funi/v4";

const USD_SCALE = 1_000_000n;
const same=(a:unknown,b:unknown)=>String(a).toLowerCase()===String(b).toLowerCase();
function pow10(n:number){if(!Number.isInteger(n)||n<0||n>255)throw new Error("V4_REALIZED_DECIMALS_INVALID");return 10n**BigInt(n);}
function decimalFraction(value:string){
  const match=value.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);if(!match)throw new Error("V4_REALIZED_DECIMAL_INVALID");
  const sign=match[1]==="-"?-1n:1n,digits=BigInt(`${match[2]}${match[3]??""}`),exp=Number(match[4]??0)-(match[3]?.length??0);
  return exp>=0?{n:sign*digits*pow10(exp),d:1n}:{n:sign*digits,d:pow10(-exp)};
}
function rounded(n:bigint,d:bigint){if(d<=0n||n<0n)throw new Error("V4_REALIZED_FIXED_POINT_INVALID");return (n+d/2n)/d;}
export function usdMicrosToText(value:bigint){const sign=value<0n?"-":"",v=value<0n?-value:value,whole=v/USD_SCALE,fraction=(v%USD_SCALE).toString().padStart(6,"0").replace(/0+$/,"");return `${sign}${whole}${fraction?`.${fraction}`:""}`;}
export function usdTextToMicros(value:string){const f=decimalFraction(value),scaled=f.n*USD_SCALE;if(scaled%f.d!==0n)throw new Error("V4_REALIZED_USD_PRECISION_EXCEEDS_MICROS");return scaled/f.d;}
export function rawUsdMicros(raw:bigint,decimals:number,price:string){const p=decimalFraction(price);if(p.n<0n)throw new Error("V4_REALIZED_PRICE_INVALID");return rounded(raw*p.n*USD_SCALE,p.d*pow10(decimals));}

export function valueGenericV4Returns(input:{token0:string;token1:string;decimals0:number;decimals1:number;amount0:bigint;amount1:bigint;price1Per0:string}){
  const zeroUsd=same(input.token0,robinhoodMainnet.assets.USDG),oneUsd=same(input.token1,robinhoodMainnet.assets.USDG),ratio=decimalFraction(input.price1Per0);
  if(zeroUsd===oneUsd||ratio.n<=0n)return {status:"INCOMPLETE" as const,reason:"DIRECT_USDG_PAIR_PRICE_UNAVAILABLE"};
  const usd0=zeroUsd?rawUsdMicros(input.amount0,input.decimals0,"1"):rounded(input.amount0*ratio.n*USD_SCALE,ratio.d*pow10(input.decimals0));
  const usd1=oneUsd?rawUsdMicros(input.amount1,input.decimals1,"1"):rounded(input.amount1*ratio.d*USD_SCALE,ratio.n*pow10(input.decimals1));
  return {status:"AVAILABLE" as const,token0UsdMicros:usd0,token1UsdMicros:usd1,totalUsdMicros:usd0+usd1,evidence:{contract:"DIRECT_V4_POOL_PRICE_CAPTURE_V1",price1Per0:input.price1Per0,token0:input.token0,token1:input.token1,decimals0:input.decimals0,decimals1:input.decimals1,token0Raw:input.amount0.toString(),token1Raw:input.amount1.toString(),token0Usd:usdMicrosToText(usd0),token1Usd:usdMicrosToText(usd1)}};
}

export type V4RealizedPoolValuationSource={
  poolId:string;
  poolKey:V4PoolKey;
  sqrtPriceX96:bigint;
  tick:number;
  activeLiquidity:bigint;
  initialized:boolean;
  blockNumber:bigint;
  token0Decimals:number;
  token1Decimals:number;
};
export type V4PoolValuationSanityFailure=
  |"POOL_VALUATION_SOURCE_IDENTITY_MISMATCH"
  |"POOL_UNINITIALIZED"
  |"POOL_PRICE_OUTSIDE_PROTOCOL_DOMAIN"
  |"POOL_PRICE_TICK_INCONSISTENT"
  |"POOL_PRICE_AT_PROTOCOL_BOUNDARY"
  |"POOL_ACTIVE_LIQUIDITY_UNAVAILABLE";

function incomplete(reason:V4PoolValuationSanityFailure,source:V4RealizedPoolValuationSource){return {status:"INCOMPLETE" as const,reason,evidence:{contract:"DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V2",sanityStatus:"FAILED",reason,poolId:source.poolId,poolKey:source.poolKey,sqrtPriceX96:source.sqrtPriceX96.toString(),tick:source.tick,activeLiquidity:source.activeLiquidity.toString(),initialized:source.initialized,blockNumber:source.blockNumber.toString(),token0Decimals:source.token0Decimals,token1Decimals:source.token1Decimals}};}

/** Structural source validation only. It deliberately makes no external-oracle
 * or arbitrary USD-magnitude judgement. The boundary band is derived from the
 * pool's own tick spacing: a usable price must sit strictly between its first
 * and last protocol-aligned ticks. */
export function validateV4RealizedPoolValuationSource(input:{token0:string;token1:string;decimals0:number;decimals1:number;sqrtPriceX96:bigint;source:V4RealizedPoolValuationSource}){
  const {source}=input,key=source.poolKey,spacing=key.tickSpacing;
  if(!same(input.token0,key.currency0)||!same(input.token1,key.currency1)||!same(source.poolId,poolId(key))||input.sqrtPriceX96!==source.sqrtPriceX96||input.decimals0!==source.token0Decimals||input.decimals1!==source.token1Decimals||!Number.isInteger(spacing)||spacing<=0||!Number.isInteger(source.tick)||source.tick<V4_MIN_TICK||source.tick>V4_MAX_TICK)return incomplete("POOL_VALUATION_SOURCE_IDENTITY_MISMATCH",source);
  if(!source.initialized)return incomplete("POOL_UNINITIALIZED",source);
  const minimumSqrt=sqrtPriceAtTick(V4_MIN_TICK),maximumSqrt=sqrtPriceAtTick(V4_MAX_TICK);
  if(source.sqrtPriceX96<minimumSqrt||source.sqrtPriceX96>maximumSqrt)return incomplete("POOL_PRICE_OUTSIDE_PROTOCOL_DOMAIN",source);
  const tickFloor=sqrtPriceAtTick(source.tick),tickCeiling=source.tick===V4_MAX_TICK?tickFloor:sqrtPriceAtTick(source.tick+1),tickConsistent=source.tick===V4_MAX_TICK?source.sqrtPriceX96===tickFloor:source.sqrtPriceX96>=tickFloor&&source.sqrtPriceX96<tickCeiling;
  if(!tickConsistent)return incomplete("POOL_PRICE_TICK_INCONSISTENT",source);
  const usableMinimumTick=Math.ceil(V4_MIN_TICK/spacing)*spacing,usableMaximumTick=Math.floor(V4_MAX_TICK/spacing)*spacing;
  if(source.tick<=usableMinimumTick||source.tick>=usableMaximumTick)return incomplete("POOL_PRICE_AT_PROTOCOL_BOUNDARY",source);
  if(source.activeLiquidity<=0n||source.activeLiquidity>2n**128n-1n)return incomplete("POOL_ACTIVE_LIQUIDITY_UNAVAILABLE",source);
  return {status:"AVAILABLE" as const,evidence:{contract:"DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V2",sanityStatus:"AVAILABLE",poolId:source.poolId,poolKey:key,sqrtPriceX96:source.sqrtPriceX96.toString(),tick:source.tick,activeLiquidity:source.activeLiquidity.toString(),initialized:source.initialized,blockNumber:source.blockNumber.toString(),usableMinimumTick,usableMaximumTick,token0Decimals:source.token0Decimals,token1Decimals:source.token1Decimals}};
}

function deriveV4ReturnValuationCandidate(input:{token0:string;token1:string;decimals0:number;decimals1:number;amount0:bigint;amount1:bigint;sqrtPriceX96:bigint}){
  const zeroUsd=same(input.token0,robinhoodMainnet.assets.USDG),oneUsd=same(input.token1,robinhoodMainnet.assets.USDG);
  if(zeroUsd===oneUsd||input.sqrtPriceX96<=0n)return {status:"INCOMPLETE" as const,reason:"DIRECT_USDG_PAIR_PRICE_UNAVAILABLE"};
  if(input.amount0<0n||input.amount1<0n)throw new Error("V4_REALIZED_RETURN_AMOUNT_INVALID");
  pow10(input.decimals0);pow10(input.decimals1);
  const q192=2n**192n,priceSquared=input.sqrtPriceX96*input.sqrtPriceX96;
  const usd0=zeroUsd?rawUsdMicros(input.amount0,input.decimals0,"1"):rounded(input.amount0*priceSquared*USD_SCALE,q192*pow10(input.decimals1));
  const usd1=oneUsd?rawUsdMicros(input.amount1,input.decimals1,"1"):rounded(input.amount1*q192*USD_SCALE,priceSquared*pow10(input.decimals0));
  return {status:"CANDIDATE" as const,token0UsdMicros:usd0,token1UsdMicros:usd1,totalUsdMicros:usd0+usd1};
}

/** Two-stage contract: exact fixed-point math derives a non-canonical
 * candidate, then structural source validation decides whether it may become
 * AVAILABLE evidence. Callers persist only this final result. */
export function valueV4ReturnsFromSqrtPriceX96(input:{token0:string;token1:string;decimals0:number;decimals1:number;amount0:bigint;amount1:bigint;sqrtPriceX96:bigint;source:V4RealizedPoolValuationSource}){
  const candidate=deriveV4ReturnValuationCandidate(input);if(candidate.status==="INCOMPLETE")return candidate;
  const sanity=validateV4RealizedPoolValuationSource(input);if(sanity.status==="INCOMPLETE")return sanity;
  return {status:"AVAILABLE" as const,token0UsdMicros:candidate.token0UsdMicros,token1UsdMicros:candidate.token1UsdMicros,totalUsdMicros:candidate.totalUsdMicros,evidence:{...sanity.evidence,token0:input.token0,token1:input.token1,decimals0:input.decimals0,decimals1:input.decimals1,token0Raw:input.amount0.toString(),token1Raw:input.amount1.toString(),token0Usd:usdMicrosToText(candidate.token0UsdMicros),token1Usd:usdMicrosToText(candidate.token1UsdMicros)}};
}

const rawEvidenceIdentity=(row:Record<string,unknown>)=>`${row.token0_raw??""}|${row.token1_raw??""}|${row.token0_decimals??""}|${row.token1_decimals??""}|${String(row.transaction_hash??"").toLowerCase()}|${row.block_number??""}`;
const sha256=(value:string)=>createHash("sha256").update(value).digest("hex");
export function realizedPnlRawEvidenceChecksum(row:Record<string,unknown>){return sha256(rawEvidenceIdentity(row));}

/** Canonical, CAS-guarded demotion for conclusively invalid historical price
 * evidence. Economic identity and raw token evidence are immutable; only the
 * unsupported USD projection is removed. */
export function repairInvalidV4RealizedPnlValuation(input:{repo:SqliteLedgerRepository;eventId:string;reason:V4PoolValuationSanityFailure;source:V4RealizedPoolValuationSource}){
  const {repo}=input;
  return repo.db.transaction(()=>{
    const row=repo.db.prepare("SELECT * FROM realized_pnl_events WHERE event_id=?").get(input.eventId) as Record<string,unknown>|undefined;
    if(!row||String(row.protocol)!=="v4")throw new Error("V4_REALIZED_PRICE_SANITY_REPAIR_EVENT_INVALID");
    const rawEvidenceSha256=realizedPnlRawEvidenceChecksum(row),priorEvidence=String(row.valuation_evidence_json),priorValuationEvidenceSha256=sha256(priorEvidence),repairEvidence={contract:"V4_REALIZED_PNL_PRICE_SANITY_REPAIR_V1",status:"INCOMPLETE",reason:input.reason,rawEvidencePreserved:true,rawEvidenceSha256,priorValuationEvidenceSha256,source:{poolId:input.source.poolId,poolKey:input.source.poolKey,sqrtPriceX96:input.source.sqrtPriceX96.toString(),tick:input.source.tick,activeLiquidity:input.source.activeLiquidity.toString(),initialized:input.source.initialized,blockNumber:input.source.blockNumber.toString(),token0Decimals:input.source.token0Decimals,token1Decimals:input.source.token1Decimals}},evidence=JSON.stringify(repairEvidence),metadata=(()=>{try{return JSON.parse(String(row.presentation_metadata_json??"{}"));}catch{return {};}})();
    if(String(row.valuation_status)==="INCOMPLETE"){
      let existing:Record<string,unknown>={};try{existing=JSON.parse(priorEvidence);}catch{}
      if(existing.contract==="V4_REALIZED_PNL_PRICE_SANITY_REPAIR_V1"&&existing.reason===input.reason&&existing.rawEvidenceSha256===rawEvidenceSha256)return {changed:0,before:row,after:row,rawEvidenceSha256};
      throw new Error("V4_REALIZED_PRICE_SANITY_REPAIR_STATE_CONFLICT");
    }
    if(String(row.valuation_status)!=="AVAILABLE")throw new Error("V4_REALIZED_PRICE_SANITY_REPAIR_STATE_CONFLICT");
    metadata.returnedValueUsd=null;metadata.valuationUnavailableReason=input.reason;
    const changed=repo.db.prepare("UPDATE realized_pnl_events SET returned_principal_usd=NULL,newly_realized_fees_usd=NULL,realized_pnl_usd=NULL,valuation_status='INCOMPLETE',valuation_evidence_json=?,presentation_metadata_json=? WHERE event_id=? AND valuation_status='AVAILABLE' AND valuation_evidence_json=?").run(evidence,JSON.stringify(metadata),input.eventId,priorEvidence).changes;
    if(changed!==1)throw new Error("V4_REALIZED_PRICE_SANITY_REPAIR_CAS_CONFLICT");
    const after=repo.db.prepare("SELECT * FROM realized_pnl_events WHERE event_id=?").get(input.eventId) as Record<string,unknown>;
    if(realizedPnlRawEvidenceChecksum(after)!==rawEvidenceSha256)throw new Error("V4_REALIZED_PRICE_SANITY_REPAIR_RAW_EVIDENCE_CONFLICT");
    return {changed,before:row,after,rawEvidenceSha256};
  })();
}

function exactInitialBasis(repo:SqliteLedgerRepository,positionId:string,liquidityBefore:bigint,currentTxHash:string){
  const tokenId=positionId.replace(/^v4:/,""),row=repo.v4Position(tokenId);if(!row||!row.open_intent_id||!same(row.funding_token,robinhoodMainnet.assets.USDG))return;
  const decimals=Number(row.funding_decimals),index=Number(row.funding_index),raw=index===0?BigInt(String(row.initial_amount0_raw)):BigInt(String(row.initial_amount1_raw));
  if(raw<=0n||liquidityBefore<=0n)return;
  const priorDecrease=(repo.db.prepare("SELECT 1 FROM liquidity_changes WHERE position_id=? AND kind='decrease' AND lower(tx_hash)<>lower(?) LIMIT 1").get(positionId,currentTxHash));if(priorDecrease)return;
  const deposit=repo.db.prepare("SELECT tx_hash,block_number FROM position_deposits WHERE position_id=? ORDER BY block_number,log_index LIMIT 1").get(positionId) as {tx_hash:string;block_number:string}|undefined;if(!deposit)return;
  return {basis:rawUsdMicros(raw,decimals,"1"),txHash:deposit.tx_hash,blockNumber:deposit.block_number,evidence:{source:"OPERATIONAL_OPEN_EXACT_USDG_FUNDING",fundingRaw:raw.toString(),fundingDecimals:decimals,increaseSupported:false}};
}

export function consumeGenericV4Basis(input:{repo:SqliteLedgerRepository;positionId:string;tokenId:string;intentId:string;stage:string;receipt:TransactionReceipt;liquidityBefore:bigint;liquidityRemoved:bigint;liquidityAfter:bigint}){
  const {repo}=input,eventId=`basis:${input.intentId}:${input.receipt.transactionHash.toLowerCase()}:CONSUME`,existing=repo.db.prepare("SELECT * FROM v4_position_basis_events WHERE basis_event_id=?").get(eventId) as Record<string,unknown>|undefined;if(existing)return existing;
  const intent=repo.v4LifecycleIntent(input.intentId),unresolved=repo.db.prepare("SELECT 1 FROM v4_lifecycle_intents WHERE token_id=? AND id<>? AND created_at<=? AND state IN ('CLAIMED','SIMULATION_PASSED','PREPARED','SUBMITTED','CONFIRMED_RECONCILIATION_REQUIRED','CONFIRMED') LIMIT 1").get(input.tokenId,input.intentId,String(intent?.created_at??""));if(unresolved)throw new Error("V4_REALIZED_BASIS_PREDECESSOR_UNRESOLVED");
  return repo.db.transaction(()=>{
    let rows=repo.db.prepare("SELECT * FROM v4_position_basis_events WHERE position_identity=? ORDER BY CAST(block_number AS INTEGER),COALESCE(transaction_index,-1),basis_event_id").all(input.positionId) as Record<string,unknown>[];
    if(!rows.length){const initial=exactInitialBasis(repo,input.positionId,input.liquidityBefore,input.receipt.transactionHash);if(!initial)return undefined;repo.db.prepare("INSERT INTO v4_position_basis_events(basis_event_id,position_identity,event_kind,workflow_identity,journal_stage,transaction_hash,block_number,transaction_index,liquidity_before_raw,liquidity_delta_raw,liquidity_after_raw,basis_before_usd_micros,basis_delta_usd_micros,basis_after_usd_micros,evidence_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`basis-open:${input.positionId}:${initial.txHash.toLowerCase()}`,input.positionId,"INITIAL",String(repo.v4Position(input.tokenId)?.open_intent_id),"OPEN",initial.txHash.toLowerCase(),initial.blockNumber,null,null,input.liquidityBefore.toString(),input.liquidityBefore.toString(),"0",initial.basis.toString(),initial.basis.toString(),JSON.stringify(initial.evidence),Date.now());rows=repo.db.prepare("SELECT * FROM v4_position_basis_events WHERE position_identity=? ORDER BY CAST(block_number AS INTEGER),COALESCE(transaction_index,-1),basis_event_id").all(input.positionId) as Record<string,unknown>[];}
    const last=rows.at(-1)!,lastBlock=BigInt(String(last.block_number)),block=input.receipt.blockNumber,txIndex=typeof input.receipt.transactionIndex==="number"?input.receipt.transactionIndex:null;if(block<lastBlock||(block===lastBlock&&(txIndex===null||last.transaction_index===null||txIndex<=Number(last.transaction_index))))throw new Error("V4_REALIZED_BASIS_CANONICAL_ORDER_CONFLICT");
    const before=BigInt(String(last.basis_after_usd_micros));if(input.liquidityBefore<=0n||input.liquidityRemoved<=0n||input.liquidityRemoved>input.liquidityBefore||input.liquidityAfter!==input.liquidityBefore-input.liquidityRemoved)throw new Error("V4_REALIZED_BASIS_LIQUIDITY_INVARIANT");
    const consumed=input.liquidityAfter===0n?before:(before*input.liquidityRemoved)/input.liquidityBefore,after=before-consumed;
    repo.db.prepare("INSERT INTO v4_position_basis_events(basis_event_id,position_identity,event_kind,workflow_identity,journal_stage,transaction_hash,block_number,transaction_index,liquidity_before_raw,liquidity_delta_raw,liquidity_after_raw,basis_before_usd_micros,basis_delta_usd_micros,basis_after_usd_micros,evidence_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(eventId,input.positionId,"CONSUME",input.intentId,input.stage,input.receipt.transactionHash.toLowerCase(),block.toString(),txIndex,input.liquidityBefore.toString(),input.liquidityRemoved.toString(),input.liquidityAfter.toString(),before.toString(),consumed.toString(),after.toString(),JSON.stringify({allocation:"REMAINING_BASIS_X_REMOVED_LIQUIDITY_DIV_BEFORE",terminalResidueAbsorbed:input.liquidityAfter===0n}),Date.now());
    return repo.db.prepare("SELECT * FROM v4_position_basis_events WHERE basis_event_id=?").get(eventId) as Record<string,unknown>;
  })();
}
