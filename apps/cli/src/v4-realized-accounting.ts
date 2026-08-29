import type { TransactionReceipt } from "viem";
import { robinhoodMainnet } from "@funi/core";
import type { SqliteLedgerRepository } from "@funi/ledger";

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

/** Exact V4 raw-unit valuation from the immutable pool sqrt price. */
export function valueV4ReturnsFromSqrtPriceX96(input:{token0:string;token1:string;decimals0:number;decimals1:number;amount0:bigint;amount1:bigint;sqrtPriceX96:bigint}){
  const zeroUsd=same(input.token0,robinhoodMainnet.assets.USDG),oneUsd=same(input.token1,robinhoodMainnet.assets.USDG);
  if(zeroUsd===oneUsd||input.sqrtPriceX96<=0n)return {status:"INCOMPLETE" as const,reason:"DIRECT_USDG_PAIR_PRICE_UNAVAILABLE"};
  pow10(input.decimals0);pow10(input.decimals1);
  const q192=2n**192n,priceSquared=input.sqrtPriceX96*input.sqrtPriceX96;
  const usd0=zeroUsd?rawUsdMicros(input.amount0,input.decimals0,"1"):rounded(input.amount0*priceSquared*USD_SCALE,q192*pow10(input.decimals1));
  const usd1=oneUsd?rawUsdMicros(input.amount1,input.decimals1,"1"):rounded(input.amount1*q192*USD_SCALE,priceSquared*pow10(input.decimals0));
  return {status:"AVAILABLE" as const,token0UsdMicros:usd0,token1UsdMicros:usd1,totalUsdMicros:usd0+usd1,evidence:{contract:"DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V1",sqrtPriceX96:input.sqrtPriceX96.toString(),token0:input.token0,token1:input.token1,decimals0:input.decimals0,decimals1:input.decimals1,token0Raw:input.amount0.toString(),token1Raw:input.amount1.toString(),token0Usd:usdMicrosToText(usd0),token1Usd:usdMicrosToText(usd1)}};
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
