import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { robinhoodMainnet } from "@funi/core";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import { poolId, sqrtPriceAtTick, type V4PoolState } from "@funi/v4";
import {
  createV4BidLadderLive,
  previewV4BidLadder,
} from "../apps/cli/src/v4-bid-ladder-operator.js";
import {
  classifyV4BidLadderUsdResetOutputs,
  evaluateV4BidLadderUsdResetEligibility,
  processV4BidLadderUsdReset,
} from "../apps/cli/src/v4-bid-ladder-usdg-reset.js";
import { executeV4BidLadderManualClose } from "../apps/cli/src/v4-bid-ladder-live.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const wallet = "0x00000000000000000000000000000000000000aa" as const,
  target = "0x0000000000000000000000000000000000000001" as const,
  zero = "0x0000000000000000000000000000000000000000" as const,
  usdg = robinhoodMainnet.assets.USDG;
function state(tick: number, block: bigint): V4PoolState {
  const [currency0, currency1] = [target, usdg].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    ) as [typeof target, typeof usdg],
    key = { currency0, currency1, fee: 3000, tickSpacing: 10, hooks: zero };
  return {
    id: poolId(key),
    key,
    sqrtPriceX96: sqrtPriceAtTick(tick),
    tick,
    liquidity: 10n ** 24n,
    initialized: true,
    blockNumber: block,
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "usdg-reset-")),
    path = join(root, "ledger.sqlite");
  roots.push(root);
  migrateSqlite(path, "infra/migrations");
  return new SqliteLedgerRepository(path);
}
function create(
  repo: SqliteLedgerRepository,
  depth: number,
  tick = 0,
  block = 1n,
  capital = 1_000_000_000n,
  reset?: {
    rootLadderId: string;
    previousLadderId: string;
    generation: number;
    creationReason: "USDG_RESET_REPOSITION";
  },
) {
  const preview = previewV4BidLadder({
    pool: state(tick, block),
    funding: { address: usdg, symbol: "USDG", decimals: 6 },
    target: { address: target, symbol: "TOKEN", decimals: 18 },
    totalFundingAmount: capital,
    maxDownsideBps: depth,
    owner: wallet,
    deadline: 9_999_999n,
    nowMs: Number(block) * 1000,
  });
  createV4BidLadderLive(repo, preview, Number(capital) / 1e6, reset);
  return preview;
}
function truths(input: {
  fundingIndex: 0 | 1;
  targetIndex: 0 | 1;
  targetPrincipal?: bigint;
  targetFee?: bigint;
  block?: bigint;
}) {
  const block = input.block ?? 10n;
  return Array.from({ length: 5 }, (_, index) => {
    const principal = { token0: 0n, token1: 0n },
      fees = { token0: 0n, token1: 0n };
    principal[input.fundingIndex === 0 ? "token0" : "token1"] = 100n;
    principal[input.targetIndex === 0 ? "token0" : "token1"] =
      index === 3 ? (input.targetPrincipal ?? 0n) : 0n;
    fees[input.targetIndex === 0 ? "token0" : "token1"] = input.targetFee ?? 0n;
    return {
      tokenId: BigInt(index + 1),
      owner: wallet,
      poolId: `0x${"1".repeat(64)}` as const,
      tickLower: index * 10,
      tickUpper: index * 10 + 10,
      liquidity: 1000n,
      principal,
      fees,
      blockNumber: block,
    };
  });
}
function eligible(input: {
  fundingIndex: 0 | 1;
  targetIndex: 0 | 1;
  targetPrincipal?: bigint;
  targetFee?: bigint;
  legs?: ReturnType<typeof truths>;
  unresolved?: number;
  ambiguous?: boolean;
}) {
  const legs = input.legs ?? truths(input);
  return evaluateV4BidLadderUsdResetEligibility({
    wallet,
    expectedPoolId: `0x${"1".repeat(64)}`,
    fundingIndex: input.fundingIndex,
    targetIndex: input.targetIndex,
    expectedLegs: legs.map((x) => ({
      tokenId: x.tokenId,
      tickLower: x.tickLower,
      tickUpper: x.tickUpper,
    })),
    legs,
    unresolvedTransactions: input.unresolved ?? 0,
    nonceAmbiguous: input.ambiguous ?? false,
  });
}

describe("USDG Reset Reposition V1", () => {
  it("uses exact economic principal in either orientation and ignores target-token fees", () => {
    for (const orientation of [
      { fundingIndex: 0 as const, targetIndex: 1 as const },
      { fundingIndex: 1 as const, targetIndex: 0 as const },
    ]) {
      expect(eligible({ ...orientation }).eligible).toBe(true);
      expect(eligible({ ...orientation, targetFee: 9n }).eligible).toBe(true);
      const oneAtom = eligible({ ...orientation, targetPrincipal: 1n });
      expect(oneAtom.eligible).toBe(false);
      expect(oneAtom.blockers).toContain(
        "REPOSITION_TARGET_PRINCIPAL_NONZERO:3",
      );
    }
  });
  it("fails closed for incoherent identity, unresolved transactions, or nonce ambiguity", () => {
    const base = { fundingIndex: 1 as const, targetIndex: 0 as const },
      mixed = truths(base);
    mixed[4] = { ...mixed[4]!, blockNumber: 11n };
    expect(eligible({ ...base, legs: mixed }).blockers).toContain(
      "REPOSITION_STATE_NOT_COHERENT",
    );
    expect(eligible({ ...base, unresolved: 1 }).blockers).toContain(
      "REPOSITION_UNRESOLVED_TRANSACTION",
    );
    expect(eligible({ ...base, ambiguous: true }).blockers).toContain(
      "REPOSITION_NONCE_AMBIGUOUS",
    );
  });
  it("keeps USDG and target fees outside exact child capital", () => {
    const out = classifyV4BidLadderUsdResetOutputs({
      principal: { token0: 0n, token1: 1_900_000_000n },
      transfers: { token0: 77n, token1: 1_900_123_456n },
      fundingIndex: 1,
      targetIndex: 0,
    });
    expect(out).toMatchObject({
      returnedUsdgPrincipal: 1_900_000_000n,
      returnedTargetPrincipal: 0n,
      returnedUsdgFee: 123_456n,
      returnedTargetFee: 77n,
    });
    expect(() =>
      classifyV4BidLadderUsdResetOutputs({
        principal: { token0: 2n, token1: 1n },
        transfers: { token0: 1n, token1: 1n },
        fundingIndex: 1,
        targetIndex: 0,
      }),
    ).toThrow("REPOSITION_PRINCIPAL_EXCEEDS_RECEIPT_TRANSFER");
  });
  it("inherits -60% and custom depth while rebuilding fresh five-leg geometry and exact capital", () => {
    for (const depth of [6000, 4700]) {
      const repo = fixture();
      try {
        const parent = create(repo, depth),
          parentRow = repo.loadBidLadderUsdReset(parent.plan.ladderId)!;
        expect(repo.v4BidLadderStrategyDepthBps(parent.plan.ladderId)).toBe(
          depth,
        );
        const child = create(repo, depth, 500, 2n, 876_543_210n, {
          rootLadderId: String(parentRow.root_ladder_id),
          previousLadderId: parent.plan.ladderId,
          generation: 1,
          creationReason: "USDG_RESET_REPOSITION",
        });
        expect(repo.v4BidLadderStrategyDepthBps(child.plan.ladderId)).toBe(
          depth,
        );
        expect(child.plan.legs.map((x) => x.weightBps)).toEqual([
          800, 1200, 1800, 2500, 3700,
        ]);
        expect(
          child.plan.legs.map((x) => [x.tickLower, x.tickUpper]),
        ).not.toEqual(parent.plan.legs.map((x) => [x.tickLower, x.tickUpper]));
        expect(
          repo.loadBidLadder(child.plan.ladderId)?.total_funding_amount_raw,
        ).toBe("876543210");
        expect(
          repo.loadBidLadderUsdReset(parent.plan.ladderId)?.next_ladder_id,
        ).toBe(child.plan.ladderId);
        expect(repo.loadBidLadderUsdReset(child.plan.ladderId)).toMatchObject({
          root_ladder_id: parent.plan.ladderId,
          previous_ladder_id: parent.plan.ladderId,
          generation: 1,
          creation_reason: "USDG_RESET_REPOSITION",
        });
      } finally {
        repo.close();
      }
    }
  });
  it("persists explicit restart phases and prevents duplicate child generations", () => {
    const repo = fixture();
    try {
      const parent = create(repo, 6000),
        id = parent.plan.ladderId,
        authorization =
          "manual-reposition:7:00000000-0000-4000-8000-000000000007";
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "WATCHING",
        to: "CLOSE_PREPARED",
        closeWorkflowIdentity: authorization,
      });
      expect(
        repo.listBidLadderUsdResetCandidates().map((x) => x.phase),
      ).toContain("CLOSE_PREPARED");
      expect(repo.loadBidLadderUsdReset(id)?.close_workflow_identity).toBe(
        authorization,
      );
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "CLOSE_PREPARED",
        to: "CLOSE_SUBMITTED",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "CLOSE_SUBMITTED",
        to: "CLOSE_CONFIRMED",
        closeReason: "USDG_RESET_REPOSITION",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "CLOSE_CONFIRMED",
        to: "PRINCIPAL_RECONCILED",
        returnedUsdgPrincipal: 900n,
        returnedTargetPrincipal: 0n,
        returnedUsdgFee: 10n,
        returnedTargetFee: 20n,
      });
      const child = create(repo, 6000, 300, 3n, 900n, {
        rootLadderId: id,
        previousLadderId: id,
        generation: 1,
        creationReason: "USDG_RESET_REPOSITION",
      });
      expect(() =>
        create(repo, 6000, 400, 4n, 900n, {
          rootLadderId: id,
          previousLadderId: id,
          generation: 1,
          creationReason: "USDG_RESET_REPOSITION",
        }),
      ).toThrow();
      expect(repo.loadBidLadderUsdReset(child.plan.ladderId)?.phase).toBe(
        "OPEN_PENDING",
      );
    } finally {
      repo.close();
    }
  });
  it("marks an enabled operator close terminal without creating a child", () => {
    const repo = fixture();
    try {
      const parent = create(repo, 6000),
        id = parent.plan.ladderId;
      repo.db
        .prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?")
        .run(id);
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "WATCHING",
        to: "OPERATOR_CLOSED",
        closeReason: "NORMAL_OPERATOR_CLOSE",
        closeWorkflowIdentity: id,
      });
      expect(repo.loadBidLadderUsdReset(id)).toMatchObject({
        phase: "OPERATOR_CLOSED",
        close_reason: "NORMAL_OPERATOR_CLOSE",
        next_ladder_id: null,
      });
      expect(
        repo.db
          .prepare("SELECT COUNT(*) count FROM v4_bid_ladder_usdg_reset_v1")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      repo.close();
    }
  });
  it("keeps disabled existing ladders inert and final revalidation aborts before signing", async () => {
    const repo = fixture();
    try {
      expect(
        await processV4BidLadderUsdReset(
          {
            repo,
            rpc: {} as any,
            wallet,
            walletClient: () => ({}) as any,
            context: async () => {
              throw new Error("must not execute");
            },
          },
          "legacy",
        ),
      ).toEqual({ status: "DISABLED", ladderId: "legacy" });
      const first = eligible({ fundingIndex: 1, targetIndex: 0 });
      const moved = eligible({
        fundingIndex: 1,
        targetIndex: 0,
        targetPrincipal: 1n,
      });
      expect(first.eligible).toBe(true);
      expect(moved.eligible).toBe(false);
      const parent = create(repo, 6000),
        id = parent.plan.ladderId;
      repo.db
        .prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?")
        .run(id);
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      let reads = 0,
        signers = 0,
        contexts = 0;
      const result = await processV4BidLadderUsdReset(
        {
          repo,
          rpc: {} as any,
          wallet,
          walletClient: () => {
            signers++;
            return {} as any;
          },
          context: async () => {
            contexts++;
            throw new Error("must not execute");
          },
          manualAuthorizationIdentity:
            "manual-reposition:7:00000000-0000-4000-8000-000000000007",
          readTruth: async () => {
            reads++;
            return (
              reads === 1
                ? { eligible: true, blockers: [], usdgPrincipal: 500n }
                : {
                    eligible: false,
                    blockers: ["REPOSITION_TARGET_PRINCIPAL_NONZERO:3"],
                    usdgPrincipal: 499n,
                  }
            ) as any;
          },
        },
        id,
      );
      expect(result).toMatchObject({
        status: "ABORTED_PRE_SIGN",
        signingUsed: false,
        broadcastUsed: false,
      });
      expect(signers).toBe(0);
      expect(contexts).toBe(0);
      expect(repo.loadBidLadderUsdReset(id)).toMatchObject({
        phase: "WATCHING",
        close_workflow_identity: null,
      });
      expect(
        repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        repo.db.prepare("SELECT COUNT(*) count FROM chain_nonce_mutex").get(),
      ).toEqual({ count: 0 });
    } finally {
      repo.close();
    }
  });
  it("keeps eligible observation and restart inert until an operator authorizes reposition", async () => {
    const repo = fixture();
    try {
      const parent = create(repo, 6000),
        id = parent.plan.ladderId;
      repo.db
        .prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?")
        .run(id);
      repo.db
        .prepare(
          "UPDATE v4_bid_ladder_legs SET status='OPEN',token_id=CAST(leg_index+1 AS TEXT) WHERE ladder_id=?",
        )
        .run(id);
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      let signers = 0,
        contexts = 0;
      const input = {
        repo,
        rpc: {} as any,
        wallet,
        walletClient: () => {
          signers++;
          return {} as any;
        },
        context: async () => {
          contexts++;
          throw new Error("must not execute");
        },
        readTruth: async () =>
          ({
            eligible: true,
            blockers: [],
            usdgPrincipal: 500n,
            targetPrincipal: 0n,
          }) as any,
      };
      for (let restart = 0; restart < 2; restart++)
        expect(await processV4BidLadderUsdReset(input, id)).toMatchObject({
          status: "ELIGIBLE",
          signingUsed: false,
          broadcastUsed: false,
        });
      expect(signers).toBe(0);
      expect(contexts).toBe(0);
      expect(repo.loadBidLadder(id)).toMatchObject({ status: "OPEN" });
      expect(repo.loadBidLadderUsdReset(id)).toMatchObject({
        phase: "WATCHING",
        close_workflow_identity: null,
        next_ladder_id: null,
      });
      for (const table of ["chain_transaction_journal", "chain_nonce_mutex"])
        expect(
          repo.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
      expect(
        repo.db
          .prepare("SELECT COUNT(*) count FROM v4_bid_ladder_usdg_reset_v1")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      repo.close();
    }
  });
  it("rejects the signer boundary itself when manual reposition authorization is absent", async () => {
    const repo = fixture();
    try {
      const parent = create(repo, 6000),
        id = parent.plan.ladderId;
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      let walletCalls = 0;
      await expect(
        executeV4BidLadderManualClose({
          repo,
          ladderId: id,
          wallet,
          rpc: {} as any,
          walletClient: new Proxy({} as any, {
            get() {
              walletCalls++;
              throw new Error("wallet must not execute");
            },
          }),
          fundingUsd: 1,
          nativeUsd: 1,
          runtime: {} as any,
          closeReason: "USDG_RESET_REPOSITION",
        }),
      ).rejects.toThrow("REPOSITION_MANUAL_AUTHORIZATION_REQUIRED");
      expect(walletCalls).toBe(0);
      expect(repo.loadBidLadderUsdReset(id)).toMatchObject({
        phase: "WATCHING",
        close_workflow_identity: null,
      });
      for (const table of ["chain_transaction_journal", "chain_nonce_mutex"])
        expect(
          repo.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
    } finally {
      repo.close();
    }
  });
  it("resumes only a durably authorized reposition after restart", async () => {
    for (const authorized of [false, true]) {
      const repo = fixture();
      try {
        const parent = create(repo, 6000),
          id = parent.plan.ladderId,
          identity = authorized
            ? "manual-reposition:7:00000000-0000-4000-8000-000000000007"
            : id;
        repo.db
          .prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?")
          .run(id);
        repo.transitionBidLadderUsdReset({
          ladderId: id,
          from: "OPEN_PENDING",
          to: "WATCHING",
        });
        repo.transitionBidLadderUsdReset({
          ladderId: id,
          from: "WATCHING",
          to: "CLOSE_PREPARED",
          closeWorkflowIdentity: identity,
        });
        let contexts = 0;
        const attempt = processV4BidLadderUsdReset(
          {
            repo,
            rpc: {} as any,
            wallet,
            walletClient: () => ({}) as any,
            context: async () => {
              contexts++;
              throw new Error("AUTHORIZED_RECOVERY_REACHED");
            },
          },
          id,
        );
        if (authorized)
          await expect(attempt).rejects.toThrow("AUTHORIZED_RECOVERY_REACHED");
        else
          await expect(attempt).rejects.toThrow(
            "REPOSITION_DURABLE_MANUAL_AUTHORIZATION_MISSING",
          );
        expect(contexts).toBe(authorized ? 1 : 0);
        expect(repo.loadBidLadderUsdReset(id)).toMatchObject({
          phase: "CLOSE_PREPARED",
          close_workflow_identity: identity,
        });
      } finally {
        repo.close();
      }
    }
  });
  it("creates no child when confirmed close accounting contains target principal", async () => {
    const repo = fixture();
    try {
      const parent = create(repo, 6000),
        id = parent.plan.ladderId,
        identity = "manual-reposition:7:00000000-0000-4000-8000-000000000007";
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "WATCHING",
        to: "CLOSE_PREPARED",
        closeWorkflowIdentity: identity,
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "CLOSE_PREPARED",
        to: "CLOSE_SUBMITTED",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "CLOSE_SUBMITTED",
        to: "CLOSE_CONFIRMED",
        closeReason: "USDG_RESET_REPOSITION",
      });
      repo.db
        .prepare("UPDATE v4_bid_ladders SET status='CLOSED' WHERE ladder_id=?")
        .run(id);
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "CLOSE_CONFIRMED",
        to: "PRINCIPAL_RECONCILED",
        returnedUsdgPrincipal: 900n,
        returnedTargetPrincipal: 1n,
        returnedUsdgFee: 10n,
        returnedTargetFee: 20n,
      });
      const result = await processV4BidLadderUsdReset(
        {
          repo,
          rpc: {} as any,
          wallet,
          walletClient: () => ({}) as any,
          context: async () => {
            throw new Error("must not execute");
          },
        },
        id,
      );
      expect(result).toMatchObject({
        status: "BLOCKED",
        reason: "REPOSITION_BLOCKED_NON_USDG_PRINCIPAL",
      });
      expect(repo.loadBidLadderUsdReset(id)).toMatchObject({
        phase: "BLOCKED",
        next_ladder_id: null,
      });
      expect(
        repo.db
          .prepare("SELECT COUNT(*) count FROM v4_bid_ladder_usdg_reset_v1")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      repo.close();
    }
  });
  it("keeps the confirmed parent closed and wallet principal unspent when child OPEN fails", async () => {
    const repo = fixture();
    try {
      const parent = create(repo, 6000),
        id = parent.plan.ladderId,
        identity = "manual-reposition:7:00000000-0000-4000-8000-000000000007";
      repo.db
        .prepare("UPDATE v4_bid_ladders SET status='CLOSED' WHERE ladder_id=?")
        .run(id);
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "WATCHING",
        to: "CLOSE_PREPARED",
        closeWorkflowIdentity: identity,
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "CLOSE_PREPARED",
        to: "CLOSE_SUBMITTED",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "CLOSE_SUBMITTED",
        to: "CLOSE_CONFIRMED",
        closeReason: "USDG_RESET_REPOSITION",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "CLOSE_CONFIRMED",
        to: "PRINCIPAL_RECONCILED",
        returnedUsdgPrincipal: 900n,
        returnedTargetPrincipal: 0n,
        returnedUsdgFee: 10n,
        returnedTargetFee: 20n,
      });
      const child = create(repo, 6000, 300, 3n, 900n, {
        rootLadderId: id,
        previousLadderId: id,
        generation: 1,
        creationReason: "USDG_RESET_REPOSITION",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "PRINCIPAL_RECONCILED",
        to: "REOPEN_PLANNED",
        reopenWorkflowIdentity: child.plan.ladderId,
      });
      const result = await processV4BidLadderUsdReset(
        {
          repo,
          rpc: {} as any,
          wallet,
          walletClient: () => ({}) as any,
          context: async () => {
            throw new Error("CHILD_OPEN_FAILED");
          },
        },
        id,
      );
      expect(result).toMatchObject({
        status: "BLOCKED",
        childId: child.plan.ladderId,
        reason: "CHILD_OPEN_FAILED",
      });
      expect(repo.loadBidLadder(id)).toMatchObject({ status: "CLOSED" });
      expect(repo.loadBidLadderUsdReset(id)).toMatchObject({
        phase: "BLOCKED",
        returned_usdg_principal_raw: "900",
        next_ladder_id: child.plan.ladderId,
      });
      expect(repo.loadBidLadder(child.plan.ladderId)).toMatchObject({
        status: "CANCELLED",
        total_funding_amount_raw: "900",
      });
      expect(
        repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      repo.close();
    }
  });
  it("retains exact-hash close, 200 bps minima, and explicit manual authorization", () => {
    const reset = readFileSync(
        "apps/cli/src/v4-bid-ladder-usdg-reset.ts",
        "utf8",
      ),
      close = readFileSync("apps/cli/src/v4-bid-ladder-live.ts", "utf8");
    expect(reset).toContain("executeV4BidLadderManualClose");
    expect(reset).toContain('closeReason: "USDG_RESET_REPOSITION"');
    expect(reset).toContain("REPOSITION_DURABLE_MANUAL_AUTHORIZATION_MISSING");
    expect(close).toContain("V4_BID_LADDER_CLOSE_SLIPPAGE_BPS = 200");
    expect(close).toContain("broadcastDurableTransaction");
    expect(close).toContain("REPOSITION_MANUAL_AUTHORIZATION_REQUIRED");
  });
});
