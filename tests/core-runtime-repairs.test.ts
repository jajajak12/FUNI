import Database from "better-sqlite3";
import { createRequire } from "node:module";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSqliteTransientLock,
  migrateSqlite,
  SQLITE_RUNTIME_BUSY_TIMEOUT_MS,
  SQLITE_TRANSIENT_RETRY_BUDGET_MS,
  SqliteLedgerRepository,
  withSqliteTransientRetrySync,
} from "@funi/ledger";
import { initializeTelegramRuntime } from "../apps/telegram-lp-bot/src/startup.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(prefix = "funi-core-runtime-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  const database = join(dir, "runtime.sqlite");
  migrateSqlite(database, "infra/migrations");
  return { dir, database };
}
const cliEnv = (dir: string, database: string) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: join(dir, "no-production-env"),
    DATA_DIR: dir,
    DATABASE_PATH: database,
    EXECUTION_ENABLED: "false",
    DRY_RUN: "true",
    EMERGENCY_PAUSE: "true",
    LIVE_CANARY_ENABLED: "false",
    V4_LIVE_CANARY_ENABLED: "false",
    MAX_POSITION_VALUE_USD: "1000",
    MAX_APPROVAL_VALUE_USD: "1000",
  };
  for (const key of [
    "LP_PRIVATE_KEY",
    "LP_MNEMONIC",
    "SEED_PHRASE",
    "MNEMONIC",
  ])
    delete env[key];
  return env;
};
const cliJson = (stdout: string) =>
  JSON.parse(stdout.slice(Math.max(0, stdout.lastIndexOf("\n{") + 1)));

describe("shared SQLite transient-lock policy", () => {
  it("uses one central busy timeout and recognizes BUSY/LOCKED extended variants only", () => {
    const f = fixture();
    const repo = new SqliteLedgerRepository(f.database, {
      busyTimeoutMs: SQLITE_RUNTIME_BUSY_TIMEOUT_MS,
    });
    try {
      expect(repo.db.pragma("busy_timeout", { simple: true })).toBe(
        SQLITE_RUNTIME_BUSY_TIMEOUT_MS,
      );
      expect(SQLITE_TRANSIENT_RETRY_BUDGET_MS).toBe(1500);
      for (const code of [
        "SQLITE_BUSY",
        "SQLITE_BUSY_SNAPSHOT",
        "SQLITE_LOCKED",
        "SQLITE_LOCKED_SHAREDCACHE",
      ])
        expect(
          isSqliteTransientLock(
            Object.assign(new Error("transient"), { code }),
          ),
        ).toBe(true);
      for (const code of [
        "SQLITE_CONSTRAINT",
        "SQLITE_SCHEMA",
        "SQLITE_CORRUPT",
        "SQLITE_IOERR",
      ])
        expect(
          isSqliteTransientLock(Object.assign(new Error("terminal"), { code })),
        ).toBe(false);
    } finally {
      repo.close();
    }
  });
  it("does not retry non-transient failures", () => {
    let calls = 0;
    expect(() =>
      withSqliteTransientRetrySync({
        operation: "constraint_write",
        run: () => {
          calls++;
          throw Object.assign(new Error("constraint failed"), {
            code: "SQLITE_CONSTRAINT_UNIQUE",
          });
        },
      }),
    ).toThrow("constraint failed");
    expect(calls).toBe(1);
  });
});

describe("reconcile lifecycle exact CLI and wrapper paths", () => {
  it("returns DEFERRED under a persistent lock, then succeeds once clear without duplicate writes or execution artifacts", () => {
    const f = fixture(),
      seed = new SqliteLedgerRepository(f.database);
    seed.ensurePosition(
      "test:1",
      "1",
      "0x0000000000000000000000000000000000000001",
    );
    seed.close();
    const lock = new Database(f.database);
    lock.exec("BEGIN IMMEDIATE");
    let deferred;
    try {
      deferred = spawnSync(
        "./node_modules/.bin/tsx",
        ["apps/cli/src/index.ts", "reconcile-all"],
        {
          cwd: process.cwd(),
          env: cliEnv(f.dir, f.database),
          encoding: "utf8",
          timeout: 30_000,
        },
      );
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
    expect(deferred.status).toBe(75);
    expect(cliJson(deferred.stdout)).toMatchObject({
      status: "DEFERRED",
      operation: "reconcile_all",
      sqliteCode: "SQLITE_BUSY",
      finalDisposition: "DEFERRED",
      reconciled: [],
      mainnetTransactionsSent: 0,
    });
    const recovered = spawnSync(
      "./node_modules/.bin/tsx",
      ["apps/cli/src/index.ts", "reconcile-all"],
      {
        cwd: process.cwd(),
        env: cliEnv(f.dir, f.database),
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(recovered.status).toBe(0);
    expect(cliJson(recovered.stdout)).toMatchObject({
      status: "SUCCESS",
      pendingTransactions: 0,
    });
    const verify = new SqliteLedgerRepository(f.database);
    try {
      expect(
        verify.db
          .prepare(
            "SELECT COUNT(*) count FROM reconciliation_runs WHERE id='startup:test:1'",
          )
          .get(),
      ).toEqual({ count: 1 });
      for (const table of [
        "transaction_intents",
        "transaction_receipts",
        "chain_nonce_mutex",
        "chain_transaction_journal",
        "chain_callback_authorizations",
      ])
        expect(
          verify.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
    } finally {
      verify.close();
    }
  });
  it("migrates a fresh public database before reconciliation", () => {
    const dir = mkdtempSync(join(tmpdir(), "funi-reconcile-terminal-"));
    roots.push(dir);
    const database = join(dir, "empty.sqlite");
    new Database(database).close();
    const result = spawnSync(
      "./node_modules/.bin/tsx",
      ["apps/cli/src/index.ts", "reconcile-all"],
      {
        cwd: process.cwd(),
        env: cliEnv(dir, database),
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(0);
    expect(cliJson(result.stdout)).toMatchObject({
      status: "SUCCESS",
      pendingTransactions: 0,
      mainnetTransactionsSent: 0,
    });
    const verify = new Database(database, { readonly: true });
    try {
      expect(verify.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(
        verify
          .prepare(
            "SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='pnl_card_deliveries'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      verify.close();
    }
  });
  it("keeps the shell alive after exit 75 and propagates the next terminal exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "funi-reconcile-wrapper-"));
    roots.push(dir);
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    mkdirSync(join(dir, "bin"));
    const counter = join(dir, "calls"),
      fakeTsx = join(dir, "node_modules/.bin/tsx"),
      fakeSleep = join(dir, "bin/sleep");
    writeFileSync(
      fakeTsx,
      `#!/usr/bin/env bash\ncount=0\n[[ -f '${counter}' ]] && count=$(< '${counter}')\ncount=$((count+1))\nprintf '%s' "$count" > '${counter}'\n[[ "$count" -eq 1 ]] && exit 75\nexit 42\n`,
    );
    writeFileSync(fakeSleep, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeTsx, 0o700);
    chmodSync(fakeSleep, 0o700);
    const result = spawnSync(
      "bash",
      [resolve("infra/pm2/reconcile-worker.sh")],
      {
        cwd: dir,
        env: {
          ...process.env,
          DATA_DIR: join(dir, "data"),
          PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
        },
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    expect(result.status).toBe(42);
    expect(readFileSync(counter, "utf8")).toBe("2");
  });
});

describe("canonical process exclusion and startup ownership", () => {
  it("runs the real Telegram initialization path as a read-only safety consumer and defers a persistent lock without throwing", () => {
    const f = fixture("funi-telegram-startup-"),
      seed = new SqliteLedgerRepository(f.database),
      authoritative = {
        executionEnabled: false,
        dryRun: true,
        emergencyPause: true,
        manualPause: false,
        effectiveEmergencyPause: true,
      };
    seed.persistSafetyState(authoritative);
    seed.ensurePosition(
      "telegram:1",
      "1",
      "0x0000000000000000000000000000000000000001",
    );
    seed.close();
    const events: Array<{ event: string; data: Record<string, unknown> }> = [],
      ready = initializeTelegramRuntime({
        databasePath: f.database,
        log: (event, data) => events.push({ event, data }),
        now: () => 1_700_000_000_000,
      });
    expect(ready).toMatchObject({ status: "READY", safety: authoritative });
    let verify = new SqliteLedgerRepository(f.database);
    expect(verify.safetyState()).toEqual(authoritative);
    verify.close();
    const lock = new Database(f.database);
    lock.exec("BEGIN IMMEDIATE");
    try {
      expect(
        initializeTelegramRuntime({
          databasePath: f.database,
          log: (event, data) => events.push({ event, data }),
          now: () => 1_700_000_000_001,
        }),
      ).toMatchObject({
        status: "DEFERRED",
        sqliteCode: "SQLITE_BUSY",
        finalDisposition: "DEFERRED",
      });
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
    verify = new SqliteLedgerRepository(f.database);
    try {
      expect(verify.safetyState()).toEqual(authoritative);
      for (const table of [
        "transaction_intents",
        "transaction_receipts",
        "chain_nonce_mutex",
        "chain_transaction_journal",
        "chain_callback_authorizations",
      ])
        expect(
          verify.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
    } finally {
      verify.close();
    }
  });
  it("includes only the public FUNI processes when optional chains are disabled", () => {
    const f = fixture("funi-ecosystem-"),
      prior = Object.fromEntries(
        ["FUNI_ENV_FILE", "BSC_ENABLED", "ETHEREUM_ENABLED"].map((key) => [
          key,
          process.env[key],
        ]),
      );
    Object.assign(process.env, {
      FUNI_ENV_FILE: join(f.dir, "absent.env"),
      BSC_ENABLED: "false",
      ETHEREUM_ENABLED: "false",
    });
    try {
      const require = createRequire(import.meta.url),
        target = require.resolve("../infra/pm2/ecosystem.config.cjs");
      delete require.cache[target];
      const ecosystem = require(target) as { apps: Array<{ name: string }> };
      expect(ecosystem.apps.map((app) => app.name)).toEqual([
        "funi-telegram",
        "funi-reconcile",
        "funi-v4-registry-worker",
        "funi-v4-state-cache-worker",
        "funi-v4-state-cache-urgent",
        "funi-v4-direct-lookup-worker",
      ]);
      expect(
        ecosystem.apps.some((app) => /bsc|ethereum|outcome/i.test(app.name)),
      ).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(prior))
        value === undefined
          ? delete process.env[key]
          : (process.env[key] = value);
    }
  });
  it("keeps Telegram and generic CLI startup read-only with no raw safety SQL", () => {
    const telegram = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      startup = readFileSync("apps/telegram-lp-bot/src/startup.ts", "utf8"),
      cli = readFileSync("apps/cli/src/index.ts", "utf8"),
      runtime = readFileSync("apps/cli/src/runtime.ts", "utf8");
    expect(startup).toContain(
      "initializeSafety(db,'READ_ONLY_SAFETY_CONSUMER')",
    );
    expect(cli).not.toMatch(
      /initializeSafety\([^\n]+AUTHORITATIVE_SAFETY_WRITER/,
    );
    expect(`${telegram}\n${startup}\n${cli}\n${runtime}`).not.toMatch(
      /(?:INSERT|UPDATE|REPLACE)\s+(?:INTO\s+)?operator_safety_state/i,
    );
  });
});
