import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  CHAIN_PROFILES,
  PROTOCOL_DEPLOYMENTS,
  actualGasEvidence,
  assertChainIdentity,
  assertFreshFeeQuote,
  chainAssetKey,
  chainConfigurationStatus,
  chainProfile,
  directStableValuation,
  eip1559FeeQuote,
  legacyFeeQuote,
  loadChainDeploymentRegistry,
  loadChainRuntimeConfig,
  nonceMutexIdentity,
  orientChainQuote,
  positionIdentity,
  protocolDeployment,
  requireProtocolCapability,
  supplyDisplay,
} from "@funi/core";

describe("multi-chain domain model", () => {
  it("has unique immutable durable chain identities and preserves FUNI defaults", () => {
    expect(Object.values(CHAIN_PROFILES).map((item) => item.chainId)).toEqual([
      4663, 56, 1,
    ]);
    expect(
      new Set(Object.values(CHAIN_PROFILES).map((item) => item.chainId)).size,
    ).toBe(3);
    expect(CHAIN_PROFILES.robinhood.enabledByDefault).toBe(true);
    expect(CHAIN_PROFILES.bsc.executionEnabledByDefault).toBe(false);
    expect(CHAIN_PROFILES.ethereum.executionEnabledByDefault).toBe(false);
    expect(() => Object.assign(CHAIN_PROFILES.bsc, { chainId: 1 })).toThrow();
    expect(chainProfile(4663).key).toBe("robinhood");
  });
  it("keys tokens, positions, and nonce locks by chain", () => {
    const token = "0x0000000000000000000000000000000000000001";
    expect(chainAssetKey(1, token)).not.toBe(chainAssetKey(56, token));
    expect(positionIdentity(1, "uniswap_v3", 7n)).not.toBe(
      positionIdentity(56, "uniswap_v3", 7n),
    );
    expect(nonceMutexIdentity(1, token)).not.toBe(
      nonceMutexIdentity(4663, token),
    );
  });
  it("rejects wrong-chain context fields", () => {
    expect(() =>
      assertChainIdentity({
        requestedChainId: 1,
        providerChainId: 56,
        deploymentChainId: 1,
      }),
    ).toThrow("CHAIN_CONTEXT_MISMATCH:providerChainId:56:1");
  });
  it("records official-source registries, exposes guarded v3 code capability, and rejects unsupported protocols", () => {
    expect(
      PROTOCOL_DEPLOYMENTS.every((item) =>
        /^(https:\/\/|config\/|packages\/)/.test(item.source.url),
      ),
    ).toBe(true);
    const pancake = requireProtocolCapability(56, "pancakeswap_v3", "open");
    expect(pancake.contracts.factory).toBeDefined();
    expect(pancake.runtimeVerification.status).toBe("UNVERIFIED");
    expect(() =>
      requireProtocolCapability(56, "pancakeswap_infinity", "discovery"),
    ).toThrow("PANCAKESWAP_INFINITY_SEPARATE_ADAPTER_NOT_IMPLEMENTED");
    expect(() => protocolDeployment(1, "pancakeswap_v3")).toThrow(
      "CHAIN_PROTOCOL_MISMATCH",
    );
  });
  it("loads versioned file registries and rejects bad versions, chain scope, and addresses", () => {
    expect(
      loadChainDeploymentRegistry(
        "config/deployments/ethereum.v1.json",
      ).deployments.map((item) => item.protocol),
    ).toEqual(["uniswap_v3", "uniswap_v4"]);
    const dir = mkdtempSync(join(tmpdir(), "bad-registry-"));
    try {
      const path = join(dir, "bad.json");
      for (const [value, message] of [
        [{ registryVersion: 2 }, "DEPLOYMENT_REGISTRY_VERSION_UNSUPPORTED"],
        [
          { registryVersion: 1, chainKey: "bsc", chainId: 1, deployments: [] },
          "DEPLOYMENT_CHAIN_ID_MISMATCH",
        ],
      ] as const) {
        writeFileSync(path, JSON.stringify(value));
        expect(() => loadChainDeploymentRegistry(path)).toThrow(message);
      }
      const valid = JSON.parse(
        JSON.stringify({
          registryVersion: 1,
          chainKey: "ethereum",
          chainId: 1,
          deployments: [
            {
              registryVersion: 1,
              chainKey: "ethereum",
              chainId: 1,
              protocol: "uniswap_v3",
              contracts: {
                ...protocolDeployment(1, "uniswap_v3").contracts,
                factory: "0x0000000000000000000000000000000000000000",
              },
            },
          ],
        }),
      );
      writeFileSync(path, JSON.stringify(valid));
      expect(() => loadChainDeploymentRegistry(path)).toThrow(
        "DEPLOYMENT_ADDRESS_MISMATCH",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("isolates malformed or missing new-chain configuration from FUNI", () => {
    const env = {
      BSC_ENABLED: "true",
      BSC_RPC_URLS: "",
      ETHEREUM_ENABLED: "true",
      ETHEREUM_RPC_URLS: "https://eth.example",
      ETHEREUM_EXECUTION_ENABLED: "garbage",
    };
    const funi = loadChainRuntimeConfig("robinhood", env),
      bsc = loadChainRuntimeConfig("bsc", env),
      ethereum = loadChainRuntimeConfig("ethereum", env);
    expect(funi.enabled).toBe(true);
    expect(bsc.available).toBe(false);
    expect(bsc.blockerReason).toContain("BSC_RPC_CONFIGURATION_MISSING");
    expect(ethereum.available).toBe(false);
    expect(ethereum.blockerReason).toBe(
      "CONFIG_INVALID:ETHEREUM_EXECUTION_ENABLED",
    );
  });
  it("keeps new chains disabled, dry-run, paused, capless, and explicitly configuration-blocked by default", () => {
    for (const key of ["bsc", "ethereum"] as const) {
      const config = loadChainRuntimeConfig(key, {});
      expect(config).toMatchObject({
        enabled: false,
        executionEnabled: false,
        dryRun: true,
        emergencyPause: true,
        available: false,
      });
      expect(config.blockerReason).toContain("RPC_CONFIGURATION_MISSING");
    }
    expect(chainConfigurationStatus({}).map((item) => item.key)).toEqual([
      "robinhood",
      "bsc",
      "ethereum",
    ]);
  });
});

describe("chain-aware quote and price model", () => {
  it("handles decimal pairs and token inversions without address-only identity", () => {
    const token = "0x0000000000000000000000000000000000000001",
      quote = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      forward = orientChainQuote({
        chainId: 1,
        token0: token,
        token1: quote,
        token0Decimals: 18,
        token1Decimals: 6,
        price1Per0: 2000,
        baseToken: token,
        quoteToken: quote,
      }),
      inverse = orientChainQuote({
        chainId: 1,
        token0: token,
        token1: quote,
        token0Decimals: 18,
        token1Decimals: 6,
        price1Per0: 2000,
        baseToken: quote,
        quoteToken: token,
      });
    expect(forward.quotePerBase).toBe(2000);
    expect(inverse.quotePerBase).toBe(0.0005);
    expect(forward.baseAssetKey).not.toBe(chainAssetKey(56, token));
  });
  it("allows only profile stable quotes and fails stale valuation closed", () => {
    const ethUsdc = CHAIN_PROFILES.ethereum.quoteTokens[0]!.address;
    expect(
      directStableValuation({
        chainId: 1,
        token: CHAIN_PROFILES.ethereum.wrappedNativeAddress,
        amountRaw: 1_000_000_000_000_000_000n,
        decimals: 18,
        stableQuote: ethUsdc,
        tokenPriceUsd: 2000,
        source: "verified pool",
        observedAtMs: 100,
        nowMs: 150,
        maxAgeMs: 100,
      }),
    ).toMatchObject({ status: "AVAILABLE", valueUsd: 2000 });
    expect(
      directStableValuation({
        chainId: 1,
        token: CHAIN_PROFILES.ethereum.wrappedNativeAddress,
        amountRaw: 1n,
        decimals: 18,
        stableQuote: ethUsdc,
        tokenPriceUsd: 2000,
        source: "verified pool",
        observedAtMs: 1,
        nowMs: 200,
        maxAgeMs: 100,
      }),
    ).toMatchObject({ status: "UNAVAILABLE", reason: "PRICE_STALE" });
    expect(() =>
      directStableValuation({
        chainId: 56,
        token: CHAIN_PROFILES.bsc.wrappedNativeAddress,
        amountRaw: 1n,
        decimals: 18,
        stableQuote: ethUsdc,
        tokenPriceUsd: 1,
        source: "wrong-chain",
        observedAtMs: 1,
        nowMs: 1,
        maxAgeMs: 1,
      }),
    ).toThrow("STABLE_QUOTE_NOT_ALLOWED_FOR_CHAIN");
  });
  it("shows FDV while keeping unavailable supply evidence explicit", () => {
    expect(
      supplyDisplay({ totalSupplyRaw: 1_000_000n, decimals: 6, priceUsd: 2 }),
    ).toMatchObject({
      status: "PARTIAL",
      fdvUsd: 2,
      marketCap: { status: "UNAVAILABLE" },
    });
    expect(supplyDisplay({ decimals: 18 })).toMatchObject({
      status: "UNAVAILABLE",
    });
  });
});

describe("chain fee policies", () => {
  it("supports bounded legacy gas for BSC and FUNI", () => {
    const quote = legacyFeeQuote({
      gasPrice: 3_000_000_000n,
      minimumGasPrice: 1_000_000_000n,
      maximumGasPrice: 5_000_000_000n,
      observedAtMs: 100,
    });
    expect(
      assertFreshFeeQuote(CHAIN_PROFILES.bsc, quote, {
        nowMs: 200,
        maxAgeMs: 101,
      }),
    ).toBe(quote);
    expect(() => legacyFeeQuote({ gasPrice: 9n, maximumGasPrice: 8n })).toThrow(
      "FEE_GAS_PRICE_ABOVE_POLICY_MAXIMUM",
    );
  });
  it("supports EIP-1559 base and priority evidence with stale/spike rejection", () => {
    const quote = eip1559FeeQuote({
      baseFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
      observedAtMs: 100,
    });
    expect(quote.maxFeePerGas).toBe(22n);
    expect(
      assertFreshFeeQuote(CHAIN_PROFILES.ethereum, quote, {
        nowMs: 200,
        maxAgeMs: 100,
      }),
    ).toBe(quote);
    expect(() =>
      assertFreshFeeQuote(CHAIN_PROFILES.ethereum, quote, {
        nowMs: 201,
        maxAgeMs: 100,
      }),
    ).toThrow("FEE_QUOTE_STALE");
    expect(() =>
      eip1559FeeQuote({
        baseFeePerGas: 10n,
        maxPriorityFeePerGas: 2n,
        maximumFeePerGas: 21n,
      }),
    ).toThrow("FEE_EIP1559_POLICY_MAXIMUM_EXCEEDED");
  });
  it("enforces replacement safety and preserves confirmed gas truth without USD", () => {
    const old = legacyFeeQuote({ gasPrice: 5n, observedAtMs: 1 }),
      same = legacyFeeQuote({ gasPrice: 5n, observedAtMs: 2 });
    expect(() =>
      assertFreshFeeQuote(CHAIN_PROFILES.bsc, same, {
        nowMs: 2,
        maxAgeMs: 10,
        replacementOf: old,
      }),
    ).toThrow("FEE_REPLACEMENT_NOT_HIGHER");
    expect(
      actualGasEvidence({
        chainId: 56,
        nativeSymbol: "BNB",
        gasUsed: 10n,
        effectiveGasPrice: 3n,
        projectedNative: 20n,
      }),
    ).toEqual({
      chainId: 56,
      nativeSymbol: "BNB",
      actualNative: 30n,
      actualUsd: undefined,
      projectionBreached: true,
      valuationStatus: "UNAVAILABLE",
    });
  });
});
