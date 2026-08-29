import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bot } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { FallbackRpc, chainProfile, protocolDeployment } from "@funi/core";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import {
  runReadOnlyWorkerOnce,
  type ReadOnlyChainKey,
} from "../apps/workers/src/multichain-readonly-worker.js";
import {
  chainSelectorView,
  registerMultichainUx,
} from "../apps/telegram-lp-bot/src/multichain-ux.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0))
    rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "readonly-worker-"));
  cleanup.push(dir);
  return { dir, path: join(dir, "runtime.sqlite") };
}
const owner = "0x00000000000000000000000000000000000000bb" as const;

function rpcFor(key: ReadOnlyChainKey, reportedChainId?: number) {
  const profile = chainProfile(key),
    deployment = protocolDeployment(
      profile.chainId,
      key === "bsc" ? "pancakeswap_v3" : "uniswap_v3",
    ),
    pool = "0x00000000000000000000000000000000000000aa" as const,
    quote = profile.quoteTokens[0]!,
    wrapped = profile.wrappedNativeAddress,
    client = {
      getChainId: async () => reportedChainId ?? profile.chainId,
      getBytecode: async () => "0x01" as const,
      getBlockNumber: async () => 100n,
      getLogs: async () => [],
      getBlock: async () => ({
        number: 100n,
        timestamp: 1_700_000_000n,
        baseFeePerGas: key === "ethereum" ? 1n : null,
      }),
      readContract: async ({
        address,
        functionName,
        args,
      }: {
        address: string;
        functionName: string;
        args?: readonly unknown[];
      }) => {
        if (functionName === "getPool")
          return args?.[2] === 500
            ? pool
            : "0x0000000000000000000000000000000000000000";
        if (functionName === "feeAmountTickSpacing") return 10;
        if (functionName === "decimals")
          return address.toLowerCase() === quote.address.toLowerCase()
            ? quote.decimals
            : 18;
        if (functionName === "symbol")
          return address.toLowerCase() === quote.address.toLowerCase()
            ? quote.symbol
            : profile.nativeSymbol;
        if (functionName === "name")
          return address.toLowerCase() === quote.address.toLowerCase()
            ? quote.symbol
            : `Wrapped ${profile.nativeSymbol}`;
        if (functionName === "factory") return deployment.contracts.factory;
        if (functionName === "WETH9") return wrapped;
        if (functionName === "deployer")
          return deployment.contracts.poolDeployer;
        if (functionName === "token0") return quote.address;
        if (functionName === "token1") return wrapped;
        if (functionName === "fee") return 500;
        if (functionName === "tickSpacing") return 10;
        if (functionName === "slot0") return [1n, 0, 0, 0, 0, 0, true];
        if (functionName === "liquidity") return 5n;
        if (functionName === "ownerOf") return owner;
        if (functionName === "positions")
          return [
            0n,
            owner,
            quote.address,
            wrapped,
            500,
            -10,
            10,
            5n,
            0n,
            0n,
            1n,
            2n,
          ];
        throw new Error(`UNEXPECTED_READ:${functionName}`);
      },
    } as unknown as PublicClient;
  return new FallbackRpc(
    {
      chainId: profile.chainId,
      name: profile.displayName,
      nativeSymbol: profile.nativeSymbol,
      rpcUrls: ["https://example.invalid"],
      assets: {},
    },
    undefined,
    { clients: [client], timeoutMs: 100 },
  );
}

describe("read-only multi-chain workers", () => {
  it("stays disabled without opening SQLite and reports deterministic missing configuration", async () => {
    const f = fixture(),
      disabled = await runReadOnlyWorkerOnce({
        chain: "bsc",
        role: "registry",
        env: {},
        databasePath: f.path,
      });
    expect(disabled).toMatchObject({
      status: "DISABLED",
      blockerReason: expect.stringContaining("BSC_RPC_CONFIGURATION_MISSING"),
      signerConstructed: false,
      mainnetTransactionsSent: 0,
    });
    expect(existsSync(f.path)).toBe(false);
    const blocked = await runReadOnlyWorkerOnce({
      chain: "bsc",
      role: "registry",
      env: { BSC_ENABLED: "true" },
      databasePath: f.path,
    });
    expect(blocked).toMatchObject({
      status: "CONFIGURATION_BLOCKED",
      blockerReason: "BSC_RPC_CONFIGURATION_MISSING",
    });
    const repo = new SqliteLedgerRepository(f.path);
    try {
      expect(
        repo.chainRegistryCursor(
          56,
          "pancakeswap_v3",
          "deployment_verification",
        ),
      ).toBeDefined();
      expect(
        repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      repo.close();
    }
  });

  it("selects the exact chain, rejects wrong providers, and leaves FUNI evidence unchanged", async () => {
    const f = fixture();
    migrateSqlite(f.path, "infra/migrations");
    const repo = new SqliteLedgerRepository(f.path);
    try {
      repo.upsertChainPosition({
        chainId: 4663,
        protocol: "uniswap_v3",
        positionIdentifier: "funi-sentinel",
        provenance: "BOT_OPERATIONAL",
        lifecycleState: "open",
        payload: { unchanged: true },
      });
    } finally {
      repo.close();
    }
    const result = await runReadOnlyWorkerOnce({
      chain: "ethereum",
      role: "registry",
      env: {
        ETHEREUM_ENABLED: "true",
        ETHEREUM_RPC_URL: "https://example.invalid",
      },
      databasePath: f.path,
      rpc: rpcFor("ethereum", 56),
      maxRetries: 1,
    });
    expect(result).toMatchObject({
      chain: "ethereum",
      chainId: 1,
      status: "BLOCKED",
      blockerReason: "WRONG_CHAIN_PROVIDER:56:1",
    });
    const after = new SqliteLedgerRepository(f.path);
    try {
      expect(
        JSON.parse(
          String(
            after.chainPosition(4663, "uniswap_v3", "funi-sentinel")!
              .payload_json,
          ),
        ),
      ).toEqual({ unchanged: true });
      expect(
        after.db
          .prepare("SELECT COUNT(*) count FROM chain_pools WHERE chain_id=1")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      after.close();
    }
  });

  it("persists restart-safe registry/state cursors, chain keys, provenance, and no execution artifacts", async () => {
    const f = fixture();
    migrateSqlite(f.path, "infra/migrations");
    const repo = new SqliteLedgerRepository(f.path);
    try {
      repo.upsertChainPosition({
        chainId: 56,
        protocol: "pancakeswap_v3",
        positionIdentifier: "7",
        provenance: "BOT_OPERATIONAL",
        lifecycleState: "ACTIVE",
      });
      repo.upsertChainPosition({
        chainId: 56,
        protocol: "pancakeswap_v3",
        positionIdentifier: "8",
        provenance: "MANUAL_EXTERNAL",
        lifecycleState: "ACTIVE",
      });
      repo.upsertChainPosition({
        chainId: 1,
        protocol: "uniswap_v3",
        positionIdentifier: "7",
        provenance: "MANUAL_EXTERNAL",
        lifecycleState: "ETH_SENTINEL",
        payload: { chain: "ethereum" },
      });
    } finally {
      repo.close();
    }
    const baseEnv = {
        BSC_ENABLED: "true",
        BSC_RPC_URLS: "https://example.invalid",
      },
      guardedEnv = new Proxy(baseEnv, {
        get(target, key, receiver) {
          if (
            typeof key === "string" &&
            /(PRIVATE|MNEMONIC|SEED|WALLET)/.test(key)
          )
            throw new Error("PRIVATE_CONFIGURATION_ACCESSED");
          return Reflect.get(target, key, receiver);
        },
      });
    for (let pass = 0; pass < 2; pass++)
      expect(
        await runReadOnlyWorkerOnce({
          chain: "bsc",
          role: "registry",
          env: guardedEnv,
          databasePath: f.path,
          rpc: rpcFor("bsc"),
        }),
      ).toMatchObject({ status: "COMPLETED", poolsRefreshed: 1 });
    for (let pass = 0; pass < 2; pass++)
      expect(
        await runReadOnlyWorkerOnce({
          chain: "bsc",
          role: "state-cache",
          env: guardedEnv,
          databasePath: f.path,
          rpc: rpcFor("bsc"),
        }),
      ).toMatchObject({
        status: "COMPLETED",
        poolsRefreshed: 1,
        positionsRefreshed: 2,
      });
    const after = new SqliteLedgerRepository(f.path);
    try {
      expect(
        after.db
          .prepare(
            "SELECT COUNT(*) count FROM chain_registry_cursors WHERE chain_id=56 AND protocol='pancakeswap_v3'",
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(
        after.db
          .prepare(
            "SELECT chain_id,protocol,validation_status FROM chain_pools",
          )
          .all(),
      ).toEqual([
        {
          chain_id: 56,
          protocol: "pancakeswap_v3",
          validation_status: "VERIFIED_READ_ONLY",
        },
      ]);
      expect(after.chainPosition(56, "pancakeswap_v3", "7")!.provenance).toBe(
        "BOT_OPERATIONAL",
      );
      expect(after.chainPosition(56, "pancakeswap_v3", "8")!.provenance).toBe(
        "MANUAL_EXTERNAL",
      );
      expect(after.chainPosition(1, "uniswap_v3", "7")).toMatchObject({
        provenance: "MANUAL_EXTERNAL",
        lifecycle_state: "ETH_SENTINEL",
      });
      expect(
        JSON.parse(
          String(after.chainPosition(1, "uniswap_v3", "7")!.payload_json),
        ),
      ).toEqual({ chain: "ethereum" });
      for (const table of [
        "chain_nonce_mutex",
        "chain_transaction_journal",
        "chain_callback_authorizations",
      ])
        expect(
          after.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
    } finally {
      after.close();
    }
  });
});

describe("canonical PM2 and Telegram registration", () => {
  it("keeps optional multichain workers disabled by default and signer-free when enabled", () => {
    const f = fixture(),
      prior = {
        file: process.env.FUNI_ENV_FILE,
        bsc: process.env.BSC_ENABLED,
        eth: process.env.ETHEREUM_ENABLED,
      };
    process.env.FUNI_ENV_FILE = join(f.dir, "absent.env");
    process.env.BSC_ENABLED = "false";
    process.env.ETHEREUM_ENABLED = "false";
    try {
      const require = createRequire(import.meta.url),
        resolved = require.resolve("../infra/pm2/ecosystem.config.cjs");
      delete require.cache[resolved];
      const ecosystem = require(resolved) as { apps: Array<Record<string, unknown>> };
      expect(
        ecosystem.apps.some(
          (app) =>
            String(app.name).startsWith("funi-bsc-") ||
            String(app.name).startsWith("funi-ethereum-"),
        ),
      ).toBe(false);
      process.env.BSC_ENABLED = "true";
      delete require.cache[resolved];
      const enabledEcosystem = require(resolved) as {
        apps: Array<{ name: string; script: string; env: Record<string, string> }>;
      };
      const bscApps = enabledEcosystem.apps.filter((app) => app.name.startsWith("funi-bsc-"));
      expect(bscApps.map((app) => app.name)).toEqual([
        "funi-bsc-registry-worker",
        "funi-bsc-state-cache-worker",
      ]);
      for (const app of bscApps) {
        expect(app.script).toBe("infra/pm2/start-multichain-readonly-worker.sh");
        expect(app.env).toMatchObject({
          BSC_EXECUTION_ENABLED: "false",
          BSC_DRY_RUN: "true",
          BSC_EMERGENCY_PAUSE: "true",
          LP_PRIVATE_KEY: "",
        });
      }
    } finally {
      prior.file === undefined
        ? delete process.env.FUNI_ENV_FILE
        : (process.env.FUNI_ENV_FILE = prior.file);
      prior.bsc === undefined
        ? delete process.env.BSC_ENABLED
        : (process.env.BSC_ENABLED = prior.bsc);
      prior.eth === undefined
        ? delete process.env.ETHEREUM_ENABLED
        : (process.env.ETHEREUM_ENABLED = prior.eth);
    }
  });

  it("imports and registers /chains once while absent new-chain RPCs expose no execution callback", () => {
    const bot = new Bot("123:test"),
      command = vi.spyOn(bot, "command"),
      callback = vi.spyOn(bot, "callbackQuery"),
      registration = registerMultichainUx(bot, {});
    expect(registration.commands).toEqual(["chains", "chainpool"]);
    expect(
      command.mock.calls.filter((call) => call[0] === "chains"),
    ).toHaveLength(1);
    expect(
      command.mock.calls.filter((call) => call[0] === "chainpool"),
    ).toHaveLength(1);
    expect(callback).toHaveBeenCalledTimes(1);
    const view = chainSelectorView({});
    expect(
      view.rows
        .filter((row) => row.key !== "robinhood")
        .every(
          (row) =>
            !row.readOnlyAvailable &&
            !row.executionAvailable &&
            row.blockerReason?.includes("RPC_CONFIGURATION_MISSING"),
        ),
    ).toBe(true);
    expect(JSON.stringify(view.keyboard)).not.toContain("mc:x:");
    const telegramSource = readFileSync(
      "apps/telegram-lp-bot/src/index.ts",
      "utf8",
    );
    expect(telegramSource.match(/registerMultichainUx\(bot,/g)).toHaveLength(1);
  });
});
