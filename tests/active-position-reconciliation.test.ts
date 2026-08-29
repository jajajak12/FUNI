import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import {
  activePositionReconciliationAudit,
  buildPersistedPortfolioSnapshot,
  cachedCirculatingSupply,
  enqueueTargetedPositionReconciliation,
  leaseTargetedPositionReconciliations,
  markOperationalPositionOpenConfirming,
  persistPortfolioSnapshot,
  reconcileActivePositions,
} from "../apps/cli/src/active-position-reconciliation.js";
import { persistedPositionViews } from "../apps/telegram-lp-bot/src/persisted-portfolio.js";
import { robinhoodMainnet } from "@funi/core";
import { getAddress } from "viem";

const wallet = "0x00000000000000000000000000000000000000AA";
const token = "0x0000000000000000000000000000000000000011";
const key = {
  currency0: token,
  currency1: robinhoodMainnet.assets.USDG,
  fee: 500,
  tickSpacing: 10,
  hooks: "0x0000000000000000000000000000000000000000",
};
function opened() {
  const dir = mkdtempSync(join(tmpdir(), "active-position-truth-")),
    path = join(dir, "db.sqlite");
  migrateSqlite(path, "infra/migrations");
  const repo = new SqliteLedgerRepository(path);
  for (const [id, symbol, operational] of [
    ["101", "ASSET_A", true],
    ["102", "ASSET_B", false],
    ["103", "ASSET_C", false],
  ] as const) {
    repo.ensurePosition(`v4:${id}`, id, `pool-${id}`);
    repo.upsertV4Position({
      tokenId: BigInt(id),
      owner: wallet,
      poolId: `pool-${id}`,
      poolKey: key,
      currency0: key.currency0,
      currency1: key.currency1,
      fee: key.fee,
      tickSpacing: key.tickSpacing,
      hooks: key.hooks,
      tickLower: -100,
      tickUpper: 100,
      liquidity: 1n,
      initialAmount0: 0n,
      initialAmount1: operational ? 5_000_000n : 1_000_000_000n,
      mintHash: `0x${id.padStart(64, "0")}`,
      targetToken: token,
      fundingToken: robinhoodMainnet.assets.USDG,
      targetSymbol: symbol,
      fundingSymbol: "USDG",
      targetDecimals: 18,
      fundingDecimals: 6,
      targetIndex: 0,
      fundingIndex: 1,
      openIntentId: operational ? "operational-asset-a" : undefined,
    });
    repo.ingestDeposit({
      id: `deposit-${id}`,
      positionId: `v4:${id}`,
      txHash: `0x${id.padStart(64, "0")}`,
      logIndex: 0,
      amounts: {
        token0: 0n,
        token1: operational ? 5_000_000n : 1_000_000_000n,
      },
      blockNumber: 1n,
      blockTimestamp: new Date().toISOString(),
    });
  }
  repo.ensurePosition("live:104", "104", "v3-pool");
  const success = (result: unknown) => ({ status: "success", result }),
    failure = (message: string) => ({
      status: "failure",
      error: { shortMessage: message },
    });
  const calls = [
    success(wallet),
    success(0n),
    success([0n, 0n, 0n]),
    success([0n, 0n]),
    success([2n ** 96n, 0, 0, 500]),
    success(1_000_000_000_000_000_000_000_000_000n),
    success(wallet),
    success(10n),
    success([10n, 0n, 0n]),
    success([0n, 0n]),
    success([2n ** 96n, 0, 0, 500]),
    success(1_000_000_000_000_000_000_000_000_000n),
    success(wallet),
    success(20n),
    success([20n, 0n, 0n]),
    success([0n, 0n]),
    success([2n ** 96n, 0, 0, 500]),
    success(1_000_000_000_000_000_000_000_000_000n),
    failure("ERC721: owner query for nonexistent token"),
    failure("Invalid token ID"),
  ];
  const rpc = {
    withClient: async (work: any) =>
      work({ getBlockNumber: async () => 100n, multicall: async () => calls }),
  } as any;
  return {
    dir,
    repo,
    rpc,
    close() {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
describe("active position lifecycle truth", () => {
  it("reconciles the four synthetic records to exactly two active positions and preserves history", async () => {
    const f = opened();
    try {
      const before = (
          f.repo.db
            .prepare("SELECT COUNT(*) count FROM position_deposits")
            .get() as { count: number }
        ).count,
        result = await reconcileActivePositions({
          repo: f.repo,
          rpc: f.rpc,
          wallet,
          positionIds: ["v4:101", "v4:102", "v4:103", "live:104"],
          limit: 4,
          nowMs: 1_000,
          ttlMs: 90_000,
        });
      expect(result).toMatchObject({
        activePositionChecks: 4,
        ethCallCount: 20,
        multicallCount: 1,
        multicallMembers: 20,
      });
      const audit = activePositionReconciliationAudit(f.repo, 2_000);
      expect(audit.confirmedActiveCount).toBe(2);
      expect(audit.pendingReconciliationCount).toBe(0);
      expect(
        audit.positions.find((x) => x.tokenId === "101")?.terminalReason,
      ).toBe("CLOSED_EMPTY");
      expect(
        audit.positions.find((x) => x.tokenId === "104")?.terminalReason,
      ).toBe("BURNED");
      expect(
        audit.positions
          .filter((x) => x.classification === "CONFIRMED_ACTIVE_FRESH")
          .map((x) => x.tokenId)
          .sort(),
      ).toEqual(["102", "103"]);
      expect(
        (
          f.repo.db
            .prepare("SELECT COUNT(*) count FROM position_deposits")
            .get() as { count: number }
        ).count,
      ).toBe(before);
      expect(
        persistedPositionViews(f.repo).find((x) => x.tokenId === "101"),
      ).toMatchObject({
        source: "BOT_OPERATIONAL",
        terminalReason: "CLOSED_EMPTY",
      });
      expect(
        buildPersistedPortfolioSnapshot(f.repo, 2_000).confirmedActiveCount,
      ).toBe(2);
    } finally {
      f.close();
    }
  });
  it("upserts reconciliation idempotently and keeps expired verified ownership visible while refreshing", async () => {
    const f = opened();
    try {
      await reconcileActivePositions({
        repo: f.repo,
        rpc: f.rpc,
        wallet,
        positionIds: ["v4:101", "v4:102", "v4:103", "live:104"],
        nowMs: 1_000,
        ttlMs: 90_000,
      });
      await reconcileActivePositions({
        repo: f.repo,
        rpc: f.rpc,
        wallet,
        positionIds: ["v4:101", "v4:102", "v4:103", "live:104"],
        nowMs: 2_000,
        ttlMs: 90_000,
      });
      expect(
        (
          f.repo.db
            .prepare(
              "SELECT COUNT(*) count FROM active_position_reconciliations",
            )
            .get() as { count: number }
        ).count,
      ).toBe(4);
      const stale = activePositionReconciliationAudit(f.repo, 100_000);
      expect(stale.confirmedActiveCount).toBe(2);
      expect(stale.refreshingCount).toBe(2);
      expect(stale.pendingReconciliationCount).toBe(0);
      expect(stale.terminalizedCount).toBe(2);
      expect(
        buildPersistedPortfolioSnapshot(f.repo, 100_000).confirmedActiveCount,
      ).toBe(2);
    } finally {
      f.close();
    }
  });
  it("does not terminalize a missing v4 NFT without receipt-backed burn evidence", async () => {
    const f = opened();
    try {
      f.repo.ensurePosition("v4:999", "999", "pool-999");
      f.repo.upsertV4Position({
        tokenId: 999n,
        owner: wallet,
        poolId: "pool-999",
        poolKey: key,
        currency0: key.currency0,
        currency1: key.currency1,
        fee: key.fee,
        tickSpacing: key.tickSpacing,
        hooks: key.hooks,
        tickLower: -100,
        tickUpper: 100,
        liquidity: 1n,
        initialAmount0: 0n,
        initialAmount1: 1n,
        mintHash: `0x${"9".repeat(64)}`,
        targetToken: token,
        fundingToken: robinhoodMainnet.assets.USDG,
        targetSymbol: "MISSING",
        fundingSymbol: "USDG",
        targetDecimals: 18,
        fundingDecimals: 6,
        targetIndex: 0,
        fundingIndex: 1,
      });
      const failure = (message: string) => ({
          status: "failure",
          error: { shortMessage: message },
        }),
        rpc = {
          withClient: async (work: any) =>
            work({
              getBlockNumber: async () => 101n,
              multicall: async () => [
                failure("NOT_MINTED"),
                failure("NOT_MINTED"),
                failure("unavailable"),
                failure("unavailable"),
                failure("unavailable"),
              ],
            }),
        } as any;
      await reconcileActivePositions({
        repo: f.repo,
        rpc,
        wallet,
        positionIds: ["v4:999"],
        nowMs: 3_000,
        ttlMs: 90_000,
      });
      const item = activePositionReconciliationAudit(
        f.repo,
        3_001,
      ).positions.find((x) => x.tokenId === "999");
      expect(item?.classification).toBe("PENDING_NEVER_VERIFIED");
      expect(item?.terminalReason).toBeNull();
      expect(item?.reconciliation?.last_error).toBe(
        "V4_NONEXISTENT_WITHOUT_BURN_RECEIPT",
      );
    } finally {
      f.close();
    }
  });
  it("persists the same portfolio snapshot when a bounded reconciliation batch has no eligible position", async () => {
    const f = opened();
    try {
      let acquired = 0,
        released = 0;
      const result = await reconcileActivePositions({
        repo: f.repo,
        rpc: f.rpc,
        wallet,
        positionIds: [],
        nowMs: 1_000,
        ttlMs: 90_000,
        rpcLease: {
          acquire: () => {
            acquired++;
            return true;
          },
          release: () => {
            released++;
          },
        },
      });
      const snapshot = f.repo.db
        .prepare(
          "SELECT refreshed_at_ms FROM portfolio_persisted_snapshot WHERE snapshot_key='current'",
        )
        .get() as { refreshed_at_ms: number };
      expect(result.activePositionChecks).toBe(0);
      expect(snapshot.refreshed_at_ms).toBe(1_000);
      expect({ acquired, released }).toEqual({ acquired: 0, released: 0 });
    } finally {
      f.close();
    }
  });
  it("holds the RPC lease only across bounded RPC and releases it before snapshot work", async () => {
    const f = opened();
    try {
      const events: string[] = [],
        rpc = {
          withClient: async (work: any) => {
            events.push("rpc:start");
            const result = await f.rpc.withClient(work);
            events.push("rpc:end");
            return result;
          },
        } as any,
        result = await reconcileActivePositions({
          repo: f.repo,
          rpc,
          wallet,
          positionIds: ["v4:102"],
          nowMs: 1_000,
          ttlMs: 90_000,
          rpcLease: {
            acquire: () => {
              events.push("lease:acquire");
              return true;
            },
            release: () => {
              events.push("lease:release");
              expect(
                f.repo.db
                  .prepare(
                    "SELECT COUNT(*) count FROM portfolio_persisted_snapshot",
                  )
                  .get(),
              ).toEqual({ count: 0 });
            },
          },
        });
      expect(result.rpcLeaseDeferred).toBe(false);
      expect(events).toEqual([
        "lease:acquire",
        "rpc:start",
        "rpc:end",
        "lease:release",
      ]);
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM portfolio_persisted_snapshot")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      f.close();
    }
  });
  it("releases the RPC lease when the reconciliation RPC fails", async () => {
    const f = opened();
    try {
      let acquired = 0,
        released = 0;
      const rpc = {
        withClient: async () => {
          throw new Error("bounded rpc failed");
        },
      } as any;
      await expect(
        reconcileActivePositions({
          repo: f.repo,
          rpc,
          wallet,
          positionIds: ["v4:102"],
          nowMs: 1_000,
          rpcLease: {
            acquire: () => {
              acquired++;
              return true;
            },
            release: () => {
              released++;
            },
          },
        }),
      ).rejects.toThrow("bounded rpc failed");
      expect({ acquired, released }).toEqual({ acquired: 1, released: 1 });
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM portfolio_persisted_snapshot")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      f.close();
    }
  });
  it("commits a ten-position reconciliation atomically", async () => {
    const f = opened();
    try {
      const ids = ["101", "102", "103"];
      for (let i = 0; i < 7; i++) {
        const id = String(400_000 + i);
        ids.push(id);
        f.repo.ensurePosition(`v4:${id}`, id, `pool-${id}`);
        f.repo.upsertV4Position({
          tokenId: BigInt(id),
          owner: wallet,
          poolId: `pool-${id}`,
          poolKey: key,
          currency0: key.currency0,
          currency1: key.currency1,
          fee: key.fee,
          tickSpacing: key.tickSpacing,
          hooks: key.hooks,
          tickLower: -100,
          tickUpper: 100,
          liquidity: 1n,
          initialAmount0: 0n,
          initialAmount1: 1_000_000n,
          mintHash: `0x${id.padStart(64, "0")}`,
          targetToken: token,
          fundingToken: robinhoodMainnet.assets.USDG,
          targetSymbol: `T${i}`,
          fundingSymbol: "USDG",
          targetDecimals: 18,
          fundingDecimals: 6,
          targetIndex: 0,
          fundingIndex: 1,
        });
      }
      const success = (result: unknown) => ({ status: "success", result }),
        results = ids.flatMap(() => [
          success(wallet),
          success(10n),
          success([10n, 0n, 0n]),
          success([0n, 0n]),
          success([2n ** 96n, 0, 0, 500]),
          success(1_000_000_000_000_000_000n),
        ]),
        rpc = {
          withClient: async (work: any) =>
            work({
              getBlockNumber: async () => 100n,
              multicall: async () => results,
            }),
        } as any,
        positionIds = ids.map((id) => `v4:${id}`);
      f.repo.db.exec(
        "CREATE TRIGGER fail_tenth_reconciliation BEFORE INSERT ON active_position_reconciliations WHEN NEW.position_id='v4:400006' BEGIN SELECT RAISE(ABORT,'atomic proof'); END",
      );
      await expect(
        reconcileActivePositions({
          repo: f.repo,
          rpc,
          wallet,
          positionIds,
          nowMs: 1_000,
        }),
      ).rejects.toThrow("atomic proof");
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM active_position_reconciliations")
          .get(),
      ).toEqual({ count: 0 });
      f.repo.db.exec("DROP TRIGGER fail_tenth_reconciliation");
      const result = await reconcileActivePositions({
        repo: f.repo,
        rpc,
        wallet,
        positionIds,
        nowMs: 1_001,
      });
      expect(result.positions).toHaveLength(10);
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM active_position_reconciliations")
          .get(),
      ).toEqual({ count: 10 });
    } finally {
      f.close();
    }
  });
  it("keeps authoritative reconciliation committed when snapshot persistence fails and repairs it next cycle", async () => {
    const f = opened();
    try {
      f.repo.db.exec(
        "CREATE TRIGGER fail_snapshot BEFORE INSERT ON portfolio_persisted_snapshot BEGIN SELECT RAISE(ABORT,'snapshot unavailable'); END",
      );
      await expect(
        reconcileActivePositions({
          repo: f.repo,
          rpc: f.rpc,
          wallet,
          positionIds: ["v4:101", "v4:102", "v4:103", "live:104"],
          nowMs: 1_000,
          ttlMs: 90_000,
        }),
      ).rejects.toThrow("snapshot unavailable");
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM active_position_reconciliations")
          .get(),
      ).toEqual({ count: 4 });
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM portfolio_persisted_snapshot")
          .get(),
      ).toEqual({ count: 0 });
      f.repo.db.exec("DROP TRIGGER fail_snapshot");
      let providerCalls = 0;
      await reconcileActivePositions({
        repo: f.repo,
        rpc: {
          withClient: async () => {
            providerCalls++;
            throw new Error("provider must not run");
          },
        } as any,
        wallet,
        nowMs: 1_001,
        ttlMs: 90_000,
      });
      expect(providerCalls).toBe(0);
      expect(
        f.repo.db
          .prepare("SELECT refreshed_at_ms FROM portfolio_persisted_snapshot")
          .get(),
      ).toEqual({ refreshed_at_ms: 1_001 });
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM active_position_reconciliations")
          .get(),
      ).toEqual({ count: 4 });
    } finally {
      f.close();
    }
  });
  it("keeps provider calls and derived snapshot build and JSON outside the writer transaction", async () => {
    const f = opened(),
      originalStringify = JSON.stringify,
      originalListPositions = f.repo.listPositions.bind(f.repo);
    try {
      const observations: Array<{ stage: string; inTransaction: boolean }> = [],
        listPositions = vi
          .spyOn(f.repo, "listPositions")
          .mockImplementation((...args: any[]) => {
            observations.push({
              stage: "snapshot-or-plan-read",
              inTransaction: f.repo.db.inTransaction,
            });
            return (originalListPositions as any)(...args);
          }),
        stringify = vi.spyOn(JSON, "stringify").mockImplementation(((
          value: any,
          ...args: any[]
        ) => {
          if (
            value &&
            typeof value === "object" &&
            Array.isArray(value.positions) &&
            typeof value.observedAt === "string"
          )
            observations.push({
              stage: "snapshot-json",
              inTransaction: f.repo.db.inTransaction,
            });
          return (originalStringify as any)(value, ...args);
        }) as any),
        rpc = {
          withClient: async (work: any) => {
            observations.push({
              stage: "provider",
              inTransaction: f.repo.db.inTransaction,
            });
            return f.rpc.withClient(work);
          },
        } as any;
      await reconcileActivePositions({
        repo: f.repo,
        rpc,
        wallet,
        positionIds: ["v4:102"],
        nowMs: 1_000,
      });
      expect(observations.filter((item) => item.stage === "provider")).toEqual([
        { stage: "provider", inTransaction: false },
      ]);
      expect(observations.some((item) => item.stage === "snapshot-json")).toBe(
        true,
      );
      expect(observations.every((item) => !item.inTransaction)).toBe(true);
      stringify.mockRestore();
      listPositions.mockRestore();
    } finally {
      JSON.stringify = originalStringify;
      f.close();
    }
  });
  it("uses canonical exact GMGN identity while preserving latest-observation and TTL semantics", () => {
    const f = opened();
    try {
      const stored = getAddress("0xc2362aff2a2a4cc1f48cf3dab2c4e2605eb94ba4"),
        canonical = stored.toLowerCase(),
        mixed = `0x${canonical.slice(2).toUpperCase()}` as `0x${string}`,
        insert = f.repo.db.prepare(
          "INSERT INTO gmgn_robinhood_observations(token_address,symbol,name,observed_at_ms,market_cap_usd,source_json) VALUES(?,'T','Token',?,1,?)",
        );
      insert.run(
        stored,
        1_000,
        JSON.stringify({
          supplyBasis: { kind: "circulating", raw: "1000000" },
        }),
      );
      insert.run(
        stored,
        1_500,
        JSON.stringify({
          supplyBasis: { kind: "circulating", raw: "2500000" },
        }),
      );
      const old = f.repo.db
          .prepare(
            "SELECT observed_at_ms FROM gmgn_robinhood_observations WHERE lower(token_address)=lower(?) ORDER BY observed_at_ms DESC LIMIT 1",
          )
          .get(mixed) as { observed_at_ms: number },
        fresh = cachedCirculatingSupply(f.repo, mixed, 6, 2_000),
        plan = f.repo.db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT observed_at_ms,source_json FROM gmgn_robinhood_observations WHERE token_address=? ORDER BY observed_at_ms DESC LIMIT 1",
          )
          .all(canonical) as Array<{ detail: string }>;
      expect(stored).not.toBe(canonical);
      expect(old.observed_at_ms).toBe(1_500);
      expect(fresh).toMatchObject({
        raw: "2500000",
        normalized: 2.5,
        kind: "CIRCULATING",
        observedAt: new Date(1_500).toISOString(),
      });
      expect(
        plan.some((row) =>
          row.detail.includes("idx_gmgn_robinhood_observations_token_time"),
        ),
      ).toBe(true);
      expect(
        cachedCirculatingSupply(f.repo, mixed, 6, 1_500 + 30 * 60_000),
      ).toBeTruthy();
      expect(
        cachedCirculatingSupply(f.repo, mixed, 6, 1_500 + 30 * 60_000 + 1),
      ).toBeUndefined();
    } finally {
      f.close();
    }
  });
  it("reopens a terminal stale ownership record through the normal targeted reconciliation path", async () => {
    const f = opened();
    try {
      const positionId = "v4:201",
        tokenId = "201",
        owner = wallet.toLowerCase();
      f.repo.ensurePosition(positionId, tokenId, "pool-201");
      f.repo.upsertV4Position({
        tokenId: BigInt(tokenId),
        owner: wallet,
        poolId: "pool-201",
        poolKey: key,
        currency0: key.currency0,
        currency1: key.currency1,
        fee: key.fee,
        tickSpacing: key.tickSpacing,
        hooks: key.hooks,
        tickLower: -100,
        tickUpper: -50,
        liquidity: 1n,
        initialAmount0: 0n,
        initialAmount1: 1n,
        mintHash: `0x${"6".repeat(64)}`,
        targetToken: token,
        fundingToken: robinhoodMainnet.assets.USDG,
        targetSymbol: "ACTIVE",
        fundingSymbol: "USDG",
        targetDecimals: 18,
        fundingDecimals: 6,
        targetIndex: 0,
        fundingIndex: 1,
        status: "closed",
      });
      f.repo.db
        .prepare(
          "INSERT INTO active_position_reconciliations(position_id,protocol_version,token_id,manager_address,owner_status,terminal_reason,confirmed_active,contributes_equity,checked_at_ms,fresh_until_ms,retry_count,details_json) VALUES(?,'v4',?,?, 'VERIFIED_UNOWNED','OWNERSHIP_LOST',0,0,1,1,0,'{}')",
        )
        .run(positionId, tokenId, "0x0000000000000000000000000000000000000001");
      expect(
        enqueueTargetedPositionReconciliation(f.repo, {
          positionId,
          tokenId,
          protocol: "v4",
          reason: "OPERATOR_TARGETED_RECONCILIATION",
          nowMs: 2_000,
        }),
      ).toBe("ENQUEUED");
      expect(
        enqueueTargetedPositionReconciliation(f.repo, {
          positionId,
          tokenId,
          protocol: "v4",
          reason: "OPERATOR_TARGETED_RECONCILIATION",
          nowMs: 2_001,
        }),
      ).toBe("ALREADY_PENDING");
      expect(
        leaseTargetedPositionReconciliations(f.repo, 1, 15_000, 2_002).map(
          (row) => row.position_id,
        ),
      ).toEqual([positionId]);
      const success = (result: unknown) => ({ status: "success", result }),
        rpc = {
          withClient: async (work: any) =>
            work({
              getBlockNumber: async () => 200n,
              multicall: async () => [
                success(owner),
                success(9n),
                success([0n, 0n, 0n]),
                success([0n, 0n]),
                success([2n ** 96n, 0, 0, 500]),
              ],
            }),
        } as any;
      await reconcileActivePositions({
        repo: f.repo,
        rpc,
        wallet,
        positionIds: [positionId],
        nowMs: 2_100,
        ttlMs: 90_000,
      });
      const row = f.repo.db
          .prepare(
            "SELECT owner_status,terminal_reason,confirmed_active,contributes_equity FROM active_position_reconciliations WHERE position_id=?",
          )
          .get(positionId) as Record<string, unknown>,
        truth = activePositionReconciliationAudit(f.repo, 2_101).positions.find(
          (item) => item.positionId === positionId,
        );
      expect(row).toMatchObject({
        owner_status: "VERIFIED_OWNED",
        terminal_reason: null,
        confirmed_active: 1,
        contributes_equity: 1,
      });
      expect(truth?.classification).toBe("CONFIRMED_ACTIVE_FRESH");
      expect(f.repo.v4Position(tokenId)?.status).toBe("open");
    } finally {
      f.close();
    }
  });
});
it("creates OPEN_CONFIRMING after a confirmed operational receipt and targets only the new NFT", async () => {
  const f = opened();
  try {
    const success = (result: unknown) => ({ status: "success", result }),
      activeRpc = {
        withClient: async (work: any) =>
          work({
            getBlockNumber: async () => 124n,
            multicall: async () => [
              success(wallet),
              success(50n),
              success([50n, 0n, 0n]),
              success([0n, 0n]),
              success([2n ** 96n, 0, 0, 500]),
            ],
          }),
      } as any;
    await reconcileActivePositions({
      repo: f.repo,
      rpc: activeRpc,
      wallet,
      positionIds: ["v4:102"],
      nowMs: 1_000,
      ttlMs: 90_000,
    });
    f.repo.ensurePosition("v4:202", "202", "pool-new");
    f.repo.upsertV4Position({
      tokenId: 202n,
      owner: wallet,
      poolId: "pool-new",
      poolKey: key,
      currency0: key.currency0,
      currency1: key.currency1,
      fee: key.fee,
      tickSpacing: key.tickSpacing,
      hooks: key.hooks,
      tickLower: -100,
      tickUpper: 100,
      liquidity: 50n,
      initialAmount0: 0n,
      initialAmount1: 5_000_000n,
      mintHash: `0x${"3".repeat(64)}`,
      targetToken: token,
      fundingToken: robinhoodMainnet.assets.USDG,
      targetSymbol: "NEW",
      fundingSymbol: "USDG",
      targetDecimals: 18,
      fundingDecimals: 6,
      targetIndex: 0,
      fundingIndex: 1,
      openIntentId: "intent-new",
      openEvidence: { lane: "operational" },
    });
    markOperationalPositionOpenConfirming(f.repo, {
      positionId: "v4:202",
      tokenId: "202",
      intentId: "intent-new",
      mintHash: `0x${"3".repeat(64)}`,
      blockNumber: 123n,
      nowMs: 2_000,
    });
    persistPortfolioSnapshot(f.repo, 2_000);
    const before = activePositionReconciliationAudit(f.repo, 2_001);
    expect(before.openConfirmingCount).toBe(1);
    expect(
      before.positions.find((x) => x.tokenId === "202")?.classification,
    ).toBe("OPEN_CONFIRMING");
    expect(
      before.positions.find((x) => x.tokenId === "102")?.classification,
    ).toBe("CONFIRMED_ACTIVE_FRESH");
    expect(
      persistedPositionViews(f.repo).find((x) => x.tokenId === "202"),
    ).toMatchObject({
      lifecycle: "OPEN_CONFIRMING",
      accounting: {
        externalCapitalUsd: 5,
        currentEquityUsd: null,
        uncollectedFeesUsd: null,
      },
    });
    const leased = leaseTargetedPositionReconciliations(
      f.repo,
      16,
      15_000,
      2_001,
    );
    expect(leased.map((x) => x.position_id)).toEqual(["v4:202"]);
    await reconcileActivePositions({
      repo: f.repo,
      rpc: activeRpc,
      wallet,
      positionIds: ["v4:202"],
      nowMs: 2_100,
      ttlMs: 90_000,
    });
    const after = activePositionReconciliationAudit(f.repo, 2_101);
    expect(
      after.positions.find((x) => x.tokenId === "202")?.classification,
    ).toBe("CONFIRMED_ACTIVE_FRESH");
    expect(
      after.positions.find((x) => x.tokenId === "102")?.classification,
    ).toBe("CONFIRMED_ACTIVE_FRESH");
    expect(
      persistedPositionViews(f.repo).find((x) => x.tokenId === "202")
        ?.source,
    ).toBe("BOT_OPERATIONAL");
  } finally {
    f.close();
  }
});
it("rejects an older snapshot writer after a newer canonical projection is persisted", () => {
  const f = opened();
  try {
    markOperationalPositionOpenConfirming(f.repo, {
      positionId: "v4:101",
      tokenId: "101",
      intentId: "operational-asset-a",
      mintHash: `0x${"1".repeat(64)}`,
      blockNumber: 10n,
      nowMs: 2_000,
    });
    persistPortfolioSnapshot(f.repo, 2_000);
    const newer = f.repo.db
      .prepare(
        "SELECT payload_json,refreshed_at_ms,last_reconciliation_at_ms FROM portfolio_persisted_snapshot WHERE snapshot_key='current'",
      )
      .get() as Record<string, unknown>;
    persistPortfolioSnapshot(f.repo, 1_000);
    const final = f.repo.db
      .prepare(
        "SELECT payload_json,refreshed_at_ms,last_reconciliation_at_ms FROM portfolio_persisted_snapshot WHERE snapshot_key='current'",
      )
      .get();
    expect(final).toEqual(newer);
  } finally {
    f.close();
  }
});
