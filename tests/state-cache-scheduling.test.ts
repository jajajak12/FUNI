import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import {
  createStateCacheSchedulerState,
  leasePriorityDirectLookupRefresh,
  leaseUrgentStateRefresh,
  runnablePriorityWork,
  runStateCacheWorkerCycle,
} from "../apps/workers/src/state-cache-scheduling.js";

describe("state-cache worker scheduling", () => {
  it("runs the bounded lower-priority order when no priority signal is runnable", async () => {
    const events: string[] = [];
    await runStateCacheWorkerCycle({
      state: createStateCacheSchedulerState(),
      priorityWork: () => ({ p0: false, p1: false }),
      targetedReconciliation: async () => {
        events.push("targeted");
        return false;
      },
      priorityStateCache: async () => {
        events.push("priority");
        return false;
      },
      activeReconciliation: async () => {
        events.push("active");
        return false;
      },
      backgroundStateCache: async () => {
        events.push("state-cache");
        return true;
      },
      adoption: async (rpcTaskRan) => {
        events.push(`adoption:${rpcTaskRan}`);
      },
    });
    expect(events).toEqual(["active", "state-cache", "adoption:true"]);
  });

  it("continues one bounded active unit per outer cycle when no direct lookup is queued", async () => {
    const remaining = ["position-1", "position-2", "position-3"],
      processed: string[] = [];
    const activeReconciliation = async () => {
      const position = remaining.shift();
      if (!position) return false;
      processed.push(position);
      return true;
    };
    const noWork = async () => false;
    const state = createStateCacheSchedulerState();
    for (let cycle = 0; cycle < 3; cycle++)
      await runStateCacheWorkerCycle({
        state,
        priorityWork: () => ({ p0: false, p1: false }),
        targetedReconciliation: noWork,
        priorityStateCache: noWork,
        activeReconciliation,
        backgroundStateCache: noWork,
        adoption: async () => {},
      });
    expect(processed).toEqual(["position-1", "position-2", "position-3"]);
    expect(new Set(processed).size).toBe(3);
    expect(remaining).toEqual([]);
  });
  it("services P1 at the next safe boundary after a saturated P3 chunk", async () => {
    const events: string[] = [];
    let p1 = false;
    const state = createStateCacheSchedulerState();
    const cycle = () =>
      runStateCacheWorkerCycle({
        state,
        priorityWork: () => ({ p0: false, p1 }),
        targetedReconciliation: async () => false,
        priorityStateCache: async () => {
          events.push("p1");
          p1 = false;
          return true;
        },
        activeReconciliation: async () => false,
        backgroundStateCache: async () => {
          events.push("p3");
          p1 = true;
          return true;
        },
        adoption: async () => {},
      });
    await cycle();
    await cycle();
    expect(events).toEqual(["p3", "p1"]);
  });
  it("does not drain a 7,950-row-equivalent P3 backlog before servicing a newly arrived P1", async () => {
    let backgroundRemaining = 7_950,
      p1 = false;
    const events: string[] = [],
      state = createStateCacheSchedulerState();
    const cycle = () =>
      runStateCacheWorkerCycle({
        state,
        priorityWork: () => ({ p0: false, p1 }),
        targetedReconciliation: async () => false,
        priorityStateCache: async () => {
          events.push("p1");
          p1 = false;
          return true;
        },
        activeReconciliation: async () => false,
        backgroundStateCache: async () => {
          backgroundRemaining -= 16;
          events.push("p3:16");
          p1 = true;
          return true;
        },
        adoption: async () => {},
      });
    await cycle();
    await cycle();
    expect(events).toEqual(["p3:16", "p1"]);
    expect(backgroundRemaining).toBe(7_934);
  });
  it("hides an exact operational OPEN pool refresh from every background/legacy lease and exposes it only to urgent ownership", () => {
    const dir = mkdtempSync(join(tmpdir(), "priority-open-pool-")),
      path = join(dir, "db.sqlite");
    migrateSqlite(path, "infra/migrations");
    const repo = new SqliteLedgerRepository(path),
      id = "0x" + "0a".repeat(32);
    try {
      repo.upsertV4RegistryPool({
        poolId: id,
        currency0: "0x0000000000000000000000000000000000000001",
        currency1: "0x0000000000000000000000000000000000000002",
        initializeFeeRaw: 500,
        tickSpacing: 10,
        hooks: "0x0000000000000000000000000000000000000000",
        initializationBlock: 1n,
        dynamicFee: false,
        staticFeePips: 500,
        hookClassification: "ZERO_HOOK",
      });
      repo.enqueueV4StateRefresh(
        id,
        900,
        "OPERATIONAL_OPEN_POOL_FRESHNESS",
        1_000,
      );
      expect(runnablePriorityWork(repo.db, 1_001)).toEqual({
        p0: false,
        p1: false,
      });
      expect(
        leasePriorityDirectLookupRefresh(repo.db, 4, 60_000, 1_001),
      ).toEqual([]);
      expect(
        leaseUrgentStateRefresh(repo.db, 4, 60_000, "urgent-open", 1_001),
      ).toMatchObject([{ pool_id: id, lease_owner: "urgent-open" }]);
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("bounds priority service and still advances P2 and P3 under sustained pressure", async () => {
    const events: string[] = [];
    const state = createStateCacheSchedulerState();
    const cycle = () =>
      runStateCacheWorkerCycle({
        state,
        priorityWork: () => ({ p0: true, p1: true }),
        targetedReconciliation: async () => {
          events.push("p0");
          return true;
        },
        priorityStateCache: async () => {
          events.push("p1");
          return true;
        },
        activeReconciliation: async () => {
          events.push("p2");
          return true;
        },
        backgroundStateCache: async () => {
          events.push("p3");
          return true;
        },
        adoption: async () => {},
      });
    for (let turn = 0; turn < 10; turn++) await cycle();
    expect(events).toEqual([
      "p0",
      "p1",
      "p0",
      "p1",
      "p2",
      "p0",
      "p1",
      "p0",
      "p1",
      "p3",
    ]);
  });
  it("services both urgent lanes within two turns regardless of continuous work in the other lane", async () => {
    for (const cursor of [0, 1] as const) {
      const events: string[] = [],
        state = createStateCacheSchedulerState();
      state.priorityCursor = cursor;
      const cycle = () =>
        runStateCacheWorkerCycle({
          state,
          priorityWork: () => ({ p0: true, p1: true }),
          targetedReconciliation: async () => {
            events.push("p0");
            return true;
          },
          priorityStateCache: async () => {
            events.push("p1");
            return true;
          },
          activeReconciliation: async () => false,
          backgroundStateCache: async () => false,
          adoption: async () => {},
        });
      await cycle();
      await cycle();
      expect(new Set(events)).toEqual(new Set(["p0", "p1"]));
    }
  });
  it("services five P0 NFTs and one P1 pool in bounded turns without draining an 8k P3 backlog", async () => {
    let p0 = 5,
      p1 = 1,
      p3 = 8_000;
    const events: string[] = [],
      state = createStateCacheSchedulerState();
    for (let turn = 0; turn < 2; turn++)
      await runStateCacheWorkerCycle({
        state,
        priorityWork: () => ({ p0: p0 > 0, p1: p1 > 0 }),
        targetedReconciliation: async () => {
          events.push(`p0:${p0}`);
          p0 = 0;
          return true;
        },
        priorityStateCache: async () => {
          events.push("p1");
          p1 = 0;
          return true;
        },
        activeReconciliation: async () => false,
        backgroundStateCache: async () => {
          p3 -= 16;
          return true;
        },
        adoption: async () => {},
      });
    expect(events).toEqual(["p0:5", "p1"]);
    expect(p3).toBe(8_000);
  });
  it("leases queued priority-90 direct lookup rows in a bounded prephase without taking active or bulk rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "priority-state-")),
      path = join(dir, "db.sqlite");
    migrateSqlite(path, "infra/migrations");
    const repo = new SqliteLedgerRepository(path),
      ids = [
        "0x" + "01".repeat(32),
        "0x" + "02".repeat(32),
        "0x" + "03".repeat(32),
        "0x" + "04".repeat(32),
      ];
    try {
      for (const id of ids)
        repo.upsertV4RegistryPool({
          poolId: id,
          currency0: "0x0000000000000000000000000000000000000001",
          currency1: "0x0000000000000000000000000000000000000002",
          initializeFeeRaw: 500,
          tickSpacing: 10,
          hooks: "0x0000000000000000000000000000000000000000",
          initializationBlock: 1n,
          dynamicFee: false,
          staticFeePips: 500,
          hookClassification: "ZERO_HOOK",
        });
      for (const [id, priority, reason] of [
        [ids[0], 90, "recent-token-lookup"],
        [ids[1], 90, "recent-telegram-token"],
        [ids[2], 120, "active-wallet-position"],
        [ids[3], 50, "fair-registry-refresh"],
      ] as const)
        repo.enqueueV4StateRefresh(id, priority, reason, 1_000);
      const leased = leasePriorityDirectLookupRefresh(
        repo.db,
        1,
        60_000,
        1_001,
      );
      expect(leased.map((row) => row.pool_id)).toEqual([ids[0]]);
      const states = new Map(
        (
          repo.db
            .prepare(
              "SELECT pool_id,leased_until_ms FROM v4_state_refresh_queue",
            )
            .all() as Array<{ pool_id: string; leased_until_ms: number | null }>
        ).map((row) => [row.pool_id, row.leased_until_ms]),
      );
      expect(states.get(ids[0])).toBe(61001);
      expect(states.get(ids[1])).toBeNull();
      expect(states.get(ids[2])).toBeNull();
      expect(states.get(ids[3])).toBeNull();
      expect(
        leasePriorityDirectLookupRefresh(repo.db, 4, 60_000, 1_002).map(
          (row) => row.pool_id,
        ),
      ).toEqual([ids[1]]);
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("deterministically re-leases an expired direct-lookup refresh lease", () => {
    const dir = mkdtempSync(join(tmpdir(), "priority-expiry-")),
      path = join(dir, "db.sqlite");
    migrateSqlite(path, "infra/migrations");
    const repo = new SqliteLedgerRepository(path),
      id = "0x" + "09".repeat(32);
    try {
      repo.upsertV4RegistryPool({
        poolId: id,
        currency0: "0x0000000000000000000000000000000000000001",
        currency1: "0x0000000000000000000000000000000000000002",
        initializeFeeRaw: 500,
        tickSpacing: 10,
        hooks: "0x0000000000000000000000000000000000000000",
        initializationBlock: 1n,
        dynamicFee: false,
        staticFeePips: 500,
        hookClassification: "ZERO_HOOK",
      });
      repo.enqueueV4StateRefresh(id, 90, "recent-token-lookup", 1_000);
      expect(
        leasePriorityDirectLookupRefresh(repo.db, 1, 100, 1_001),
      ).toHaveLength(1);
      expect(
        leasePriorityDirectLookupRefresh(repo.db, 1, 100, 1_100),
      ).toHaveLength(0);
      const released = leasePriorityDirectLookupRefresh(repo.db, 1, 100, 1_102);
      expect(released).toHaveLength(1);
      expect(released[0]).toMatchObject({ pool_id: id });
      expect(
        repo.db
          .prepare(
            "SELECT leased_until_ms FROM v4_state_refresh_queue WHERE pool_id=?",
          )
          .get(id),
      ).toEqual({ leased_until_ms: 1202 });
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("prevents an unleased direct refresh from consuming a queued OPEN obligation", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-refresh-race-")),
      path = join(dir, "db.sqlite");
    migrateSqlite(path, "infra/migrations");
    const repo = new SqliteLedgerRepository(path),
      id = "0x" + "07".repeat(32);
    try {
      repo.upsertV4RegistryPool({
        poolId: id,
        currency0: "0x0000000000000000000000000000000000000001",
        currency1: "0x0000000000000000000000000000000000000002",
        initializeFeeRaw: 500,
        tickSpacing: 10,
        hooks: "0x0000000000000000000000000000000000000000",
        initializationBlock: 1n,
        dynamicFee: false,
        staticFeePips: 500,
        hookClassification: "ZERO_HOOK",
      });
      repo.enqueueV4StateRefresh(
        id,
        900,
        "OPERATIONAL_OPEN_POOL_FRESHNESS",
        1_000,
      );
      repo.refreshV4RegistryPool({
        poolId: id,
        sqrtPriceX96: 1n,
        tick: 0,
        liquidity: 1n,
        protocolFee: 0,
        lpFeePips: 500,
        initialized: true,
        refreshBlock: 2n,
        validationStatus: "ELIGIBLE",
        blockers: [],
      });
      repo.completeV4StateRefresh(id);
      expect(
        repo.db
          .prepare(
            "SELECT priority,reason,leased_until_ms FROM v4_state_refresh_queue WHERE pool_id=?",
          )
          .get(id),
      ).toEqual({
        priority: 900,
        reason: "OPERATIONAL_OPEN_POOL_FRESHNESS",
        leased_until_ms: null,
      });
      expect(
        leasePriorityDirectLookupRefresh(repo.db, 1, 60_000, 1_001),
      ).toEqual([]);
      expect(
        leaseUrgentStateRefresh(repo.db, 1, 60_000, "urgent-race", 1_001),
      ).toHaveLength(1);
      repo.completeV4StateRefresh(id, "urgent-race");
      expect(
        repo.db
          .prepare("SELECT 1 FROM v4_state_refresh_queue WHERE pool_id=?")
          .get(id),
      ).toBeUndefined();
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("detects runnable priority rows without leasing them", () => {
    const dir = mkdtempSync(join(tmpdir(), "priority-wake-")),
      path = join(dir, "db.sqlite");
    migrateSqlite(path, "infra/migrations");
    const repo = new SqliteLedgerRepository(path),
      id = "0x" + "08".repeat(32);
    try {
      repo.ensurePosition("v4:8", "8", id);
      repo.db
        .prepare(
          "INSERT INTO targeted_position_reconciliation_requests(position_id,lane,token_id,protocol_version,reason,priority,requested_at_ms,available_at_ms) VALUES('v4:8','background','8','v4','OPEN',1000,1,1)",
        )
        .run();
      repo.upsertV4RegistryPool({
        poolId: id,
        currency0: "0x0000000000000000000000000000000000000001",
        currency1: "0x0000000000000000000000000000000000000002",
        initializeFeeRaw: 500,
        tickSpacing: 10,
        hooks: "0x0000000000000000000000000000000000000000",
        initializationBlock: 1n,
        dynamicFee: false,
        staticFeePips: 500,
        hookClassification: "ZERO_HOOK",
      });
      repo.enqueueV4StateRefresh(id, 90, "recent-token-lookup", 1);
      expect(runnablePriorityWork(repo.db, 2)).toEqual({ p0: true, p1: true });
      expect(
        repo.db
          .prepare(
            "SELECT leased_until_ms FROM targeted_position_reconciliation_requests",
          )
          .get(),
      ).toEqual({ leased_until_ms: null });
      expect(
        repo.db
          .prepare("SELECT leased_until_ms FROM v4_state_refresh_queue")
          .get(),
      ).toEqual({ leased_until_ms: null });
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("assigns direct lookup execution to exactly one production worker", () => {
    const state = readFileSync(
        "apps/workers/src/state-cache-worker.ts",
        "utf8",
      ),
      dedicated = readFileSync(
        "apps/workers/src/direct-lookup-worker.ts",
        "utf8",
      ),
      ecosystem = readFileSync("infra/pm2/ecosystem.config.cjs", "utf8"),
      packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(state).not.toMatch(
      /leaseDirectTokenLookup|executeDirectTokenLookup|directLookupPhase/,
    );
    expect(dedicated).toMatch(
      /leaseDirectTokenLookup[\s\S]*executeDirectTokenLookup/,
    );
    expect(
      ecosystem.match(/app\(\s*["']funi-v4-direct-lookup-worker["']/g),
    ).toHaveLength(1);
    expect(packageJson.scripts["pm2-sync-funi"]).toBe(
      "pm2 startOrReload infra/pm2/ecosystem.config.cjs --update-env",
    );
  });
  it("reports pool and NFT freshness timing independently without claiming one proves the other", () => {
    const source = readFileSync(
        "apps/workers/src/state-cache-worker.ts",
        "utf8",
      ),
      open = readFileSync("apps/cli/src/v4-bid-ladder-live.ts", "utf8"),
      reposition = readFileSync(
        "apps/cli/src/v4-bid-ladder-usdg-reset.ts",
        "utf8",
      );
    for (const field of [
      "queueWaitMs",
      "rpcDurationMs",
      "persistenceDurationMs",
      "openToPoolFreshMs",
      "openToNftVerifiedMs",
      "fullyActionableLadders",
    ])
      expect(source).toContain(field);
    expect(open).toContain("openReceiptTimestampMs");
    expect(open).toContain("nftTargetedEnqueuedAtMs");
    expect(reposition).toContain("REPOSITION_ON_DEMAND_POOL_FRESHNESS");
    expect(reposition).toContain("FRESH_STATE_UNAVAILABLE");
    expect(reposition).toContain(
      "v4_bid_ladder_reposition_pool_refresh_completed",
    );
  });
});
