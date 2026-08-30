import { createHash } from "node:crypto";
import {
  decodeEventLog,
  getAddress,
  parseAbiItem,
  toHex,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import type { FallbackRpc } from "@funi/core";
import type { SqliteLedgerRepository } from "@funi/ledger";
import {
  amountsForLiquidity,
  decodeV4BatchFullDecrease,
  inspectV4Pool,
  V4_ROBINHOOD_DEPLOYMENTS,
  type V4PoolKey,
} from "@funi/v4";
import { valueV4ReturnsFromSqrtPriceX96 } from "./v4-realized-accounting.js";

const CHAIN_ID = 4663;
const MAX_EXTERNAL_CLOSE_LOG_SPAN = 100_000n;
const ACTION_MSG_SENDER = "0x0000000000000000000000000000000000000001";
const modifyLiquidityEvent = parseAbiItem(
  "event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)",
);
const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
);
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from,address indexed to,uint256 value)",
);

const same = (a: unknown, b: unknown) =>
  String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const json = (value: unknown) =>
  JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
const fingerprint = (value: unknown) =>
  createHash("sha256").update(json(value)).digest("hex");

export type ExternalCloseLegEvidence = {
  legIndex: number;
  tokenId: string;
  transactionHash: Hash;
  blockNumber: bigint;
  blockHash: Hash;
  transactionIndex: number | null;
  logIndex: number;
  nonce: number;
  sender: Address;
  target: Address;
  liquidityRemovedRaw: bigint;
  token0Raw: bigint;
  token1Raw: bigint;
  gasNativeRaw: bigint;
  nftTerminalState: "OWNED_ZERO" | "BURNED_ZERO";
  principal0Raw: bigint | null;
  principal1Raw: bigint | null;
  returnUsdMicros: bigint | null;
  valuation: Record<string, unknown>;
  identityEvidence: Record<string, unknown>;
};

export type ExternalFollowOnSwapEvidence = {
  transactionHash: Hash;
  blockNumber: bigint;
  blockHash: Hash;
  transactionIndex: number | null;
  nonce: number;
  sender: Address;
  target: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmountRaw: bigint;
  buyAmountRaw: bigint;
  gasNativeRaw: bigint;
  receiptStatus: "success" | "reverted";
  interveningWalletTransactions: number;
  relatedApproval?: {
    nonce: number;
    sender: Address;
    token: Address;
    spender: Address;
    amountRaw: bigint;
    receiptStatus: "success" | "reverted";
  };
};

export function classifyExternalFollowOnSwap(input: {
  wallet: Address;
  lastCloseNonce: number;
  closeToken0: Address;
  closeToken1: Address;
  aggregateToken0Raw: bigint;
  aggregateToken1Raw: bigint;
  evidence?: ExternalFollowOnSwapEvidence;
}) {
  const value = input.evidence;
  if (!value)
    return {
      status: "UNATTRIBUTED_OR_AMBIGUOUS" as const,
      reason: "FOLLOW_ON_NONCE_INDEX_EVIDENCE_UNAVAILABLE",
    };
  const approval = value.relatedApproval,
    expectedSwapNonce = input.lastCloseNonce + (approval ? 2 : 1),
    approvalValid =
      !approval ||
      (approval.receiptStatus === "success" &&
        approval.nonce === input.lastCloseNonce + 1 &&
        same(approval.sender, input.wallet) &&
        same(approval.token, value.sellToken) &&
        (same(approval.spender, V4_ROBINHOOD_DEPLOYMENTS.permit2) ||
          same(approval.spender, V4_ROBINHOOD_DEPLOYMENTS.universalRouter)) &&
        approval.amountRaw >= value.sellAmountRaw);
  if (
    value.receiptStatus !== "success" ||
    !same(value.sender, input.wallet) ||
    value.nonce !== expectedSwapNonce ||
    value.interveningWalletTransactions !== 0 ||
    !same(value.target, V4_ROBINHOOD_DEPLOYMENTS.universalRouter) ||
    !approvalValid
  )
    return {
      status: "UNATTRIBUTED_OR_AMBIGUOUS" as const,
      reason: "FOLLOW_ON_CAUSAL_IDENTITY_UNPROVEN",
    };
  const available = same(value.sellToken, input.closeToken0)
    ? input.aggregateToken0Raw
    : same(value.sellToken, input.closeToken1)
      ? input.aggregateToken1Raw
      : null;
  const other = same(value.sellToken, input.closeToken0)
    ? input.closeToken1
    : input.closeToken0;
  if (
    available === null ||
    !same(value.buyToken, other) ||
    value.sellAmountRaw <= 0n ||
    value.sellAmountRaw > available ||
    value.buyAmountRaw <= 0n
  )
    return {
      status: "UNATTRIBUTED_OR_AMBIGUOUS" as const,
      reason: "FOLLOW_ON_SETTLEMENT_FLOW_UNPROVEN",
    };
  return { status: "ATTRIBUTED" as const, evidence: value };
}

export type ExternalV4MutationEvidence = {
  ladderId: string;
  wallet: Address;
  currency0: Address;
  currency1: Address;
  observedThroughBlock: bigint;
  legs: ExternalCloseLegEvidence[];
  followOn:
    | { status: "PROVEN_NONE" }
    | { status: "ATTRIBUTED"; evidence: ExternalFollowOnSwapEvidence }
    | { status: "UNATTRIBUTED_OR_AMBIGUOUS"; reason: string };
};

function completenessRank(value: string) {
  return value === "FULL" ? 3 : value === "PARTIAL" ? 2 : 1;
}

/** Pure durable projection. The evidence is already receipt- and identity-
 * validated by the collector. It never creates a Robin transaction journal. */
export function persistExternalV4MutationEvidence(
  repo: SqliteLedgerRepository,
  evidence: ExternalV4MutationEvidence,
  nowMs = Date.now(),
) {
  const parent = repo.loadBidLadder(evidence.ladderId),
    expected = repo.listBidLadderLegs(evidence.ladderId);
  if (!parent || expected.length !== 5 || expected.some((leg) => !leg.token_id))
    throw new Error("EXTERNAL_V4_LADDER_IDENTITY_INCOMPLETE");
  if (
    !same(parent.currency0, evidence.currency0) ||
    !same(parent.currency1, evidence.currency1) ||
    parent.close_provenance === "FUNI_EXECUTED" ||
    parent.terminal_provenance === "FUNI_AUTHORED_CLOSE_BATCH" ||
    repo.db
      .prepare(
        "SELECT 1 FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='CLOSE_BATCH' AND status='CONFIRMED' LIMIT 1",
      )
      .get(CHAIN_ID, evidence.ladderId)
  )
    throw new Error("EXTERNAL_V4_PROVENANCE_CONFLICT");

  const expectedByToken = new Map(
      expected.map((leg) => [String(leg.token_id), leg]),
    ),
    seen = new Set<string>(),
    validLegs = [...evidence.legs].sort((a, b) => a.legIndex - b.legIndex);
  for (const leg of validLegs) {
    const durable = expectedByToken.get(leg.tokenId);
    if (
      !durable ||
      seen.has(leg.tokenId) ||
      Number(durable.leg_index) !== leg.legIndex ||
      leg.liquidityRemovedRaw !== BigInt(String(durable.planned_liquidity_raw)) ||
      leg.token0Raw < 0n ||
      leg.token1Raw < 0n ||
      leg.gasNativeRaw < 0n ||
      !same(leg.sender, evidence.wallet) ||
      !same(leg.target, V4_ROBINHOOD_DEPLOYMENTS.positionManager) ||
      leg.identityEvidence.receiptHashMatches !== true ||
      leg.identityEvidence.exactTokenId !== true ||
      leg.identityEvidence.exactLiquidityRemoved !== true ||
      leg.identityEvidence.poolManagerTransfers !== true
    )
      throw new Error("EXTERNAL_V4_LEG_EVIDENCE_MISMATCH");
    seen.add(leg.tokenId);
  }

  const allLegs = validLegs.length === expected.length,
    aggregate0 = validLegs.reduce((sum, leg) => sum + leg.token0Raw, 0n),
    aggregate1 = validLegs.reduce((sum, leg) => sum + leg.token1Raw, 0n),
    aggregateGas = validLegs.reduce((sum, leg) => sum + leg.gasNativeRaw, 0n),
    decomposition =
      allLegs &&
      validLegs.every(
        (leg) => leg.principal0Raw !== null && leg.principal1Raw !== null,
      ),
    principal0 = decomposition
      ? validLegs.reduce((sum, leg) => sum + leg.principal0Raw!, 0n)
      : null,
    principal1 = decomposition
      ? validLegs.reduce((sum, leg) => sum + leg.principal1Raw!, 0n)
      : null,
    rawInvariant =
      principal0 !== null &&
      principal1 !== null &&
      aggregate0 >= principal0 &&
      aggregate1 >= principal1,
    valuationComplete =
      allLegs && validLegs.every((leg) => leg.returnUsdMicros !== null),
    returnUsdMicros = valuationComplete
      ? validLegs.reduce((sum, leg) => sum + leg.returnUsdMicros!, 0n)
      : null,
    followOnKnown = evidence.followOn.status !== "UNATTRIBUTED_OR_AMBIGUOUS",
    reasons = [
      ...(!allLegs ? ["EXTERNAL_CLOSE_LEG_EVIDENCE_INCOMPLETE"] : []),
      ...(allLegs && !rawInvariant
        ? ["FEE_PRINCIPAL_DECOMPOSITION_UNPROVEN"]
        : []),
      ...(allLegs && !valuationComplete
        ? ["BLOCK_BOUND_USD_VALUATION_INCOMPLETE"]
        : []),
      ...(evidence.followOn.status === "UNATTRIBUTED_OR_AMBIGUOUS"
        ? [evidence.followOn.reason]
        : []),
    ],
    accountingCompleteness = !allLegs
      ? "INCOMPLETE"
      : rawInvariant && valuationComplete && followOnKnown
        ? "FULL"
        : "PARTIAL",
    durableEvidence = {
      contract: "EXTERNAL_ONCHAIN_MUTATION_V1",
      wallet: evidence.wallet,
      currency0: evidence.currency0,
      currency1: evidence.currency1,
      observedThroughBlock: evidence.observedThroughBlock,
      legs: validLegs,
      followOn: evidence.followOn,
      rawInvariant,
    },
    evidenceFingerprint = fingerprint(durableEvidence),
    existing = repo.db
      .prepare("SELECT * FROM v4_external_close_settlements WHERE ladder_id=?")
      .get(evidence.ladderId) as Record<string, unknown> | undefined;
  if (existing?.evidence_fingerprint === evidenceFingerprint)
    return {
      status: "ALREADY_RECONCILED" as const,
      accountingCompleteness: String(existing.accounting_completeness),
      writes: 0,
    };
  if (
    existing &&
    completenessRank(String(existing.accounting_completeness)) >
      completenessRank(accountingCompleteness)
  )
    throw new Error("EXTERNAL_V4_ACCOUNTING_EVIDENCE_REGRESSION");

  return repo.db.transaction(() => {
    repo.db
      .prepare(
        `INSERT INTO v4_external_close_settlements(
          ladder_id,chain_id,provenance,accounting_completeness,
          aggregate_token0_raw,aggregate_token1_raw,aggregate_gas_native_raw,
          principal0_raw,principal1_raw,fee0_raw,fee1_raw,return_usd_micros,
          first_close_block,last_close_block,observed_through_block,
          follow_on_swap_status,reason_codes_json,evidence_json,evidence_fingerprint,
          created_at_ms,updated_at_ms
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(ladder_id) DO UPDATE SET
          accounting_completeness=excluded.accounting_completeness,
          aggregate_token0_raw=excluded.aggregate_token0_raw,
          aggregate_token1_raw=excluded.aggregate_token1_raw,
          aggregate_gas_native_raw=excluded.aggregate_gas_native_raw,
          principal0_raw=excluded.principal0_raw,principal1_raw=excluded.principal1_raw,
          fee0_raw=excluded.fee0_raw,fee1_raw=excluded.fee1_raw,
          return_usd_micros=excluded.return_usd_micros,
          first_close_block=excluded.first_close_block,last_close_block=excluded.last_close_block,
          observed_through_block=excluded.observed_through_block,
          follow_on_swap_status=excluded.follow_on_swap_status,
          reason_codes_json=excluded.reason_codes_json,evidence_json=excluded.evidence_json,
          evidence_fingerprint=excluded.evidence_fingerprint,updated_at_ms=excluded.updated_at_ms`,
      )
      .run(
        evidence.ladderId,
        CHAIN_ID,
        "EXTERNAL_ONCHAIN_MUTATION",
        accountingCompleteness,
        allLegs ? aggregate0.toString() : null,
        allLegs ? aggregate1.toString() : null,
        allLegs ? aggregateGas.toString() : null,
        rawInvariant ? principal0!.toString() : null,
        rawInvariant ? principal1!.toString() : null,
        rawInvariant ? (aggregate0 - principal0!).toString() : null,
        rawInvariant ? (aggregate1 - principal1!).toString() : null,
        returnUsdMicros?.toString() ?? null,
        validLegs.length ? validLegs[0]!.blockNumber.toString() : null,
        validLegs.length ? validLegs.at(-1)!.blockNumber.toString() : null,
        evidence.observedThroughBlock.toString(),
        evidence.followOn.status,
        json(reasons),
        json(durableEvidence),
        evidenceFingerprint,
        existing?.created_at_ms ?? nowMs,
        nowMs,
      );
    for (const leg of validLegs) {
      const durable = json(leg.identityEvidence), valuation = json(leg.valuation);
      repo.db
        .prepare(
          `INSERT OR IGNORE INTO v4_external_close_transactions(
            ladder_id,transaction_hash,evidence_kind,leg_index,token_id,
            block_number,block_hash,transaction_index,nonce,sender,target,
            token0_raw,token1_raw,gas_native_raw,liquidity_removed_raw,
            nft_terminal_state,valuation_json,evidence_json,created_at_ms
          ) VALUES(?,?,'EXTERNAL_V4_DECREASE_TAKE_PAIR',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          evidence.ladderId,
          leg.transactionHash.toLowerCase(),
          leg.legIndex,
          leg.tokenId,
          leg.blockNumber.toString(),
          leg.blockHash.toLowerCase(),
          leg.transactionIndex,
          leg.nonce,
          leg.sender.toLowerCase(),
          leg.target.toLowerCase(),
          leg.token0Raw.toString(),
          leg.token1Raw.toString(),
          leg.gasNativeRaw.toString(),
          leg.liquidityRemovedRaw.toString(),
          leg.nftTerminalState,
          valuation,
          durable,
          nowMs,
        );
    }
    if (allLegs) {
      for (const leg of validLegs) {
        repo.db
          .prepare("UPDATE positions SET status='closed' WHERE id=?")
          .run(`v4:${leg.tokenId}`);
        repo.db
          .prepare(
            "UPDATE v4_positions SET status='closed',liquidity_raw='0',updated_at=? WHERE token_id=?",
          )
          .run(new Date(nowMs).toISOString(), leg.tokenId);
        repo.db
          .prepare(
            "UPDATE v4_bid_ladder_legs SET status='CLOSED',updated_at_ms=? WHERE ladder_id=? AND leg_index=?",
          )
          .run(nowMs, evidence.ladderId, leg.legIndex);
      }
      repo.db
        .prepare(
          `UPDATE v4_bid_ladders SET status='CLOSED',
             close_provenance=CASE WHEN close_provenance='FUNI_EXECUTED' THEN close_provenance ELSE 'UNKNOWN_EXTERNAL' END,
             terminal_provenance='EXTERNAL_ONCHAIN_MUTATION',updated_at_ms=?,revision=revision+1
           WHERE ladder_id=? AND terminal_provenance IS NOT 'EXTERNAL_ONCHAIN_MUTATION'`,
        )
        .run(nowMs, evidence.ladderId);
    }
    return {
      status: "RECONCILED" as const,
      accountingCompleteness,
      reasonCodes: reasons,
      legCount: validLegs.length,
      writes: 1 + validLegs.length,
    };
  })();
}

function receiptTransfers(
  receipt: TransactionReceipt,
  wallet: Address,
  currency0: Address,
  currency1: Address,
) {
  let token0 = 0n, token1 = 0n;
  for (const log of receipt.logs) {
    const index = same(log.address, currency0)
      ? 0
      : same(log.address, currency1)
        ? 1
        : -1;
    if (index < 0) continue;
    try {
      const decoded = decodeEventLog({
        abi: [transferEvent],
        data: log.data,
        topics: log.topics,
      });
      if (
        decoded.eventName === "Transfer" &&
        same(decoded.args.from, V4_ROBINHOOD_DEPLOYMENTS.poolManager) &&
        same(decoded.args.to, wallet)
      ) {
        if (index === 0) token0 += decoded.args.value;
        else token1 += decoded.args.value;
      }
    } catch {
      // Unrelated token log.
    }
  }
  return { token0, token1 };
}

function terminalState(repo: SqliteLedgerRepository, tokenId: string) {
  const row = repo.db
    .prepare(
      "SELECT owner_status,liquidity_raw,terminal_reason,last_error FROM active_position_reconciliations WHERE position_id=?",
    )
    .get(`v4:${tokenId}`) as Record<string, unknown> | undefined;
  if (
    row?.owner_status === "VERIFIED_OWNED" &&
    row.liquidity_raw === "0" &&
    row.terminal_reason === "CLOSED_EMPTY" &&
    !row.last_error
  )
    return "OWNED_ZERO" as const;
  if (
    row?.owner_status === "NONEXISTENT" &&
    row.liquidity_raw === "0" &&
    row.terminal_reason === "BURNED" &&
    !row.last_error
  )
    return "BURNED_ZERO" as const;
  return undefined;
}

export async function collectExternalV4MutationEvidence(input: {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  logsRpc?: FallbackRpc;
  ladderId: string;
}) {
  const parent = input.repo.loadBidLadder(input.ladderId),
    expected = input.repo.listBidLadderLegs(input.ladderId);
  if (!parent || expected.length !== 5 || expected.some((leg) => !leg.token_id))
    throw new Error("EXTERNAL_V4_LADDER_IDENTITY_INCOMPLETE");
  const positions = expected.map((leg) => {
      const position = input.repo.v4Position(String(leg.token_id));
      if (!position) throw new Error("EXTERNAL_V4_POSITION_IDENTITY_MISSING");
      return { leg, position };
    }),
    wallets = new Set(positions.map(({ position }) => getAddress(String(position.owner))));
  if (wallets.size !== 1) throw new Error("EXTERNAL_V4_WALLET_IDENTITY_MISMATCH");
  const wallet = [...wallets][0]!,
    key = JSON.parse(String(positions[0]!.position.pool_key_json)) as V4PoolKey,
    open = input.repo.db
      .prepare(
        "SELECT receipt_json FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND semantic_stage='OPEN_BATCH' AND status='CONFIRMED' ORDER BY attempt DESC LIMIT 1",
      )
      .get(CHAIN_ID, input.ladderId) as { receipt_json: string } | undefined;
  if (!open) throw new Error("EXTERNAL_V4_OPEN_RECEIPT_MISSING");
  const openBlock = BigInt(String(JSON.parse(open.receipt_json).blockNumber)),
    latest = await input.rpc.withClient((client) =>
      client.getBlockNumber({ cacheTime: 0 }),
    );
  if (latest < openBlock || latest - openBlock > MAX_EXTERNAL_CLOSE_LOG_SPAN)
    throw new Error("EXTERNAL_V4_LOG_RANGE_OUTSIDE_BOUND");
  const logs = await (input.logsRpc ?? input.rpc).withClient(
      (client) =>
        client.getLogs({
          address: V4_ROBINHOOD_DEPLOYMENTS.poolManager,
          event: modifyLiquidityEvent,
          args: { id: String(parent.pool_id) as Hex },
          fromBlock: openBlock,
          toBlock: latest,
        }),
      { stage: "external_v4_close", method: "PoolManager.ModifyLiquidity" },
    ),
    bySalt = new Map(
      positions.map(({ leg }) => [
        toHex(BigInt(String(leg.token_id)), { size: 32 }).toLowerCase(),
        leg,
      ]),
    ),
    candidates = logs.filter(
      (log) =>
        log.args.liquidityDelta !== undefined &&
        log.args.liquidityDelta < 0n &&
        same(log.args.sender, V4_ROBINHOOD_DEPLOYMENTS.positionManager) &&
        bySalt.has(String(log.args.salt).toLowerCase()),
    ),
    uniqueHashes = [...new Set(candidates.map((log) => log.transactionHash!))];
  const chain = await input.rpc.withClient((client) =>
    Promise.all(
      uniqueHashes.map(async (hash) => ({
        transaction: await client.getTransaction({ hash }),
        receipt: await client.getTransactionReceipt({ hash }),
      })),
    ),
  );
  const txByHash = new Map(
      chain.map((item) => [item.transaction.hash.toLowerCase(), item]),
    ),
    token0 = getAddress(String(parent.currency0)),
    token1 = getAddress(String(parent.currency1)),
    decimals0 = input.repo.tokenMetadata(token0)?.decimals,
    decimals1 = input.repo.tokenMetadata(token1)?.decimals,
    legEvidence: ExternalCloseLegEvidence[] = [];
  for (const log of candidates) {
    const durableLeg = bySalt.get(String(log.args.salt).toLowerCase())!,
      item = txByHash.get(log.transactionHash!.toLowerCase());
    if (!item || item.receipt.status !== "success") continue;
    const transaction = item.transaction, receipt = item.receipt;
    if (
      !same(transaction.from, wallet) ||
      !same(transaction.to, V4_ROBINHOOD_DEPLOYMENTS.positionManager) ||
      transaction.value !== 0n ||
      !same(receipt.from, wallet) ||
      !same(receipt.to, V4_ROBINHOOD_DEPLOYMENTS.positionManager) ||
      !same(receipt.transactionHash, transaction.hash)
    )
      continue;
    let decoded;
    try {
      decoded = decodeV4BatchFullDecrease(transaction.input);
    } catch {
      continue;
    }
    if (
      decoded.legs.length !== 1 ||
      decoded.legs[0]!.tokenId.toString() !== String(durableLeg.token_id) ||
      decoded.legs[0]!.liquidity !== BigInt(String(durableLeg.planned_liquidity_raw)) ||
      !same(decoded.take[0], token0) ||
      !same(decoded.take[1], token1) ||
      (!same(decoded.take[2], wallet) && !same(decoded.take[2], ACTION_MSG_SENDER))
    )
      continue;
    const nftTerminalState = terminalState(input.repo, String(durableLeg.token_id));
    if (!nftTerminalState) continue;
    const transfers = receiptTransfers(receipt, wallet, token0, token1),
      laterSwaps = await input.rpc.withClient((client) =>
        client.getLogs({
          address: V4_ROBINHOOD_DEPLOYMENTS.poolManager,
          event: swapEvent,
          args: { id: String(parent.pool_id) as Hex },
          fromBlock: receipt.blockNumber,
          toBlock: receipt.blockNumber,
        }),
      ),
      laterSwapCount = laterSwaps.filter(
        (entry) =>
          entry.transactionIndex === null ||
          receipt.transactionIndex === null ||
          Number(entry.transactionIndex) > Number(receipt.transactionIndex),
      ).length;
    let principal0Raw: bigint | null = null,
      principal1Raw: bigint | null = null,
      returnUsdMicros: bigint | null = null,
      valuation: Record<string, unknown> = {
        status: "INCOMPLETE",
        reason: "HISTORICAL_POOL_STATE_UNAVAILABLE",
        blockNumber: receipt.blockNumber.toString(),
      };
    if (laterSwapCount === 0) {
      const historical = await inspectV4Pool(input.rpc, key, receipt.blockNumber);
      if (historical.status === "available") {
        const principal = amountsForLiquidity(
          historical.value.sqrtPriceX96,
          Number(durableLeg.tick_lower),
          Number(durableLeg.tick_upper),
          BigInt(String(durableLeg.planned_liquidity_raw)),
        );
        if (
          transfers.token0 >= principal.token0 &&
          transfers.token1 >= principal.token1
        ) {
          principal0Raw = principal.token0;
          principal1Raw = principal.token1;
        }
        if (typeof decimals0 === "number" && typeof decimals1 === "number") {
          const valued = valueV4ReturnsFromSqrtPriceX96({
            token0,
            token1,
            decimals0,
            decimals1,
            amount0: transfers.token0,
            amount1: transfers.token1,
            sqrtPriceX96: historical.value.sqrtPriceX96,
            source: {
              poolId: historical.value.id,
              poolKey: historical.value.key,
              sqrtPriceX96: historical.value.sqrtPriceX96,
              tick: historical.value.tick,
              activeLiquidity: historical.value.liquidity,
              initialized: historical.value.initialized,
              blockNumber: historical.value.blockNumber,
              token0Decimals: decimals0,
              token1Decimals: decimals1,
            },
          });
          if (valued.status === "AVAILABLE") returnUsdMicros = valued.totalUsdMicros;
          valuation = {
            ...valued,
            blockNumber: receipt.blockNumber.toString(),
            sameBlockLaterPoolSwaps: 0,
          };
        }
      }
    } else {
      valuation = {
        status: "INCOMPLETE",
        reason: "SAME_BLOCK_LATER_POOL_SWAP",
        blockNumber: receipt.blockNumber.toString(),
        sameBlockLaterPoolSwaps: laterSwapCount,
      };
    }
    legEvidence.push({
      legIndex: Number(durableLeg.leg_index),
      tokenId: String(durableLeg.token_id),
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash!,
      transactionIndex:
        receipt.transactionIndex === null ? null : Number(receipt.transactionIndex),
      logIndex: Number(log.logIndex),
      nonce: transaction.nonce,
      sender: getAddress(transaction.from),
      target: getAddress(transaction.to!),
      liquidityRemovedRaw: -log.args.liquidityDelta!,
      token0Raw: transfers.token0,
      token1Raw: transfers.token1,
      gasNativeRaw: receipt.gasUsed * receipt.effectiveGasPrice,
      nftTerminalState,
      principal0Raw,
      principal1Raw,
      returnUsdMicros,
      valuation,
      identityEvidence: {
        source: "RECEIPT_DECREASE_LIQUIDITY_TAKE_PAIR",
        recipientSemantics: same(decoded.take[2], ACTION_MSG_SENDER)
          ? "ACTION_MSG_SENDER_BOUND_TO_TRANSACTION_SENDER"
          : "EXPLICIT_WALLET_RECIPIENT",
        receiptStatus: receipt.status,
        receiptHashMatches: true,
        exactTokenId: true,
        exactLiquidityRemoved: true,
        poolManagerTransfers: true,
      },
    });
  }
  legEvidence.sort(
    (a, b) =>
      Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
  );
  return {
    ladderId: input.ladderId,
    wallet,
    currency0: token0,
    currency1: token1,
    observedThroughBlock: latest,
    legs: legEvidence,
    followOn: {
      status: "UNATTRIBUTED_OR_AMBIGUOUS" as const,
      reason: "FOLLOW_ON_NONCE_INDEX_EVIDENCE_UNAVAILABLE",
    },
  } satisfies ExternalV4MutationEvidence;
}

export function externalV4MutationCandidates(
  repo: SqliteLedgerRepository,
  limit = 2,
) {
  return repo.db
    .prepare(
      `SELECT l.ladder_id FROM v4_bid_ladders l
       WHERE l.execution_mode='LIVE'
         AND l.status='CLOSED'
         AND COALESCE(l.terminal_provenance,
           CASE WHEN l.close_provenance IN ('EXTERNAL_OPERATOR_CLOSE','UNKNOWN_EXTERNAL')
             THEN 'EXTERNAL_ONCHAIN_MUTATION' END)='EXTERNAL_ONCHAIN_MUTATION'
         AND NOT EXISTS(SELECT 1 FROM v4_external_close_settlements s WHERE s.ladder_id=l.ladder_id)
       ORDER BY l.updated_at_ms DESC,l.ladder_id DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(8, limit))) as Array<{ ladder_id: string }>;
}

export async function reconcileExternalV4MutationCycle(input: {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  logsRpc?: FallbackRpc;
  limit?: number;
  nowMs?: number;
}) {
  const candidates = externalV4MutationCandidates(input.repo, input.limit),
    results: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    try {
      const evidence = await collectExternalV4MutationEvidence({
          repo: input.repo,
          rpc: input.rpc,
          logsRpc: input.logsRpc,
          ladderId: candidate.ladder_id,
        }),
        result = persistExternalV4MutationEvidence(
          input.repo,
          evidence,
          input.nowMs,
        );
      results.push({ ladderId: candidate.ladder_id, ...result });
    } catch (error) {
      results.push({
        ladderId: candidate.ladder_id,
        status: "INCOMPLETE",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    scanned: candidates.length,
    results,
    signingAttempts: 0 as const,
    broadcasts: 0 as const,
    mainnetTransactionsSent: 0 as const,
  };
}
