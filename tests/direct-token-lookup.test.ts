import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAddress, zeroAddress } from "viem";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import { robinhoodMainnet } from "@funi/core";
import { poolId } from "@funi/v4";
import {
  allocateDirectLookupCandidates,
  applyDirectLookupCandidatePresentation,
  attachDirectLookupSubscriber,
  cleanupLegacyDirectLookupFanout,
  completeDirectLookupOutbox,
  completeDirectTokenLookup,
  createOrReuseDirectLookup,
  DIRECT_LOOKUP_TERMINAL_STATUSES,
  directLookupCandidateLifecycle,
  directLookupCandidatePoolIds,
  directLookupFairnessCursor,
  directLookupRpcCandidatePoolIds,
  executeDirectTokenLookup,
  expireDueDirectTokenLookups,
  leaseDirectLookupOutbox,
  leaseDirectTokenLookup,
  retryDirectLookupOutbox,
  settleDirectLookupCandidateRefresh,
} from "../apps/cli/src/direct-token-lookup.js";
import { cachedV4PoolsForToken } from "../apps/cli/src/v4-registry.js";
import { runDedicatedDirectLookupCycle } from "../apps/workers/src/direct-lookup-worker.js";
import { v4PoolSelectionLabel } from "../apps/telegram-lp-bot/src/pool-selection-ux.js";

const token = getAddress("0xc200000000000000000000000000000000000042");
function keyAt(index: number, target = token, fee = 500 + index) {
  const quote =
      index % 2 ? robinhoodMainnet.assets.WETH : robinhoodMainnet.assets.USDG,
    [currency0, currency1] = [target, quote].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    ) as [typeof target, typeof quote];
  return { currency0, currency1, fee, tickSpacing: 10, hooks: zeroAddress };
}
const poolIdAt = (index: number) => poolId(keyAt(index));
function fixture(count = 180) {
  const dir = mkdtempSync(join(tmpdir(), "direct-lookup-")),
    path = join(dir, "test.sqlite");
  migrateSqlite(path, "infra/migrations");
  const repo = new SqliteLedgerRepository(path);
  repo.upsertTokenMetadata({
    address: token,
    symbol: "TEST",
    name: "Test",
    decimals: 18,
  });
  for (let i = 0; i < count; i++) {
    const key = keyAt(i);
    repo.upsertV4RegistryPool({
      poolId: poolId(key),
      currency0: key.currency0,
      currency1: key.currency1,
      initializeFeeRaw: key.fee,
      tickSpacing: key.tickSpacing,
      hooks: key.hooks,
      initializationBlock: BigInt(1000 + i),
      dynamicFee: false,
      staticFeePips: key.fee,
      hookClassification: "ZERO_HOOK",
    });
  }
  return {
    repo,
    close() {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function rpc(liquidity = 1n, fail = false) {
  const client = {
    getBlockNumber: async () => 100n,
    multicall: async (input: any) => {
      if (fail) throw new Error("provider timeout");
      return input.contracts.map((_: unknown, index: number) => ({
        status: "success",
        result: index % 2 === 0 ? [2n ** 96n, 0, 0, 500] : liquidity,
      }));
    },
  };
  return {
    config: {},
    metrics: { fallbackUses: 0 },
    withClient: async (work: any) => work(client, "mock"),
  } as any;
}
function laneRpc(
  lanes: Array<{ liquidity: bigint[]; fail?: boolean; advanceMs?: number }>,
  advance?: (ms: number) => void,
) {
  let call = 0;
  return {
    config: {},
    metrics: { fallbackUses: 0 },
    withClient: async (work: any) => {
      const lane = lanes[call++] ?? lanes.at(-1)!;
      advance?.(lane.advanceMs ?? 0);
      const client = {
        getBlockNumber: async () => 100n,
        multicall: async (input: any) => {
          if (lane.fail) throw new Error("provider timeout");
          return input.contracts.map((_: unknown, index: number) => ({
            status: "success",
            result:
              index % 2 === 0
                ? [2n ** 96n, 0, 0, 500]
                : (lane.liquidity[Math.floor(index / 2)] ?? 0n),
          }));
        },
      };
      return work(client, "mock");
    },
  } as any;
}
function stateRpc(
  states: Array<{ initialized: boolean; liquidity: bigint } | "failed">,
) {
  let offset = 0,
    calls = 0;
  return {
    rpc: {
      config: {},
      metrics: { fallbackUses: 0 },
      withClient: async (work: any) => {
        const client = {
          getBlockNumber: async () => 100n,
          multicall: async (input: any) => {
            const count = input.contracts.length / 2,
              start = offset;
            offset += count;
            calls += count;
            return input.contracts.map((_: unknown, index: number) => {
              const state = states[start + Math.floor(index / 2)] ?? {
                initialized: false,
                liquidity: 0n,
              };
              if (state === "failed")
                return {
                  status: "failure",
                  error: new Error("member unavailable"),
                };
              return {
                status: "success",
                result:
                  index % 2 === 0
                    ? [state.initialized ? 2n ** 96n : 0n, 0, 0, 500]
                    : state.liquidity,
              };
            });
          },
        };
        return work(client, "mock");
      },
    } as any,
    get calls() {
      return calls;
    },
  };
}
function markFast(
  repo: SqliteLedgerRepository,
  indexes: number[],
  now: number,
  liquidity = 1n,
) {
  const update = repo.db.prepare(
    "UPDATE v4_pool_registry SET active_liquidity_raw=?,initialized=1,validation_status='ELIGIBLE',last_refreshed_at=? WHERE pool_id=?",
  );
  for (const index of indexes)
    update.run(
      liquidity.toString(),
      new Date(now).toISOString(),
      poolIdAt(index),
    );
}
function addPool(repo: SqliteLedgerRepository, index: number, fee: number) {
  const key = keyAt(index, token, fee),
    id = poolId(key);
  repo.upsertV4RegistryPool({
    poolId: id,
    currency0: key.currency0,
    currency1: key.currency1,
    initializeFeeRaw: fee,
    tickSpacing: key.tickSpacing,
    hooks: key.hooks,
    initializationBlock: BigInt(2_000 + index),
    dynamicFee: false,
    staticFeePips: fee,
    hookClassification: "ZERO_HOOK",
  });
  return id;
}

describe("durable direct token lookup", () => {
  it("fresh-evidence refresh bypasses a terminal result while preserving in-flight deduplication", () => {
    const f = fixture(1),
      now = 1_000;
    try {
      const first = createOrReuseDirectLookup({
        repo: f.repo,
        token,
        nowMs: now,
      });
      const same = createOrReuseDirectLookup({
        repo: f.repo,
        token,
        nowMs: now + 1,
        refreshStaleEvidence: true,
      });
      expect(same).toMatchObject({
        created: false,
        deduplicated: true,
        cacheHit: false,
      });
      completeDirectTokenLookup(f.repo, {
        requestId: first.request.id,
        requestRevision: first.request.revision,
        status: "NO_ACTIVE_LIQUIDITY_POOL",
        reasonCode: "NO_FRESH_POSITIVE_ACTIVE_LIQUIDITY",
        candidatePoolCount: 1,
        hydratedPoolCount: 1,
        eligiblePoolIds: [],
        providerResult: "zero",
        rpcAttribution: {},
        nowMs: now + 2,
      });
      const retry = createOrReuseDirectLookup({
        repo: f.repo,
        token,
        nowMs: now + 3,
        refreshStaleEvidence: true,
      });
      expect(retry).toMatchObject({
        created: true,
        deduplicated: false,
        cacheHit: false,
      });
      expect(retry.request.revision).toBe(2);
    } finally {
      f.close();
    }
  });
  it("dedicated worker leases, releases the RPC lease before outbox persistence, and completes", async () => {
    const f = fixture(12);
    try {
      const created = createOrReuseDirectLookup({
        repo: f.repo,
        token,
        nowMs: 1_000,
        deadlineMs: 10_000,
      });
      attachDirectLookupSubscriber({
        repo: f.repo,
        requestId: created.request.id,
        requestRevision: created.request.revision,
        interactionId: "dedicated",
        userId: "u",
        chatId: "c",
        messageId: 9,
        sessionId: "s",
        nowMs: 1_010,
      });
      f.repo.db.exec(
        `CREATE TRIGGER assert_direct_lookup_rpc_lease_released BEFORE INSERT ON direct_token_lookup_outbox BEGIN SELECT CASE WHEN COALESCE((SELECT leased_until_ms FROM state_cache_rpc_budget_leases WHERE lane='background'),0)>2000 THEN RAISE(ABORT,'RPC_LEASE_HELD_DURING_OUTBOX') END; END`,
      );
      const cycle = await runDedicatedDirectLookupCycle({
        repo: f.repo,
        rpc: rpc(),
        candidateBudget: 12,
        maxRpcBatches: 1,
        now: () => 2_000,
      });
      expect(cycle.status).toBe("COMPLETED");
      expect(
        f.repo.db
          .prepare(
            "SELECT status,attempts FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(created.request.id),
      ).toMatchObject({ status: "SUPPORTED_POOLS_FOUND", attempts: 1 });
      expect(
        f.repo.db
          .prepare(
            "SELECT status FROM direct_token_lookup_outbox WHERE request_id=?",
          )
          .get(created.request.id),
      ).toEqual({ status: "PENDING" });
      expect(
        f.repo.db
          .prepare(
            "SELECT leased_until_ms FROM state_cache_rpc_budget_leases WHERE lane='background'",
          )
          .get(),
      ).toEqual({ leased_until_ms: 2_000 });
    } finally {
      f.close();
    }
  });
  it("defers without RPC when the shared lease is busy and safely requeues the durable request", async () => {
    const f = fixture(1);
    try {
      const created = createOrReuseDirectLookup({
        repo: f.repo,
        token,
        nowMs: 1_000,
      });
      f.repo.db
        .prepare(
          "INSERT INTO state_cache_rpc_budget_leases(lane,owner_id,leased_until_ms,updated_at_ms) VALUES('background','other-worker',5000,1000)",
        )
        .run();
      let rpcCalls = 0;
      const blockedRpc = {
          withClient: async () => {
            rpcCalls++;
            throw new Error("must not call");
          },
        } as any,
        cycle = await runDedicatedDirectLookupCycle({
          repo: f.repo,
          rpc: blockedRpc,
          now: () => 2_000,
        });
      expect(cycle.status).toBe("RPC_LEASE_BUSY");
      expect(rpcCalls).toBe(0);
      expect(
        f.repo.db
          .prepare(
            "SELECT status,leased_until_ms,attempts FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(created.request.id),
      ).toMatchObject({ status: "QUEUED", leased_until_ms: null, attempts: 1 });
    } finally {
      f.close();
    }
  });
  it("keeps the fixed deadline and identifies a request no worker ever leased", async () => {
    const f = fixture(1);
    try {
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: 1_000,
          deadlineMs: 500,
        }),
        cycle = await runDedicatedDirectLookupCycle({
          repo: f.repo,
          rpc: rpc(),
          now: () => 1_501,
        });
      expect(cycle.status).toBe("EXPIRED");
      expect(
        cycle.stages.find((stage) => stage.stage === "request_lease_end"),
      ).toMatchObject({
        leaseResult: "EXPIRED_BEFORE_LEASE",
        deadlineOverrunMs: 1,
      });
      expect(
        f.repo.db
          .prepare(
            "SELECT status,reason_code,provider_result,attempts FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(created.request.id) as any,
      ).toMatchObject({
        status: "LOOKUP_TIMED_OUT",
        reason_code: "DIRECT_LOOKUP_WORKER_NOT_LEASED",
        provider_result: "worker_stalled",
        attempts: 0,
      });
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM rpc_read_work_lease")
          .get(),
      ).toEqual({ count: 0 });
      expect(DIRECT_LOOKUP_TERMINAL_STATUSES).toEqual([
        "SUPPORTED_POOLS_FOUND",
        "NO_ACTIVE_LIQUIDITY_POOL",
        "PROVIDER_TEMPORARILY_UNAVAILABLE",
        "LOOKUP_TIMED_OUT",
        "REQUEST_EXPIRED",
      ]);
    } finally {
      f.close();
    }
  });
  it("separates request, candidate, split RPC, completion, outbox, and outer-cycle timing without sleeps", async () => {
    const f = fixture(12);
    try {
      const created = createOrReuseDirectLookup({
        repo: f.repo,
        token,
        nowMs: 1_000,
        deadlineMs: 10_000,
      });
      attachDirectLookupSubscriber({
        repo: f.repo,
        requestId: created.request.id,
        requestRevision: created.request.revision,
        interactionId: "timing",
        userId: "u",
        chatId: "c",
        messageId: 1,
        sessionId: "s",
        nowMs: 1_001,
      });
      let clock = 1_100;
      const timedRpc = rpc();
      const original = timedRpc.withClient;
      timedRpc.withClient = async (work: any, options: any) => {
        clock += 900;
        return original(work, options);
      };
      const cycle = await runDedicatedDirectLookupCycle({
        repo: f.repo,
        rpc: timedRpc,
        now: () => clock,
        busy: async (operation, work) => {
          const value = work();
          if (operation === "direct_lookup_lease") clock += 30;
          return value;
        },
        onStage: (record) => {
          if (record.stage === "candidate_discovery_start") clock += 40;
          if (record.stage === "completion_persistence_start") clock += 60;
        },
      });
      expect(cycle.status).toBe("COMPLETED");
      const by = (name: string) =>
          cycle.stages.find((stage) => stage.stage === name)!,
        rpcEnds = cycle.stages.filter((stage) => stage.stage === "rpc_end");
      expect(by("request_lease_end")).toMatchObject({
        leaseResult: "LEASED",
        elapsedMs: 30,
      });
      expect(by("candidate_discovery_end").elapsedMs).toBe(40);
      expect(rpcEnds).toHaveLength(2);
      expect(rpcEnds[0]).toMatchObject({
        elapsedMs: 900,
        multicallCount: 1,
        multicallMembers: 12,
        lane: "FAST",
      });
      expect(rpcEnds[1]).toMatchObject({
        elapsedMs: 900,
        multicallCount: 1,
        multicallMembers: 12,
        lane: "FAIRNESS",
      });
      expect(
        Number(by("completion_persistence_end").atMs) -
          Number(by("completion_persistence_start").atMs),
      ).toBe(60);
      expect(by("outbox_persistence_complete")).toMatchObject({
        outboxCreated: 1,
      });
      const outer =
        Number(by("cycle_end").atMs) - Number(by("cycle_start").atMs);
      expect(outer).toBeGreaterThan(900);
      const row = f.repo.db
          .prepare(
            "SELECT rpc_attribution_json FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(created.request.id) as any,
        metrics = JSON.parse(row.rpc_attribution_json);
      expect(metrics.workerMs).not.toBe(outer);
    } finally {
      f.close();
    }
  });
  it("bounds a 180-pool token to one request, twelve candidates and two RPC sub-batches", async () => {
    const f = fixture();
    try {
      const first = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: 1_000,
          deadlineMs: 10_000,
        }),
        duplicate = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: 1_100,
          deadlineMs: 10_000,
        });
      expect(first.created).toBe(true);
      expect(duplicate).toMatchObject({ created: false, deduplicated: true });
      expect(duplicate.request.id).toBe(first.request.id);
      attachDirectLookupSubscriber({
        repo: f.repo,
        requestId: first.request.id,
        requestRevision: first.request.revision,
        interactionId: "interaction-1",
        userId: "u",
        chatId: "c",
        messageId: 7,
        sessionId: "s",
        nowMs: 1_200,
      });
      const leased = leaseDirectTokenLookup(f.repo, 10_000, 1_300)!;
      expect(leased.id).toBe(first.request.id);
      const done = await executeDirectTokenLookup({
        repo: f.repo,
        rpc: rpc(),
        request: leased,
        candidateBudget: 12,
        maxRpcBatches: 1,
        now: () => 2_000,
      });
      expect(done).toMatchObject({ completed: true, stale: false });
      const row = f.repo.db
          .prepare("SELECT * FROM direct_token_lookup_requests WHERE id=?")
          .get(first.request.id) as any,
        metrics = JSON.parse(row.rpc_attribution_json);
      expect(row.provider_result).toBe("partial_terminal");
      expect(row).toMatchObject({
        status: "SUPPORTED_POOLS_FOUND",
        candidate_pool_count: 180,
        hydrated_pool_count: 12,
        eligible_pool_count: 12,
      });
      expect(metrics).toMatchObject({
        ethCallCount: 24,
        eth_blockNumberCount: 2,
        multicallCount: 2,
        multicallMembers: 24,
        rpcCallCount: 4,
        queueJobsCreated: 12,
        terminalCandidateCount: 180,
        unavailableCandidateCount: 168,
      });
      expect(
        directLookupCandidateLifecycle(
          f.repo,
          first.request.id,
          first.request.revision,
        ).filter((item) =>
          ["DISCOVERED", "REFRESH_REQUESTED", "LEASED"].includes(item.state),
        ),
      ).toEqual([]);
      expect(leaseDirectLookupOutbox(f.repo, 5_000, 2_100)).toMatchObject({
        request_id: first.request.id,
        interaction_id: "interaction-1",
      });
      expect(
        completeDirectTokenLookup(f.repo, {
          requestId: first.request.id,
          requestRevision: first.request.revision,
          status: "NO_ACTIVE_LIQUIDITY_POOL",
          candidatePoolCount: 0,
          hydratedPoolCount: 0,
          eligiblePoolIds: [],
          providerResult: "late",
          rpcAttribution: {},
          reasonCode: "STALE",
          nowMs: 2_200,
        }),
      ).toEqual({ completed: false, stale: true });
    } finally {
      f.close();
    }
  });
  it("hydrates high-fee static pools but preserves dynamic, hook, and execution safety boundaries", async () => {
    const f = fixture(6);
    try {
      const ids = directLookupCandidatePoolIds(f.repo, token, 6),
        hook = "0x0000000000000000000000000000000000000001";
      f.repo.db
        .prepare(
          "UPDATE v4_pool_registry SET initialize_fee_raw=?,dynamic_fee=1,static_fee_pips=NULL WHERE pool_id=?",
        )
        .run(0x800000, ids[1]);
      f.repo.db
        .prepare(
          "UPDATE v4_pool_registry SET hooks=?,hook_classification='UNSUPPORTED_NONZERO_HOOK' WHERE pool_id=?",
        )
        .run(hook, ids[2]);
      f.repo.db
        .prepare(
          "UPDATE v4_pool_registry SET initialize_fee_raw=50001,static_fee_pips=50001 WHERE pool_id=?",
        )
        .run(ids[3]);
      const workset = directLookupRpcCandidatePoolIds(f.repo, ids);
      expect(workset.rpcIds).not.toContain(ids[3]);
      expect(workset.blocked.map((item) => item.blockers[0])).toEqual([
        "DYNAMIC_FEE_UNSUPPORTED",
        "NONZERO_HOOK_UNSUPPORTED",
        "EXTREME_STATIC_FEE",
      ]);
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: 1_000,
        }),
        leased = leaseDirectTokenLookup(f.repo, 10_000, 1_001)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: rpc(),
        request: leased,
        candidateBudget: 6,
        maxRpcBatches: 1,
        now: () => 2_000,
      });
      const extreme = cachedV4PoolsForToken({
          repo: f.repo,
          token,
          now: 2_001,
        }).candidates.find((item) => item.poolId === ids[3]),
        lifecycle = directLookupCandidateLifecycle(
          f.repo,
          created.request.id,
          created.request.revision,
        ).find((item) => item.pool_id === ids[3]);
      expect(extreme).toMatchObject({
        executionEligible: false,
        uiState: "UNSUPPORTED:EXTREME_STATIC_FEE",
      });
      expect(lifecycle).toMatchObject({
        state: "UNSUPPORTED",
        reason_code: "EXTREME_STATIC_FEE",
      });
      expect(f.repo.v4RegistryPool(ids[3])?.initialized).toBe(0);
      expect(f.repo.v4RegistryPool(ids[1])?.initialized).toBe(0);
      expect(f.repo.v4RegistryPool(ids[2])?.initialized).toBe(0);
    } finally {
      f.close();
    }
  });
  it("allocates exactly six FAST and six FAIRNESS slots across a large stale tail", () => {
    const f = fixture(120),
      now = Date.now();
    try {
      markFast(f.repo, [0, 1, 2, 3, 4, 5], now - 120_001);
      const allocation = allocateDirectLookupCandidates(f.repo, token, 12, now);
      expect(allocation.candidateIds).toHaveLength(12);
      expect(allocation.fastIds).toHaveLength(6);
      expect(allocation.fairnessIds).toHaveLength(6);
      expect(
        new Set(allocation.candidateIds.map((id) => id.toLowerCase())).size,
      ).toBe(12);
      expect(
        allocation.fairnessIds.every((id) => !allocation.fastIds.includes(id)),
      ).toBe(true);
    } finally {
      f.close();
    }
  });
  it("rolls unused FAST slots into FAIRNESS and deterministically backfills overlap", () => {
    const now = Date.now(),
      two = fixture(120),
      three = fixture(12),
      overlap = fixture(12);
    try {
      markFast(two.repo, [0, 1], now - 120_001);
      const onlyTwo = allocateDirectLookupCandidates(two.repo, token, 12, now);
      expect(onlyTwo.fastIds).toHaveLength(2);
      expect(onlyTwo.fairnessIds).toHaveLength(10);
      markFast(three.repo, [0, 1, 2, 3, 4, 5, 6, 7, 8], now - 120_001);
      const onlyThree = allocateDirectLookupCandidates(
        three.repo,
        token,
        12,
        now,
      );
      expect(onlyThree.fastIds).toHaveLength(6);
      expect(onlyThree.fairnessIds).toHaveLength(6);
      markFast(overlap.repo, [0, 1, 2, 3, 4, 5], 0);
      const dedup = allocateDirectLookupCandidates(
        overlap.repo,
        token,
        12,
        now,
      );
      expect(dedup.fastFairnessOverlap).toBeGreaterThan(0);
      expect(dedup.candidateIds).toHaveLength(12);
      expect(
        new Set(dedup.candidateIds.map((id) => id.toLowerCase())).size,
      ).toBe(12);
    } finally {
      two.close();
      three.close();
      overlap.close();
    }
  });
  it("advances the durable fairness cursor through a 137-candidate tail while FAST may repeat", () => {
    const f = fixture(137),
      now = Date.now();
    try {
      markFast(f.repo, [0, 1, 2, 3, 4, 5], now);
      const visited = new Set<string>(),
        first = allocateDirectLookupCandidates(f.repo, token, 12, now),
        second = allocateDirectLookupCandidates(f.repo, token, 12, now + 1);
      expect(first.fastIds).toEqual(second.fastIds);
      expect(
        first.fairnessIds.some((id) => second.fairnessIds.includes(id)),
      ).toBe(false);
      for (const id of [...first.fairnessIds, ...second.fairnessIds])
        visited.add(id);
      for (let attempt = 2; attempt < 23; attempt++)
        for (const id of allocateDirectLookupCandidates(
          f.repo,
          token,
          12,
          now + attempt,
        ).fairnessIds)
          visited.add(id);
      expect(visited).toContain(poolIdAt(136));
      expect(directLookupFairnessCursor(f.repo, token).nextOffset).not.toBe(0);
    } finally {
      f.close();
    }
  });
  it("skips fresh pools, prioritizes never-refreshed pools, and preserves the cached result", async () => {
    const f = fixture(13),
      now = Date.now();
    try {
      markFast(f.repo, [0, 1, 2, 3, 4, 5, 6], now);
      const preview = allocateDirectLookupCandidates(
          f.repo,
          token,
          12,
          now,
          false,
        ),
        fresh = poolIdAt(0),
        neverRefreshedPoolIds: string[] = [7, 8, 9, 10, 11, 12].map(poolIdAt);
      expect(preview.candidateIds).not.toContain(fresh);
      expect(preview.candidateIds.slice(0, 6).every((id) =>
        neverRefreshedPoolIds.includes(id),
      )).toBe(true);
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: now,
        }),
        leased = leaseDirectTokenLookup(f.repo, 10_000, now + 1)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: rpc(),
        request: leased,
        candidateBudget: 12,
        maxRpcBatches: 1,
        now: () => now + 2,
      });
      const row = f.repo.db
        .prepare(
          "SELECT hydrated_pool_count,eligible_pool_ids_json FROM direct_token_lookup_requests WHERE id=?",
        )
        .get(created.request.id) as any;
      expect(row.hydrated_pool_count).toBe(6);
      expect(JSON.parse(row.eligible_pool_ids_json)).toContain(fresh);
      expect(f.repo.v4RegistryPool(fresh)?.last_refreshed_at).toBe(
        new Date(now).toISOString(),
      );
    } finally {
      f.close();
    }
  });
  it("preserves three fresh cache results and advances fairness after bounded failed attempts", async () => {
    const f = fixture(20),
      now = Date.now();
    try {
      markFast(f.repo, [0, 1, 2], now);
      const before = directLookupFairnessCursor(f.repo, token);
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: now,
        }),
        leased = leaseDirectTokenLookup(f.repo, 20_000, now + 1)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: laneRpc([
          { liquidity: [], fail: true },
          { liquidity: [], fail: true },
        ]),
        request: leased,
        now: () => now + 2,
      });
      const row = f.repo.db
          .prepare(
            "SELECT status,eligible_pool_count,eligible_pool_ids_json,rpc_attribution_json FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(created.request.id) as any,
        metrics = JSON.parse(row.rpc_attribution_json);
      expect(row).toMatchObject({
        status: "SUPPORTED_POOLS_FOUND",
        eligible_pool_count: 3,
      });
      expect(new Set(JSON.parse(row.eligible_pool_ids_json))).toEqual(
        new Set([poolIdAt(0), poolIdAt(1), poolIdAt(2)]),
      );
      expect(metrics).toMatchObject({
        fairnessCommitted: true,
        fairnessCursorBefore: before.nextOffset,
      });
      expect(metrics.fairnessCursorAfter).not.toBe(before.nextOffset);
      expect(directLookupFairnessCursor(f.repo, token).nextOffset).toBe(
        metrics.fairnessCursorAfter,
      );
    } finally {
      f.close();
    }
  });
  it("returns FAST partial success when FAIRNESS times out", async () => {
    const f = fixture(12),
      now = Date.now();
    try {
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: now,
        }),
        leased = leaseDirectTokenLookup(f.repo, 20_000, now + 1)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: laneRpc([
          { liquidity: [1n, 1n, 0n, 0n, 0n, 0n] },
          { liquidity: [], fail: true },
        ]),
        request: leased,
        now: () => now + 2,
      });
      const row = f.repo.db
        .prepare(
          "SELECT status,eligible_pool_count,provider_result FROM direct_token_lookup_requests WHERE id=?",
        )
        .get(created.request.id) as any;
      expect(row).toMatchObject({
        status: "SUPPORTED_POOLS_FOUND",
        eligible_pool_count: 2,
        provider_result: "partial",
      });
    } finally {
      f.close();
    }
  });
  it("returns FAIRNESS discoveries when FAST finds none", async () => {
    const f = fixture(12),
      now = Date.now();
    try {
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: now,
        }),
        leased = leaseDirectTokenLookup(f.repo, 20_000, now + 1)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: laneRpc([
          { liquidity: [0n, 0n, 0n, 0n, 0n, 0n] },
          { liquidity: [1n, 0n, 0n, 0n, 0n, 0n] },
        ]),
        request: leased,
        now: () => now + 2,
      });
      const row = f.repo.db
          .prepare(
            "SELECT status,eligible_pool_count,rpc_attribution_json FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(created.request.id) as any,
        metrics = JSON.parse(row.rpc_attribution_json);
      expect(row).toMatchObject({
        status: "SUPPORTED_POOLS_FOUND",
        eligible_pool_count: 1,
      });
      expect(metrics).toMatchObject({
        multicallCount: 2,
        fairnessCommitted: true,
      });
    } finally {
      f.close();
    }
  });
  it("uses one 15 second deadline and does not advance FAIRNESS when FAST leaves only three seconds", async () => {
    const f = fixture(20);
    let clock = 1_000;
    try {
      markFast(f.repo, [0, 1, 2, 3, 4, 5], clock - 120_001);
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: clock,
        }),
        leased = leaseDirectTokenLookup(f.repo, 20_000, clock + 1)!;
      expect(leased.deadline_at_ms).toBe(16_000);
      const before = directLookupFairnessCursor(f.repo, token).nextOffset,
        stages: any[] = [];
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: laneRpc(
          [{ liquidity: [1n, 1n, 1n, 1n, 1n, 1n], advanceMs: 12_000 }],
          (ms) => {
            clock += ms;
          },
        ),
        request: leased,
        now: () => clock,
        onStage: (stage, extra) => stages.push({ stage, extra }),
      });
      const metrics = JSON.parse(
        (
          f.repo.db
            .prepare(
              "SELECT rpc_attribution_json FROM direct_token_lookup_requests WHERE id=?",
            )
            .get(created.request.id) as any
        ).rpc_attribution_json,
      );
      expect(
        stages
          .filter((item) => item.stage === "rpc_start")
          .map((item) => item.extra.lane),
      ).toEqual(["FAST"]);
      expect(metrics).toMatchObject({
        multicallCount: 1,
        fairnessStarted: false,
        fairnessCommitted: false,
        fairnessCursorAfter: before,
      });
      expect(directLookupFairnessCursor(f.repo, token).nextOffset).toBe(before);
      expect(clock).toBe(13_000);
    } finally {
      f.close();
    }
  });
  it("inspects last-known stale active FAST evidence but correctly downgrades it when fresh StateView liquidity is zero", async () => {
    const f = fixture(20),
      now = Date.now();
    try {
      markFast(f.repo, [0], now - 120_001);
      const allocation = allocateDirectLookupCandidates(
          f.repo,
          token,
          12,
          now,
          false,
        ),
        activeId = poolIdAt(0);
      expect(allocation.fastIds[0]).toBe(activeId);
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: now,
        }),
        leased = leaseDirectTokenLookup(f.repo, 10_000, now + 1)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: rpc(0n),
        request: leased,
        candidateBudget: 12,
        maxRpcBatches: 1,
        now: () => now + 2,
      });
      const candidate = cachedV4PoolsForToken({
        repo: f.repo,
        token,
        now: now + 3,
      }).candidates.find((item) => item.poolId === activeId);
      expect(candidate).toMatchObject({
        executionEligible: false,
        uiState: "SUPPORTED_NO_ACTIVE_LIQUIDITY",
      });
    } finally {
      f.close();
    }
  });
  it("leases ordinary idle and back-to-back requests before their fixed deadlines without a poll sleep", async () => {
    const f = fixture(1),
      second = getAddress("0x0000000000000000000000000000000000000050");
    try {
      const quote = robinhoodMainnet.assets.USDG,
        [currency0, currency1] = [second, quote].sort((a, b) =>
          a.toLowerCase().localeCompare(b.toLowerCase()),
        ) as [typeof second, typeof quote],
        key = {
          currency0,
          currency1,
          fee: 500,
          tickSpacing: 10,
          hooks: zeroAddress,
        },
        secondId = poolId(key);
      f.repo.upsertV4RegistryPool({
        poolId: secondId,
        currency0,
        currency1,
        initializeFeeRaw: 500,
        tickSpacing: 10,
        hooks: zeroAddress,
        initializationBlock: 2n,
        dynamicFee: false,
        staticFeePips: 500,
        hookClassification: "ZERO_HOOK",
      });
      const first = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: 1_000,
          deadlineMs: 10_000,
        }),
        next = createOrReuseDirectLookup({
          repo: f.repo,
          token: second,
          nowMs: 1_001,
          deadlineMs: 10_000,
        });
      const one = await runDedicatedDirectLookupCycle({
          repo: f.repo,
          rpc: rpc(),
          now: () => 1_749,
        }),
        two = await runDedicatedDirectLookupCycle({
          repo: f.repo,
          rpc: rpc(),
          now: () => 1_750,
        });
      expect(one.status).toBe("COMPLETED");
      expect(two.status).toBe("COMPLETED");
      if (!one.request || !two.request)
        throw new Error("BACK_TO_BACK_REQUEST_NOT_LEASED");
      expect([one.request.id, two.request.id]).toEqual([
        first.request.id,
        next.request.id,
      ]);
      expect(
        one.stages.find((stage) => stage.stage === "request_lease_end"),
      ).toMatchObject({ leaseResult: "LEASED", requestAgeMs: 749 });
      expect(
        two.stages.find((stage) => stage.stage === "request_lease_end"),
      ).toMatchObject({ leaseResult: "LEASED", requestAgeMs: 749 });
      const worker = readFileSync(
        "apps/workers/src/direct-lookup-worker.ts",
        "utf8",
      );
      expect(worker).toContain(
        "sleepAfterCycle=cycle.status==='IDLE'||cycle.status==='RPC_LEASE_BUSY'",
      );
    } finally {
      f.close();
    }
  });
  it("terminalizes every candidate when the deadline prevents accelerator work", async () => {
    const f = fixture(173);
    try {
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: 1_000,
          deadlineMs: 10_000,
        }),
        leased = leaseDirectTokenLookup(f.repo, 10_000, 1_100)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: rpc(0n, true),
        request: leased,
        candidateBudget: 9,
        maxRpcBatches: 1,
        now: () => 12_000,
      });
      const row = f.repo.db
          .prepare("SELECT * FROM direct_token_lookup_requests WHERE id=?")
          .get(created.request.id) as any,
        lifecycle = directLookupCandidateLifecycle(
          f.repo,
          created.request.id,
          created.request.revision,
        );
      expect(row.status).toBe("LOOKUP_TIMED_OUT");
      expect(
        f.repo.db
          .prepare(
            "SELECT COUNT(*) count FROM v4_state_refresh_queue WHERE reason='recent-token-lookup'",
          )
          .get(),
      ).toEqual({ count: 9 });
      expect(lifecycle).toHaveLength(173);
      expect(
        lifecycle.filter((item) =>
          ["DISCOVERED", "REFRESH_REQUESTED", "LEASED"].includes(item.state),
        ),
      ).toHaveLength(0);
      expect(directLookupCandidatePoolIds(f.repo, token, 9)).toHaveLength(9);
    } finally {
      f.close();
    }
  });
  it("cleans only legacy fan-out while preserving active-position pool work", () => {
    const f = fixture(3);
    try {
      const ids = directLookupCandidatePoolIds(f.repo, token, 3);
      for (const id of ids)
        f.repo.enqueueV4StateRefresh(id, 90, "recent-telegram-token", 1_000);
      f.repo.upsertV4Position({
        tokenId: 1n,
        owner: "0x0000000000000000000000000000000000000001",
        poolId: ids[0]!,
        poolKey: {
          currency0: token,
          currency1: robinhoodMainnet.assets.USDG,
          fee: 500,
          tickSpacing: 10,
          hooks: zeroAddress,
        },
        currency0: token,
        currency1: robinhoodMainnet.assets.USDG,
        fee: 500,
        tickSpacing: 10,
        hooks: zeroAddress,
        tickLower: -10,
        tickUpper: 10,
        liquidity: 1n,
        initialAmount0: 0n,
        initialAmount1: 0n,
        mintHash: "0x1",
      });
      const result = cleanupLegacyDirectLookupFanout(f.repo, true, 2_000);
      expect(result.removed).toBe(2);
      expect(
        f.repo.db.prepare("SELECT pool_id FROM v4_state_refresh_queue").all(),
      ).toEqual([{ pool_id: ids[0] }]);
    } finally {
      f.close();
    }
  });
  it("keeps cached lookup and Telegram handlers free of hydration polling and fan-out side effects", () => {
    const registry = readFileSync("apps/cli/src/v4-registry.ts", "utf8"),
      telegram = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      cached = registry.slice(
        registry.indexOf("export function cachedV4PoolsForToken"),
        registry.indexOf("export async function v4RegistryStatus"),
      );
    expect(cached).not.toMatch(
      /\bnoteTokenRequest\b|\benqueueV4StateRefresh\b/,
    );
    expect(telegram).not.toMatch(
      /\bscheduleHydrationEdit\b|\bnoChangeRenderCount\b/,
    );
    expect(telegram).toMatch(/\bpollingIterations\s*:\s*0\b/);
  });
  it("times out durably even when no worker ever leases the request", () => {
    const f = fixture(1);
    try {
      const created = createOrReuseDirectLookup({
        repo: f.repo,
        token,
        nowMs: 1_000,
        deadlineMs: 500,
      });
      attachDirectLookupSubscriber({
        repo: f.repo,
        requestId: created.request.id,
        requestRevision: created.request.revision,
        interactionId: "deadline",
        userId: "u",
        chatId: "c",
        messageId: 2,
        sessionId: "s",
        nowMs: 1_010,
      });
      expect(expireDueDirectTokenLookups(f.repo, 1_501)).toBe(1);
      expect(
        f.repo.db
          .prepare(
            "SELECT status,reason_code,provider_result FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(created.request.id),
      ).toMatchObject({
        status: "LOOKUP_TIMED_OUT",
        reason_code: "DIRECT_LOOKUP_WORKER_NOT_LEASED",
        provider_result: "worker_stalled",
      });
      expect(leaseDirectLookupOutbox(f.repo, 1_000, 1_502)).toBeTruthy();
    } finally {
      f.close();
    }
  });
  it("retains normal deadline semantics after a worker has leased the request", () => {
    const f = fixture(1);
    try {
      const created = createOrReuseDirectLookup({
        repo: f.repo,
        token,
        nowMs: 1_000,
        deadlineMs: 500,
      });
      expect(leaseDirectTokenLookup(f.repo, 10_000, 1_100)).toBeTruthy();
      expect(expireDueDirectTokenLookups(f.repo, 1_501)).toBe(1);
      expect(
        f.repo.db
          .prepare(
            "SELECT status,reason_code,provider_result,attempts FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(created.request.id),
      ).toMatchObject({
        status: "LOOKUP_TIMED_OUT",
        reason_code: "DIRECT_LOOKUP_DEADLINE_EXCEEDED",
        provider_result: "deadline",
        attempts: 1,
      });
    } finally {
      f.close();
    }
  });
  it("hydrates a synthetic exact-identity 5 percent pool and keeps the boundary executable", async () => {
    const f = fixture(0),
      syntheticToken = getAddress("0x0000000000000000000000000000000000000043"),
      [currency0, currency1] = [robinhoodMainnet.assets.USDG, syntheticToken].sort(
        (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()),
      ) as [typeof syntheticToken, typeof robinhoodMainnet.assets.USDG],
      key = {
        currency0,
        currency1,
        fee: 50_000,
        tickSpacing: 1_000,
        hooks: zeroAddress,
      },
      id = poolId(key);
    try {
      f.repo.upsertTokenMetadata({
        address: syntheticToken,
        symbol: "ASSET50",
        name: "Synthetic Asset 50",
        decimals: 18,
      });
      f.repo.upsertV4RegistryPool({
        poolId: id,
        currency0: key.currency0,
        currency1: key.currency1,
        initializeFeeRaw: key.fee,
        tickSpacing: key.tickSpacing,
        hooks: key.hooks,
        initializationBlock: 100n,
        dynamicFee: false,
        staticFeePips: 50_000,
        hookClassification: "ZERO_HOOK",
      });
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token: syntheticToken,
          nowMs: 1_000,
        }),
        leased = leaseDirectTokenLookup(f.repo, 10_000, 1_001)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: rpc(1_000n),
        request: leased,
        candidateBudget: 12,
        now: () => 2_000,
      });
      const candidate = cachedV4PoolsForToken({
        repo: f.repo,
        token: syntheticToken,
        now: 2_001,
      }).candidates.find((item) => item.poolId === id);
      expect(candidate).toMatchObject({
        executionEligible: true,
        uiState: "EXECUTABLE",
        feeLabel: "5%",
      });
      expect(candidate?.blockers).not.toContain("EXTREME_STATIC_FEE");
      expect(f.repo.v4RegistryPool(id)).toMatchObject({
        initialized: 1,
        active_liquidity_raw: "1000",
        validation_status: "ELIGIBLE",
      });
    } finally {
      f.close();
    }
  });
  it("converges a synthetic two-pool shape and exposes both fee tiers", async () => {
    const f = fixture(0),
      now = 10_000;
    try {
      const low = addPool(f.repo, 0, 30_000);
      addPool(f.repo, 1, 50_000);
      f.repo.db
        .prepare(
          "UPDATE v4_pool_registry SET active_liquidity_raw='100',initialized=1,validation_status='ELIGIBLE',last_refreshed_at=? WHERE pool_id=?",
        )
        .run(new Date(now).toISOString(), low);
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: now,
        }),
        leased = leaseDirectTokenLookup(f.repo, 20_000, now + 1)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: rpc(1_000n),
        request: leased,
        candidateBudget: 2,
        now: () => now + 2,
      });
      const lifecycle = directLookupCandidateLifecycle(
        f.repo,
        created.request.id,
        created.request.revision,
      );
      expect(lifecycle.map((item) => item.state)).toEqual([
        "ELIGIBLE",
        "ELIGIBLE",
      ]);
      const presented = applyDirectLookupCandidatePresentation(
        f.repo,
        token,
        cachedV4PoolsForToken({ repo: f.repo, token, now: now + 3 }).candidates,
        now + 3,
      );
      expect(presented.filter((item) => item.executionEligible)).toHaveLength(
        2,
      );
      expect(presented.filter((item) => item.uiState === "CHECKING")).toEqual(
        [],
      );
      expect(
        new Set(
          presented
            .filter((item) => item.executionEligible)
            .map((item) => item.feeSemantics.staticFeePips),
        ),
      ).toEqual(new Set([30_000, 50_000]));
    } finally {
      f.close();
    }
  });
  it("terminalizes synthetic zero liquidity and RPC failure without eternal Checking", async () => {
    for (const mode of ["zero", "failure"] as const) {
      const f = fixture(0),
        now = 20_000;
      try {
        addPool(f.repo, 0, 40_000);
        const created = createOrReuseDirectLookup({
            repo: f.repo,
            token,
            nowMs: now,
          }),
          leased = leaseDirectTokenLookup(f.repo, 20_000, now + 1)!;
        await executeDirectTokenLookup({
          repo: f.repo,
          rpc: rpc(mode === "zero" ? 0n : 1n, mode === "failure"),
          request: leased,
          candidateBudget: 1,
          now: () => now + 2,
        });
        const lifecycle = directLookupCandidateLifecycle(
          f.repo,
          created.request.id,
          created.request.revision,
        );
        expect(lifecycle[0]).toMatchObject(
          mode === "zero"
            ? {
                state: "NO_ACTIVE_LIQUIDITY",
                reason_code: "FRESH_ZERO_ACTIVE_LIQUIDITY",
              }
            : {
                state: "EVIDENCE_UNAVAILABLE",
                reason_code: "STATEVIEW_RPC_FAILED",
              },
        );
        const presented = applyDirectLookupCandidatePresentation(
          f.repo,
          token,
          cachedV4PoolsForToken({ repo: f.repo, token, now: now + 3 })
            .candidates,
          now + 3,
        );
        expect(presented.filter((item) => item.uiState === "CHECKING")).toEqual(
          [],
        );
        expect(presented[0]?.uiState).toBe(
          mode === "zero"
            ? "SUPPORTED_NO_ACTIVE_LIQUIDITY"
            : "EVIDENCE_UNAVAILABLE",
        );
      } finally {
        f.close();
      }
    }
  });
  it("recomputes a running parent when state-cache completion settles its final candidate", async () => {
    const f = fixture(1),
      now = 30_000;
    try {
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: now,
        }),
        leased = leaseDirectTokenLookup(f.repo, 20_000, now + 1)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: rpc(1n, true),
        request: leased,
        candidateBudget: 1,
        now: () => now + 2,
      });
      f.repo.db
        .prepare(
          "UPDATE direct_token_lookup_requests SET status='RUNNING',completed_at_ms=NULL WHERE id=?",
        )
        .run(created.request.id);
      f.repo.db
        .prepare(
          "UPDATE direct_token_lookup_candidates SET state='REFRESH_REQUESTED',completed_at_ms=NULL WHERE request_id=?",
        )
        .run(created.request.id);
      f.repo.refreshV4RegistryPool({
        poolId: poolIdAt(0),
        sqrtPriceX96: 2n ** 96n,
        tick: 0,
        liquidity: 99n,
        protocolFee: 0,
        lpFeePips: 500,
        initialized: true,
        refreshBlock: 55n,
        validationStatus: "ELIGIBLE",
        blockers: [],
      });
      expect(
        settleDirectLookupCandidateRefresh(
          f.repo,
          poolIdAt(0),
          "REFRESHED",
          "STATE_CACHE_REFRESHED",
          now + 3,
        ),
      ).toMatchObject({ parents: 1 });
      expect(
        f.repo.db
          .prepare(
            "SELECT status,eligible_pool_count FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(created.request.id),
      ).toMatchObject({
        status: "SUPPORTED_POOLS_FOUND",
        eligible_pool_count: 1,
      });
      expect(
        directLookupCandidateLifecycle(
          f.repo,
          created.request.id,
          created.request.revision,
        )[0],
      ).toMatchObject({ state: "ELIGIBLE", refresh_block: "55" });
    } finally {
      f.close();
    }
  });
  it("rejects a stale completion after an explicit retry creates a newer revision", () => {
    const f = fixture(1);
    try {
      const old = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: 1_000,
        }),
        next = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: 1_100,
          explicitRetry: true,
        });
      expect(next.request.revision).toBe(old.request.revision + 1);
      expect(
        completeDirectTokenLookup(f.repo, {
          requestId: old.request.id,
          requestRevision: old.request.revision,
          status: "SUPPORTED_POOLS_FOUND",
          candidatePoolCount: 1,
          hydratedPoolCount: 1,
          eligiblePoolIds: ["old"],
          providerResult: "late",
          rpcAttribution: {},
          reasonCode: "LATE",
          nowMs: 1_200,
        }),
      ).toEqual({ completed: false, stale: true });
      expect(
        (
          f.repo.db
            .prepare(
              "SELECT status FROM direct_token_lookup_requests WHERE id=?",
            )
            .get(next.request.id) as any
        ).status,
      ).toBe("QUEUED");
    } finally {
      f.close();
    }
  });
  it("delivers an outbox revision once and retries network failure idempotently", () => {
    const f = fixture(1);
    try {
      const created = createOrReuseDirectLookup({
        repo: f.repo,
        token,
        nowMs: 1_000,
      });
      attachDirectLookupSubscriber({
        repo: f.repo,
        requestId: created.request.id,
        requestRevision: created.request.revision,
        interactionId: "i",
        userId: "u",
        chatId: "c",
        messageId: 1,
        sessionId: "s",
        nowMs: 1_010,
      });
      completeDirectTokenLookup(f.repo, {
        requestId: created.request.id,
        requestRevision: created.request.revision,
        status: "NO_ACTIVE_LIQUIDITY_POOL",
        candidatePoolCount: 1,
        hydratedPoolCount: 1,
        eligiblePoolIds: [],
        providerResult: "available",
        rpcAttribution: {},
        reasonCode: "NONE",
        nowMs: 1_020,
      });
      const first = leaseDirectLookupOutbox(f.repo, 1_000, 1_030)! as any;
      expect(
        retryDirectLookupOutbox(
          f.repo,
          String(first.id),
          "telegram timeout",
          3,
          1_040,
        ),
      ).toMatchObject({ failed: false, attempts: 1 });
      const second = leaseDirectLookupOutbox(f.repo, 1_000, 1_300)! as any;
      expect(second.id).toBe(first.id);
      expect(completeDirectLookupOutbox(f.repo, String(second.id), 1_310)).toBe(
        true,
      );
      expect(completeDirectLookupOutbox(f.repo, String(second.id), 1_320)).toBe(
        false,
      );
      expect(leaseDirectLookupOutbox(f.repo, 1_000, 1_400)).toBeUndefined();
    } finally {
      f.close();
    }
  });
  it("uses WAL plus busy timeout and releases write phases before network work", async () => {
    const f = fixture(0);
    try {
      expect(f.repo.db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(f.repo.db.pragma("busy_timeout", { simple: true })).toBe(10_000);
      const holder = spawn(
          process.execPath,
          [
            "-e",
            `const DB=require('better-sqlite3'),db=new DB(${JSON.stringify(f.repo.path)});db.exec('BEGIN IMMEDIATE');process.stdout.write('locked');process.stdin.once('data',()=>{db.exec('COMMIT');db.close();process.stdout.write('released')})`,
          ],
          { cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit"] },
        ),
        writer = spawn(
          process.execPath,
          [
            "-e",
            `const DB=require('better-sqlite3');process.stdin.once('data',()=>{const db=new DB(${JSON.stringify(f.repo.path)});db.pragma('busy_timeout = 10000');process.stdout.write('attempting');db.prepare("INSERT INTO latency_telemetry(metric,duration_ms,fallback_used,context_json,created_at_ms) VALUES('busy-test',0,0,'{}',1)").run();db.close();process.stdout.write('completed')})`,
          ],
          { cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit"] },
        );
      const holderOutput = holder.stdout!,
        writerOutput = writer.stdout!,
        waitFor = (
          output: typeof holderOutput,
          child: ReturnType<typeof spawn>,
          word: string,
        ) =>
          new Promise<void>((resolve, reject) => {
            output.on("data", (chunk) => {
              if (String(chunk).includes(word)) resolve();
            });
            child.once("error", reject);
          }),
        holderClosed = new Promise((resolve) => holder.once("close", resolve)),
        writerClosed = new Promise((resolve) => writer.once("close", resolve));
      await waitFor(holderOutput, holder, "locked");
      let writerCompleted = false;
      writerOutput.on("data", (chunk) => {
        if (String(chunk).includes("completed")) writerCompleted = true;
      });
      const attempting = waitFor(writerOutput, writer, "attempting"),
        holderReleased = waitFor(holderOutput, holder, "released"),
        writerDone = waitFor(writerOutput, writer, "completed");
      writer.stdin.end("attempt");
      await attempting;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writerCompleted).toBe(false);
      holder.stdin.end("release");
      await holderReleased;
      await writerDone;
      expect(writerCompleted).toBe(true);
      await Promise.all([holderClosed, writerClosed]);
      const telegram = readFileSync(
          "apps/telegram-lp-bot/src/index.ts",
          "utf8",
        ),
        outbox = telegram.slice(
          telegram.indexOf("async function deliverDirectLookupOutbox"),
          telegram.indexOf("async function directLookupOutboxConsumer"),
        ),
        workerSource = readFileSync(
          "apps/workers/src/state-cache-worker.ts",
          "utf8",
        ),
        worker = workerSource.slice(
          workerSource.indexOf("async function stateCachePhase"),
          workerSource.indexOf("async function adoptionPhase"),
        );
      expect(outbox.indexOf("renderDb.close()")).toBeLessThan(
        outbox.indexOf("bot.api.editMessageText"),
      );
      expect(worker.indexOf("selectDb.close()")).toBeLessThan(
        worker.indexOf("fetchV4RegistryPoolBatch"),
      );
    } finally {
      f.close();
    }
  });
  it("revalidates fourteen initialized-zero registry candidates across bounded revisions and terminalizes only after complete fresh truth", async () => {
    const f = fixture(15),
      now = 100_000;
    try {
      const zeroId = poolIdAt(14);
      f.repo.refreshV4RegistryPool({
        poolId: zeroId,
        sqrtPriceX96: 2n ** 96n,
        tick: 0,
        liquidity: 0n,
        protocolFee: 0,
        lpFeePips: 514,
        initialized: true,
        refreshBlock: 90n,
        validationStatus: "BLOCKED",
        blockers: ["ZERO_ACTIVE_LIQUIDITY"],
      });
      const first = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: now,
        }),
        firstLease = leaseDirectTokenLookup(f.repo, 20_000, now + 1)!,
        firstRpc = stateRpc(
          Array.from({ length: 12 }, () => ({
            initialized: false,
            liquidity: 0n,
          })),
        );
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: firstRpc.rpc,
        request: firstLease,
        candidateBudget: 12,
        now: () => now + 2,
      });
      const firstRows = directLookupCandidateLifecycle(
          f.repo,
          first.request.id,
          first.request.revision,
        ),
        deferred = firstRows
          .filter(
            (row) =>
              row.reason_code === "BOUNDED_CANDIDATE_BUDGET_NOT_SELECTED",
          )
          .map((row) => row.pool_id);
      expect(firstRpc.calls).toBe(12);
      expect(deferred).toHaveLength(2);
      expect(
        (
          f.repo.db
            .prepare(
              "SELECT status FROM direct_token_lookup_requests WHERE id=?",
            )
            .get(first.request.id) as any
        ).status,
      ).toBe("PROVIDER_TEMPORARILY_UNAVAILABLE");
      const second = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: now + 10,
          refreshStaleEvidence: true,
        }),
        secondLease = leaseDirectTokenLookup(f.repo, 20_000, now + 11)!,
        secondRpc = stateRpc(
          Array.from({ length: 12 }, () => ({
            initialized: false,
            liquidity: 0n,
          })),
        );
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: secondRpc.rpc,
        request: secondLease,
        candidateBudget: 12,
        now: () => now + 12,
      });
      const rows = directLookupCandidateLifecycle(
          f.repo,
          second.request.id,
          second.request.revision,
        ),
        request = f.repo.db
          .prepare(
            "SELECT status,rpc_attribution_json FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(second.request.id) as any,
        metrics = JSON.parse(request.rpc_attribution_json),
        reasons = rows.reduce<Record<string, number>>(
          (out, row) => (
            (out[String(row.reason_code)] =
              (out[String(row.reason_code)] ?? 0) + 1),
            out
          ),
          {},
        );
      expect(secondRpc.calls).toBe(12);
      expect(
        deferred.every(
          (id) =>
            rows.find((row) => row.pool_id === id)?.reason_code ===
            "FRESH_STATEVIEW_NOT_INITIALIZED",
        ),
      ).toBe(true);
      expect(reasons).toEqual({
        FRESH_STATEVIEW_NOT_INITIALIZED: 14,
        FRESH_ZERO_ACTIVE_LIQUIDITY: 1,
      });
      expect(
        rows.filter((row) => row.state === "NO_ACTIVE_LIQUIDITY"),
      ).toHaveLength(1);
      expect(request.status).toBe("NO_ACTIVE_LIQUIDITY_POOL");
      expect(metrics).toMatchObject({
        structuralCandidateCount: 15,
        zeroLiquidityCandidateCount: 1,
        notInitializedCandidateCount: 14,
        unavailableCandidateCount: 0,
      });
    } finally {
      f.close();
    }
  });
  it("promotes a previously fresh not-initialized candidate on the next explicit lookup", async () => {
    const f = fixture(1),
      now = 200_000;
    try {
      const first = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: now,
        }),
        firstLease = leaseDirectTokenLookup(f.repo, 20_000, now + 1)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: stateRpc([{ initialized: false, liquidity: 0n }]).rpc,
        request: firstLease,
        candidateBudget: 1,
        now: () => now + 2,
      });
      expect(
        directLookupCandidateLifecycle(
          f.repo,
          first.request.id,
          first.request.revision,
        )[0],
      ).toMatchObject({
        state: "EVIDENCE_UNAVAILABLE",
        reason_code: "FRESH_STATEVIEW_NOT_INITIALIZED",
      });
      const second = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: now + 3,
          refreshStaleEvidence: true,
        }),
        secondLease = leaseDirectTokenLookup(f.repo, 20_000, now + 4)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: stateRpc([{ initialized: true, liquidity: 77n }]).rpc,
        request: secondLease,
        candidateBudget: 1,
        now: () => now + 5,
      });
      expect(
        directLookupCandidateLifecycle(
          f.repo,
          second.request.id,
          second.request.revision,
        )[0],
      ).toMatchObject({
        state: "ELIGIBLE",
        reason_code: "FRESH_POSITIVE_ACTIVE_LIQUIDITY",
      });
      expect(
        f.repo.db
          .prepare(
            "SELECT status,eligible_pool_count FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(second.request.id),
      ).toMatchObject({
        status: "SUPPORTED_POOLS_FOUND",
        eligible_pool_count: 1,
      });
    } finally {
      f.close();
    }
  });
  it("does not emit a false categorical negative when an exact candidate member is unavailable", async () => {
    const f = fixture(3),
      now = 300_000;
    try {
      const created = createOrReuseDirectLookup({
          repo: f.repo,
          token,
          nowMs: now,
        }),
        leased = leaseDirectTokenLookup(f.repo, 20_000, now + 1)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: stateRpc([
          { initialized: true, liquidity: 0n },
          "failed",
          { initialized: false, liquidity: 0n },
        ]).rpc,
        request: leased,
        candidateBudget: 3,
        now: () => now + 2,
      });
      const row = f.repo.db
          .prepare(
            "SELECT status,rpc_attribution_json FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(created.request.id) as any,
        metrics = JSON.parse(row.rpc_attribution_json);
      expect(row.status).toBe("PROVIDER_TEMPORARILY_UNAVAILABLE");
      expect(metrics).toMatchObject({
        zeroLiquidityCandidateCount: 1,
        notInitializedCandidateCount: 1,
        unavailableCandidateCount: 1,
      });
      expect(
        directLookupCandidateLifecycle(
          f.repo,
          created.request.id,
          created.request.revision,
        ).find(
          (item) => item.reason_code === "STATEVIEW_MULTICALL_MEMBER_FAILED",
        ),
      ).toBeTruthy();
    } finally {
      f.close();
    }
  });
  it("rotates bounded failed attempts so repeated paste or Refresh reaches every plausible candidate", async () => {
    const f = fixture(14),
      now = 400_000;
    try {
      const attempted = new Set<string>();
      for (let revision = 0; revision < 2; revision++) {
        const created = createOrReuseDirectLookup({
            repo: f.repo,
            token,
            nowMs: now + revision * 10,
            refreshStaleEvidence: true,
          }),
          leased = leaseDirectTokenLookup(
            f.repo,
            20_000,
            now + revision * 10 + 1,
          )!;
        await executeDirectTokenLookup({
          repo: f.repo,
          rpc: stateRpc(Array.from({ length: 12 }, () => "failed" as const))
            .rpc,
          request: leased,
          candidateBudget: 12,
          now: () => now + revision * 10 + 2,
        });
        for (const row of directLookupCandidateLifecycle(
          f.repo,
          created.request.id,
          created.request.revision,
        ))
          if (row.attempt_count > 0) attempted.add(row.pool_id);
        expect(
          (
            f.repo.db
              .prepare(
                "SELECT status FROM direct_token_lookup_requests WHERE id=?",
              )
              .get(created.request.id) as any
          ).status,
        ).toBe("PROVIDER_TEMPORARILY_UNAVAILABLE");
      }
      expect(attempted.size).toBe(14);
    } finally {
      f.close();
    }
  });
  it("runs a synthetic paste-to-outbox-to-selection path with stale registry state", async () => {
    const f = fixture(0),
      natural = getAddress("0x0000000000000000000000000000000000000044"),
      usd = robinhoodMainnet.assets.USDG,
      [currency0, currency1] = [natural, usd].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      ) as [typeof natural, typeof usd],
      keys = [
        {
          currency0,
          currency1,
          fee: 30_000,
          tickSpacing: 300,
          hooks: zeroAddress,
        },
        {
          currency0,
          currency1,
          fee: 50_000,
          tickSpacing: 500,
          hooks: zeroAddress,
        },
      ],
      poolA = poolId(keys[0]!),
      poolB = poolId(keys[1]!),
      now = 1_000;
    try {
      f.repo.upsertTokenMetadata({
        address: natural,
        symbol: "SYN",
        name: "Synthetic Asset",
        decimals: 18,
      });
      for (const [index, key] of keys.entries()) {
        const id = poolId(key);
        f.repo.upsertV4RegistryPool({
          poolId: id,
          currency0,
          currency1,
          initializeFeeRaw: key.fee,
          tickSpacing: key.tickSpacing,
          hooks: zeroAddress,
          initializationBlock: BigInt(100 + index),
          dynamicFee: false,
          staticFeePips: key.fee,
          hookClassification: "ZERO_HOOK",
        });
      }
      const created = createOrReuseDirectLookup({
        repo: f.repo,
        token: natural,
        nowMs: now,
        deadlineMs: 10_000,
        naturalTimeline: { pasteReceivedAtMs: 900, firstUiResponseAtMs: 950 },
      });
      expect(
        f.repo.db
          .prepare(
            "SELECT COUNT(*) count FROM direct_token_lookup_candidates WHERE request_id=?",
          )
          .get(created.request.id),
      ).toEqual({ count: 0 });
      attachDirectLookupSubscriber({
        repo: f.repo,
        requestId: created.request.id,
        requestRevision: created.request.revision,
        interactionId: "natural",
        userId: "u",
        chatId: "c",
        messageId: 7,
        sessionId: "s",
        nowMs: 1_001,
      });
      const cycle = await runDedicatedDirectLookupCycle({
        repo: f.repo,
        rpc: stateRpc([
          { initialized: true, liquidity: 1_000n },
          { initialized: true, liquidity: 2_000n },
        ]).rpc,
        candidateBudget: 2,
        now: () => 2_000,
      });
      expect(cycle.status).toBe("COMPLETED");
      const request = f.repo.db
          .prepare("SELECT * FROM direct_token_lookup_requests WHERE id=?")
          .get(created.request.id) as any,
        eligible = JSON.parse(request.eligible_pool_ids_json) as string[];
      expect(request).toMatchObject({
        status: "SUPPORTED_POOLS_FOUND",
        eligible_pool_count: 2,
      });
      expect(new Set(eligible.map((id) => id.toLowerCase()))).toEqual(
        new Set([poolA, poolB]),
      );
      const outbox = leaseDirectLookupOutbox(f.repo, 5_000, 2_001) as any,
        payload = JSON.parse(String(outbox.payload_json)),
        timeline = payload.rpcAttribution;
      expect(
        new Set(payload.eligiblePoolIds.map((id: string) => id.toLowerCase())),
      ).toEqual(new Set([poolA, poolB]));
      expect([
        timeline.pasteReceivedAtMs,
        timeline.firstUiResponseAtMs,
        timeline.requestPersistedAtMs,
        timeline.workerLeasedAtMs,
        timeline.firstRpcAtMs,
        timeline.hydrationCompletedAtMs,
        timeline.outboxCreatedAtMs,
      ]).toEqual([900, 950, 1_000, 2_000, 2_000, 2_000, 2_000]);
      f.repo.db
        .prepare(
          "UPDATE v4_pool_registry SET initialized=0,active_liquidity_raw=NULL,validation_status='DISCOVERED',last_refreshed_at=NULL WHERE lower(pool_id) IN (lower(?),lower(?))",
        )
        .run(poolA, poolB);
      const cached = cachedV4PoolsForToken({
          repo: f.repo,
          token: natural,
          now: 2_001,
        }).candidates,
        presented = applyDirectLookupCandidatePresentation(
          f.repo,
          natural,
          cached,
          2_001,
          {
            requestId: created.request.id,
            requestRevision: created.request.revision,
          },
        ),
        labels = presented
          .filter((item) => item.executionEligible)
          .map((item) =>
            v4PoolSelectionLabel(
              item.target.symbol,
              item.funding.symbol,
              item.feeLabel,
            ),
          );
      expect(labels).toEqual(
        expect.arrayContaining([
          "v4 · SYN/USDG · fee 3%",
          "v4 · SYN/USDG · fee 5%",
        ]),
      );
      const retry = createOrReuseDirectLookup({
          repo: f.repo,
          token: natural,
          nowMs: 2_010,
          refreshStaleEvidence: true,
        }),
        retryLease = leaseDirectTokenLookup(f.repo, 10_000, 2_011)!;
      await executeDirectTokenLookup({
        repo: f.repo,
        rpc: stateRpc(["failed", "failed"]).rpc,
        request: retryLease,
        candidateBudget: 2,
        now: () => 2_012,
      });
      const carried = f.repo.db
        .prepare(
          "SELECT status,eligible_pool_ids_json FROM direct_token_lookup_requests WHERE id=?",
        )
        .get(retry.request.id) as any;
      expect(carried.status).toBe("SUPPORTED_POOLS_FOUND");
      expect(
        new Set(
          (JSON.parse(carried.eligible_pool_ids_json) as string[]).map((id) =>
            id.toLowerCase(),
          ),
        ),
      ).toEqual(new Set([poolA, poolB]));
    } finally {
      f.close();
    }
  });
  it("enforces the parent invariant that a plausible candidate cannot complete as structural absence", () => {
    const f = fixture(1);
    try {
      const created = createOrReuseDirectLookup({
        repo: f.repo,
        token,
        nowMs: 1_000,
      });
      completeDirectTokenLookup(f.repo, {
        requestId: created.request.id,
        requestRevision: created.request.revision,
        status: "NO_ACTIVE_LIQUIDITY_POOL",
        candidatePoolCount: 0,
        hydratedPoolCount: 0,
        eligiblePoolIds: [],
        providerResult: "none",
        rpcAttribution: {},
        reasonCode: "NO_STRUCTURALLY_SUPPORTED_CANDIDATE",
        nowMs: 1_001,
      });
      expect(
        f.repo.db
          .prepare(
            "SELECT status,reason_code,rpc_attribution_json FROM direct_token_lookup_requests WHERE id=?",
          )
          .get(created.request.id),
      ).toMatchObject({
        status: "PROVIDER_TEMPORARILY_UNAVAILABLE",
        reason_code: "PLAUSIBLE_CANDIDATE_EVIDENCE_INCOMPLETE",
      });
    } finally {
      f.close();
    }
  });
});
