import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeFunctionData, type Address, type Hex, type TransactionReceipt } from "viem";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import { V4_ROBINHOOD_DEPLOYMENTS, permit2ApproveAbi } from "@funi/v4";
import { canonicalRequestFingerprint, type DurablePreparedTransaction } from "../apps/cli/src/transaction-boundary.js";
import { discoverMissingEconomicReconciliationWork } from "../apps/cli/src/economic-reconciliation-work.js";
import { runEconomicReconciliationCycle } from "../apps/cli/src/economic-reconciliation-cycle.js";
import { durableV4RecoveryCandidates, reconcileDurableV4Journals } from "../apps/cli/src/v4-durable-journal-reconcile.js";
import { assertDurableV4RecoveryStage, isDurableV4RecoveryStage } from "../apps/cli/src/v4-durable-journal-stages.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const wallet = "0x3333333333333333333333333333333333333333" as Address;
const funding = "0x1111111111111111111111111111111111111111" as Address;
const target = "0x2222222222222222222222222222222222222222" as Address;
const wrong = "0x4444444444444444444444444444444444444444" as Address;
const erc20ApproveAbi = [{
  type: "function",
  name: "approve",
  stateMutability: "nonpayable",
  inputs: [{ type: "address", name: "spender" }, { type: "uint256", name: "amount" }],
  outputs: [{ type: "bool" }],
}] as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "v4-approval-recovery-"));
  roots.push(root);
  const databasePath = join(root, "db.sqlite");
  migrateSqlite(databasePath, "infra/migrations");
  const repo = new SqliteLedgerRepository(databasePath);
  const ladderId = `v4bid_${"a".repeat(32)}`;
  repo.db.prepare("INSERT INTO v4_bid_ladders(ladder_id,strategy_version,execution_mode,pool_id,currency0,currency1,fee,tick_spacing,hooks,funding_token,target_token,funding_index,target_index,reference_tick,reference_block,total_funding_amount_raw,entry_usd_snapshot,status,created_at_ms,updated_at_ms) VALUES(?,'V4_BID_LADDER_V1','LIVE',?,?,?,?,?,?,?,?,1,0,0,'1','100',1,'PLANNED',1,1)").run(ladderId,`0x${"9".repeat(64)}`,target,funding,3000,10,"0x0000000000000000000000000000000000000000",funding,target);
  const leg = repo.db.prepare("INSERT INTO v4_bid_ladder_legs(ladder_id,leg_index,upper_drop_bps,lower_drop_bps,capital_weight_bps,tick_lower,tick_upper,funding_amount_raw,planned_liquidity_raw,funding_index,target_index,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,1,0,'PLANNED',1,1)");
  const weights = [800, 1200, 1800, 2500, 3700], amounts = [8, 12, 18, 25, 37];
  for (let index = 0; index < 5; index++) leg.run(ladderId,index,100+index*100,200+index*100,weights[index],-100-index*10,-50-index*10,String(amounts[index]),"1");
  return { repo, ladderId };
}

function approvalData(stage: string, spender = stage.includes("PERMIT2") ? V4_ROBINHOOD_DEPLOYMENTS.positionManager : V4_ROBINHOOD_DEPLOYMENTS.permit2) {
  return stage.includes("PERMIT2")
    ? encodeFunctionData({ abi: permit2ApproveAbi, functionName: "approve", args: [funding, spender, 100n, 9_999_999] })
    : encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [spender, 100n] });
}

function persistApproval(input: { repo: SqliteLedgerRepository; ladderId: string; stage: string; nonce?: number; to?: Address; account?: Address; spender?: Address }) {
  const nonce = input.nonce ?? 9;
  const hash = `0x${nonce.toString(16).padStart(2, "0").repeat(32)}` as Hex;
  const to = input.to ?? (input.stage.includes("PERMIT2") ? V4_ROBINHOOD_DEPLOYMENTS.permit2 : funding);
  const request = { account: input.account ?? wallet, chainId: 4663, to, data: approvalData(input.stage, input.spender), value: 0n, gas: 50_000n, gasPrice: 1n, nonce };
  const base = { workflowId: input.ladderId, semanticStage: input.stage, attempt: 0, request };
  const requestFingerprint = canonicalRequestFingerprint(base);
  const prepared: DurablePreparedTransaction = { ...base, expectedHash: hash, requestFingerprint };
  input.repo.persistChainPreparedTransaction({ chainId: 4663, chainKey: "robinhood", protocol: "uniswap_v4", journalId: `${input.ladderId}:${input.stage}:0`, wallet, workflowIdentity: input.ladderId, semanticStage: input.stage, attempt: 0, nonce, transactionType: input.stage, expectedHash: hash, to, requestFingerprint, feeModel: "legacy" });
  input.repo.db.prepare("UPDATE chain_transaction_journal SET provider_evidence_json=? WHERE journal_id=?").run(JSON.stringify({ prepared }, (_, value) => typeof value === "bigint" ? value.toString() : value), `${input.ladderId}:${input.stage}:0`);
  return { hash, journalId: `${input.ladderId}:${input.stage}:0`, to };
}

function receipt(hash: Hex, to: Address, from: Address = wallet): TransactionReceipt {
  return { status: "success", transactionHash: hash, blockNumber: 10n, blockHash: `0x${"5".repeat(64)}`, transactionIndex: 0, from, to, contractAddress: null, cumulativeGasUsed: 1n, effectiveGasPrice: 1n, gasUsed: 1n, logs: [], logsBloom: `0x${"0".repeat(512)}`, type: "legacy" };
}

describe("V4 approval journal canonical recovery", () => {
  for (const stage of ["OPEN_ERC20_APPROVAL", "OPEN_PERMIT2_APPROVAL"] as const) {
    it(`${stage} remains unresolved while its nonce is available`, async () => {
      const f = fixture(); try { persistApproval({ ...f, stage }); const result = await reconcileDurableV4Journals({ repo: f.repo, rpc: {} as any, wallet, observe: async () => ({ kind: "ABSENT", latestNonce: 9, pendingNonce: 9 }) }); expect(result.results).toMatchObject([{ outcome: "UNRESOLVED", evidence: "ABSENT" }]); expect(f.repo.unresolvedChainTransactions(4663, wallet)).toBe(1); } finally { f.repo.close(); }
    });

    it(`${stage} confirms the exact approval receipt without lifecycle projection`, async () => {
      const f = fixture(); try { const tx = persistApproval({ ...f, stage }); const result = await reconcileDurableV4Journals({ repo: f.repo, rpc: {} as any, wallet, observe: async () => ({ kind: "RECEIPT", receipt: receipt(tx.hash, tx.to) }) }); expect(result).toMatchObject({ signingAttempts: 0, broadcasts: 0, results: [{ outcome: "CONFIRMED_RECONCILED", semanticStage: stage, reconciliation: { journalTerminal: "CONFIRMED", stageAwareApproval: true } }] }); expect(f.repo.db.prepare("SELECT status,failure_reason FROM chain_transaction_journal WHERE journal_id=?").get(tx.journalId)).toEqual({ status: "CONFIRMED", failure_reason: null }); expect(f.repo.unresolvedChainTransactions(4663, wallet)).toBe(0); } finally { f.repo.close(); }
    });

    it(`${stage} fails terminally when an external transaction consumes its nonce`, async () => {
      const f = fixture(); try { const tx = persistApproval({ ...f, stage }); expect(f.repo.unresolvedChainTransactions(4663, wallet)).toBe(1); const first = await reconcileDurableV4Journals({ repo: f.repo, rpc: {} as any, wallet, observe: async () => ({ kind: "ABSENT", latestNonce: 10, pendingNonce: 10 }) }); expect(first).toMatchObject({ signingAttempts: 0, broadcasts: 0, mainnetTransactionsSent: 0, results: [{ outcome: "FAILED", failureReason: "NONCE_NO_LONGER_AVAILABLE" }] }); expect(f.repo.db.prepare("SELECT status,failure_reason FROM chain_transaction_journal WHERE journal_id=?").get(tx.journalId)).toEqual({ status: "FAILED", failure_reason: "NONCE_NO_LONGER_AVAILABLE" }); expect(f.repo.unresolvedChainTransactions(4663, wallet)).toBe(0); const replay = await reconcileDurableV4Journals({ repo: f.repo, rpc: {} as any, wallet, observe: async () => { throw new Error("must not replay terminal row"); } }); expect(replay.scanned).toBe(0); } finally { f.repo.close(); }
    });
  }

  it("fails closed on wrong token, spender, wallet, receipt hash, target, or sender", async () => {
    for (const scenario of ["token", "spender", "wallet", "hash", "receipt-target", "receipt-sender"] as const) {
      const f = fixture(); try {
        const tx = persistApproval({ ...f, stage: "OPEN_ERC20_APPROVAL", ...(scenario === "token" ? { to: wrong } : {}), ...(scenario === "spender" ? { spender: wrong } : {}), ...(scenario === "wallet" ? { account: wrong } : {}) });
        let observations = 0;
        const observedReceipt = receipt(scenario === "hash" ? `0x${"f".repeat(64)}` as Hex : tx.hash, scenario === "receipt-target" ? wrong : tx.to, scenario === "receipt-sender" ? wrong : wallet);
        const result = await reconcileDurableV4Journals({ repo: f.repo, rpc: {} as any, wallet, observe: async () => { observations++; return { kind: "RECEIPT", receipt: observedReceipt }; } });
        expect(result.results[0]).toMatchObject({ outcome: "FINALIZATION_FAILED", error: scenario === "token" || scenario === "spender" || scenario === "wallet" ? "V4_DURABLE_RECOVERY_APPROVAL_IDENTITY_MISMATCH" : "V4_DURABLE_RECOVERY_RECEIPT_IDENTITY_MISMATCH" });
        expect(f.repo.unresolvedChainTransactions(4663, wallet)).toBe(1);
        if (["token", "spender", "wallet"].includes(scenario)) expect(observations).toBe(0);
      } finally { f.repo.close(); }
    }
  });

  it("keeps provider ambiguity blocked and creates no recovery transaction", async () => {
    const f = fixture(); try { persistApproval({ ...f, stage: "OPEN_ERC20_APPROVAL" }); const result = await reconcileDurableV4Journals({ repo: f.repo, rpc: {} as any, wallet, observe: async () => ({ kind: "INCONCLUSIVE", reason: "PROVIDER_DISAGREEMENT" }) }); expect(result).toMatchObject({ signingAttempts: 0, broadcasts: 0, mainnetTransactionsSent: 0, results: [{ outcome: "UNRESOLVED", evidence: "INCONCLUSIVE" }] }); expect(f.repo.unresolvedChainTransactions(4663, wallet)).toBe(1); } finally { f.repo.close(); }
  });

  it("recovers through the canonical queue once and replays terminal state idempotently", async () => {
    const f = fixture(); try {
      const tx = persistApproval({ ...f, stage: "OPEN_ERC20_APPROVAL" });
      const client = { getTransactionReceipt: async () => { throw new Error("transaction not found"); }, getTransaction: async () => { throw new Error("transaction not found"); }, getTransactionCount: async ({ blockTag }: { blockTag: string }) => blockTag === "latest" ? 10 : 10 };
      const rpc = { clients: [client, client, client] } as any;
      const first = await runEconomicReconciliationCycle({ repo: f.repo, rpc, owner: "test-recovery", nowMs: 100 });
      expect(first).toMatchObject({ leased: 1, signingAttempts: 0, broadcasts: 0, mainnetTransactionsSent: 0, results: [{ status: "FAILED_CLOSED", outcome: "FAILED" }] });
      expect(f.repo.db.prepare("SELECT status,failure_reason FROM chain_transaction_journal WHERE journal_id=?").get(tx.journalId)).toEqual({ status: "FAILED", failure_reason: "NONCE_NO_LONGER_AVAILABLE" });
      const replay = await runEconomicReconciliationCycle({ repo: f.repo, rpc, owner: "test-restart", nowMs: 200 });
      expect(replay).toMatchObject({ leased: 0, signingAttempts: 0, broadcasts: 0, mainnetTransactionsSent: 0 });
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal").get()).toEqual({ count: 1 });
    } finally { f.repo.close(); }
  });

  it("keeps blocker stages and both discovery paths structurally aligned", () => {
    const stages = ["OPEN_ERC20_APPROVAL", "OPEN_PERMIT2_APPROVAL", "OPEN_BATCH", "CLOSE_BATCH", "COLLECT_BATCH:claim", "REPOSITION_PREPARE_ERC20_APPROVAL:100", "REPOSITION_PREPARE_PERMIT2_APPROVAL:100"];
    expect(stages.every(isDurableV4RecoveryStage)).toBe(true);
    expect(() => assertDurableV4RecoveryStage("FUTURE_UNREGISTERED_STAGE")).toThrow("V4_DURABLE_RECOVERY_STAGE_UNREGISTERED");
    const writer = readFileSync("apps/cli/src/v4-bid-ladder-live.ts", "utf8"), submitStart = writer.indexOf("async function submit("), broadcastStart = writer.indexOf("broadcastDurableTransaction({", submitStart);
    expect(writer.slice(submitStart, broadcastStart)).toContain("assertDurableV4RecoveryStage(input.stage)");
    const f = fixture(); try {
      let nonce = 20;
      for (const stage of stages) {
        if (stage.includes("APPROVAL")) persistApproval({ ...f, stage, nonce: nonce++ });
        else {
          const currentNonce = nonce++, hash = `0x${currentNonce.toString(16).padStart(2, "0").repeat(32)}`;
          f.repo.persistChainPreparedTransaction({ chainId: 4663, chainKey: "robinhood", protocol: "uniswap_v4", journalId: `${f.ladderId}:${stage}:0`, wallet, workflowIdentity: f.ladderId, semanticStage: stage, attempt: 0, nonce: currentNonce, transactionType: stage, expectedHash: hash, to: V4_ROBINHOOD_DEPLOYMENTS.positionManager, requestFingerprint: stage, feeModel: "legacy" });
        }
      }
      expect(f.repo.unresolvedChainTransactions(4663, wallet)).toBe(stages.length);
      expect(new Set(durableV4RecoveryCandidates(f.repo, wallet, 64).map((row) => row.semantic_stage))).toEqual(new Set(stages));
      expect(discoverMissingEconomicReconciliationWork(f.repo, 100)).toMatchObject({ scanned: stages.length, materialized: stages.length });
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM economic_reconciliation_work").get()).toEqual({ count: stages.length });
    } finally { f.repo.close(); }
  });
});
