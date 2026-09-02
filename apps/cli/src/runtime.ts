import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, getAddress, http, type Address } from "viem";
import { z } from "zod";
import {
  erc20Abi,
  FallbackRpc,
  orderedRpcUrls,
  RH_MAINNET,
  robinhoodMainnet,
  sanitizeRpcError,
  type Availability,
  type VerifiedUniswapV3Deployments,
} from "@funi/core";
import { productionDatabasePaths, SqliteLedgerRepository } from "@funi/ledger";
import { maxGasCostUsdSchema, strictBooleanSchema } from "./execution-gates.js";
import { assertFuniCredentialIsolation } from "../../shared/credential-isolation.js";
import { resolveCanonicalFuniWallet } from "../../shared/funi-wallet.js";

assertFuniCredentialIsolation(process.env);
const bool = (key: string, fallback: boolean) =>
  strictBooleanSchema(key, fallback);
export const runtimeEnvSchema = z
  .object({
    RH_CHAIN_ID: z.coerce.number().default(RH_MAINNET),
    ALCHEMY_RPC_URL: z.string().url().optional(),
    ALCHEMY_RPC_URLS: z.string().optional(),
    RH_LOGS_RPC_URL: z
      .string()
      .url()
      .default("https://rpc.mainnet.chain.robinhood.com"),
    RH_RPC_URL: z
      .string()
      .url()
      .default("https://rpc.mainnet.chain.robinhood.com"),
    RH_RPC_FALLBACK_URL: z.string().url().optional(),
    DATA_DIR: z.string().optional(),
    DATABASE_PATH: z.string().optional(),
    BACKUP_RETENTION: z.coerce.number().int().min(1).max(365).default(7),
    EXECUTION_ENABLED: bool("EXECUTION_ENABLED", false),
    DRY_RUN: bool("DRY_RUN", true),
    EMERGENCY_PAUSE: bool("EMERGENCY_PAUSE", true),
    LIVE_CANARY_ENABLED: bool("LIVE_CANARY_ENABLED", false),
    V4_LIVE_CANARY_ENABLED: bool("V4_LIVE_CANARY_ENABLED", false),
    MAX_POSITION_VALUE_USD: z.coerce.number().positive().max(1_000_000).default(1_000),
    MAX_APPROVAL_VALUE_USD: z.coerce.number().positive().max(1_000_000).default(1_000),
    MAX_GAS_COST_USD: maxGasCostUsdSchema.default(0.7),
    MAX_LIFECYCLE_GAS_USD: z.coerce.number().positive().max(1).default(1),
    MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(50),
    APPROVAL_CAP_MULTIPLIER_BPS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(20_000)
      .default(10_050),
    LIVE_CANARY_MAX_OPEN_POSITIONS: z.coerce
      .number()
      .int()
      .min(1)
      .max(1)
      .default(1),
    GAS_USD_PER_NATIVE: z.coerce
      .number()
      .positive()
      .optional()
      .transform((value) => value ?? Number.NaN),
    V4_CANARY_MAX_TX_GAS_USD: z.coerce
      .number()
      .positive()
      .max(0.25)
      .default(0.25),
    V4_CANARY_TOTAL_GAS_BUDGET_USD: z.coerce
      .number()
      .positive()
      .max(1)
      .default(1),
    OPERATOR_WALLET: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
    WALLET_ADDRESS: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
    DEDICATED_WALLET_ADDRESS: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
    LP_PRIVATE_KEY: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .optional(),
    WALLET_POSITION_FROM_BLOCK: z.coerce.bigint().optional(),
    CONFIRMATION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(3600)
      .default(300),
    TELEGRAM_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3600)
      .default(600),
  })
  .superRefine((value, ctx) => {
    if (value.RH_CHAIN_ID !== RH_MAINNET)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `RH_CHAIN_ID must be ${RH_MAINNET}`,
      });
    try{resolveCanonicalFuniWallet(value);}catch(error){ctx.addIssue({code:z.ZodIssueCode.custom,message:error instanceof Error?error.message:String(error)});}
  });
export const runtimeEnv = runtimeEnvSchema.parse(process.env);
export type RuntimeEnv = typeof runtimeEnv;
export const runtimePaths = productionDatabasePaths({
  dataDir: runtimeEnv.DATA_DIR,
  databasePath: runtimeEnv.DATABASE_PATH,
});
const hasAlchemyRpc = Boolean(
    runtimeEnv.ALCHEMY_RPC_URLS || runtimeEnv.ALCHEMY_RPC_URL,
  ),
  rpcUrls = hasAlchemyRpc
    ? orderedRpcUrls(runtimeEnv.ALCHEMY_RPC_URLS, runtimeEnv.ALCHEMY_RPC_URL)
    : [runtimeEnv.RH_RPC_URL];
export const runtimeRpc = new FallbackRpc(
  { ...robinhoodMainnet, chainId: runtimeEnv.RH_CHAIN_ID, rpcUrls },
  rpcUrls,
  {
    timeoutMs: hasAlchemyRpc ? 2_000 : 12_000,
    onProviderEvent: (event) => console.log(JSON.stringify(event)),
  },
);
export const logsRpc = new FallbackRpc({
  ...robinhoodMainnet,
  chainId: runtimeEnv.RH_CHAIN_ID,
  rpcUrls: [runtimeEnv.RH_LOGS_RPC_URL],
});

/** Only an address is required for normal operation. A private key is never emitted or persisted. */
export function dedicatedWallet() {
  if (
    process.env.LP_MNEMONIC ||
    process.env.SEED_PHRASE ||
    process.env.MNEMONIC
  )
    throw new Error(
      "seed phrases are not supported; use address-only mode or LP_PRIVATE_KEY from protected environment configuration",
    );
  const signer = runtimeEnv.LP_PRIVATE_KEY
    ? privateKeyToAccount(runtimeEnv.LP_PRIVATE_KEY as `0x${string}`)
    : undefined;
  const address = resolveCanonicalFuniWallet(runtimeEnv,signer?.address);
  return {
    address,
    signerConfigured: Boolean(signer),
    mode: signer
      ? "protected-signer"
      : address
        ? "address-only"
        : "unconfigured",
  } as const;
}
/** Deliberately private to the guarded executor. Calling this is not a gate; the executor must prove every gate first. */
export function guardedWalletClient(providerIndex = 0) {
  if (!runtimeEnv.LP_PRIVATE_KEY)
    throw new Error("protected signer is not configured");
  const account = privateKeyToAccount(
      runtimeEnv.LP_PRIVATE_KEY as `0x${string}`,
    ),
    configured = dedicatedWallet().address;
  if (!configured || configured.toLowerCase() !== account.address.toLowerCase())
    throw new Error("configured wallet does not match protected signer");
  const writeUrl = rpcUrls[providerIndex];
  if (!writeUrl) throw new Error("CONFIGURED_WRITE_PROVIDER_UNAVAILABLE");
  return createWalletClient({
    account,
    chain: {
      id: RH_MAINNET,
      name: "Robinhood",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [writeUrl] } },
    },
    transport: http(writeUrl),
  });
}
function environmentSafetyPayload(repo?: SqliteLedgerRepository) {
  const prior = repo?.safetyState() ?? ({} as Record<string, unknown>);
  const payload = {
    chainId: runtimeEnv.RH_CHAIN_ID,
    executionEnabled: runtimeEnv.EXECUTION_ENABLED,
    dryRun: runtimeEnv.DRY_RUN,
    emergencyPause: runtimeEnv.EMERGENCY_PAUSE,
    liveCanaryEnabled: runtimeEnv.LIVE_CANARY_ENABLED,
    maxPositionValueUsd: runtimeEnv.MAX_POSITION_VALUE_USD,
    maxApprovalValueUsd: runtimeEnv.MAX_APPROVAL_VALUE_USD,
    maxGasCostUsd: runtimeEnv.MAX_GAS_COST_USD,
    maxSlippageBps: runtimeEnv.MAX_SLIPPAGE_BPS,
    manualPause: prior.manualPause === true,
    manualPauseActor:
      typeof prior.manualPauseActor === "string"
        ? prior.manualPauseActor
        : undefined,
    manualPauseReason:
      typeof prior.manualPauseReason === "string"
        ? prior.manualPauseReason
        : undefined,
    manualPauseAt:
      typeof prior.manualPauseAt === "string" ? prior.manualPauseAt : undefined,
    updatedAt: new Date().toISOString(),
  };
  return {
    ...payload,
    effectiveEmergencyPause: payload.emergencyPause || payload.manualPause,
  };
}
/** Durable operator safety is authoritative for readers. Environment-derived
 * values are constructed only for an explicit writer or when no repository is
 * supplied (for non-persistent preview code). */
export function safetyPayload(repo?: SqliteLedgerRepository) {
  return activeSafetyState(repo?.safetyState() ?? environmentSafetyPayload(repo));
}
function activeSafetyState<T extends Record<string, unknown>>(state: T) {
  const {
    maxBotManagedExposureUsd: _legacyMaximum,
    botManagedExposureCapStatus: _legacyStatus,
    ...active
  } = state;
  return active;
}
export type SafetyStateWriterRole =
  "AUTHORITATIVE_SAFETY_WRITER" | "READ_ONLY_SAFETY_CONSUMER";
/** Read-only processes must never turn their process-local gates into shared
 * operator policy. Missing durable evidence is reported as fail-safe, without
 * creating a row that could later look authoritative. */
export function initializeSafety(
  repo: SqliteLedgerRepository,
  role: SafetyStateWriterRole = "READ_ONLY_SAFETY_CONSUMER",
) {
  if (role === "READ_ONLY_SAFETY_CONSUMER") {
    const durable = repo.safetyState();
    return (
      durable ? activeSafetyState(durable) : {
        ...environmentSafetyPayload(),
        executionEnabled: false,
        dryRun: true,
        emergencyPause: true,
        effectiveEmergencyPause: true,
        safetyEvidence: "AUTHORITATIVE_SAFETY_STATE_MISSING_FAILSAFE",
      }
    );
  }
  const payload = environmentSafetyPayload(repo);
  repo.persistSafetyState(payload);
  repo.recoverConfirmations();
  return payload;
}
export async function walletStatus(rpc = runtimeRpc): Promise<any> {
  const wallet = dedicatedWallet();
  if (!wallet.address)
    return {
      status: "WALLET_ADDRESS_REQUIRED",
      wallet: { mode: wallet.mode, signerConfigured: false },
    };
  const address = wallet.address as Address;
  try {
    return await rpc.withClient(
      async (client) => {
        const [chainId, eth, weth, usdg, nonce] = await Promise.all([
          client.getChainId(),
          client.getBalance({ address }),
          client.readContract({
            address: robinhoodMainnet.assets.WETH,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          }),
          client.readContract({
            address: robinhoodMainnet.assets.USDG,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          }),
          client.getTransactionCount({ address, blockTag: "pending" }),
        ]);
        return {
          status: chainId === RH_MAINNET ? "READY" : "WRONG_CHAIN",
          chainId,
          wallet: {
            address,
            mode: wallet.mode,
            signerConfigured: wallet.signerConfigured,
          },
          balances: {
            ETH: { raw: eth, decimals: 18 },
            WETH: { raw: weth, decimals: 18 },
            USDG: { raw: usdg, decimals: 6 },
          },
          nonce,
        };
      },
      { stage: "wallet_preflight", method: "eth_call" },
    );
  } catch (error) {
    return {
      status: "RPC_UNAVAILABLE",
      wallet: {
        address,
        mode: wallet.mode,
        signerConfigured: wallet.signerConfigured,
      },
      reason: sanitizeRpcError(error, {
        stage: "wallet_preflight",
        method: "eth_call",
      }),
    };
  }
}
export async function allowanceAudit(
  deployments: Availability<VerifiedUniswapV3Deployments>,
  rpc = runtimeRpc,
): Promise<any> {
  const base = await walletStatus(rpc);
  if (
    base.status === "WALLET_ADDRESS_REQUIRED" ||
    base.status === "RPC_UNAVAILABLE" ||
    base.status === "WRONG_CHAIN"
  )
    return base;
  if (deployments.status === "unavailable")
    return {
      status: "PROTOCOL_VERIFICATION_REQUIRED",
      reason: deployments.reason,
      wallet: base.wallet,
    };
  const wallet = base.wallet.address as Address;
  return rpc.withClient(async (client) => {
    const spenders = {
      positionManager: deployments.value.positionManager,
      swapRouter: deployments.value.swapRouter,
    };
    const records = await Promise.all(
      Object.entries({
        WETH: robinhoodMainnet.assets.WETH,
        USDG: robinhoodMainnet.assets.USDG,
      }).flatMap(([symbol, token]) =>
        Object.entries(spenders).map(async ([spenderName, spender]) => ({
          symbol,
          token,
          spenderName,
          spender,
          allowance: await client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [wallet, spender],
          }),
        })),
      ),
    );
    return {
      status: "READY",
      wallet: base.wallet,
      spenders,
      allowances: records,
    };
  });
}
export type FundingReadinessInput = {
  fundingSymbol: string;
  fundingBalance: bigint;
  fundingAmount: bigint;
  currentAllowance: bigint;
  nativeBalance: bigint;
  combinedGasEstimate?: bigint;
  gasPriceWei?: bigint;
  nativeUsd?: number;
  maxGasUsd: number;
};
export function evaluateIntentFundingReadiness(input: FundingReadinessInput) {
  const approvalRequired = input.currentAllowance < input.fundingAmount,
    requiredNative =
      input.combinedGasEstimate !== undefined && input.gasPriceWei !== undefined
        ? input.combinedGasEstimate * input.gasPriceWei
        : undefined,
    estimatedGasUsd =
      requiredNative !== undefined && input.nativeUsd !== undefined
        ? (Number(requiredNative) / 1e18) * input.nativeUsd
        : undefined,
    readyStatus =
      input.fundingSymbol.toUpperCase() === "USDG"
        ? "READY_FOR_USDG_ONLY_CANARY"
        : input.fundingSymbol.toUpperCase() === "WETH"
          ? "READY_FOR_WETH_ONLY_CANARY"
          : "READY_FOR_FUNDING_ONLY_CANARY";
  if (input.fundingBalance < input.fundingAmount)
    return {
      status: "FUNDING_ASSET_BALANCE_INSUFFICIENT" as const,
      approvalStatus: approvalRequired
        ? ("APPROVAL_REQUIRED" as const)
        : ("ALLOWANCE_SUFFICIENT" as const),
      requiredNative,
      estimatedGasUsd,
    };
  if (requiredNative !== undefined && input.nativeBalance < requiredNative)
    return {
      status: "GAS_BALANCE_INSUFFICIENT" as const,
      approvalStatus: approvalRequired
        ? ("APPROVAL_REQUIRED" as const)
        : ("ALLOWANCE_SUFFICIENT" as const),
      requiredNative,
      estimatedGasUsd,
    };
  if (estimatedGasUsd !== undefined && estimatedGasUsd > input.maxGasUsd)
    return {
      status: "GAS_CAP_TOO_LOW" as const,
      approvalStatus: approvalRequired
        ? ("APPROVAL_REQUIRED" as const)
        : ("ALLOWANCE_SUFFICIENT" as const),
      requiredNative,
      estimatedGasUsd,
    };
  return {
    status: readyStatus,
    approvalStatus: approvalRequired
      ? ("APPROVAL_REQUIRED" as const)
      : ("ALLOWANCE_SUFFICIENT" as const),
    requiredNative,
    estimatedGasUsd,
  };
}
export type StrategyPreflightIntent = {
  targetToken: Address;
  fundingToken: Address;
  fundingSymbol: string;
  fundingAmount: bigint;
  pool: Address;
  protocolVersion: "v3";
  combinedGasEstimate?: bigint;
  gasPriceWei?: bigint;
  nativeUsd?: number;
};
export async function walletPreflight(
  deployments: Availability<VerifiedUniswapV3Deployments>,
  repo?: SqliteLedgerRepository,
  rpc = runtimeRpc,
  intent?: StrategyPreflightIntent,
): Promise<any> {
  const base = await walletStatus(rpc);
  const safety = safetyPayload(repo);
  if (
    base.status === "WALLET_ADDRESS_REQUIRED" ||
    base.status === "RPC_UNAVAILABLE" ||
    base.status === "WRONG_CHAIN"
  )
    return { ...base, safety };
  if (deployments.status === "unavailable")
    return {
      status: "PROTOCOL_VERIFICATION_REQUIRED",
      reason: deployments.reason,
      wallet: base.wallet,
      safety,
      balances: base.balances,
      nonce: base.nonce,
    };
  if (!intent)
    return {
      status:
        base.balances.ETH.raw === 0n ? "GAS_BALANCE_INSUFFICIENT" : "READY",
      wallet: base.wallet,
      chainId: base.chainId,
      balances: base.balances,
      nonce: base.nonce,
      fundingReadiness: "SELECTED_INTENT_REQUIRED",
      safety,
    };
  const wallet = base.wallet.address as Address;
  return rpc.withClient(async (client) => {
    const [fundingBalance, currentAllowance, nativeBalance, gasPriceWei] =
        await Promise.all([
          client.readContract({
            address: intent.fundingToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [wallet],
          }),
          client.readContract({
            address: intent.fundingToken,
            abi: erc20Abi,
            functionName: "allowance",
            args: [wallet, deployments.value.positionManager],
          }),
          client.getBalance({ address: wallet }),
          intent.gasPriceWei ?? client.getGasPrice(),
        ]),
      readiness = evaluateIntentFundingReadiness({
        fundingSymbol: intent.fundingSymbol,
        fundingBalance,
        fundingAmount: intent.fundingAmount,
        currentAllowance,
        nativeBalance,
        combinedGasEstimate: intent.combinedGasEstimate,
        gasPriceWei,
        nativeUsd: intent.nativeUsd,
        maxGasUsd: runtimeEnv.MAX_GAS_COST_USD,
      });
    return {
      ...readiness,
      wallet: base.wallet,
      chainId: base.chainId,
      protocolVersion: intent.protocolVersion,
      pool: intent.pool,
      targetToken: intent.targetToken,
      fundingToken: intent.fundingToken,
      fundingAmount: intent.fundingAmount,
      fundingBalance,
      currentAllowance,
      requiredAllowance: intent.fundingAmount,
      nativeBalance,
      combinedGasEstimate: intent.combinedGasEstimate,
      gasPriceWei,
      maxGasUsd: runtimeEnv.MAX_GAS_COST_USD,
      targetBalanceRequired: false,
      existingAllowanceRequired: false,
      safety,
    };
  });
}
export type StaticCanaryWiring = {
  executionEnabled: boolean;
  dryRun: boolean;
  emergencyPause: boolean;
  liveCanaryEnabled: boolean;
  signerConfigured: boolean;
  operatorConfigured: boolean;
  chainId: number;
  deploymentVerified: boolean;
};
export function staticCanaryReachability(input: StaticCanaryWiring) {
  const reason = !input.executionEnabled
    ? "EXECUTION_ENABLED is false"
    : input.dryRun
      ? "DRY_RUN is true"
      : input.emergencyPause
        ? "EMERGENCY_PAUSE is true"
        : !input.liveCanaryEnabled
          ? "LIVE_CANARY_ENABLED is false"
          : !input.signerConfigured
            ? "protected signer is not configured"
            : !input.operatorConfigured
              ? "allowlisted Telegram operator is not configured"
              : input.chainId !== 4663
                ? "chain ID is not 4663"
                : !input.deploymentVerified
                  ? "verified deployment registry unavailable"
                  : undefined;
  return {
    executionReachable: reason === undefined,
    reason,
    executor: "executeGuardedSingleSidedCanary" as const,
  };
}
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => {
        if (/private|secret|seed|mnemonic/i.test(key))
          return [key, "[REDACTED]"];
        return [key, redactSecrets(item)];
      },
    );
    return Object.fromEntries(entries);
  }
  return value;
}
