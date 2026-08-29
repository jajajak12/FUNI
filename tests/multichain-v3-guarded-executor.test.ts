import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { eip1559FeeQuote, legacyFeeQuote } from "@funi/core";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import {
  buildGuardedV3Approval,
  type GuardedV3Chain,
  type GuardedV3Protocol,
} from "@funi/v3";
import {
  acquireBscLegacyFeeEvidence,
  acquireEthereumEip1559FeeEvidence,
  approvalStageForAllowance,
  executeGuardedV3Transaction,
  guardedV3ExecutionBlockers,
  simulateOnlyGuardedV3Transaction,
  type GuardedV3Readiness,
  type V3ExecutorDependencies,
} from "../apps/cli/src/v3-multichain-executor.js";

const account = privateKeyToAccount(`0x${"01".padStart(64, "0")}` as Hex),
  token = "0x0000000000000000000000000000000000000001" as Address;
const tokenEvidence = (chainId: GuardedV3Chain) => ({
  chainId,
  token,
  runtimeCodePresent: true,
  decimals: 18,
  totalSupply: 100n,
  transferSemantics: "STANDARD_ERC20" as const,
  approveReturn: "BOOL" as const,
});
function opened() {
  const dir = mkdtempSync(join(tmpdir(), "guarded-v3-")),
    path = join(dir, "db.sqlite");
  migrateSqlite(path, "infra/migrations");
  const repo = new SqliteLedgerRepository(path);
  return {
    repo,
    close() {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function readiness(
  chainId: GuardedV3Chain,
  protocol: GuardedV3Protocol,
): GuardedV3Readiness {
  return {
    chainId,
    protocol,
    enabled: true,
    executionEnabled: true,
    dryRun: false,
    emergencyPause: false,
    deploymentVerification: "VERIFIED",
    providerChainId: chainId,
    wallet: account.address,
    providerHealthy: true,
    walletBalanceVerified: true,
    gasPolicyValid: true,
    nativeGasSufficient: true,
    nonceEvidenceHealthy: true,
    nonceMutexEmpty: true,
    unresolvedChainTransactions: 0,
    previewRevision: 1,
    currentPreviewRevision: 1,
    previewBound: true,
    deploymentVersion: 1,
    previewDeploymentVersion: 1,
    safetyRevision: "s1",
    currentSafetyRevision: "s1",
    feeEvidenceFresh: true,
    priceEvidenceFresh: true,
    simulationProofVerified: true,
    authorizationBound: true,
    authorizationValid: true,
  };
}
function workflow(
  repo: SqliteLedgerRepository,
  chainId: GuardedV3Chain,
  protocol: GuardedV3Protocol,
  id = "workflow",
) {
  repo.createChainV3Workflow({
    chainId,
    protocol,
    workflowId: id,
    idempotencyKey: id,
    action: "open",
    deploymentVersion: 1,
    wallet: account.address,
    previewRevision: 1,
    capabilitySnapshot: { open: true },
    safetyEvidence: { revision: "s1" },
    exposureEvidence: { fingerprint: "e1" },
    feeEvidence: { fresh: true },
    preview: {},
  });
}
function receipt(hash: Hex, gasUsed = 100n, effectiveGasPrice = 3n) {
  return {
    transactionHash: hash,
    status: "success" as const,
    gasUsed,
    effectiveGasPrice,
    blockNumber: 10n,
  };
}
function deps(
  repo: SqliteLedgerRepository,
  overrides: Partial<V3ExecutorDependencies> = {},
) {
  let expected: Hex = "0x" as Hex;
  const base: V3ExecutorDependencies = {
    simulate: async () => ({ gas: 100n }),
    pendingNonce: async () => ({ nonce: 10, providerCount: 2 }),
    sign: async (request) => account.signTransaction(request as any),
    broadcast: async (serialized) => {
      expected = keccak256(serialized);
      expect(
        (
          repo.db
            .prepare(
              "SELECT status FROM chain_transaction_journal WHERE expected_hash=?",
            )
            .get(expected) as any
        )?.status,
      ).toBe("PREPARED");
      return expected;
    },
    observe: async () => ({ status: "FOUND", hash: expected }),
    waitForReceipt: async (hash) => receipt(hash),
    reconcile: async () => ({ positionId: "7" }),
  };
  return { ...base, ...overrides };
}

describe("guarded BSC and Ethereum v3 executor", () => {
  it("commits PREPARED before BSC broadcast and persists exact receipt before reconciliation", async () => {
    const f = opened();
    try {
      workflow(f.repo, 56, "pancakeswap_v3");
      const tx = buildGuardedV3Approval({
          chainId: 56,
          protocol: "pancakeswap_v3",
          tokenEvidence: tokenEvidence(56),
          amount: 10n,
        }),
        result = await executeGuardedV3Transaction({
          repo: f.repo,
          transaction: tx,
          workflowId: "workflow",
          journalId: "journal",
          semanticStage: "APPROVAL",
          attempt: 0,
          wallet: account.address,
          capability: "open",
          feeQuote: legacyFeeQuote({ gasPrice: 3n, observedAtMs: 100 }),
          feeEvidenceMaxAgeMs: 100,
          confirmations: 15,
          readiness: readiness(56, "pancakeswap_v3"),
          dependencies: deps(f.repo),
          maximumGasUsd: 1,
          projectedLifecycleGasUsd: 0,
          maximumLifecycleGasUsd: 2,
          nativeUsd: 1,
          nativeBalance: 10n ** 30n,
          nowMs: 150,
        });
      expect(result.status).toBe("CONFIRMED_RECONCILED");
      expect(
        f.repo.db
          .prepare(
            "SELECT status,expected_hash,confirmation_count,actual_gas_native FROM chain_transaction_journal",
          )
          .get(),
      ).toMatchObject({
        status: "CONFIRMED",
        confirmation_count: 15,
        actual_gas_native: "300",
      });
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM chain_v3_lifecycle_events")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      f.close();
    }
  });
  it("sends zero transactions when PREPARED commit detects same-nonce different bytes", async () => {
    const f = opened();
    try {
      workflow(f.repo, 56, "pancakeswap_v3");
      f.repo.persistChainPreparedTransaction({
        chainId: 56,
        chainKey: "bsc",
        protocol: "pancakeswap_v3",
        journalId: "prior",
        wallet: account.address,
        workflowIdentity: "prior",
        semanticStage: "OPEN",
        attempt: 0,
        nonce: 10,
        transactionType: "legacy",
        expectedHash: `0x${"11".repeat(32)}`,
        to: token,
        requestFingerprint: "prior",
        feeModel: "legacy",
      });
      let broadcasts = 0;
      await expect(
        executeGuardedV3Transaction({
          repo: f.repo,
          transaction: buildGuardedV3Approval({
            chainId: 56,
            protocol: "pancakeswap_v3",
            tokenEvidence: tokenEvidence(56),
            amount: 10n,
          }),
          workflowId: "workflow",
          journalId: "journal",
          semanticStage: "APPROVAL",
          attempt: 0,
          wallet: account.address,
          capability: "open",
          feeQuote: legacyFeeQuote({ gasPrice: 3n, observedAtMs: 100 }),
          feeEvidenceMaxAgeMs: 100,
          confirmations: 15,
          readiness: readiness(56, "pancakeswap_v3"),
          dependencies: deps(f.repo, {
            broadcast: async () => {
              broadcasts++;
              throw new Error("must not broadcast");
            },
          }),
          maximumGasUsd: 1,
          projectedLifecycleGasUsd: 0,
          maximumLifecycleGasUsd: 2,
          nativeUsd: 1,
          nativeBalance: 10n ** 30n,
          nowMs: 150,
        }),
      ).rejects.toThrow("CHAIN_JOURNAL_SAME_NONCE_DIFFERENT_TRANSACTION");
      expect(broadcasts).toBe(0);
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      f.close();
    }
  });
  it("does not rebroadcast an existing submitted attempt", async () => {
    const f = opened();
    try {
      workflow(f.repo, 56, "pancakeswap_v3");
      const tx = buildGuardedV3Approval({
          chainId: 56,
          protocol: "pancakeswap_v3",
          tokenEvidence: tokenEvidence(56),
          amount: 10n,
        }),
        request = {
          chainId: 56,
          nonce: 10,
          to: tx.to,
          data: tx.data,
          value: 0n,
          gas: 100n,
          type: "legacy" as const,
          gasPrice: 3n,
        },
        raw = await account.signTransaction(request),
        hash = keccak256(raw);
      f.repo.persistChainPreparedTransaction({
        chainId: 56,
        chainKey: "bsc",
        protocol: "pancakeswap_v3",
        journalId: "journal",
        wallet: account.address,
        workflowIdentity: "workflow",
        semanticStage: "APPROVAL",
        attempt: 0,
        nonce: 10,
        transactionType: "legacy",
        expectedHash: hash,
        to: tx.to,
        requestFingerprint: "existing",
        feeModel: "legacy",
      });
      f.repo.transitionChainTransaction({
        chainId: 56,
        journalId: "journal",
        from: "PREPARED",
        to: "SUBMITTED",
      });
      let broadcasts = 0;
      await expect(
        executeGuardedV3Transaction({
          repo: f.repo,
          transaction: tx,
          workflowId: "workflow",
          journalId: "journal",
          semanticStage: "APPROVAL",
          attempt: 0,
          wallet: account.address,
          capability: "open",
          feeQuote: legacyFeeQuote({ gasPrice: 3n, observedAtMs: 100 }),
          feeEvidenceMaxAgeMs: 100,
          confirmations: 15,
          readiness: readiness(56, "pancakeswap_v3"),
          dependencies: deps(f.repo, {
            broadcast: async () => {
              broadcasts++;
              return hash;
            },
          }),
          maximumGasUsd: 1,
          projectedLifecycleGasUsd: 0,
          maximumLifecycleGasUsd: 2,
          nativeUsd: 1,
          nativeBalance: 10n ** 30n,
          nowMs: 150,
        }),
      ).rejects.toThrow("CHAIN_JOURNAL_ALREADY_SUBMITTED_RECOVERY_REQUIRED");
      expect(broadcasts).toBe(0);
    } finally {
      f.close();
    }
  });
  it("recovers provider-accepts-then-errors through exact-hash observation without retry", async () => {
    const f = opened();
    try {
      workflow(f.repo, 56, "pancakeswap_v3");
      let broadcasts = 0,
        observations = 0,
        expected: Hex = "0x" as Hex;
      const dependencies = deps(f.repo, {
        sign: async (request) => {
          const raw = await account.signTransaction(request as any);
          expected = keccak256(raw);
          return raw;
        },
        broadcast: async () => {
          broadcasts++;
          throw new Error("transport closed after acceptance");
        },
        observe: async () => {
          observations++;
          return {
            status: "FOUND",
            hash: expected,
            evidence: { providerIndex: 1 },
          };
        },
      });
      const result = await executeGuardedV3Transaction({
        repo: f.repo,
        transaction: buildGuardedV3Approval({
          chainId: 56,
          protocol: "pancakeswap_v3",
          tokenEvidence: tokenEvidence(56),
          amount: 10n,
        }),
        workflowId: "workflow",
        journalId: "journal",
        semanticStage: "APPROVAL",
        attempt: 0,
        wallet: account.address,
        capability: "open",
        feeQuote: legacyFeeQuote({ gasPrice: 3n, observedAtMs: 100 }),
        feeEvidenceMaxAgeMs: 100,
        confirmations: 15,
        readiness: readiness(56, "pancakeswap_v3"),
        dependencies,
        maximumGasUsd: 1,
        projectedLifecycleGasUsd: 0,
        maximumLifecycleGasUsd: 2,
        nativeUsd: 1,
        nativeBalance: 10n ** 30n,
        nowMs: 150,
      });
      expect(result.status).toBe("CONFIRMED_RECONCILED");
      expect({ broadcasts, observations }).toEqual({
        broadcasts: 1,
        observations: 1,
      });
    } finally {
      f.close();
    }
  });
  it("rejects a wrong-chain signed envelope before journal or broadcast", async () => {
    const f = opened();
    try {
      workflow(f.repo, 56, "pancakeswap_v3");
      let broadcasts = 0;
      await expect(
        executeGuardedV3Transaction({
          repo: f.repo,
          transaction: buildGuardedV3Approval({
            chainId: 56,
            protocol: "pancakeswap_v3",
            tokenEvidence: tokenEvidence(56),
            amount: 10n,
          }),
          workflowId: "workflow",
          journalId: "journal",
          semanticStage: "APPROVAL",
          attempt: 0,
          wallet: account.address,
          capability: "open",
          feeQuote: legacyFeeQuote({ gasPrice: 3n, observedAtMs: 100 }),
          feeEvidenceMaxAgeMs: 100,
          confirmations: 15,
          readiness: readiness(56, "pancakeswap_v3"),
          dependencies: deps(f.repo, {
            sign: async (request) =>
              account.signTransaction({ ...request, chainId: 1 } as any),
            broadcast: async () => {
              broadcasts++;
              return `0x${"11".repeat(32)}`;
            },
          }),
          maximumGasUsd: 1,
          projectedLifecycleGasUsd: 0,
          maximumLifecycleGasUsd: 2,
          nativeUsd: 1,
          nativeBalance: 10n ** 30n,
          nowMs: 150,
        }),
      ).rejects.toThrow("SIGNED_ENVELOPE_CHAIN_ID_MISMATCH");
      expect(broadcasts).toBe(0);
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      f.close();
    }
  });
  it("keeps confirmed receipt and gas truth when post-confirmation accounting fails", async () => {
    const f = opened();
    try {
      workflow(f.repo, 1, "uniswap_v3");
      const result = await executeGuardedV3Transaction({
        repo: f.repo,
        transaction: buildGuardedV3Approval({
          chainId: 1,
          protocol: "uniswap_v3",
          tokenEvidence: tokenEvidence(1),
          amount: 10n,
        }),
        workflowId: "workflow",
        journalId: "journal",
        semanticStage: "APPROVAL",
        attempt: 0,
        wallet: account.address,
        capability: "open",
        feeQuote: eip1559FeeQuote({
          baseFeePerGas: 10n,
          maxPriorityFeePerGas: 2n,
          observedAtMs: 100,
        }),
        feeEvidenceMaxAgeMs: 100,
        confirmations: 3,
        readiness: readiness(1, "uniswap_v3"),
        dependencies: deps(f.repo, {
          reconcile: async () => {
            throw new Error("parser unavailable");
          },
        }),
        maximumGasUsd: 1,
        projectedLifecycleGasUsd: 0,
        maximumLifecycleGasUsd: 2,
        nativeUsd: 1,
        nativeBalance: 10n ** 30n,
        nowMs: 150,
      });
      expect(result.status).toBe("CONFIRMED_ACCOUNTING_PENDING");
      expect(
        f.repo.db
          .prepare("SELECT status,receipt_json FROM chain_transaction_journal")
          .get(),
      ).toMatchObject({ status: "CONFIRMED" });
      expect(
        String(
          (
            f.repo.db
              .prepare("SELECT receipt_json FROM chain_transaction_journal")
              .get() as any
          ).receipt_json,
        ),
      ).toContain("success");
    } finally {
      f.close();
    }
  });
  it("fails missing native/USD valuation before signing", async () => {
    const f = opened();
    try {
      workflow(f.repo, 56, "pancakeswap_v3");
      let signs = 0,
        broadcasts = 0;
      await expect(
        executeGuardedV3Transaction({
          repo: f.repo,
          transaction: buildGuardedV3Approval({
            chainId: 56,
            protocol: "pancakeswap_v3",
            tokenEvidence: tokenEvidence(56),
            amount: 10n,
          }),
          workflowId: "workflow",
          journalId: "journal",
          semanticStage: "APPROVAL",
          attempt: 0,
          wallet: account.address,
          capability: "open",
          feeQuote: legacyFeeQuote({ gasPrice: 3n, observedAtMs: 100 }),
          feeEvidenceMaxAgeMs: 100,
          confirmations: 15,
          readiness: readiness(56, "pancakeswap_v3"),
          dependencies: deps(f.repo, {
            sign: async (request) => {
              signs++;
              return account.signTransaction(request as any);
            },
            broadcast: async () => {
              broadcasts++;
              return `0x${"11".repeat(32)}`;
            },
          }),
          maximumGasUsd: 1,
          projectedLifecycleGasUsd: 0,
          maximumLifecycleGasUsd: 2,
          nativeBalance: 10n ** 30n,
          nowMs: 150,
        }),
      ).rejects.toThrow("BNB_USD_VALUATION_REQUIRED_BEFORE_SIGNING");
      expect({ signs, broadcasts }).toEqual({ signs: 0, broadcasts: 0 });
    } finally {
      f.close();
    }
  });
  it("persists confirmation when actual gas exceeds the pre-sign policy projection", async () => {
    const f = opened();
    try {
      workflow(f.repo, 56, "pancakeswap_v3");
      const result = await executeGuardedV3Transaction({
        repo: f.repo,
        transaction: buildGuardedV3Approval({
          chainId: 56,
          protocol: "pancakeswap_v3",
          tokenEvidence: tokenEvidence(56),
          amount: 10n,
        }),
        workflowId: "workflow",
        journalId: "journal",
        semanticStage: "APPROVAL",
        attempt: 0,
        wallet: account.address,
        capability: "open",
        feeQuote: legacyFeeQuote({
          gasPrice: 1_000_000_000_000_000n,
          observedAtMs: 100,
        }),
        feeEvidenceMaxAgeMs: 100,
        confirmations: 15,
        readiness: readiness(56, "pancakeswap_v3"),
        dependencies: deps(f.repo, {
          waitForReceipt: async (hash) =>
            receipt(hash, 1_000n, 1_000_000_000_000_000n),
        }),
        maximumGasUsd: 0.2,
        projectedLifecycleGasUsd: 0,
        maximumLifecycleGasUsd: 2,
        nativeUsd: 1,
        nativeBalance: 10n ** 30n,
        nowMs: 150,
      });
      expect(result).toMatchObject({
        status: "CONFIRMED_RECONCILED",
        actualGasPolicyBreached: true,
      });
      expect(
        f.repo.db
          .prepare(
            "SELECT status,actual_gas_usd FROM chain_transaction_journal",
          )
          .get(),
      ).toMatchObject({ status: "CONFIRMED", actual_gas_usd: 1 });
    } finally {
      f.close();
    }
  });
  it.each([
    [56, "pancakeswap_v3"],
    [1, "uniswap_v3"],
  ] as const)(
    "blocks insufficient chain %s native balance before nonce reservation, signing, or journal persistence",
    async (chainId, protocol) => {
      const f = opened();
      try {
        workflow(f.repo, chainId, protocol);
        let signs = 0,
          nonceReads = 0;
        const feeQuote =
          chainId === 56
            ? legacyFeeQuote({ gasPrice: 3n, observedAtMs: 100 })
            : eip1559FeeQuote({
                baseFeePerGas: 10n,
                maxPriorityFeePerGas: 2n,
                observedAtMs: 100,
              });
        await expect(
          executeGuardedV3Transaction({
            repo: f.repo,
            transaction: buildGuardedV3Approval({
              chainId,
              protocol,
              tokenEvidence: tokenEvidence(chainId),
              amount: 10n,
            }),
            workflowId: "workflow",
            journalId: "journal",
            semanticStage: "APPROVAL",
            attempt: 0,
            wallet: account.address,
            capability: "open",
            feeQuote,
            feeEvidenceMaxAgeMs: 100,
            confirmations: 3,
            readiness: readiness(chainId, protocol),
            dependencies: deps(f.repo, {
              pendingNonce: async () => {
                nonceReads++;
                return { nonce: 10, providerCount: 1 };
              },
              sign: async (request) => {
                signs++;
                return account.signTransaction(request as any);
              },
            }),
            maximumGasUsd: 1,
            projectedLifecycleGasUsd: 0,
            maximumLifecycleGasUsd: 2,
            nativeUsd: 1,
            nativeBalance: 1n,
            nowMs: 150,
          }),
        ).rejects.toThrow(
          "CHAIN_NATIVE_GAS_BALANCE_INSUFFICIENT_BEFORE_SIGNING",
        );
        expect({ signs, nonceReads }).toEqual({ signs: 0, nonceReads: 0 });
        expect(
          f.repo.db
            .prepare("SELECT COUNT(*) count FROM chain_nonce_mutex")
            .get(),
        ).toEqual({ count: 0 });
        expect(
          f.repo.db
            .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        f.close();
      }
    },
  );
  it.each([
    [56, "pancakeswap_v3"],
    [1, "uniswap_v3"],
  ] as const)(
    "creates no chain %s journal or nonce state when exact simulation fails",
    async (chainId, protocol) => {
      const f = opened();
      try {
        workflow(f.repo, chainId, protocol);
        let signs = 0,
          nonceReads = 0;
        const feeQuote =
          chainId === 56
            ? legacyFeeQuote({ gasPrice: 3n, observedAtMs: 100 })
            : eip1559FeeQuote({
                baseFeePerGas: 10n,
                maxPriorityFeePerGas: 2n,
                observedAtMs: 100,
              });
        await expect(
          executeGuardedV3Transaction({
            repo: f.repo,
            transaction: buildGuardedV3Approval({
              chainId,
              protocol,
              tokenEvidence: tokenEvidence(chainId),
              amount: 10n,
            }),
            workflowId: "workflow",
            journalId: "journal",
            semanticStage: "APPROVAL",
            attempt: 0,
            wallet: account.address,
            capability: "open",
            feeQuote,
            feeEvidenceMaxAgeMs: 100,
            confirmations: 3,
            readiness: readiness(chainId, protocol),
            dependencies: deps(f.repo, {
              simulate: async () => {
                throw new Error("LOCAL_SIMULATION_REVERTED");
              },
              pendingNonce: async () => {
                nonceReads++;
                return { nonce: 10, providerCount: 1 };
              },
              sign: async (request) => {
                signs++;
                return account.signTransaction(request as any);
              },
            }),
            maximumGasUsd: 1,
            projectedLifecycleGasUsd: 0,
            maximumLifecycleGasUsd: 2,
            nativeUsd: 1,
            nativeBalance: 10n ** 30n,
            nowMs: 150,
          }),
        ).rejects.toThrow("LOCAL_SIMULATION_REVERTED");
        expect({ signs, nonceReads }).toEqual({ signs: 0, nonceReads: 0 });
        expect(
          f.repo.db
            .prepare("SELECT COUNT(*) count FROM chain_nonce_mutex")
            .get(),
        ).toEqual({ count: 0 });
        expect(
          f.repo.db
            .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        f.close();
      }
    },
  );
  it("runs the no-broadcast production preflight without signer, mutex, or journal effects", async () => {
    const f = opened();
    try {
      workflow(f.repo, 56, "pancakeswap_v3");
      const tx = buildGuardedV3Approval({
          chainId: 56,
          protocol: "pancakeswap_v3",
          tokenEvidence: tokenEvidence(56),
          amount: 10n,
        }),
        result = await simulateOnlyGuardedV3Transaction({
          repo: f.repo,
          transaction: tx,
          workflowId: "workflow",
          wallet: account.address,
          capability: "open",
          feeQuote: legacyFeeQuote({ gasPrice: 3n, observedAtMs: 100 }),
          feeEvidenceMaxAgeMs: 100,
          readiness: readiness(56, "pancakeswap_v3"),
          dependencies: deps(f.repo),
          maximumGasUsd: 1,
          projectedLifecycleGasUsd: 0,
          maximumLifecycleGasUsd: 2,
          nativeUsd: 1,
          nativeBalance: 10n ** 30n,
          nowMs: 150,
        });
      expect(result).toMatchObject({
        simulationResult: "VERIFIED",
        signerConstructed: false,
        nonceReserved: false,
        journalWritten: false,
        broadcastUsed: false,
      });
      expect(
        f.repo.db.prepare("SELECT COUNT(*) count FROM chain_nonce_mutex").get(),
      ).toEqual({ count: 0 });
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      f.close();
    }
  });
  it("fails stale deployment, safety, fee, and authorization evidence before signing", () => {
    const value = readiness(56, "pancakeswap_v3");
    expect(
      guardedV3ExecutionBlockers({
        ...value,
        previewDeploymentVersion: 2,
        currentSafetyRevision: "changed",
        feeEvidenceFresh: false,
        authorizationValid: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        "DEPLOYMENT_VERSION_CHANGED",
        "SAFETY_REVISION_CHANGED",
        "FEE_EVIDENCE_STALE",
        "CHAIN_AUTHORIZATION_INVALID",
      ]),
    );
  });
  it("reports only genuine pre-activation blockers when runtime evidence is healthy", () => {
    const value = readiness(56, "pancakeswap_v3"),
      blockers = guardedV3ExecutionBlockers({
        ...value,
        executionEnabled: false,
        dryRun: true,
        emergencyPause: true,
        authorizationBound: false,
        authorizationValid: false,
      });
    expect(blockers).toEqual([
      "CHAIN_EXECUTION_DISABLED",
      "CHAIN_DRY_RUN_ENABLED",
      "CHAIN_EMERGENCY_PAUSE",
      "CHAIN_AUTHORIZATION_REQUIRED",
    ]);
    expect(
      guardedV3ExecutionBlockers({ ...value, nativeGasSufficient: false }),
    ).toContain("CHAIN_NATIVE_GAS_INSUFFICIENT");
  });
  it("omits approval when allowance is already sufficient and includes it exactly once otherwise", () => {
    const transaction = buildGuardedV3Approval({
      chainId: 56,
      protocol: "pancakeswap_v3",
      tokenEvidence: tokenEvidence(56),
      amount: 10n,
    });
    expect(
      approvalStageForAllowance({
        stage: "APPROVAL",
        transaction,
        currentAllowance: 10n,
        requiredAllowance: 10n,
      }),
    ).toBeUndefined();
    expect(
      approvalStageForAllowance({
        stage: "APPROVAL",
        transaction,
        currentAllowance: 9n,
        requiredAllowance: 10n,
      }),
    ).toMatchObject({ stage: "APPROVAL", requirement: "REQUIRED" });
  });
  it.each([
    [56, "pancakeswap_v3"],
    [1, "uniswap_v3"],
  ] as const)(
    "blocks chain %s missing cap and stale fee evidence before executor side effects",
    async (chainId, protocol) => {
      const f = opened();
      try {
        workflow(f.repo, chainId, protocol);
        let simulationCalls = 0;
        const feeQuote =
          chainId === 56
            ? legacyFeeQuote({ gasPrice: 3n, observedAtMs: 100 })
            : eip1559FeeQuote({
                baseFeePerGas: 10n,
                maxPriorityFeePerGas: 2n,
                observedAtMs: 100,
              });
        await expect(
          executeGuardedV3Transaction({
            repo: f.repo,
            transaction: buildGuardedV3Approval({
              chainId,
              protocol,
              tokenEvidence: tokenEvidence(chainId),
              amount: 10n,
            }),
            workflowId: "workflow",
            journalId: "journal",
            semanticStage: "APPROVAL",
            attempt: 0,
            wallet: account.address,
            capability: "open",
            feeQuote,
            feeEvidenceMaxAgeMs: 100,
            confirmations: 3,
            readiness: {
              ...readiness(chainId, protocol),
              feeEvidenceFresh: false,
            },
            dependencies: deps(f.repo, {
              simulate: async () => {
                simulationCalls++;
                return { gas: 100n };
              },
            }),
            maximumGasUsd: 1,
            projectedLifecycleGasUsd: 0,
            maximumLifecycleGasUsd: 2,
            nativeUsd: 1,
            nativeBalance: 10n ** 30n,
            nowMs: 150,
          }),
        ).rejects.toThrow(/FEE_EVIDENCE_STALE/);
        expect(simulationCalls).toBe(0);
        expect(
          f.repo.db
            .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
            .get(),
        ).toEqual({ count: 0 });
        expect(
          f.repo.db
            .prepare("SELECT COUNT(*) count FROM chain_nonce_mutex")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        f.close();
      }
    },
  );
  it.each([
    [56, "pancakeswap_v3"],
    [1, "uniswap_v3"],
  ] as const)(
    "rejects chain %s wrong deployment destination before simulation or persistence",
    async (chainId, protocol) => {
      const f = opened();
      try {
        workflow(f.repo, chainId, protocol);
        let simulationCalls = 0;
        const valid = buildGuardedV3Approval({
            chainId,
            protocol,
            tokenEvidence: tokenEvidence(chainId),
            amount: 10n,
          }),
          transaction = { ...valid, to: account.address },
          feeQuote =
            chainId === 56
              ? legacyFeeQuote({ gasPrice: 3n, observedAtMs: 100 })
              : eip1559FeeQuote({
                  baseFeePerGas: 10n,
                  maxPriorityFeePerGas: 2n,
                  observedAtMs: 100,
                });
        await expect(
          executeGuardedV3Transaction({
            repo: f.repo,
            transaction,
            workflowId: "workflow",
            journalId: "journal",
            semanticStage: "APPROVAL",
            attempt: 0,
            wallet: account.address,
            capability: "open",
            feeQuote,
            feeEvidenceMaxAgeMs: 100,
            confirmations: 3,
            readiness: readiness(chainId, protocol),
            dependencies: deps(f.repo, {
              simulate: async () => {
                simulationCalls++;
                return { gas: 100n };
              },
            }),
            maximumGasUsd: 1,
            projectedLifecycleGasUsd: 0,
            maximumLifecycleGasUsd: 2,
            nativeUsd: 1,
            nativeBalance: 10n ** 30n,
            nowMs: 150,
          }),
        ).rejects.toThrow("V3_APPROVAL_TOKEN_CHAIN_MISMATCH");
        expect(simulationCalls).toBe(0);
        expect(
          f.repo.db
            .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        f.close();
      }
    },
  );
});

describe("chain fee evidence acquisition", () => {
  it("uses bounded legacy BSC gasPrice and rejects provider disagreement", async () => {
    await expect(
      acquireBscLegacyFeeEvidence({
        clients: [
          { getGasPrice: async () => 3n },
          { getGasPrice: async () => 3n },
        ],
        maximumProviderSpreadBps: 0,
        minimumGasPrice: 1n,
        maximumGasPrice: 5n,
        observedAtMs: 1,
      }),
    ).resolves.toMatchObject({
      feeModel: "legacy",
      gasPrice: 3n,
      providerCount: 2,
    });
    await expect(
      acquireBscLegacyFeeEvidence({
        clients: [
          { getGasPrice: async () => 3n },
          { getGasPrice: async () => 5n },
        ],
        maximumProviderSpreadBps: 1000,
      }),
    ).rejects.toThrow("FEE_PROVIDER_DISAGREEMENT");
  });
  it("uses EIP-1559 priority estimation with fee-history fallback and fails before signing when unavailable", async () => {
    const primary = {
        getBlock: async () => ({ baseFeePerGas: 10n }),
        estimateMaxPriorityFeePerGas: async () => 2n,
      },
      fallback = {
        getBlock: async () => ({ baseFeePerGas: 10n }),
        estimateMaxPriorityFeePerGas: async () => {
          throw new Error("temporary");
        },
        getFeeHistory: async () => ({ reward: [[2n], [2n]] }),
      };
    await expect(
      acquireEthereumEip1559FeeEvidence({
        clients: [primary, fallback],
        maximumProviderSpreadBps: 0,
        observedAtMs: 1,
      }),
    ).resolves.toMatchObject({
      feeModel: "eip1559",
      baseFeePerGas: 10n,
      providerCount: 2,
      providerSpreadBps: 0,
    });
    await expect(
      acquireEthereumEip1559FeeEvidence({
        clients: [{ getBlock: async () => ({ baseFeePerGas: null }) }],
        maximumProviderSpreadBps: 0,
      }),
    ).rejects.toThrow("FEE_EVIDENCE_UNAVAILABLE_BEFORE_SIGNING");
  });
  it("derives BSC and Ethereum provider spread, sample block, time, and revision without operator metadata", async () => {
    const bsc = await acquireBscLegacyFeeEvidence({
      clients: [
        {
          getChainId: async () => 56,
          getGasPrice: async () => 100n,
          getBlockNumber: async () => 10n,
        },
        {
          getChainId: async () => 56,
          getGasPrice: async () => 101n,
          getBlockNumber: async () => 11n,
        },
      ],
      observedAtMs: 123,
    });
    expect(bsc).toMatchObject({
      chainId: 56,
      providerCount: 2,
      providerSpreadBps: 99,
      sampleBlock: 10n,
      observedAtMs: 123,
      evidenceRevision: expect.stringMatching(/^0x/),
    });
    const eth = await acquireEthereumEip1559FeeEvidence({
      clients: [
        {
          getChainId: async () => 1,
          getBlock: async () => ({ baseFeePerGas: 100n, number: 20n }),
          estimateMaxPriorityFeePerGas: async () => 2n,
        },
        {
          getChainId: async () => 1,
          getBlock: async () => ({ baseFeePerGas: 101n, number: 21n }),
          getFeeHistory: async () => ({ reward: [[2n]] }),
        },
      ],
      observedAtMs: 124,
    });
    expect(eth).toMatchObject({
      chainId: 1,
      providerCount: 2,
      baseFeeSpreadBps: 99,
      priorityFeeSpreadBps: 0,
      sampleBlock: 20n,
      observedAtMs: 124,
      evidenceRevision: expect.stringMatching(/^0x/),
    });
    await expect(
      acquireBscLegacyFeeEvidence({
        clients: [{ getChainId: async () => 1, getGasPrice: async () => 100n }],
      }),
    ).rejects.toThrow("FEE_EVIDENCE_UNAVAILABLE_BEFORE_SIGNING");
  });
});
