import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAddress, type Address, type Hash } from "viem";
import { robinhoodMainnet } from "@funi/core";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import {
  poolId,
  sqrtPriceAtTick,
  V4_ROBINHOOD_DEPLOYMENTS,
} from "@funi/v4";
import {
  createV4BidLadderDryRun,
  previewV4BidLadder,
} from "../apps/cli/src/v4-bid-ladder-operator.js";
import {
  classifyExternalFollowOnSwap,
  persistExternalV4MutationEvidence,
  type ExternalCloseLegEvidence,
  type ExternalV4MutationEvidence,
} from "../apps/cli/src/external-v4-mutation-reconciliation.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const token0 = getAddress("0x0000000000000000000000000000000000000010"),
  token1 = robinhoodMainnet.assets.USDG,
  wallet = getAddress("0x0000000000000000000000000000000000000020"),
  key = {
    currency0: token0,
    currency1: token1,
    fee: 3_000,
    tickSpacing: 10,
    hooks: getAddress("0x0000000000000000000000000000000000000000"),
  } as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "external-v4-close-"));
  roots.push(root);
  const path = join(root, "db.sqlite");
  migrateSqlite(path, "infra/migrations");
  const repo = new SqliteLedgerRepository(path),
    pool = {
      id: poolId(key),
      key,
      sqrtPriceX96: sqrtPriceAtTick(0),
      tick: 0,
      liquidity: 10n ** 18n,
      initialized: true,
      blockNumber: 1n,
    },
    preview = previewV4BidLadder({
      pool,
      funding: { address: token1, symbol: "USDG", decimals: 6 },
      target: { address: token0, symbol: "TOKEN", decimals: 18 },
      totalFundingAmount: 10_000_000n,
      owner: wallet,
      deadline: 9_999n,
      nowMs: 1_000,
    });
  repo.upsertTokenMetadata({ address: token0, symbol: "TOKEN", name: "Token", decimals: 18 });
  repo.upsertTokenMetadata({ address: token1, symbol: "USDG", name: "USDG", decimals: 6 });
  createV4BidLadderDryRun(repo, preview);
  repo.db.prepare("UPDATE v4_bid_ladders SET execution_mode='LIVE',status='OPEN' WHERE ladder_id=?").run(preview.plan.ladderId);
  for (let index = 0; index < 5; index++) {
    const tokenId = String(500 + index), leg = repo.listBidLadderLegs(preview.plan.ladderId)[index]!;
    repo.db.prepare("UPDATE v4_bid_ladder_legs SET status='OPEN',token_id=? WHERE ladder_id=? AND leg_index=?").run(tokenId, preview.plan.ladderId, index);
    repo.ensurePosition(`v4:${tokenId}`, tokenId, pool.id);
    repo.upsertV4Position({
      tokenId: BigInt(tokenId), owner: wallet, poolId: pool.id, poolKey: key,
      currency0: token0, currency1: token1, fee: key.fee,
      tickSpacing: key.tickSpacing, hooks: key.hooks,
      tickLower: Number(leg.tick_lower), tickUpper: Number(leg.tick_upper),
      liquidity: 0n, initialAmount0: 0n, initialAmount1: BigInt(String(leg.funding_amount_raw)),
      mintHash: `0x${String(index + 1).padStart(64, "0")}` as Hash,
      status: "closed", openIntentId: preview.plan.ladderId,
    });
  }
  return { repo, ladderId: preview.plan.ladderId };
}

function legs(repo: SqliteLedgerRepository, ladderId: string, burned = false): ExternalCloseLegEvidence[] {
  return repo.listBidLadderLegs(ladderId).map((leg, index) => ({
    legIndex: index,
    tokenId: String(leg.token_id),
    transactionHash: `0x${String(index + 11).padStart(64, "0")}` as Hash,
    blockNumber: 100n + BigInt(index),
    blockHash: `0x${String(index + 21).padStart(64, "0")}` as Hash,
    transactionIndex: index,
    logIndex: index,
    nonce: 40 + index,
    sender: wallet,
    target: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
    liquidityRemovedRaw: BigInt(String(leg.planned_liquidity_raw)),
    token0Raw: 100n + BigInt(index),
    token1Raw: 200n + BigInt(index),
    gasNativeRaw: 10n,
    nftTerminalState: burned ? "BURNED_ZERO" : "OWNED_ZERO",
    principal0Raw: 90n + BigInt(index),
    principal1Raw: 190n + BigInt(index),
    returnUsdMicros: 1_000_000n + BigInt(index),
    valuation: { status: "AVAILABLE", block: String(100 + index) },
    identityEvidence: {
      receiptHashMatches: true,
      exactTokenId: true,
      exactLiquidityRemoved: true,
      poolManagerTransfers: true,
    },
  }));
}

function evidence(repo: SqliteLedgerRepository, ladderId: string, options: { count?: number; burned?: boolean; followOn?: ExternalV4MutationEvidence["followOn"] } = {}): ExternalV4MutationEvidence {
  return {
    ladderId,
    wallet,
    currency0: token0,
    currency1: token1,
    observedThroughBlock: 200n,
    legs: legs(repo, ladderId, options.burned).slice(0, options.count ?? 5),
    followOn: options.followOn ?? { status: "PROVEN_NONE" },
  };
}

describe("external V4 mutation reconciliation", () => {
  it("keeps one-of-five external mutation open and terminalizes five-of-five with permanent external provenance", () => {
    const f = fixture();
    try {
      expect(persistExternalV4MutationEvidence(f.repo, evidence(f.repo, f.ladderId, { count: 1 }), 2_000)).toMatchObject({ accountingCompleteness: "INCOMPLETE", legCount: 1 });
      expect(f.repo.loadBidLadder(f.ladderId)).toMatchObject({ status: "OPEN", terminal_provenance: null });
      expect(persistExternalV4MutationEvidence(f.repo, evidence(f.repo, f.ladderId), 3_000)).toMatchObject({ accountingCompleteness: "FULL", legCount: 5 });
      expect(f.repo.loadBidLadder(f.ladderId)).toMatchObject({ status: "CLOSED", close_provenance: "UNKNOWN_EXTERNAL", terminal_provenance: "EXTERNAL_ONCHAIN_MUTATION" });
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM v4_external_close_transactions WHERE ladder_id=?").get(f.ladderId)).toEqual({ count: 5 });
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal WHERE workflow_identity=? AND semantic_stage='CLOSE_BATCH'").get(f.ladderId)).toEqual({ count: 0 });
    } finally { f.repo.close(); }
  });

  it("supports retained and burned zero-liquidity NFT truth without provenance laundering", () => {
    for (const burned of [false, true]) {
      const f = fixture();
      try {
        persistExternalV4MutationEvidence(f.repo, evidence(f.repo, f.ladderId, { burned }));
        expect(f.repo.db.prepare("SELECT DISTINCT nft_terminal_state state FROM v4_external_close_transactions WHERE ladder_id=?").all(f.ladderId)).toEqual([{ state: burned ? "BURNED_ZERO" : "OWNED_ZERO" }]);
        expect(f.repo.loadBidLadder(f.ladderId)?.terminal_provenance).toBe("EXTERNAL_ONCHAIN_MUTATION");
      } finally { f.repo.close(); }
    }
  });

  it("uses FULL/PARTIAL/INCOMPLETE truth and never guesses missing attribution", () => {
    const full = fixture(), partial = fixture(), incomplete = fixture();
    try {
      expect(persistExternalV4MutationEvidence(full.repo, evidence(full.repo, full.ladderId))).toMatchObject({ accountingCompleteness: "FULL" });
      expect(persistExternalV4MutationEvidence(partial.repo, evidence(partial.repo, partial.ladderId, { followOn: { status: "UNATTRIBUTED_OR_AMBIGUOUS", reason: "UNRELATED_WALLET_TRANSACTION" } }))).toMatchObject({ accountingCompleteness: "PARTIAL", reasonCodes: expect.arrayContaining(["UNRELATED_WALLET_TRANSACTION"]) });
      expect(persistExternalV4MutationEvidence(incomplete.repo, evidence(incomplete.repo, incomplete.ladderId, { count: 4 }))).toMatchObject({ accountingCompleteness: "INCOMPLETE" });
    } finally { full.repo.close(); partial.repo.close(); incomplete.repo.close(); }
  });

  it("attributes only causally adjacent exact wallet settlement swaps, including a related approval", () => {
    const base = {
      wallet,
      lastCloseNonce: 10,
      closeToken0: token0,
      closeToken1: token1,
      aggregateToken0Raw: 1_000n,
      aggregateToken1Raw: 2_000n,
    },
      swap = {
        transactionHash: `0x${"44".repeat(32)}` as Hash,
        blockNumber: 20n,
        blockHash: `0x${"55".repeat(32)}` as Hash,
        transactionIndex: 0,
        nonce: 12,
        sender: wallet,
        target: V4_ROBINHOOD_DEPLOYMENTS.universalRouter,
        sellToken: token0,
        buyToken: token1,
        sellAmountRaw: 900n,
        buyAmountRaw: 800n,
        gasNativeRaw: 1n,
        receiptStatus: "success" as const,
        interveningWalletTransactions: 0,
        relatedApproval: {
          nonce: 11,
          sender: wallet,
          token: token0,
          spender: V4_ROBINHOOD_DEPLOYMENTS.permit2,
          amountRaw: 900n,
          receiptStatus: "success" as const,
        },
      };
    expect(classifyExternalFollowOnSwap({ ...base, evidence: swap })).toMatchObject({ status: "ATTRIBUTED" });
    expect(classifyExternalFollowOnSwap({ ...base, evidence: { ...swap, interveningWalletTransactions: 1 } })).toMatchObject({ status: "UNATTRIBUTED_OR_AMBIGUOUS" });
    expect(classifyExternalFollowOnSwap({ ...base, evidence: { ...swap, sellAmountRaw: 1_001n } })).toMatchObject({ status: "UNATTRIBUTED_OR_AMBIGUOUS" });
  });

  it("replays idempotently and cannot duplicate economic contribution", () => {
    const f = fixture();
    try {
      const proof = evidence(f.repo, f.ladderId, { followOn: { status: "UNATTRIBUTED_OR_AMBIGUOUS", reason: "FOLLOW_ON_UNPROVEN" } });
      expect(persistExternalV4MutationEvidence(f.repo, proof)).toMatchObject({ status: "RECONCILED" });
      expect(persistExternalV4MutationEvidence(f.repo, proof)).toMatchObject({ status: "ALREADY_RECONCILED", writes: 0 });
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM v4_external_close_settlements WHERE ladder_id=?").get(f.ladderId)).toEqual({ count: 1 });
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM v4_external_close_transactions WHERE ladder_id=?").get(f.ladderId)).toEqual({ count: 5 });
    } finally { f.repo.close(); }
  });

  it("rejects receipt identity mismatch and FUNI-authored provenance", () => {
    const bad = fixture(), internal = fixture();
    try {
      const malformed = evidence(bad.repo, bad.ladderId);
      malformed.legs[0]!.identityEvidence.receiptHashMatches = false;
      expect(() => persistExternalV4MutationEvidence(bad.repo, malformed)).toThrow("EXTERNAL_V4_LEG_EVIDENCE_MISMATCH");
      internal.repo.db.prepare("UPDATE v4_bid_ladders SET close_provenance='FUNI_EXECUTED',terminal_provenance='FUNI_AUTHORED_CLOSE_BATCH' WHERE ladder_id=?").run(internal.ladderId);
      expect(() => persistExternalV4MutationEvidence(internal.repo, evidence(internal.repo, internal.ladderId))).toThrow("EXTERNAL_V4_PROVENANCE_CONFLICT");
    } finally { bad.repo.close(); internal.repo.close(); }
  });

  it("shows the approved emergency advisory only on the pending reconciliation path", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      start = source.indexOf("function durableReconciliationPendingText"),
      end = source.indexOf("const amount =", start),
      pending = source.slice(start, end);
    expect(pending).toContain("Wallet transaction pending — avoid sending another wallet transaction while FUNI is reconciling.");
    expect(pending).toContain("If immediate risk reduction is necessary, you may act manually. FUNI will reconcile from canonical on-chain truth afterward.");
  });
});
