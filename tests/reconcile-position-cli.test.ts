import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "reconcile-position-cli-")),
    databasePath = join(root, "ledger.sqlite");
  roots.push(root);
  migrateSqlite(databasePath, "infra/migrations");
  const repo = new SqliteLedgerRepository(databasePath);
  repo.ensurePosition("v4:123", "123", "pool");
  repo.persistSafetyState({
    manualPause: true,
    executionEnabled: false,
    dryRun: true,
    emergencyPause: true,
  });
  repo.close();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: join(root, "absent.env"),
    DATA_DIR: root,
    DATABASE_PATH: databasePath,
    RH_CHAIN_ID: "4663",
    EXECUTION_ENABLED: "false",
    DRY_RUN: "true",
    EMERGENCY_PAUSE: "true",
    MAX_POSITION_VALUE_USD: "100",
    MAX_APPROVAL_VALUE_USD: "100",
  };
  for (const key of Object.keys(env))
    if (/^NOVA_/.test(key)) delete env[key];
  const run = (...args: string[]) =>
    spawnSync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      ["apps/cli/src/index.ts", ...args],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
  return { databasePath, run };
}

describe("reconcile-position CLI command", () => {
  it("enqueues the enrolled position behind a closed safety gate without transaction side effects", () => {
    const f = fixture(),
      result = f.run("reconcile-position", "v4:123");
    expect(result.status, result.stderr).toBe(0);
    const commandOutputStart = result.stdout.lastIndexOf('{\n  "command"'),
      output = JSON.parse(result.stdout.slice(commandOutputStart).trim());
    expect(output).toMatchObject({
      command: "reconcile-position",
      positionId: "v4:123",
      queueStatus: "ENQUEUED",
      safetyVerified: true,
      signingUsed: false,
      broadcastUsed: false,
    });
    const repo = new SqliteLedgerRepository(f.databasePath);
    expect(
      repo.db
        .prepare(
          "SELECT position_id,token_id,protocol_version,reason FROM targeted_position_reconciliation_requests",
        )
        .all(),
    ).toEqual([
      {
        position_id: "v4:123",
        token_id: "123",
        protocol_version: "v4",
        reason: "OPERATOR_TARGETED_RECONCILIATION",
      },
    ]);
    expect(
      repo.db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM chain_transaction_journal) journals,(SELECT COUNT(*) FROM nonce_mutex)+(SELECT COUNT(*) FROM chain_nonce_mutex) nonce_locks,(SELECT COUNT(*) FROM transaction_receipts) receipts",
        )
        .get(),
    ).toEqual({ journals: 0, nonce_locks: 0, receipts: 0 });
    repo.close();
  });

  it("rejects malformed IDs before enqueueing anything", () => {
    const f = fixture(),
      result = f.run("reconcile-position", "v4:0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RECONCILE_POSITION_ID_INVALID");
    const repo = new SqliteLedgerRepository(f.databasePath);
    expect(
      repo.db
        .prepare(
          "SELECT COUNT(*) count FROM targeted_position_reconciliation_requests",
        )
        .get(),
    ).toEqual({ count: 0 });
    repo.close();
  });
});
