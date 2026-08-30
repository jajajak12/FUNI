import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import {
  isSqliteBusy,
  retrySqliteBusy,
  retrySqliteBusySync,
} from "../apps/telegram-lp-bot/src/sqlite-busy.js";
import { createOrReuseDirectLookup } from "../apps/cli/src/direct-token-lookup.js";
import { getAddress } from "viem";

const busy = Object.assign(new Error("database is locked"), {
  code: "SQLITE_BUSY",
});
describe("Telegram SQLite busy handling", () => {
  it("keeps expired active-flow lookup read-only and correct while another connection holds the writer lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "funi-active-flow-readonly-")),
      path = join(dir, "db.sqlite");
    migrateSqlite(path, "infra/migrations");
    const seed = new SqliteLedgerRepository(path),
      expired = seed.createTelegramFlow({
        userId: "u",
        chatId: "c",
        state: { kind: "token_entry" },
        now: 1_000,
        ttlMs: 10,
      });
    seed.close();
    const lock = new Database(path),
      reader = new SqliteLedgerRepository(path, { busyTimeoutMs: 1 });
    try {
      lock.exec("BEGIN IMMEDIATE");
      lock
        .prepare(
          "UPDATE telegram_flow_sessions SET updated_at_ms=updated_at_ms WHERE session_id=?",
        )
        .run(expired.sessionId);
      expect(
        reader.activeTelegramFlow({ userId: "u", chatId: "c", now: 1_011 }),
      ).toBeUndefined();
      expect(
        reader.db
          .prepare(
            "SELECT status FROM telegram_flow_sessions WHERE session_id=?",
          )
          .get(expired.sessionId),
      ).toEqual({ status: "active" });
      lock.exec("COMMIT");
      const replacement = reader.createTelegramFlow({
        userId: "u",
        chatId: "c",
        state: { kind: "pool" },
        now: 1_012,
        ttlMs: 100,
      });
      expect(
        reader.activeTelegramFlow({ userId: "u", chatId: "c", now: 1_013 })
          ?.sessionId,
      ).toBe(replacement.sessionId);
      expect(
        reader.db
          .prepare(
            "SELECT status FROM telegram_flow_sessions WHERE session_id=?",
          )
          .get(expired.sessionId),
      ).toEqual({ status: "expired" });
    } finally {
      try {
        lock.close();
      } catch {}
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("recovers a transient direct-lookup create BUSY with exactly one durable request", () => {
    const dir = mkdtempSync(join(tmpdir(), "funi-direct-create-busy-")),
      path = join(dir, "db.sqlite");
    migrateSqlite(path, "infra/migrations");
    const repo = new SqliteLedgerRepository(path);
    let calls = 0;
    try {
      const result = retrySqliteBusySync({
        operation: "createOrReuseDirectLookup",
        baseWaitMs: 1,
        log: () => {},
        run: () => {
          calls++;
          if (calls === 1) throw busy;
          return createOrReuseDirectLookup({
            repo,
            token: getAddress("0x0000000000000000000000000000000000000042"),
            nowMs: 1_000,
          });
        },
      });
      expect(result.created).toBe(true);
      expect(calls).toBe(2);
      expect(
        repo.db
          .prepare("SELECT COUNT(*) count FROM direct_token_lookup_requests")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("exhausts direct-lookup create BUSY cleanly without creating a request", () => {
    const dir = mkdtempSync(join(tmpdir(), "funi-direct-create-exhausted-")),
      path = join(dir, "db.sqlite");
    migrateSqlite(path, "infra/migrations");
    const repo = new SqliteLedgerRepository(path);
    try {
      expect(() =>
        retrySqliteBusySync({
          operation: "createOrReuseDirectLookup",
          baseWaitMs: 1,
          maxAttempts: 2,
          log: () => {},
          run: () => {
            throw busy;
          },
        }),
      ).toThrow(
        "SQLITE_TRANSIENT_RETRY_EXHAUSTED:createOrReuseDirectLookup:SQLITE_BUSY",
      );
      expect(
        repo.db
          .prepare("SELECT COUNT(*) count FROM direct_token_lookup_requests")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        repo.db
          .prepare("SELECT COUNT(*) count FROM telegram_flow_sessions")
          .get(),
      ).toEqual({ count: 0 });
      const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
        section = source.slice(
          source.indexOf("async function beginToken"),
          source.indexOf("function renderPoolListing"),
        );
      expect(section.indexOf("message = await ctx.reply")).toBeLessThan(
        section.indexOf("retrySqliteBusySync"),
      );
      expect(section.indexOf("retrySqliteBusySync")).toBeLessThan(
        section.indexOf("attachDirectLookupSubscriber"),
      );
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("retries a flow write and preserves the single successful transition", async () => {
    let calls = 0,
      transitions = 0;
    const events: any[] = [];
    const value = await retrySqliteBusy({
      operation: "transitionTelegramFlow",
      baseWaitMs: 1,
      log: (event, data) => events.push({ event, data }),
      run: () => {
        calls++;
        if (calls < 3) throw busy;
        transitions++;
        return "v4_amount";
      },
    });
    expect(value).toBe("v4_amount");
    expect(transitions).toBe(1);
    expect(
      events.filter((x) => x.data.finalDisposition === "RETRYING"),
    ).toHaveLength(2);
    expect(events.at(-1)?.data).toMatchObject({
      operation: "transitionTelegramFlow",
      attempt: 3,
      delayMs: 0,
      sqliteCode: "SQLITE_OK",
      finalDisposition: "RECOVERED",
    });
  });
  it("retries an actual held SQLite write lock and reaches v4_amount once released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "funi-telegram-busy-")),
      path = join(dir, "db.sqlite");
    migrateSqlite(path, "infra/migrations");
    const seed = new SqliteLedgerRepository(path),
      flow = seed.createTelegramFlow({
        userId: "u",
        chatId: "c",
        state: { kind: "v4_mode" },
        now: 1_700_000_000_000,
        ttlMs: 600_000,
      });
    seed.close();
    const lock = new Database(path);
    lock.exec("BEGIN IMMEDIATE");
    setTimeout(() => lock.exec("COMMIT"), 20);
    try {
      const next = await retrySqliteBusy({
        operation: "transitionTelegramFlowCAS",
        baseWaitMs: 1,
        log: () => {},
        run: () => {
          const repo = new SqliteLedgerRepository(path, { busyTimeoutMs: 1 });
          try {
            return repo.transitionTelegramFlowCAS({
              userId: "u",
              chatId: "c",
              sessionId: flow.sessionId,
              expectedRevision: flow.flowRevision,
              expectedStatus: "active",
              nextState: { kind: "v4_amount" },
              now: 1_700_000_000_001,
              ttlMs: 600_000,
            });
          } finally {
            repo.close();
          }
        },
      });
      expect(next.result).toBe("APPLIED");
      expect(next.flow?.state.kind).toBe("v4_amount");
    } finally {
      try {
        lock.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("exhausts safely without invoking any transaction path", () => {
    let calls = 0,
      transactions = 0;
    const events: any[] = [];
    expect(() =>
      retrySqliteBusySync({
        operation: "transitionTelegramFlow",
        baseWaitMs: 1,
        maxAttempts: 2,
        log: (event, data) => events.push({ event, data }),
        run: () => {
          calls++;
          throw busy;
        },
      }),
    ).toThrow(
      "SQLITE_TRANSIENT_RETRY_EXHAUSTED:transitionTelegramFlow:SQLITE_BUSY",
    );
    expect(calls).toBe(2);
    expect(transactions).toBe(0);
    expect(isSqliteBusy(busy)).toBe(true);
    expect(events.at(-1)?.data).toMatchObject({
      operation: "transitionTelegramFlow",
      attempt: 2,
      delayMs: 0,
      sqliteCode: "SQLITE_BUSY",
      finalDisposition: "DEFERRED",
    });
  });
  it("keeps a non-fatal process-level catch handler installed", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("apps/telegram-lp-bot/src/index.ts", "utf8"),
    );
    expect(source).toMatch(/bot\.catch\s*\(\s*async\s*\(\s*error\s*\)\s*=>/);
    expect(source).toContain(
      "Temporarily busy. Please tap the button again in a moment.",
    );
    expect(source).toMatch(/retryable\s*:\s*busy/);
  });
  it("routes every address-input mutation through the canonical bounded helper", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      ledger = readFileSync("packages/lp-ledger/src/index.ts", "utf8"),
      begin = source.slice(
        source.indexOf("async function beginToken"),
        source.indexOf("function renderPoolListing"),
      );
    expect(begin).toContain('telegramFlowWrite("persistPoolListing"');
    expect(begin).toContain('telegramFlowWrite("attachDirectLookupSubscriber"');
    expect(begin).toContain("advanceFlow(");
    expect(begin).toContain(
      'retrySqliteBusySync({\n      operation: "createOrReuseDirectLookup"',
    );
    expect(
      source.slice(
        source.indexOf("function newFlow"),
        source.indexOf("function loadFlow"),
      ),
    ).toContain('telegramFlowWrite("createTelegramFlow"');
    expect(
      ledger.slice(
        ledger.indexOf("activeTelegramFlow(input:"),
        ledger.indexOf("transitionTelegramFlowCAS(input:"),
      ),
    ).not.toContain("UPDATE telegram_flow_sessions");
  });
});
