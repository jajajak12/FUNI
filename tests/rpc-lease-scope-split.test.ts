import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAddress, zeroAddress } from "viem";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import { poolId, type V4PoolKey } from "@funi/v4";
import {
  fetchV4RegistryPoolBatch,
  persistV4RegistryPoolBatch,
  planV4RegistryPoolBatch,
} from "../apps/cli/src/v4-registry.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rpc-lease-split-")),
    path = join(dir, "test.sqlite");
  migrateSqlite(path, "infra/migrations");
  const repo = new SqliteLedgerRepository(path),
    key: V4PoolKey = {
      currency0: getAddress("0x0000000000000000000000000000000000000001"),
      currency1: getAddress("0x7000000000000000000000000000000000000001"),
      fee: 500,
      tickSpacing: 10,
      hooks: zeroAddress,
    },
    id = poolId(key);
  repo.upsertV4RegistryPool({
    poolId: id,
    currency0: key.currency0,
    currency1: key.currency1,
    initializeFeeRaw: key.fee,
    tickSpacing: key.tickSpacing,
    hooks: key.hooks,
    initializationBlock: 1n,
    dynamicFee: false,
    staticFeePips: key.fee,
    hookClassification: "ZERO_HOOK",
  });
  return {
    repo,
    id,
    close() {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const rpc = (events: string[], fail = false) =>
  ({
    withClient: async (work: any) => {
      events.push("provider");
      if (fail) throw new Error("provider failed");
      return work({
        getBlockNumber: async () => 10n,
        multicall: async ({ contracts }: any) =>
          contracts.map((_: unknown, index: number) => ({
            status: "success",
            result: index % 2 === 0 ? [2n ** 96n, 0n, 0n, 500n] : 7n,
          })),
      });
    },
  }) as any;

describe("state-cache RPC lease split", () => {
  it("keeps the zero-work branch before lease acquisition and all persistence after release", () => {
    const source = readFileSync(
        "apps/workers/src/state-cache-worker.ts",
        "utf8",
      ),
      zero = source.indexOf("if(!statePlan.rows.length)"),
      acquire = source.indexOf("acquireRpcReadLease", zero),
      fetch = source.indexOf("fetchV4RegistryPoolBatch", acquire),
      release = source.indexOf("releaseRpcReadLease", fetch),
      persist = source.indexOf("persistV4RegistryPoolBatch", release);
    expect(zero).toBeGreaterThan(0);
    expect(acquire).toBeGreaterThan(zero);
    expect(fetch).toBeGreaterThan(acquire);
    expect(release).toBeGreaterThan(fetch);
    expect(persist).toBeGreaterThan(release);
  });
  it("plans first, fetches under the lease, releases, then persists the unchanged StateView result", async () => {
    const f = fixture(),
      events: string[] = [];
    try {
      events.push("planning");
      const plan = planV4RegistryPoolBatch({ repo: f.repo, poolIds: [f.id] });
      let held = false,
        result;
      events.push("acquire");
      held = true;
      try {
        result = await fetchV4RegistryPoolBatch({ rpc: rpc(events), plan });
        expect(held).toBe(true);
        expect(f.repo.v4RegistryPool(f.id)?.last_refreshed_at).toBeNull();
      } finally {
        held = false;
        events.push("release");
      }
      events.push("persistence");
      const persisted = persistV4RegistryPoolBatch({
        repo: f.repo,
        result: result!,
      });
      expect(held).toBe(false);
      expect(events).toEqual([
        "planning",
        "acquire",
        "provider",
        "release",
        "persistence",
      ]);
      expect(persisted).toMatchObject({
        refreshed: [f.id],
        failed: [],
        multicallPoolCount: 1,
      });
      expect(f.repo.v4RegistryPool(f.id)).toMatchObject({
        active_liquidity_raw: "7",
        refresh_block: "10",
      });
    } finally {
      f.close();
    }
  });
  it("releases on provider error without persistence", async () => {
    const f = fixture(),
      events: string[] = [];
    try {
      const plan = planV4RegistryPoolBatch({ repo: f.repo, poolIds: [f.id] });
      let held = true;
      await expect(
        (async () => {
          try {
            return await fetchV4RegistryPoolBatch({
              rpc: rpc(events, true),
              plan,
            });
          } finally {
            held = false;
            events.push("release");
          }
        })(),
      ).rejects.toThrow("provider failed");
      expect(held).toBe(false);
      expect(events).toEqual(["provider", "release"]);
      expect(f.repo.v4RegistryPool(f.id)?.last_refreshed_at).toBeNull();
    } finally {
      f.close();
    }
  });
  it("surfaces persistence failure only after the lease is released", () => {
    let held = false;
    const key: V4PoolKey = {
        currency0: getAddress("0x0000000000000000000000000000000000000001"),
        currency1: getAddress("0x7000000000000000000000000000000000000001"),
        fee: 500,
        tickSpacing: 10,
        hooks: zeroAddress,
      },
      result = {
        states: [
          {
            id: poolId(key),
            state: {
              key,
              id: poolId(key),
              sqrtPriceX96: 1n,
              tick: 0,
              protocolFee: 0,
              lpFee: 500,
              liquidity: 1n,
              initialized: true,
              blockNumber: 1n,
            },
          },
        ],
        failed: [],
        multicallPoolCount: 1,
      };
    expect(() =>
      persistV4RegistryPoolBatch({
        repo: {
          refreshV4RegistryPool: () => {
            expect(held).toBe(false);
            throw new Error("persistence failed");
          },
        } as any,
        result,
      }),
    ).toThrow("persistence failed");
  });
});
