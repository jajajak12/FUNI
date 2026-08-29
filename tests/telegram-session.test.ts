import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeExpiresAt,
  isExpired,
  migrateSqlite,
  SqliteLedgerRepository,
  type TelegramFlowSession,
} from "@funi/ledger";
import { canExecuteV3 } from "@funi/v3";

const ttl = 600_000,
  base = 1_700_000_000_000;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "funi-session-")),
    path = join(dir, "db.sqlite");
  migrateSqlite(path, join(process.cwd(), "infra/migrations"));
  return { dir, repo: new SqliteLedgerRepository(path) };
}
function advance(
  repo: SqliteLedgerRepository,
  flow: TelegramFlowSession,
  state: Record<string, unknown>,
  now: number,
) {
  const result = repo.transitionTelegramFlowCAS({
    userId: flow.userId,
    chatId: flow.chatId,
    sessionId: flow.sessionId,
    expectedRevision: flow.flowRevision,
    expectedStatus: "active",
    nextState: state,
    now,
    ttlMs: ttl,
  });
  expect(result.result).toBe("APPLIED");
  return result.flow!;
}

describe("Telegram persistent flow revision CAS and TTL", () => {
  it("uses epoch milliseconds without seconds/milliseconds comparisons", () => {
    expect(computeExpiresAt(base, ttl)).toBe(base + ttl);
    expect(isExpired(base + ttl, base + 59_000)).toBe(false);
    expect(isExpired(base + ttl, base + ttl)).toBe(true);
  });
  it("is valid immediately and after one minute, then expires with one status revision", () => {
    const { dir, repo } = fixture();
    try {
      const flow = repo.createTelegramFlow({
        userId: "u",
        chatId: "c",
        state: { kind: "pool" },
        now: base,
        ttlMs: ttl,
      });
      expect(flow.flowRevision).toBe(0);
      expect(
        repo.telegramFlow({
          userId: "u",
          chatId: "c",
          sessionId: flow.sessionId,
          now: base + 60_000,
        })?.status,
      ).toBe("active");
      const expired = repo.telegramFlow({
        userId: "u",
        chatId: "c",
        sessionId: flow.sessionId,
        now: base + ttl,
      })!;
      expect(expired).toMatchObject({ status: "expired", flowRevision: 1 });
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("increments exactly once and refreshes TTL on each interactive transition", () => {
    const { dir, repo } = fixture();
    try {
      let flow: TelegramFlowSession = repo.createTelegramFlow({
        userId: "u",
        chatId: "c",
        state: { kind: "pool" },
        now: base,
        ttlMs: ttl,
      });
      const expiries: number[] = [];
      for (const [index, kind] of [
        "range",
        "asset",
        "amount",
        "amount",
        "asset",
      ].entries()) {
        flow = advance(repo, flow, { kind }, base + (index + 1) * 60_000);
        expiries.push(flow.expiresAtMs);
      }
      expect(expiries).toEqual([
        base + 660_000,
        base + 720_000,
        base + 780_000,
        base + 840_000,
        base + 900_000,
      ]);
      expect(flow).toMatchObject({ flowRevision: 5, state: { kind: "asset" } });
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("allows exactly one of two callbacks from the same revision", () => {
    const { dir, repo } = fixture();
    try {
      const pool = repo.createTelegramFlow({
          userId: "u",
          chatId: "c",
          state: { kind: "pool" },
          now: base,
          ttlMs: ttl,
        }),
        first = repo.transitionTelegramFlowCAS({
          userId: "u",
          chatId: "c",
          sessionId: pool.sessionId,
          expectedRevision: 0,
          expectedStatus: "active",
          nextState: { kind: "v4_strategy" },
          now: base + 1,
          ttlMs: ttl,
        }),
        second = repo.transitionTelegramFlowCAS({
          userId: "u",
          chatId: "c",
          sessionId: pool.sessionId,
          expectedRevision: 0,
          expectedStatus: "active",
          nextState: { kind: "other_strategy" },
          now: base + 1,
          ttlMs: ttl,
        });
      expect(first.result).toBe("APPLIED");
      expect(second).toMatchObject({
        result: "REVISION_CONFLICT",
        observedRevision: 1,
      });
      expect(
        repo.activeTelegramFlow({ userId: "u", chatId: "c", now: base + 2 }),
      ).toMatchObject({ flowRevision: 1, state: { kind: "v4_strategy" } });
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("proves ASSET_A and ASSET_B late pool outboxes cannot rewind strategy or depth", () => {
    const { dir, repo } = fixture();
    try {
      let flow: TelegramFlowSession = repo.createTelegramFlow({
        userId: "u",
        chatId: "c",
        state: {
          kind: "pool",
          token: "0x0000000000000000000000000000000000000048",
        },
        now: base,
        ttlMs: ttl,
      });
      const originatingRevision = flow.flowRevision;
      flow = advance(
        repo,
        flow,
        { ...flow.state, kind: "v4_strategy" },
        base + 1,
      );
      const assetA = repo.transitionTelegramFlowCAS({
        userId: "u",
        chatId: "c",
        sessionId: flow.sessionId,
        expectedRevision: originatingRevision,
        expectedStatus: "active",
        nextState: {
          kind: "pool",
          token: "0x0000000000000000000000000000000000000048",
          fresh: true,
        },
        now: base + 2,
        ttlMs: ttl,
      });
      expect(assetA).toMatchObject({
        result: "REVISION_CONFLICT",
        observedRevision: 1,
      });
      flow = advance(
        repo,
        flow,
        {
          ...flow.state,
          kind: "v4_bid_ladder_depth",
          token: "0x0000000000000000000000000000000000000049",
        },
        base + 3,
      );
      const assetB = repo.transitionTelegramFlowCAS({
        userId: "u",
        chatId: "c",
        sessionId: flow.sessionId,
        expectedRevision: originatingRevision,
        expectedStatus: "active",
        nextState: {
          kind: "pool",
          token: "0x0000000000000000000000000000000000000049",
          fresh: true,
        },
        now: base + 4,
        ttlMs: ttl,
      });
      expect(assetB).toMatchObject({
        result: "REVISION_CONFLICT",
        observedRevision: 2,
      });
      expect(
        repo.activeTelegramFlow({ userId: "u", chatId: "c", now: base + 5 }),
      ).toMatchObject({
        flowRevision: 2,
        state: { kind: "v4_bid_ladder_depth" },
      });
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("proves outbox-first evidence applies and the next pool callback remains current", () => {
    const { dir, repo } = fixture();
    try {
      const pool = repo.createTelegramFlow({
          userId: "u",
          chatId: "c",
          state: { kind: "pool" },
          now: base,
          ttlMs: ttl,
        }),
        outbox = repo.transitionTelegramFlowCAS({
          userId: "u",
          chatId: "c",
          sessionId: pool.sessionId,
          expectedRevision: pool.flowRevision,
          expectedStatus: "active",
          nextState: { kind: "pool", freshEvidence: true },
          now: base + 1,
          ttlMs: ttl,
        });
      expect(outbox).toMatchObject({ result: "APPLIED", resultingRevision: 1 });
      const selected = repo.transitionTelegramFlowCAS({
        userId: "u",
        chatId: "c",
        sessionId: pool.sessionId,
        expectedRevision: outbox.flow!.flowRevision,
        expectedStatus: "active",
        nextState: { kind: "v4_strategy", freshEvidence: true },
        now: base + 2,
        ttlMs: ttl,
      });
      expect(selected).toMatchObject({
        result: "APPLIED",
        resultingRevision: 2,
      });
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("fails late outboxes closed after cancel, start-over, and a new CA supersede", () => {
    const { dir, repo } = fixture();
    try {
      const pool = repo.createTelegramFlow({
          userId: "u",
          chatId: "c",
          state: { kind: "pool" },
          now: base,
          ttlMs: ttl,
        }),
        cancel = repo.cancelTelegramFlow({
          userId: "u",
          chatId: "c",
          sessionId: pool.sessionId,
          expectedRevision: pool.flowRevision,
          state: pool.state,
          now: base + 1,
        });
      expect(cancel).toMatchObject({
        result: "APPLIED",
        resultingRevision: 1,
        flow: { status: "cancelled" },
      });
      expect(
        repo.transitionTelegramFlowCAS({
          userId: "u",
          chatId: "c",
          sessionId: pool.sessionId,
          expectedRevision: 0,
          expectedStatus: "active",
          nextState: { kind: "pool" },
          now: base + 2,
          ttlMs: ttl,
        }).result,
      ).toBe("STATUS_CONFLICT");
      const start = repo.createTelegramFlow({
          userId: "u",
          chatId: "c",
          state: { kind: "token_entry" },
          now: base + 3,
          ttlMs: ttl,
        }),
        newCa = repo.createTelegramFlow({
          userId: "u",
          chatId: "c",
          state: { kind: "pool", token: "new" },
          now: base + 4,
          ttlMs: ttl,
        });
      expect(
        repo.transitionTelegramFlowCAS({
          userId: "u",
          chatId: "c",
          sessionId: start.sessionId,
          expectedRevision: start.flowRevision,
          expectedStatus: "active",
          nextState: { kind: "pool", token: "old" },
          now: base + 5,
          ttlMs: ttl,
        }).result,
      ).toBe("STATUS_CONFLICT");
      expect(
        repo.activeTelegramFlow({ userId: "u", chatId: "c", now: base + 5 })
          ?.sessionId,
      ).toBe(newCa.sessionId);
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects old and cross-scope sessions without touching the replacement flow", () => {
    const { dir, repo } = fixture();
    try {
      const old = repo.createTelegramFlow({
          userId: "u",
          chatId: "c",
          state: { kind: "range" },
          now: base,
          ttlMs: ttl,
        }),
        current = repo.createTelegramFlow({
          userId: "u",
          chatId: "c",
          state: { kind: "asset" },
          now: base + 1,
          ttlMs: ttl,
        });
      expect(
        repo.transitionTelegramFlowCAS({
          userId: "u",
          chatId: "c",
          sessionId: old.sessionId,
          expectedRevision: old.flowRevision,
          expectedStatus: "active",
          nextState: { kind: "amount" },
          now: base + 2,
          ttlMs: ttl,
        }).result,
      ).toBe("STATUS_CONFLICT");
      expect(
        repo.transitionTelegramFlowCAS({
          userId: "other",
          chatId: "c",
          sessionId: current.sessionId,
          expectedRevision: current.flowRevision,
          expectedStatus: "active",
          nextState: { kind: "amount" },
          now: base + 2,
          ttlMs: ttl,
        }).result,
      ).toBe("NOT_FOUND");
      expect(
        repo.activeTelegramFlow({ userId: "u", chatId: "c", now: base + 2 }),
      ).toMatchObject({
        sessionId: current.sessionId,
        state: { kind: "asset" },
      });
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("startup recovery retains non-expired sessions and revises expired sessions once", () => {
    const { dir, repo } = fixture();
    try {
      const fresh = repo.createTelegramFlow({
        userId: "u",
        chatId: "c",
        state: { kind: "pool" },
        now: base,
        ttlMs: ttl,
      });
      expect(repo.recoverTelegramFlows(base + 1)).toBe(0);
      expect(repo.recoverTelegramFlows(base + ttl)).toBe(1);
      expect(repo.recoverTelegramFlows(base + ttl + 1)).toBe(0);
      expect(
        repo.telegramFlow({
          userId: "u",
          chatId: "c",
          sessionId: fresh.sessionId,
          now: base + ttl + 1,
        }),
      ).toMatchObject({ status: "expired", flowRevision: 1 });
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("retains the execution gate as blocked", () => {
    expect(
      canExecuteV3({ status: "unavailable", reason: "no" }, false, true, true)
        .allowed,
    ).toBe(false);
  });
});
