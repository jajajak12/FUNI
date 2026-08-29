import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import { poolId, sqrtPriceAtTick } from "@funi/v4";
import {
  acquireRpcReadLease,
  completeTargetedPositionReconciliation,
  enqueueTargetedPositionReconciliation,
  leaseTargetedPositionReconciliations,
  releaseRpcReadLease,
} from "../apps/cli/src/active-position-reconciliation.js";
import {
  createV4BidLadderLive,
  previewV4BidLadder,
} from "../apps/cli/src/v4-bid-ladder-operator.js";
import {
  acquireStatePersistenceLease,
  convergeOpenPendingV4BidLadder,
  fullyActionableV4BidLadder,
  leaseBackgroundStateRefresh,
  leaseUrgentStateRefresh,
  releaseStatePersistenceLease,
  runnableUrgentWork,
  URGENT_TARGETED_POSITION_REASONS,
} from "../apps/workers/src/state-cache-scheduling.js";
import { bidLadderRepositionActionState } from "../apps/telegram-lp-bot/src/persisted-portfolio.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const c0 = "0x0000000000000000000000000000000000000001" as const,
  c1 = "0x0000000000000000000000000000000000000002" as const,
  owner = "0x0000000000000000000000000000000000000003" as const,
  hooks = "0x0000000000000000000000000000000000000000" as const,
  key = {
    currency0: c0,
    currency1: c1,
    fee: 3000,
    tickSpacing: 10,
    hooks,
  } as const;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "urgent-state-verifier-"));
  roots.push(root);
  const path = join(root, "db.sqlite");
  migrateSqlite(path, "infra/migrations");
  return { path, repo: new SqliteLedgerRepository(path) };
}
function register(repo: SqliteLedgerRepository, id: string) {
  repo.upsertV4RegistryPool({
    poolId: id,
    currency0: c0,
    currency1: c1,
    initializeFeeRaw: 3000,
    tickSpacing: 10,
    hooks,
    initializationBlock: 1n,
    dynamicFee: false,
    staticFeePips: 3000,
    hookClassification: "ZERO_HOOK",
  });
}
function activateLadders(
  repo: SqliteLedgerRepository,
  count: number,
  nowMs: number,
  ttlMs: number,
) {
  const state = {
      id: poolId(key),
      key,
      sqrtPriceX96: sqrtPriceAtTick(0),
      tick: 0,
      liquidity: 1_000_000n,
      initialized: true,
      blockNumber: 123n,
    },
    ladderIds: string[] = [],
    positionIds: string[] = [];
  register(repo, state.id);
  for (let ladderIndex = 0; ladderIndex < count; ladderIndex++) {
    const preview = previewV4BidLadder({
      pool: {
        ...state,
        tick: ladderIndex * 10,
        blockNumber: 123n + BigInt(ladderIndex),
        sqrtPriceX96: sqrtPriceAtTick(ladderIndex * 10),
      },
      funding: { address: c1, symbol: "USDG", decimals: 6 },
      target: { address: c0, symbol: "TOKEN", decimals: 18 },
      totalFundingAmount: 10_000_000n,
      owner,
      deadline: 999_999n,
      nowMs: nowMs + ladderIndex,
    });
    createV4BidLadderLive(repo, preview, 10);
    ladderIds.push(preview.plan.ladderId);
    repo.db
      .prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?")
      .run(preview.plan.ladderId);
    for (const leg of repo.listBidLadderLegs(preview.plan.ladderId)) {
      const token = String(10_000 + ladderIndex * 5 + Number(leg.leg_index)),
        positionId = `v4:${token}`;
      positionIds.push(positionId);
      repo.db
        .prepare(
          "UPDATE v4_bid_ladder_legs SET status='OPEN',token_id=? WHERE ladder_id=? AND leg_index=?",
        )
        .run(token, preview.plan.ladderId, leg.leg_index);
      repo.ensurePosition(positionId, token, state.id);
      repo.upsertV4Position({
        tokenId: BigInt(token),
        owner,
        poolId: state.id,
        poolKey: key,
        currency0: c0,
        currency1: c1,
        fee: 3000,
        tickSpacing: 10,
        hooks,
        tickLower: Number(leg.tick_lower),
        tickUpper: Number(leg.tick_upper),
        liquidity: 1n,
        initialAmount0: 0n,
        initialAmount1: 1n,
        mintHash: `0x${token.padStart(64, "0")}`,
        targetToken: c0,
        fundingToken: c1,
        targetSymbol: "TOKEN",
        fundingSymbol: "USDG",
        targetDecimals: 18,
        fundingDecimals: 6,
        targetIndex: 0,
        fundingIndex: 1,
        openIntentId: preview.plan.ladderId,
      });
      repo.db
        .prepare(
          "INSERT INTO active_position_reconciliations(position_id,protocol_version,token_id,manager_address,owner_result,owner_status,liquidity_raw,confirmed_active,contributes_equity,checked_at_ms,fresh_until_ms,retry_count,details_json) VALUES(?,'v4',?,'manager',?,'VERIFIED_OWNED','1',1,1,?,?,0,'{}')",
        )
        .run(positionId, token, owner, nowMs, nowMs + ttlMs);
      enqueueTargetedPositionReconciliation(repo, {
        positionId,
        tokenId: token,
        protocol: "v4",
        reason: "OPERATIONAL_MINT_CONFIRMED",
        priority: 1_000,
        nowMs,
      });
    }
  }
  return { ladderIds, positionIds, poolId: state.id };
}

describe("dedicated urgent state verifier architecture", () => {
  it("leases five OPEN NFTs and the exact pool exclusively from urgent lanes", () => {
    const { repo } = fixture(),
      id = poolId(key);
    try {
      register(repo, id);
      for (let index = 0; index < 5; index++) {
        const token = String(100 + index),
          positionId = `v4:${token}`;
        repo.ensurePosition(positionId, token, id);
        enqueueTargetedPositionReconciliation(repo, {
          positionId,
          tokenId: token,
          protocol: "v4",
          reason: "OPERATIONAL_MINT_CONFIRMED",
          priority: 1000,
          nowMs: 1_000,
        });
      }
      repo.enqueueV4StateRefresh(
        id,
        900,
        "OPERATIONAL_OPEN_POOL_FRESHNESS",
        1_000,
      );
      expect(runnableUrgentWork(repo.db, 1_001)).toEqual({
        p0: true,
        p1: true,
      });
      const nft = leaseTargetedPositionReconciliations(repo, 8, 15_000, 1_001, {
          ownerId: "urgent-nft",
          lane: "urgent",
          reasons: URGENT_TARGETED_POSITION_REASONS,
        }),
        pool = leaseUrgentStateRefresh(
          repo.db,
          4,
          15_000,
          "urgent-pool",
          1_001,
        );
      expect(nft).toHaveLength(5);
      expect(pool.map((row) => row.pool_id)).toEqual([id]);
      expect(
        leaseTargetedPositionReconciliations(repo, 8, 15_000, 1_001, {
          ownerId: "background-nft",
          lane: "background",
        }),
      ).toEqual([]);
      expect(
        leaseBackgroundStateRefresh(
          repo.db,
          8,
          15_000,
          "background-pool",
          1_001,
        ),
      ).toEqual([]);
      expect(new Set([...nft, ...pool].map((row) => row.lease_owner))).toEqual(
        new Set(["urgent-nft", "urgent-pool"]),
      );
    } finally {
      repo.close();
    }
  });

  it("keeps 15 NFTs across three ladders continuously actionable through recurring NFT and pool deadlines, then stops at terminal", () => {
    const { repo } = fixture(),
      start = 1_000_000,
      ttl = 120_000;
    try {
      const active = activateLadders(repo, 3, start, ttl),
        initial = leaseTargetedPositionReconciliations(
          repo,
          20,
          15_000,
          start + 1,
          {
            ownerId: "initial-nft",
            lane: "urgent",
            reasons: URGENT_TARGETED_POSITION_REASONS,
          },
        );
      expect(initial).toHaveLength(15);
      for (const row of initial)
        completeTargetedPositionReconciliation(
          repo,
          String(row.position_id),
          start + 2,
          "initial-nft",
        );
      repo.enqueueV4StateRefresh(
        active.poolId,
        900,
        "OPERATIONAL_OPEN_POOL_FRESHNESS",
        start,
      );
      expect(
        leaseUrgentStateRefresh(repo.db, 1, 15_000, "initial-pool", start + 1),
      ).toHaveLength(1);
      repo.db
        .prepare(
          "UPDATE v4_pool_registry SET last_refreshed_at=?,refresh_block=? WHERE pool_id=?",
        )
        .run(new Date(start).toISOString(), "123", active.poolId);
      expect(
        repo.completeV4StateRefresh(active.poolId, "initial-pool", {
          ttlMs: ttl,
          refreshedAtMs: start,
          nowMs: start + 2,
        }),
      ).toBe(1);
      let due = start + 80_000;
      for (let cycle = 0; cycle < 3; cycle++) {
        expect(
          leaseTargetedPositionReconciliations(repo, 20, 15_000, due - 1, {
            ownerId: `early-${cycle}`,
            lane: "urgent",
            reasons: URGENT_TARGETED_POSITION_REASONS,
          }),
        ).toEqual([]);
        const nft = leaseTargetedPositionReconciliations(
          repo,
          20,
          15_000,
          due,
          {
            ownerId: `nft-${cycle}`,
            lane: "urgent",
            reasons: URGENT_TARGETED_POSITION_REASONS,
          },
        );
        expect(nft).toHaveLength(15);
        for (const row of nft) {
          repo.db
            .prepare(
              "UPDATE active_position_reconciliations SET checked_at_ms=?,fresh_until_ms=? WHERE position_id=?",
            )
            .run(due, due + ttl, row.position_id);
          completeTargetedPositionReconciliation(
            repo,
            String(row.position_id),
            due + 1,
            `nft-${cycle}`,
          );
        }
        expect(
          leaseUrgentStateRefresh(repo.db, 1, 15_000, `pool-${cycle}`, due),
        ).toHaveLength(1);
        repo.db
          .prepare(
            "UPDATE v4_pool_registry SET last_refreshed_at=? WHERE pool_id=?",
          )
          .run(new Date(due).toISOString(), active.poolId);
        expect(
          repo.completeV4StateRefresh(active.poolId, `pool-${cycle}`, {
            ttlMs: ttl,
            refreshedAtMs: due,
            nowMs: due + 1,
          }),
        ).toBe(1);
        for (const ladderId of active.ladderIds)
          expect(
            fullyActionableV4BidLadder(repo.db, ladderId, due + 1, ttl),
          ).toBe(true);
        due += 80_000;
      }
      repo.db
        .prepare(
          "UPDATE v4_bid_ladders SET status='CLOSED' WHERE ladder_id IN (?,?,?)",
        )
        .run(...active.ladderIds);
      const terminalNft = leaseTargetedPositionReconciliations(
        repo,
        20,
        15_000,
        due,
        {
          ownerId: "terminal-nft",
          lane: "urgent",
          reasons: URGENT_TARGETED_POSITION_REASONS,
        },
      );
      for (const row of terminalNft)
        completeTargetedPositionReconciliation(
          repo,
          String(row.position_id),
          due + 1,
          "terminal-nft",
        );
      expect(
        leaseUrgentStateRefresh(repo.db, 1, 15_000, "terminal-pool", due),
      ).toHaveLength(1);
      expect(
        repo.completeV4StateRefresh(active.poolId, "terminal-pool", {
          ttlMs: ttl,
          refreshedAtMs: due,
          nowMs: due + 1,
        }),
      ).toBe(1);
      expect(
        repo.db
          .prepare(
            "SELECT COUNT(*) count FROM targeted_position_reconciliation_requests WHERE reason='ACTIVE_OPEN_POSITION_REFRESH_DUE'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        repo.db
          .prepare(
            "SELECT COUNT(*) count FROM v4_state_refresh_queue WHERE reason='ACTIVE_OPEN_POOL_REFRESH_DUE'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      repo.close();
    }
  });

  it("services 100 recurring NFT obligations in bounded batches with positive headroom", () => {
    const { repo } = fixture(),
      start = 2_000_000,
      ttl = 120_000,
      due = start + 80_000;
    try {
      activateLadders(repo, 20, start, ttl);
      for (let batch = 0; ; batch++) {
        const rows = leaseTargetedPositionReconciliations(
          repo,
          16,
          15_000,
          start + 1,
          {
            ownerId: `initial-${batch}`,
            lane: "urgent",
            reasons: URGENT_TARGETED_POSITION_REASONS,
          },
        );
        if (!rows.length) break;
        expect(rows.length).toBeLessThanOrEqual(16);
        for (const row of rows)
          completeTargetedPositionReconciliation(
            repo,
            String(row.position_id),
            start + 2,
            `initial-${batch}`,
          );
      }
      expect(
        repo.db
          .prepare(
            "SELECT COUNT(*) count FROM targeted_position_reconciliation_requests WHERE reason='ACTIVE_OPEN_POSITION_REFRESH_DUE'",
          )
          .get(),
      ).toEqual({ count: 100 });
      let serviced = 0;
      for (let batch = 0; ; batch++) {
        const rows = leaseTargetedPositionReconciliations(
          repo,
          16,
          15_000,
          due,
          {
            ownerId: `maintenance-${batch}`,
            lane: "urgent",
            reasons: URGENT_TARGETED_POSITION_REASONS,
          },
        );
        if (!rows.length) break;
        expect(rows.length).toBeLessThanOrEqual(16);
        for (const row of rows) {
          repo.db
            .prepare(
              "UPDATE active_position_reconciliations SET checked_at_ms=?,fresh_until_ms=? WHERE position_id=?",
            )
            .run(due, due + ttl, row.position_id);
          completeTargetedPositionReconciliation(
            repo,
            String(row.position_id),
            due + 1,
            `maintenance-${batch}`,
          );
          serviced++;
        }
      }
      expect(serviced).toBe(100);
      const horizons = repo.db
        .prepare(
          "SELECT q.available_at_ms,r.fresh_until_ms FROM targeted_position_reconciliation_requests q JOIN active_position_reconciliations r USING(position_id) WHERE q.reason='ACTIVE_OPEN_POSITION_REFRESH_DUE'",
        )
        .all() as Array<{ available_at_ms: number; fresh_until_ms: number }>;
      expect(horizons).toHaveLength(100);
      expect(
        Math.min(
          ...horizons.map((row) => row.fresh_until_ms - row.available_at_ms),
        ),
      ).toBe(40_000);
    } finally {
      repo.close();
    }
  });

  it("keeps an 8,000-row P3 backlog from affecting urgent lease latency", () => {
    const { repo } = fixture(),
      urgentId = "0x" + "ff".repeat(32);
    try {
      repo.db.transaction(() => {
        for (let index = 1; index <= 8_000; index++) {
          const id = `0x${index.toString(16).padStart(64, "0")}`;
          register(repo, id);
          repo.enqueueV4StateRefresh(id, 50, "fair-registry-refresh", 1_000);
        }
        register(repo, urgentId);
        repo.enqueueV4StateRefresh(
          urgentId,
          900,
          "OPERATIONAL_OPEN_POOL_FRESHNESS",
          2_000,
        );
      })();
      const started = Date.now(),
        leased = leaseUrgentStateRefresh(
          repo.db,
          1,
          15_000,
          "urgent-under-p3",
          2_001,
        ),
        elapsed = Date.now() - started;
      expect(leased.map((row) => row.pool_id)).toEqual([urgentId]);
      expect(elapsed).toBeLessThan(2_000);
      expect(
        repo.db
          .prepare(
            "SELECT COUNT(*) count FROM v4_state_refresh_queue WHERE lane='background'",
          )
          .get(),
      ).toEqual({ count: 8_000 });
    } finally {
      repo.close();
    }
  });

  it("allows urgent RPC service while the bounded background budget is held for ten minutes", () => {
    const { repo } = fixture();
    try {
      expect(
        acquireRpcReadLease(
          repo,
          "background-stuck",
          600_000,
          1_000,
          "background",
        ),
      ).toBe(true);
      expect(
        acquireRpcReadLease(repo, "urgent-open", 15_000, 1_001, "urgent"),
      ).toBe(true);
      expect(
        acquireRpcReadLease(
          repo,
          "background-second",
          15_000,
          1_001,
          "background",
        ),
      ).toBe(false);
      expect(
        repo.db
          .prepare(
            "SELECT lane,owner_id FROM state_cache_rpc_budget_leases ORDER BY lane",
          )
          .all(),
      ).toEqual([
        { lane: "background", owner_id: "background-stuck" },
        { lane: "urgent", owner_id: "urgent-open" },
      ]);
      expect(releaseRpcReadLease(repo, "urgent-open", 1_002, "urgent")).toBe(
        true,
      );
    } finally {
      repo.close();
    }
  });

  it("recovers expired urgent leases after a worker restart without duplicate ownership", () => {
    const { repo } = fixture(),
      id = poolId(key);
    try {
      register(repo, id);
      repo.enqueueV4StateRefresh(
        id,
        900,
        "OPERATIONAL_OPEN_POOL_FRESHNESS",
        1_000,
      );
      expect(
        leaseUrgentStateRefresh(
          repo.db,
          1,
          100,
          "urgent-before-restart",
          1_001,
        ),
      ).toHaveLength(1);
      expect(
        leaseUrgentStateRefresh(repo.db, 1, 100, "urgent-after-restart", 1_100),
      ).toEqual([]);
      const recovered = leaseUrgentStateRefresh(
        repo.db,
        1,
        100,
        "urgent-after-restart",
        1_102,
      );
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        lease_owner: "urgent-after-restart",
        leased_at_ms: 1_102,
      });
    } finally {
      repo.close();
    }
  });

  it("serializes urgent/background persistence and rejects a stale pool overwrite", () => {
    const { repo, path } = fixture(),
      other = new SqliteLedgerRepository(path),
      id = poolId(key);
    try {
      register(repo, id);
      expect(
        acquireStatePersistenceLease(repo.db, "urgent-writer", 10_000, 1_000),
      ).toBe(true);
      expect(
        acquireStatePersistenceLease(
          other.db,
          "background-writer",
          10_000,
          1_001,
        ),
      ).toBe(false);
      repo.refreshV4RegistryPool({
        poolId: id,
        sqrtPriceX96: 2n,
        tick: 2,
        liquidity: 2n,
        protocolFee: 0,
        lpFeePips: 3000,
        initialized: true,
        refreshBlock: 200n,
        validationStatus: "ELIGIBLE",
        blockers: [],
      });
      expect(
        releaseStatePersistenceLease(repo.db, "urgent-writer", 1_002),
      ).toBe(true);
      expect(
        acquireStatePersistenceLease(
          other.db,
          "background-writer",
          10_000,
          1_003,
        ),
      ).toBe(true);
      other.refreshV4RegistryPool({
        poolId: id,
        sqrtPriceX96: 1n,
        tick: 1,
        liquidity: 1n,
        protocolFee: 0,
        lpFeePips: 3000,
        initialized: true,
        refreshBlock: 199n,
        validationStatus: "ELIGIBLE",
        blockers: [],
      });
      expect(other.v4RegistryPool(id)).toMatchObject({
        refresh_block: "200",
        current_tick: 2,
        sqrt_price_x96: "2",
      });
      expect(
        releaseStatePersistenceLease(other.db, "background-writer", 1_004),
      ).toBe(true);
    } finally {
      other.close();
      repo.close();
    }
  });

  it("converges generation 0 and 1 OPEN_PENDING only after exact urgent evidence, then exposes Reposition without snapshot or freshness-gated visibility", () => {
    const { repo } = fixture(),
      now = Date.now(),
      state = {
        id: poolId(key),
        key,
        sqrtPriceX96: sqrtPriceAtTick(0),
        tick: 0,
        liquidity: 1_000_000n,
        initialized: true,
        blockNumber: 123n,
      };
    const makePreview = (tick: number, blockNumber: bigint, nowMs: number) =>
      previewV4BidLadder({
        pool: {
          ...state,
          tick,
          blockNumber,
          sqrtPriceX96: sqrtPriceAtTick(tick),
        },
        funding: { address: c1, symbol: "USDG", decimals: 6 },
        target: { address: c0, symbol: "TOKEN", decimals: 18 },
        totalFundingAmount: 10_000_000n,
        owner,
        deadline: 999_999n,
        nowMs,
      });
    const activate = (ladderId: string, tokenBase: number) => {
      repo.db
        .prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?")
        .run(ladderId);
      for (const leg of repo.listBidLadderLegs(ladderId)) {
        const token = String(tokenBase + Number(leg.leg_index)),
          positionId = `v4:${token}`;
        repo.db
          .prepare(
            "UPDATE v4_bid_ladder_legs SET status='OPEN',token_id=? WHERE ladder_id=? AND leg_index=?",
          )
          .run(token, ladderId, leg.leg_index);
        repo.ensurePosition(positionId, token, state.id);
        repo.upsertV4Position({
          tokenId: BigInt(token),
          owner,
          poolId: state.id,
          poolKey: key,
          currency0: c0,
          currency1: c1,
          fee: 3000,
          tickSpacing: 10,
          hooks,
          tickLower: Number(leg.tick_lower),
          tickUpper: Number(leg.tick_upper),
          liquidity: 1n,
          initialAmount0: 0n,
          initialAmount1: 1n,
          mintHash: `0x${token.padStart(64, "0")}`,
          targetToken: c0,
          fundingToken: c1,
          targetSymbol: "TOKEN",
          fundingSymbol: "USDG",
          targetDecimals: 18,
          fundingDecimals: 6,
          targetIndex: 0,
          fundingIndex: 1,
          openIntentId: ladderId,
        });
        repo.db
          .prepare(
            "INSERT INTO active_position_reconciliations(position_id,protocol_version,token_id,manager_address,owner_result,owner_status,liquidity_raw,confirmed_active,contributes_equity,checked_at_ms,fresh_until_ms,retry_count,details_json) VALUES(?,'v4',?,'manager',?,'VERIFIED_OWNED','1',1,1,?,?,0,'{}')",
          )
          .run(positionId, token, owner, now, now + 300_000);
      }
    };
    try {
      const generation0 = makePreview(0, 123n, 1_000),
        rootId = generation0.plan.ladderId;
      createV4BidLadderLive(repo, generation0, 10);
      register(repo, state.id);
      repo.refreshV4RegistryPool({
        poolId: state.id,
        sqrtPriceX96: state.sqrtPriceX96,
        tick: 0,
        liquidity: state.liquidity,
        protocolFee: 0,
        lpFeePips: 3000,
        initialized: true,
        refreshBlock: 123n,
        validationStatus: "ELIGIBLE",
        blockers: [],
      });
      activate(rootId, 500);
      repo.db.prepare("DELETE FROM portfolio_persisted_snapshot").run();
      expect(repo.loadBidLadderUsdReset(rootId)).toMatchObject({
        generation: 0,
        phase: "OPEN_PENDING",
      });
      expect(fullyActionableV4BidLadder(repo.db, rootId, now, 120_000)).toBe(
        true,
      );
      expect(convergeOpenPendingV4BidLadder(repo, rootId, now, 120_000)).toBe(
        true,
      );
      expect(repo.loadBidLadderUsdReset(rootId)).toMatchObject({
        generation: 0,
        phase: "WATCHING",
      });
      expect(bidLadderRepositionActionState(repo, rootId)).toEqual({
        executable: true,
        reason: null,
      });
      repo.db
        .prepare(
          "UPDATE active_position_reconciliations SET fresh_until_ms=? WHERE position_id IN (SELECT 'v4:'||token_id FROM v4_bid_ladder_legs WHERE ladder_id=?)",
        )
        .run(now - 1, rootId);
      expect(fullyActionableV4BidLadder(repo.db, rootId, now, 120_000)).toBe(
        false,
      );
      expect(bidLadderRepositionActionState(repo, rootId)).toEqual({
        executable: true,
        reason: null,
      });
      const generation1 = makePreview(10, 124n, 2_000),
        childId = generation1.plan.ladderId;
      expect(childId).not.toBe(rootId);
      createV4BidLadderLive(repo, generation1, 10, {
        rootLadderId: rootId,
        previousLadderId: rootId,
        generation: 1,
        creationReason: "USDG_RESET_REPOSITION",
      });
      activate(childId, 600);
      expect(repo.loadBidLadderUsdReset(childId)).toMatchObject({
        root_ladder_id: rootId,
        previous_ladder_id: rootId,
        generation: 1,
        phase: "OPEN_PENDING",
      });
      expect(convergeOpenPendingV4BidLadder(repo, childId, now, 120_000)).toBe(
        true,
      );
      expect(repo.loadBidLadderUsdReset(childId)).toMatchObject({
        generation: 1,
        phase: "WATCHING",
      });
      expect(bidLadderRepositionActionState(repo, childId)).toEqual({
        executable: true,
        reason: null,
      });
    } finally {
      repo.close();
    }
  });

  it("wires one secret-free canonical PM2 process and leaves the background source without urgent leasing", () => {
    const urgent = readFileSync(
        "apps/workers/src/urgent-state-cache-worker.ts",
        "utf8",
      ),
      background = readFileSync(
        "apps/workers/src/state-cache-worker.ts",
        "utf8",
      ),
      ecosystem = readFileSync("infra/pm2/ecosystem.config.cjs", "utf8"),
      start = readFileSync(
        "infra/pm2/start-urgent-state-cache-worker.sh",
        "utf8",
      );
    expect(
      ecosystem.match(/app\(\s*["']funi-v4-state-cache-urgent["']/g),
    ).toHaveLength(1);
    expect(ecosystem).toContain("...readOnlyEnv");
    expect(start).toContain(
      "unset LP_PRIVATE_KEY LP_MNEMONIC SEED_PHRASE MNEMONIC",
    );
    expect(urgent).not.toMatch(
      /privateKeyToAccount|signTransaction|sendRawTransaction|broadcastSignedTransaction|reserveNonce/,
    );
    expect(urgent).not.toMatch(
      /fair-registry-refresh|principalCachePhase|v3CachePhase|adoptionPhase|activeReconciliationPhase/,
    );
    expect(urgent).toContain("refreshPortfolioSnapshot:false");
    expect(background).toContain("lane:'background'");
    expect(background).not.toContain("leaseUrgentStateRefresh");
    expect(background).not.toContain("'urgent'");
  });
});
