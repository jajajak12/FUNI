import { getAddress, zeroAddress, type Address } from "viem";
import { readFileSync } from "node:fs";

export type ChainKey = "robinhood" | "bsc" | "ethereum";
export type ProtocolKey =
  "uniswap_v3" | "uniswap_v4" | "pancakeswap_v3" | "pancakeswap_infinity";
export type FeeModel = "legacy" | "eip1559";
export type DeploymentVerificationStatus =
  "VERIFIED" | "PARTIALLY_VERIFIED" | "UNVERIFIED" | "UNSUPPORTED";
export type ProtocolOperation =
  | "discovery"
  | "portfolioRead"
  | "externalPositionDiscovery"
  | "open"
  | "collect"
  | "partialClose"
  | "fullClose"
  | "burn"
  | "singleSidedOpen"
  | "permit2"
  | "dynamicFee"
  | "hooks"
  | "nativeFunding";

export type QuoteToken = {
  address: Address;
  symbol: string;
  decimals: number;
  stable: boolean;
  source: string;
};
export type ChainProfile = {
  readonly key: ChainKey;
  readonly chainId: number;
  readonly displayName: string;
  readonly nativeSymbol: string;
  readonly nativeDecimals: 18;
  readonly wrappedNativeAddress: Address;
  readonly blockExplorerBase: string;
  readonly expectedBlockTimeMs: number;
  readonly defaultReceiptConfirmations: number;
  readonly feeModel: FeeModel;
  readonly rpcEnvironmentVariables: readonly string[];
  readonly supportedProtocolKeys: readonly ProtocolKey[];
  readonly quoteTokens: readonly QuoteToken[];
  readonly enabledByDefault: boolean;
  readonly executionEnabledByDefault: boolean;
  readonly dryRunByDefault: boolean;
  readonly emergencyPauseByDefault: boolean;
};
export type ProtocolCapabilities = Readonly<
  Record<ProtocolOperation, boolean>
> & { readonly executionSupported: boolean; readonly blockerReason?: string };
export type RuntimeCodeVerification = {
  readonly status: DeploymentVerificationStatus;
  readonly verifiedAt?: string;
  readonly verificationBlock?: string;
  readonly codeHashes?: Readonly<Record<string, string>>;
  readonly blockerReason?: string;
};
export type ProtocolDeployment = {
  readonly registryVersion: 1;
  readonly chainId: number;
  readonly chainKey: ChainKey;
  readonly protocol: ProtocolKey;
  readonly deploymentBlock?: string;
  readonly contracts: Readonly<
    Partial<
      Record<
        | "factory"
        | "poolDeployer"
        | "positionManager"
        | "poolManager"
        | "stateView"
        | "quoter"
        | "router"
        | "universalRouter"
        | "permit2"
        | "multicall"
        | "wrappedNative",
        Address
      >
    >
  >;
  readonly source: Readonly<{
    kind:
      "official-docs" | "official-repository" | "persisted-funi-verification";
    url: string;
    retrievedAt: string;
  }>;
  readonly runtimeVerification: RuntimeCodeVerification;
  readonly capabilities: ProtocolCapabilities;
};

const address = (value: string) => getAddress(value);
const quote = (value: QuoteToken) => Object.freeze(value);
const profile = (value: ChainProfile): ChainProfile =>
  Object.freeze({
    ...value,
    rpcEnvironmentVariables: Object.freeze([...value.rpcEnvironmentVariables]),
    supportedProtocolKeys: Object.freeze([...value.supportedProtocolKeys]),
    quoteTokens: Object.freeze(value.quoteTokens.map(quote)),
  });

export const CHAIN_PROFILES: Readonly<Record<ChainKey, ChainProfile>> =
  Object.freeze({
    robinhood: profile({
      key: "robinhood",
      chainId: 4663,
      displayName: "Robinhood Chain",
      nativeSymbol: "ETH",
      nativeDecimals: 18,
      wrappedNativeAddress: address(
        "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      ),
      blockExplorerBase: "https://robinhoodchain.blockscout.com",
      expectedBlockTimeMs: 2_000,
      defaultReceiptConfirmations: 2,
      feeModel: "legacy",
      rpcEnvironmentVariables: [
        "ALCHEMY_RPC_URLS",
        "ALCHEMY_RPC_URL",
        "RH_RPC_URL",
        "RH_RPC_FALLBACK_URL",
      ],
      supportedProtocolKeys: ["uniswap_v3", "uniswap_v4"],
      quoteTokens: [
        quote({
          address: address("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
          symbol: "USDG",
          decimals: 6,
          stable: true,
          source: "verified Robinhood deployment snapshot",
        }),
      ],
      enabledByDefault: true,
      executionEnabledByDefault: false,
      dryRunByDefault: true,
      emergencyPauseByDefault: true,
    }),
    bsc: profile({
      key: "bsc",
      chainId: 56,
      displayName: "BNB Smart Chain",
      nativeSymbol: "BNB",
      nativeDecimals: 18,
      wrappedNativeAddress: address(
        "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      ),
      blockExplorerBase: "https://bscscan.com",
      expectedBlockTimeMs: 750,
      defaultReceiptConfirmations: 15,
      feeModel: "legacy",
      rpcEnvironmentVariables: ["BSC_RPC_URLS", "BSC_RPC_URL"],
      supportedProtocolKeys: [
        "pancakeswap_v3",
        "uniswap_v3",
        "pancakeswap_infinity",
      ],
      quoteTokens: [
        quote({
          address: address("0x55d398326f99059fF775485246999027B3197955"),
          symbol: "USDT",
          decimals: 18,
          stable: true,
          source: "canonical BSC token; runtime verification required",
        }),
        quote({
          address: address("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"),
          symbol: "USDC",
          decimals: 18,
          stable: true,
          source: "canonical BSC token; runtime verification required",
        }),
      ],
      enabledByDefault: false,
      executionEnabledByDefault: false,
      dryRunByDefault: true,
      emergencyPauseByDefault: true,
    }),
    ethereum: profile({
      key: "ethereum",
      chainId: 1,
      displayName: "Ethereum Mainnet",
      nativeSymbol: "ETH",
      nativeDecimals: 18,
      wrappedNativeAddress: address(
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      ),
      blockExplorerBase: "https://etherscan.io",
      expectedBlockTimeMs: 12_000,
      defaultReceiptConfirmations: 3,
      feeModel: "eip1559",
      rpcEnvironmentVariables: ["ETHEREUM_RPC_URLS", "ETHEREUM_RPC_URL"],
      supportedProtocolKeys: ["uniswap_v3", "uniswap_v4"],
      quoteTokens: [
        quote({
          address: address("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
          symbol: "USDC",
          decimals: 6,
          stable: true,
          source: "canonical Ethereum USDC; runtime verification required",
        }),
        quote({
          address: address("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
          symbol: "USDT",
          decimals: 6,
          stable: true,
          source: "canonical Ethereum USDT; runtime verification required",
        }),
      ],
      enabledByDefault: false,
      executionEnabledByDefault: false,
      dryRunByDefault: true,
      emergencyPauseByDefault: true,
    }),
  });

export function chainProfile(input: ChainKey | number): ChainProfile {
  const found =
    typeof input === "number"
      ? Object.values(CHAIN_PROFILES).find((item) => item.chainId === input)
      : CHAIN_PROFILES[input];
  if (!found) throw new Error(`UNKNOWN_CHAIN:${String(input)}`);
  return found;
}
export function chainAssetKey(chainId: number, token: Address | string) {
  return `${chainId}:${getAddress(token).toLowerCase()}`;
}
export function positionIdentity(
  chainId: number,
  protocol: ProtocolKey,
  positionId: string | bigint,
) {
  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    String(positionId).length === 0
  )
    throw new Error("POSITION_IDENTITY_INVALID");
  return `${chainId}:${protocol}:${String(positionId)}`;
}
export function nonceMutexIdentity(chainId: number, wallet: Address | string) {
  return `${chainId}:${getAddress(wallet).toLowerCase()}`;
}
export function assertChainIdentity(input: {
  requestedChainId: number;
  providerChainId: number;
  deploymentChainId: number;
  workflowChainId?: number;
  journalChainId?: number;
  signedTransactionChainId?: number;
}) {
  for (const [field, value] of Object.entries(input))
    if (value !== undefined && value !== input.requestedChainId)
      throw new Error(
        `CHAIN_CONTEXT_MISMATCH:${field}:${value}:${input.requestedChainId}`,
      );
}

const readBool = (env: NodeJS.ProcessEnv, key: string, fallback: boolean) => {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (/^(true|1|yes|on)$/i.test(raw)) return true;
  if (/^(false|0|no|off)$/i.test(raw)) return false;
  throw new Error(`CONFIG_INVALID:${key}`);
};
const readPositiveInt = (
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
) => {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`CONFIG_INVALID:${key}`);
  return value;
};
const rpcUrls = (env: NodeJS.ProcessEnv, profile: ChainProfile) =>
  profile.rpcEnvironmentVariables
    .flatMap((key) => (env[key] ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
export type ChainRuntimeConfig = {
  readonly profile: ChainProfile;
  readonly enabled: boolean;
  readonly executionEnabled: boolean;
  readonly dryRun: boolean;
  readonly emergencyPause: boolean;
  readonly confirmations: number;
  readonly rpcUrls: readonly string[];
  readonly available: boolean;
  readonly blockerReason?: string;
};
export function loadChainRuntimeConfig(
  key: ChainKey,
  env: NodeJS.ProcessEnv = process.env,
): ChainRuntimeConfig {
  const p = chainProfile(key),
    prefix = key === "robinhood" ? "" : key === "bsc" ? "BSC_" : "ETHEREUM_";
  try {
    const enabled =
        key === "robinhood" ? true : readBool(env, `${prefix}ENABLED`, false),
      executionEnabled =
        key === "robinhood"
          ? readBool(env, "EXECUTION_ENABLED", false)
          : readBool(env, `${prefix}EXECUTION_ENABLED`, false),
      dryRun =
        key === "robinhood"
          ? readBool(env, "DRY_RUN", true)
          : readBool(env, `${prefix}DRY_RUN`, true),
      emergencyPause =
        key === "robinhood"
          ? readBool(env, "EMERGENCY_PAUSE", true)
          : readBool(env, `${prefix}EMERGENCY_PAUSE`, true),
      confirmations = readPositiveInt(
        env,
        key === "robinhood" ? "RH_CONFIRMATIONS" : `${prefix}CONFIRMATIONS`,
        p.defaultReceiptConfirmations,
      ),
      configuredUrls = rpcUrls(env, p),
      urls =
        key === "robinhood" && !configuredUrls.length
          ? ["https://rpc.mainnet.chain.robinhood.com"]
          : configuredUrls;
    const blockers: string[] = [];
    if (key !== "robinhood" && !enabled) blockers.push("CHAIN_DISABLED");
    if (key !== "robinhood" && !urls.length)
      blockers.push(`${prefix}RPC_CONFIGURATION_MISSING`);
    if (enabled && !urls.length && key === "robinhood")
      blockers.push("RH_RPC_CONFIGURATION_MISSING");
    if (executionEnabled && !enabled) blockers.push("CHAIN_NOT_ENABLED");
    if (executionEnabled && dryRun) blockers.push("DRY_RUN_ENABLED");
    if (executionEnabled && emergencyPause) blockers.push("EMERGENCY_PAUSE");
    return Object.freeze({
      profile: p,
      enabled,
      executionEnabled,
      dryRun,
      emergencyPause,
      confirmations,
      rpcUrls: Object.freeze(urls),
      available: blockers.length === 0,
      blockerReason: blockers.length ? blockers.join(",") : undefined,
    });
  } catch (error) {
    return Object.freeze({
      profile: p,
      enabled: false,
      executionEnabled: false,
      dryRun: true,
      emergencyPause: true,
      confirmations: p.defaultReceiptConfirmations,
      rpcUrls: Object.freeze([]),
      available: false,
      blockerReason: error instanceof Error ? error.message : "CONFIG_INVALID",
    });
  }
}
export function chainConfigurationStatus(env: NodeJS.ProcessEnv = process.env) {
  return (Object.keys(CHAIN_PROFILES) as ChainKey[]).map((key) => {
    const config = loadChainRuntimeConfig(key, env);
    return {
      key,
      chainId: config.profile.chainId,
      enabled: config.enabled,
      readOnlyAvailable: config.enabled && config.available,
      executionEnabled: config.executionEnabled,
      executionAvailable:
        config.executionEnabled &&
        config.available &&
        !config.dryRun &&
        !config.emergencyPause,
      rpcProviderCount: config.rpcUrls.length,
      confirmations: config.confirmations,
      feeModel: config.profile.feeModel,
      dryRun: config.dryRun,
      emergencyPause: config.emergencyPause,
      blockerReason: config.blockerReason,
    };
  });
}

const noExecution = (
  read: Partial<Record<ProtocolOperation, boolean>>,
  blockerReason: string,
): ProtocolCapabilities =>
  Object.freeze({
    discovery: false,
    portfolioRead: false,
    externalPositionDiscovery: false,
    open: false,
    collect: false,
    partialClose: false,
    fullClose: false,
    burn: false,
    singleSidedOpen: false,
    permit2: false,
    dynamicFee: false,
    hooks: false,
    nativeFunding: false,
    ...read,
    executionSupported: false,
    blockerReason,
  });
const robinCapabilities = (v4 = false): ProtocolCapabilities =>
  Object.freeze({
    discovery: true,
    portfolioRead: true,
    externalPositionDiscovery: true,
    open: true,
    collect: true,
    partialClose: true,
    fullClose: true,
    burn: true,
    singleSidedOpen: true,
    permit2: true,
    dynamicFee: v4,
    hooks: v4,
    nativeFunding: false,
    executionSupported: true,
  });
const guardedV3Capabilities = (blockerReason: string): ProtocolCapabilities =>
  Object.freeze({
    discovery: true,
    portfolioRead: true,
    externalPositionDiscovery: true,
    open: true,
    collect: true,
    partialClose: true,
    fullClose: true,
    burn: true,
    singleSidedOpen: true,
    permit2: false,
    dynamicFee: false,
    hooks: false,
    nativeFunding: true,
    executionSupported: true,
    blockerReason,
  });
const deployment = (value: ProtocolDeployment) =>
  Object.freeze({
    ...value,
    contracts: Object.freeze({ ...value.contracts }),
    source: Object.freeze({ ...value.source }),
    runtimeVerification: Object.freeze({ ...value.runtimeVerification }),
    capabilities: Object.freeze({ ...value.capabilities }),
  });
export const PROTOCOL_DEPLOYMENTS: readonly ProtocolDeployment[] =
  Object.freeze([
    deployment({
      registryVersion: 1,
      chainId: 4663,
      chainKey: "robinhood",
      protocol: "uniswap_v3",
      deploymentBlock: "16574811",
      contracts: {
        factory: address("0x1f7d7550b1b028f7571e69a784071f0205fd2efa"),
        positionManager: address("0x73991a25c818bf1f1128deaab1492d45638de0d3"),
        quoter: address("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"),
        router: address("0xcaf681a66d020601342297493863e78c959e5cb2"),
        universalRouter: address("0x8876789976decbfcbbbe364623c63652db8c0904"),
        permit2: address("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
        wrappedNative: CHAIN_PROFILES.robinhood.wrappedNativeAddress,
      },
      source: {
        kind: "persisted-funi-verification",
        url: "config/robinhood-v3-deployments.16574811.json",
        retrievedAt: "2026-07-28",
      },
      runtimeVerification: {
        status: "VERIFIED",
        verificationBlock: "16574811",
      },
      capabilities: robinCapabilities(),
    }),
    deployment({
      registryVersion: 1,
      chainId: 4663,
      chainKey: "robinhood",
      protocol: "uniswap_v4",
      contracts: {
        poolManager: address("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
        positionManager: address("0x58daec3116aae6d93017baaea7749052e8a04fa7"),
        stateView: address("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"),
        quoter: address("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
        universalRouter: address("0x8876789976decbfcbbbe364623c63652db8c0904"),
        permit2: address("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
      },
      source: {
        kind: "persisted-funi-verification",
        url: "packages/uniswap-v4-adapter/src/index.ts",
        retrievedAt: "2026-07-28",
      },
      runtimeVerification: { status: "VERIFIED" },
      capabilities: robinCapabilities(true),
    }),
    deployment({
      registryVersion: 1,
      chainId: 1,
      chainKey: "ethereum",
      protocol: "uniswap_v3",
      contracts: {
        factory: address("0x1F98431c8aD98523631AE4a59f267346ea31F984"),
        positionManager: address("0xC36442b4a4522E871399CD717aBDD847Ab11FE88"),
        quoter: address("0x61fFE014bA17989E743c5F6cB21bF9697530B21e"),
        router: address("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"),
        universalRouter: address("0x66a9893cc07d91d95644aedd05d03f95e1dba8af"),
        permit2: address("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
        multicall: address("0x1F98415757620B543A52E61c46B32eB19261F984"),
        wrappedNative: CHAIN_PROFILES.ethereum.wrappedNativeAddress,
      },
      source: {
        kind: "official-docs",
        url: "https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments",
        retrievedAt: "2026-08-01",
      },
      runtimeVerification: {
        status: "UNVERIFIED",
        blockerReason:
          "chain RPC bytecode and relationship verification pending",
      },
      capabilities: guardedV3Capabilities(
        "ETHEREUM_V3_RUNTIME_AND_FORK_VERIFICATION_PENDING",
      ),
    }),
    deployment({
      registryVersion: 1,
      chainId: 1,
      chainKey: "ethereum",
      protocol: "uniswap_v4",
      contracts: {
        poolManager: address("0x000000000004444c5dc75cB358380D2e3dE08A90"),
        positionManager: address("0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e"),
        stateView: address("0x7ffe42c4a5deea5b0fec41c94c136cf115597227"),
        quoter: address("0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203"),
        universalRouter: address("0x66a9893cc07d91d95644aedd05d03f95e1dba8af"),
        permit2: address("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
      },
      source: {
        kind: "official-docs",
        url: "https://developers.uniswap.org/docs/protocols/v4/deployments",
        retrievedAt: "2026-08-01",
      },
      runtimeVerification: {
        status: "UNVERIFIED",
        blockerReason:
          "chain RPC bytecode and relationship verification pending",
      },
      capabilities: noExecution(
        {
          discovery: true,
          portfolioRead: true,
          externalPositionDiscovery: true,
          permit2: true,
          dynamicFee: true,
          hooks: true,
        },
        "ETHEREUM_V4_EXECUTION_ADAPTER_AND_HOOK_PATH_VERIFICATION_PENDING",
      ),
    }),
    deployment({
      registryVersion: 1,
      chainId: 56,
      chainKey: "bsc",
      protocol: "pancakeswap_v3",
      contracts: {
        factory: address("0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"),
        poolDeployer: address("0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9"),
        positionManager: address("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364"),
        quoter: address("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997"),
        router: address("0x1b81D678ffb9C0263b24A97847620C99d213eB14"),
        universalRouter: address("0x13f4EA83D0bd40E75C8222255bc855a974568Dd4"),
        multicall: address("0xac1cE734566f390A94b00eb9bf561c2625BF44ea"),
        wrappedNative: CHAIN_PROFILES.bsc.wrappedNativeAddress,
      },
      source: {
        kind: "official-docs",
        url: "https://developer.pancakeswap.finance/contracts/v3/addresses",
        retrievedAt: "2026-08-01",
      },
      runtimeVerification: {
        status: "UNVERIFIED",
        blockerReason: "BSC RPC bytecode and Pancake role verification pending",
      },
      capabilities: guardedV3Capabilities(
        "PANCAKESWAP_V3_RUNTIME_AND_FORK_VERIFICATION_PENDING",
      ),
    }),
    deployment({
      registryVersion: 1,
      chainId: 56,
      chainKey: "bsc",
      protocol: "uniswap_v3",
      contracts: {
        factory: address("0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7"),
        positionManager: address("0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613"),
        quoter: address("0x78D78E420Da98ad378D7799bE8f4AF69033EB077"),
        router: address("0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2"),
        universalRouter: address("0x1906c1d672b88cd1b9ac7593301ca990f94eae07"),
        permit2: address("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
        multicall: address("0x963Df249eD09c358A4819E39d9Cd5736c3087184"),
        wrappedNative: CHAIN_PROFILES.bsc.wrappedNativeAddress,
      },
      source: {
        kind: "official-docs",
        url: "https://developers.uniswap.org/docs/protocols/v3/deployments/v3-bnb-deployments",
        retrievedAt: "2026-08-01",
      },
      runtimeVerification: {
        status: "UNVERIFIED",
        blockerReason: "BSC RPC bytecode and relationship verification pending",
      },
      capabilities: noExecution(
        {
          discovery: true,
          portfolioRead: true,
          externalPositionDiscovery: true,
          permit2: true,
        },
        "BSC_UNISWAP_V3_EXECUTION_PATH_VERIFICATION_PENDING",
      ),
    }),
    deployment({
      registryVersion: 1,
      chainId: 56,
      chainKey: "bsc",
      protocol: "pancakeswap_infinity",
      contracts: {},
      source: {
        kind: "official-docs",
        url: "https://developer.pancakeswap.finance/contracts/infinity/overview",
        retrievedAt: "2026-08-01",
      },
      runtimeVerification: {
        status: "UNSUPPORTED",
        blockerReason:
          "Infinity lifecycle and command encoding are not Uniswap v4 compatible",
      },
      capabilities: noExecution(
        {},
        "PANCAKESWAP_INFINITY_SEPARATE_ADAPTER_NOT_IMPLEMENTED",
      ),
    }),
  ]);

export function protocolDeployment(chainId: number, protocol: ProtocolKey) {
  const found = PROTOCOL_DEPLOYMENTS.find(
    (value) => value.chainId === chainId && value.protocol === protocol,
  );
  if (!found) throw new Error(`CHAIN_PROTOCOL_MISMATCH:${chainId}:${protocol}`);
  validateProtocolDeployment(found);
  return found;
}
export function validateProtocolDeployment(value: ProtocolDeployment) {
  if (value.registryVersion !== 1)
    throw new Error("DEPLOYMENT_REGISTRY_VERSION_UNSUPPORTED");
  if (chainProfile(value.chainKey).chainId !== value.chainId)
    throw new Error("DEPLOYMENT_CHAIN_ID_MISMATCH");
  for (const [name, item] of Object.entries(value.contracts)) {
    if (!item || item.toLowerCase() === zeroAddress)
      throw new Error(`DEPLOYMENT_ADDRESS_INVALID:${name}`);
  }
  if (value.capabilities.executionSupported) {
    const required =
      value.protocol === "uniswap_v4"
        ? ["poolManager", "positionManager", "stateView", "quoter"]
        : ["factory", "positionManager", "quoter"];
    for (const name of required)
      if (!value.contracts[name as keyof typeof value.contracts])
        throw new Error(`DEPLOYMENT_CAPABILITY_CONTRACT_MISSING:${name}`);
  }
  return value;
}
export function requireProtocolCapability(
  chainId: number,
  protocol: ProtocolKey,
  operation: ProtocolOperation,
) {
  const item = protocolDeployment(chainId, protocol);
  if (!item.capabilities[operation])
    throw new Error(
      `CAPABILITY_UNSUPPORTED:${chainId}:${protocol}:${operation}:${item.capabilities.blockerReason ?? "not supported"}`,
    );
  return item;
}
export function loadChainDeploymentRegistry(path: string) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    registryVersion?: number;
    chainKey?: ChainKey;
    chainId?: number;
    deployments?: Array<Record<string, unknown>>;
  };
  if (parsed.registryVersion !== 1)
    throw new Error("DEPLOYMENT_REGISTRY_VERSION_UNSUPPORTED");
  if (
    !parsed.chainKey ||
    !Number.isSafeInteger(parsed.chainId) ||
    chainProfile(parsed.chainKey).chainId !== parsed.chainId
  )
    throw new Error("DEPLOYMENT_CHAIN_ID_MISMATCH");
  if (!Array.isArray(parsed.deployments) || !parsed.deployments.length)
    throw new Error("DEPLOYMENT_REGISTRY_EMPTY");
  const records = parsed.deployments.map((raw) => {
    const canonical = PROTOCOL_DEPLOYMENTS.find(
      (item) =>
        item.chainId === parsed.chainId && item.protocol === raw.protocol,
    );
    if (!canonical)
      throw new Error(
        `CHAIN_PROTOCOL_MISMATCH:${parsed.chainId}:${String(raw.protocol)}`,
      );
    if (
      raw.registryVersion !== 1 ||
      raw.chainId !== parsed.chainId ||
      raw.chainKey !== parsed.chainKey
    )
      throw new Error("DEPLOYMENT_RECORD_SCOPE_MISMATCH");
    const contracts = raw.contracts;
    if (!contracts || typeof contracts !== "object")
      throw new Error("DEPLOYMENT_CONTRACTS_MISSING");
    for (const [name, expected] of Object.entries(canonical.contracts)) {
      const actual = (contracts as Record<string, unknown>)[name];
      if (
        typeof actual !== "string" ||
        getAddress(actual).toLowerCase() !== expected?.toLowerCase()
      )
        throw new Error(
          `DEPLOYMENT_ADDRESS_MISMATCH:${String(raw.protocol)}:${name}`,
        );
    }
    return validateProtocolDeployment(canonical);
  });
  return Object.freeze({
    registryVersion: 1 as const,
    chainKey: parsed.chainKey,
    chainId: parsed.chainId!,
    deployments: Object.freeze(records),
  });
}

export type LegacyFeeQuote = {
  feeModel: "legacy";
  gasPrice: bigint;
  observedAtMs: number;
};
export type Eip1559FeeQuote = {
  feeModel: "eip1559";
  baseFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  observedAtMs: number;
};
export type ChainFeeQuote = LegacyFeeQuote | Eip1559FeeQuote;
export function legacyFeeQuote(input: {
  gasPrice: bigint;
  observedAtMs?: number;
  minimumGasPrice?: bigint;
  maximumGasPrice?: bigint;
}): LegacyFeeQuote {
  if (input.gasPrice <= 0n) throw new Error("FEE_GAS_PRICE_INVALID");
  if (
    input.minimumGasPrice !== undefined &&
    input.gasPrice < input.minimumGasPrice
  )
    throw new Error("FEE_GAS_PRICE_BELOW_NETWORK_MINIMUM");
  if (
    input.maximumGasPrice !== undefined &&
    input.gasPrice > input.maximumGasPrice
  )
    throw new Error("FEE_GAS_PRICE_ABOVE_POLICY_MAXIMUM");
  return {
    feeModel: "legacy",
    gasPrice: input.gasPrice,
    observedAtMs: input.observedAtMs ?? Date.now(),
  };
}
export function eip1559FeeQuote(input: {
  baseFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas?: bigint;
  observedAtMs?: number;
  maximumFeePerGas?: bigint;
}): Eip1559FeeQuote {
  if (input.baseFeePerGas <= 0n || input.maxPriorityFeePerGas <= 0n)
    throw new Error("FEE_EIP1559_PROVIDER_VALUES_INVALID");
  const maxFeePerGas =
    input.maxFeePerGas ?? input.baseFeePerGas * 2n + input.maxPriorityFeePerGas;
  if (maxFeePerGas < input.baseFeePerGas + input.maxPriorityFeePerGas)
    throw new Error("FEE_EIP1559_MAX_FEE_TOO_LOW");
  if (
    input.maximumFeePerGas !== undefined &&
    maxFeePerGas > input.maximumFeePerGas
  )
    throw new Error("FEE_EIP1559_POLICY_MAXIMUM_EXCEEDED");
  return {
    feeModel: "eip1559",
    baseFeePerGas: input.baseFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    maxFeePerGas,
    observedAtMs: input.observedAtMs ?? Date.now(),
  };
}
export function assertFreshFeeQuote(
  profile: ChainProfile,
  quote: ChainFeeQuote,
  input: { nowMs?: number; maxAgeMs: number; replacementOf?: ChainFeeQuote },
): ChainFeeQuote {
  if (profile.feeModel !== quote.feeModel)
    throw new Error("FEE_MODEL_CHAIN_MISMATCH");
  if ((input.nowMs ?? Date.now()) - quote.observedAtMs > input.maxAgeMs)
    throw new Error("FEE_QUOTE_STALE");
  if (input.replacementOf) {
    if (input.replacementOf.feeModel !== quote.feeModel)
      throw new Error("FEE_REPLACEMENT_MODEL_MISMATCH");
    if (
      quote.feeModel === "legacy" &&
      input.replacementOf.feeModel === "legacy" &&
      quote.gasPrice <= input.replacementOf.gasPrice
    )
      throw new Error("FEE_REPLACEMENT_NOT_HIGHER");
    if (
      quote.feeModel === "eip1559" &&
      input.replacementOf.feeModel === "eip1559" &&
      (quote.maxFeePerGas <= input.replacementOf.maxFeePerGas ||
        quote.maxPriorityFeePerGas < input.replacementOf.maxPriorityFeePerGas)
    )
      throw new Error("FEE_REPLACEMENT_NOT_HIGHER");
  }
  return quote;
}
export function actualGasEvidence(input: {
  chainId: number;
  nativeSymbol: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  projectedNative?: bigint;
  nativeUsd?: number;
}) {
  if (input.gasUsed < 0n || input.effectiveGasPrice < 0n)
    throw new Error("ACTUAL_GAS_INVALID");
  const actualNative = input.gasUsed * input.effectiveGasPrice,
    actualUsd =
      input.nativeUsd === undefined || !Number.isFinite(input.nativeUsd)
        ? undefined
        : (Number(actualNative) / 1e18) * input.nativeUsd;
  return {
    chainId: input.chainId,
    nativeSymbol: input.nativeSymbol,
    actualNative,
    actualUsd,
    projectionBreached:
      input.projectedNative !== undefined &&
      actualNative > input.projectedNative,
    valuationStatus: actualUsd === undefined ? "UNAVAILABLE" : "AVAILABLE",
  };
}

export function assertTransactionBoundary(input: {
  chainId: number;
  protocol: ProtocolKey;
  operation: ProtocolOperation;
  providerChainId: number;
  deploymentVersion: number;
  to: Address | string;
  feeQuote: ChainFeeQuote;
  feeMaxAgeMs: number;
  nowMs?: number;
  workflowChainId: number;
  journalChainId: number;
  signedTransactionChainId: number;
  expectedHash: string;
  observedHash: string;
  allowedValue: boolean;
}) {
  const profile = chainProfile(input.chainId),
    deployment = requireProtocolCapability(
      input.chainId,
      input.protocol,
      input.operation,
    );
  assertChainIdentity({
    requestedChainId: input.chainId,
    providerChainId: input.providerChainId,
    deploymentChainId: deployment.chainId,
    workflowChainId: input.workflowChainId,
    journalChainId: input.journalChainId,
    signedTransactionChainId: input.signedTransactionChainId,
  });
  if (input.deploymentVersion !== deployment.registryVersion)
    throw new Error("DEPLOYMENT_VERSION_CHANGED");
  if (
    !Object.values(deployment.contracts).some(
      (address) =>
        address?.toLowerCase() === getAddress(input.to).toLowerCase(),
    )
  )
    throw new Error("TRANSACTION_DESTINATION_NOT_IN_DEPLOYMENT");
  if (!input.allowedValue) throw new Error("TRANSACTION_VALUE_NOT_ALLOWED");
  if (input.expectedHash.toLowerCase() !== input.observedHash.toLowerCase())
    throw new Error("SIGNED_TRANSACTION_HASH_MISMATCH");
  assertFreshFeeQuote(profile, input.feeQuote, {
    nowMs: input.nowMs,
    maxAgeMs: input.feeMaxAgeMs,
  });
  return deployment;
}

export function orientChainQuote(input: {
  chainId: number;
  token0: Address | string;
  token1: Address | string;
  token0Decimals: number;
  token1Decimals: number;
  price1Per0: number;
  baseToken: Address | string;
  quoteToken: Address | string;
}) {
  const token0 = getAddress(input.token0),
    token1 = getAddress(input.token1),
    base = getAddress(input.baseToken),
    quoteToken = getAddress(input.quoteToken);
  if (
    !Number.isFinite(input.price1Per0) ||
    input.price1Per0 <= 0 ||
    ![input.token0Decimals, input.token1Decimals].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    )
  )
    throw new Error("CHAIN_QUOTE_INPUT_INVALID");
  const baseIs0 =
      base.toLowerCase() === token0.toLowerCase() &&
      quoteToken.toLowerCase() === token1.toLowerCase(),
    baseIs1 =
      base.toLowerCase() === token1.toLowerCase() &&
      quoteToken.toLowerCase() === token0.toLowerCase();
  if (!baseIs0 && !baseIs1) throw new Error("CHAIN_QUOTE_PAIR_MISMATCH");
  return {
    chainId: input.chainId,
    baseAssetKey: chainAssetKey(input.chainId, base),
    quoteAssetKey: chainAssetKey(input.chainId, quoteToken),
    quotePerBase: baseIs0 ? input.price1Per0 : 1 / input.price1Per0,
    orientation: baseIs0 ? "token1_per_token0" : "token0_per_token1",
  };
}
export function directStableValuation(input: {
  chainId: number;
  token: Address | string;
  amountRaw: bigint;
  decimals: number;
  stableQuote: Address | string;
  tokenPriceUsd: number;
  source: string;
  observedAtMs: number;
  nowMs?: number;
  maxAgeMs: number;
}) {
  const profile = chainProfile(input.chainId),
    stable = getAddress(input.stableQuote);
  if (
    !profile.quoteTokens.some(
      (item) =>
        item.stable && item.address.toLowerCase() === stable.toLowerCase(),
    )
  )
    throw new Error("STABLE_QUOTE_NOT_ALLOWED_FOR_CHAIN");
  if (
    !Number.isFinite(input.tokenPriceUsd) ||
    input.tokenPriceUsd <= 0 ||
    input.amountRaw < 0n
  )
    throw new Error("VALUATION_INPUT_INVALID");
  const ageMs = (input.nowMs ?? Date.now()) - input.observedAtMs;
  if (ageMs > input.maxAgeMs)
    return {
      status: "UNAVAILABLE" as const,
      reason: "PRICE_STALE",
      source: input.source,
      observedAtMs: input.observedAtMs,
      ageMs,
    };
  return {
    status: "AVAILABLE" as const,
    valueUsd:
      (Number(input.amountRaw) / 10 ** input.decimals) * input.tokenPriceUsd,
    source: input.source,
    observedAtMs: input.observedAtMs,
    ageMs,
  };
}
export function supplyDisplay(input: {
  totalSupplyRaw?: bigint;
  circulatingSupplyRaw?: bigint;
  decimals: number;
  priceUsd?: number;
}) {
  const unavailable = (reason: string) => ({
    status: "UNAVAILABLE" as const,
    reason,
  });
  if (input.totalSupplyRaw === undefined || input.priceUsd === undefined)
    return unavailable("TOTAL_SUPPLY_OR_PRICE_UNAVAILABLE");
  const fdv =
    (Number(input.totalSupplyRaw) / 10 ** input.decimals) * input.priceUsd;
  if (input.circulatingSupplyRaw === undefined)
    return {
      status: "PARTIAL" as const,
      fdvUsd: fdv,
      marketCap: unavailable("CIRCULATING_SUPPLY_UNAVAILABLE"),
    };
  return {
    status: "AVAILABLE" as const,
    fdvUsd: fdv,
    marketCapUsd:
      (Number(input.circulatingSupplyRaw) / 10 ** input.decimals) *
      input.priceUsd,
  };
}
