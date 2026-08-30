import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { robinhoodMainnet } from "@funi/core";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import { amountsForLiquidity, poolId, sqrtPriceAtTick, type V4PoolState } from "@funi/v4";
import {
  createV4BidLadderLive,
  previewV4BidLadder,
} from "../apps/cli/src/v4-bid-ladder-operator.js";
import {
  acquireV4BidLadderRepositionLease,
  classifyV4BidLadderRepositionExecutionError,
  classifyV4BidLadderUsdResetOutputs,
  cancelV4BidLadderRepositionPreClose,
  classifyV4BidLadderUsdResetCandidateError,
  evaluateV4BidLadderUsdResetEligibility,
  processV4BidLadderUsdReset,
  releaseV4BidLadderRepositionLease,
  renewV4BidLadderRepositionLease,
  rematerializeV4BidLadderRepositionChildOnce,
  resumeV4BidLadderReposition,
  readV4BidLadderCloseExecutionPool,
  runV4BidLadderUsdResetCycle,
  stopV4BidLadderReplacementOpen,
  V4_REPOSITION_MAX_JIT_REMATERIALIZATIONS,
  V4_BID_LADDER_USDG_RESET_PARENT_STATUS_MATRIX,
  v4BidLadderRepositionResumeEligibility,
  v4BidLadderUsdResetParentStatePolicy,
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
const closeIdentity="manual-reposition:7:00000000-0000-4000-8000-000000000007";
function setupReopen(repo:SqliteLedgerRepository,capital=1_999_999_995n){
  const source=create(repo,6000,0,1n,capital),sourceId=source.plan.ladderId;
  repo.db.prepare("UPDATE v4_bid_ladders SET status='CLOSED',close_provenance='FUNI_EXECUTED' WHERE ladder_id=?").run(sourceId);
  repo.transitionBidLadderUsdReset({ladderId:sourceId,from:'OPEN_PENDING',to:'WATCHING'});repo.transitionBidLadderUsdReset({ladderId:sourceId,from:'WATCHING',to:'CLOSE_PREPARED',closeWorkflowIdentity:closeIdentity});repo.transitionBidLadderUsdReset({ladderId:sourceId,from:'CLOSE_PREPARED',to:'CLOSE_SUBMITTED'});repo.transitionBidLadderUsdReset({ladderId:sourceId,from:'CLOSE_SUBMITTED',to:'CLOSE_CONFIRMED',closeReason:'USDG_RESET_REPOSITION'});repo.transitionBidLadderUsdReset({ladderId:sourceId,from:'CLOSE_CONFIRMED',to:'PRINCIPAL_RECONCILED',returnedUsdgPrincipal:capital,returnedTargetPrincipal:0n,returnedUsdgFee:5n,returnedTargetFee:7n});
  const child=create(repo,6000,0,2n,capital,{rootLadderId:sourceId,previousLadderId:sourceId,generation:1,creationReason:'USDG_RESET_REPOSITION'}),childId=child.plan.ladderId;repo.transitionBidLadderUsdReset({ladderId:sourceId,from:'PRINCIPAL_RECONCILED',to:'REOPEN_PLANNED',reopenWorkflowIdentity:childId});
  return {sourceId,childId,capital};
}
function insertConfirmedClose(repo:SqliteLedgerRepository,sourceId:string){
  const hash=`0x${'a'.repeat(64)}`;repo.db.prepare("INSERT INTO chain_transaction_journal(chain_id,chain_key,protocol,journal_id,wallet_address,workflow_identity,semantic_stage,attempt,status,nonce,transaction_type,expected_hash,to_address,request_fingerprint,fee_model,receipt_json,confirmation_count,created_at,submitted_at,confirmed_at,updated_at) VALUES(4663,'robinhood','uniswap_v4',?,?,?,'CLOSE_BATCH',0,'CONFIRMED',1,'legacy',?,?,?,'legacy','{}',1,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')").run(`${sourceId}:close`,wallet,sourceId,hash,target,'fingerprint');
}
function setupBlockedIncident(repo:SqliteLedgerRepository){
  const value=setupReopen(repo);repo.transitionBidLadderUsdReset({ladderId:value.sourceId,from:'REOPEN_PLANNED',to:'BLOCKED',blockReason:'REPOSITION_JIT_REMATERIALIZATION_LIMIT_EXHAUSTED'});repo.db.transaction(()=>{repo.db.prepare("UPDATE v4_bid_ladders SET status='CANCELLED',terminal_reason='JIT_EXHAUSTED',terminal_at_ms=10000,updated_at_ms=10000,revision=revision+1 WHERE ladder_id=?").run(value.childId);repo.db.prepare("UPDATE v4_bid_ladder_legs SET status='CANCELLED',updated_at_ms=10000 WHERE ladder_id=?").run(value.childId);repo.transitionBidLadderUsdReset({ladderId:value.childId,from:'OPEN_PENDING',to:'BLOCKED',blockReason:'REPOSITION_SOURCE_BLOCKED_PRE_OPEN',nowMs:10000});})();insertConfirmedClose(repo,value.sourceId);return value;
}
function canonicalRpc(repo?:SqliteLedgerRepository,childId?:string){let block=100n;return {config:{assets:robinhoodMainnet.assets},withClient:async(fn:any)=>fn({getTransactionCount:async()=>0,getBlockNumber:async()=>block++,getBytecode:async()=>"0x01",readContract:async({address,functionName}:any)=>{const tick=repo&&childId?Math.floor((Number(repo.listBidLadderLegs(childId)[0]!.tick_lower)+Number(repo.listBidLadderLegs(childId)[0]!.tick_upper))/2):0;if(functionName==='getSlot0')return [sqrtPriceAtTick(tick),tick,0,3000];if(functionName==='getLiquidity')return 10n**24n;if(functionName==='decimals')return String(address).toLowerCase()===String(usdg).toLowerCase()?6:18;if(functionName==='symbol')return String(address).toLowerCase()===String(usdg).toLowerCase()?'USDG':'TOKEN';if(functionName==='name')return 'Token';if(functionName==='balanceOf')return 10_000_000_000n;throw new Error(`UNEXPECTED:${functionName}`);}})} as any;}
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
  it("pins CLOSE execution state to its block and ignores every later block", async () => {
    const key = state(0, 100n).key,
      calls: any[] = [];
    const rpc = {
      withClient: async (fn: any) =>
        fn({
          getLogs: async (input: any) => {
            calls.push(input);
            return [];
          },
          readContract: async (input: any) => {
            calls.push(input);
            return input.functionName === "getSlot0"
              ? [sqrtPriceAtTick(7), 7, 0, 3000]
              : 123n;
          },
        }),
    } as any;
    const value = await readV4BidLadderCloseExecutionPool(rpc, key, {
      blockNumber: 100n,
      transactionIndex: 4,
    } as any);
    expect(value).toMatchObject({
      blockNumber: 100n,
      tick: 7,
      liquidity: 123n,
    });
    expect(calls[0]).toMatchObject({ fromBlock: 100n, toBlock: 100n });
    expect(
      calls
        .filter((call) => call.blockNumber !== undefined)
        .every((call) => call.blockNumber === 100n),
    ).toBe(true);
  });
  it("accepts a same-block swap before CLOSE because end-block state is the post-swap CLOSE state", async () => {
    const key = state(0, 100n).key;
    const rpc = {
      withClient: async (fn: any) =>
        fn({
          getLogs: async () => [{ transactionIndex: 3 }],
          readContract: async (input: any) =>
            input.functionName === "getSlot0"
              ? [sqrtPriceAtTick(8), 8, 0, 3000]
              : 456n,
        }),
    } as any;
    await expect(
      readV4BidLadderCloseExecutionPool(rpc, key, {
        blockNumber: 100n,
        transactionIndex: 4,
      } as any),
    ).resolves.toMatchObject({ tick: 8, blockNumber: 100n });
  });
  it("fails closed specifically for a same-block swap after CLOSE", async () => {
    const key = state(0, 100n).key;
    const rpc = {
      withClient: async (fn: any) =>
        fn({ getLogs: async () => [{ transactionIndex: 5 }] }),
    } as any;
    await expect(
      readV4BidLadderCloseExecutionPool(rpc, key, {
        blockNumber: 100n,
        transactionIndex: 4,
      } as any),
    ).rejects.toThrow("REPOSITION_SAME_BLOCK_LATER_SWAP_AMBIGUOUS");
    expect(
      classifyV4BidLadderUsdResetCandidateError(
        new Error("REPOSITION_SAME_BLOCK_LATER_SWAP_AMBIGUOUS"),
      ),
    ).toMatchObject({ classification: "DETERMINISTIC_TERMINAL" });
  });
  it("keeps historical provider failure retryable and never supplies a value", async () => {
    const key = state(0, 100n).key;
    const rpc = {
      withClient: async () => {
        throw new Error("RPC_ARCHIVE_UNAVAILABLE");
      },
    } as any;
    await expect(
      readV4BidLadderCloseExecutionPool(rpc, key, {
        blockNumber: 100n,
        transactionIndex: 4,
      } as any),
    ).rejects.toThrow("REPOSITION_EXECUTION_PRICE_EVIDENCE_RPC_UNAVAILABLE");
    expect(
      classifyV4BidLadderUsdResetCandidateError(
        new Error("REPOSITION_EXECUTION_PRICE_EVIDENCE_RPC_UNAVAILABLE"),
      ),
    ).toMatchObject({ classification: "RETRYABLE" });
  });
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
            return {eligible:false,blockers:["REPOSITION_TARGET_PRINCIPAL_NONZERO:3"],usdgPrincipal:499n} as any;
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
      expect(reads).toBe(1);
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
  it("acknowledges the exact CLOSE receipt without running principal or child OPEN in the handler", async () => {
    const repo = fixture();
    try {
      const parent = create(repo, 6000), id = parent.plan.ladderId,
        identity = "manual-reposition:7:00000000-0000-4000-8000-000000000007",
        hash = `0x${"cd".repeat(32)}` as const;
      repo.db.prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?").run(id);
      repo.transitionBidLadderUsdReset({ ladderId: id, from: "OPEN_PENDING", to: "WATCHING" });
      let principal = 0, child = 0, opens = 0;
      const result = await processV4BidLadderUsdReset({
        repo, rpc: {} as any, wallet, walletClient: () => ({} as any), context: async () => ({} as any),
        manualAuthorizationIdentity: identity, returnAfterCloseReceipt: true, readAllowanceReadiness:async()=>({ready:true,blockers:[]} as any),
        readTruth: async () => ({ eligible: true, blockers: [], usdgPrincipal: 500n } as any),
        executeClose: async () => {
          repo.transitionBidLadderUsdReset({ ladderId: id, from: "WATCHING", to: "CLOSE_PREPARED", closeWorkflowIdentity: identity });
          repo.transitionBidLadderUsdReset({ ladderId: id, from: "CLOSE_PREPARED", to: "CLOSE_SUBMITTED" });
          repo.persistChainPreparedTransaction({ chainId: 4663, chainKey: "robinhood", protocol: "uniswap_v4", journalId: `${id}:CLOSE_BATCH:0`, wallet, workflowIdentity: id, semanticStage: "CLOSE_BATCH", attempt: 0, nonce: 1, transactionType: "modifyLiquidities", expectedHash: hash, to: zero, requestFingerprint: "bounded-close", feeModel: "legacy" });
          repo.transitionChainTransaction({ chainId: 4663, journalId: `${id}:CLOSE_BATCH:0`, from: "PREPARED", to: "SUBMITTED" });
          repo.transitionChainTransaction({ chainId: 4663, journalId: `${id}:CLOSE_BATCH:0`, from: "SUBMITTED", to: "CONFIRMED", receipt: { status: "success", transactionHash: hash } });
          return { status: "CLOSED", mainnetTransactionsSent: 0 } as any;
        },
        reconcilePrincipal: async () => { principal++; throw new Error("HANDLER_MUST_NOT_RECONCILE"); },
        planChild: async () => { child++; throw new Error("HANDLER_MUST_NOT_PLAN"); },
        executeOpen: async () => { opens++; throw new Error("HANDLER_MUST_NOT_OPEN"); },
      }, id);
      expect(result).toEqual({ status: "CLOSE_CONFIRMED_PREPARING_REPLACEMENT", ladderId: id, durableContinuation: true });
      expect({ principal, child, opens }).toEqual({ principal: 0, child: 0, opens: 0 });
      expect(repo.loadBidLadderUsdReset(id)?.phase).toBe("CLOSE_SUBMITTED");
      expect(repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal WHERE semantic_stage='CLOSE_BATCH' AND status='CONFIRMED'").get()).toEqual({ count: 1 });
    } finally { repo.close(); }
  });
  it("continues the normal authorized hot path directly with sub-2s internal overhead and no cadence dependency",async()=>{
    const repo=fixture();try{const parent=create(repo,6000),id=parent.plan.ladderId,identity="manual-reposition:7:00000000-0000-4000-8000-000000000007",events:string[]=[];repo.db.prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?").run(id);repo.transitionBidLadderUsdReset({ladderId:id,from:'OPEN_PENDING',to:'WATCHING'});const started=Date.now(),result=await processV4BidLadderUsdReset({repo,rpc:{} as any,wallet,walletClient:()=>({}) as any,context:async()=>({}) as any,manualAuthorizationIdentity:identity,confirmAtMs:started,readAllowanceReadiness:async()=>({ready:true,blockers:[]} as any),readTruth:async()=>{events.push('preflight');return {eligible:true,blockers:[],usdgPrincipal:900n} as any;},executeClose:async()=>{events.push('close');repo.transitionBidLadderUsdReset({ladderId:id,from:'WATCHING',to:'CLOSE_PREPARED',closeWorkflowIdentity:identity});repo.transitionBidLadderUsdReset({ladderId:id,from:'CLOSE_PREPARED',to:'CLOSE_SUBMITTED'});repo.db.prepare("UPDATE v4_bid_ladders SET status='CLOSED' WHERE ladder_id=?").run(id);repo.transitionBidLadderUsdReset({ladderId:id,from:'CLOSE_SUBMITTED',to:'CLOSE_CONFIRMED',closeReason:'USDG_RESET_REPOSITION'});return {status:'CLOSED'} as any;},reconcilePrincipal:async()=>{events.push('principal');repo.transitionBidLadderUsdReset({ladderId:id,from:'CLOSE_CONFIRMED',to:'PRINCIPAL_RECONCILED',returnedUsdgPrincipal:900n,returnedTargetPrincipal:0n,returnedUsdgFee:10n,returnedTargetFee:20n});return {returnedUsdgPrincipal:900n} as any;},planChild:async()=>{events.push('plan');const child=create(repo,6000,300,3n,900n,{rootLadderId:id,previousLadderId:id,generation:1,creationReason:'USDG_RESET_REPOSITION'});repo.transitionBidLadderUsdReset({ladderId:id,from:'PRINCIPAL_RECONCILED',to:'REOPEN_PLANNED',reopenWorkflowIdentity:child.plan.ladderId});return child.plan.ladderId;},executeOpen:async()=>{events.push('open');return {status:'OPEN',mainnetTransactionsSent:0} as any;}},id);const elapsed=Date.now()-started;expect(result.status).toBe('COMPLETED');expect(events).toEqual(['preflight','close','principal','plan','open']);expect(elapsed).toBeLessThan(2_000);expect(repo.loadBidLadderUsdReset(id)?.phase).toBe('COMPLETED');const telemetry=repo.db.prepare("SELECT context_json FROM latency_telemetry WHERE metric='v4_bid_ladder_reposition_sla'").get() as {context_json:string};expect(JSON.parse(telemetry.context_json)).toMatchObject({confirm_at:started,sla:'PASS'});const source=readFileSync('apps/cli/src/v4-bid-ladder-usdg-reset.ts','utf8');expect(source).not.toMatch(/processV4BidLadderUsdReset[\s\S]*await sleep/);}
    finally{repo.close();}
  });
  it("performs no CLOSE when exact replacement allowance is not ready", async () => {
    const repo = fixture();
    try {
      const parent = create(repo, 6000), ladderId = parent.plan.ladderId;
      repo.db.prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?").run(ladderId);
      repo.transitionBidLadderUsdReset({ ladderId, from: "OPEN_PENDING", to: "WATCHING" });
      let closeRuns = 0;
      const result = await processV4BidLadderUsdReset({ repo, rpc: {} as any, wallet, walletClient: () => ({}) as any, context: async () => ({}) as any, manualAuthorizationIdentity: "manual-reposition:7:00000000-0000-4000-8000-000000000007", readTruth: async () => ({ eligible: true, blockers: [], usdgPrincipal: 900n }) as any, readAllowanceReadiness: async () => ({ ready: false, blockers: ["ERC20_ALLOWANCE_INSUFFICIENT"] }) as any, executeClose: async () => { closeRuns++; return {} as any; } }, ladderId);
      expect(result).toMatchObject({ status: "PREPARE_ALLOWANCE_REQUIRED", ladderId });
      expect(closeRuns).toBe(0);
      expect(repo.loadBidLadderUsdReset(ladderId)).toMatchObject({ phase: "WATCHING" });
      expect(repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal").get()).toEqual({ count: 0 });
    } finally { repo.close(); }
  });
  it.each([{name:'preprepared exact allowance',openMs:4_000},{name:'bounded JIT planning latency',openMs:8_000}])('classifies $name under the strict 10s mocked-inclusion SLA',async({openMs})=>{vi.useFakeTimers();const started=1_800_000_000_000;vi.setSystemTime(started);const repo=fixture();try{const parent=create(repo,6000),id=parent.plan.ladderId,identity="manual-reposition:7:00000000-0000-4000-8000-000000000007";repo.db.prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?").run(id);repo.transitionBidLadderUsdReset({ladderId:id,from:'OPEN_PENDING',to:'WATCHING'});const result=await processV4BidLadderUsdReset({repo,rpc:{} as any,wallet,walletClient:()=>({}) as any,context:async()=>({}) as any,manualAuthorizationIdentity:identity,confirmAtMs:started,readAllowanceReadiness:async()=>({ready:true,blockers:[]} as any),readTruth:async()=>({eligible:true,blockers:[],usdgPrincipal:900n} as any),executeClose:async()=>{vi.setSystemTime(started+1_500);repo.transitionBidLadderUsdReset({ladderId:id,from:'WATCHING',to:'CLOSE_PREPARED',closeWorkflowIdentity:identity});repo.transitionBidLadderUsdReset({ladderId:id,from:'CLOSE_PREPARED',to:'CLOSE_SUBMITTED'});repo.db.prepare("UPDATE v4_bid_ladders SET status='CLOSED' WHERE ladder_id=?").run(id);repo.transitionBidLadderUsdReset({ladderId:id,from:'CLOSE_SUBMITTED',to:'CLOSE_CONFIRMED',closeReason:'USDG_RESET_REPOSITION'});return {} as any;},reconcilePrincipal:async()=>{vi.setSystemTime(started+2_000);repo.transitionBidLadderUsdReset({ladderId:id,from:'CLOSE_CONFIRMED',to:'PRINCIPAL_RECONCILED',returnedUsdgPrincipal:900n,returnedTargetPrincipal:0n,returnedUsdgFee:0n,returnedTargetFee:0n});return {returnedUsdgPrincipal:900n} as any;},planChild:async()=>{vi.setSystemTime(started+2_250);const child=create(repo,6000,300,3n,900n,{rootLadderId:id,previousLadderId:id,generation:1,creationReason:'USDG_RESET_REPOSITION'});repo.transitionBidLadderUsdReset({ladderId:id,from:'PRINCIPAL_RECONCILED',to:'REOPEN_PLANNED',reopenWorkflowIdentity:child.plan.ladderId});return child.plan.ladderId;},executeOpen:async()=>{vi.setSystemTime(started+openMs);return {status:'OPEN',mainnetTransactionsSent:0} as any;}},id);expect(result.status).toBe('COMPLETED');const telemetry=JSON.parse(String((repo.db.prepare("SELECT context_json FROM latency_telemetry WHERE metric='v4_bid_ladder_reposition_sla'").get() as {context_json:string}).context_json));expect(telemetry.total_ms).toBe(openMs);expect(telemetry.total_ms).toBeLessThan(10_000);expect(telemetry.sla).toBe('PASS');}finally{repo.close();vi.useRealTimers();}});
  it("terminalizes pre-CLOSE cancel and rejects post-authority cancel without inventing transaction truth", () => {
    const repo = fixture();
    try {
      const first = create(repo, 6000),
        id = first.plan.ladderId;
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      cancelV4BidLadderRepositionPreClose({ repo, ladderId: id });
      expect(repo.loadBidLadderUsdReset(id)).toMatchObject({
        phase: "BLOCKED",
        block_reason: "REPOSITION_CANCELLED_PRE_CLOSE",
        next_ladder_id: null,
      });
      expect(
        repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual({ count: 0 });
      const second = create(repo, 6000, 10, 2n),
        secondId = second.plan.ladderId;
      repo.transitionBidLadderUsdReset({
        ladderId: secondId,
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: secondId,
        from: "WATCHING",
        to: "CLOSE_PREPARED",
        closeWorkflowIdentity:
          "manual-reposition:7:00000000-0000-4000-8000-000000000007",
      });
      expect(() =>
        cancelV4BidLadderRepositionPreClose({ repo, ladderId: secondId }),
      ).toThrow("REPOSITION_CANCEL_TOO_LATE_PHASE_CHANGED");
      expect(repo.loadBidLadderUsdReset(secondId)?.phase).toBe(
        "CLOSE_PREPARED",
      );
    } finally {
      repo.close();
    }
  });
  it("stops replacement durably only before child OPEN authority exists", async () => {
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
        to: "CLOSE_CONFIRMED",
        closeReason: "USDG_RESET_REPOSITION",
      });
      const revision = Number(repo.loadBidLadderUsdReset(id)!.revision);
      stopV4BidLadderReplacementOpen({
        repo,
        ladderId: id,
        expectedRevision: revision,
      });
      expect(repo.loadBidLadderUsdReset(id)).toMatchObject({
        phase: "BLOCKED",
        block_reason: "REPOSITION_REPLACEMENT_OPEN_STOPPED",
        next_ladder_id: null,
      });
      expect(
        await processV4BidLadderUsdReset(
          {
            repo,
            rpc: {} as any,
            wallet,
            walletClient: () => {
              throw new Error("NO_SIGNER");
            },
            context: async () => {
              throw new Error("NO_CONTEXT");
            },
          },
          id,
        ),
      ).toMatchObject({ status: "BLOCKED" });
      expect(() =>
        stopV4BidLadderReplacementOpen({
          repo,
          ladderId: id,
          expectedRevision: revision,
        }),
      ).toThrow("REPOSITION_STOP_AUTHORIZATION_STALE_REVISION");
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
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "CLOSE_PREPARED",
        to: "CLOSE_SUBMITTED",
      });
      repo.db
        .prepare("UPDATE v4_bid_ladders SET status='CLOSED' WHERE ladder_id=?")
        .run(id);
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
          readAllowanceReadiness: async () => ({ ready: true, blockers: [] }) as any,
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
      expect(repo.loadBidLadderUsdReset(child.plan.ladderId)).toMatchObject({
        phase: "BLOCKED",
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
  it("re-materializes stale child geometry once from the latest exact pool while preserving strategy intent", async () => {
    const repo = fixture();
    try {
      const parent = create(repo, 5000, 334391, 10n, 1_999_999_995n),
        ladderId = parent.plan.ladderId;
      repo.db.prepare("UPDATE v4_bid_ladders SET status='CLOSED' WHERE ladder_id=?").run(ladderId);
      repo.transitionBidLadderUsdReset({ ladderId, from: "OPEN_PENDING", to: "WATCHING" });
      repo.transitionBidLadderUsdReset({ ladderId, from: "WATCHING", to: "CLOSE_PREPARED", closeWorkflowIdentity: "manual-reposition:test" });
      repo.transitionBidLadderUsdReset({ ladderId, from: "CLOSE_PREPARED", to: "CLOSE_SUBMITTED" });
      repo.transitionBidLadderUsdReset({ ladderId, from: "CLOSE_SUBMITTED", to: "CLOSE_CONFIRMED", closeReason: "USDG_RESET_REPOSITION" });
      repo.transitionBidLadderUsdReset({ ladderId, from: "CLOSE_CONFIRMED", to: "PRINCIPAL_RECONCILED", returnedUsdgPrincipal: 1_999_999_995n, returnedTargetPrincipal: 0n, returnedUsdgFee: 5n, returnedTargetFee: 0n });
      const child = create(repo, 5000, 334391, 11n, 1_999_999_995n, { rootLadderId: ladderId, previousLadderId: ladderId, generation: 1, creationReason: "USDG_RESET_REPOSITION" }),
        childId = child.plan.ladderId;
      repo.transitionBidLadderUsdReset({ ladderId, from: "PRINCIPAL_RECONCILED", to: "REOPEN_PLANNED", reopenWorkflowIdentity: childId });
      const oldLegs = repo.listBidLadderLegs(childId), oldLeg0 = oldLegs[0], driftTick = Math.floor((Number(oldLeg0.tick_lower) + Number(oldLeg0.tick_upper)) / 2), latest = state(driftTick, 12n);
      const metadata={funding:{address:usdg,decimals:6},target:{address:target,decimals:18}};
      const result = await rematerializeV4BidLadderRepositionChildOnce({ repo, rpc: {} as any, ladderId, childId, wallet, nowMs: 12_000, pool: latest,metadata });
      expect(result).toMatchObject({ childId, referenceTick: driftTick, referenceBlock: 12n, rematerializations: 1 });
      const updated = repo.loadBidLadder(childId)!, legs = repo.listBidLadderLegs(childId);
      expect(updated).toMatchObject({ revision: 1, reference_tick: driftTick, total_funding_amount_raw: "1999999995" });
      expect(legs.map(row => row.capital_weight_bps)).toEqual(oldLegs.map(row => row.capital_weight_bps));
      expect(legs.map(row => [row.tick_lower, row.tick_upper])).not.toEqual(oldLegs.map(row => [row.tick_lower, row.tick_upper]));
      expect(legs.reduce((sum, row) => sum + BigInt(String(row.funding_amount_raw)), 0n)).toBe(1_999_999_995n);
      for (const leg of legs) {
        const amounts = amountsForLiquidity(latest.sqrtPriceX96, Number(leg.tick_lower), Number(leg.tick_upper), BigInt(String(leg.planned_liquidity_raw)));
        expect(Number(updated.target_index) === 0 ? amounts.token0 : amounts.token1).toBe(0n);
        expect(Number(updated.funding_index) === 0 ? amounts.token0 : amounts.token1).toBeGreaterThan(0n);
      }
      expect((await rematerializeV4BidLadderRepositionChildOnce({ repo, rpc: {} as any, ladderId, childId, wallet, nowMs: 12_001, pool: state(driftTick + 10, 13n),metadata })).rematerializations).toBe(2);
      expect((await rematerializeV4BidLadderRepositionChildOnce({ repo, rpc: {} as any, ladderId, childId, wallet, nowMs: 12_002, pool: state(driftTick + 20, 14n),metadata })).rematerializations).toBe(3);
      await expect(rematerializeV4BidLadderRepositionChildOnce({ repo, rpc: {} as any, ladderId, childId, wallet, nowMs: 12_003, pool: state(driftTick + 30, 15n),metadata })).rejects.toThrow("REPOSITION_JIT_REMATERIALIZATION_LIMIT_EXHAUSTED");
      expect(repo.loadBidLadderUsdReset(childId)).toMatchObject({jit_rematerialization_attempts:3,jit_last_reference_block:"14"});
      expect(repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal WHERE semantic_stage='OPEN_BATCH'").get()).toEqual({ count: 0 });
    } finally {
      repo.close();
    }
  });
  it("fails closed without OPEN authority when the latest exact pool cannot produce valid funding-only geometry", async () => {
    const repo = fixture();
    try {
      const parent = create(repo, 5000, 0, 20n, 1_000_000n), ladderId = parent.plan.ladderId;
      repo.db.prepare("UPDATE v4_bid_ladders SET status='CLOSED' WHERE ladder_id=?").run(ladderId);
      repo.transitionBidLadderUsdReset({ ladderId, from: "OPEN_PENDING", to: "WATCHING" });
      repo.transitionBidLadderUsdReset({ ladderId, from: "WATCHING", to: "CLOSE_PREPARED", closeWorkflowIdentity: "manual-reposition:test" });
      repo.transitionBidLadderUsdReset({ ladderId, from: "CLOSE_PREPARED", to: "CLOSE_SUBMITTED" });
      repo.transitionBidLadderUsdReset({ ladderId, from: "CLOSE_SUBMITTED", to: "CLOSE_CONFIRMED", closeReason: "USDG_RESET_REPOSITION" });
      repo.transitionBidLadderUsdReset({ ladderId, from: "CLOSE_CONFIRMED", to: "PRINCIPAL_RECONCILED", returnedUsdgPrincipal: 1_000_000n, returnedTargetPrincipal: 0n, returnedUsdgFee: 0n, returnedTargetFee: 0n });
      const child = create(repo, 5000, 0, 21n, 1_000_000n, { rootLadderId: ladderId, previousLadderId: ladderId, generation: 1, creationReason: "USDG_RESET_REPOSITION" }), childId = child.plan.ladderId;
      repo.transitionBidLadderUsdReset({ ladderId, from: "PRINCIPAL_RECONCILED", to: "REOPEN_PLANNED", reopenWorkflowIdentity: childId });
      await expect(rematerializeV4BidLadderRepositionChildOnce({ repo, rpc: {} as any, ladderId, childId, wallet, nowMs: 22_000, pool: state(-887270, 22n),metadata:{funding:{address:usdg,decimals:6},target:{address:target,decimals:18}} })).rejects.toThrow();
      expect(repo.loadBidLadder(childId)).toMatchObject({ status: "PLANNED", revision: 0 });
      expect(repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal WHERE workflow_identity=?").get(childId)).toEqual({ count: 0 });
    } finally { repo.close(); }
  });
  it.each([2,3])("opens successfully after %i durable JIT rematerializations under one owner",async failures=>{const repo=fixture();try{const {sourceId,childId}=setupReopen(repo);let opens=0;const telemetry:any[]=[],result=await processV4BidLadderUsdReset({repo,rpc:canonicalRpc(repo,childId),wallet,walletClient:()=>({}) as any,context:async()=>({}) as any,executeOpen:async()=>{opens++;if(opens<=failures)throw new Error(opens%2?'V4_BID_LADDER_LEG_NOT_FUNDING_ONLY':'V4_BID_LADDER_MINT_ESTIMATE_FAILED');return {status:'OPEN'} as any;},telemetry:event=>telemetry.push(event)},sourceId);expect(result).toMatchObject({status:'COMPLETED',childId});expect(repo.loadBidLadderUsdReset(childId)).toMatchObject({jit_rematerialization_attempts:failures});expect(repo.loadBidLadderUsdReset(sourceId)).toMatchObject({phase:'COMPLETED'});expect(opens).toBe(failures+1);expect(telemetry.filter(row=>row.jitAttempt)).toHaveLength(failures);expect(new Set(telemetry.filter(row=>row.jitAttempt).map(row=>row.ownerId)).size).toBe(1);}finally{repo.close();}});
  it("blocks exactly once on the fourth drift need and cannot hot-retry or notify again",async()=>{const repo=fixture();try{const {sourceId,childId}=setupReopen(repo);let opens=0,notifications=0;const input={repo,rpc:canonicalRpc(repo,childId),wallet,walletClient:()=>({}) as any,context:async()=>({}) as any,executeOpen:async()=>{opens++;throw new Error('V4_BID_LADDER_LEG_NOT_FUNDING_ONLY');},notify:async()=>{notifications++;}};const result=await processV4BidLadderUsdReset(input,sourceId);expect(result).toMatchObject({status:'BLOCKED',reason:'REPOSITION_JIT_REMATERIALIZATION_LIMIT_EXHAUSTED'});expect(repo.loadBidLadderUsdReset(childId)).toMatchObject({jit_rematerialization_attempts:V4_REPOSITION_MAX_JIT_REMATERIALIZATIONS,phase:'BLOCKED'});expect(repo.loadBidLadder(childId)).toMatchObject({status:'CANCELLED'});expect(opens).toBe(4);expect(notifications).toBe(1);expect(await processV4BidLadderUsdReset(input,sourceId)).toMatchObject({status:'BLOCKED'});expect({opens,notifications}).toEqual({opens:4,notifications:1});}finally{repo.close();}});
  it.each([1,2])("preserves JIT attempt #%i across repository restart while revision remains CAS version",async attempts=>{const first=fixture(),{sourceId,childId}=setupReopen(first),path=first.path,metadata={funding:{address:usdg,decimals:6},target:{address:target,decimals:18}};try{first.db.prepare("UPDATE v4_bid_ladder_usdg_reset_v1 SET revision=revision+5 WHERE ladder_id=?").run(childId);for(let index=0;index<attempts;index++)await rematerializeV4BidLadderRepositionChildOnce({repo:first,rpc:{} as any,ladderId:sourceId,childId,wallet,nowMs:5_000+index,pool:state(index*10,100n+BigInt(index)),metadata});const before=first.loadBidLadderUsdReset(childId)!;expect(Number(before.revision)).toBe(5+attempts);expect(Number(before.jit_rematerialization_attempts)).toBe(attempts);first.close();const reopened=new SqliteLedgerRepository(path);try{expect(reopened.loadBidLadderUsdReset(childId)).toMatchObject({revision:5+attempts,jit_rematerialization_attempts:attempts,jit_last_reference_block:String(99+attempts)});}finally{reopened.close();}}finally{try{first.close();}catch{}}});
  it("CAS-serializes duplicate rematerializers so only one consumes an attempt",async()=>{const root=mkdtempSync(join(tmpdir(),'jit-cas-')),path=join(root,'db.sqlite');roots.push(root);migrateSqlite(path,'infra/migrations');const one=new SqliteLedgerRepository(path),{sourceId,childId}=setupReopen(one),two=new SqliteLedgerRepository(path),metadata={funding:{address:usdg,decimals:6},target:{address:target,decimals:18}},rpc=canonicalRpc(),call=(repo:SqliteLedgerRepository)=>rematerializeV4BidLadderRepositionChildOnce({repo,rpc,ladderId:sourceId,childId,wallet,nowMs:8_000,metadata});try{const values=await Promise.allSettled([call(one),call(two)]);expect(values.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(values.filter(row=>row.status==='rejected')).toHaveLength(1);expect(one.loadBidLadderUsdReset(childId)).toMatchObject({jit_rematerialization_attempts:1});}finally{one.close();two.close();}});
  it("keeps cancelled generation immutable and explicit Resume creates exactly one linked generation+1",async()=>{const repo=fixture();try{const {sourceId,childId,capital}=setupBlockedIncident(repo),rpc=canonicalRpc(),context=async()=>({}) as any,base={repo,rpc,ladderId:sourceId,wallet,context,readWalletBalance:async()=>capital,readAllowanceReadiness:async()=>({ready:true,blockers:[]})};const status=await v4BidLadderRepositionResumeEligibility(base);expect(status).toMatchObject({eligible:true,priorChildId:childId,priorChildGeneration:1,nextGeneration:2,signingCount:0,broadcastCount:0});const resumed=await resumeV4BidLadderReposition(base);expect(resumed).toMatchObject({status:'RESUMED_REOPEN_PLANNED',previousChildId:childId,generation:2,jitAttemptsUsed:0,signingCount:0,broadcastCount:0});expect(repo.loadBidLadder(childId)).toMatchObject({status:'CANCELLED'});expect(repo.loadBidLadderUsdReset(childId)).toMatchObject({phase:'BLOCKED'});expect(repo.loadBidLadderUsdReset(resumed.childId)).toMatchObject({generation:2,root_ladder_id:sourceId,previous_ladder_id:childId,jit_rematerialization_attempts:0,phase:'OPEN_PENDING'});expect(repo.loadBidLadderUsdReset(sourceId)).toMatchObject({phase:'REOPEN_PLANNED',next_ladder_id:childId,reopen_workflow_identity:resumed.childId});expect(repo.db.prepare("SELECT COUNT(*) count FROM v4_bid_ladder_usdg_reset_v1 WHERE root_ladder_id=? AND generation=2").get(sourceId)).toEqual({count:1});await expect(resumeV4BidLadderReposition(base)).rejects.toThrow();expect(repo.db.prepare("SELECT COUNT(*) count FROM v4_bid_ladder_usdg_reset_v1 WHERE root_ladder_id=? AND generation=2").get(sourceId)).toEqual({count:1});}finally{repo.close();}});
  it.each([
    ['source not CLOSED',(repo:SqliteLedgerRepository,id:string)=>repo.db.prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?").run(id),'REPOSITION_RESUME_SOURCE_NOT_CANONICALLY_CLOSED'],
    ['missing principal',(repo:SqliteLedgerRepository,id:string)=>repo.db.prepare("UPDATE v4_bid_ladder_usdg_reset_v1 SET returned_usdg_principal_raw='0' WHERE ladder_id=?").run(id),'REPOSITION_RESUME_PRINCIPAL_MISSING'],
    ['unresolved tx',(repo:SqliteLedgerRepository,id:string)=>repo.db.prepare("UPDATE chain_transaction_journal SET status='SUBMITTED' WHERE workflow_identity=?").run(id),'REPOSITION_RESUME_UNRESOLVED_WALLET_TRANSACTION'],
    ['live old child',(repo:SqliteLedgerRepository,_id:string,child:string)=>{repo.db.prepare("UPDATE v4_bid_ladder_usdg_reset_v1 SET phase='OPEN_PENDING' WHERE ladder_id=?").run(child);},'REPOSITION_RESUME_PRIOR_CHILD_NOT_TERMINAL'],
    ['old child already minted',(repo:SqliteLedgerRepository,_id:string,child:string)=>{const pool=state(0,2n);repo.upsertV4Position({tokenId:99n,owner:wallet,poolId:pool.id,poolKey:pool.key,currency0:pool.key.currency0,currency1:pool.key.currency1,fee:pool.key.fee,tickSpacing:pool.key.tickSpacing,hooks:pool.key.hooks,tickLower:-10,tickUpper:10,liquidity:1n,initialAmount0:0n,initialAmount1:1n,mintHash:`0x${'b'.repeat(64)}`,openIntentId:child});},'REPOSITION_RESUME_PRIOR_CHILD_ALREADY_MINTED'],
  ] as const)("rejects Resume when %s",async(_name,mutate,code)=>{const repo=fixture();try{const {sourceId,childId,capital}=setupBlockedIncident(repo);mutate(repo,sourceId,childId);const result=await v4BidLadderRepositionResumeEligibility({repo,rpc:canonicalRpc(),ladderId:sourceId,wallet,context:async()=>({}) as any,readWalletBalance:async()=>capital,readAllowanceReadiness:async()=>({ready:true,blockers:[]})});expect(result.eligible).toBe(false);expect(result.blockers).toContain(code);}finally{repo.close();}});
  it("defines one exact phase-aware parent-state matrix", () => {
    expect(V4_BID_LADDER_USDG_RESET_PARENT_STATUS_MATRIX).toMatchObject({
      OPEN_PENDING: ["PLANNED", "OPEN"],
      WATCHING: ["OPEN"],
      CLOSE_PREPARED: ["OPEN"],
      CLOSE_SUBMITTED: ["OPEN", "CLOSED"],
      CLOSE_CONFIRMED: ["CLOSED"],
      PRINCIPAL_RECONCILED: ["CLOSED"],
      REOPEN_PLANNED: ["CLOSED"],
      REOPEN_PREPARED: ["CLOSED"],
      REOPEN_SUBMITTED: ["CLOSED"],
    });
    expect(v4BidLadderUsdResetParentStatePolicy("WATCHING", "OPEN").valid).toBe(
      true,
    );
    expect(
      v4BidLadderUsdResetParentStatePolicy("WATCHING", "CLOSED").valid,
    ).toBe(false);
    expect(
      v4BidLadderUsdResetParentStatePolicy("CLOSE_CONFIRMED", "CLOSED").valid,
    ).toBe(true);
    expect(
      v4BidLadderUsdResetParentStatePolicy("CLOSE_CONFIRMED", "OPEN").valid,
    ).toBe(false);
  });
  it("converges deterministic closed/cancelled orphans without inventing economic evidence", async () => {
    const repo = fixture();
    try {
      const normal = create(repo, 6000, 10, 21n),
        cancelled = create(repo, 6000, 20, 22n),
        external = create(repo, 6000, 30, 23n);
      repo.transitionBidLadderUsdReset({
        ladderId: normal.plan.ladderId,
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      repo.db
        .prepare(
          "UPDATE v4_bid_ladders SET status='CLOSED',close_provenance='EXTERNAL_OPERATOR_CLOSE' WHERE ladder_id=?",
        )
        .run(normal.plan.ladderId);
      repo.db
        .prepare(
          "UPDATE v4_bid_ladders SET status='CANCELLED',terminal_reason='AUTO_EXPIRED_PLANNED_30M',terminal_at_ms=updated_at_ms WHERE ladder_id=?",
        )
        .run(cancelled.plan.ladderId);
      repo.transitionBidLadderUsdReset({
        ladderId: external.plan.ladderId,
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      repo.db
        .prepare(
          "UPDATE v4_bid_ladders SET status='CLOSED',close_provenance='UNKNOWN_EXTERNAL' WHERE ladder_id=?",
        )
        .run(external.plan.ladderId);
      const input = {
        repo,
        rpc: {} as any,
        wallet,
        walletClient: () => {
          throw new Error("NO_SIGNER");
        },
        context: async () => {
          throw new Error("NO_CONTEXT");
        },
      };
      expect(
        await processV4BidLadderUsdReset(input, normal.plan.ladderId),
      ).toMatchObject({ status: "OPERATOR_CLOSED" });
      expect(
        await processV4BidLadderUsdReset(input, cancelled.plan.ladderId),
      ).toMatchObject({
        status: "BLOCKED",
        reason: "REPOSITION_SOURCE_LADDER_CANCELLED:OPEN_PENDING",
      });
      expect(
        await processV4BidLadderUsdReset(input, external.plan.ladderId),
      ).toMatchObject({
        status: "BLOCKED",
        reason:
          "EXTERNAL_OR_UNKNOWN_TERMINAL_ACCOUNTING_RECONCILIATION_REQUIRED",
      });
      expect(
        repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual({ count: 0 });
      for (const id of [
        normal.plan.ladderId,
        cancelled.plan.ladderId,
        external.plan.ladderId,
      ])
        expect(repo.loadBidLadderUsdReset(id)?.next_ladder_id).toBeNull();
    } finally {
      repo.close();
    }
  });
  it("isolates candidate faults and durably rotates the LIMIT window until a closed CLOSE_CONFIRMED source completes exactly once", async () => {
    const repo = fixture();
    try {
      const ladders = Array.from({ length: 11 }, (_, index) =>
          create(repo, 6000, index * 10, BigInt(100 + index)),
        ),
        identity = "manual-reposition:7:00000000-0000-4000-8000-000000000007",
        id = (index: number) => ladders[index]!.plan.ladderId;
      repo.transitionBidLadderUsdReset({
        ladderId: id(0),
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      repo.db
        .prepare(
          "UPDATE v4_bid_ladders SET status='CLOSED',close_provenance='EXTERNAL_OPERATOR_CLOSE' WHERE ladder_id=?",
        )
        .run(id(0));
      repo.db
        .prepare(
          "UPDATE v4_bid_ladders SET status='CANCELLED',terminal_reason='AUTO_EXPIRED_PLANNED_30M',terminal_at_ms=updated_at_ms WHERE ladder_id=?",
        )
        .run(id(1));
      repo.transitionBidLadderUsdReset({
        ladderId: id(2),
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id(3),
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      repo.db
        .prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?")
        .run(id(3));
      repo.db
        .prepare(
          "UPDATE v4_bid_ladders SET status='CLOSED',close_provenance='FUNI_EXECUTED' WHERE ladder_id=?",
        )
        .run(id(9));
      repo.transitionBidLadderUsdReset({
        ladderId: id(9),
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id(9),
        from: "WATCHING",
        to: "CLOSE_PREPARED",
        closeWorkflowIdentity: identity,
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id(9),
        from: "CLOSE_PREPARED",
        to: "CLOSE_SUBMITTED",
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id(9),
        from: "CLOSE_SUBMITTED",
        to: "CLOSE_CONFIRMED",
        closeReason: "USDG_RESET_REPOSITION",
      });
      const closeHash = `0x${"ab".repeat(32)}` as const;
      repo.persistChainPreparedTransaction({
        chainId: 4663,
        chainKey: "robinhood",
        protocol: "uniswap_v4",
        journalId: `${id(9)}:CLOSE_BATCH:0`,
        wallet,
        workflowIdentity: id(9),
        semanticStage: "CLOSE_BATCH",
        attempt: 0,
        nonce: 130,
        transactionType: "modifyLiquidities",
        expectedHash: closeHash,
        to: zero,
        requestFingerprint: "fixture-close",
        feeModel: "legacy",
      });
      repo.transitionChainTransaction({
        chainId: 4663,
        journalId: `${id(9)}:CLOSE_BATCH:0`,
        from: "PREPARED",
        to: "SUBMITTED",
      });
      repo.transitionChainTransaction({
        chainId: 4663,
        journalId: `${id(9)}:CLOSE_BATCH:0`,
        from: "SUBMITTED",
        to: "CONFIRMED",
        receipt: { status: "success", transactionHash: closeHash },
      });
      ladders.forEach((ladder, index) =>
        repo.db
          .prepare(
            "UPDATE v4_bid_ladder_usdg_reset_v1 SET updated_at_ms=? WHERE ladder_id=?",
          )
          .run(500_000 + index, ladder.plan.ladderId),
      );
      let principalRuns = 0,
        childPlans = 0,
        opens = 0,
        childId = "";
      const input = {
        repo,
        rpc: {} as any,
        wallet,
        walletClient: () => ({}) as any,
        context: async () => ({}) as any,
        readAllowanceReadiness: async () => ({ ready: true, blockers: [] }) as any,
        nowMs: () => 1_000_000,
        readTruth: async ({ ladderId }: { ladderId: string }) => {
          if (ladderId === id(3)) throw new Error("RPC_TIMEOUT");
          return { eligible: false, blockers: ["WAIT"] } as any;
        },
        reconcilePrincipal: async ({ ladderId }: { ladderId: string }) => {
          principalRuns++;
          repo.transitionBidLadderUsdReset({
            ladderId,
            from: "CLOSE_CONFIRMED",
            to: "PRINCIPAL_RECONCILED",
            returnedUsdgPrincipal: 900n,
            returnedTargetPrincipal: 0n,
            returnedUsdgFee: 10n,
            returnedTargetFee: 20n,
          });
          return {
            returnedUsdgPrincipal: 900n,
            returnedTargetPrincipal: 0n,
            returnedUsdgFee: 10n,
            returnedTargetFee: 20n,
          } as any;
        },
        planChild: async ({ ladderId }: { ladderId: string }) => {
          childPlans++;
          const child = create(repo, 6000, 500, 999n, 900n, {
            rootLadderId: ladderId,
            previousLadderId: ladderId,
            generation: 1,
            creationReason: "USDG_RESET_REPOSITION",
          });
          childId = child.plan.ladderId;
          repo.transitionBidLadderUsdReset({
            ladderId,
            from: "PRINCIPAL_RECONCILED",
            to: "REOPEN_PLANNED",
            reopenWorkflowIdentity: childId,
          });
          return childId;
        },
        executeOpen: async () => {
          opens++;
          return { status: "OPEN", mainnetTransactionsSent: 0 } as any;
        },
      } as any;
      const turns = [];
      for (let turn = 0; turn < 3; turn++)
        turns.push(await runV4BidLadderUsdResetCycle(input));
      expect(turns[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ladderId: id(0),
            status: "OPERATOR_CLOSED",
          }),
          expect.objectContaining({ ladderId: id(1), status: "BLOCKED" }),
          expect.objectContaining({
            ladderId: id(3),
            status: "FAILED_RETRYABLE",
            fairnessRotated: true,
          }),
        ]),
      );
      expect(
        turns
          .flat()
          .some((row) => row.ladderId === id(9) && row.status === "COMPLETED"),
      ).toBe(true);
      expect(repo.loadBidLadderUsdReset(id(9))).toMatchObject({
        phase: "COMPLETED",
        returned_usdg_principal_raw: "900",
        returned_target_principal_raw: "0",
        next_ladder_id: childId,
      });
      expect(repo.v4BidLadderStrategyDepthBps(childId)).toBe(
        repo.v4BidLadderStrategyDepthBps(id(9)),
      );
      expect(principalRuns).toBe(1);
      expect(childPlans).toBe(1);
      expect(opens).toBe(1);
      expect(await processV4BidLadderUsdReset(input, id(9))).toMatchObject({
        status: "COMPLETED",
      });
      expect(principalRuns).toBe(1);
      expect(childPlans).toBe(1);
      expect(opens).toBe(1);
      expect(
        repo.db
          .prepare(
            "SELECT COUNT(*) count FROM chain_transaction_journal WHERE semantic_stage='CLOSE_BATCH'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        repo.db
          .prepare(
            "SELECT COUNT(*) count FROM v4_bid_ladder_usdg_reset_v1 WHERE previous_ladder_id=?",
          )
          .get(id(9)),
      ).toEqual({ count: 1 });
    } finally {
      repo.close();
    }
  });
  it("classifies explicit invariant failures terminally and provider ambiguity retryably", () => {
    expect(
      classifyV4BidLadderUsdResetCandidateError(
        new Error("REPOSITION_DURABLE_MANUAL_AUTHORIZATION_MISSING"),
      ),
    ).toMatchObject({ classification: "DETERMINISTIC_TERMINAL" });
    expect(
      classifyV4BidLadderUsdResetCandidateError(new Error("RPC_TIMEOUT")),
    ).toMatchObject({ classification: "RETRYABLE" });
    expect(
      classifyV4BidLadderUsdResetCandidateError(
        new Error("REPOSITION_EXECUTION_POOL_STATE_UNAVAILABLE"),
      ),
    ).toMatchObject({ classification: "RETRYABLE" });
    expect(classifyV4BidLadderUsdResetCandidateError(new Error("FRESH_STATE_UNAVAILABLE:RPC_TIMEOUT"))).toMatchObject({classification:"RETRYABLE",code:"FRESH_STATE_UNAVAILABLE"});
  });
  it("keeps stale exact-pool evidence fail-closed before any signer authority",async()=>{const repo=fixture();try{const parent=create(repo,6000),id=parent.plan.ladderId;repo.db.prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?").run(id);repo.transitionBidLadderUsdReset({ladderId:id,from:"OPEN_PENDING",to:"WATCHING"});let signerCalls=0;await expect(processV4BidLadderUsdReset({repo,rpc:{} as any,wallet,walletClient:()=>{signerCalls++;return {} as any;},context:async()=>{throw new Error("NO_CONTEXT")},manualAuthorizationIdentity:"manual-reposition:7:00000000-0000-4000-8000-000000000007",readTruth:async()=>{throw new Error("FRESH_STATE_UNAVAILABLE:RPC_TIMEOUT")}},id)).rejects.toThrow("FRESH_STATE_UNAVAILABLE");expect(signerCalls).toBe(0);expect(repo.loadBidLadderUsdReset(id)).toMatchObject({phase:"WATCHING",close_workflow_identity:null,next_ladder_id:null});expect(repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal").get()).toEqual({count:0});}finally{repo.close();}});
  it("single-flights the natural CLOSE_CONFIRMED hot-path/recovery race and emits lifecycle notifications once", async () => {
    const repo = fixture();
    try {
      const parent = create(repo, 6000), id = parent.plan.ladderId,
        identity = "manual-reposition:7:00000000-0000-4000-8000-000000000007";
      repo.db.prepare("UPDATE v4_bid_ladders SET status='CLOSED' WHERE ladder_id=?").run(id);
      repo.transitionBidLadderUsdReset({ladderId:id,from:"OPEN_PENDING",to:"WATCHING"});
      repo.transitionBidLadderUsdReset({ladderId:id,from:"WATCHING",to:"CLOSE_PREPARED",closeWorkflowIdentity:identity});
      repo.transitionBidLadderUsdReset({ladderId:id,from:"CLOSE_PREPARED",to:"CLOSE_SUBMITTED"});
      repo.transitionBidLadderUsdReset({ladderId:id,from:"CLOSE_SUBMITTED",to:"CLOSE_CONFIRMED",closeReason:"USDG_RESET_REPOSITION"});
      let entered!: () => void, continuePrincipal!: () => void;
      const principalEntered = new Promise<void>(resolve => { entered = resolve; }),
        principalGate = new Promise<void>(resolve => { continuePrincipal = resolve; });
      let reconciliations=0,plans=0,opens=0;
      const notifications:string[]=[],telemetry:Record<string,unknown>[]=[];
      const base = {
        repo,rpc:{} as any,wallet,walletClient:()=>({}) as any,
        context:async()=>({}) as any,
        readAllowanceReadiness:async()=>({ready:true,blockers:[]} as any),
        reconcilePrincipal:async()=>{reconciliations++;entered();await principalGate;repo.transitionBidLadderUsdReset({ladderId:id,from:"CLOSE_CONFIRMED",to:"PRINCIPAL_RECONCILED",returnedUsdgPrincipal:900n,returnedTargetPrincipal:0n,returnedUsdgFee:10n,returnedTargetFee:20n});return {returnedUsdgPrincipal:900n,transitionResult:"APPLIED"} as any;},
        planChild:async()=>{plans++;const child=create(repo,6000,300,3n,900n,{rootLadderId:id,previousLadderId:id,generation:1,creationReason:"USDG_RESET_REPOSITION"});repo.transitionBidLadderUsdReset({ladderId:id,from:"PRINCIPAL_RECONCILED",to:"REOPEN_PLANNED",reopenWorkflowIdentity:child.plan.ladderId});return child.plan.ladderId;},
        executeOpen:async()=>{opens++;return {status:"OPEN",mainnetTransactionsSent:0} as any;},
        notify:(message:string)=>{notifications.push(message);},
        telemetry:(event:Record<string,unknown>)=>telemetry.push(event),
      };
      const hot=processV4BidLadderUsdReset({...base,callerSource:"USER_CONFIRM" as const,executionOwnerId:"hot-owner"},id);
      await principalEntered;
      const duplicate=await processV4BidLadderUsdReset({...base,callerSource:"IMMEDIATE_RECOVERY" as const,executionOwnerId:"recovery-owner"},id);
      expect(duplicate).toMatchObject({status:"ALREADY_PROGRESSING",concurrentConsumerSuppressed:true});
      continuePrincipal();
      expect(await hot).toMatchObject({status:"COMPLETED"});
      await Promise.resolve();
      expect({reconciliations,plans,opens}).toEqual({reconciliations:1,plans:1,opens:1});
      expect(notifications.filter(message=>message.includes("· CLOSED"))).toHaveLength(1);
      expect(notifications.filter(message=>message.includes("· OPEN"))).toHaveLength(1);
      expect(notifications.some(message=>message.includes("· BLOCKED"))).toBe(false);
      expect(repo.loadBidLadderUsdReset(id)).toMatchObject({phase:"COMPLETED"});
      expect(telemetry).toEqual(expect.arrayContaining([expect.objectContaining({leaseAcquireResult:"ALREADY_PROGRESSING",concurrentConsumerSuppressed:true})]));
      expect(repo.db.prepare("SELECT COUNT(*) count FROM v4_bid_ladder_usdg_reset_execution_leases").get()).toEqual({count:0});
    } finally { repo.close(); }
  });
  it("keeps single-flight ownership durable across repositories, renews a slow live owner, and permits expired-owner recovery", () => {
    const root=mkdtempSync(join(tmpdir(),"usdg-reset-cross-process-")),path=join(root,"ledger.sqlite");roots.push(root);migrateSqlite(path,"infra/migrations");
    const first=new SqliteLedgerRepository(path),second=new SqliteLedgerRepository(path);
    try {
      const ladder=create(first,6000).plan.ladderId;
      expect(acquireV4BidLadderRepositionLease({repo:first,ladderId:ladder,ownerId:"process-a",callerSource:"USER_CONFIRM",nowMs:1_000,leaseMs:100})).toMatchObject({result:"ACQUIRED",leaseUntil:1_100});
      expect(acquireV4BidLadderRepositionLease({repo:second,ladderId:ladder,ownerId:"process-b",callerSource:"IMMEDIATE_RECOVERY",nowMs:1_050,leaseMs:100})).toMatchObject({result:"ALREADY_PROGRESSING"});
      expect(renewV4BidLadderRepositionLease({repo:first,ladderId:ladder,ownerId:"process-a",nowMs:1_075,leaseMs:100})).toBe(true);
      expect(acquireV4BidLadderRepositionLease({repo:second,ladderId:ladder,ownerId:"process-b",callerSource:"PERIODIC_RECOVERY",nowMs:1_150,leaseMs:100})).toMatchObject({result:"ALREADY_PROGRESSING"});
      expect(acquireV4BidLadderRepositionLease({repo:second,ladderId:ladder,ownerId:"process-b",callerSource:"PERIODIC_RECOVERY",nowMs:1_176,leaseMs:100})).toMatchObject({result:"ACQUIRED",leaseUntil:1_276});
      expect(releaseV4BidLadderRepositionLease({repo:first,ladderId:ladder,ownerId:"process-a"})).toBe(false);
      expect(releaseV4BidLadderRepositionLease({repo:second,ladderId:ladder,ownerId:"process-b"})).toBe(true);
    } finally { first.close(); second.close(); }
  });
  it("makes Cancel and Stop lose safely to a live continuation owner", () => {
    const repo=fixture();
    try{
      const cancelSource=create(repo,6000).plan.ladderId;
      repo.db.prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?").run(cancelSource);
      repo.transitionBidLadderUsdReset({ladderId:cancelSource,from:"OPEN_PENDING",to:"WATCHING"});
      expect(acquireV4BidLadderRepositionLease({repo,ladderId:cancelSource,ownerId:"live-confirm",callerSource:"USER_CONFIRM",nowMs:1_000,leaseMs:1_000})).toMatchObject({result:"ACQUIRED"});
      expect(()=>cancelV4BidLadderRepositionPreClose({repo,ladderId:cancelSource,nowMs:1_001})).toThrow("REPOSITION_ALREADY_PROGRESSING");
      expect(repo.loadBidLadderUsdReset(cancelSource)).toMatchObject({phase:"WATCHING"});
      releaseV4BidLadderRepositionLease({repo,ladderId:cancelSource,ownerId:"live-confirm"});
      expect(cancelV4BidLadderRepositionPreClose({repo,ladderId:cancelSource,nowMs:1_002})).toMatchObject({phase:"BLOCKED"});

      const stopSource=create(repo,6000,0,2n).plan.ladderId,identity="manual-reposition:7:00000000-0000-4000-8000-000000000007";
      repo.db.prepare("UPDATE v4_bid_ladders SET status='CLOSED' WHERE ladder_id=?").run(stopSource);
      repo.transitionBidLadderUsdReset({ladderId:stopSource,from:"OPEN_PENDING",to:"WATCHING"});repo.transitionBidLadderUsdReset({ladderId:stopSource,from:"WATCHING",to:"CLOSE_PREPARED",closeWorkflowIdentity:identity});repo.transitionBidLadderUsdReset({ladderId:stopSource,from:"CLOSE_PREPARED",to:"CLOSE_SUBMITTED"});repo.transitionBidLadderUsdReset({ladderId:stopSource,from:"CLOSE_SUBMITTED",to:"CLOSE_CONFIRMED",closeReason:"USDG_RESET_REPOSITION"});
      const revision=Number(repo.loadBidLadderUsdReset(stopSource)?.revision);
      acquireV4BidLadderRepositionLease({repo,ladderId:stopSource,ownerId:"live-reopen",callerSource:"PERIODIC_RECOVERY",nowMs:2_000,leaseMs:1_000});
      expect(()=>stopV4BidLadderReplacementOpen({repo,ladderId:stopSource,expectedRevision:revision,nowMs:2_001})).toThrow("REPOSITION_ALREADY_PROGRESSING");
      expect(repo.loadBidLadderUsdReset(stopSource)).toMatchObject({phase:"CLOSE_CONFIRMED"});
      releaseV4BidLadderRepositionLease({repo,ladderId:stopSource,ownerId:"live-reopen"});
      expect(stopV4BidLadderReplacementOpen({repo,ladderId:stopSource,expectedRevision:revision,nowMs:2_002})).toMatchObject({phase:"BLOCKED"});
    }finally{repo.close();}
  });
  it("preserves a planned child on retryable nonce contention, then completes once, while nonce divergence fails closed", async () => {
    for (const failure of ["DURABLE_TRANSACTION_NONCE_MUTEX_HELD","DURABLE_TRANSACTION_NONCE_DIVERGENCE"]) {
      const repo=fixture();
      try {
        const parent=create(repo,6000),id=parent.plan.ladderId,identity="manual-reposition:7:00000000-0000-4000-8000-000000000007";
        repo.db.prepare("UPDATE v4_bid_ladders SET status='CLOSED' WHERE ladder_id=?").run(id);
        repo.transitionBidLadderUsdReset({ladderId:id,from:"OPEN_PENDING",to:"WATCHING"});repo.transitionBidLadderUsdReset({ladderId:id,from:"WATCHING",to:"CLOSE_PREPARED",closeWorkflowIdentity:identity});repo.transitionBidLadderUsdReset({ladderId:id,from:"CLOSE_PREPARED",to:"CLOSE_SUBMITTED"});repo.transitionBidLadderUsdReset({ladderId:id,from:"CLOSE_SUBMITTED",to:"CLOSE_CONFIRMED",closeReason:"USDG_RESET_REPOSITION"});repo.transitionBidLadderUsdReset({ladderId:id,from:"CLOSE_CONFIRMED",to:"PRINCIPAL_RECONCILED",returnedUsdgPrincipal:900n,returnedTargetPrincipal:0n,returnedUsdgFee:0n,returnedTargetFee:0n});
        const child=create(repo,6000,300,3n,900n,{rootLadderId:id,previousLadderId:id,generation:1,creationReason:"USDG_RESET_REPOSITION"});repo.transitionBidLadderUsdReset({ladderId:id,from:"PRINCIPAL_RECONCILED",to:"REOPEN_PLANNED",reopenWorkflowIdentity:child.plan.ladderId});
        let attempts=0,confirmedOpens=0;
        const input={repo,rpc:{} as any,wallet,walletClient:()=>({}) as any,context:async()=>({}) as any,executeOpen:async()=>{attempts++;if(attempts===1)throw new Error(failure);confirmedOpens++;return {status:"OPEN"} as any;}};
        const firstResult=await processV4BidLadderUsdReset(input,id);
        if(failure.endsWith("MUTEX_HELD")){
          expect(firstResult).toMatchObject({status:"RECOVERY_REQUIRED",reason:"DURABLE_TRANSACTION_NONCE_MUTEX_HELD"});expect(repo.loadBidLadderUsdReset(id)).toMatchObject({phase:"REOPEN_PLANNED"});expect(repo.loadBidLadder(child.plan.ladderId)).toMatchObject({status:"PLANNED"});expect(await processV4BidLadderUsdReset(input,id)).toMatchObject({status:"COMPLETED"});expect({attempts,confirmedOpens}).toEqual({attempts:2,confirmedOpens:1});
        }else{
          expect(firstResult).toMatchObject({status:"BLOCKED",reason:"DURABLE_TRANSACTION_NONCE_DIVERGENCE"});expect(repo.loadBidLadderUsdReset(id)).toMatchObject({phase:"BLOCKED"});expect(repo.loadBidLadder(child.plan.ladderId)).toMatchObject({status:"CANCELLED"});expect({attempts,confirmedOpens}).toEqual({attempts:1,confirmedOpens:0});
        }
      } finally { repo.close(); }
    }
    expect(classifyV4BidLadderRepositionExecutionError(new Error("DURABLE_TRANSACTION_NONCE_MUTEX_HELD"))).toMatchObject({classification:"RETRYABLE"});
    expect(classifyV4BidLadderRepositionExecutionError(new Error("DURABLE_TRANSACTION_NONCE_DIVERGENCE"))).toMatchObject({classification:"DETERMINISTIC_TERMINAL"});
  });
  it("retains exact-hash close and the 200 bps safety minimum", () => {
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
