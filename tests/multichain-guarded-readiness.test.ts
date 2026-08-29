import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  FallbackRpc,
  chainProfile,
  legacyFeeQuote,
  loadChainRuntimeConfig,
  protocolDeployment,
} from "@funi/core";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import { buildGuardedV3Approval, buildGuardedV3Collect } from "@funi/v3";
import { canonicalDeploymentVerification } from "../apps/cli/src/multichain-runtime.js";
import { estimateGuardedV3LifecycleGas } from "../apps/cli/src/v3-multichain-executor.js";
import {
  chainGasReadiness,
  configuredChainWallet,
  guardedLiveReadiness,
  nativeUsdFromVerifiedPool,
  registerManualVerifiedBscPool,
  verifyChainWallet,
} from "../apps/cli/src/multichain-guarded-readiness.js";

const wallet = "0x0000000000000000000000000000000000000009" as const,
  pool = "0x0000000000000000000000000000000000000010" as const,
  Q96 = 2n ** 96n;
function opened() {
  const dir = mkdtempSync(join(tmpdir(), "guarded-ready-")),
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
function rpcFor(chainId: 1 | 56, overrides: Record<string, unknown> = {}) {
  const profile = chainProfile(chainId),
    deployment = protocolDeployment(
      chainId,
      chainId === 56 ? "pancakeswap_v3" : "uniswap_v3",
    ),
    token0 = profile.quoteTokens[0]!.address,
    token1 = profile.wrappedNativeAddress,
    sqrtPriceX96 = chainId === 56 ? Q96 / 23n : Q96 * 22_360n,
    nonce = chainId === 56 ? 14 : 0;
  const client = {
    getChainId: async () => chainId,
    getTransactionCount: async () => nonce,
    getBalance: async () => 10n ** 20n,
    getGasPrice: async () => 3_000_000_000n,
    getBlock: async () => ({
      number: 100n,
      timestamp: 1_000n,
      baseFeePerGas: 10n,
    }),
    estimateMaxPriorityFeePerGas: async () => 2n,
    getFeeHistory: async () => ({ reward: [[2n]] }),
    getBytecode: async () => "0x6000",
    getBlockNumber: async () => 100n,
    estimateGas: async () => 100n,
    call: async () => ({ data: "0x" }),
    readContract: async ({ address, functionName, args }: any) => {
      if (
        address.toLowerCase() ===
        deployment.contracts.positionManager?.toLowerCase()
      ) {
        if (functionName === "factory") return deployment.contracts.factory;
        if (functionName === "WETH9") return deployment.contracts.wrappedNative;
        if (functionName === "deployer")
          return deployment.contracts.poolDeployer;
        if (functionName === "balanceOf") return 0n;
      }
      if (address.toLowerCase() === pool.toLowerCase()) {
        if (functionName === "factory") return deployment.contracts.factory;
        if (functionName === "token0") return token0;
        if (functionName === "token1") return token1;
        if (functionName === "fee") return 500;
        if (functionName === "tickSpacing") return 10;
        if (functionName === "liquidity") return 1000n;
        if (functionName === "slot0")
          return [sqrtPriceX96, 0, 0, 0, 0, 0, true];
      }
      if (
        address.toLowerCase() === deployment.contracts.factory?.toLowerCase()
      ) {
        if (functionName === "getPool")
          return Number(args?.[2]) === 500
            ? pool
            : "0x0000000000000000000000000000000000000000";
        if (functionName === "feeAmountTickSpacing") return 10;
      }
      if (functionName === "decimals")
        return address.toLowerCase() === token0.toLowerCase()
          ? profile.quoteTokens[0]!.decimals
          : 18;
      if (functionName === "symbol")
        return address.toLowerCase() === token0.toLowerCase()
          ? profile.quoteTokens[0]!.symbol
          : profile.nativeSymbol;
      if (functionName === "name") return "Verified token";
      if (functionName === "totalSupply") return 10n ** 30n;
      throw new Error(`unexpected:${functionName}`);
    },
    ...overrides,
  } as any;
  return new FallbackRpc(
    {
      chainId,
      name: profile.displayName,
      nativeSymbol: profile.nativeSymbol,
      rpcUrls: ["https://provider.invalid"],
      assets: {},
    },
    undefined,
    { clients: [client] },
  );
}

describe("guarded-live readiness model", () => {
  it("distinguishes read-only, configuration, evidence, simulation, and code-ready states", () => {
    const base = {
      chainId: 56,
      protocol: "pancakeswap_v3",
      supported: true,
      readOnlyReady: true,
      simulationProof: "RPC_SIMULATION_VERIFIED" as const,
      enabled: true,
      executionEnabled: true,
      dryRun: false,
      emergencyPause: false,
      deploymentVerified: true,
      providerHealthy: true,
      walletConfigured: true,
      walletBalanceVerified: true,
      gasPolicyValid: true,
      nativeGasSufficient: true,
      feeEvidenceFresh: true,
      priceEvidenceFresh: true,
      unresolvedChainTransactions: 0,
      nonceMutexEmpty: true,
      previewBound: true,
      authorizationBound: true,
    };
    expect(guardedLiveReadiness(base).state).toBe("GUARDED_LIVE_CODE_READY");
    expect(
      guardedLiveReadiness({
        ...base,
        executionEnabled: false,
      }).state,
    ).toBe("GUARDED_LIVE_CONFIGURATION_BLOCKED");
    expect(
      guardedLiveReadiness({ ...base, feeEvidenceFresh: false }).state,
    ).toBe("GUARDED_LIVE_EVIDENCE_BLOCKED");
    expect(
      guardedLiveReadiness({ ...base, simulationProof: undefined }).state,
    ).toBe("READ_ONLY_READY");
    expect(
      guardedLiveReadiness({
        ...base,
        simulationProof: "SIMULATION_PARTIALLY_VERIFIED",
      }).state,
    ).toBe("SIMULATION_READY");
    expect(guardedLiveReadiness({ ...base, supported: false }).state).toBe(
      "UNSUPPORTED",
    );
  });
  it("ignores retired aggregate exposure environment keys", () => {
    const env = {
      OPERATOR_WALLET: wallet,
      BSC_WALLET_ADDRESS: "0x0000000000000000000000000000000000000008",
    };
    expect(configuredChainWallet(56, env)).not.toBe(
      configuredChainWallet(1, env),
    );
    const config=loadChainRuntimeConfig("bsc",{BSC_ENABLED:"true",BSC_RPC_URL:"https://provider.invalid",OLD_AGGREGATE_EXPOSURE_KEY:"invalid"});
    expect(config.available).toBe(true);
  });
});

describe("manual pools, wallet evidence, and gas readiness", () => {
  it("registers an on-chain verified Pancake pool idempotently without execution side effects", async () => {
    const f = opened();
    try {
      const rpc = rpcFor(56),
        first = await registerManualVerifiedBscPool({
          rpc,
          repo: f.repo,
          poolAddress: pool,
          nowMs: 100,
        }),
        second = await registerManualVerifiedBscPool({
          rpc,
          repo: f.repo,
          poolAddress: pool,
          nowMs: 101,
        });
      expect(first).toMatchObject({
        status: "REGISTERED",
        source: "MANUAL_VERIFIED",
        signerConstructed: false,
        nonceReserved: false,
        journalWritten: false,
        broadcastUsed: false,
      });
      expect(second.status).toBe("ALREADY_REGISTERED_VERIFIED");
      expect(
        f.repo.db
          .prepare(
            "SELECT validation_status FROM chain_pools WHERE chain_id=56",
          )
          .get(),
      ).toEqual({ validation_status: "MANUAL_VERIFIED" });
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM chain_callback_authorizations")
          .get(),
      ).toEqual({ count: 0 });
      expect(f.repo.chainBotExposure(56).totalUsd).toBe(0);
    } finally {
      f.close();
    }
  });
  it("fails a pool with the wrong factory closed and persists nothing", async () => {
    const f = opened();
    try {
      const rpc = rpcFor(56, {
        readContract: async ({ address, functionName }: any) => {
          const deployment = protocolDeployment(56, "pancakeswap_v3");
          if (
            address.toLowerCase() ===
            deployment.contracts.positionManager!.toLowerCase()
          )
            return functionName === "factory"
              ? deployment.contracts.factory
              : functionName === "WETH9"
                ? deployment.contracts.wrappedNative
                : deployment.contracts.poolDeployer;
          if (
            address.toLowerCase() === pool.toLowerCase() &&
            functionName === "factory"
          )
            return wallet;
          throw new Error("blocked");
        },
      });
      await expect(
        registerManualVerifiedBscPool({ rpc, repo: f.repo, poolAddress: pool }),
      ).rejects.toThrow();
      expect(
        f.repo.db.prepare("SELECT COUNT(*) count FROM chain_pools").get(),
      ).toEqual({ count: 0 });
    } finally {
      f.close();
    }
  });
  it("keeps BSC 14/14 and Ethereum 0/0 nonce evidence chain-scoped and derives fee/price policy without manual metadata", async () => {
    const f = opened();
    try {
      const bsc = rpcFor(56),
        eth = rpcFor(1),
        bscWallet = await verifyChainWallet({
          rpc: bsc,
          repo: f.repo,
          chainId: 56,
          protocol: "pancakeswap_v3",
          wallet,
          nowMs: 100,
        }),
        ethWallet = await verifyChainWallet({
          rpc: eth,
          repo: f.repo,
          chainId: 1,
          protocol: "uniswap_v3",
          wallet,
          nowMs: 100,
        });
      expect(bscWallet).toMatchObject({
        status: "VERIFIED",
        latestNonce: 14,
        pendingNonce: 14,
        nonceEvidenceHealthy: true,
        nonceMutexEmpty: true,
      });
      expect(ethWallet).toMatchObject({
        status: "VERIFIED",
        latestNonce: 0,
        pendingNonce: 0,
        nonceEvidenceHealthy: true,
        nonceMutexEmpty: true,
      });
      const bscEnv = {
          BSC_ENABLED: "true",
          BSC_RPC_URL: "https://provider.invalid",
        },
        gas = await chainGasReadiness({
          rpc: bsc,
          repo: f.repo,
          config: loadChainRuntimeConfig("bsc", bscEnv),
          walletStatus: bscWallet,
          env: bscEnv,
          nowMs: 100,
        });
      expect(gas).toMatchObject({
        chain: "bsc",
        feeEvidenceStatus: "AVAILABLE",
        feeEvidenceFresh: true,
        projectedGasStatus: "NOT_APPLICABLE",
        projectedLifecycleGasStatus: "NOT_APPLICABLE",
        sufficiency: "NOT_APPLICABLE",
        gasPolicyValid: true,
        nonceEvidenceHealthy: true,
        signingUsed: false,
        broadcastUsed: false,
      });
      expect(gas.nativeUsdEvidence?.status).toBe("AVAILABLE");
      expect(gas.blockers).not.toEqual(
        expect.arrayContaining([
          "GAS_POLICY_PROVIDER_SPREAD_MISSING",
          "FEE_EVIDENCE_MAX_AGE_MISSING",
          "PROJECTED_ACTION_GAS_CONFIGURATION_MISSING",
          "PROJECTED_LIFECYCLE_GAS_CONFIGURATION_MISSING",
        ]),
      );
    } finally {
      f.close();
    }
  });
});

describe("canonical guarded-v3 runtime evidence", () => {
  it.each([
    [56, "pancakeswap_v3"],
    [1, "uniswap_v3"],
  ] as const)(
    "propagates verified deployment evidence on chain %s and invalidates a mismatched persisted version",
    async (chainId, protocol) => {
      const f = opened();
      try {
        const rpc = rpcFor(chainId),
          profile = chainProfile(chainId),
          first = await canonicalDeploymentVerification({
            profile,
            rpc,
            protocol,
            repo: f.repo,
            nowMs: 100,
          });
        expect(first).toMatchObject({
          status: "VERIFIED",
          source: "RUNTIME_VERIFIED",
          deploymentVersion: 1,
        });
        const reused = await canonicalDeploymentVerification({
          profile,
          rpc,
          protocol,
          repo: f.repo,
          nowMs: 101,
        });
        expect(reused).toMatchObject({
          status: "VERIFIED",
          source: "PERSISTED",
          evidenceRevision: first.evidenceRevision,
        });
        f.repo.db
          .prepare(
            "UPDATE chain_runtime_evidence SET deployment_version=2,payload_json=json_set(payload_json,'$.deploymentVersion',2) WHERE chain_id=? AND protocol=?",
          )
          .run(chainId, protocol);
        const refreshed = await canonicalDeploymentVerification({
          profile,
          rpc,
          protocol,
          repo: f.repo,
          nowMs: 102,
        });
        expect(refreshed).toMatchObject({
          status: "VERIFIED",
          source: "RUNTIME_VERIFIED",
          deploymentVersion: 1,
        });
      } finally {
        f.close();
      }
    },
  );

  it.each([
    [56, 500],
    [1, 2_000],
  ] as const)(
    "derives chain-scoped wrapped-native USD valuation with token ordering and decimals on chain %s",
    async (chainId, expected) => {
      const profile = chainProfile(chainId),
        stable = profile.quoteTokens[0]!,
        sqrtPriceX96 =
          chainId === 56
            ? Q96 / BigInt(Math.round(Math.sqrt(expected)))
            : Q96 * BigInt(Math.round(Math.sqrt(10 ** 12 / expected))),
        value = nativeUsdFromVerifiedPool({
          chainId,
          protocol: chainId === 56 ? "pancakeswap_v3" : "uniswap_v3",
          token0: stable.address,
          token1: profile.wrappedNativeAddress,
          sqrtPriceX96,
          token0Decimals: stable.decimals,
          token1Decimals: 18,
          observedBlock: 100n,
          observedAtMs: 100,
          nowMs: 101,
        });
      expect(value.nativeUsd).toBeGreaterThan(expected * 0.9);
      expect(value.nativeUsd).toBeLessThan(expected * 1.1);
      expect(() =>
        nativeUsdFromVerifiedPool({
          chainId,
          protocol: chainId === 56 ? "pancakeswap_v3" : "uniswap_v3",
          token0: stable.address,
          token1: profile.wrappedNativeAddress,
          sqrtPriceX96,
          token0Decimals: stable.decimals,
          token1Decimals: 18,
          observedBlock: 100n,
          observedAtMs: 0,
          nowMs: 1_000_000,
          maxAgeMs: 10,
        }),
      ).toThrow("NATIVE_USD_POOL_PRICE_STALE");
      expect(() =>
        nativeUsdFromVerifiedPool({
          chainId,
          protocol: chainId === 56 ? "pancakeswap_v3" : "uniswap_v3",
          token0: stable.address,
          token1: profile.wrappedNativeAddress,
          sqrtPriceX96,
          token0Decimals: stable.decimals + 1,
          token1Decimals: 18,
          observedBlock: 100n,
          observedAtMs: 100,
          nowMs: 101,
        }),
      ).toThrow("NATIVE_USD_TOKEN_DECIMALS_INVALID");
    },
  );

  it("estimates exact conditional stages, deduplicates approval, aggregates lifecycle gas, and leaves journal/nonce state untouched", async () => {
    const f = opened();
    try {
      const chainId = 56 as const,
        protocol = "pancakeswap_v3" as const,
        rpc = rpcFor(chainId),
        env = { BSC_ENABLED: "true", BSC_RPC_URL: "https://provider.invalid" },
        walletEvidence = await verifyChainWallet({
          rpc,
          repo: f.repo,
          chainId,
          protocol,
          wallet,
          nowMs: 100,
        }),
        token = chainProfile(chainId).quoteTokens[0]!.address,
        approval = buildGuardedV3Approval({
          chainId,
          protocol,
          tokenEvidence: {
            chainId,
            token,
            runtimeCodePresent: true,
            decimals: 18,
            totalSupply: 100n,
            transferSemantics: "STANDARD_ERC20",
            approveReturn: "BOOL",
          },
          amount: 10n,
        }),
        collect = buildGuardedV3Collect({
          chainId,
          protocol,
          tokenId: 1n,
          recipient: wallet,
        }),
        beforeJournal = f.repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
        beforeMutex = f.repo.db
          .prepare("SELECT COUNT(*) count FROM chain_nonce_mutex")
          .get(),
        gas = await chainGasReadiness({
          rpc,
          repo: f.repo,
          config: loadChainRuntimeConfig("bsc", env),
          walletStatus: walletEvidence,
          protocol,
          action: "OPEN",
          stages: [
            {
              stage: "APPROVAL",
              transaction: approval,
              requirement: "CONDITIONAL",
            },
            {
              stage: "APPROVAL_DUPLICATE",
              transaction: approval,
              requirement: "CONDITIONAL",
            },
            { stage: "MINT", transaction: collect },
          ],
          previewRevision: 7,
          allowanceEvidenceRevision: "allowance-1",
          env,
          nowMs: 100,
        });
      expect(gas.projectedGas).toHaveLength(2);
      expect(gas.projectedLifecycleGas).toMatchObject({
        low: 100n,
        high: 200n,
        bufferedLow: 120n,
        bufferedHigh: 240n,
        conditionalStages: ["APPROVAL"],
      });
      expect(gas.gasFunding).toMatchObject({
        fundingDeficit: 0n,
        actionAndLifecycleCovered: "OPEN",
      });
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual(beforeJournal);
      expect(
        f.repo.db.prepare("SELECT COUNT(*) count FROM chain_nonce_mutex").get(),
      ).toEqual(beforeMutex);
      expect(gas).toMatchObject({
        projectionEvidenceRevision: expect.stringMatching(/^0x/),
        signerConstructed: false,
        nonceReserved: false,
        journalWritten: false,
        broadcastUsed: false,
      });
    } finally {
      f.close();
    }
  });
  it("calculates only the evidence-backed native and USD funding deficit", async () => {
    const chainId = 56 as const,
      protocol = "pancakeswap_v3" as const,
      token = chainProfile(chainId).quoteTokens[0]!.address,
      transaction = buildGuardedV3Approval({
        chainId,
        protocol,
        tokenEvidence: {
          chainId,
          token,
          runtimeCodePresent: true,
          decimals: 18,
          totalSupply: 100n,
          transferSemantics: "STANDARD_ERC20",
          approveReturn: "BOOL",
        },
        amount: 10n,
      }),
      result = await estimateGuardedV3LifecycleGas({
        rpc: rpcFor(chainId),
        wallet,
        chainId,
        protocol,
        action: "OPEN",
        stages: [{ stage: "APPROVAL", transaction }],
        feeQuote: legacyFeeQuote({
          gasPrice: 3_000_000_000n,
          observedAtMs: 100,
        }),
        feeEvidenceRevision: "fee-1",
        previewRevision: 1,
        deploymentEvidenceRevision: "deployment-1",
        walletEvidenceRevision: "wallet-1",
        allowanceEvidenceRevision: "allowance-1",
        nativeBalance: 1n,
        nativeUsd: 500,
        nowMs: 100,
      });
    expect(result.funding.fundingDeficit).toBe(
      result.funding.safetyBufferedNativeRequirementHigh - 1n,
    );
    expect(result.funding.fundingDeficitUsd).toBeGreaterThan(0);
    expect(result.funding.actionAndLifecycleCovered).toBe("OPEN");
  });
});
