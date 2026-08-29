import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FallbackRpc, robinhoodMainnet } from "@funi/core";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import { poolId } from "@funi/v4";
import {
  BID_LADDER_AUTO_EXPIRY_REASON,
  BID_LADDER_PLANNED_AUTO_EXPIRY_MS,
  cancelPlannedV4BidLadder,
  expireAbandonedPlannedV4BidLadders,
  plannedV4BidLadderCancellationStatus,
} from "../apps/cli/src/v4-bid-ladder-cancellation.js";
import {
  executeV4BidLadderLiveOpen,
  previewV4BidLadderLive,
} from "../apps/cli/src/v4-bid-ladder-live.js";
import { formatPersistedV4BidLadder } from "../apps/cli/src/v4-bid-ladder-operator.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const now = 2_000_000_000_000,
  wallet = "0x0000000000000000000000000000000000000003" as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ladder-cancel-")),
    path = join(root, "db.sqlite");
  roots.push(root);
  migrateSqlite(path, "infra/migrations");
  return new SqliteLedgerRepository(path);
}
function ladder(
  repo: SqliteLedgerRepository,
  input: { id: string; ageMs?: number; usd?: number },
) {
  const at = now - (input.ageMs ?? BID_LADDER_PLANNED_AUTO_EXPIRY_MS);
  repo.db
    .prepare(
      "INSERT INTO v4_bid_ladders(ladder_id,strategy_version,execution_mode,pool_id,currency0,currency1,fee,tick_spacing,hooks,funding_token,target_token,funding_index,target_index,reference_tick,reference_block,total_funding_amount_raw,entry_usd_snapshot,status,created_at_ms,updated_at_ms) VALUES(?,'V4_BID_LADDER_V1','LIVE',?,?,?,?,?,?,?,?,?,?,0,'1','2000000000',?,'PLANNED',?,?)",
    )
    .run(
      input.id,
      `0x${"1".repeat(64)}`,
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
      3000,
      10,
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000001",
      1,
      0,
      input.usd ?? 2000,
      at,
      at,
    );
  const insert = repo.db.prepare(
    "INSERT INTO v4_bid_ladder_legs(ladder_id,leg_index,upper_drop_bps,lower_drop_bps,capital_weight_bps,tick_lower,tick_upper,funding_amount_raw,planned_liquidity_raw,funding_index,target_index,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,1,0,'PLANNED',?,?)",
  );
  for (let index = 0; index < 5; index++)
    insert.run(
      input.id,
      index,
      (index + 1) * 100,
      (index + 2) * 100,
      [800, 1200, 1800, 2500, 3700][index],
      index,
      index + 1,
      "400000000",
      "1",
      at,
      at,
    );
  return input.id;
}
function cleanup(repo: SqliteLedgerRepository) {
  return expireAbandonedPlannedV4BidLadders(repo, { nowMs: now });
}
function prepared(repo: SqliteLedgerRepository, id: string, submitted = false) {
  repo.persistChainPreparedTransaction({
    chainId: 4663,
    chainKey: "robinhood",
    protocol: "uniswap_v4",
    journalId: `${id}:OPEN_BATCH:0`,
    wallet,
    workflowIdentity: id,
    semanticStage: "OPEN_BATCH",
    attempt: 0,
    nonce: 7,
    transactionType: "OPEN_BATCH",
    expectedHash: `0x${"1".repeat(64)}`,
    to: "0x0000000000000000000000000000000000000004",
    requestFingerprint: "fixture",
    feeModel: "legacy",
  });
  if (submitted)
    repo.transitionChainTransaction({
      chainId: 4663,
      journalId: `${id}:OPEN_BATCH:0`,
      from: "PREPARED",
      to: "SUBMITTED",
    });
}
function snapshot(repo: SqliteLedgerRepository, equity: number) {
  repo.db
    .prepare(
      "INSERT OR REPLACE INTO portfolio_persisted_snapshot(snapshot_key,payload_json,content_hash,refreshed_at_ms,last_reconciliation_at_ms) VALUES('current',?,?,?,?)",
    )
    .run(
      JSON.stringify({
        positions: equity
          ? [
              {
                positionId: "v4:active",
                status: "open",
                lifecycle: "CONFIRMED_ACTIVE_FRESH",
                liquidityRaw: "1",
                source: "BOT_OPERATIONAL",
                openIntentId: "active-intent",
                accounting: { currentEquityUsd: equity },
              },
            ]
          : [],
      }),
      "fixture",
      now,
      now,
    );
}

describe("canonical BID Ladder planned cancellation", () => {
  it("keeps 29m59s PLANNED and cancels exactly at 30m with one revision", () => {
    const repo = fixture();
    try {
      ladder(repo, {
        id: "young",
        ageMs: BID_LADDER_PLANNED_AUTO_EXPIRY_MS - 1000,
      });
      ladder(repo, { id: "exact" });
      expect(cleanup(repo)).toMatchObject([
        { status: "CANCELLED", ladderId: "exact" },
      ]);
      expect(repo.loadBidLadder("young")?.status).toBe("PLANNED");
      expect(repo.loadBidLadder("exact")).toMatchObject({
        status: "CANCELLED",
        terminal_reason: BID_LADDER_AUTO_EXPIRY_REASON,
        terminal_at_ms: now,
        revision: 1,
      });
      expect(repo.listBidLadderLegs("exact").map((row) => row.status)).toEqual(
        Array(5).fill("CANCELLED"),
      );
      expect(
        formatPersistedV4BidLadder({
          parent: repo.loadBidLadder("exact")!,
          legs: repo.listBidLadderLegs("exact"),
          funding: {
            address: "0x0000000000000000000000000000000000000002",
            symbol: "USDG",
            decimals: 6,
          },
          target: {
            address: "0x0000000000000000000000000000000000000001",
            symbol: "TOKEN",
            decimals: 18,
          },
        }),
      ).toContain(
        "Status: CANCELLED\nExpired after 30 minutes without execution.",
      );
      expect(cleanup(repo)).toEqual([]);
      expect(
        cancelPlannedV4BidLadder(repo, {
          ladderId: "exact",
          expectedRevision: 0,
          reason: BID_LADDER_AUTO_EXPIRY_REASON,
          nowMs: now,
        }),
      ).toMatchObject({ status: "ALREADY_CANCELLED" });
    } finally {
      repo.close();
    }
  });

  it.each([
    ["PREPARED", false],
    ["SUBMITTED", true],
  ])("never cancels %s journal evidence", (_status, submitted) => {
    const repo = fixture();
    try {
      const id = ladder(repo, { id: `journal-${_status}` });
      prepared(repo, id, submitted);
      expect(cleanup(repo)[0]).toMatchObject({ status: "BLOCKED" });
      expect(repo.loadBidLadder(id)?.status).toBe("PLANNED");
    } finally {
      repo.close();
    }
  });

  it("never cancels broadcast/receipt, canonical position, or nonce evidence", () => {
    for (const kind of ["receipt", "position", "nonce"] as const) {
      const repo = fixture();
      try {
        const id = ladder(repo, { id: kind });
        if (kind === "receipt") {
          repo.db
            .prepare(
              "INSERT INTO transaction_intents(id,idempotency_key,state,payload_json,created_at) VALUES(?,?,?,?,?)",
            )
            .run(
              id,
              id,
              "SUBMITTED",
              JSON.stringify({ ladderId: id }),
              new Date(now).toISOString(),
            );
          repo.db
            .prepare(
              "INSERT INTO transaction_receipts(tx_hash,intent_id,receipt_json) VALUES(?,?,?)",
            )
            .run(
              `0x${"2".repeat(64)}`,
              id,
              JSON.stringify({ status: "success", ladderId: id }),
            );
        } else if (kind === "position") {
          repo.upsertV4Position({
            tokenId: 7n,
            owner: wallet,
            poolId: `0x${"1".repeat(64)}`,
            poolKey: {},
            currency0: "0x0000000000000000000000000000000000000001",
            currency1: "0x0000000000000000000000000000000000000002",
            fee: 3000,
            tickSpacing: 10,
            hooks: "0x0000000000000000000000000000000000000000",
            tickLower: 0,
            tickUpper: 1,
            liquidity: 1n,
            initialAmount0: 1n,
            initialAmount1: 0n,
            mintHash: `0x${"3".repeat(64)}`,
            openIntentId: id,
            openEvidence: { ladderId: id },
          });
        } else {
          repo.db
            .prepare(
              "INSERT INTO nonce_mutex(wallet,nonce,acquired_at,expires_at) VALUES(?,?,?,?)",
            )
            .run(
              wallet,
              "7",
              new Date(now - 1000).toISOString(),
              new Date(now + 60_000).toISOString(),
            );
        }
        expect(cleanup(repo)[0]).toMatchObject({ status: "BLOCKED" });
        expect(repo.loadBidLadder(id)?.status).toBe("PLANNED");
      } finally {
        repo.close();
      }
    }
  });

  it("fails closed on advanced open intent, generic position, commitment, and live callback evidence", () => {
    for (const kind of [
      "intent",
      "generic",
      "commitment",
      "callback",
    ] as const) {
      const repo = fixture();
      try {
        const id = ladder(repo, { id: `protected-${kind}` });
        if (kind === "intent") {
          const intent = repo.createV4LiveOpenIntent({
            idempotencyKey: id,
            owner: wallet,
            poolId: `0x${"1".repeat(64)}`,
            poolKey: {},
            amount: 1n,
            payload: { ladderId: id },
          });
          repo.transitionV4LiveOpenIntent(String(intent.id), "MINT_PREPARED");
        } else if (kind === "generic") {
          repo.db
            .prepare(
              "UPDATE v4_bid_ladder_legs SET token_id='7' WHERE ladder_id=? AND leg_index=0",
            )
            .run(id);
          repo.ensurePosition("v4:7", "7", `0x${"1".repeat(64)}`);
        } else if (kind === "commitment") {
          repo.db
            .prepare(
              "INSERT INTO chain_exposure_commitments(chain_id,protocol,workflow_id,provenance,committed_usd,valuation_status,evidence_json) VALUES(4663,'uniswap_v4',?,'BOT_OPERATIONAL',2000,'KNOWN','{}')",
            )
            .run(id);
        } else {
          repo.db
            .prepare(
              "INSERT INTO chain_callback_authorizations(authorization_id,user_id,chat_id,chain_id,protocol,workflow_or_position_id,action,preview_revision,expires_at_ms,idempotency_key,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              "auth",
              "u",
              "c",
              4663,
              "uniswap_v4",
              id,
              "OPEN",
              0,
              now + 1,
              "auth",
              now - 1,
            );
        }
        expect(cleanup(repo)[0]).toMatchObject({ status: "BLOCKED" });
        expect(repo.loadBidLadder(id)?.status).toBe("PLANNED");
      } finally {
        repo.close();
      }
    }
  });

  it("protects only an active unexpired exact Telegram flow", () => {
    const repo = fixture();
    try {
      const active = ladder(repo, { id: "active-session" }),
        expired = ladder(repo, { id: "expired-session" });
      const insert = repo.db.prepare(
        "INSERT INTO telegram_flow_sessions(session_id,scope,user_id,chat_id,state_json,status,created_at_ms,updated_at_ms,expires_at_ms) VALUES(?,?,?,?,?,'active',?,?,?)",
      );
      insert.run(
        "s-active",
        "u:c",
        "u",
        "c",
        JSON.stringify({ bidLadderPreview: { ladderId: active } }),
        now - 1000,
        now - 1000,
        now + 1,
      );
      insert.run(
        "s-expired",
        "u2:c2",
        "u2",
        "c2",
        JSON.stringify({ bidLadderPreview: { ladderId: expired } }),
        now - 2000,
        now - 2000,
        now - 1,
      );
      const results = cleanup(repo);
      expect(results.find((row) => row.ladderId === active)).toMatchObject({
        status: "BLOCKED",
      });
      expect(results.find((row) => row.ladderId === expired)).toMatchObject({
        status: "CANCELLED",
      });
      expect(repo.loadBidLadder(active)?.status).toBe("PLANNED");
      expect(repo.loadBidLadder(expired)?.status).toBe("CANCELLED");
    } finally {
      repo.close();
    }
  });

  it("fails closed after concurrent PREPARED evidence and on revision mismatch", () => {
    const repo = fixture();
    try {
      const journal = ladder(repo, { id: "concurrent-prepared" }),
        revised = ladder(repo, { id: "revised" });
      const selected = plannedV4BidLadderCancellationStatus(repo, {
        ladderId: journal,
        expectedRevision: 0,
        nowMs: now,
      });
      expect(selected.eligible).toBe(true);
      prepared(repo, journal);
      expect(
        cancelPlannedV4BidLadder(repo, {
          ladderId: journal,
          expectedRevision: 0,
          reason: BID_LADDER_AUTO_EXPIRY_REASON,
          nowMs: now,
        }),
      ).toMatchObject({ status: "BLOCKED" });
      repo.db
        .prepare(
          "UPDATE v4_bid_ladders SET revision=revision+1 WHERE ladder_id=?",
        )
        .run(revised);
      expect(
        cancelPlannedV4BidLadder(repo, {
          ladderId: revised,
          expectedRevision: 0,
          reason: BID_LADDER_AUTO_EXPIRY_REASON,
          nowMs: now,
        }),
      ).toMatchObject({ status: "CONCURRENT_STATE_CHANGED" });
    } finally {
      repo.close();
    }
  });

  it("runs bounded cleanup in the LIVE preview path before recomputing exposure", async () => {
    const repo = fixture();
    try {
      snapshot(repo, 1999.999995);
      const stale = ladder(repo, { id: "lazy-stale" }),
        proposal = ladder(repo, { id: "lazy-proposal", ageMs: 0 }),
        key = {
          currency0: "0x0000000000000000000000000000000000000001",
          currency1: "0x0000000000000000000000000000000000000002",
          fee: 3000,
          tickSpacing: 10,
          hooks: "0x0000000000000000000000000000000000000000",
        } as const;
      repo.db
        .prepare("UPDATE v4_bid_ladders SET pool_id=? WHERE ladder_id IN (?,?)")
        .run(poolId(key), stale, proposal);
      repo.upsertTokenMetadata({
        address: key.currency0,
        symbol: "T",
        name: "Target",
        decimals: 18,
      });
      repo.upsertTokenMetadata({
        address: key.currency1,
        symbol: "USDG",
        name: "USDG",
        decimals: 6,
      });
      const client = {
          getBlockNumber: async () => 123n,
          readContract: async (input: any) => {
            if (input.functionName === "getSlot0")
              return [2n ** 96n, 0, 0, 3000];
            if (input.functionName === "getLiquidity") return 1_000_000_000n;
            if (input.functionName === "balanceOf") return 10_000_000_000n;
            if (input.functionName === "allowance")
              return input.args?.length === 3
                ? [10_000_000_000n, 9_999_999_999, 0]
                : 10_000_000_000n;
            throw new Error(`unexpected read ${String(input.functionName)}`);
          },
          estimateGas: async () => 1_000_000n,
        } as any,
        rpc = new FallbackRpc(
          { ...robinhoodMainnet, rpcUrls: ["https://example.invalid"] },
          undefined,
          { clients: [client] },
        ),
        preview = await previewV4BidLadderLive({
          repo,
          rpc,
          ladderId: proposal,
          wallet,
          fundingUsd: 1,
          nativeUsd: 1,
          runtime: {
            executionEnabled: true,
            dryRun: false,
            emergencyPause: false,
            signerConfigured: true,
            allowlisted: true,
            maxPositionUsd: 2050,
            maxApprovalUsd: 2050,
            maxGasUsd: 10,
            slippageBps: 100,
          },
          nowMs: () => now,
          entryPriceFetch: async (token) => ({
            token,
            priceUsd: "1",
            source: "gmgn-token-info-price.price",
            fetchedAtMs: now,
            freshUntilMs: now + 30_000,
          }),
        });
      expect(repo.loadBidLadder(stale)?.status).toBe("CANCELLED");
      expect(repo.loadBidLadder(proposal)?.status).toBe("PLANNED");
      expect(preview.blockers.every((code) => !code.includes("EXPOSURE"))).toBe(true);
    } finally {
      repo.close();
    }
  });

  it("rejects CANCELLED preview, resume, and final open before RPC or wallet use", async () => {
    const repo = fixture();
    try {
      const id = ladder(repo, { id: "cancelled-entrypoint" });
      cleanup(repo);
      let rpcCalls = 0,
        walletCalls = 0;
      const input = {
        repo,
        rpc: new Proxy({ config: { chainId: 4663 } } as any, {
          get(target, property) {
            if (property === "config") return target.config;
            rpcCalls++;
            throw new Error("RPC must be unreachable");
          },
        }),
        ladderId: id,
        wallet,
        fundingUsd: 1,
        nativeUsd: 1,
        runtime: {
          executionEnabled: true,
          dryRun: false,
          emergencyPause: false,
          signerConfigured: true,
          allowlisted: true,
          maxPositionUsd: 2050,
          maxApprovalUsd: 2050,
          maxGasUsd: 10,
          slippageBps: 100,
        },
      };
      await expect(previewV4BidLadderLive(input)).rejects.toThrow(
        "V4_BID_LADDER_CANCELLED",
      );
      await expect(
        executeV4BidLadderLiveOpen({
          ...input,
          walletClient: new Proxy({} as any, {
            get() {
              walletCalls++;
              throw new Error("wallet must be unreachable");
            },
          }),
        }),
      ).rejects.toThrow("V4_BID_LADDER_CANCELLED");
      expect({ rpcCalls, walletCalls }).toEqual({
        rpcCalls: 0,
        walletCalls: 0,
      });
    } finally {
      repo.close();
    }
  });
});
