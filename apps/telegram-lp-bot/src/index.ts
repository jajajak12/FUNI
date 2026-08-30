import "./load-env.js";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { getAddress, type Address } from "viem";
import {
  auditRobinhoodV3Deployments,
  discoverV3Pools,
  erc20Abi,
  inspectErc20,
  inspectV3Pool,
  inspectV3Position,
  priceFromSqrtX96,
  robinhoodMainnet,
  sanitizeSensitiveText,
  simulateUnclaimedFees,
  walletV3Positions,
} from "@funi/core";
import {
  allowanceSimulationState,
  balancedRangeQuote,
  buildApproval,
  buildCollect,
  buildDecrease,
  buildMint,
  explainMintSimulationFailure,
  presentPool,
  presentPosition,
  rangeFromPercent,
  resolveSingleSidedRoles,
  singleSidedDownsideQuote,
  downsideFromCurrent,
  validateDownsidePercentages,
  simulateApproval,
  simulateBuiltTransaction,
} from "@funi/v3";
import {
  markToMarket,
  nowMs,
  sqliteTransientCode,
  SQLITE_RUNTIME_BUSY_TIMEOUT_MS,
  SqliteLedgerRepository,
  type TelegramFlowCASResult,
  type TelegramFlowSession,
} from "@funi/ledger";
import {
  dedicatedWallet,
  guardedWalletClient,
  initializeSafety,
  logsRpc,
  runtimeEnv as env,
  runtimePaths,
  runtimeRpc as rpc,
  safetyPayload,
  staticCanaryReachability,
  walletPreflight,
  walletStatus,
} from "../../cli/src/runtime.js";
import {
  evaluateCanaryGates,
  executeConfirmedCanaryRoute,
  executeDirectAmountCanary,
  executePreparedCanaryRoute,
  validateBoundPool,
} from "../../cli/src/live-canary-route.js";
import { nativeUsdPrice } from "../../cli/src/live-canary-route-preflight.js";
import {
  auditRobinhoodV4Deployments,
  inspectV4ClaimableFeesBatch,
  inspectV4Pool,
  inspectV4PositionState,
  poolId,
  sqrtPriceAtTick,
  validateV4DownsideRange,
  type V4PoolKey,
  type V4PoolState,
} from "@funi/v4";
import {
  evaluateCanonicalExecutionGates,
  readCanonicalExecutionGates,
} from "../../cli/src/execution-gates.js";
import {
  confirmV4TelegramManagement,
  prepareV4TelegramManagement,
} from "../../cli/src/v4-telegram-management.js";
import { executeV4LiveCanaryClose } from "../../cli/src/v4-live-canary.js";
import {
  executeV4OperationalOpen,
  prepareV4OperationalPreviewContext,
  prewarmV4OperationalPreviewStaticVerification,
  v4OperationalOpenPreflight,
} from "../../cli/src/v4-operational-executor.js";
import { v4PositionInspect } from "../../cli/src/v4-cli.js";
import { cachedV4PoolsForToken } from "../../cli/src/v4-registry.js";
import {
  fetchDexScreenerV4Liquidity,
  formatDexScreenerV4Liquidity,
  rankTelegramV4ByDexLiquidity,
  type DexScreenerV4Liquidity,
} from "./dexscreener-v4-liquidity.js";
import { needsDirectLookupAcceleration } from "./direct-lookup-acceleration.js";
import { periodPnlPresentation, renderFuniPnlCard, wibPeriodWindow, type FuniPeriodKind } from "./pnl-card.js";
import {
  createV4BidLadderDryRun,
  createV4BidLadderLive,
  calculateOpenV4BidLadderPerformance,
  displayV4BidLadderMarketCapEvidence,
  formatPersistedV4BidLadder,
  formatV4BidLadderPreview,
  previewV4BidLadder,
  restoreV4BidLadderPreview,
  snapshotV4BidLadderPreview,
  type V4BidLadderPreviewSnapshot,
} from "../../cli/src/v4-bid-ladder-operator.js";
import {
  fetchCanonicalGmgnEntryPrice,
  formatLpEntryPriceGuard,
  freshLpEntryPriceGuard,
  orientPoolPriceFundingPerTarget,
  priceGuardCooldown,
  type LpEntryPriceGuardResult,
} from "../../cli/src/lp-entry-price-guard.js";
import { gmgnCliJson, normalizeGmgnObservation } from "../../shared/gmgn-market.js";
import {
  confirmedV4BidLadderOpenTruth,
  executeV4BidLadderLiveOpen,
  executeV4BidLadderManualClose,
  executeV4BidLadderCollect,
  prepareV4BidLadderFundingAllowance,
  formatV4BidLadderCollectPreview,
  formatV4BidLadderClosePreview,
  formatV4BidLadderLivePreview,
  previewV4BidLadderClose,
  previewV4BidLadderCollect,
  previewV4BidLadderLive,
  v4BidLadderNativeUsd,
  v4BidLadderFundingAllowanceReadiness,
  type LadderLiveContext,
} from "../../cli/src/v4-bid-ladder-live.js";
import { durableTransactionReconciliationPending } from "../../cli/src/transaction-boundary.js";
import { runEconomicReconciliationCycle } from "../../cli/src/economic-reconciliation-cycle.js";
import {
  canResolveV4BidLadderPool,
  returnToV4SelectedPool,
  selectV4Strategy,
  selectV4BidLadderDepth,
} from "./bid-ladder-flow.js";
import { v4BidLadderGeometry } from "../../cli/src/v4-bid-ladder-planner.js";
import {
  amountPrompt,
  assertAmountWithinBalance,
  assertCanaryValue,
  formatHumanAmount,
  isEvmAddressText,
  pairedAmountMessage,
  parseAmountMessage,
  parseHumanAmount,
  routeTelegramText,
  tokenLabel,
  type DisplayToken,
} from "./amount-ux.js";
import {
  parseV4CustomRange,
  parseV4RangeChoice,
  v4RangeButtons,
  buildV4RangePricing,
  formatV4RangePricing,
  orientedTokenPrice,
  readTrustedMarketMetric,
  type V4RangeSelectionQuote,
} from "./v4-range-ux.js";
import { v4AmountRangeSelection } from "./range-callbacks.js";
import { isSqliteBusy, retrySqliteBusySync } from "./sqlite-busy.js";
import { initializeTelegramRuntime } from "./startup.js";
import { safeTelegramError, safeTelegramOperation } from "./telegram-error.js";
import { bidLadderCallback, TelegramCallbackDataOverflowError, telegramCallbackData } from "./callback-data.js";
import {
  compactLabel,
  directLookupAcknowledgementText,
  directLookupTerminalEvidenceText,
  poolListingPage,
  poolListingSummary,
  rankPoolListing,
  unavailablePoolListingPage,
  unavailablePoolListingItems,
  v4PoolSelectionLabel,
  type DirectLookupEvidenceSummary,
  type PoolListing,
  type PoolListingItem,
} from "./pool-selection-ux.js";
import {
  authorizeTelegramInbound,
  telegramMessageShape,
  telegramUpdateKind,
} from "./group-silent.js";
import {
  buildPortfolioAudit,
  trustedV4WethUsdReference,
  trustedWethUsdReference,
  type OptionalUsd,
  type PortfolioPosition,
} from "../../cli/src/portfolio.js";
import { FUNI_COMMAND_MENU, HELP_TEXT, START_TEXT } from "./command-menu.js";
import { registerMultichainUx } from "./multichain-ux.js";
import {
  aggregateFuniOpenLifecyclePnl,
  displayEquity,
  displayLifecycle,
  displayUnclaimedFees,
  formatPortfolioSnapshot,
  marketRangeLines,
  persistedPositionCard,
  persistedPositionDetail,
  persistedPositionDisplayCard,
  persistedPositionDisplayItems,
  persistedPositionDisplaySummary,
  bidLadderRepositionActionState,
  persistedPositionSummary,
  persistedPositionTechnicalDetails,
  persistedPositionViews,
  type PersistedPositionDisplayItem,
} from "./persisted-portfolio.js";
import {
  assertFuniTelegramCredentials,
  installFuniBotSenderTelemetry,
  sendFuniPhoto,
  sendFuniMessage,
} from "./telegram-sender.js";
import { drainClosePnlCardDeliveries } from "./pnl-card-delivery.js";
import {
  formatV4BidLadderUsdResetPreview,
  previewV4BidLadderUsdReset,
  processV4BidLadderUsdReset,
  cancelV4BidLadderRepositionPreClose,
  stopV4BidLadderReplacementOpen,
  readV4BidLadderUsdResetTruth,
  runV4BidLadderUsdResetCycle,
  validateV4BidLadderRepositionPreviewEvidence,
} from "../../cli/src/v4-bid-ladder-usdg-reset.js";
import {
  confirmAdoptionBaseline,
  createAdoptionBaselineConfirmation,
  enqueueWalletPositionSync,
  positionAdoption,
  setAdoptedFundingAsset,
} from "../../cli/src/position-adoption.js";
import {
  acquireRpcReadLease,
  enqueuePortfolioRefresh,
  persistedPortfolioSnapshot,
  reconcileActivePositions,
  releaseRpcReadLease,
} from "../../cli/src/active-position-reconciliation.js";
import {
  attachDirectLookupSubscriber,
  applyDirectLookupCandidatePresentation,
  completeDirectLookupOutbox,
  createOrReuseDirectLookup,
  expireDueDirectTokenLookups,
  leaseDirectLookupOutbox,
  retryDirectLookupOutbox,
  saveDirectLookupOutboxRender,
} from "../../cli/src/direct-token-lookup.js";
import { attributedRpc } from "../../cli/src/rpc-attribution.js";
const { token } = assertFuniTelegramCredentials();
const allowed = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);
type BidLadderInteractiveWork = { updateId:string; generation:number; progressMessageId?:number; promise?:Promise<unknown> };
const bidLadderDirectLiveInFlight = new Map<string, BidLadderInteractiveWork>();
const bidLadderLiveOpenInFlight = new Map<string, Promise<unknown>>();
if (!allowed.size)
  throw new Error(
    "TELEGRAM_ALLOWED_USER_IDS must contain the single operator user ID",
  );
if (allowed.size !== 1)
  throw new Error(
    "TELEGRAM_ALLOWED_USER_IDS must contain exactly one operator user ID",
  );
const operatorUserId = [...allowed][0]!;
const operatorPrivateChatId = String(
  process.env.FUNI_TELEGRAM_CHAT_ID ?? "",
).trim();
if (!operatorPrivateChatId)
  throw new Error("FUNI_TELEGRAM_CHAT_ID is required");
const bot = new Bot(token);
installFuniBotSenderTelemetry(bot);
const log = (event: string, data: Record<string, unknown> = {}) =>
  process.stdout.write(
    JSON.stringify(
      {
        level: "info",
        event,
        ...data,
        at: new Date().toISOString(),
      },
      (_, value) =>
        typeof value === "bigint"
          ? value.toString()
          : typeof value === "string"
            ? sanitizeSensitiveText(value)
            : value,
    ) + "\n",
  );
let v4PreviewStaticPrewarmInitiated = false;
const repo = () =>
  new SqliteLedgerRepository(runtimePaths.databasePath, {
    busyTimeoutMs: SQLITE_RUNTIME_BUSY_TIMEOUT_MS,
  });
function startRuntime() {
  const result = initializeTelegramRuntime({
    databasePath: runtimePaths.databasePath,
    log,
  });
  if (result.status === "READY") {
    log("telegram_session_recovery", {
      expired: result.expired,
      retryableOperationalOpenIntents: result.retryableOperationalOpenIntents,
      mainnetTransactionsSent: 0,
    });
  } else
    log("telegram_startup_deferred", { ...result, mainnetTransactionsSent: 0 });
  return result;
}
const audit = () => auditRobinhoodV3Deployments(rpc);
const owner = (ctx: { from?: { id: number } }) => String(ctx.from?.id ?? "");
const chat = (ctx: { chat?: { id: number } }) => String(ctx.chat?.id ?? "");
const sessionTtlMs = env.TELEGRAM_SESSION_TTL_SECONDS * 1000;
const reduced = (value: string) =>
  value.length <= 4 ? "…" : `…${value.slice(-4)}`;
function registryMatchesV4Key(
  row: Record<string, unknown>,
  key: V4PoolKey,
  id: string,
) {
  return (
    poolId(key).toLowerCase() === id.toLowerCase() &&
    key.currency0.toLowerCase() === String(row.currency0).toLowerCase() &&
    key.currency1.toLowerCase() === String(row.currency1).toLowerCase() &&
    key.fee === Number(row.initialize_fee_raw) &&
    key.tickSpacing === Number(row.tick_spacing) &&
    key.hooks.toLowerCase() === String(row.hooks).toLowerCase()
  );
}
function exactV4PoolState(state: V4PoolState, key: V4PoolKey, id: string) {
  return state.id.toLowerCase() === id.toLowerCase() &&
    poolId(state.key).toLowerCase() === id.toLowerCase() &&
    state.key.currency0.toLowerCase() === key.currency0.toLowerCase() &&
    state.key.currency1.toLowerCase() === key.currency1.toLowerCase() &&
    state.key.fee === key.fee && state.key.tickSpacing === key.tickSpacing &&
    state.key.hooks.toLowerCase() === key.hooks.toLowerCase() && state.blockNumber >= 0n;
}
function transitionLog(
  flow: TelegramFlowSession,
  previous: string | undefined,
  next: string,
  reason: string,
) {
  log("telegram_session_transition", {
    sessionId: flow.sessionId,
    user: reduced(flow.userId),
    chat: reduced(flow.chatId),
    previousState: previous,
    nextState: next,
    flowRevision: flow.flowRevision,
    now: nowMs(),
    updatedAt: flow.updatedAtMs,
    expiresAt: flow.expiresAtMs,
    remainingTtlMs: flow.expiresAtMs - nowMs(),
    reason,
  });
}
function flowCasLog(
  source: string,
  flow: TelegramFlowSession,
  requestedNextKind: string,
  result: TelegramFlowCASResult,
  extra: Record<string, unknown> = {},
) {
  log("telegram_flow_cas", {
    sessionId: flow.sessionId,
    source,
    expectedRevision: flow.flowRevision,
    observedRevision: result.observedRevision ?? null,
    resultingRevision: result.resultingRevision ?? null,
    previousKind: String(flow.state.kind ?? "unknown"),
    requestedNextKind,
    result: result.result,
    ...extra,
  });
}
function telegramFlowWrite<T>(
  operation: string,
  write: (db: SqliteLedgerRepository) => T,
) {
  return retrySqliteBusySync({
    operation,
    log,
    run: () => {
      const db = repo();
      try {
        return write(db);
      } finally {
        db.close();
      }
    },
  });
}
function newFlow(ctx: any, state: Record<string, unknown>) {
  const flow = telegramFlowWrite("createTelegramFlow", (db) =>
    db.createTelegramFlow({
      userId: owner(ctx),
      chatId: chat(ctx),
      state,
      now: nowMs(),
      ttlMs: sessionTtlMs,
    }),
  );
  transitionLog(flow, undefined, String(state.kind), "created");
  return flow;
}
function supersededFlowMessageIds(flow:TelegramFlowSession){const ids=new Set<number>(),stored=Array.isArray(flow.state.interactiveMessageIds)?flow.state.interactiveMessageIds:[];for(const value of stored){const id=Number(value);if(Number.isSafeInteger(id)&&id>0)ids.add(id);}const db=repo();try{const rows=db.db.prepare('SELECT message_id FROM direct_token_lookup_subscribers WHERE session_id=? AND chat_id=?').all(flow.sessionId,flow.chatId) as Array<{message_id:number}>;for(const row of rows)if(Number.isSafeInteger(row.message_id)&&row.message_id>0)ids.add(row.message_id);}finally{db.close();}return [...ids];}
function retireSupersededFlowUi(ctx:any,flow:TelegramFlowSession){const messageIds=supersededFlowMessageIds(flow);if(!messageIds.length)return;const started=Date.now(),retirement=Promise.allSettled(messageIds.map(messageId=>bot.api.editMessageReplyMarkup(Number(flow.chatId),messageId,{reply_markup:{inline_keyboard:[]}})));void Promise.race([retirement,sleep(1_500).then(()=>{throw new Error('TELEGRAM_FLOW_UI_RETIRE_TIMEOUT');})]).then(results=>log('telegram_superseded_flow_ui_retired',{sessionId:flow.sessionId,messageIds,retired:Array.isArray(results)?results.filter(result=>result.status==='fulfilled').length:0,elapsedMs:Date.now()-started})).catch(error=>log('telegram_superseded_flow_ui_retire_failed',{sessionId:flow.sessionId,messageIds,error:textError(error),elapsedMs:Date.now()-started,backendStaleRejectionAuthoritative:true}));}
function newTokenFlow(ctx:any,state:Record<string,unknown>,previous?:TelegramFlowSession){const flow=newFlow(ctx,state);if(previous?.status==='active'&&previous.sessionId!==flow.sessionId)retireSupersededFlowUi(ctx,previous);return flow;}
function bindInteractiveFlowMessage(ctx:any,flow:TelegramFlowSession,messageId:number,state:Record<string,unknown>=flow.state){const ids=[...new Set([...(Array.isArray(state.interactiveMessageIds)?state.interactiveMessageIds.map(Number):[]),messageId])];return advanceFlow(ctx,flow,{...state,interactiveMessageIds:ids},'interactive message bound')??flow;}
function loadFlow(ctx: any, sessionId?: string) {
  const db = repo();
  try {
    return sessionId
      ? db.telegramFlow({
          userId: owner(ctx),
          chatId: chat(ctx),
          sessionId,
          now: nowMs(),
        })
      : db.activeTelegramFlow({
          userId: owner(ctx),
          chatId: chat(ctx),
          now: nowMs(),
        });
  } finally {
    db.close();
  }
}
function loadLatestFlow(ctx: any) {
  const db = repo();
  try {
    return db.telegramFlow({
      userId: owner(ctx),
      chatId: chat(ctx),
      now: nowMs(),
    });
  } finally {
    db.close();
  }
}
function advanceFlow(
  ctx: any,
  flow: TelegramFlowSession,
  state: Record<string, unknown>,
  reason: string,
) {
  const result = telegramFlowWrite("transitionTelegramFlowCAS", (db) =>
    db.transitionTelegramFlowCAS({
      userId: owner(ctx),
      chatId: chat(ctx),
      sessionId: flow.sessionId,
      expectedRevision: flow.flowRevision,
      expectedStatus: "active",
      nextState: state,
      now: nowMs(),
      ttlMs: sessionTtlMs,
    }),
  );
  flowCasLog(reason, flow, String(state.kind), result);
  if (result.result === "APPLIED" && result.flow) {
    transitionLog(result.flow, String(flow.state.kind), String(state.kind), reason);
    return result.flow;
  }
  return undefined;
}
function cancelFlow(ctx: any, sessionId?: string) {
  if (sessionId) {
    const outcome = telegramFlowWrite("cancelTelegramFlowCAS", (db) => {
      const flow = db.telegramFlow({
        userId: owner(ctx),
        chatId: chat(ctx),
        sessionId,
        now: nowMs(),
      });
      if (!flow) return undefined;
      const result = db.cancelTelegramFlow({
        userId: owner(ctx),
        chatId: chat(ctx),
        sessionId,
        expectedRevision: flow.flowRevision,
        state: flow.state,
        now: nowMs(),
      });
      return { flow, result };
    });
    if (outcome) {
      flowCasLog("cancel", outcome.flow, String(outcome.flow.state.kind), outcome.result);
      const cancelled = outcome.result.result === "APPLIED";
      log("telegram_flow_cancelled", {
        sessionId,
        user: reduced(owner(ctx)),
        chat: reduced(chat(ctx)),
        cancelled,
      });
      return cancelled;
    }
    return false;
  }
  const flow = telegramFlowWrite("createTelegramFlow", (db) => db.createTelegramFlow({
      userId: owner(ctx),
      chatId: chat(ctx),
      state: { kind: "token_entry" },
      now: nowMs(),
      ttlMs: sessionTtlMs,
    }));
    transitionLog(flow, undefined, "token_entry", "start over");
    log("telegram_flow_start_over", {
      sessionId: flow.sessionId,
      user: reduced(owner(ctx)),
      chat: reduced(chat(ctx)),
      expiresAt: flow.expiresAtMs,
    });
    return true;
}
function flowControls(flow: TelegramFlowSession) {
  return [
    { label: "Back", data: `back:${flow.sessionId}` },
    { label: "Cancel", data: `cancel-flow:${flow.sessionId}` },
    { label: "Start over", data: "start-over" },
  ];
}
function v4SelectedPoolRows(flow: TelegramFlowSession, selectionId: string) {
  return [
    [
      {
        label: "🪜 Bid Ladder",
        data: `v4-strategy:${selectionId}:BID_LADDER`,
      },
      { label: "🎯 Spot", data: `v4-strategy:${selectionId}:SPOT` },
    ],
    [{ label: "Technical details", data: `v4-pool-technical:${selectionId}` }],
    flowControls(flow),
  ];
}
function poolCooldownUntil(flow: TelegramFlowSession, poolIdentity: string) {
  const values = flow.state.entryPriceCooldowns as
      Record<string, unknown> | undefined,
    value = Number(values?.[poolIdentity.toLowerCase()] ?? 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
function recordPoolPriceMismatch(
  ctx: any,
  flow: TelegramFlowSession,
  poolIdentity: string,
  result: LpEntryPriceGuardResult,
) {
  const cooldown = priceGuardCooldown({
      nowMs: nowMs(),
      blocked: true,
      existingUntilMs: poolCooldownUntil(flow, poolIdentity),
    }),
    next = advanceFlow(
      ctx,
      flow,
      {
        ...flow.state,
        entryPriceCooldowns: {
          ...(flow.state.entryPriceCooldowns as
            Record<string, unknown> | undefined),
          [poolIdentity.toLowerCase()]: cooldown.untilMs,
        },
      },
      "LP entry price mismatch cooldown",
    );
  return ctx.reply(
    `${formatLpEntryPriceGuard(result)}\nCooldown: ${Math.ceil(cooldown.remainingMs / 1000)}s`,
    { reply_markup: keyboard([flowControls(next ?? flow)]) },
  );
}
function rejectActivePoolCooldown(
  ctx: any,
  flow: TelegramFlowSession,
  poolIdentity: string,
) {
  const cooldown = priceGuardCooldown({
    nowMs: nowMs(),
    blocked: false,
    existingUntilMs: poolCooldownUntil(flow, poolIdentity),
  });
  return cooldown.allowed
    ? null
    : ctx.reply(
        `PRICE_RECHECK_COOLDOWN\nRetry available in ${Math.ceil(cooldown.remainingMs / 1000)}s.`,
      );
}
async function unavailableFlow(
  ctx: any,
  reason: "expired" | "stale" | "missing",
) {
  const text =
    reason === "expired"
      ? "This old selection has expired. Start a new flow."
      : reason === "stale"
        ? "This button belongs to an older selection."
        : "No active selection.";
  return ctx.reply(text, {
    reply_markup: keyboard([
      [{ label: "Start over", data: "start-over" }],
      [{ label: "Cancel", data: "cancel-flow" }],
    ]),
  });
}
const textError = (error: unknown) =>
  error instanceof Error
    ? sanitizeSensitiveText(error.message)
    : "unexpected read-only preview error";
function durableReconciliationPendingText(error: unknown, title: string, workflowId?: string) {
  const pending = durableTransactionReconciliationPending(error);
  if (!pending) return undefined;
  return [
    title,
    "Transaction status is being reconciled.",
    "Do not retry this transaction.",
    "Wallet transaction pending — avoid sending another wallet transaction while FUNI is reconciling.",
    "If immediate risk reduction is necessary, you may act manually. FUNI will reconcile from canonical on-chain truth afterward.",
    "FUNI will recover the position automatically if the transaction landed.",
    `Workflow: ${workflowId ?? pending.workflowId}`,
    `Expected tx: ${pending.expectedHash}`,
    `Nonce: ${pending.nonce}`,
  ].join("\n");
}
const amount = (value: bigint, decimals: number) =>
  formatHumanAmount(value, decimals);
function keyboard(rows: Array<Array<{ label: string; data: string }>>) {
  const kb = new InlineKeyboard();
  for (const row of rows) {
    for (const item of row) {
      const parts = item.data.split(":"),
        data =
          (parts[0] === "pool" || parts[0] === "pool-unavailable") &&
          parts.length === 3
            ? `${parts[0]}:${parts[2]}`
            : item.data;
      try {
        kb.text(item.label, telegramCallbackData(data));
      } catch (error) {
        if (error instanceof TelegramCallbackDataOverflowError)
          log("telegram_callback_data_overflow", {
            prefix: error.prefix,
            callbackDataBytes: error.byteLength,
          });
        throw error;
      }
    }
    kb.row();
  }
  return kb;
}
const tokenInfo = (token: {
  symbol: string;
  address: Address;
  decimals: number;
}): DisplayToken => ({
  symbol: token.symbol,
  address: token.address,
  decimals: token.decimals,
});
async function walletBalance(address: Address, wallet: Address) {
  return rpc.withClient((client) =>
    client.readContract({
      address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet],
    }),
  );
}
async function walletAllowance(
  address: Address,
  wallet: Address,
  spender: Address,
) {
  return rpc.withClient((client) =>
    client.readContract({
      address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [wallet, spender],
    }),
  );
}
async function tokenBalances(
  token0: Address,
  token1: Address,
  wallet: Address,
) {
  return Promise.all([
    walletBalance(token0, wallet),
    walletBalance(token1, wallet),
  ]);
}
function preserve(ctx: any, flow: TelegramFlowSession, message: string) {
  const refreshed = advanceFlow(ctx, flow, flow.state, "invalid amount");
  const active = refreshed ?? flow;
  return ctx.reply(
    `${message}\n\nYour selected pool and range are unchanged. Enter the amount again or use Back / Cancel / Start over.`,
    { reply_markup: keyboard([flowControls(active)]) },
  );
}
async function runConfirmedCanary(ctx: any, confirmationId: string) {
  const db = repo();
  try {
    const confirmation = db.confirmation(confirmationId);
    if (!confirmation) return ctx.reply("Unknown canary confirmation.");
    let payload: any;
    try {
      payload = JSON.parse(String(confirmation.payload_json));
    } catch {
      return ctx.reply(
        "Canary confirmation payload is invalid. No transaction was sent.",
      );
    }
    const canary = payload.canary;
    if (!canary)
      return ctx.reply("This confirmation is not a live single-sided canary.");
    const [currentBlock, deployments] = await Promise.all([
      rpc.withClient((client) => client.getBlockNumber()),
      audit(),
    ]);
    if (deployments.status === "unavailable")
      return ctx.reply(
        `EXECUTION_BLOCKED\nDeployment verification failed: ${deployments.reason}`,
      );
    const wallet = dedicatedWallet(),
      safety = safetyPayload(db);
    if (!wallet.address)
      return ctx.reply(
        "EXECUTION_BLOCKED\nDedicated wallet is not configured.",
      );
    const result = await executeConfirmedCanaryRoute({
      repo: db,
      confirmationId,
      selectionId: String(canary.selectionId),
      sessionId: String(canary.sessionId),
      buttonPool: canary.pool as Address,
      verifiedFactory: deployments.value.factory,
      userId: owner(ctx),
      chatId: chat(ctx),
      allowlisted: allowed.has(owner(ctx)),
      readiness: canary.readiness,
      executionEnabled: env.EXECUTION_ENABLED,
      dryRun: env.DRY_RUN,
      emergencyPause: env.EMERGENCY_PAUSE,
      liveCanaryEnabled: env.LIVE_CANARY_ENABLED,
      signerConfigured: wallet.signerConfigured,
      chainId: env.RH_CHAIN_ID,
      deploymentVerified: true,
      runtimeConfigurationMatches:
        safety.executionEnabled === env.EXECUTION_ENABLED &&
        safety.dryRun === env.DRY_RUN &&
        safety.emergencyPause === env.EMERGENCY_PAUSE &&
        safety.liveCanaryEnabled === env.LIVE_CANARY_ENABLED,
      positionUsd: Number(canary.positionUsd),
      approvalUsd: Number(canary.positionUsd),
      maxPositionUsd: env.MAX_POSITION_VALUE_USD,
      maxApprovalUsd: env.MAX_APPROVAL_VALUE_USD,
      openPositions: db
        .listPositions()
        .filter((position) => position.status === "open").length,
      maxOpenPositions: env.LIVE_CANARY_MAX_OPEN_POSITIONS,
      wallet: wallet.address as Address,
      log,
      executorInput: {
        rpc,
        walletClient: guardedWalletClient(),
        wallet: wallet.address as Address,
        owner: owner(ctx),
        pool: canary.pool as Address,
        target: canary.target,
        funding: canary.funding,
        fundingAmount: BigInt(canary.amount),
        upperDropPct: Number(canary.upper),
        lowerDropPct: Number(canary.lower),
        slippageBps: env.MAX_SLIPPAGE_BPS,
        deadlineSeconds: env.CONFIRMATION_TTL_SECONDS,
        maxGasUsd: env.MAX_GAS_COST_USD,
        gasUsdPerNative: Number(canary.nativeUsd),
        notify: (message) => ctx.reply(message),
      },
    });
    if (result.status === "EXECUTION_BLOCKED")
      return ctx.reply(
        `EXECUTION_BLOCKED\n${result.reason}\nNo transaction was sent.`,
      );
    if (result.status === "ALREADY_PROCESSING_OR_COMPLETED")
      return ctx.reply(
        `Canary confirmation already used. Intent: ${result.intentId}`,
      );
    return result;
  } finally {
    db.close();
  }
}
async function runPreparedCanary(ctx: any, intentId: string) {
  const db = repo();
  try {
    const intent = db.canaryIntent(intentId);
    if (!intent) return ctx.reply("Preview expired, create a new preview.");
    let payload: any;
    try {
      payload = JSON.parse(String(intent.payload_json));
    } catch {
      return ctx.reply(
        "Canary intent payload is invalid. No transaction was sent.",
      );
    }
    const canary = payload.canary;
    if (!canary)
      return ctx.reply("This intent is not a live single-sided canary.");
    if (
      Number(canary.expiresAt) <= nowMs() &&
      String(intent.state) === "PREVIEWED"
    )
      return ctx.reply("Preview expired, create a new preview.");
    const deployments = await audit();
    if (deployments.status === "unavailable")
      return ctx.reply(
        `EXECUTION_BLOCKED\nDeployment verification failed: ${deployments.reason}`,
      );
    const wallet = dedicatedWallet(),
      safety = safetyPayload(db);
    if (!wallet.address)
      return ctx.reply(
        "EXECUTION_BLOCKED\nDedicated wallet is not configured.",
      );
    const result = await executePreparedCanaryRoute({
      repo: db,
      intentId,
      selectionId: String(canary.selectionId),
      sessionId: String(canary.sessionId),
      buttonPool: canary.pool as Address,
      verifiedFactory: deployments.value.factory,
      userId: owner(ctx),
      chatId: chat(ctx),
      allowlisted: allowed.has(owner(ctx)),
      readiness: canary.readiness,
      executionEnabled: env.EXECUTION_ENABLED,
      dryRun: env.DRY_RUN,
      emergencyPause: env.EMERGENCY_PAUSE,
      liveCanaryEnabled: env.LIVE_CANARY_ENABLED,
      signerConfigured: wallet.signerConfigured,
      chainId: env.RH_CHAIN_ID,
      deploymentVerified: true,
      runtimeConfigurationMatches:
        safety.executionEnabled === env.EXECUTION_ENABLED &&
        safety.dryRun === env.DRY_RUN &&
        safety.emergencyPause === env.EMERGENCY_PAUSE &&
        safety.liveCanaryEnabled === env.LIVE_CANARY_ENABLED,
      positionUsd: Number(canary.positionUsd),
      approvalUsd: Number(canary.positionUsd),
      maxPositionUsd: env.MAX_POSITION_VALUE_USD,
      maxApprovalUsd: env.MAX_APPROVAL_VALUE_USD,
      openPositions: db
        .listPositions()
        .filter((position) => position.status === "open").length,
      maxOpenPositions: env.LIVE_CANARY_MAX_OPEN_POSITIONS,
      wallet: wallet.address as Address,
      log,
      executorInput: {
        rpc,
        walletClient: guardedWalletClient(),
        wallet: wallet.address as Address,
        owner: owner(ctx),
        pool: canary.pool as Address,
        target: canary.target,
        funding: canary.funding,
        fundingAmount: BigInt(canary.amount),
        upperDropPct: Number(canary.upper),
        lowerDropPct: Number(canary.lower),
        slippageBps: env.MAX_SLIPPAGE_BPS,
        deadlineSeconds: env.CONFIRMATION_TTL_SECONDS,
        maxGasUsd: env.MAX_GAS_COST_USD,
        gasUsdPerNative: Number(canary.nativeUsd),
        notify: (message) => ctx.reply(message),
      },
    });
    if (result.status === "EXECUTION_BLOCKED")
      return ctx.reply(
        `EXECUTION_BLOCKED\n${result.reason}\nNo transaction was sent.`,
      );
    if (result.status === "ALREADY_PROCESSING_OR_COMPLETED")
      return ctx.reply("ALREADY_PROCESSING_OR_COMPLETED");
    return result;
  } finally {
    db.close();
  }
}
bot.use(async (ctx, next) => {
  const messageShape = telegramMessageShape(
    ctx.update?.message as Record<string, unknown> | undefined,
  );
  const route = authorizeTelegramInbound({
    chatType: ctx.chat?.type,
    senderId: ctx.from?.id,
    chatId: ctx.chat?.id,
    operatorUserId,
    operatorPrivateChatId,
    updateKind: telegramUpdateKind(
      ctx.update as unknown as Record<string, unknown>,
    ),
    ...messageShape,
  });
  if (route === "silent") return;
  return next();
});
const acknowledgedCallbacks = new Set<string>();
async function acknowledgeCallback(ctx: any) {
  if (
    !ctx.callbackQuery ||
    acknowledgedCallbacks.has(String(ctx.callbackQuery.id))
  )
    return 0;
  const started = Date.now();
  try {
    await ctx.answerCallbackQuery();
  } catch (error) {
    if (!/query.*(old|expired)|QUERY_ID_INVALID/i.test(textError(error)))
      throw error;
    log("telegram_callback_ack_expired", {
      callbackId: String(ctx.callbackQuery.id),
    });
  }
  acknowledgedCallbacks.add(String(ctx.callbackQuery.id));
  const callbackAckMs = Date.now() - started;
  log("telegram_interaction_latency", {
    interaction: "callback",
    callbackAckMs,
    firstPaintMs: 0,
    ledgerReadMs: 0,
    walletSyncMs: 0,
    ownershipMs: 0,
    poolStateMs: 0,
    pricingMs: 0,
    allowanceMs: 0,
    rpcProvider: "telegram",
    fallbackUsed: false,
    rpcMs: 0,
    totalMs: callbackAckMs,
  });
  return callbackAckMs;
}
bot.use(async (ctx, next) => {
  if (ctx.callbackQuery) await acknowledgeCallback(ctx);
  return next();
});
const directLookupDeadlineMs = Number(
    process.env.DIRECT_LOOKUP_DEADLINE_MS ?? 15_000,
  ),
  directLookupResultTtlMs = Number(
    process.env.DIRECT_LOOKUP_RESULT_TTL_MS ?? 300_000,
  ),
  outboxRetryCount = Number(process.env.DIRECT_LOOKUP_OUTBOX_RETRY_COUNT ?? 3),
  outboxCadenceMs = Number(process.env.DIRECT_LOOKUP_OUTBOX_CADENCE_MS ?? 750);
function terminalLookupRender(
  status: string,
  tokenSymbol: string,
  token: string,
  reasonCode?: string | null,
  evidence?: DirectLookupEvidenceSummary,
) {
  const reason =
    reasonCode === "DIRECT_LOOKUP_WORKER_NOT_LEASED"
      ? "Pool lookup worker did not start this request before the deadline."
      : (status === "NO_ACTIVE_LIQUIDITY_POOL" || status === "PROVIDER_TEMPORARILY_UNAVAILABLE" || status === "LOOKUP_TIMED_OUT") && evidence
      ? directLookupTerminalEvidenceText(status,evidence)
      : status === "PROVIDER_TEMPORARILY_UNAVAILABLE"
        ? "Pool provider is temporarily unavailable."
        : status === "LOOKUP_TIMED_OUT"
          ? "Pool lookup timed out safely."
          : status === "REQUEST_EXPIRED"
            ? "Pool lookup request expired."
            : "Pool lookup could not complete.";
  const text = `${tokenSymbol}: ${reason}`,
    rows = [[{ label: "Retry", data: `direct-lookup-retry:${token}` }]],
    hash = createHash("sha256")
      .update(JSON.stringify({ text, rows }))
      .digest("hex");
  return { text, rows, hash };
}
function directLookupEvidenceSummary(value:unknown):DirectLookupEvidenceSummary|undefined{
 if(!value||typeof value!=='object')return undefined;const record=value as Record<string,unknown>,number=(key:string)=>Number(record[key]??0);return {structuralCandidateCount:number('structuralCandidateCount'),zeroLiquidityCandidateCount:number('zeroLiquidityCandidateCount'),notInitializedCandidateCount:number('notInitializedCandidateCount'),unavailableCandidateCount:number('unavailableCandidateCount')};
}
function persistPoolListing(input: {
  db: SqliteLedgerRepository;
  userId: string;
  chatId: string;
  flow: TelegramFlowSession;
  tokenAddress: Address;
  tokenSymbol: string;
  v4Candidates: ReturnType<typeof cachedV4PoolsForToken>["candidates"];
  v3Rows: Record<string, unknown>[];
}) {
  const existingV4 = input.db.v4PoolSelectionsForSession(
      input.userId,
      input.chatId,
      input.flow.sessionId,
    ),
    existingV3 = input.db.db
      .prepare(
        "SELECT * FROM canary_pool_selections WHERE user_id=? AND chat_id=? AND session_id=? AND superseded=0",
      )
      .all(input.userId, input.chatId, input.flow.sessionId) as Record<
      string,
      unknown
    >[];
  const executableV4=input.v4Candidates.filter(candidate=>candidate.executionEligible),unsupportedV4=input.v4Candidates.filter(candidate=>String(candidate.uiState).startsWith('UNSUPPORTED:')),notInitializedV4=input.v4Candidates.filter(candidate=>String(candidate.uiState)==='NOT_INITIALIZED'),evidenceUnavailableV4=input.v4Candidates.filter(candidate=>candidate.uiState==='EVIDENCE_UNAVAILABLE');
  const v4Selections = executableV4.map((candidate) => {
    const prior = existingV4.find(
      (row) =>
        String(row.pool_id).toLowerCase() === candidate.poolId.toLowerCase(),
    );
    const id = prior
      ? String(prior.id)
      : String(
          input.db.createV4PoolSelection({
            userId: input.userId,
            chatId: input.chatId,
            sessionId: input.flow.sessionId,
            poolId: candidate.poolId,
            poolKey: candidate.key,
            discoveryBlock: candidate.initializationBlock,
            refreshBlock: candidate.refreshBlock,
            liquidity: candidate.liquidity,
            targetToken: candidate.target.address,
            fundingToken: candidate.funding.address,
            targetSymbol: candidate.target.symbol,
            fundingSymbol: candidate.funding.symbol,
            symbolProvenance: {source:'TRUSTED_DISCOVERY_SELECTION_V1',observedAtMs:Date.now(),bindings:[{address:candidate.target.address.toLowerCase(),symbol:candidate.target.symbol},{address:candidate.funding.address.toLowerCase(),symbol:candidate.funding.symbol}]},
            targetIndex: candidate.targetIndex,
            fundingIndex: candidate.fundingIndex,
            feeSemantics: candidate.feeSemantics,
            hookStatus: candidate.hookStatus,
            valuationSnapshot: {
              valuation: candidate.valuation,
              priceFundingPerTarget: candidate.priceFundingPerTarget,
              priceProvenance: candidate.priceProvenance,
            },
            eligibility: true,
            blockers: [],
            expiresAtMs: input.flow.expiresAtMs,
            supersedeExisting: false,
          }).id,
        );
    return { id, candidate };
  });
  const selections = input.v3Rows.map((row) => {
      const prior = existingV3.find(
        (item) =>
          String(item.pool_address).toLowerCase() ===
          String(row.pool_address).toLowerCase(),
      );
      const id = prior
        ? String(prior.id)
        : String(
            input.db.createPoolSelection({
              userId: input.userId,
              chatId: input.chatId,
              sessionId: input.flow.sessionId,
              poolAddress: String(row.pool_address),
              factoryAddress: String(row.factory_address),
              token0Address: String(row.token0_address),
              token1Address: String(row.token1_address),
              fee: Number(row.fee),
              tickSpacing: Number(row.tick_spacing),
              discoveryBlock: BigInt(String(row.refresh_block)),
              liquidity: BigInt(String(row.liquidity_raw)),
              tvlUsd: Number(row.tvl_usd),
              tvlSource: String(row.tvl_source),
              tvlObservedAtMs: Number(row.tvl_observed_at_ms),
              tvlFreshUntilMs: Number(row.tvl_fresh_until_ms),
              tvlStatus: String(row.tvl_status),
              initialized: true,
            }).id,
          );
      return { id, row };
    });
  const items: PoolListingItem[] = [
      ...v4Selections.map(({ id, candidate }, rank) => ({
        section: "v4_eligible" as const,
        rank,
        label: v4PoolSelectionLabel(candidate.target.symbol,candidate.funding.symbol,candidate.feeLabel),
        data: `v4-pool:${id}`,
      })),
      ...selections.map(({ id, row }, rank) => ({
        section: "v3_eligible" as const,
        rank,
        label: compactLabel(
          `v3 · cached · fee ${(Number(row.fee) / 10_000).toFixed(2)}%`,
        ),
        data: `pool:${input.flow.sessionId}:${id}`,
      })),
    ],
    unavailableItems: PoolListingItem[] = [...notInitializedV4.map((candidate,rank)=>({section:'v4_unavailable' as const,rank,label:compactLabel(`NOT INITIALIZED · fresh StateView · ${candidate.target.symbol}/${candidate.funding.symbol}`),data:''})),...evidenceUnavailableV4.map((candidate,rank)=>({section:'v4_unavailable' as const,rank:rank+notInitializedV4.length,label:compactLabel(`EVIDENCE UNAVAILABLE · ${candidate.uiReason??'REFRESH_FAILED'} · ${candidate.target.symbol}/${candidate.funding.symbol}`),data:''})),...unsupportedV4.map((candidate,rank)=>({section:'v4_unavailable' as const,rank:rank+notInitializedV4.length+evidenceUnavailableV4.length,label:compactLabel(`UNSUPPORTED · ${candidate.blockers[0]??candidate.uiReason??'EXECUTION BLOCKED'} · ${candidate.target.symbol}/${candidate.funding.symbol}`),data:''}))],
    listing: PoolListing = {
      tokenSymbol: input.tokenSymbol,
      tokenAddress: input.tokenAddress,
      items: rankPoolListing(items),
      unavailableItems,
      counts: {
        v4Eligible: v4Selections.length,
        v3Eligible: selections.length,
        v4Unavailable: unsupportedV4.length,
        zeroLiquidity: input.v4Candidates.filter(candidate=>candidate.uiState==='SUPPORTED_NO_ACTIVE_LIQUIDITY').length,
        checking: input.v4Candidates.filter(candidate=>candidate.uiState==='CHECKING'||candidate.uiState==='TEMPORARILY_UNAVAILABLE').length,
        unsupported: unsupportedV4.length,
        evidenceUnavailable: evidenceUnavailableV4.length,
        notInitialized: notInitializedV4.length,
      },
    },
    render = poolListingRender(input.flow, listing, 0),
    state = {
      kind: "pool",
      token: input.tokenAddress,
      poolSelections: selections.map((x) => x.id),
      v4PoolSelections: v4Selections.map((x) => x.id),
      poolListing: listing,
      poolListingRender: {
        ...render,
        revision:
          Number((input.flow.state.poolListingRender as any)?.revision ?? 0) +
          1,
      },
      poolHydrationPending: false,
      interactiveMessageIds: Array.isArray(input.flow.state.interactiveMessageIds)?input.flow.state.interactiveMessageIds:[],
    };
  return { listing, render, state };
}
async function rankV4CandidatesForTelegram(
  candidates: ReturnType<typeof cachedV4PoolsForToken>["candidates"],
) {
  const requests = new Map<string, Promise<DexScreenerV4Liquidity>>();
  const liquidityFor = (candidate: (typeof candidates)[number]) => {
    const id = candidate.poolId.toLowerCase();
    let request = requests.get(id);
    if (!request) {
      request = fetchDexScreenerV4Liquidity({
        poolId: candidate.poolId,
        currency0: candidate.key.currency0,
        currency1: candidate.key.currency1,
      });
      requests.set(id, request);
    }
    return request;
  };
  const enriched = await Promise.all(candidates.map(async candidate => ({ candidate, liquidity: await liquidityFor(candidate) })));
  return rankTelegramV4ByDexLiquidity(enriched).map(value => value.candidate);
}
async function dexV4PoolLiquidityLine(poolId: string, key: V4PoolKey) {
  return formatDexScreenerV4Liquidity(await fetchDexScreenerV4Liquidity({
    poolId,
    currency0: key.currency0,
    currency1: key.currency1,
  }));
}
function directLookupTokenDisplay(db:SqliteLedgerRepository,token:Address){const cached=db.tokenMetadata(token);if(cached?.symbol)return cached;return db.db.prepare("SELECT symbol,name FROM gmgn_robinhood_observations WHERE lower(token_address)=lower(?) AND symbol IS NOT NULL ORDER BY observed_at_ms DESC LIMIT 1").get(token) as {symbol:string;name:string|null}|undefined;}
function directLookupTargetSymbol<T extends {target:{symbol:string}}>(candidates:readonly T[],symbol:string){return candidates.map(candidate=>({...candidate,target:{...candidate.target,symbol}}));}
async function beginToken(ctx: any, address: string, pasteReceivedAtMs=Date.now()) {
  const tokenAddress = getAddress(address), interactionId = randomUUID(), started = Date.now(),
    existing = loadFlow(ctx),
    created = newTokenFlow(ctx, {
      kind: "pool",
      token: tokenAddress,
      poolSelections: [],
      v4PoolSelections: [],
      poolHydrationPending: true,
      directLookupInteractionId: interactionId,
    }, existing),
    sessionAcceptedAtMs = Date.now(),
    firstResponseStartedAtMs = Date.now(),
    message = await ctx.reply(`${tokenAddress}\nChecking cached eligible pools…`),
    firstUiResponseAtMs = Date.now(),
    flow = bindInteractiveFlowMessage(ctx, created, Number(message.message_id), created.state);
  log("telegram_interactive_stage", {interactionId,interactionType:"TOKEN_LOOKUP",requestId:interactionId,stage:"SESSION_ACCEPTED_AND_FIRST_PAINT",startedAtMs:started,endedAtMs:firstUiResponseAtMs,elapsedMs:firstUiResponseAtMs-started,dbWaitMs:sessionAcceptedAtMs-started,rpcWaitMs:0,provider:"telegram",queueWaitMs:0,cache:"PENDING",outcome:"PAINTED",messageId:Number(message.message_id)});
  log('telegram_direct_lookup_first_response',{interactionId,token:tokenAddress,pasteReceivedAtMs,firstResponseStartedAtMs,firstUiResponseAtMs,firstUiResponseMs:firstUiResponseAtMs-pasteReceivedAtMs,messageId:Number(message.message_id),mainnetTransactionsSent:0});
  const cacheStartedAtMs = Date.now(), lookupDb = repo();
  let v4Lookup:ReturnType<typeof cachedV4PoolsForToken>, allV4:ReturnType<typeof cachedV4PoolsForToken>["candidates"], v3Rows:ReturnType<SqliteLedgerRepository["v3CachedPoolsForToken"]>, tokenSymbol:string, otherQuoteActive:number;
  try {
    v4Lookup = cachedV4PoolsForToken({ repo: lookupDb, token: tokenAddress });
    const presentedV4 = applyDirectLookupCandidatePresentation(lookupDb,tokenAddress,v4Lookup.candidates),
      meta = directLookupTokenDisplay(lookupDb,tokenAddress);
    v3Rows = lookupDb.v3CachedPoolsForToken(tokenAddress, [robinhoodMainnet.assets.USDG,robinhoodMainnet.assets.WETH]);
    tokenSymbol = String(meta?.symbol ?? `${tokenAddress.slice(0, 6)}…`);
    allV4 = directLookupTargetSymbol(presentedV4,tokenSymbol);
    otherQuoteActive = Number((lookupDb.db.prepare("SELECT COUNT(*) AS count FROM v4_pool_registry WHERE initialized=1 AND CAST(active_liquidity_raw AS INTEGER)>0 AND ((lower(currency0)=lower(?) AND lower(currency1) NOT IN (lower(?),lower(?))) OR (lower(currency1)=lower(?) AND lower(currency0) NOT IN (lower(?),lower(?))))").get(tokenAddress,robinhoodMainnet.assets.USDG,robinhoodMainnet.assets.WETH,tokenAddress,robinhoodMainnet.assets.USDG,robinhoodMainnet.assets.WETH) as { count: number }).count);
  } finally { lookupDb.close(); }
  const cacheEndedAtMs=Date.now(), v4Candidates=[...allV4], acceleration=needsDirectLookupAcceleration(allV4);
  log("telegram_interactive_stage", {interactionId,interactionType:"TOKEN_LOOKUP",requestId:interactionId,stage:"CACHED_CANDIDATE_CLASSIFICATION",startedAtMs:cacheStartedAtMs,endedAtMs:cacheEndedAtMs,elapsedMs:cacheEndedAtMs-cacheStartedAtMs,dbWaitMs:cacheEndedAtMs-cacheStartedAtMs,rpcWaitMs:0,provider:"sqlite-wal",queueWaitMs:0,cache:v4Candidates.length||v3Rows.length?"HIT":"MISS",outcome:"COMPLETE",candidatePoolCount:v4Candidates.length});
  log("telegram_lookup", {
    explicitTokenLookup: true,
    telegramLookupMs: Date.now() - started,
    cacheAgeMs: v4Lookup.cacheAgeMs,
    provider: "local-cache",
    fallbackUsed: false,
    v3: v3Rows.length,
    v4: v4Candidates.length,
    ...acceleration,
  });
  if (!acceleration.accelerationNeeded && (v3Rows.length || v4Candidates.length)) {
    const persisted = telegramFlowWrite("persistPoolListing", (db) => {
        return persistPoolListing({
          db,
          userId: owner(ctx),
          chatId: chat(ctx),
          flow,
          tokenAddress,
          tokenSymbol,
          v4Candidates,
          v3Rows,
        });
      }),
      listed = advanceFlow(ctx, flow, persisted.state, "pool listing persisted");
    if (!listed) return message;
    try { await bot.api.editMessageText(Number(chat(ctx)),Number(message.message_id),persisted.render.text,{reply_markup:keyboard(persisted.render.rows)}); } catch(error) { if(!messageNotModified(error)) throw error; }
    log("telegram_interactive_stage", {interactionId,interactionType:"TOKEN_LOOKUP",requestId:interactionId,stage:"CACHED_POOL_LIST_FIRST_PAINT",startedAtMs:cacheEndedAtMs,endedAtMs:Date.now(),elapsedMs:Date.now()-cacheEndedAtMs,dbWaitMs:0,rpcWaitMs:0,provider:"telegram",queueWaitMs:0,cache:"HIT",outcome:"COMPLETE",messageId:Number(message.message_id)});
    return message;
  }
  if (!acceleration.accelerationNeeded) {
    const reason = otherQuoteActive
      ? "UNSUPPORTED_FUNDING_PAIR"
      : "NO_ACTIVE_LIQUIDITY_POOL";
    log("telegram_pool_lookup_empty", {
      token: tokenAddress,
      reason,
      otherQuoteActive,
      registeredSupportedPairs: allV4.length,
      terminalStatus: "NO_ACTIVE_LIQUIDITY_POOL",
    });
    const render=terminalLookupRender('NO_ACTIVE_LIQUIDITY_POOL',tokenSymbol,tokenAddress,reason,{structuralCandidateCount:allV4.filter(candidate=>!String(candidate.uiState).startsWith('UNSUPPORTED:')).length,zeroLiquidityCandidateCount:allV4.filter(candidate=>candidate.uiState==='SUPPORTED_NO_ACTIVE_LIQUIDITY').length,notInitializedCandidateCount:allV4.filter(candidate=>String(candidate.uiState)==='NOT_INITIALIZED').length,unavailableCandidateCount:allV4.filter(candidate=>candidate.uiState==='EVIDENCE_UNAVAILABLE').length});
    try { await bot.api.editMessageText(Number(chat(ctx)),Number(message.message_id),render.text,{reply_markup:keyboard(render.rows)}); } catch(error) { if(!messageNotModified(error)) throw error; }
    return message;
  }
  const acknowledgementCounts:PoolListing['counts']={
      v4Eligible:allV4.filter(candidate=>candidate.executionEligible).length,
      v3Eligible:v3Rows.length,
      v4Unavailable:allV4.filter(candidate=>!candidate.executionEligible).length,
      zeroLiquidity:allV4.filter(candidate=>candidate.uiState==='SUPPORTED_NO_ACTIVE_LIQUIDITY').length,
      checking:allV4.filter(candidate=>candidate.uiState==='CHECKING'||candidate.uiState==='TEMPORARILY_UNAVAILABLE').length,
      unsupported:allV4.filter(candidate=>String(candidate.uiState).startsWith('UNSUPPORTED:')).length,
      evidenceUnavailable:allV4.filter(candidate=>candidate.uiState==='EVIDENCE_UNAVAILABLE').length,
      notInitialized:allV4.filter(candidate=>String(candidate.uiState)==='NOT_INITIALIZED').length,
    };
  try { await bot.api.editMessageText(Number(chat(ctx)),Number(message.message_id),directLookupAcknowledgementText(tokenSymbol,tokenAddress,acknowledgementCounts)); } catch(error) { if(!messageNotModified(error)) throw error; }
  const requestStartedAtMs=Date.now(), requestDb = repo();
  let lookup;
  try {
    lookup = retrySqliteBusySync({
      operation: "createOrReuseDirectLookup",
      log,
      run: () =>
        createOrReuseDirectLookup({
          repo: requestDb,
          token: tokenAddress,
          interactionId,
           deadlineMs: directLookupDeadlineMs,
           resultTtlMs: directLookupResultTtlMs,
           explicitRetry: false,
           refreshStaleEvidence: acceleration.accelerationNeeded,
           naturalTimeline:{pasteReceivedAtMs,firstUiResponseAtMs},
        }),
    });
  } finally {
    requestDb.close();
  }
  const requestPersistedAtMs=Date.now();
  log("telegram_interactive_stage", {interactionId,interactionType:"TOKEN_LOOKUP",requestId:lookup.request.id,requestRevision:lookup.request.revision,stage:"REQUEST_PERSISTED",startedAtMs:requestStartedAtMs,endedAtMs:requestPersistedAtMs,elapsedMs:requestPersistedAtMs-requestStartedAtMs,dbWaitMs:requestPersistedAtMs-requestStartedAtMs,rpcWaitMs:0,provider:"sqlite-wal",queueWaitMs:0,cache:lookup.cacheHit?"HIT":"MISS",outcome:"COMPLETE"});
  log('telegram_direct_lookup_request_persisted',{interactionId,requestId:lookup.request.id,requestRevision:lookup.request.revision,token:tokenAddress,pasteReceivedAtMs,firstUiResponseAtMs,requestPersistedAtMs,persistenceMs:requestPersistedAtMs-firstUiResponseAtMs,deadlineAtMs:Number(lookup.request.deadline_at_ms),mainnetTransactionsSent:0});
  if (lookup.cacheHit && lookup.request.status !== "SUPPORTED_POOLS_FOUND") {
    if (v3Rows.length || v4Candidates.length) {
      log("telegram_direct_lookup_cache_preserved", {requestId:lookup.request.id,requestReused:true,...acceleration});
    } else {
    const render = terminalLookupRender(
      String(lookup.request.status),
      tokenSymbol,
      tokenAddress,
      String(lookup.request.reason_code ?? ""),
      directLookupEvidenceSummary(JSON.parse(String(lookup.request.rpc_attribution_json??'{}'))),
    );
    try { await bot.api.editMessageText(Number(chat(ctx)),Number(message.message_id),render.text,{reply_markup:keyboard(render.rows)}); } catch(error) { if(!messageNotModified(error)) throw error; }
    return message;
    }
  }
  const active =
      advanceFlow(
        ctx,
        flow,
        {
          ...flow.state,
          directLookupRequestId: lookup.request.id,
          directLookupRevision: lookup.request.revision,
          directLookupInteractionId: interactionId,
        },
        "durable token-scoped lookup queued",
      ) ?? flow;
  let subscriberFlow = active,
    initialListing: ReturnType<typeof persistPoolListing>["render"] | null = null;
  if (v3Rows.length || v4Candidates.length) {
    const persisted = telegramFlowWrite("persistPoolListing", db =>
        persistPoolListing({db,userId:owner(ctx),chatId:chat(ctx),flow:active,tokenAddress,tokenSymbol,v4Candidates,v3Rows})),
      state = {...persisted.state,poolHydrationPending:!lookup.cacheHit,directLookupRequestId:lookup.request.id,directLookupRevision:lookup.request.revision,directLookupInteractionId:interactionId},
      listed = advanceFlow(ctx, active, state, "initial direct lookup pool listing persisted");
    if (!listed) return unavailableFlow(ctx, "stale");
    subscriberFlow = listed;
    initialListing = persisted.render;
  }
  if(initialListing){try{await bot.api.editMessageText(Number(chat(ctx)),Number(message.message_id),initialListing.text,{reply_markup:keyboard(initialListing.rows)});}catch(error){if(!messageNotModified(error))throw error;}}
  if (lookup.cacheHit) return message;
  telegramFlowWrite("attachDirectLookupSubscriber", (attachDb) => {
    const subscriber = attachDirectLookupSubscriber({
      repo: attachDb,
      requestId: lookup.request.id,
      requestRevision: lookup.request.revision,
      interactionId,
      userId: owner(ctx),
      chatId: chat(ctx),
      messageId: Number(message.message_id),
      sessionId: subscriberFlow.sessionId,
    });
    attachDb.db.prepare("UPDATE direct_token_lookup_subscribers SET base_flow_revision=? WHERE id=? AND base_flow_revision IS NULL")
      .run(subscriberFlow.flowRevision, String(subscriber.id));
    return subscriber;
  });
  log("telegram_direct_lookup_queued", {
    interactionId,
    requestId: lookup.request.id,
    requestRevision: lookup.request.revision,
    token: tokenAddress,
    cacheHit: lookup.cacheHit,
    deduplicated: lookup.deduplicated,
    requestReused: !lookup.created,
    ...acceleration,
    candidatePoolCount: allV4.length,
    queueJobsCreated: lookup.created ? 1 : 0,
    pollingIterations: 0,
    totalMs: Date.now() - started,
    pasteReceivedAtMs,
    firstUiResponseAtMs,
    requestPersistedAtMs,
    terminalStatus: null,
  });
  return message;
}
function renderPoolListing(ctx: any, flow: TelegramFlowSession, page: number) {
  if (flow.status !== "active" || flow.state.kind !== "pool")
    return unavailableFlow(ctx, "stale");
  const listing = flow.state.poolListing as PoolListing | undefined;
  if (!listing || !Array.isArray(listing.items))
    return unavailableFlow(ctx, "stale");
  const view = poolListingPage(listing, page),
    rows = view.items.map((item) => [{ label: item.label, data: item.data }]);
  const navigation = [
    ...(view.hasPrevious
      ? [
          {
            label: "Previous",
            data: `pool-page:${flow.sessionId}:${view.current - 1}`,
          },
        ]
      : []),
    ...(view.hasNext
      ? [
          {
            label: "Next",
            data: `pool-page:${flow.sessionId}:${view.current + 1}`,
          },
        ]
      : []),
  ];
  if (navigation.length) rows.push(navigation);
  if (unavailablePoolListingItems(listing).length > 0)
    rows.push([{ label: "Show unavailable pools", data: `pool-unavailable-page:${flow.sessionId}:0` }]);
  rows.push([{ label: "Refresh", data: `direct-lookup-retry:${listing.tokenAddress}` }]);
  rows.push(flowControls(flow));
  return ctx.reply(
    `${poolListingSummary(listing, view.current)}\n\nSelections remain valid for ${env.TELEGRAM_SESSION_TTL_SECONDS / 60} minutes.`,
    { reply_markup: keyboard(rows) },
  );
}
function poolListingRender(
  flow: TelegramFlowSession,
  listing: PoolListing,
  page: number,
) {
  const view = poolListingPage(listing, page),
    rows = view.items.map((item) => [{ label: item.label, data: item.data }]),
    navigation = [
      ...(view.hasPrevious
        ? [
            {
              label: "Previous",
              data: `pool-page:${flow.sessionId}:${view.current - 1}`,
            },
          ]
        : []),
      ...(view.hasNext
        ? [
            {
              label: "Next",
              data: `pool-page:${flow.sessionId}:${view.current + 1}`,
            },
          ]
        : []),
    ];
  if (navigation.length) rows.push(navigation);
  if (unavailablePoolListingItems(listing).length > 0)
    rows.push([{ label: "Show unavailable pools", data: `pool-unavailable-page:${flow.sessionId}:0` }]);
  rows.push([{ label: "Refresh", data: `direct-lookup-retry:${listing.tokenAddress}` }]);
  rows.push(flowControls(flow));
  const text = `${poolListingSummary(listing, view.current)}\n\nSelections remain valid for ${env.TELEGRAM_SESSION_TTL_SECONDS / 60} minutes.`,
    hash = createHash("sha256")
      .update(JSON.stringify({ text, rows }))
      .digest("hex");
  return { page: view.current, text, rows, hash };
}
function messageNotModified(error: unknown) {
  return /message is not modified/i.test(textError(error));
}
async function pagePoolListing(ctx: any, sessionId: string, pageText: string) {
  const flow = loadFlow(ctx, sessionId),
    page = Number(pageText);
  if (
    !flow ||
    flow.status !== "active" ||
    flow.state.kind !== "pool" ||
    !Number.isSafeInteger(page) ||
    page < 0
  )
    return unavailableFlow(ctx, "stale");
  return renderPoolListing(ctx, flow, page);
}
function renderUnavailablePoolListing(ctx: any, flow: TelegramFlowSession, page: number) {
  if (flow.status !== "active" || flow.state.kind !== "pool")
    return unavailableFlow(ctx, "stale");
  const listing = flow.state.poolListing as PoolListing | undefined;
  if (!listing || !Array.isArray(listing.items))
    return unavailableFlow(ctx, "stale");
  const view = unavailablePoolListingPage(listing, page),
    navigation = [
      ...(view.hasPrevious ? [{ label: "Previous", data: `pool-unavailable-page:${flow.sessionId}:${view.current - 1}` }] : []),
      ...(view.hasNext ? [{ label: "Next", data: `pool-unavailable-page:${flow.sessionId}:${view.current + 1}` }] : []),
    ],
    rows: Array<Array<{ label: string; data: string }>> = [];
  if (navigation.length) rows.push(navigation);
  rows.push([{ label: "Back to executable pools", data: `pool-page:${flow.sessionId}:0` }]);
  rows.push([{ label: "Refresh", data: `direct-lookup-retry:${listing.tokenAddress}` }]);
  rows.push(flowControls(flow));
  return ctx.reply(
    [
      `${listing.tokenSymbol} (${listing.tokenAddress})`,
      "Unavailable pools — informational only. They cannot be selected or executed.",
      ...view.items.map((item) => item.label),
      `Page ${view.current + 1}/${view.totalPages}`,
    ].join("\n"),
    { reply_markup: keyboard(rows) },
  );
}
async function pageUnavailablePoolListing(ctx: any, sessionId: string, pageText: string) {
  const flow = loadFlow(ctx, sessionId), page = Number(pageText);
  if (!flow || flow.status !== "active" || flow.state.kind !== "pool" || !Number.isSafeInteger(page) || page < 0)
    return unavailableFlow(ctx, "stale");
  return renderUnavailablePoolListing(ctx, flow, page);
}
let telegramStopping = false;
async function deliverDirectLookupOutbox() {
  const event = retrySqliteBusySync({operation:"telegram_direct_lookup_outbox_lease",log,run:()=>{const leaseDb=repo();try{expireDueDirectTokenLookups(leaseDb);return leaseDirectLookupOutbox(leaseDb,15_000);}finally{leaseDb.close();}}}) as Record<string,unknown>|undefined;
  if (!event) return false;
  const deliveryStarted = Date.now();
  let render: {
    text: string;
    rows: Array<Array<{ label: string; data: string }>>;
    hash: string;
  };
  try {
    if (event.render_json) render = JSON.parse(String(event.render_json));
    else {
        const payload = JSON.parse(String(event.payload_json)) as {
          requestId:string;
          requestRevision:number;
          token: string;
          terminalStatus: string;
          eligiblePoolIds: string[];
          eligiblePoolCount: number;
          candidatePoolCount: number;
          hydratedPoolCount: number;
          reasonCode?: string | null;
          rpcAttribution?: Record<string, unknown>;
        },
        renderDb = repo();
      try {
        const flow = renderDb.telegramFlow({
            userId: String(event.user_id),
            chatId: String(event.chat_id),
            sessionId: String(event.session_id),
            now: nowMs(),
          }),
          subscriber = renderDb.db.prepare("SELECT base_flow_revision FROM direct_token_lookup_subscribers WHERE id=?")
            .get(String(event.subscriber_id)) as {base_flow_revision:number|null}|undefined,
          baseFlowRevision = subscriber?.base_flow_revision == null
            ? undefined
            : Number(subscriber.base_flow_revision),
          meta = directLookupTokenDisplay(renderDb,getAddress(payload.token)),
          symbol = String(meta?.symbol ?? `${payload.token.slice(0, 6)}…`);
        const applyOutboxFlowState = (nextState: Record<string, unknown>) => {
          if (!flow || baseFlowRevision === undefined) {
            log("telegram_direct_lookup_stale_async_write_prevented", {
              sessionId: String(event.session_id),
              source: "direct_lookup_outbox",
              requestId: event.request_id,
              requestRevision: event.request_revision,
              subscriberId: event.subscriber_id,
              originatingFlowRevision: baseFlowRevision ?? null,
              currentFlowRevision: flow?.flowRevision ?? null,
              previousKind: flow?.state.kind ?? null,
              requestedNextKind: nextState.kind ?? null,
              result: flow ? "REVISION_CONFLICT" : "NOT_FOUND",
              staleAsyncWritePrevented: true,
            });
            return;
          }
          const result = retrySqliteBusySync({operation:"telegram_direct_lookup_flow_transition",log,run:()=>renderDb.transitionTelegramFlowCAS({
            userId: String(event.user_id),
            chatId: String(event.chat_id),
            sessionId: flow.sessionId,
            expectedRevision: baseFlowRevision,
            expectedStatus: "active",
            nextState,
            now: nowMs(),
            ttlMs: sessionTtlMs,
          })});
          log("telegram_flow_cas", {
            sessionId: flow.sessionId,
            source: "direct_lookup_outbox",
            expectedRevision: baseFlowRevision,
            observedRevision: result.observedRevision ?? null,
            resultingRevision: result.resultingRevision ?? null,
            previousKind: String(flow.state.kind ?? "unknown"),
            requestedNextKind: String(nextState.kind ?? "unknown"),
            result: result.result,
          });
          if (result.result !== "APPLIED")
            log("telegram_direct_lookup_stale_async_write_prevented", {
              sessionId: flow.sessionId,
              source: "direct_lookup_outbox",
              requestId: event.request_id,
              requestRevision: event.request_revision,
              subscriberId: event.subscriber_id,
              originatingFlowRevision: baseFlowRevision,
              currentFlowRevision: result.observedRevision ?? flow.flowRevision,
              previousKind: flow.state.kind ?? null,
              requestedNextKind: nextState.kind ?? null,
              result: result.result,
              staleAsyncWritePrevented: true,
            });
        };
        if (!flow || flow.status !== "active") {
          if (flow) applyOutboxFlowState(flow.state);
          render = terminalLookupRender(
            "REQUEST_EXPIRED",
            symbol,
            payload.token,
          );
        } else if (payload.terminalStatus === "SUPPORTED_POOLS_FOUND") {
          const eligible = new Set(
              payload.eligiblePoolIds.map((id) => id.toLowerCase()),
            ),
            lookup = cachedV4PoolsForToken({
              repo: renderDb,
              token: getAddress(payload.token),
            }),
            presented = directLookupTargetSymbol(applyDirectLookupCandidatePresentation(renderDb,getAddress(payload.token),lookup.candidates,nowMs(),{requestId:String(payload.requestId),requestRevision:Number(payload.requestRevision)}),symbol),
            eligibleV4 = presented.filter(item=>item.executionEligible&&eligible.has(item.poolId.toLowerCase())),
            v3 = renderDb
              .v3CachedPoolsForToken(payload.token, [
                robinhoodMainnet.assets.USDG,
                robinhoodMainnet.assets.WETH,
              ])
              .filter((item) =>
                eligible.has(String(item.pool_address).toLowerCase()),
              );
          const v4 = [...await rankV4CandidatesForTelegram(eligibleV4),...presented.filter(item=>!eligible.has(item.poolId.toLowerCase())||!item.executionEligible).map(item=>item.executionEligible?{...item,executionEligible:false,uiState:'EVIDENCE_UNAVAILABLE' as const,uiReason:'NOT_ELIGIBLE_IN_REQUEST_REVISION'}:item)];
          if (v4.length || v3.length) {
            const persisted = retrySqliteBusySync({operation:"telegram_direct_lookup_listing_persist",log,run:()=>persistPoolListing({
              db: renderDb,
              userId: String(event.user_id),
              chatId: String(event.chat_id),
              flow,
              tokenAddress: getAddress(payload.token),
              tokenSymbol: symbol,
              v4Candidates: v4,
              v3Rows: v3,
            })});
            render = persisted.render;
            applyOutboxFlowState(persisted.state);
          } else
            render = terminalLookupRender(
              "PROVIDER_TEMPORARILY_UNAVAILABLE",
              symbol,
              payload.token,
            );
        } else {
          const cached = cachedV4PoolsForToken({repo:renderDb,token:getAddress(payload.token)}),presented=directLookupTargetSymbol(applyDirectLookupCandidatePresentation(renderDb,getAddress(payload.token),cached.candidates,nowMs(),{requestId:String(payload.requestId),requestRevision:Number(payload.requestRevision)}),symbol),
            freshExecutable = presented.filter(candidate=>candidate.executionEligible);
          if (freshExecutable.length) {
            const v4 = [...await rankV4CandidatesForTelegram(freshExecutable),...presented.filter(candidate=>!candidate.executionEligible)],
              persisted = retrySqliteBusySync({operation:"telegram_direct_lookup_listing_persist",log,run:()=>persistPoolListing({db:renderDb,userId:String(event.user_id),chatId:String(event.chat_id),flow,tokenAddress:getAddress(payload.token),tokenSymbol:symbol,v4Candidates:v4,v3Rows:renderDb.v3CachedPoolsForToken(payload.token,[robinhoodMainnet.assets.USDG,robinhoodMainnet.assets.WETH])})});
            render = persisted.render;
            applyOutboxFlowState(persisted.state);
          } else render = terminalLookupRender(payload.terminalStatus,symbol,payload.token,payload.reasonCode,directLookupEvidenceSummary(payload.rpcAttribution));
        }
        retrySqliteBusySync({operation:"telegram_direct_lookup_render_persist",log,run:()=>saveDirectLookupOutboxRender(
          renderDb,
          String(event.id),
          render,
          render.hash,
        )});
      } finally {
        renderDb.close();
      }
    }
    const editStarted = Date.now();
    try {
      await bot.api.editMessageText(
        Number(event.chat_id),
        Number(event.message_id),
        render.text,
        { reply_markup: keyboard(render.rows) },
      );
    } catch (error) {
      if (!messageNotModified(error)) throw error;
    }
    const completeDb = repo();
    try {
      retrySqliteBusySync({operation:"telegram_direct_lookup_outbox_complete",log,run:()=>completeDirectLookupOutbox(completeDb,String(event.id))});
    } finally {
      completeDb.close();
    }
    const payload = JSON.parse(String(event.payload_json)) as Record<
        string,
        unknown
      >,
      rpc = (payload.rpcAttribution ?? {}) as Record<string, unknown>;
    log("telegram_direct_lookup_outbox_delivered", {
      interactionId: event.interaction_id,
      requestId: event.request_id,
      requestRevision: event.request_revision,
      token: payload.token,
      cacheHit: false,
      deduplicated: false,
      candidatePoolCount: payload.candidatePoolCount,
      hydratedPoolCount: payload.hydratedPoolCount,
      eligiblePoolCount: payload.eligiblePoolCount,
      queueJobsCreated: 0,
      rpcCallCount: rpc.rpcCallCount ?? 0,
      ethCallCount: rpc.ethCallCount ?? 0,
      blockNumberCount: rpc.eth_blockNumberCount ?? 0,
      getLogsCount: rpc.getLogsCount ?? 0,
      multicallCount: rpc.multicallCount ?? 0,
      multicallMembers: rpc.multicallMembers ?? 0,
      provider: rpc.provider ?? "none",
      workerMs: rpc.workerMs ?? 0,
      pasteReceivedAtMs: rpc.pasteReceivedAtMs ?? null,
      firstUiResponseAtMs: rpc.firstUiResponseAtMs ?? null,
      requestPersistedAtMs: rpc.requestPersistedAtMs ?? null,
      workerLeasedAtMs: rpc.workerLeasedAtMs ?? null,
      firstRpcAtMs: rpc.firstRpcAtMs ?? null,
      hydrationCompletedAtMs: rpc.hydrationCompletedAtMs ?? null,
      outboxCreatedAtMs: rpc.outboxCreatedAtMs ?? null,
      queueLeaseWaitMs: Number(rpc.workerLeasedAtMs??0)-Number(rpc.requestPersistedAtMs??0),
      rpcWaitMs: Number(rpc.hydrationCompletedAtMs??0)-Number(rpc.firstRpcAtMs??0),
      telegramEditMs: Date.now() - editStarted,
      totalMs: Date.now() - deliveryStarted,
      telegramListingCompleteAtMs: Date.now(),
      terminalStatus: payload.terminalStatus,
      editAttemptCount: Number(event.attempts),
      pollingIterations: 0,
      mainnetTransactionsSent: 0,
    });
    return true;
  } catch (error) {
    const retryDb = repo();
    let result;
    try {
      result = retrySqliteBusySync({operation:"telegram_direct_lookup_outbox_retry",log,run:()=>retryDirectLookupOutbox(
        retryDb,
        String(event.id),
        textError(error),
        outboxRetryCount,
      )});
    } finally {
      retryDb.close();
    }
    log("telegram_direct_lookup_outbox_retry", {
      interactionId: event.interaction_id,
      requestId: event.request_id,
      requestRevision: event.request_revision,
      attempts: result.attempts,
      failed: result.failed,
      backoffMs: result.delay,
      error: textError(error),
      dbLockHeldDuringTelegram: false,
    });
    return true;
  }
}
async function directLookupOutboxConsumer() {
  while (!telegramStopping) {
    try {
      const delivered = await deliverDirectLookupOutbox();
      if (!delivered) await sleep(outboxCadenceMs);
    } catch (error) {
      log("telegram_direct_lookup_outbox_cycle_error", {
        error: textError(error),
      });
      await sleep(outboxCadenceMs);
    }
  }
}
async function positionClosedCardConsumer() {
  const cadenceMs=250,recoveryCadenceMs=30_000;
  let nextRecoveryAt=0;
  while(!telegramStopping){
    try{
      const now=Date.now(),recoverClaims=now>=nextRecoveryAt,cycle=await drainClosePnlCardDeliveries({openRepository:repo,sendPhoto:sendFuniPhoto,sendMessage:sendFuniMessage,consumerSource:"TELEGRAM_EVENT_DRIVEN",telemetry:log,limit:8,recoverClaims});
      if(recoverClaims)nextRecoveryAt=now+recoveryCadenceMs;
      if(cycle.claimed||cycle.recovery.definitelyUnsent||cycle.recovery.ambiguous)log("pnl_card_delivery_cycle",{...cycle,results:cycle.results.map(result=>({deliveryId:result.deliveryId,status:result.status,attempt:result.attempt})),cadenceMs,mainnetTransactionsSent:0});
    }catch(error){log("pnl_card_delivery_cycle_error",{error:textError(error),cadenceMs,mainnetTransactionsSent:0});}
    if(!telegramStopping)await sleep(cadenceMs);
  }
}
async function usdResetRepositionConsumer() {
  const recoveryCadenceMs = 60_000, handoffCadenceMs = 500;
  let nextRecoveryAt = 0;
  while (!telegramStopping) {
    try {
      const wallet = dedicatedWallet();
      if (wallet.address) {
        const db = repo();
        try {
          const cycleInput = {
            repo: db,
            rpc,
            wallet: wallet.address,
            walletClient: guardedWalletClient,
            context: (ladderId: string) => ladderLiveContext(undefined, ladderId, db, true),
            notify: (message: string) =>
              sendFuniMessage(message, "v4_bid_ladder_usdg_reset_reposition"),
            telemetry: (details: Record<string, unknown>) =>
              log("v4_bid_ladder_reposition_single_flight", details),
          };
          const durableClose = db.db.prepare("SELECT 1 FROM economic_reconciliation_work w JOIN v4_bid_ladder_usdg_reset_v1 r ON r.ladder_id=w.workflow_identity WHERE w.workflow_kind='V4_BID_LADDER_CLOSE' AND w.status IN ('PENDING','RETRYABLE','LEASED') AND r.phase NOT IN ('COMPLETED','BLOCKED','OPERATOR_CLOSED') LIMIT 1").get();
          if(durableClose) await runEconomicReconciliationCycle({repo:db,rpc,logsRpc,owner:`telegram-reposition:${process.pid}`,limit:4});
          const now=Date.now(),results:Array<Record<string,unknown>>=[];
          const immediate = db.db.prepare("SELECT r.ladder_id FROM v4_bid_ladder_usdg_reset_v1 r LEFT JOIN v4_bid_ladder_usdg_reset_execution_leases x ON x.ladder_id=r.ladder_id AND x.lease_until_ms>? WHERE r.phase IN ('CLOSE_CONFIRMED','PRINCIPAL_RECONCILED','REOPEN_PLANNED','REOPEN_PREPARED','REOPEN_SUBMITTED') AND x.ladder_id IS NULL ORDER BY r.updated_at_ms LIMIT 4").all(now) as Array<{ladder_id:string}>;
          if(immediate.length)for(const row of immediate)results.push(await processV4BidLadderUsdReset({...cycleInput,callerSource:'IMMEDIATE_RECOVERY'},String(row.ladder_id)));
          else if(now>=nextRecoveryAt)results.push(...await runV4BidLadderUsdResetCycle({...cycleInput,callerSource:'PERIODIC_RECOVERY'}));
          if(now>=nextRecoveryAt)nextRecoveryAt=now+recoveryCadenceMs;
          if (results.length)
            log("v4_bid_ladder_usdg_reset_cycle", {
              results,
              economicProofCreated: false,
            });
        } finally {
          db.close();
        }
      }
    } catch (error) {
      log("v4_bid_ladder_usdg_reset_cycle_error", {
        error: textError(error),
      });
    }
    if (!telegramStopping) await sleep(handoffCadenceMs);
  }
}
async function selectV4Pool(ctx: any, selectionId: string) {
  const flow = loadFlow(ctx);
  if (
    !flow ||
    flow.status !== "active" ||
    flow.state.kind !== "pool" ||
    !(flow.state.v4PoolSelections as unknown[] | undefined)?.includes(
      selectionId,
    )
  )
    return unavailableFlow(ctx, "stale");
  const db = repo();
  let selection: Record<string, unknown> | undefined,
    registered: Record<string, unknown> | undefined;
  try {
    selection = db.v4PoolSelection(selectionId);
    registered = selection
      ? db.v4RegistryPool(String(selection.pool_id))
      : undefined;
  } finally {
    db.close();
  }
  if (
    !selection ||
    !registered ||
    selection.user_id !== owner(ctx) ||
    selection.chat_id !== chat(ctx) ||
    selection.session_id !== flow.sessionId ||
    Number(selection.superseded) !== 0 ||
    Number(selection.eligibility) !== 1 ||
    Number(selection.expires_at_ms) <= nowMs()
  )
    return ctx.reply("STALE_OR_INELIGIBLE_V4_POOL_SELECTION");
  const key = JSON.parse(String(selection.pool_key_json)) as V4PoolKey;
  if (!registryMatchesV4Key(registered, key, String(selection.pool_id)))
    return ctx.reply("V4_POOL_KEY_CHANGED");
  const current = await inspectV4Pool(rpc, key);
  if (current.status === "unavailable" || !current.value.initialized || !exactV4PoolState(current.value, key, String(selection.pool_id)))
    return ctx.reply("V4_POOL_ZERO_ACTIVE_LIQUIDITY");
  if (current.value.liquidity <= 0n)
    return ctx.reply("POOL_ZERO_ACTIVE_LIQUIDITY");
  const activeLiquidity = current.value.liquidity > 0n;
  if (activeLiquidity) {
    const cooldownReply = rejectActivePoolCooldown(ctx, flow, String(selection.pool_id));
    if (cooldownReply) return cooldownReply;
  }
  const target = await inspectErc20(
      rpc,
      getAddress(String(selection.target_token)),
    ),
    funding = await inspectErc20(
      rpc,
      getAddress(String(selection.funding_token)),
    );
  if (target.status === "unavailable" || funding.status === "unavailable")
    return ctx.reply("V4_TOKEN_METADATA_UNAVAILABLE");
  const d0 =
      key.currency0.toLowerCase() === target.value.address.toLowerCase()
        ? target.value.decimals
        : funding.value.decimals,
    d1 =
      key.currency1.toLowerCase() === target.value.address.toLowerCase()
        ? target.value.decimals
        : funding.value.decimals;
  let entryPriceGuard: LpEntryPriceGuardResult;
  try {
    entryPriceGuard = await freshLpEntryPriceGuard({
      target: target.value.address,
      poolPriceFundingPerTarget: orientPoolPriceFundingPerTarget({
        priceToken1PerToken0: priceFromSqrtX96(
          current.value.sqrtPriceX96,
          d0,
          d1,
        ),
        token0: key.currency0,
        token1: key.currency1,
        target: target.value.address,
        funding: funding.value.address,
      }),
      fundingUsd: await operationalFundingUsd(tokenInfo(funding.value)),
    });
  } catch (error) {
    return ctx.reply(
      `TOKEN_PRICE_REFERENCE_UNAVAILABLE\n${textError(error)}\nLive entry is blocked.`,
    );
  }
  if (entryPriceGuard.status === "BLOCK") {
    if (entryPriceGuard.blocker === "PRICE_DIVERGENCE_AT_OR_ABOVE_1000_BPS")
      return recordPoolPriceMismatch(
        ctx,
        flow,
        String(selection.pool_id),
        entryPriceGuard,
      );
    return ctx.reply(
      `${formatLpEntryPriceGuard(entryPriceGuard)}\n${entryPriceGuard.blocker}`,
    );
  }
  const next = advanceFlow(
    ctx,
    flow,
    {
      ...flow.state,
      kind: "v4_strategy",
      poolSelectionState: flow.state,
      strategy: undefined,
      v4SelectionId: selectionId,
      poolId: selection.pool_id,
      poolKey: key,
      target: tokenInfo(target.value),
      funding: tokenInfo(funding.value),
      targetIndex: Number(selection.target_index),
      fundingIndex: Number(selection.funding_index),
      entryPriceGuard,
    },
    "immutable persisted v4 PoolKey selected",
  );
  if (!next) return unavailableFlow(ctx, "stale");
  const fee = JSON.parse(String(selection.fee_semantics_json)),
    feeLabel = fee.dynamicFee
      ? "Dynamic"
      : `${Number(fee.displayedFeePercent).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%`;
  return ctx.reply(
    [
      `Selected ${target.value.symbol}/${funding.value.symbol} · v4`,
      `Fee: ${feeLabel}`,
      `Liquidity status: ${activeLiquidity ? "Active" : "NO ACTIVE LIQUIDITY"}`,
      await dexV4PoolLiquidityLine(String(selection.pool_id), key),
      formatLpEntryPriceGuard(entryPriceGuard),
      "Choose strategy.",
    ].join("\n"),
    {
      reply_markup: keyboard(v4SelectedPoolRows(next, selectionId)),
    },
  );
}
async function bidLadderDryRunPreview(ctx: any, enteredAmount?: string) {
  const flow = loadFlow(ctx),
    raw = enteredAmount ?? ctx.match?.trim();
  if (
    !flow ||
    flow.status !== "active" ||
    !canResolveV4BidLadderPool(flow.state)
  )
    return unavailableFlow(ctx, "missing");
  if (!raw) return ctx.reply("Usage: /bid_ladder_preview <funding amount>");
  const funding = flow.state.funding as DisplayToken,
    target = flow.state.target as DisplayToken,
    key = flow.state.poolKey as V4PoolKey,
    wallet = dedicatedWallet().address;
  if (!funding || !target || !key || !wallet)
    return ctx.reply("V4_BID_LADDER_SELECTION_METADATA_INCOMPLETE");
  let total: bigint;
  try {
    total = parseHumanAmount(raw, funding.decimals);
  } catch (error) {
    return ctx.reply(textError(error));
  }
  const current = await inspectV4Pool(rpc, key);
  if (current.status === "unavailable")
    return ctx.reply("V4_BID_LADDER_PREVIEW_UNAVAILABLE");
  if (current.value.initialized && exactV4PoolState(current.value, key, String(flow.state.poolId ?? "")) && current.value.liquidity === 0n)
    return ctx.reply(
      "V4 BID Ladder LIVE preview unavailable\nPool state: NO ACTIVE LIQUIDITY\nThe pool lost active liquidity before creation.\nRetry when liquidity returns.",
    );
  try {
    const preview = previewV4BidLadder({
        pool: current.value,
        funding: { ...funding, address: getAddress(funding.address) },
        target: { ...target, address: getAddress(target.address) },
        totalFundingAmount: total,
        maxDownsideBps: Number(flow.state.maxDownsideBps ?? 5000),
        owner: wallet,
        deadline: BigInt(Math.floor(Date.now() / 1000) + sessionTtlMs / 1000),
        nowMs: nowMs(),
      }),
      snapshot = snapshotV4BidLadderPreview(preview),
      next = advanceFlow(
        ctx,
        flow,
        {
          ...flow.state,
          kind: "v4_bid_ladder_preview",
          bidLadderPreview: snapshot,
        },
        "manual V4 BID ladder dry-run preview",
      );
    if (!next) return unavailableFlow(ctx, "stale");
    return ctx.reply(formatV4BidLadderPreview(preview), {
      reply_markup: keyboard([
        [
          {
            label: "Create DRY RUN ladder",
            data: `bid-ladder-create:${next.sessionId}`,
          },
        ],
        flowControls(next),
      ]),
    });
  } catch (error) {
    return ctx.reply(`V4_BID_LADDER_PREVIEW_REJECTED\n${textError(error)}`);
  }
}
async function bidLadderDirectLiveOnce(ctx: any, enteredAmount?: string, interactive?:{requestId:string;isCurrent:()=>boolean;setProgressMessageId:(messageId:number)=>void}) {
  const flow = loadFlow(ctx), raw = enteredAmount ?? ctx.match?.trim();
  if (!flow || flow.status !== "active" || flow.state.kind !== "v4_bid_ladder_amount")
    return unavailableFlow(ctx, "missing");
  if (!raw) return ctx.reply("Usage: enter a BID Ladder funding amount");
  const funding = flow.state.funding as DisplayToken,
    target = flow.state.target as DisplayToken,
    key = flow.state.poolKey as V4PoolKey,
    wallet = dedicatedWallet().address;
  if (!funding || !target || !key || !wallet)
    return ctx.reply("V4_BID_LADDER_SELECTION_METADATA_INCOMPLETE");
  let total: bigint;
  try { total = parseHumanAmount(raw, funding.decimals); } catch (error) { return ctx.reply(textError(error)); }
  const interactionStartedAtMs=Date.now(),progressStartedAtMs=Date.now(),progress=await ctx.reply("Preparing fresh LIVE preview…"),progressPaintedAtMs=Date.now(),progressMessageId=Number(progress.message_id);
  interactive?.setProgressMessageId(progressMessageId);
  log("telegram_interactive_stage",{interactionId:interactive?.requestId??null,interactionType:"V4_BID_LADDER_AMOUNT_PREVIEW",requestId:interactive?.requestId??null,stage:"PROGRESS_FIRST_PAINT",startedAtMs:progressStartedAtMs,endedAtMs:progressPaintedAtMs,elapsedMs:progressPaintedAtMs-progressStartedAtMs,dbWaitMs:0,rpcWaitMs:0,provider:"telegram",queueWaitMs:0,cache:"MISS",outcome:"PAINTED",messageId:progressMessageId});
  const discardProgress=async()=>{try{await bot.api.deleteMessage(Number(chat(ctx)),progressMessageId);}catch{}};
  const editProgress=async(text:string,rows?:Array<Array<{label:string;data:string}>>)=>bot.api.editMessageText(Number(chat(ctx)),progressMessageId,text,rows?{reply_markup:keyboard(rows)}:undefined);
  if(interactive&&!interactive.isCurrent()){await discardProgress();return;}
  const poolStartedAtMs=Date.now();
  const current = await inspectV4Pool(rpc, key);
  const poolEndedAtMs=Date.now();
  log("telegram_interactive_stage",{interactionId:interactive?.requestId??null,interactionType:"V4_BID_LADDER_AMOUNT_PREVIEW",requestId:interactive?.requestId??null,stage:"SELECTED_POOL_RESOLUTION",startedAtMs:poolStartedAtMs,endedAtMs:poolEndedAtMs,elapsedMs:poolEndedAtMs-poolStartedAtMs,dbWaitMs:0,rpcWaitMs:poolEndedAtMs-poolStartedAtMs,provider:"robinhood-rpc",queueWaitMs:0,cache:"MISS",outcome:current.status.toUpperCase()});
  if(interactive&&!interactive.isCurrent()){await discardProgress();return;}
  if (current.status === "unavailable") return editProgress("V4_BID_LADDER_PREVIEW_UNAVAILABLE");
  if (current.value.initialized && exactV4PoolState(current.value, key, String(flow.state.poolId ?? "")) && current.value.liquidity === 0n)
    return editProgress(
      "V4 BID Ladder LIVE preview unavailable\nPool state: NO ACTIVE LIQUIDITY\nThe pool lost active liquidity before creation.\nRetry when liquidity returns.",
    );
  try {
    const preview = previewV4BidLadder({
        pool: current.value,
        funding: { ...funding, address: getAddress(funding.address) },
        target: { ...target, address: getAddress(target.address) },
        totalFundingAmount: total,
        maxDownsideBps: Number(flow.state.maxDownsideBps ?? 5000),
        owner: wallet,
        deadline: BigInt(Math.floor(Date.now() / 1000) + sessionTtlMs / 1000),
        nowMs: nowMs(),
      }),
      next = advanceFlow(
        ctx,
        flow,
        { ...flow.state, kind: "v4_bid_ladder_preview", bidLadderPreview: snapshotV4BidLadderPreview(preview) },
        "direct LIVE BID ladder created",
      );
    if (!next || (interactive&&!interactive.isCurrent())) { await discardProgress(); return; }
    const persistenceStartedAtMs=Date.now();
    const db = repo();
    try {
      const native = sameAddress(funding.address, robinhoodMainnet.assets.USDG)
        ? 1
        : (await v4BidLadderNativeUsd({ repo: db, rpc })).nativeUsd;
      createV4BidLadderLive(
        db,
        preview,
        (Number(total) / 10 ** funding.decimals) * native,
      );
    } finally { db.close(); }
    const persistenceEndedAtMs=Date.now();
    log("telegram_interactive_stage",{interactionId:interactive?.requestId??null,interactionType:"V4_BID_LADDER_AMOUNT_PREVIEW",requestId:interactive?.requestId??null,stage:"PREVIEW_PLAN_PERSISTED",startedAtMs:persistenceStartedAtMs,endedAtMs:persistenceEndedAtMs,elapsedMs:persistenceEndedAtMs-persistenceStartedAtMs,dbWaitMs:persistenceEndedAtMs-persistenceStartedAtMs,rpcWaitMs:0,provider:"sqlite-wal",queueWaitMs:0,cache:"MISS",outcome:"COMPLETE",ladderId:preview.plan.ladderId});
    return bidLadderLivePreview(ctx, preview.plan.ladderId,{messageId:progressMessageId,requestId:interactive?.requestId??randomUUID(),sessionId:next.sessionId,isCurrent:interactive?.isCurrent,interactionStartedAtMs});
  } catch (error) {
    if (textError(error).includes("V4_BID_LADDER_DEPTH_NOT_REPRESENTABLE")) {
      const retry = advanceFlow(ctx, flow, { ...flow.state, kind: "v4_bid_ladder_depth" }, "BID ladder depth no longer representable");
      if (!retry || (interactive&&!interactive.isCurrent())) { await discardProgress(); return; }
      return editProgress(
        `BID Ladder ${Number(flow.state.maxDownsideBps ?? 0) / 100}% is not representable as 5 distinct V4 ranges for this pool's tick spacing. Choose another max downside.`,
        [bidLadderDepthRows(retry), [{ label: "Custom", data: `bid-ladder-depth:${retry.sessionId}:custom` }], flowControls(retry)],
      );
    }
    if(interactive&&!interactive.isCurrent()){await discardProgress();return;}
    return editProgress(`V4_BID_LADDER_CREATE_REJECTED\n${textError(error)}`);
  }
}
async function bidLadderDirectLive(ctx: any, enteredAmount?: string) {
  const flow = loadFlow(ctx);
  if (!flow || flow.status !== "active") return unavailableFlow(ctx, "missing");
  const key = `${owner(ctx)}:${chat(ctx)}:${flow.sessionId}`,
    updateId=String(ctx.update?.update_id??ctx.message?.message_id??"unknown"),
    existing = bidLadderDirectLiveInFlight.get(key);
  if (existing?.updateId===updateId&&existing.promise) return existing.promise;
  const request:BidLadderInteractiveWork={updateId,generation:(existing?.generation??0)+1};
  bidLadderDirectLiveInFlight.set(key,request);
  if(existing?.progressMessageId)void bot.api.deleteMessage(Number(chat(ctx)),existing.progressMessageId).catch(()=>{});
  const requestId=`${flow.sessionId}:${flow.flowRevision}:${updateId}`,
    work=bidLadderDirectLiveOnce(ctx,enteredAmount,{requestId,isCurrent:()=>bidLadderDirectLiveInFlight.get(key)===request,setProgressMessageId:(messageId)=>{request.progressMessageId=messageId;if(bidLadderDirectLiveInFlight.get(key)!==request)void bot.api.deleteMessage(Number(chat(ctx)),messageId).catch(()=>{});}});
  request.promise=work;
  try { return await work; } finally { if(bidLadderDirectLiveInFlight.get(key)===request)bidLadderDirectLiveInFlight.delete(key); }
}
async function bidLadderStart(ctx: any, selectionId: string) {
  const flow = loadFlow(ctx);
  if (
    !flow ||
    flow.status !== "active" ||
    String(flow.state.v4SelectionId) !== selectionId ||
    flow.state.kind !== "v4_strategy" ||
    flow.state.strategy !== undefined
  )
    return unavailableFlow(ctx, "stale");
  const next = advanceFlow(
    ctx,
    flow,
    selectV4Strategy(flow.state, "BID_LADDER"),
    "manual V4 BID ladder depth requested",
  );
  if (!next) return unavailableFlow(ctx, "stale");
  return ctx.reply("V4 Bid Ladder\nChoose maximum downside.", {
    reply_markup: keyboard([
      bidLadderDepthRows(next),
      [{ label: "Custom", data: `bid-ladder-depth:${next.sessionId}:custom` }],
      flowControls(next),
    ]),
  });
}
function bidLadderDepthRows(flow: TelegramFlowSession) {
  return [-10, -30, -50, -60].map((value) => ({
    label: `${value}%`,
    data: `bid-ladder-depth:${flow.sessionId}:${Math.abs(value) * 100}`,
  }));
}
function preserveBidLadderDepthText(ctx: any, flow: TelegramFlowSession) {
  const refreshed = advanceFlow(ctx, flow, flow.state, "invalid BID ladder max depth text");
  const active = refreshed ?? flow;
  return ctx.reply("Choose one of the available max-downside buttons, or select Custom.", {
    reply_markup: keyboard([
      bidLadderDepthRows(active),
      [{ label: "Custom", data: `bid-ladder-depth:${active.sessionId}:custom` }],
      flowControls(active),
    ]),
  });
}
async function bidLadderSelectDepth(ctx: any, flow: TelegramFlowSession, bps: number, reason: string) {
  const funding = flow.state.funding as DisplayToken,
    target = flow.state.target as DisplayToken,
    key = flow.state.poolKey as V4PoolKey;
  if (!funding || !target || !key) return ctx.reply("V4_BID_LADDER_SELECTION_METADATA_INCOMPLETE");
  const current = await inspectV4Pool(rpc, key);
  if (current.status === "unavailable") return ctx.reply("V4_BID_LADDER_DEPTH_CHECK_UNAVAILABLE");
  if (!current.value.initialized || !exactV4PoolState(current.value, key, String(flow.state.poolId ?? "")))
    return ctx.reply("V4_BID_LADDER_DEPTH_CHECK_UNAVAILABLE");
  if (current.value.liquidity === 0n)
    return ctx.reply(
      [
        "BID Ladder unavailable",
        "Pool state: NO ACTIVE LIQUIDITY",
        "Choose another pool or retry when liquidity returns.",
      ].join("\n"),
      { reply_markup: keyboard([bidLadderDepthRows(flow), [{ label: "Custom", data: `bid-ladder-depth:${flow.sessionId}:custom` }], flowControls(flow)]) },
    );
  const geometry = v4BidLadderGeometry({
    pool: current.value,
    fundingToken: getAddress(funding.address),
    targetToken: getAddress(target.address),
    maxDownsideBps: bps,
  });
  if (!geometry.representable) {
    return ctx.reply(
      `BID Ladder ${bps / 100}% is not representable as 5 distinct V4 ranges for this pool's tick spacing. Choose another max downside.`,
      { reply_markup: keyboard([bidLadderDepthRows(flow), [{ label: "Custom", data: `bid-ladder-depth:${flow.sessionId}:custom` }], flowControls(flow)]) },
    );
  }
  const next = advanceFlow(ctx, flow, selectV4BidLadderDepth(flow.state, bps), reason);
  if (!next) return unavailableFlow(ctx, "stale");
  return ctx.reply(
    `Max downside: ${bps / 100}%\nEnter ${funding.symbol} amount for BID Ladder LIVE preview`,
    { reply_markup: keyboard([flowControls(next)]) },
  );
}
async function bidLadderDepth(ctx: any, sessionId: string, value: string) {
  const flow = loadFlow(ctx, sessionId);
  if (
    !flow ||
    flow.status !== "active" ||
    flow.state.kind !== "v4_bid_ladder_depth"
  )
    return unavailableFlow(ctx, "stale");
  if (value === "custom") {
    const next = advanceFlow(
      ctx,
      flow,
      { ...flow.state, kind: "v4_bid_ladder_custom_depth" },
      "custom BID ladder depth requested",
    );
    return ctx.reply(
      "Enter maximum downside percentage, greater than 0 and below 100.",
      { reply_markup: keyboard([flowControls(next ?? flow)]) },
    );
  }
  const bps = Number(value);
  try {
    return bidLadderSelectDepth(ctx, flow, bps, "BID ladder max depth selected");
  } catch (error) {
    return ctx.reply(textError(error));
  }
}
async function bidLadderReturn(ctx: any, flow: TelegramFlowSession) {
  const next = advanceFlow(
    ctx,
    flow,
    returnToV4SelectedPool(flow.state),
    "return to selected V4 pool options",
  );
  if (!next) return unavailableFlow(ctx, "stale");
  return ctx.reply("Choose strategy.", {
    reply_markup: keyboard(
      v4SelectedPoolRows(next, String(next.state.v4SelectionId)),
    ),
  });
}

async function spotStart(ctx: any, selectionId: string) {
  const flow = loadFlow(ctx);
  if (!flow || flow.status !== "active" || flow.state.kind !== "v4_strategy" || flow.state.strategy !== undefined || String(flow.state.v4SelectionId) !== selectionId)
    return unavailableFlow(ctx, "stale");
  const next = advanceFlow(ctx, flow, selectV4Strategy(flow.state, "SPOT"), "V4 Spot strategy selected");
  if (!next) return unavailableFlow(ctx, "stale");
  return ctx.reply("V4 Spot\nChoose range.", {
    reply_markup: keyboard([...v4RangeButtons(selectionId), flowControls(next)]),
  });
}
async function bidLadderCreate(ctx: any, sessionId: string) {
  const flow = loadFlow(ctx, sessionId);
  if (
    !flow ||
    flow.status !== "active" ||
    flow.state.kind !== "v4_bid_ladder_preview"
  )
    return unavailableFlow(ctx, "stale");
  const snapshot = flow.state.bidLadderPreview as
    V4BidLadderPreviewSnapshot | undefined;
  if (!snapshot) return ctx.reply("V4_BID_LADDER_PREVIEW_MISSING");
  try {
    const preview = restoreV4BidLadderPreview(snapshot),
      db = repo();
    try {
      const stored = createV4BidLadderDryRun(db, preview);
      return ctx.reply(
        [
          "BID Ladder Dry Run Created",
          `ladder_id: ${preview.plan.ladderId}`,
          `pool: ${preview.target.symbol}/${preview.funding.symbol}`,
          `capital: ${formatHumanAmount(preview.plan.totalFundingAmount, preview.funding.decimals)} ${preview.funding.symbol}`,
          "5 legs",
          `status: ${String(stored.ladder.status)}`,
          "No transaction was signed or broadcast.",
        ].join("\n"),
      );
    } finally {
      db.close();
    }
  } catch (error) {
    return ctx.reply(`V4_BID_LADDER_CREATE_REJECTED\n${textError(error)}`);
  }
}
function ladderTokens(
  db: SqliteLedgerRepository,
  parent: Record<string, unknown>,
) {
  const fundingAddress = getAddress(String(parent.funding_token)),
    targetAddress = getAddress(String(parent.target_token)),
    fallback = (address: Address) =>
      address.toLowerCase() === robinhoodMainnet.assets.USDG.toLowerCase()
        ? { symbol: "USDG", decimals: 6 }
        : address.toLowerCase() === robinhoodMainnet.assets.WETH.toLowerCase()
          ? { symbol: "WETH", decimals: 18 }
          : { symbol: "TOKEN", decimals: 18 },
    fundingRow = db.tokenMetadata(fundingAddress),
    targetRow = db.tokenMetadata(targetAddress),
    fundingFallback = fallback(fundingAddress),
    targetFallback = fallback(targetAddress);
  return {
    funding: {
      address: fundingAddress,
      symbol: String(fundingRow?.symbol ?? fundingFallback.symbol),
      decimals: Number(fundingRow?.decimals ?? fundingFallback.decimals),
    },
    target: {
      address: targetAddress,
      symbol: String(targetRow?.symbol ?? targetFallback.symbol),
      decimals: Number(targetRow?.decimals ?? targetFallback.decimals),
    },
  };
}
async function bidLadderView(ctx: any, ladderId: string) {
  if (!ladderId) return ctx.reply("Usage: /bid_ladder_view <ladder_id>");
  const db = repo();
  let parent: Record<string, unknown> | undefined,
    legs: Record<string, unknown>[],
    positions: Record<string, unknown>[] = [],
    tokens;
  try {
    parent = db.loadBidLadder(ladderId);
    if (!parent) return ctx.reply("V4_BID_LADDER_NOT_FOUND");
    legs = db.listBidLadderLegs(ladderId);
    tokens = ladderTokens(db, parent);
    if (String(parent.status) === "OPEN")
      positions = legs.flatMap((leg) => {
        if (leg.token_id === null || leg.token_id === undefined) return [];
        const position = db.v4Position(String(leg.token_id));
        return position ? [position] : [];
      });
  } finally {
    db.close();
  }
  const key: V4PoolKey = {
    currency0: getAddress(String(parent!.currency0)),
    currency1: getAddress(String(parent!.currency1)),
    fee: Number(parent!.fee),
    tickSpacing: Number(parent!.tick_spacing),
    hooks: getAddress(String(parent!.hooks)),
  };
  let current: V4PoolState | undefined,
    unclaimed:
      | { status: "available"; token0: bigint; token1: bigint; rpcRoundTrips: 2; latencyMs: number }
      | { status: "unavailable" } = { status: "unavailable" };
  if (String(parent!.status) === "OPEN") {
    try {
      const batch = await inspectV4ClaimableFeesBatch(
        rpc,
        positions.map((position) => ({
          tokenId: BigInt(String(position.token_id)),
          key,
          tickLower: Number(position.tick_lower),
          tickUpper: Number(position.tick_upper),
          liquidity: BigInt(String(position.liquidity_raw)),
        })),
      );
      unclaimed = { status: "available", ...batch };
      current = batch.pool;
    } catch {
      unclaimed = { status: "unavailable" };
    }
  }
  if (!current) {
    try {
      const inspected = await inspectV4Pool(rpc, key);
      current = inspected.status === "available" ? inspected.value : undefined;
    } catch {
      current = undefined;
    }
  }
  let performance;
  if (String(parent!.status) === "OPEN" && current) {
    try {
      const token0 = sameAddress(tokens!.funding.address, key.currency0)
          ? tokens!.funding
          : tokens!.target,
        token1 = sameAddress(tokens!.funding.address, key.currency1)
          ? tokens!.funding
          : tokens!.target;
      performance = calculateOpenV4BidLadderPerformance({
        parent: parent!,
        legs,
        positions,
        current,
        token0,
        token1,
        unclaimed,
      });
    } catch {
      performance = undefined;
    }
  }
  let marketCapEvidence: { marketCapUsd: number; tokenPriceUsd: number } | undefined;
  try {
    if (!sameAddress(tokens!.funding.address, robinhoodMainnet.assets.USDG)) throw new Error("BID_LADDER_MC_USD_QUOTE_UNAVAILABLE");
    const raw = await gmgnCliJson(["token", "info", "--chain", "robinhood", "--address", tokens!.target.address, "--raw"]),
      observation = normalizeGmgnObservation(raw);
    marketCapEvidence = displayV4BidLadderMarketCapEvidence({raw,observation,targetAddress:tokens!.target.address});
  } catch {
    marketCapEvidence = undefined;
  }
  const actionDb=repo();let repositionAvailable=false,repositionAuthorization:string|undefined,stopAuthorization:string|undefined;
  try{const reset=actionDb.loadBidLadderUsdReset(ladderId);repositionAvailable=bidLadderRepositionActionState(actionDb,ladderId).executable;if(repositionAvailable){repositionAuthorization=randomUUID().replace(/-/g,'').slice(0,18);actionDb.authorizeChainCallback({authorizationId:repositionAuthorization,userId:owner(ctx),chatId:chat(ctx),chainId:4663,protocol:'uniswap_v4',workflowOrPositionId:ladderId,action:'V4_BID_LADDER_REPOSITION_PREVIEW',previewRevision:Number(parent!.revision),walletAddress:dedicatedWallet().address??'',expiresAtMs:Date.now()+sessionTtlMs,idempotencyKey:`v4blrpp:${repositionAuthorization}`});}if(reset&&['CLOSE_CONFIRMED','PRINCIPAL_RECONCILED'].includes(String(reset.phase))&&!reset.next_ladder_id){stopAuthorization=randomUUID().replace(/-/g,'').slice(0,18);actionDb.authorizeChainCallback({authorizationId:stopAuthorization,userId:owner(ctx),chatId:chat(ctx),chainId:4663,protocol:'uniswap_v4',workflowOrPositionId:ladderId,action:'V4_BID_LADDER_REPOSITION_STOP',previewRevision:Number(reset.revision),walletAddress:dedicatedWallet().address??'',expiresAtMs:Date.now()+sessionTtlMs,idempotencyKey:`v4blrps:${stopAuthorization}`});}}finally{actionDb.close();}
  const
    text = formatPersistedV4BidLadder({
      parent: parent!,
      legs,
      funding: tokens!.funding,
      target: tokens!.target,
      current,
      performance,
      marketCapEvidence,
      poolUsdMetricLine: await dexV4PoolLiquidityLine(String(parent!.pool_id), key),
    }),
    mode = String(parent!.execution_mode),
    status = String(parent!.status),
    row = stopAuthorization
      ? [{label:"Stop Replacement Open",data:bidLadderCallback("repositionStop",ladderId,stopAuthorization)}]
      :
      mode === "DRY_RUN" && status === "PLANNED"
        ? [{ label: "Open Live", data: bidLadderCallback("livePreview", ladderId) }]
        : mode === "LIVE" && status === "PLANNED"
          ? [
              legs.some((leg) => leg.open_batch_id)
                ? { label: "Resume Open", data: bidLadderCallback("liveOpen", ladderId) }
                : { label: "Preview Live Open", data: bidLadderCallback("livePreview", ladderId) },
            ]
          : mode === "LIVE" && status === "OPEN"
            ? [
                ...(repositionAvailable
                  ? [
                      {
                        label: "♻️ Reposition",
                        data: bidLadderCallback("repositionPreview", ladderId, repositionAuthorization!),
                      },
                    ]
                  : []),
                {
                  label: "💰 Claim Fees",
                  data: bidLadderCallback("collectPreview", ladderId),
                },
                {
                  label: legs.some((leg) => leg.close_batch_id)
                    ? "Resume Close"
                    : "Close Ladder",
                  data: legs.some((leg) => leg.close_batch_id)
                    ? bidLadderCallback("closeConfirm", ladderId)
                    : bidLadderCallback("closePreview", ladderId),
                },
              ]
            : [];
  return ctx.reply(
    text,
    row.length ? { reply_markup: keyboard([row]) } : undefined,
  );
}
function bidLadderList(ctx: any) {
  const db = repo();
  try {
    const rows = db.listBidLadders();
    if (!rows.length) return ctx.reply("No V4 BID ladder dry-runs.");
    return ctx.reply(
      [
        "V4 BID Ladder DRY RUNS",
        ...rows.map((row) => {
          const tokens = ladderTokens(db, row);
          return `${String(row.ladder_id).slice(0, 14)}… · ${tokens.target.symbol}/${tokens.funding.symbol} · ${String(row.total_funding_amount_raw)} raw · ${new Date(Number(row.created_at_ms)).toISOString()} · ${String(row.status)}`;
        }),
      ].join("\n"),
    );
  } finally {
    db.close();
  }
}
async function ladderLiveContext(
  ctx: any,
  ladderId: string,
  db: SqliteLedgerRepository,
  allowlisted = allowed.has(owner(ctx)),
  reuseConfirmedOpen = false,
): Promise<LadderLiveContext> {
  const parent = db.loadBidLadder(ladderId);
  if (!parent) throw new Error("V4_BID_LADDER_NOT_FOUND");
  const tokens = ladderTokens(db, parent),
    wallet = dedicatedWallet(),
    confirmedOpen = reuseConfirmedOpen
      ? confirmedV4BidLadderOpenTruth(db, ladderId)
      : undefined;
  if (!wallet.address) throw new Error("V4_BID_LADDER_WALLET_REQUIRED");
  const native = confirmedOpen?.projectionComplete
    ? { nativeUsd: 1 }
    : await v4BidLadderNativeUsd({ repo: db, rpc });
  let fundingUsd: number;
  if (sameAddress(tokens.funding.address, robinhoodMainnet.assets.USDG))
    fundingUsd = 1;
  else if (sameAddress(tokens.funding.address, robinhoodMainnet.assets.WETH))
    fundingUsd = native.nativeUsd;
  else throw new Error("V4_FUNDING_PRICE_UNAVAILABLE");
  const context: LadderLiveContext = {
    repo: db,
    rpc,
    ladderId,
    wallet: wallet.address,
    fundingUsd,
    nativeUsd: native.nativeUsd,
    nativeUsdSource: "nativeUsdSource" in native ? native.nativeUsdSource : "confirmed open projection",
    nativeUsdObservedAtMs: "nativeUsdObservedAtMs" in native ? native.nativeUsdObservedAtMs : undefined,
    telemetry: (event, data) => log(event, data),
    runtime: {
      executionEnabled: env.EXECUTION_ENABLED,
      dryRun: env.DRY_RUN,
      emergencyPause: env.EMERGENCY_PAUSE,
      signerConfigured: wallet.signerConfigured,
      allowlisted,
      maxPositionUsd: env.MAX_POSITION_VALUE_USD,
      maxApprovalUsd: env.MAX_APPROVAL_VALUE_USD,
      maxGasUsd: env.MAX_GAS_COST_USD,
      slippageBps: env.MAX_SLIPPAGE_BPS,
    },
  };
  context.entryPriceFetch = async (token) => {
    context.marketCapEvidence = undefined;
    let raw: unknown;
    try {
      const evidence = await fetchCanonicalGmgnEntryPrice(token, {
        invoke: async (args, timeoutMs) => {
          raw = await gmgnCliJson(args, timeoutMs);
          return raw;
        },
      });
      try {
        context.marketCapEvidence = displayV4BidLadderMarketCapEvidence({
          raw,
          observation: normalizeGmgnObservation(raw),
          targetAddress: token,
        });
      } catch {
        context.marketCapEvidence = undefined;
      }
      return evidence;
    } catch (error) {
      context.marketCapEvidence = undefined;
      throw error;
    }
  };
  return context;
}
async function bidLadderLivePreview(ctx: any, ladderId: string, interactive?:{messageId:number;requestId:string;sessionId:string;isCurrent?:()=>boolean;interactionStartedAtMs:number}) {
  const db = repo();
  try {
    const parentForLiquidity=db.loadBidLadder(ladderId),liquidityStartedAtMs=Date.now(),liquidityPromise=parentForLiquidity?dexV4PoolLiquidityLine(String(parentForLiquidity.pool_id),{
        currency0:getAddress(String(parentForLiquidity.currency0)),currency1:getAddress(String(parentForLiquidity.currency1)),fee:Number(parentForLiquidity.fee),tickSpacing:Number(parentForLiquidity.tick_spacing),hooks:getAddress(String(parentForLiquidity.hooks)),
      }).then(value=>({value,elapsedMs:Date.now()-liquidityStartedAtMs})):Promise.resolve({value:"Pool liquidity: Unavailable",elapsedMs:0}),
      contextStartedAtMs=Date.now(),context = await ladderLiveContext(
        ctx,
        ladderId,
        db,
        allowed.has(owner(ctx)),
        true,
      ),
      contextEndedAtMs=Date.now(),previewStartedAtMs=Date.now(),preview = await previewV4BidLadderLive(context),previewEndedAtMs=Date.now(),liquidity=await liquidityPromise,
      buttons = preview.blockers.length
        ? [[{ label: "Retry LIVE Preview", data: bidLadderCallback("livePreview", ladderId) }]]
        : [
            [
              {
                label: "Confirm Live Open",
                data: bidLadderCallback("liveOpen", ladderId),
              },
            ],
          ];
    const text=formatV4BidLadderLivePreview(preview,{poolLiquidityLine:liquidity.value}),currentFlow=interactive?loadFlow(ctx):undefined,
      current=!interactive||(interactive.isCurrent?.()!==false&&currentFlow?.status==="active"&&currentFlow.sessionId===interactive.sessionId);
    log("telegram_interactive_stage",{interactionId:interactive?.requestId??null,interactionType:"V4_BID_LADDER_AMOUNT_PREVIEW",requestId:interactive?.requestId??null,stage:"AUTHORITATIVE_PREVIEW_READY",startedAtMs:previewStartedAtMs,endedAtMs:previewEndedAtMs,elapsedMs:previewEndedAtMs-previewStartedAtMs,dbWaitMs:contextEndedAtMs-contextStartedAtMs,rpcWaitMs:previewEndedAtMs-previewStartedAtMs,provider:"robinhood-rpc+gmgn",queueWaitMs:0,cache:"CANONICAL_FRESH",outcome:preview.blockers.length?"BLOCKED":"READY",ladderId,liquidityMs:liquidity.elapsedMs,totalMs:Date.now()-(interactive?.interactionStartedAtMs??previewStartedAtMs)});
    if(!current){if(interactive)try{await bot.api.deleteMessage(Number(chat(ctx)),interactive.messageId);}catch{}return;}
    const sendStartedAtMs=Date.now();
    const result=interactive
      ? await bot.api.editMessageText(Number(chat(ctx)),interactive.messageId,text,buttons.length?{reply_markup:keyboard(buttons)}:undefined)
      : await ctx.reply(text,buttons.length?{reply_markup:keyboard(buttons)}:undefined);
    log("telegram_interactive_stage",{interactionId:interactive?.requestId??null,interactionType:"V4_BID_LADDER_AMOUNT_PREVIEW",requestId:interactive?.requestId??null,stage:"FINAL_PREVIEW_TELEGRAM_DELIVERY",startedAtMs:sendStartedAtMs,endedAtMs:Date.now(),elapsedMs:Date.now()-sendStartedAtMs,dbWaitMs:0,rpcWaitMs:0,provider:"telegram",queueWaitMs:0,cache:"N/A",outcome:"DELIVERED",ladderId});
    return result;
  } catch (error) {
    if(interactive&&(interactive.isCurrent?.()===false||loadFlow(ctx)?.sessionId!==interactive.sessionId)){try{await bot.api.deleteMessage(Number(chat(ctx)),interactive.messageId);}catch{}return;}
    const text=`V4_BID_LADDER_LIVE_PREVIEW_BLOCKED\n${textError(error)}`,options={reply_markup:keyboard([[{ label: "Retry LIVE Preview", data: bidLadderCallback("livePreview", ladderId) }]])};
    return interactive?bot.api.editMessageText(Number(chat(ctx)),interactive.messageId,text,options):ctx.reply(text,options);
  } finally {
    db.close();
  }
}
async function bidLadderLiveOpenOnce(ctx: any, ladderId: string) {
  const db = repo();
  try {
    const context = await ladderLiveContext(ctx, ladderId, db),
      result = await executeV4BidLadderLiveOpen({
        ...context,
        walletClient: guardedWalletClient(),
      }),
      tokenIds = result.confirmedTokenIds;
    return ctx.reply(
      [
        "V4 BID Ladder V1",
        "LIVE",
        `Ladder: ${ladderId}`,
        "Status: OPEN",
        `Batch tx: ${result.hash}`,
        `TokenIds: ${tokenIds.length ? tokenIds.join(", ") : "refreshing"}`,
        ...(result.postReceiptRecoveryRequired
          ? ["Local projection: refreshing automatically"]
          : []),
      ].join("\n"),
    );
  } catch (error) {
    let authoritativeOpen: ReturnType<typeof confirmedV4BidLadderOpenTruth>;
    try {
      authoritativeOpen = confirmedV4BidLadderOpenTruth(db, ladderId);
    } catch {}
    if (authoritativeOpen && !authoritativeOpen.supersededByConfirmedClose) {
      log("v4_bid_ladder_open_receipt_boundary", {
        ladderId,
        workflowId: ladderId,
        receiptConfirmed: true,
        executionPhase: "POST_RECEIPT_TELEGRAM_RECOVERY",
        sqliteOperation: null,
        retryAttempt: 0,
        retryable: false,
        priorReceiptReuse: true,
        postReceiptRecoveryRequired: true,
        userFacingClassification: "OPEN_REFRESHING",
        duplicateConfirmSuppressed: true,
      });
      return ctx.reply(
        [
          "V4 BID Ladder V1",
          "LIVE",
          `Ladder: ${ladderId}`,
          "Status: OPEN",
          `Batch tx: ${authoritativeOpen.hash}`,
          `TokenIds: ${authoritativeOpen.tokenIds.length ? authoritativeOpen.tokenIds.join(", ") : "refreshing"}`,
          "Local projection: refreshing automatically",
        ].join("\n"),
      );
    }
    const pending = durableReconciliationPendingText(
      error,
      "V4_BID_LADDER_OPEN_RECONCILIATION_PENDING",
      ladderId,
    );
    if (pending) {
      log("v4_bid_ladder_open_receipt_boundary", {
        ladderId,
        workflowId: ladderId,
        receiptConfirmed: false,
        executionPhase: "POST_BROADCAST_RECEIPT_UNRESOLVED",
        sqliteOperation: null,
        retryAttempt: 0,
        retryable: true,
        priorReceiptReuse: false,
        postReceiptRecoveryRequired: false,
        userFacingClassification: "OPEN_RECONCILIATION_PENDING",
        duplicateConfirmSuppressed: false,
      });
      return ctx.reply(pending);
    }
    const sqliteCode = sqliteTransientCode(error);
    log("v4_bid_ladder_open_receipt_boundary", {
      ladderId,
      workflowId: ladderId,
      receiptConfirmed: false,
      executionPhase: "PRE_RECEIPT_FAILED",
      sqliteOperation:
        typeof (error as { operation?: unknown })?.operation === "string"
          ? String((error as { operation: string }).operation)
          : null,
      retryAttempt:
        Number.isSafeInteger((error as { attempts?: unknown })?.attempts)
          ? Number((error as { attempts: number }).attempts)
          : 0,
      retryable: Boolean(sqliteCode),
      priorReceiptReuse: false,
      postReceiptRecoveryRequired: false,
      userFacingClassification: "OPEN_BLOCKED",
      duplicateConfirmSuppressed: false,
      sqliteCode,
    });
    return ctx.reply(`V4_BID_LADDER_LIVE_OPEN_BLOCKED\n${textError(error)}`);
  } finally {
    db.close();
  }
}
async function bidLadderLiveOpen(ctx: any, ladderId: string) {
  const existing = bidLadderLiveOpenInFlight.get(ladderId);
  if (existing) {
    log("v4_bid_ladder_open_receipt_boundary", {
      ladderId,
      workflowId: ladderId,
      receiptConfirmed: false,
      executionPhase: "DUPLICATE_CONFIRM_IN_FLIGHT",
      sqliteOperation: null,
      retryAttempt: 0,
      retryable: false,
      priorReceiptReuse: false,
      postReceiptRecoveryRequired: false,
      userFacingClassification: "OPEN_PENDING",
      duplicateConfirmSuppressed: true,
    });
    return existing;
  }
  const work = bidLadderLiveOpenOnce(ctx, ladderId);
  bidLadderLiveOpenInFlight.set(ladderId, work);
  try {
    return await work;
  } finally {
    bidLadderLiveOpenInFlight.delete(ladderId);
  }
}
async function bidLadderClosePreview(ctx: any, ladderId: string) {
  const db = repo();
  try {
    const context = await ladderLiveContext(ctx, ladderId, db),
      preview = await previewV4BidLadderClose(context),
      buttons = preview.blockers.length
        ? []
        : [
            [
              {
                label: "Confirm Manual Close",
                data: bidLadderCallback("closeConfirm", ladderId),
              },
            ],
          ];
    return ctx.reply(
      formatV4BidLadderClosePreview(preview),
      buttons.length ? { reply_markup: keyboard(buttons) } : undefined,
    );
  } catch (error) {
    return ctx.reply(
      `V4_BID_LADDER_CLOSE_PREVIEW_BLOCKED\n${textError(error)}`,
    );
  } finally {
    db.close();
  }
}
async function bidLadderCloseConfirm(ctx: any, ladderId: string) {
  const db = repo();
  try {
    const context = await ladderLiveContext(ctx, ladderId, db),
      result = await executeV4BidLadderManualClose({
        ...context,
        walletClient: guardedWalletClient(),
      }),
      outputs = result.reconciliation?.aggregateTransfers as {token0:bigint;token1:bigint}|undefined;
    return ctx.reply(
      [
        "V4 BID Ladder V1",
        `Ladder: ${ladderId}`,
        "Status: CLOSED",
        `Batch tx: ${result.hash ?? "not required; all legs already zero"}`,
        `Wallet output token0: ${outputs?.token0 ?? "accounting refreshing"}`,
        `Wallet output token1: ${outputs?.token1 ?? "accounting refreshing"}`,
        "Per-leg principal/fee attribution: unavailable from aggregate TAKE_PAIR",
        "NO SWAP WAS PERFORMED",
        "NFTs remain alive. All assets remain in wallet.",
      ].join("\n"),
    );
  } catch (error) {
    const pending = durableReconciliationPendingText(
      error,
      "V4_BID_LADDER_CLOSE_RECONCILIATION_PENDING",
      ladderId,
    );
    if (pending) return ctx.reply(pending);
    return ctx.reply(`V4_BID_LADDER_CLOSE_BLOCKED\n${textError(error)}`);
  } finally {
    db.close();
  }
}
async function bidLadderCollectPreview(ctx: any, ladderId: string) {
  const db = repo();
  try {
    const context = await ladderLiveContext(ctx, ladderId, db), preview = await previewV4BidLadderCollect(context), authorizationId = randomUUID().replace(/-/g, "").slice(0, 18);
    if (preview.plan && !preview.blockers.length) db.authorizeChainCallback({ authorizationId, userId: owner(ctx), chatId: chat(ctx), chainId: 4663, protocol: "uniswap_v4", workflowOrPositionId: ladderId, action: "V4_BID_LADDER_COLLECT", previewRevision: Number(preview.state.parent.revision), walletAddress: context.wallet, feeEvidenceRevision: JSON.stringify({ blockNumber: preview.fees.pool.blockNumber.toString(), tokenIds: preview.inspected.map((value) => value.tokenId.toString()), token0: preview.fees.token0.toString(), token1: preview.fees.token1.toString() }), expiresAtMs: Date.now() + sessionTtlMs, idempotencyKey: `v4-bid-ladder-collect:${authorizationId}` });
    const buttons = preview.plan && !preview.blockers.length ? [[{ label: "Confirm Claim Fees", data: bidLadderCallback("collectConfirm", ladderId, authorizationId) }], [{ label: "Back", data: bidLadderCallback("view", ladderId) }, { label: "Cancel", data: bidLadderCallback("collectCancel", ladderId) }]] : [[{ label: "Back", data: bidLadderCallback("view", ladderId) }]];
    return ctx.reply(formatV4BidLadderCollectPreview(preview), { reply_markup: keyboard(buttons) });
  } catch (error) { return ctx.reply(`V4_BID_LADDER_COLLECT_PREVIEW_BLOCKED\n${textError(error)}`); } finally { db.close(); }
}
async function bidLadderCollectConfirm(ctx: any, authorizationId: string, ladderId: string) {
  const db = repo();
  try {
    const context = await ladderLiveContext(ctx, ladderId, db), authorization = db.db.prepare("SELECT * FROM chain_callback_authorizations WHERE authorization_id=?").get(authorizationId) as Record<string, unknown> | undefined, stage = `COLLECT_BATCH:${authorizationId}`, existing = db.db.prepare("SELECT 1 FROM chain_transaction_journal WHERE chain_id=4663 AND workflow_identity=? AND semantic_stage=? LIMIT 1").get(ladderId, stage);
    const parent = db.loadBidLadder(ladderId);
    if (!authorization || !parent || String(authorization.user_id) !== owner(ctx) || String(authorization.chat_id) !== chat(ctx) || Number(authorization.chain_id) !== 4663 || String(authorization.protocol) !== "uniswap_v4" || String(authorization.workflow_or_position_id) !== ladderId || String(authorization.action) !== "V4_BID_LADDER_COLLECT" || Number(authorization.preview_revision) !== Number(parent.revision) || String(authorization.wallet_address).toLowerCase() !== context.wallet.toLowerCase() || (!existing && (authorization.consumed_at_ms !== null || Number(authorization.expires_at_ms) <= Date.now()))) throw new Error("V4_BID_LADDER_COLLECT_AUTHORIZATION_INVALID_STALE_OR_MISMATCHED");
    const evidence = JSON.parse(String(authorization.fee_evidence_revision));
    if (!Array.isArray(evidence.tokenIds) || evidence.tokenIds.length !== 5) throw new Error("V4_BID_LADDER_COLLECT_AUTHORIZATION_EVIDENCE_INVALID");
    const result = await executeV4BidLadderCollect({ ...context, walletClient: guardedWalletClient(), collectAuthorizationId: authorizationId, expectedTokenIds: evidence.tokenIds.map(String) });
    db.db.prepare("UPDATE chain_callback_authorizations SET consumed_at_ms=COALESCE(consumed_at_ms,?) WHERE authorization_id=?").run(Date.now(), authorizationId);
    if (result.status === "NO_CLAIMABLE_FEES") return ctx.reply("V4 BID Ladder · CLAIM FEES\nNO CLAIMABLE FEES\nNo transaction was signed or broadcast.");
    return ctx.reply(["V4 BID Ladder · CLAIM FEES", `Ladder: ${ladderId}`, "Status: COLLECTED · accounting refreshing", `Batch tx: ${result.hash}`, "Exact claimed amounts are reconciling in the background.", "NO LIQUIDITY WAS REMOVED", "NO SWAP WAS PERFORMED", "NO NFT WAS BURNED", "ALL CLAIMED FEES REMAIN IN WALLET"].join("\n"));
  } catch (error) {
    const pending = durableReconciliationPendingText(error, "V4_BID_LADDER_COLLECT_RECONCILIATION_PENDING", ladderId);
    if (pending) return ctx.reply(pending);
    return ctx.reply(`V4_BID_LADDER_COLLECT_BLOCKED\n${textError(error)}`);
  } finally { db.close(); }
}
async function bidLadderRepositionPreview(ctx: any, authorizationId:string, ladderId: string) {
  const db = repo();
  try {
    const wallet = dedicatedWallet();
    if (!wallet.address) throw new Error("V4_BID_LADDER_WALLET_REQUIRED");
    const parent = db.loadBidLadder(ladderId);
    if (!parent) throw new Error("V4_BID_LADDER_NOT_FOUND");
    db.consumeChainCallback({authorizationId,userId:owner(ctx),chatId:chat(ctx),chainId:4663,protocol:'uniswap_v4',workflowOrPositionId:ladderId,action:'V4_BID_LADDER_REPOSITION_PREVIEW',previewRevision:Number(parent.revision),walletAddress:wallet.address});
    const tokens = ladderTokens(db, parent);
    let marketCapEvidence: { marketCapUsd: number; tokenPriceUsd: number } | undefined;
    try {
      const raw = await gmgnCliJson([
          "token", "info", "--chain", "robinhood", "--address", tokens.target.address, "--raw",
        ]),
        observation = normalizeGmgnObservation(raw);
      marketCapEvidence = displayV4BidLadderMarketCapEvidence({
        raw,
        observation,
        targetAddress: tokens.target.address,
      });
    } catch {
      marketCapEvidence = undefined;
    }
    const previewBase = await previewV4BidLadderUsdReset({
      repo: db,
      rpc,
      ladderId,
      wallet: wallet.address,
      marketCapEvidence,
    }),liveContext=await ladderLiveContext(ctx,ladderId,db),allowanceReadiness=await v4BidLadderFundingAllowanceReadiness({...liveContext,fundingAmount:previewBase.truth.usdgPrincipal}),preview={...previewBase,allowanceReadiness};
    const confirmAuthorization=randomUUID().replace(/-/g,'').slice(0,18),manualIdentity=`manual-reposition:${owner(ctx)}:${randomUUID()}`,previewCore={block:String(preview.truth.fees.pool.blockNumber),timestamp_ms:Date.now(),revision:Number(parent.revision),pool_key:preview.truth.state.key,token_ids:preview.truth.state.legs.map(leg=>String(leg.token_id))},previewEvidence=JSON.stringify({...previewCore,fingerprint:createHash('sha256').update(JSON.stringify(previewCore)).digest('hex')});
    if(preview.eligible)db.authorizeChainCallback({authorizationId:confirmAuthorization,userId:owner(ctx),chatId:chat(ctx),chainId:4663,protocol:'uniswap_v4',workflowOrPositionId:ladderId,action:allowanceReadiness.ready?'V4_BID_LADDER_REPOSITION_CONFIRM':'V4_BID_LADDER_REPOSITION_ALLOWANCE_PREPARE',previewRevision:Number(parent.revision),walletAddress:wallet.address,exposureRevision:previewEvidence,feeEvidenceRevision:allowanceReadiness.ready?manualIdentity:preview.truth.usdgPrincipal.toString(),expiresAtMs:Date.now()+sessionTtlMs,idempotencyKey:`v4blrp:${confirmAuthorization}`});
    const buttons = preview.eligible&&allowanceReadiness.ready
      ? [
          [{ label: "Confirm Reposition", data: bidLadderCallback("repositionConfirm", ladderId, confirmAuthorization) }],
          [
            { label: "Back", data: bidLadderCallback("view", ladderId) },
            { label: "Cancel", data: bidLadderCallback("repositionCancel", ladderId, confirmAuthorization) },
          ],
        ]
      : preview.eligible
        ? [[{label:'Prepare Reposition Allowance',data:bidLadderCallback('repositionPrepareAllowance',ladderId,confirmAuthorization)}],[{ label: "Back", data: bidLadderCallback("view", ladderId) }]]
        : [[{ label: "Back", data: bidLadderCallback("view", ladderId) }]];
    return ctx.reply(formatV4BidLadderUsdResetPreview(preview), {
      reply_markup: keyboard(buttons),
    });
  } catch (error) {
    return ctx.reply(`V4_BID_LADDER_REPOSITION_PREVIEW_BLOCKED\n${textError(error)}`, {
      reply_markup: keyboard([[{ label: "Back", data: bidLadderCallback("view", ladderId) }]]),
    });
  } finally {
    db.close();
  }
}
async function bidLadderRepositionPrepareAllowance(ctx:any,authorizationId:string,ladderId:string){const db=repo();try{const wallet=dedicatedWallet();if(!wallet.address)throw new Error('V4_BID_LADDER_WALLET_REQUIRED');const parent=db.loadBidLadder(ladderId),authorization=db.db.prepare('SELECT * FROM chain_callback_authorizations WHERE authorization_id=?').get(authorizationId) as Record<string,unknown>|undefined;if(!parent||!authorization||String(authorization.user_id)!==owner(ctx)||String(authorization.chat_id)!==chat(ctx)||String(authorization.workflow_or_position_id)!==ladderId||String(authorization.action)!=='V4_BID_LADDER_REPOSITION_ALLOWANCE_PREPARE'||String(authorization.wallet_address).toLowerCase()!==wallet.address.toLowerCase()||Number(authorization.preview_revision)!==Number(parent.revision)||authorization.consumed_at_ms!==null||Number(authorization.expires_at_ms)<=Date.now())throw new Error('V4_BID_LADDER_REPOSITION_ALLOWANCE_AUTHORIZATION_INVALID_STALE_OR_MISMATCHED');const evidence=JSON.parse(String(authorization.exposure_revision??'')),legs=db.listBidLadderLegs(ladderId);if(!validateV4BidLadderRepositionPreviewEvidence({evidence,parent,legs,nowMs:Date.now()}))throw new Error('V4_BID_LADDER_REPOSITION_PREVIEW_EVIDENCE_INVALID_STALE_OR_MISMATCHED');const amount=BigInt(String(authorization.fee_evidence_revision));db.consumeChainCallback({authorizationId,userId:owner(ctx),chatId:chat(ctx),chainId:4663,protocol:'uniswap_v4',workflowOrPositionId:ladderId,action:'V4_BID_LADDER_REPOSITION_ALLOWANCE_PREPARE',previewRevision:Number(parent.revision),walletAddress:wallet.address,exposureRevision:String(authorization.exposure_revision),feeEvidenceRevision:amount.toString()});await prepareV4BidLadderFundingAllowance({...await ladderLiveContext(ctx,ladderId,db),walletClient:guardedWalletClient(),fundingAmount:amount});const freshAuthorization=randomUUID().replace(/-/g,'').slice(0,18);db.authorizeChainCallback({authorizationId:freshAuthorization,userId:owner(ctx),chatId:chat(ctx),chainId:4663,protocol:'uniswap_v4',workflowOrPositionId:ladderId,action:'V4_BID_LADDER_REPOSITION_PREVIEW',previewRevision:Number(parent.revision),walletAddress:wallet.address,expiresAtMs:Date.now()+sessionTtlMs,idempotencyKey:`v4blrpp:${freshAuthorization}`});return bidLadderRepositionPreview(ctx,freshAuthorization,ladderId);}catch(error){const pending=durableReconciliationPendingText(error,'V4_BID_LADDER_REPOSITION_ALLOWANCE_RECONCILIATION_PENDING',ladderId);if(pending)return ctx.reply(pending);return ctx.reply(`V4_BID_LADDER_REPOSITION_ALLOWANCE_BLOCKED\n${textError(error)}`);}finally{db.close();}}
async function bidLadderRepositionConfirm(ctx: any, authorizationId:string, ladderId: string) {
  const db = repo();
  try {
    const wallet = dedicatedWallet();
    if (!wallet.address) throw new Error("V4_BID_LADDER_WALLET_REQUIRED");
    const parent=db.loadBidLadder(ladderId),authorization=db.db.prepare("SELECT * FROM chain_callback_authorizations WHERE authorization_id=?").get(authorizationId) as Record<string,unknown>|undefined;
    if(!parent||!authorization||String(authorization.user_id)!==owner(ctx)||String(authorization.chat_id)!==chat(ctx)||String(authorization.workflow_or_position_id)!==ladderId||String(authorization.action)!=='V4_BID_LADDER_REPOSITION_CONFIRM'||String(authorization.wallet_address).toLowerCase()!==wallet.address.toLowerCase())throw new Error('V4_BID_LADDER_REPOSITION_AUTHORIZATION_INVALID_STALE_OR_MISMATCHED');
    const manualIdentity=String(authorization.fee_evidence_revision),reset=db.loadBidLadderUsdReset(ladderId),replay=authorization.consumed_at_ms!==null&&String(reset?.close_workflow_identity)===manualIdentity;
    if(!replay&&Number(authorization.preview_revision)!==Number(parent.revision))throw new Error('V4_BID_LADDER_REPOSITION_AUTHORIZATION_INVALID_STALE_OR_MISMATCHED');
    const previewEvidence=String(authorization.exposure_revision??''),evidence=JSON.parse(previewEvidence),legs=db.listBidLadderLegs(ladderId);if(!validateV4BidLadderRepositionPreviewEvidence({evidence,parent,legs,nowMs:Date.now()}))throw new Error('V4_BID_LADDER_REPOSITION_PREVIEW_EVIDENCE_INVALID_STALE_OR_MISMATCHED');
    const confirmAtMs=Date.now();
    if(!replay)db.consumeChainCallback({authorizationId,userId:owner(ctx),chatId:chat(ctx),chainId:4663,protocol:'uniswap_v4',workflowOrPositionId:ladderId,action:'V4_BID_LADDER_REPOSITION_CONFIRM',previewRevision:Number(parent.revision),walletAddress:wallet.address,exposureRevision:previewEvidence,feeEvidenceRevision:manualIdentity,now:confirmAtMs});
    const result = await processV4BidLadderUsdReset(
      {
        repo: db,
        rpc,
        wallet: wallet.address,
        walletClient: guardedWalletClient,
        context: (id) => ladderLiveContext(ctx, id, db),
        manualAuthorizationIdentity: manualIdentity,
        confirmAtMs,
        callerSource: "USER_CONFIRM",
        telemetry: (details) =>
          log("v4_bid_ladder_reposition_single_flight", details),
        notify: (message) =>
          sendFuniMessage(message, "v4_bid_ladder_usdg_reset_reposition"),
      },
      ladderId,
    );
    return ctx.reply(
      `V4 BID Ladder · MANUAL REPOSITION\nLadder: ${ladderId}\nStatus: ${String(result.status)}\nNO SWAP\nNO BURN`,
    );
  } catch (error) {
    const pending = durableReconciliationPendingText(
      error,
      "V4_BID_LADDER_REPOSITION_RECONCILIATION_PENDING",
      ladderId,
    );
    if (pending) return ctx.reply(pending);
    return ctx.reply(`V4_BID_LADDER_REPOSITION_BLOCKED\n${textError(error)}`);
  } finally {
    db.close();
  }
}
async function bidLadderRepositionCancel(ctx:any,authorizationId:string,ladderId:string){
  const db=repo();
  try{
    const wallet=dedicatedWallet(),authorization=db.db.prepare("SELECT * FROM chain_callback_authorizations WHERE authorization_id=?").get(authorizationId) as Record<string,unknown>|undefined,parent=db.loadBidLadder(ladderId),reset=db.loadBidLadderUsdReset(ladderId),journal=db.db.prepare("SELECT status FROM chain_transaction_journal WHERE chain_id=4663 AND workflow_identity=? AND semantic_stage='CLOSE_BATCH' ORDER BY attempt DESC LIMIT 1").get(ladderId) as {status:string}|undefined;
    if(!wallet.address||!authorization||!parent||!reset||String(authorization.user_id)!==owner(ctx)||String(authorization.chat_id)!==chat(ctx)||String(authorization.workflow_or_position_id)!==ladderId||String(authorization.action)!=='V4_BID_LADDER_REPOSITION_CONFIRM'||String(authorization.wallet_address).toLowerCase()!==wallet.address.toLowerCase()||Number(authorization.preview_revision)!==Number(parent.revision)||authorization.consumed_at_ms!==null||Number(authorization.expires_at_ms)<=Date.now())throw new Error('V4_BID_LADDER_REPOSITION_CANCEL_AUTHORIZATION_INVALID_STALE_OR_MISMATCHED');
    if(String(reset.phase)!=='WATCHING'||journal)throw new Error(journal?'REPOSITION_CANCEL_TOO_LATE_TRANSACTION_AUTHORITY_EXISTS':'REPOSITION_CANCEL_TOO_LATE_PHASE_CHANGED');
    db.db.transaction(()=>{db.db.prepare("UPDATE chain_callback_authorizations SET consumed_at_ms=? WHERE authorization_id=? AND consumed_at_ms IS NULL").run(Date.now(),authorizationId);cancelV4BidLadderRepositionPreClose({repo:db,ladderId});})();
    return ctx.reply("Reposition cancelled before CLOSE. No Reposition transaction was signed or broadcast; no replacement child can open.");
  }catch(error){return ctx.reply(`V4_BID_LADDER_REPOSITION_CANCEL_REJECTED\n${textError(error)}\nIf CLOSE authority exists, the source may already be closing or closed; replacement continuation remains authorized.`);}finally{db.close();}
}
async function bidLadderRepositionStop(ctx:any,authorizationId:string,ladderId:string){
  const db=repo();
  try{
    const wallet=dedicatedWallet(),authorization=db.db.prepare("SELECT * FROM chain_callback_authorizations WHERE authorization_id=?").get(authorizationId) as Record<string,unknown>|undefined,reset=db.loadBidLadderUsdReset(ladderId);
    if(!wallet.address||!authorization||!reset||String(authorization.user_id)!==owner(ctx)||String(authorization.chat_id)!==chat(ctx)||String(authorization.workflow_or_position_id)!==ladderId||String(authorization.action)!=='V4_BID_LADDER_REPOSITION_STOP'||String(authorization.wallet_address).toLowerCase()!==wallet.address.toLowerCase()||Number(authorization.preview_revision)!==Number(reset.revision)||authorization.consumed_at_ms!==null||Number(authorization.expires_at_ms)<=Date.now())throw new Error('V4_BID_LADDER_REPOSITION_STOP_AUTHORIZATION_INVALID_STALE_OR_MISMATCHED');
    db.db.transaction(()=>{db.db.prepare("UPDATE chain_callback_authorizations SET consumed_at_ms=? WHERE authorization_id=? AND consumed_at_ms IS NULL").run(Date.now(),authorizationId);stopV4BidLadderReplacementOpen({repo:db,ladderId,expectedRevision:Number(authorization.preview_revision)});})();
    return ctx.reply("Replacement OPEN stopped. The source CLOSE remains final; reconciled principal remains in the wallet and no child was created.");
  }catch(error){return ctx.reply(`V4_BID_LADDER_REPOSITION_STOP_REJECTED\n${textError(error)}\nReplacement OPEN authority may already exist; no authority was revoked.`);}finally{db.close();}
}
async function selectV4Range(ctx: any, selectionId: string, value: string) {
  const flow = loadFlow(ctx);
  if (
    !flow ||
    flow.status !== "active" ||
    flow.state.kind !== "v4_spot_range" ||
    flow.state.strategy !== "SPOT" ||
    String(flow.state.v4SelectionId) !== selectionId
  )
    return unavailableFlow(ctx, "stale");
  let choice;
  try {
    choice = parseV4RangeChoice(value);
  } catch (error) {
    return ctx.reply(textError(error));
  }
  if (choice === "custom") {
    const next = advanceFlow(
      ctx,
      flow,
      { ...flow.state, kind: "v4_custom_downside" },
      "v4 custom downside selected",
    );
    return ctx.reply(
      "Enter start and finish downside percentages as `start,finish`, for example `30,60`.",
      { reply_markup: keyboard([flowControls(next ?? flow)]) },
    );
  }
  return finishV4Range(ctx, flow, choice);
}
async function finishV4Range(
  ctx: any,
  flow: TelegramFlowSession,
  range: { upperDropPct: number; lowerDropPct: number },
) {
  if (flow.state.strategy !== "SPOT") return unavailableFlow(ctx, "stale");
  const wallet = dedicatedWallet().address;
  if (!wallet) return ctx.reply("Dedicated wallet is not configured.");
  const funding = flow.state.funding as DisplayToken,
    target = flow.state.target as DisplayToken,
    key = flow.state.poolKey as V4PoolKey;
  if (!funding || !target || !key)
    return ctx.reply("V4_SELECTION_METADATA_INCOMPLETE");
  if (!sameAddress(funding.address, robinhoodMainnet.assets.USDG))
    return ctx.reply(
      "Transparent range pricing is available only for USDG-only v4 selections.",
    );
  const [balance, pool] = await Promise.all([
    walletBalance(funding.address as Address, wallet),
    inspectV4Pool(rpc, key),
  ]);
  if (pool.status === "unavailable" || pool.value.liquidity <= 0n)
    return ctx.reply("V4_POOL_ZERO_ACTIVE_LIQUIDITY");
  const db = repo();
  let marketMetric;
  try {
    marketMetric = readTrustedMarketMetric(db, target.address);
  } finally {
    db.close();
  }
  const currentPriceUsd = orientedTokenPrice(
      priceFromSqrtX96(
        pool.value.sqrtPriceX96,
        Number(flow.state.targetIndex) === 0
          ? target.decimals
          : funding.decimals,
        Number(flow.state.targetIndex) === 0
          ? funding.decimals
          : target.decimals,
      ),
      Number(flow.state.targetIndex) as 0 | 1,
    ),
    selectionQuote: V4RangeSelectionQuote = {
      currentPriceUsd,
      marketMetric,
      quoteBlock: pool.value.blockNumber,
      quoteTimestampMs: Date.now(),
    },
    pricing = buildV4RangePricing({ ...selectionQuote, range }),
    amountSelection = v4AmountRangeSelection({
      state: flow.state,
      range,
      selectionQuote,
      fundingBalance: balance,
      funding,
      rangePricing: formatV4RangePricing(pricing),
    }),
    next = advanceFlow(
      ctx,
      flow,
      amountSelection.state,
      "generic v4 funding-only range selected",
    );
  if (!next) return unavailableFlow(ctx, "stale");
  return ctx.reply(amountSelection.prompt, {
    reply_markup: keyboard([flowControls(next)]),
  });
}
async function selectPool(ctx: any, sessionId: string, selectionId: string) {
  const flow = loadFlow(ctx, sessionId);
  if (!flow) return unavailableFlow(ctx, "stale");
  if (flow.status === "expired") return unavailableFlow(ctx, "expired");
  const state = flow.state;
  if (
    state.kind !== "pool" ||
    !Array.isArray(state.poolSelections) ||
    !state.poolSelections.includes(selectionId)
  )
    return unavailableFlow(ctx, "stale");
  const db = repo(),
    selection = db.poolSelection(selectionId);
  db.close();
  if (
    !selection ||
    selection.user_id !== owner(ctx) ||
    selection.chat_id !== chat(ctx) ||
    selection.session_id !== sessionId ||
    Number(selection.superseded) !== 0
  )
    return ctx.reply("STALE_POOL_SELECTION");
  if (BigInt(String(selection.liquidity_raw)) <= 0n)
    return ctx.reply("POOL_ZERO_ACTIVE_LIQUIDITY");
  const cooldownReply = rejectActivePoolCooldown(
    ctx,
    flow,
    String(selection.pool_address),
  );
  if (cooldownReply) return cooldownReply;
  const wallet = dedicatedWallet().address;
  if (!wallet) return ctx.reply("Dedicated wallet is not configured.");
  const deployments = await audit();
  if (deployments.status === "unavailable")
    return ctx.reply(`Deployment unavailable: ${deployments.reason}`);
  const poolRead = await inspectV3Pool(
    rpc,
    String(selection.pool_address) as Address,
  );
  if (poolRead.status === "unavailable")
    return ctx.reply(`Pool unavailable: ${poolRead.reason}`);
  if (
    poolRead.value.factory.toLowerCase() !==
      deployments.value.factory.toLowerCase() ||
    poolRead.value.address.toLowerCase() !==
      String(selection.pool_address).toLowerCase()
  )
    return ctx.reply("POOL_SELECTION_MISMATCH");
  if (poolRead.value.fee !== Number(selection.fee))
    return ctx.reply("POOL_FEE_MISMATCH");
  if (poolRead.value.liquidity <= 0n)
    return ctx.reply("POOL_ZERO_ACTIVE_LIQUIDITY");
  const pool = await presentPool(rpc, poolRead.value);
  if (pool.status === "unavailable")
    return ctx.reply(`Pool metadata unavailable: ${pool.reason}`);
  const [balance0, balance1] = await tokenBalances(
      pool.value.token0.address,
      pool.value.token1.address,
      wallet,
    ),
    token0 = tokenInfo(pool.value.token0),
    token1 = tokenInfo(pool.value.token1),
    target =
      String(state.token).toLowerCase() === token0.address.toLowerCase()
        ? token0
        : token1,
    funding =
      target.address.toLowerCase() === token0.address.toLowerCase()
        ? token1
        : token0;
  let entryPriceGuard: LpEntryPriceGuardResult;
  try {
    entryPriceGuard = await freshLpEntryPriceGuard({
      target: getAddress(target.address),
      poolPriceFundingPerTarget: orientPoolPriceFundingPerTarget({
        priceToken1PerToken0: pool.value.priceToken1PerToken0,
        token0: token0.address,
        token1: token1.address,
        target: target.address,
        funding: funding.address,
      }),
      fundingUsd: await operationalFundingUsd(funding),
    });
  } catch (error) {
    return ctx.reply(
      `TOKEN_PRICE_REFERENCE_UNAVAILABLE\n${textError(error)}\nLive entry is blocked.`,
    );
  }
  if (entryPriceGuard.status === "BLOCK") {
    if (entryPriceGuard.blocker === "PRICE_DIVERGENCE_AT_OR_ABOVE_1000_BPS")
      return recordPoolPriceMismatch(
        ctx,
        flow,
        String(selection.pool_address),
        entryPriceGuard,
      );
    return ctx.reply(
      `${formatLpEntryPriceGuard(entryPriceGuard)}\n${entryPriceGuard.blocker}`,
    );
  }
  const next = advanceFlow(
    ctx,
    flow,
    {
      ...state,
      kind: "mode",
      selectionId,
      pool: pool.value.pool.address,
      fee: pool.value.pool.fee,
      token0,
      token1,
      target,
      funding,
      balance0: balance0.toString(),
      balance1: balance1.toString(),
      entryPriceGuard,
    },
    "immutable pool selected",
  );
  if (!next) return unavailableFlow(ctx, "stale");
  const fund = tokenLabel(funding, target);
  return ctx.reply(
    [
      `Selected pool: ${tokenLabel(target, funding)} / ${fund}`,
      `Pool: ${pool.value.pool.address}; fee ${(pool.value.pool.fee / 10_000).toFixed(2)}%; active liquidity ${pool.value.pool.liquidity}`,
      `Target: ${tokenLabel(target, funding)} (${target.address})`,
      `Funding asset: ${fund} (${funding.address})`,
      formatLpEntryPriceGuard(entryPriceGuard),
      "Choose liquidity mode",
    ].join("\n"),
    {
      reply_markup: keyboard([
        [10, 20, 30].map((p) => ({
          label: `${fund}-only ↓${p}%`,
          data: `downside:${next.sessionId}:${p}`,
        })),
        [40, 50, 60].map((p) => ({
          label: `${fund}-only ↓${p}%`,
          data: `downside:${next.sessionId}:${p}`,
        })),
        [
          {
            label: `${fund}-only custom`,
            data: `downside:${next.sessionId}:custom`,
          },
        ],
        [{ label: "Balanced range", data: `balanced:${next.sessionId}:0` }],
        flowControls(next),
      ]),
    },
  );
}
async function selectDownside(
  ctx: any,
  sessionId: string,
  upper: number,
  lower: number,
) {
  const flow = loadFlow(ctx, sessionId);
  if (!flow) return unavailableFlow(ctx, "stale");
  if (flow.status === "expired") return unavailableFlow(ctx, "expired");
  const state = flow.state;
  if (state.kind !== "mode") return unavailableFlow(ctx, "stale");
  try {
    validateDownsidePercentages(upper, lower);
  } catch (error) {
    return ctx.reply(textError(error));
  }
  const funding = state.funding as DisplayToken,
    token0 = state.token0 as DisplayToken,
    balance = BigInt(
      funding.address.toLowerCase() === token0.address.toLowerCase()
        ? String(state.balance0)
        : String(state.balance1),
    ),
    next = advanceFlow(
      ctx,
      flow,
      {
        ...state,
        kind: "amount",
        mode: "SINGLE_SIDED_DOWNSIDE",
        upperDropPct: upper,
        lowerDropPct: lower,
      },
      "single-sided downside selected",
    );
  if (!next) return unavailableFlow(ctx, "stale");
  return ctx.reply(
    amountPrompt(funding, balance, state.target as DisplayToken) +
      `\nSingle-sided downside: starts at −${upper}% and finishes at −${lower}%.`,
    { reply_markup: keyboard([flowControls(next)]) },
  );
}
async function selectRange(ctx: any, sessionId: string, percent: number) {
  const flow = loadFlow(ctx, sessionId);
  if (!flow) return unavailableFlow(ctx, "stale");
  if (flow.status === "expired") return unavailableFlow(ctx, "expired");
  const state = flow.state;
  if (state.kind !== "range") return unavailableFlow(ctx, "stale");
  const token0 = state.token0 as DisplayToken,
    token1 = state.token1 as DisplayToken,
    next = advanceFlow(
      ctx,
      flow,
      { ...state, kind: "asset", percent },
      "range selected",
    );
  if (!next) return unavailableFlow(ctx, "stale");
  return ctx.reply(
    `Range ±${percent}%. Choose the asset amount you will enter:`,
    {
      reply_markup: keyboard([
        [
          {
            label: `Enter ${tokenLabel(token0, token1)} amount`,
            data: `asset:${next.sessionId}:0`,
          },
        ],
        [
          {
            label: `Enter ${tokenLabel(token1, token0)} amount`,
            data: `asset:${next.sessionId}:1`,
          },
        ],
        flowControls(next),
      ]),
    },
  );
}
async function chooseAsset(ctx: any, sessionId: string, index: 0 | 1) {
  const flow = loadFlow(ctx, sessionId);
  if (!flow) return unavailableFlow(ctx, "stale");
  if (flow.status === "expired") return unavailableFlow(ctx, "expired");
  const state = flow.state;
  if (state.kind !== "asset") return unavailableFlow(ctx, "stale");
  const token0 = state.token0 as DisplayToken,
    token1 = state.token1 as DisplayToken,
    selected = index === 0 ? token0 : token1,
    sibling = index === 0 ? token1 : token0,
    balance = BigInt(
      index === 0 ? String(state.balance0) : String(state.balance1),
    ),
    next = advanceFlow(
      ctx,
      flow,
      { ...state, kind: "amount", asset: index },
      "amount side selected",
    );
  if (!next) return unavailableFlow(ctx, "stale");
  return ctx.reply(
    amountPrompt(selected, balance, sibling) +
      `\nThis selection is valid for ${env.TELEGRAM_SESSION_TTL_SECONDS / 60} minutes.`,
    { reply_markup: keyboard([flowControls(next)]) },
  );
}
async function singleSidedPreview(
  ctx: any,
  flow: TelegramFlowSession,
  input: string,
) {
  const state = flow.state,
    target = state.target as DisplayToken,
    funding = state.funding as DisplayToken,
    token0 = state.token0 as DisplayToken,
    token1 = state.token1 as DisplayToken;
  let supplied: bigint;
  try {
    supplied = parseHumanAmount(input, funding.decimals);
  } catch (error) {
    return preserve(ctx, flow, textError(error));
  }
  const refreshedFlow =
      advanceFlow(
        ctx,
        flow,
        { ...state, kind: "amount" },
        "single-sided funding amount entered",
      ) ?? flow,
    wallet = dedicatedWallet().address;
  if (!wallet)
    return preserve(ctx, refreshedFlow, "Dedicated wallet is not configured.");
  const poolRead = await inspectV3Pool(rpc, state.pool as Address);
  if (poolRead.status === "unavailable")
    return preserve(
      ctx,
      refreshedFlow,
      `Pool refresh failed: ${poolRead.reason}`,
    );
  const shown = await presentPool(rpc, poolRead.value);
  if (shown.status === "unavailable")
    return preserve(ctx, refreshedFlow, shown.reason);
  const fundingBalance = await walletBalance(
    funding.address as Address,
    wallet,
  );
  try {
    assertAmountWithinBalance(supplied, fundingBalance);
  } catch {
    return preserve(
      ctx,
      refreshedFlow,
      `Amount exceeds your ${tokenLabel(funding, target)} balance of ${formatHumanAmount(fundingBalance, funding.decimals)}.`,
    );
  }
  const roles = resolveSingleSidedRoles({
      target: { ...target, address: target.address as Address },
      funding: { ...funding, address: funding.address as Address },
      token0: { ...token0, address: token0.address as Address },
      token1: { ...token1, address: token1.address as Address },
    }),
    current =
      roles.targetIndex === 0
        ? shown.value.priceToken1PerToken0
        : 1 / shown.value.priceToken1PerToken0;
  let quote;
  try {
    quote = singleSidedDownsideQuote(shown.value.pool, roles, supplied, {
      currentDisplayedPrice: current,
      upperDropPct: Number(state.upperDropPct),
      lowerDropPct: Number(state.lowerDropPct),
    });
  } catch (error) {
    return preserve(ctx, refreshedFlow, textError(error));
  }
  const deployments = await audit();
  if (deployments.status === "unavailable")
    return preserve(
      ctx,
      refreshedFlow,
      `Deployment verification failed: ${deployments.reason}`,
    );
  const deadline = BigInt(
      Math.floor(Date.now() / 1000) + env.CONFIRMATION_TTL_SECONDS,
    ),
    slippage = BigInt(env.MAX_SLIPPAGE_BPS),
    mint = buildMint(deployments.value, {
      token0: token0.address as Address,
      token1: token1.address as Address,
      fee: shown.value.pool.fee,
      tickLower: quote.tickLower,
      tickUpper: quote.tickUpper,
      amount0Desired: quote.amount0Desired,
      amount1Desired: quote.amount1Desired,
      amount0Min: (quote.amount0Desired * (10_000n - slippage)) / 10_000n,
      amount1Min: (quote.amount1Desired * (10_000n - slippage)) / 10_000n,
      recipient: wallet,
      deadline,
    });
  const approval = buildApproval(
      funding.address as Address,
      deployments.value.positionManager,
      supplied,
    ),
    [currentAllowance, targetAllowance] = await Promise.all([
      walletAllowance(
        funding.address as Address,
        wallet,
        deployments.value.positionManager,
      ),
      walletAllowance(
        target.address as Address,
        wallet,
        deployments.value.positionManager,
      ),
    ]),
    allowance = allowanceSimulationState(currentAllowance, supplied),
    approvalTransactionSimulation = allowance.approvalRequired
      ? await simulateApproval(rpc, wallet, approval)
      : undefined,
    directMintSimulation = allowance.approvalRequired
      ? undefined
      : await simulateBuiltTransaction(rpc, wallet, mint),
    sequentialSimulation:
      | {
          status: string;
          tokenId?: bigint;
          reason?: string;
          artifactPath?: string;
        }
      | undefined = undefined;
  const db = repo();
  try {
    const expiry = new Date(Number(deadline) * 1000).toISOString(),
      approvalResult =
        approvalTransactionSimulation?.status === "available"
          ? `APPROVAL_SIMULATION_SUCCEEDED (gas ${approvalTransactionSimulation.value.gas})`
          : (approvalTransactionSimulation?.reason ?? "Not required"),
      directMintResult = allowance.approvalRequired
        ? "MINT_BLOCKED_UNTIL_APPROVAL"
        : directMintSimulation?.status === "available"
          ? `DIRECT_MINT_SUCCEEDED (gas ${directMintSimulation.value.gas})`
          : explainMintSimulationFailure(
              directMintSimulation?.reason ?? "Unavailable",
            ),
      sequentialResult =
        "Production preview uses authoritative eth_call/estimateGas; fork simulation is CLI-only",
      confirmation = db.createConfirmation({
        action: "SINGLE_SIDED_DOWNSIDE_MINT",
        owner: owner(ctx),
        expiresAt: expiry,
        idempotencyKey: `single-downside:${owner(ctx)}:${shown.value.pool.address}:${quote.currentBlock}:${supplied}:${quote.tickLower}:${quote.tickUpper}`,
        blockNumber: quote.currentBlock.toString(),
        priceObservedAt: new Date().toISOString(),
        payload: {
          strategy: "SINGLE_SIDED_DOWNSIDE",
          roles,
          quote,
          mint,
          fundingApproval: approval,
          targetApproval: "None",
          allowance,
          approvalTransactionSimulation,
          directMintSimulation,
          sequentialSimulation,
        },
      });
    if (!confirmation) throw new Error("failed to persist confirmation");
    const lines = [
      "Single-sided downside preview — NO_BROADCAST / EXECUTION_BLOCKED",
      `Target: ${tokenLabel(target, funding)} (${target.address})`,
      `Funding: ${tokenLabel(funding, target)} (${funding.address})`,
      `Pool: ${shown.value.pool.address}; fee ${shown.value.pool.fee}`,
      `Current price: 1 ${tokenLabel(target, funding)} = ${current} ${tokenLabel(funding, target)}`,
      `Downside: start −${state.upperDropPct}% / finish −${state.lowerDropPct}%`,
      `Requested prices: upper ${quote.requestedUpperPrice}; lower ${quote.requestedLowerPrice}`,
      `Tick-aligned prices: upper ${quote.actualUpperPrice}; lower ${quote.actualLowerPrice}`,
      `Tick range: ${quote.tickLower}–${quote.tickUpper}`,
      `Funding supplied: ${formatHumanAmount(supplied, funding.decimals)} ${tokenLabel(funding, target)}; balance ${formatHumanAmount(fundingBalance, funding.decimals)}`,
      `Target amount required initially: 0; target approval required: None (current target allowance ${formatHumanAmount(targetAllowance, target.decimals)})`,
      `Current ${tokenLabel(funding, target)} allowance to Position Manager: ${formatHumanAmount(allowance.currentAllowance, funding.decimals)}`,
      `Required allowance: ${formatHumanAmount(allowance.requiredAllowance, funding.decimals)} ${tokenLabel(funding, target)}`,
      `Approval required: ${allowance.approvalRequired ? "Yes" : "No"} (${allowance.approvalStatus})`,
      `Approval spender: ${deployments.value.positionManager}; approval amount: ${formatHumanAmount(supplied, funding.decimals)} ${tokenLabel(funding, target)}`,
      `Approval tx simulation: ${approvalResult}`,
      `Approval applied to independent simulation state: ${allowance.approvalAppliedToSimulationState ? "Yes" : "No — eth_call/estimateGas is stateless"}`,
      `Direct mint simulation: ${directMintResult}`,
      `Sequential approval → mint simulation: ${sequentialResult}`,
      `Simulation: production eth_call/estimateGas (no fork artifact)`,
      `Mainnet transactions sent: 0`,
      `Composition: before range 100% ${tokenLabel(funding, target)}; in range progressively converts; below lower boundary may be 100% ${tokenLabel(target, funding)}. Fees accrue only in range.`,
      `Warning: target price may continue falling after full conversion. Slippage ${env.MAX_SLIPPAGE_BPS} bps; deadline ${expiry}.`,
      `Confirmation: ${String(confirmation.id)} (expires ${expiry})`,
    ];
    return ctx.reply(lines.join("\n"), {
      reply_markup: keyboard([
        [
          {
            label: "Acknowledge (execution remains blocked)",
            data: `confirm:${String(confirmation.id)}`,
          },
        ],
        [{ label: "Cancel", data: `cancel:${String(confirmation.id)}` }],
        flowControls(refreshedFlow),
      ]),
    });
  } finally {
    db.close();
  }
}
async function singleSidedLivePreview(
  ctx: any,
  flow: TelegramFlowSession,
  input: string,
) {
  const state = flow.state,
    target = state.target as DisplayToken,
    funding = state.funding as DisplayToken,
    token0 = state.token0 as DisplayToken,
    token1 = state.token1 as DisplayToken;
  let supplied: bigint;
  try {
    supplied = parseHumanAmount(input, funding.decimals);
  } catch (error) {
    return preserve(ctx, flow, textError(error));
  }
  const wallet = dedicatedWallet();
  if (!wallet.address)
    return preserve(ctx, flow, "Dedicated wallet is not configured.");
  if (!state.selectionId) return preserve(ctx, flow, "STALE_POOL_SELECTION");
  const poolRead = await inspectV3Pool(rpc, state.pool as Address);
  if (poolRead.status === "unavailable")
    return preserve(ctx, flow, `Pool refresh failed: ${poolRead.reason}`);
  const shown = await presentPool(rpc, poolRead.value);
  if (shown.status === "unavailable") return preserve(ctx, flow, shown.reason);
  if (shown.value.pool.liquidity <= 0n)
    return preserve(ctx, flow, "POOL_ZERO_ACTIVE_LIQUIDITY");
  const fundingBalance = await walletBalance(
    funding.address as Address,
    wallet.address,
  );
  try {
    assertAmountWithinBalance(supplied, fundingBalance);
  } catch {
    return preserve(
      ctx,
      flow,
      `Amount exceeds your ${tokenLabel(funding, target)} balance of ${formatHumanAmount(fundingBalance, funding.decimals)}.`,
    );
  }
  const roles = resolveSingleSidedRoles({
      target: { ...target, address: target.address as Address },
      funding: { ...funding, address: funding.address as Address },
      token0: { ...token0, address: token0.address as Address },
      token1: { ...token1, address: token1.address as Address },
    }),
    current =
      roles.targetIndex === 0
        ? shown.value.priceToken1PerToken0
        : 1 / shown.value.priceToken1PerToken0,
    quote = singleSidedDownsideQuote(shown.value.pool, roles, supplied, {
      currentDisplayedPrice: current,
      upperDropPct: Number(state.upperDropPct),
      lowerDropPct: Number(state.lowerDropPct),
    }),
    deployments = await audit();
  if (deployments.status === "unavailable")
    return preserve(
      ctx,
      flow,
      `Deployment verification failed: ${deployments.reason}`,
    );
  const sequential = {
    status: "PRODUCTION_ETH_CALL_PREFLIGHT" as const,
    combinedGasUsed: undefined as bigint | undefined,
  };
  const [nativeUsd, gasPriceWei] = await Promise.all([
      nativeUsdPrice(),
      rpc.withClient((client) => client.getGasPrice()),
    ]),
    positionUsd =
      funding.symbol === "USDG"
        ? Number(supplied) / 10 ** funding.decimals
        : nativeUsd === undefined
          ? NaN
          : (Number(supplied) / 10 ** funding.decimals) * nativeUsd;
  if (!Number.isFinite(positionUsd))
    return preserve(
      ctx,
      flow,
      "Reliable USD pricing is unavailable for the selected funding asset.",
    );
  try {
    assertCanaryValue(positionUsd, env.MAX_POSITION_VALUE_USD);
  } catch {
    return preserve(
      ctx,
      flow,
      `Estimated position value $${positionUsd.toFixed(2)} exceeds the $${env.MAX_POSITION_VALUE_USD} canary cap.`,
    );
  }
  const db = repo();
  try {
    const readiness = await walletPreflight(deployments, db, rpc, {
      targetToken: target.address as Address,
      fundingToken: funding.address as Address,
      fundingSymbol: funding.symbol,
      fundingAmount: supplied,
      pool: shown.value.pool.address,
      protocolVersion: "v3",
      combinedGasEstimate: sequential.combinedGasUsed,
      gasPriceWei,
      nativeUsd,
    });
    const selectionId = String(state.selectionId),
      selection = db.poolSelection(selectionId),
      poolValidation =
        selection &&
        selection.session_id === flow.sessionId &&
        selection.user_id === owner(ctx) &&
        selection.chat_id === chat(ctx) &&
        Number(selection.superseded) === 0 &&
        String(selection.pool_address).toLowerCase() ===
          shown.value.pool.address.toLowerCase() &&
        String(selection.factory_address).toLowerCase() ===
          deployments.value.factory.toLowerCase() &&
        String(selection.token0_address).toLowerCase() ===
          shown.value.pool.token0.toLowerCase() &&
        String(selection.token1_address).toLowerCase() ===
          shown.value.pool.token1.toLowerCase() &&
        Number(selection.fee) === shown.value.pool.fee &&
        BigInt(String(selection.liquidity_raw)) > 0n
          ? { ok: true }
          : { ok: false, reason: "POOL_SELECTION_MISMATCH" };
    const safety = safetyPayload(db),
      runtimeConfigurationMatches =
        safety.executionEnabled === env.EXECUTION_ENABLED &&
        safety.dryRun === env.DRY_RUN &&
        safety.emergencyPause === env.EMERGENCY_PAUSE &&
        safety.liveCanaryEnabled === env.LIVE_CANARY_ENABLED,
      evaluation = evaluateCanaryGates({
        executionEnabled: env.EXECUTION_ENABLED,
        dryRun: env.DRY_RUN,
        emergencyPause: env.EMERGENCY_PAUSE,
        liveCanaryEnabled: env.LIVE_CANARY_ENABLED,
        manualPause: safety.manualPause === true,
        runtimeConfigurationMatches,
        allowlisted: allowed.has(owner(ctx)),
        signerConfigured: wallet.signerConfigured,
        chainId: env.RH_CHAIN_ID,
        deploymentVerified: true,
        positionUsd,
        approvalUsd: positionUsd,
        maxPositionUsd: env.MAX_POSITION_VALUE_USD,
        maxApprovalUsd: env.MAX_APPROVAL_VALUE_USD,
        pendingExecutions:
          db.pendingTransactions() +
          db.activeCanaryExecutionCount(wallet.address),
        budgetAvailable: db.canaryBudgetAvailable(),
        openPositions: db
          .listPositions()
          .filter((position) => position.status === "open").length,
        maxOpenPositions: env.LIVE_CANARY_MAX_OPEN_POSITIONS,
        readiness,
        poolValidation,
      });
    log("canary_gate_evaluated", {
      stage: "amount_entry",
      selectionId,
      pool: shown.value.pool.address,
      ...evaluation,
    });
    if (!evaluation.executionReachable)
      return ctx.reply(
        `EXECUTION_BLOCKED\n${evaluation.blockingReasons.join(", ")}\nNo transaction was sent.`,
      );
    const amountText = formatHumanAmount(supplied, funding.decimals),
      summary = [
        `CANARY_STARTED — ${amountText} ${funding.symbol}`,
        `Target: ${target.symbol}`,
        `Funding: ${amountText} ${funding.symbol}`,
        `Pool: ${shown.value.pool.address.slice(0, 10)}...${shown.value.pool.address.slice(-4)}`,
        `Fee: ${(shown.value.pool.fee / 10_000).toFixed(2)}%`,
        `Range: current → -${state.lowerDropPct}%`,
        `Maximum approval: ${amountText} ${funding.symbol}`,
        `Maximum gas: $${env.MAX_GAS_COST_USD}`,
      ].join("\n");
    await ctx.reply(summary);
    const result = await executeDirectAmountCanary({
      repo: db,
      updateId: String(ctx.update?.update_id ?? ctx.message?.message_id),
      messageId: String(ctx.message?.message_id),
      selectionId,
      sessionId: flow.sessionId,
      buttonPool: shown.value.pool.address,
      verifiedFactory: deployments.value.factory,
      userId: owner(ctx),
      chatId: chat(ctx),
      allowlisted: allowed.has(owner(ctx)),
      readiness,
      executionEnabled: env.EXECUTION_ENABLED,
      dryRun: env.DRY_RUN,
      emergencyPause: env.EMERGENCY_PAUSE,
      liveCanaryEnabled: env.LIVE_CANARY_ENABLED,
      signerConfigured: wallet.signerConfigured,
      chainId: env.RH_CHAIN_ID,
      deploymentVerified: true,
      runtimeConfigurationMatches,
      positionUsd,
      approvalUsd: positionUsd,
      maxPositionUsd: env.MAX_POSITION_VALUE_USD,
      maxApprovalUsd: env.MAX_APPROVAL_VALUE_USD,
      openPositions: db
        .listPositions()
        .filter((position) => position.status === "open").length,
      maxOpenPositions: env.LIVE_CANARY_MAX_OPEN_POSITIONS,
      wallet: wallet.address,
      log,
      executorInput: {
        rpc,
        walletClient: guardedWalletClient(),
        wallet: wallet.address,
        owner: owner(ctx),
        pool: shown.value.pool.address,
        target: {
          address: target.address as Address,
          symbol: target.symbol,
          decimals: target.decimals,
        },
        funding: {
          address: funding.address as Address,
          symbol: funding.symbol,
          decimals: funding.decimals,
        },
        fundingAmount: supplied,
        upperDropPct: Number(state.upperDropPct),
        lowerDropPct: Number(state.lowerDropPct),
        slippageBps: env.MAX_SLIPPAGE_BPS,
        deadlineSeconds: env.CONFIRMATION_TTL_SECONDS,
        maxGasUsd: env.MAX_GAS_COST_USD,
        gasUsdPerNative: Number(nativeUsd),
        notify: (message) =>
          message.startsWith("CANARY_STARTED")
            ? Promise.resolve()
            : ctx.reply(message),
      },
    });
    if (result.status === "EXECUTION_BLOCKED")
      return ctx.reply(
        `EXECUTION_BLOCKED\n${result.reason}\nNo transaction was sent.`,
      );
    if (result.status === "ALREADY_PROCESSING_OR_COMPLETED")
      return ctx.reply(
        `This amount message was already processed. Intent: ${result.intentId}`,
      );
    return result;
  } finally {
    db.close();
  }
}
async function singleSidedFinalPreview(
  ctx: any,
  flow: TelegramFlowSession,
  input: string,
) {
  const state = flow.state,
    target = state.target as DisplayToken,
    funding = state.funding as DisplayToken,
    token0 = state.token0 as DisplayToken,
    token1 = state.token1 as DisplayToken;
  let supplied: bigint;
  try {
    supplied = parseHumanAmount(input, funding.decimals);
  } catch (error) {
    return preserve(ctx, flow, textError(error));
  }
  const wallet = dedicatedWallet();
  if (!wallet.address)
    return preserve(ctx, flow, "Dedicated wallet is not configured.");
  if (!state.selectionId) return preserve(ctx, flow, "STALE_POOL_SELECTION");
  const poolRead = await inspectV3Pool(rpc, state.pool as Address);
  if (poolRead.status === "unavailable")
    return preserve(ctx, flow, `Pool refresh failed: ${poolRead.reason}`);
  if (poolRead.value.liquidity <= 0n)
    return preserve(ctx, flow, "POOL_ZERO_ACTIVE_LIQUIDITY");
  const shown = await presentPool(rpc, poolRead.value);
  if (shown.status === "unavailable") return preserve(ctx, flow, shown.reason);
  try {
    assertAmountWithinBalance(
      supplied,
      await walletBalance(funding.address as Address, wallet.address),
    );
  } catch {
    return preserve(ctx, flow, "Funding balance is insufficient.");
  }
  const roles = resolveSingleSidedRoles({
      target: { ...target, address: target.address as Address },
      funding: { ...funding, address: funding.address as Address },
      token0: { ...token0, address: token0.address as Address },
      token1: { ...token1, address: token1.address as Address },
    }),
    current =
      roles.targetIndex === 0
        ? shown.value.priceToken1PerToken0
        : 1 / shown.value.priceToken1PerToken0,
    quote = singleSidedDownsideQuote(shown.value.pool, roles, supplied, {
      currentDisplayedPrice: current,
      upperDropPct: Number(state.upperDropPct),
      lowerDropPct: Number(state.lowerDropPct),
    }),
    deployments = await audit();
  if (deployments.status === "unavailable")
    return preserve(
      ctx,
      flow,
      `Deployment verification failed: ${deployments.reason}`,
    );
  const sequential = {
    status: "PRODUCTION_ETH_CALL_PREFLIGHT" as const,
    combinedGasUsed: undefined as bigint | undefined,
  };
  const [nativeUsd, gasPriceWei] = await Promise.all([
      nativeUsdPrice(),
      rpc.withClient((client) => client.getGasPrice()),
    ]),
    positionUsd =
      funding.symbol === "USDG"
        ? Number(supplied) / 10 ** funding.decimals
        : nativeUsd === undefined
          ? NaN
          : (Number(supplied) / 10 ** funding.decimals) * nativeUsd;
  if (!Number.isFinite(positionUsd) || positionUsd > env.MAX_POSITION_VALUE_USD)
    return preserve(
      ctx,
      flow,
      `Position value exceeds the configured ${env.MAX_POSITION_VALUE_USD} cap.`,
    );
  const db = repo();
  try {
    const readiness = await walletPreflight(deployments, db, rpc, {
        targetToken: target.address as Address,
        fundingToken: funding.address as Address,
        fundingSymbol: funding.symbol,
        fundingAmount: supplied,
        pool: shown.value.pool.address,
        protocolVersion: "v3",
        combinedGasEstimate: sequential.combinedGasUsed,
        gasPriceWei,
        nativeUsd,
      }),
      selectionId = String(state.selectionId),
      selection = db.poolSelection(selectionId),
      poolValidation =
        selection &&
        selection.session_id === flow.sessionId &&
        selection.user_id === owner(ctx) &&
        selection.chat_id === chat(ctx) &&
        Number(selection.superseded) === 0 &&
        String(selection.pool_address).toLowerCase() ===
          shown.value.pool.address.toLowerCase() &&
        String(selection.factory_address).toLowerCase() ===
          deployments.value.factory.toLowerCase() &&
        Number(selection.fee) === shown.value.pool.fee &&
        BigInt(String(selection.liquidity_raw)) > 0n
          ? { ok: true }
          : { ok: false, reason: "POOL_SELECTION_MISMATCH" },
      safety = safetyPayload(db),
      evaluation = evaluateCanaryGates({
        executionEnabled: env.EXECUTION_ENABLED,
        dryRun: env.DRY_RUN,
        emergencyPause: env.EMERGENCY_PAUSE,
        liveCanaryEnabled: env.LIVE_CANARY_ENABLED,
        manualPause: safety.manualPause === true,
        runtimeConfigurationMatches:
          safety.executionEnabled === env.EXECUTION_ENABLED &&
          safety.dryRun === env.DRY_RUN &&
          safety.emergencyPause === env.EMERGENCY_PAUSE &&
          safety.liveCanaryEnabled === env.LIVE_CANARY_ENABLED,
        allowlisted: allowed.has(owner(ctx)),
        signerConfigured: wallet.signerConfigured,
        chainId: env.RH_CHAIN_ID,
        deploymentVerified: true,
        positionUsd,
        approvalUsd: positionUsd,
        maxPositionUsd: env.MAX_POSITION_VALUE_USD,
        maxApprovalUsd: env.MAX_APPROVAL_VALUE_USD,
        pendingExecutions:
          db.pendingTransactions() +
          db.activeCanaryExecutionCount(wallet.address),
        budgetAvailable: db.canaryBudgetAvailable(),
        openPositions: db.listPositions().filter((x) => x.status === "open")
          .length,
        maxOpenPositions: env.LIVE_CANARY_MAX_OPEN_POSITIONS,
        readiness,
        poolValidation,
      });
    if (!evaluation.executionReachable)
      return ctx.reply(
        `EXECUTION_BLOCKED\n${evaluation.blockingReasons.join(", ")}`,
      );
    const amountDisplay = `${formatHumanAmount(supplied, funding.decimals)} ${funding.symbol}`,
      intent = db.createCanaryIntent({
        wallet: wallet.address,
        owner: owner(ctx),
        idempotencyKey: `telegram-final:${owner(ctx)}:${chat(ctx)}:${flow.sessionId}:${selectionId}:${supplied}:${state.upperDropPct}:${state.lowerDropPct}`,
        payload: {
          canary: {
            sessionId: flow.sessionId,
            selectionId,
            pool: shown.value.pool.address,
            fee: shown.value.pool.fee,
            target: {
              address: target.address,
              symbol: target.symbol,
              decimals: target.decimals,
            },
            funding: {
              address: funding.address,
              symbol: funding.symbol,
              decimals: funding.decimals,
            },
            amount: supplied,
            amountDisplay,
            upper: Number(state.upperDropPct),
            lower: Number(state.lowerDropPct),
            positionUsd,
            nativeUsd,
            readiness,
            expiresAt: nowMs() + sessionTtlMs,
            previewRange: {
              tickLower: quote.tickLower,
              tickUpper: quote.tickUpper,
            },
          },
        },
      });
    return ctx.reply(
      [
        `LIVE CANARY READY — awaiting final confirmation`,
        `Target: ${target.symbol}`,
        `Funding: ${amountDisplay}`,
        `Pool: ${shown.value.pool.address}`,
        `Fee: ${(shown.value.pool.fee / 10_000).toFixed(2)}%`,
        `Range: current → -${state.lowerDropPct}%`,
        `Maximum approval: ${amountDisplay}`,
        `Maximum gas: $${env.MAX_GAS_COST_USD}`,
      ].join("\n"),
      {
        reply_markup: keyboard([
          [
            {
              label: "Open Position",
              data: `open-canary:${String(intent.id)}`,
            },
          ],
          [{ label: "Cancel", data: `cancel-flow:${flow.sessionId}` }],
          flowControls(flow),
        ]),
      },
    );
  } finally {
    db.close();
  }
}
async function operationalFundingUsd(funding: DisplayToken, readRpc = rpc) {
  if (sameAddress(funding.address, robinhoodMainnet.assets.USDG)) return 1;
  if (sameAddress(funding.address, robinhoodMainnet.assets.WETH)) {
    const price = await trustedWethUsdReference(readRpc);
    if (price.status === "available") return price.value;
  }
  throw new Error("V4_FUNDING_PRICE_UNAVAILABLE");
}
async function operationalNativeUsd(readRpc = rpc) {
  const price = await trustedWethUsdReference(readRpc);
  if (price.status !== "available")
    throw new Error(`V4_NATIVE_USD_PRICE_UNAVAILABLE:${price.reason}`);
  const observedAtMs = Date.parse(price.observedAt),
    freshUntilMs = nowMs() + 60_000;
  if (
    !Number.isFinite(observedAtMs) ||
    !Number.isFinite(price.value) ||
    price.value <= 0
  )
    throw new Error("V4_NATIVE_USD_PRICE_INVALID");
  return {
    nativeUsd: price.value,
    nativeUsdSource: price.source,
    nativeUsdObservedAtMs: observedAtMs,
    nativeUsdFreshUntilMs: freshUntilMs,
  };
}
function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}
async function v4OpenPreview(
  ctx: any,
  flow: TelegramFlowSession,
  input: string,
) {
  const previewStarted = Date.now(),
    interactionId = randomUUID(),
    target = flow.state.target as DisplayToken,
    funding = flow.state.funding as DisplayToken;
  let amountRaw: bigint;
  try {
    amountRaw = parseHumanAmount(input, funding.decimals);
  } catch (error) {
    return preserve(ctx, flow, textError(error));
  }
  const ackStarted = Date.now();
  await ctx.reply("Preparing final preview...");
  const amountInputAckMs = Date.now() - ackStarted;
  const wallet = dedicatedWallet();
  if (!wallet.address)
    return preserve(ctx, flow, "Dedicated wallet is not configured.");
  const attributed = attributedRpc(rpc, "alchemy", 48),
    previewRpc = attributedRpc(
      rpc,
      "alchemy",
      48,
      attributed.metrics,
      "preview_context",
    ).rpc,
    estimateRpc = attributedRpc(
      rpc,
      "alchemy",
      48,
      attributed.metrics,
      "gas_estimates",
    ).rpc,
    db = repo();
  let databaseMs = 0,
    pricingMs = 0,
    nativeUsdMs = 0,
    telegramReplyMs = 0,
    previewContext:
      | Awaited<ReturnType<typeof prepareV4OperationalPreviewContext>>
      | undefined;
  try {
    const databaseStarted = Date.now(),
      selectionId = String(flow.state.v4SelectionId),
      row = db.v4PoolSelection(selectionId),
      registered = row ? db.v4RegistryPool(String(row.pool_id)) : undefined;
    databaseMs += Date.now() - databaseStarted;
    if (
      !row ||
      !registered ||
      String(row.user_id) !== owner(ctx) ||
      String(row.chat_id) !== chat(ctx) ||
      String(row.session_id) !== flow.sessionId ||
      Number(row.superseded) !== 0 ||
      Number(row.eligibility) !== 1 ||
      Number(row.expires_at_ms) <= nowMs()
    )
      return ctx.reply("V4_POOL_SELECTION_MISMATCH");
    const key = JSON.parse(String(row.pool_key_json)) as V4PoolKey;
    if (!registryMatchesV4Key(registered, key, String(row.pool_id)))
      return ctx.reply("V4_POOL_KEY_CHANGED");
    try {
      assertAmountWithinBalance(
        amountRaw,
        BigInt(String(flow.state.fundingBalance)),
      );
    } catch {
      return preserve(ctx, flow, "Funding balance is insufficient.");
    }
    const range = {
      upperDropPct: Number(flow.state.upperDropPct),
      lowerDropPct: Number(flow.state.lowerDropPct),
    };
    validateV4DownsideRange(range);
    const genericSelection = {
      poolId: String(row.pool_id),
      key,
      target: getAddress(target.address),
      funding: getAddress(funding.address),
      targetIndex: Number(row.target_index) as 0 | 1,
      fundingIndex: Number(row.funding_index) as 0 | 1,
      amount: amountRaw,
      targetSymbol: target.symbol,
      fundingSymbol: funding.symbol,
      targetDecimals: target.decimals,
      fundingDecimals: funding.decimals,
      feeSemantics: JSON.parse(String(row.fee_semantics_json)),
      hookStatus: JSON.parse(String(row.hook_status_json)),
      valuationProvenance: JSON.parse(String(row.valuation_snapshot_json)),
      selectionId,
    };
    const pricingStarted = Date.now();
    previewContext = await prepareV4OperationalPreviewContext({
      rpc: previewRpc,
      wallet: wallet.address,
      selection: genericSelection,
      staticVerificationPrewarmed: v4PreviewStaticPrewarmInitiated,
    });
    pricingMs = Date.now() - pricingStarted;
    nativeUsdMs = pricingMs;
    const nativePrice = previewContext.nativeUsd,
      fundingUsd = sameAddress(funding.address, robinhoodMainnet.assets.USDG)
        ? 1
        : sameAddress(funding.address, robinhoodMainnet.assets.WETH)
          ? nativePrice.nativeUsd
          : NaN,
      positionUsd = (Number(amountRaw) / 10 ** funding.decimals) * fundingUsd;
    if (
      !Number.isFinite(positionUsd) ||
      positionUsd > env.MAX_POSITION_VALUE_USD
    )
      return preserve(
        ctx,
        flow,
        "Reliable funding USD valuation is unavailable or exceeds the configured cap.",
      );
    const observedAt = nowMs(),
      expiresAt = nowMs() + sessionTtlMs;
    const common = {
      repo: db,
      rpc: estimateRpc,
      wallet: wallet.address,
      runtime: {
        executionEnabled: env.EXECUTION_ENABLED,
        dryRun: env.DRY_RUN,
        emergencyPause: env.EMERGENCY_PAUSE,
        signerConfigured: wallet.signerConfigured,
        allowlisted: allowed.has(owner(ctx)),
      },
      maxPositionUsd: env.MAX_POSITION_VALUE_USD,
      maxApprovalUsd: env.MAX_APPROVAL_VALUE_USD,
      maxTxGasUsd: env.MAX_GAS_COST_USD,
      maxLifecycleGasUsd: env.MAX_LIFECYCLE_GAS_USD,
      slippageBps: env.MAX_SLIPPAGE_BPS,
      maxSlippageBps: env.MAX_SLIPPAGE_BPS,
      range,
      selection: genericSelection,
      nativeUsd: nativePrice.nativeUsd,
      nativeUsdSource: nativePrice.nativeUsdSource,
      nativeUsdObservedAtMs: nativePrice.nativeUsdObservedAtMs,
      nativeUsdFreshUntilMs: nativePrice.nativeUsdFreshUntilMs,
      fundingUsd,
      priceObservedAtMs: observedAt,
      priceFreshUntilMs: expiresAt,
      previewContext,
      telemetryIntentId: `preview:${flow.sessionId}:${selectionId}`,
      log,
    };
    const preflight = await v4OperationalOpenPreflight(common);
    log("v4_execution_eligibility", {
      stage: "final_preview",
      poolId: genericSelection.poolId,
      gate: preflight.gate,
      executor: "executeV4OperationalOpen",
    });
    if (!preflight.gate.executionReachable) {
      const replyStarted = Date.now(),
        reply = await ctx.reply(
          `V4_EXECUTION_BLOCKED\n${preflight.gate.reasons.join(", ")}\nNo transaction was sent.`,
        );
      telegramReplyMs = Date.now() - replyStarted;
      const calls = attributed.finish(),
        t = preflight.timing as Record<string, number | boolean>;
      log("v4_amount_preview_telemetry", {
        interactionId,
        amountInputAckMs,
        deploymentCacheMs: Number(t.deploymentCacheMs ?? 0),
        deploymentCacheHit: Boolean(t.deploymentCacheHit),
        staticVerificationPrewarmed: Boolean(t.staticVerificationPrewarmed),
        sharedBlockNumber: Number(t.sharedBlockNumber ?? 0),
        dynamicMulticallCount: Number(t.dynamicMulticallCount ?? 0),
        dynamicMulticallMembers: Number(t.dynamicMulticallMembers ?? 0),
        canonicalPriceCacheHit: Boolean(t.canonicalPriceCacheHit),
        duplicateReadsEliminated:
          previewContext?.duplicateReadsEliminated ?? [],
        rpcCountsByStage: calls.byStage,
        tokenMetadataMs: 0,
        balanceMs: Number(t.balanceMs ?? 0),
        allowanceMs: Number(t.allowanceMs ?? 0),
        poolStateMs: Number(t.poolStateMs ?? 0),
        pricingMs,
        nativeUsdMs,
        nativeUsdNestedInPricing: true,
        approvalEstimateMs: Number(t.approvalEstimateMs ?? 0),
        mintEstimateMs: Number(t.mintEstimateMs ?? 0),
        lifecycleProjectionMs: Number(t.lifecycleProjectionMs ?? 0),
        databaseMs: databaseMs + Number(t.databaseMs ?? 0),
        telegramReplyMs,
        totalPreviewMs: Date.now() - previewStarted,
        rpcMethodCounts: calls,
        verdict: "EXECUTION_BLOCKED",
        historyReconstructionCount: 0,
        walletWideSyncCount: 0,
        anvilInvocationCount: 0,
        mainnetTransactionsSent: 0,
      });
      return reply;
    }
    const baseIdempotencyKey = `telegram-v4-open:${owner(ctx)}:${chat(ctx)}:${flow.sessionId}:${selectionId}:${amountRaw}:${range.upperDropPct}:${range.lowerDropPct}`,
      prior = db.db
        .prepare(
          "SELECT state FROM v4_live_open_intents WHERE idempotency_key=?",
        )
        .get(baseIdempotencyKey) as { state?: string } | undefined,
      previewAttemptId =
        prior &&
        (prior.state === "FAILED" || prior.state === "FAILED_RETRYABLE")
          ? randomUUID()
          : undefined,
      idempotencyKey = previewAttemptId
        ? `${baseIdempotencyKey}:retry:${previewAttemptId}`
        : baseIdempotencyKey;
    const targetIndex = Number(row.target_index) as 0 | 1,
      d0 = targetIndex === 0 ? target.decimals : funding.decimals,
      d1 = targetIndex === 0 ? funding.decimals : target.decimals,
      poolAvailability = previewContext?.pool;
    if (!poolAvailability || poolAvailability.status !== "available")
      throw new Error("V4_PREVIEW_POOL_UNAVAILABLE");
    const currentPriceUsd = orientedTokenPrice(
        priceFromSqrtX96(poolAvailability.value.sqrtPriceX96, d0, d1),
        targetIndex,
      ),
      upperTick =
        targetIndex === 0
          ? preflight.range.tickUpper
          : preflight.range.tickLower,
      lowerTick =
        targetIndex === 0
          ? preflight.range.tickLower
          : preflight.range.tickUpper,
      upperPriceUsd = orientedTokenPrice(
        priceFromSqrtX96(sqrtPriceAtTick(upperTick), d0, d1),
        targetIndex,
      ),
      lowerPriceUsd = orientedTokenPrice(
        priceFromSqrtX96(sqrtPriceAtTick(lowerTick), d0, d1),
        targetIndex,
      ),
      marketMetric = readTrustedMarketMetric(db, target.address),
      selectedRaw = flow.state.rangeSelectionQuote as
        V4RangeSelectionQuote | undefined,
      selected = selectedRaw
        ? { ...selectedRaw, quoteBlock: BigInt(String(selectedRaw.quoteBlock)) }
        : undefined,
      rangePricing = buildV4RangePricing({
        currentPriceUsd,
        range,
        marketMetric,
        quoteBlock: poolAvailability.value.blockNumber,
        quoteTimestampMs: Number(previewContext.sharedBlock.timestamp) * 1000,
        upperPriceUsd,
        lowerPriceUsd,
        selected,
        recalculated: true,
      });
    const persistStarted = Date.now(),
      intent = db.createV4LiveOpenIntent({
        idempotencyKey,
        owner: wallet.address,
        userId: owner(ctx),
        chatId: chat(ctx),
        poolId: genericSelection.poolId,
        poolKey: key,
        amount: amountRaw,
        payload: {
          selectionId,
          sessionId: flow.sessionId,
          previewAttemptId,
          rangeRequest: range,
          expiresAt,
          genericSelection,
          fundingUsd,
          priceObservedAtMs: observedAt,
          preflight,
          rangePricing,
          executor: "executeV4OperationalOpen",
        },
      });
    databaseMs += Date.now() - persistStarted;
    const fee = genericSelection.feeSemantics.dynamicFee
        ? "Dynamic"
        : `${genericSelection.feeSemantics.displayedFeePercent}%`,
      replyStarted = Date.now(),
      reply = await ctx.reply(
        [
          `V4 position preview`,
          `Pair: ${target.symbol}/${funding.symbol} · v4`,
          `Fee: ${fee}`,
          `Liquidity status: Active`,
          `Capital: ${formatHumanAmount(amountRaw, funding.decimals)} ${funding.symbol}`,
          formatV4RangePricing(rangePricing),
          "",
          `Target required: 0 ${target.symbol}`,
        ].join("\n"),
        {
          reply_markup: keyboard([
            [{ label: "Open Position", data: `v4-open:${String(intent.id)}` }],
            [
              {
                label: "Technical details",
                data: `v4-open-technical:${String(intent.id)}`,
              },
            ],
            [{ label: "Cancel", data: `cancel-flow:${flow.sessionId}` }],
            flowControls(flow),
          ]),
        },
      );
    telegramReplyMs = Date.now() - replyStarted;
    const calls = attributed.finish(),
      totalPreviewMs = Date.now() - previewStarted,
      t = preflight.timing as Record<string, number | boolean>;
    log("v4_amount_preview_telemetry", {
      interactionId,
      amountInputAckMs,
      deploymentCacheMs: Number(t.deploymentCacheMs ?? 0),
      deploymentCacheHit: Boolean(t.deploymentCacheHit),
      staticVerificationPrewarmed: Boolean(t.staticVerificationPrewarmed),
      sharedBlockNumber: Number(t.sharedBlockNumber ?? 0),
      dynamicMulticallCount: Number(t.dynamicMulticallCount ?? 0),
      dynamicMulticallMembers: Number(t.dynamicMulticallMembers ?? 0),
      canonicalPriceCacheHit: Boolean(t.canonicalPriceCacheHit),
      duplicateReadsEliminated: previewContext?.duplicateReadsEliminated ?? [],
      rpcCountsByStage: calls.byStage,
      tokenMetadataMs: 0,
      balanceMs: Number(t.balanceMs ?? 0),
      allowanceMs: Number(t.allowanceMs ?? 0),
      poolStateMs: Number(t.poolStateMs ?? 0),
      pricingMs,
      nativeUsdMs,
      nativeUsdNestedInPricing: true,
      approvalEstimateMs: Number(t.approvalEstimateMs ?? 0),
      mintEstimateMs: Number(t.mintEstimateMs ?? 0),
      lifecycleProjectionMs: Number(t.lifecycleProjectionMs ?? 0),
      databaseMs: databaseMs + Number(t.databaseMs ?? 0),
      telegramReplyMs,
      totalPreviewMs,
      rpcMethodCounts: calls,
      historyReconstructionCount: 0,
      walletWideSyncCount: 0,
      anvilInvocationCount: 0,
      mainnetTransactionsSent: 0,
    });
    return reply;
  } catch (error) {
    const replyStarted = Date.now(),
      reply = await ctx.reply(`V4_EXECUTION_BLOCKED\n${textError(error)}`);
    telegramReplyMs = Date.now() - replyStarted;
    const calls = attributed.finish();
    log("v4_amount_preview_telemetry", {
      interactionId,
      amountInputAckMs,
      staticVerificationPrewarmed: v4PreviewStaticPrewarmInitiated,
      sharedBlockNumber: previewContext
        ? Number(previewContext.sharedBlock.number)
        : 0,
      dynamicMulticallCount: previewContext?.dynamicMulticallCount ?? 0,
      dynamicMulticallMembers: previewContext?.dynamicMulticallMembers ?? 0,
      canonicalPriceCacheHit: previewContext?.nativeUsd.cacheHit ?? false,
      duplicateReadsEliminated: previewContext?.duplicateReadsEliminated ?? [],
      rpcCountsByStage: calls.byStage,
      tokenMetadataMs: 0,
      databaseMs,
      pricingMs,
      nativeUsdMs,
      nativeUsdNestedInPricing: true,
      telegramReplyMs,
      totalPreviewMs: Date.now() - previewStarted,
      rpcMethodCounts: calls,
      verdict: "BOUNDED_ERROR",
      historyReconstructionCount: 0,
      walletWideSyncCount: 0,
      anvilInvocationCount: 0,
      mainnetTransactionsSent: 0,
    });
    return reply;
  } finally {
    db.close();
  }
}

async function v4OpenConfirm(ctx: any, intentId: string) {
  const db = repo();
  try {
    const row = db.v4LiveOpenIntent(intentId);
    if (!row) return ctx.reply("Preview expired, create a new preview.");
    if (
      String(row.telegram_user_id) !== owner(ctx) ||
      String(row.telegram_chat_id) !== chat(ctx)
    )
      return ctx.reply("V4_INTENT_OWNER_MISMATCH");
    const payload = JSON.parse(String(row.payload_json));
    if (
      Number(payload.expiresAt) <= nowMs() &&
      String(row.state) === "PREVIEWED"
    )
      return ctx.reply("Preview expired, create a new preview.");
    const persisted = db.v4PoolSelection(String(payload.selectionId)),
      registry = persisted
        ? db.v4RegistryPool(String(persisted.pool_id))
        : undefined,
      persistedKey = persisted
        ? (JSON.parse(String(persisted.pool_key_json)) as V4PoolKey)
        : undefined;
    if (
      !persisted ||
      !registry ||
      !persistedKey ||
      !registryMatchesV4Key(
        registry,
        persistedKey,
        String(persisted.pool_id),
      ) ||
      Number(persisted.superseded) !== 0 ||
      Number(persisted.eligibility) !== 1 ||
      String(persisted.user_id) !== owner(ctx) ||
      String(persisted.chat_id) !== chat(ctx) ||
      String(persisted.pool_id).toLowerCase() !==
        String(row.pool_id).toLowerCase() ||
      String(persisted.pool_key_json).toLowerCase() !==
        String(row.pool_key_json).toLowerCase()
    )
      return ctx.reply("V4_POOL_SELECTION_MISMATCH");
    const wallet = dedicatedWallet();
    if (!wallet.address)
      return ctx.reply("Dedicated wallet is not configured.");
    const raw = payload.genericSelection,
      genericSelection = {
        ...raw,
        key: persistedKey,
        target: getAddress(raw.target),
        funding: getAddress(raw.funding),
        amount: BigInt(String(row.amount_raw)),
      };
    const [fundingUsd, nativePrice] = await Promise.all([
      operationalFundingUsd({
        address: genericSelection.funding,
        symbol: String(genericSelection.fundingSymbol),
        decimals: Number(genericSelection.fundingDecimals),
      }),
      operationalNativeUsd(),
    ]);
    await ctx.reply(`V4_POSITION_STARTED — ${genericSelection.fundingSymbol}`);
    const observedAt = nowMs(),
      result = await executeV4OperationalOpen({
        repo: db,
        rpc,
        wallet: wallet.address,
        walletClient: guardedWalletClient(),
        runtime: {
          executionEnabled: env.EXECUTION_ENABLED,
          dryRun: env.DRY_RUN,
          emergencyPause: env.EMERGENCY_PAUSE,
          signerConfigured: wallet.signerConfigured,
          allowlisted: allowed.has(owner(ctx)),
        },
        maxPositionUsd: env.MAX_POSITION_VALUE_USD,
        maxApprovalUsd: env.MAX_APPROVAL_VALUE_USD,
        maxTxGasUsd: env.MAX_GAS_COST_USD,
        maxLifecycleGasUsd: env.MAX_LIFECYCLE_GAS_USD,
        slippageBps: env.MAX_SLIPPAGE_BPS,
        maxSlippageBps: env.MAX_SLIPPAGE_BPS,
        range: payload.rangeRequest,
        selection: genericSelection,
        ...nativePrice,
        fundingUsd,
        priceObservedAtMs: observedAt,
        priceFreshUntilMs: observedAt + 60_000,
        intentId: String(row.id),
        idempotencyKey: String(row.idempotency_key),
        log,
        notify: (state, details) =>
          ctx.reply(
            `${state}${details ? "\n" + JSON.stringify(details, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : ""}`,
          ),
      });
    if (
      result.status === "ALREADY_PROCESSING" ||
      result.status === "ALREADY_COMPLETED"
    )
      return ctx.reply(result.status);
    if (result.status === "EXECUTION_BLOCKED")
      return ctx.reply(
        `V4_EXECUTION_BLOCKED\n${result.reasons.join(", ")}\nNo transaction was sent.`,
      );
    if (result.status === "POSITION_RECONCILED")
      return ctx.reply(
        `V4_POSITION_OPENED\nToken ID: ${result.tokenId}\nReceipts and accounting reconciled.`,
      );
    if (result.status === "OPEN_RECONCILIATION_PENDING")
      return ctx.reply(`V4_POSITION_OPENED\nStatus: OPEN / refreshing\nToken ID: ${result.tokenId}\nTx: ${result.mintHash}`);
    return ctx.reply(
      `V4_OPEN_FAILED\nunexpected operational status ${(result as any).status}`,
    );
  } catch (error) {
    return ctx.reply(`V4_OPEN_FAILED\n${textError(error)}`);
  } finally {
    db.close();
  }
}
async function addPreview(ctx: any, input: string) {
  const flow = loadFlow(ctx);
  if (!flow) {
    const latest = loadLatestFlow(ctx);
    return unavailableFlow(
      ctx,
      latest?.status === "expired" ? "expired" : "missing",
    );
  }
  const state = flow.state;
  if (state.kind === "v4_amount") return v4OpenPreview(ctx, flow, input);
  if (state.kind !== "amount") return unavailableFlow(ctx, "stale");
  if (state.mode === "SINGLE_SIDED_DOWNSIDE")
    return singleSidedFinalPreview(ctx, flow, input);
  const asset = Number(state.asset) as 0 | 1,
    percent = Number(state.percent),
    token0 = state.token0 as DisplayToken,
    token1 = state.token1 as DisplayToken,
    selected = asset === 0 ? token0 : token1,
    sibling = asset === 0 ? token1 : token0;
  let supplied: bigint;
  try {
    supplied = parseHumanAmount(input, selected.decimals);
  } catch (error) {
    return preserve(ctx, flow, textError(error));
  }
  const refreshedFlow =
    advanceFlow(
      ctx,
      flow,
      { ...state, kind: "amount" },
      "valid amount entered",
    ) ?? flow;
  const wallet = dedicatedWallet().address;
  if (!wallet)
    return preserve(ctx, refreshedFlow, "Dedicated wallet is not configured.");
  const poolRead = await inspectV3Pool(rpc, state.pool as Address);
  if (poolRead.status === "unavailable")
    return preserve(
      ctx,
      refreshedFlow,
      `Pool refresh failed: ${poolRead.reason}`,
    );
  const pool = await presentPool(rpc, poolRead.value);
  if (pool.status === "unavailable")
    return preserve(ctx, refreshedFlow, `Pool display failed: ${pool.reason}`);
  const [balance0, balance1] = await tokenBalances(
      pool.value.token0.address,
      pool.value.token1.address,
      wallet,
    ),
    currentSelected = asset === 0 ? balance0 : balance1;
  try {
    assertAmountWithinBalance(supplied, currentSelected);
  } catch {
    return preserve(
      ctx,
      refreshedFlow,
      `Amount exceeds your ${tokenLabel(selected, sibling)} balance of ${formatHumanAmount(currentSelected, selected.decimals)}.`,
    );
  }
  const range = rangeFromPercent(
      pool.value.priceToken1PerToken0,
      percent,
      pool.value.token0.decimals,
      pool.value.token1.decimals,
      pool.value.pool.tickSpacing,
    ),
    large = 2n ** 128n,
    quote =
      asset === 0
        ? balancedRangeQuote(
            pool.value.pool,
            range.tickLower,
            range.tickUpper,
            supplied,
            large,
          )
        : balancedRangeQuote(
            pool.value.pool,
            range.tickLower,
            range.tickUpper,
            large,
            supplied,
          );
  if (!quote.requiredAmount0 || !quote.requiredAmount1)
    return preserve(
      ctx,
      refreshedFlow,
      "This range is single-sided at the current price; choose a range containing the current price.",
    );
  if (quote.requiredAmount0 > balance0 || quote.requiredAmount1 > balance1)
    return preserve(
      ctx,
      refreshedFlow,
      `The required paired amount exceeds your wallet balance. ${tokenLabel(token0, token1)}: ${formatHumanAmount(balance0, token0.decimals)}; ${tokenLabel(token1, token0)}: ${formatHumanAmount(balance1, token1.decimals)}.`,
    );
  const usd0 =
      pool.value.token0.symbol === "USDG"
        ? 1
        : pool.value.token1.symbol === "USDG"
          ? pool.value.priceToken1PerToken0
          : undefined,
    usd1 =
      pool.value.token1.symbol === "USDG"
        ? 1
        : pool.value.token0.symbol === "USDG"
          ? 1 / pool.value.priceToken1PerToken0
          : undefined;
  if (usd0 === undefined || usd1 === undefined)
    return preserve(
      ctx,
      refreshedFlow,
      "USD valuation is unavailable for this pool; canary cap cannot be verified.",
    );
  const usd =
    (Number(quote.requiredAmount0) / 10 ** pool.value.token0.decimals) * usd0 +
    (Number(quote.requiredAmount1) / 10 ** pool.value.token1.decimals) * usd1;
  try {
    assertCanaryValue(usd, env.MAX_POSITION_VALUE_USD);
  } catch {
    return preserve(
      ctx,
      refreshedFlow,
      `Estimated position value $${usd.toFixed(2)} exceeds the $${env.MAX_POSITION_VALUE_USD} canary cap.`,
    );
  }
  const deployments = await audit();
  if (deployments.status === "unavailable")
    return preserve(
      ctx,
      refreshedFlow,
      `Deployment verification failed: ${deployments.reason}`,
    );
  const deadline = BigInt(
      Math.floor(Date.now() / 1000) + env.CONFIRMATION_TTL_SECONDS,
    ),
    slippage = BigInt(env.MAX_SLIPPAGE_BPS),
    mint = buildMint(deployments.value, {
      token0: pool.value.token0.address,
      token1: pool.value.token1.address,
      fee: pool.value.pool.fee,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      amount0Desired: quote.requiredAmount0,
      amount1Desired: quote.requiredAmount1,
      amount0Min: (quote.requiredAmount0 * (10_000n - slippage)) / 10_000n,
      amount1Min: (quote.requiredAmount1 * (10_000n - slippage)) / 10_000n,
      recipient: wallet,
      deadline,
    }),
    a0 = buildApproval(
      pool.value.token0.address,
      deployments.value.positionManager,
      quote.requiredAmount0,
    ),
    a1 = buildApproval(
      pool.value.token1.address,
      deployments.value.positionManager,
      quote.requiredAmount1,
    );
  const [mintSimulation, approval0, approval1] = await Promise.all([
      simulateBuiltTransaction(rpc, wallet, mint),
      simulateApproval(rpc, wallet, a0),
      simulateApproval(rpc, wallet, a1),
    ]),
    p0 = tokenInfo(pool.value.token0),
    p1 = tokenInfo(pool.value.token1),
    enteredRaw = asset === 0 ? quote.requiredAmount0 : quote.requiredAmount1;
  const db = repo();
  try {
    const preflight = await walletPreflight(deployments, db),
      expiry = new Date(Number(deadline) * 1000).toISOString(),
      confirmation = db.createConfirmation({
        action: "ADD_LIQUIDITY",
        owner: owner(ctx),
        expiresAt: expiry,
        idempotencyKey: `add:${owner(ctx)}:${pool.value.pool.address}:${quote.currentBlock}:${quote.requiredAmount0}:${quote.requiredAmount1}`,
        blockNumber: quote.currentBlock.toString(),
        priceObservedAt: new Date().toISOString(),
        payload: {
          pool: pool.value.pool.address,
          range,
          quote,
          mint,
          approval0: a0,
          approval1: a1,
          mintSimulation,
          preflight,
        },
      });
    if (!confirmation) throw new Error("failed to persist confirmation");
    const lines = [
      "Add-liquidity preview — NO_BROADCAST / EXECUTION_BLOCKED",
      `Chain: ${env.RH_CHAIN_ID}; wallet: ${wallet}`,
      `Pool: ${tokenLabel(p0, p1)} (${p0.address}) / ${tokenLabel(p1, p0)} (${p1.address}), fee ${pool.value.pool.fee}`,
      pairedAmountMessage({
        token0: p0,
        token1: p1,
        enteredIndex: asset,
        enteredRaw,
        required0: quote.requiredAmount0,
        required1: quote.requiredAmount1,
        balance0,
        balance1,
        range: percent,
      }),
      `Estimated balances after: ${formatHumanAmount(balance0 - quote.requiredAmount0, p0.decimals)} ${tokenLabel(p0, p1)}; ${formatHumanAmount(balance1 - quote.requiredAmount1, p1.decimals)} ${tokenLabel(p1, p0)}`,
      `Ticks: ${range.tickLower}–${range.tickUpper}; price ${pool.value.priceToken1PerToken0}; estimated value $${usd.toFixed(2)}`,
      `Approvals: ${tokenLabel(p0, p1)} ${approval0.status === "available" ? `OK, gas ${approval0.value.gas}` : approval0.reason}; ${tokenLabel(p1, p0)} ${approval1.status === "available" ? `OK, gas ${approval1.value.gas}` : approval1.reason}`,
      `Mint simulation: ${mintSimulation.status === "available" ? `OK, gas ${mintSimulation.value.gas}` : mintSimulation.reason}`,
      `Slippage: ${env.MAX_SLIPPAGE_BPS} bps; deadline: ${expiry}`,
      `Confirmation: ${String(confirmation.id)} (expires ${expiry})`,
      `Technical details: ${tokenLabel(p0, p1)} raw ${quote.requiredAmount0}; ${tokenLabel(p1, p0)} raw ${quote.requiredAmount1}`,
    ];
    return ctx.reply(lines.join("\n"), {
      reply_markup: keyboard([
        [
          {
            label: "Acknowledge (execution remains blocked)",
            data: `confirm:${String(confirmation.id)}`,
          },
        ],
        [{ label: "Cancel", data: `cancel:${String(confirmation.id)}` }],
        flowControls(refreshedFlow),
      ]),
    });
  } finally {
    db.close();
  }
}
async function positionView(ctx: any, tokenId: string) {
  const deployments = await audit(),
    wallet = dedicatedWallet().address;
  if (!wallet) return ctx.reply("Dedicated wallet is not configured.");
  const position = await inspectV3Position(rpc, deployments, BigInt(tokenId));
  if (position.status === "unavailable")
    return ctx.reply(`Position unavailable: ${position.reason}`);
  if (position.value.owner.toLowerCase() !== wallet.toLowerCase())
    return ctx.reply("Position is not owned by the dedicated wallet.");
  const [view, fees, t0, t1] = await Promise.all([
    presentPosition(rpc, position.value),
    simulateUnclaimedFees(rpc, deployments, position.value, wallet),
    inspectErc20(rpc, position.value.token0),
    inspectErc20(rpc, position.value.token1),
  ]);
  if (
    view.status === "unavailable" ||
    t0.status === "unavailable" ||
    t1.status === "unavailable"
  )
    return ctx.reply("Position metadata is unavailable.");
  const db = repo();
  try {
    const accounting = db.positionAccounting(`live:${tokenId}`);
    accounting.unclaimedFees =
      fees.status === "available" ? fees.value : { token0: 0n, token1: 0n };
    let pnl =
      "PnL unavailable until an execution-block deposit snapshot is persisted.";
    if (accounting.deposits.token0 || accounting.deposits.token1) {
      const price = view.value.currentPrice,
        point =
          t0.value.symbol === "USDG"
            ? {
                token0Usd: 1,
                token1Usd: 1 / price,
                token0Decimals: t0.value.decimals,
                token1Decimals: t1.value.decimals,
                blockNumber: position.value.pool.blockNumber,
                source: "current WETH/USDG pool",
                confidence: "derived" as const,
                observedAt: new Date().toISOString(),
              }
            : t1.value.symbol === "USDG"
              ? {
                  token0Usd: price,
                  token1Usd: 1,
                  token0Decimals: t0.value.decimals,
                  token1Decimals: t1.value.decimals,
                  blockNumber: position.value.pool.blockNumber,
                  source: "current WETH/USDG pool",
                  confidence: "derived" as const,
                  observedAt: new Date().toISOString(),
                }
              : undefined;
      if (point) {
        const deposited =
          (Number(accounting.deposits.token0) / 10 ** point.token0Decimals) *
            point.token0Usd +
          (Number(accounting.deposits.token1) / 10 ** point.token1Decimals) *
            point.token1Usd;
        const value = markToMarket(
          accounting,
          view.value.currentAmounts,
          point,
          deposited,
          accounting.deposits,
        );
        pnl = `MTM gross/net: $${value.grossPnl.toFixed(2)} / $${value.netPnl.toFixed(2)}; realized: $${value.realizedValue.toFixed(2)}; hold: $${value.holdPnl.toFixed(2)}; LP vs hold: $${value.lpVsHold.toFixed(2)}`;
      }
    }
    const totals = db.collectionTotals(`live:${tokenId}`);
    return ctx.reply(
      [
        `Position ${tokenId}: ${view.value.inRange ? "IN RANGE" : "OUT OF RANGE"}`,
        `Liquidity amounts: ${amount(view.value.currentAmounts.token0, t0.value.decimals)} ${t0.value.symbol}; ${amount(view.value.currentAmounts.token1, t1.value.decimals)} ${t1.value.symbol}`,
        `Range: ${view.value.lowerPrice} / ${view.value.currentPrice} / ${view.value.upperPrice}`,
        `Claimed fees: ${totals.fees.token0} / ${totals.fees.token1}; unclaimed: ${fees.status === "available" ? `${fees.value.token0} / ${fees.value.token1}` : fees.reason}`,
        `Withdrawn principal: ${totals.principal.token0} / ${totals.principal.token1}`,
        pnl,
      ].join("\n"),
      {
        reply_markup: keyboard([
          [{ label: "Refresh", data: `position:${tokenId}` }],
          [{ label: "Collect preview", data: `collect:${tokenId}` }],
          [
            { label: "Partial close", data: `partial:${tokenId}` },
            { label: "Full close", data: `full:${tokenId}` },
          ],
        ]),
      },
    );
  } finally {
    db.close();
  }
}
async function managementPreview(
  ctx: any,
  tokenId: string,
  action: "COLLECT" | "PARTIAL_CLOSE" | "FULL_CLOSE",
) {
  const deployments = await audit(),
    wallet = dedicatedWallet().address;
  if (!wallet) return ctx.reply("Dedicated wallet is not configured.");
  if (deployments.status === "unavailable")
    return ctx.reply(`Deployment unavailable: ${deployments.reason}`);
  const position = await inspectV3Position(rpc, deployments, BigInt(tokenId));
  if (position.status === "unavailable")
    return ctx.reply(`Position unavailable: ${position.reason}`);
  if (position.value.owner.toLowerCase() !== wallet.toLowerCase())
    return ctx.reply("Position is not owned by the dedicated wallet.");
  const deadline = BigInt(
      Math.floor(Date.now() / 1000) + env.CONFIRMATION_TTL_SECONDS,
    ),
    liquidity =
      action === "PARTIAL_CLOSE"
        ? position.value.liquidity / 2n
        : position.value.liquidity;
  const txs =
    action === "COLLECT"
      ? [
          buildCollect(deployments.value, {
            tokenId: BigInt(tokenId),
            recipient: wallet,
            amount0Max: 2n ** 128n - 1n,
            amount1Max: 2n ** 128n - 1n,
          }),
        ]
      : [
          buildDecrease(deployments.value, {
            tokenId: BigInt(tokenId),
            liquidity,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline,
          }),
          buildCollect(deployments.value, {
            tokenId: BigInt(tokenId),
            recipient: wallet,
            amount0Max: 2n ** 128n - 1n,
            amount1Max: 2n ** 128n - 1n,
          }),
        ];
  const simulations = await Promise.all(
      txs.map((tx) => simulateBuiltTransaction(rpc, wallet, tx)),
    ),
    block = position.value.pool.blockNumber,
    expiresAt = new Date(Number(deadline) * 1000).toISOString(),
    db = repo();
  try {
    const confirmation = db.createConfirmation({
      action,
      owner: owner(ctx),
      expiresAt,
      idempotencyKey: `${action}:${owner(ctx)}:${tokenId}:${block}:${liquidity}`,
      blockNumber: block.toString(),
      payload: { tokenId, action, liquidity, transactions: txs, simulations },
    });
    if (!confirmation) throw new Error("failed to persist confirmation");
    return ctx.reply(
      [
        `${action.replace("_", " ")} preview (no broadcast)`,
        `Token ID: ${tokenId}; wallet: ${wallet}; block: ${block}`,
        `Liquidity: ${liquidity}; deadline: ${expiresAt}`,
        `Simulations: ${simulations.map((x) => (x.status === "available" ? `OK gas ${x.value.gas}` : x.reason)).join("; ")}`,
        `Confirmation: ${String(confirmation.id)} (expires ${expiresAt})`,
      ].join("\n"),
      {
        reply_markup: keyboard([
          [
            {
              label: "Acknowledge (execution blocked)",
              data: `confirm:${String(confirmation.id)}`,
            },
          ],
          [{ label: "Cancel", data: `cancel:${String(confirmation.id)}` }],
        ]),
      },
    );
  } finally {
    db.close();
  }
}

async function v4PositionView(ctx: any, tokenId: string) {
  const wallet = dedicatedWallet().address;
  if (!wallet) return ctx.reply("Dedicated wallet is not configured.");
  const db = repo();
  try {
    const row = db.v4Position(tokenId);
    if (!row) return ctx.reply("V4 position is not enrolled.");
    if (String(row.owner).toLowerCase() !== wallet.toLowerCase())
      return ctx.reply("Position is not owned by the dedicated wallet.");
    const targetSymbol = String(row.target_symbol ?? "WETH"),
      fundingSymbol = String(row.funding_symbol ?? "USDG"),
      fundingIndex = Number(row.funding_index ?? 1) as 0 | 1;
    if (String(row.status) === "burned") {
      const terminal = await v4PositionInspect(rpc, db, BigInt(tokenId)),
        terminalPnl = terminal.terminalPnl as
          | { status: "available"; netAfterGasPnlUsd: number }
          | { status: "USD_PNL_UNAVAILABLE"; reason: string }
          | undefined,
        initial =
          fundingIndex === 0
            ? terminal.accounting.deposits.token0
            : terminal.accounting.deposits.token1,
        withdrawn =
          fundingIndex === 0
            ? terminal.accounting.withdrawnPrincipal.token0
            : terminal.accounting.withdrawnPrincipal.token1;
      return ctx.reply(
        [
          `v4 position ${tokenId} · BURNED`,
          `PoolId: ${row.pool_id}`,
          "Owner: none; NFT exists: no; on-chain liquidity: 0",
          `Initial funding: ${initial} ${fundingSymbol} raw`,
          `Withdrawn funding-side principal: ${withdrawn} ${fundingSymbol} raw`,
          `Claimed fees token0/token1: ${terminal.accounting.claimedFees.token0} / ${terminal.accounting.claimedFees.token1}`,
          `Terminal difference token0/token1: ${terminal.accounting.terminalDifferences.token0} / ${terminal.accounting.terminalDifferences.token1}`,
          `Pending principal token0/token1: ${terminal.accounting.pendingPrincipal.token0} / ${terminal.accounting.pendingPrincipal.token1}`,
          terminalPnl?.status === "available"
            ? `Net after gas PnL: $${terminalPnl.netAfterGasPnlUsd}`
            : `USD_PNL_UNAVAILABLE: ${terminalPnl?.reason ?? "verified price provenance unavailable"}`,
          `Gas cost: $${terminal.accounting.gasUsd}`,
        ].join("\n"),
      );
    }
    const state = await inspectV4PositionState(rpc, BigInt(tokenId)),
      accounting = db.positionAccounting(`v4:${tokenId}`),
      totals = db.collectionTotals(`v4:${tokenId}`);
    accounting.unclaimedFees = {
      token0: state.claimableFees.token0,
      token1: state.claimableFees.token1,
    };
    const fee = state.pool.feeSemantics,
      valuation =
        state.valuation.status === "available"
          ? `Current StateView value: $${state.valuation.valueUsd.toFixed(4)} (${state.valuation.source})`
          : `${state.valuation.status}: ${state.valuation.reason}`;
    return ctx.reply(
      [
        `v4 position ${tokenId} · ${String(row.status).toUpperCase()}`,
        `${targetSymbol} target · ${fundingSymbol} funding`,
        `PoolId: ${state.pool.id}`,
        `Fee: ${fee?.dynamicFee ? "dynamic" : `${fee?.displayedFeePercent ?? "unavailable"}%`}; hooks: ${state.key.hooks}`,
        `Range: ${state.tickLower} → ${state.tickUpper}; current tick ${state.pool.tick} (${state.rangeState})`,
        `Liquidity: ${state.liquidity}`,
        `Composition: ${state.currentAmounts.token0} ${state.token0.symbol} raw / ${state.currentAmounts.token1} ${state.token1.symbol} raw`,
        `Claimed fees token0/token1: ${totals.fees.token0} / ${totals.fees.token1}`,
        `Unclaimed fees token0/token1: ${state.claimableFees.token0} / ${state.claimableFees.token1}`,
        `Withdrawn principal token0/token1: ${totals.principal.token0} / ${totals.principal.token1}`,
        valuation,
        "Close all and burn revalidates ownership, liquidity, pool state, gas and simulation after this button is pressed.",
      ].join("\n"),
      {
        reply_markup: keyboard([
          [{ label: "Refresh", data: `v4-position:${tokenId}` }],
          [{ label: "Collect fees", data: `v4-action:${tokenId}:collect` }],
          [
            { label: "Close 25%", data: `v4-action:${tokenId}:25` },
            { label: "Close 50%", data: `v4-action:${tokenId}:50` },
            { label: "Close 75%", data: `v4-action:${tokenId}:75` },
          ],
          [{ label: "Close all and burn", data: `v4-action:${tokenId}:all` }],
        ]),
      },
    );
  } finally {
    db.close();
  }
}
async function v4ManagementPreview(ctx: any, tokenId: string, choice: string) {
  const wallet = dedicatedWallet().address;
  if (!wallet) return ctx.reply("Dedicated wallet is not configured.");
  const action =
      choice === "collect"
        ? "collect"
        : choice === "all"
          ? "full_close"
          : "partial_close",
    percent =
      action === "partial_close" ? (Number(choice) as 25 | 50 | 75) : undefined,
    db = repo();
  try {
    const preview = await prepareV4TelegramManagement({
      repo: db,
      rpc,
      walletClient: guardedWalletClient(),
      wallet,
      tokenId: BigInt(tokenId),
      action,
      percent,
      slippageBps: env.MAX_SLIPPAGE_BPS,
      deadlineSeconds: env.CONFIRMATION_TTL_SECONDS,
      userId: owner(ctx),
      chatId: chat(ctx),
      messageId: String(
        ctx.callbackQuery?.message?.message_id ?? ctx.update.update_id,
      ),
    });
    return ctx.reply(
      [
        `v4 ${action.replace("_", " ")} final summary`,
        `NFT: ${tokenId}`,
        `Liquidity to remove: ${preview.liquidity}`,
        `Minimum amounts: ${preview.amountMinimums.amount0} / ${preview.amountMinimums.amount1}`,
        "Fresh ownership, pool state, global execution gates, gas and simulation checks run after confirmation.",
        "NO AUTOMATIC SWAP WILL BE PERFORMED.",
        "RESULTING ASSETS REMAIN IN WALLET.",
      ].join("\n"),
      {
        reply_markup: keyboard([
          [
            {
              label:
                action === "collect"
                  ? "Collect fees"
                  : choice === "all"
                    ? "Close all"
                    : `Close ${choice}%`,
              data: preview.confirmationButton,
            },
          ],
        ]),
      },
    );
  } catch (error) {
    return ctx.reply(`V4_ACTION_BLOCKED\n${textError(error)}`);
  } finally {
    db.close();
  }
}
async function v4ManagementConfirm(ctx: any, intentId: string) {
  const walletConfig = dedicatedWallet(),
    wallet = walletConfig.address;
  if (!wallet) return ctx.reply("Dedicated wallet is not configured.");
  const db = repo();
  try {
    const intent = db.v4LifecycleIntent(intentId);
    if (!intent) return ctx.reply("Unknown v4 action.");
    const safety = safetyPayload(db),
      deployment = await auditRobinhoodV4Deployments(rpc),
      operation =
        String(intent.action) === "burn"
          ? "burn"
          : String(intent.action) === "collect"
            ? "collect"
            : "close",
      gate = evaluateCanonicalExecutionGates(
        operation,
        readCanonicalExecutionGates({
          signerReady: walletConfig.signerConfigured,
          chainReady: env.RH_CHAIN_ID === 4663,
          deploymentReady: deployment.status === "available",
          manualPause: safety.manualPause === true,
          configSource: "process.env (PM2 runtime)",
        }),
      );
    if (!allowed.has(owner(ctx))) gate.reasons.push("OPERATOR_NOT_ALLOWLISTED");
    gate.verdict = gate.reasons.length ? "BLOCKED" : "PASS";
    log("execution_gate_evaluated", {
      operation,
      intentId,
      executionEnabled: gate.executionEnabled,
      dryRun: gate.dryRun,
      emergencyPause: gate.emergencyPause,
      configSource: gate.configSource,
      verdict: gate.verdict,
      reasons: gate.reasons,
    });
    if (gate.reasons.length)
      return ctx.reply(
        `V4_EXECUTION_BLOCKED\n${gate.reasons.join(", ")}\nNo transaction was sent.`,
      );
    const native = await trustedWethUsdReference(rpc);
    if (native.status !== "available")
      return ctx.reply(
        `V4_EXECUTION_BLOCKED\n${native.reason}\nNo transaction was sent.`,
      );
    let confirmedLifecycleUsd = 0;
    const gasPolicy = {
      beforeSigning: async (context: {
        intentId: string;
        action: string;
        estimatedGas: bigint;
        gasPrice: bigint;
      }) => {
        const estimatedGasUsd =
            (Number(context.estimatedGas * context.gasPrice) / 1e18) *
            native.value,
          projectedLifecycleGasUsd =
            confirmedLifecycleUsd +
            estimatedGasUsd +
            (context.action === "full_close"
              ? (Number(70_000n * context.gasPrice) / 1e18) * native.value
              : 0),
          verdict = !Number.isFinite(estimatedGasUsd)
            ? "BLOCKED_NATIVE_USD"
            : estimatedGasUsd > env.MAX_GAS_COST_USD
              ? "BLOCKED_PER_TX_CAP"
              : projectedLifecycleGasUsd > env.MAX_LIFECYCLE_GAS_USD
                ? "BLOCKED_LIFECYCLE_CAP"
                : "PASS";
        log("v4_operational_gas_estimate", {
          intentId: context.intentId,
          stage: context.action.toUpperCase(),
          gasUnits: context.estimatedGas.toString(),
          gasPriceWei: context.gasPrice.toString(),
          gasBufferMultiplier: 1.2,
          nativeUsd: native.value,
          nativeUsdSource: native.source,
          nativeUsdObservedAt: native.observedAt,
          estimatedGasUsd,
          bufferedGasUsd: estimatedGasUsd * 1.2,
          perTxCapUsd: env.MAX_GAS_COST_USD,
          projectedLifecycleGasUsd,
          lifecycleCapUsd: env.MAX_LIFECYCLE_GAS_USD,
          verdict,
        });
        if (verdict !== "PASS")
          throw new Error(`V4_${verdict}:${context.action}`);
      },
      afterConfirmation: async (context: {
        hash: string;
        gasUsed: bigint;
        effectiveGasPrice: bigint;
      }) => {
        const actualUsd =
          (Number(context.gasUsed * context.effectiveGasPrice) / 1e18) *
          native.value;
        confirmedLifecycleUsd += actualUsd;
        db.ingestGas(
          `v4:${String(intent.token_id)}`,
          context.hash,
          context.gasUsed * context.effectiveGasPrice,
        );
        db.db
          .prepare("UPDATE gas_costs SET usd_value=? WHERE tx_hash=?")
          .run(actualUsd, context.hash);
      },
    };
    const result = await confirmV4TelegramManagement({
      repo: db,
      rpc,
      walletClient: guardedWalletClient(),
      wallet,
      tokenId: BigInt(String(intent.token_id)),
      action: String(intent.action) as any,
      percent: JSON.parse(String(intent.payload_json)).percent as
        25 | 50 | 75 | undefined,
      slippageBps: env.MAX_SLIPPAGE_BPS,
      deadlineSeconds: env.CONFIRMATION_TTL_SECONDS,
      userId: owner(ctx),
      chatId: chat(ctx),
      intentId,
      allowPublicWrites: true,
      gasPolicy,
    });
    const manualSwapNotice =
      "NO AUTOMATIC SWAP WILL BE PERFORMED\nRESULTING ASSETS REMAIN IN WALLET";
    return ctx.reply(
      result.status === "ALREADY_PROCESSING" ||
        result.status === "ALREADY_COMPLETED"
        ? `${result.status}\n${manualSwapNotice}`
        : result.ok
          ? `${result.status === "ECONOMIC_CONFIRMED_RECONCILIATION_PENDING" ? "V4_ACTION_CONFIRMED · accounting refreshing" : "V4_ACTION_COMPLETED"}\nTransaction: ${result.hash}\n${manualSwapNotice}`
          : `V4_ACTION_FAILED\n${result.status}`,
    );
  } catch (error) {
    const pending = durableReconciliationPendingText(
      error,
      "V4_ACTION_RECONCILIATION_PENDING",
      intentId,
    );
    if (pending) return ctx.reply(pending);
    throw error;
  } finally {
    db.close();
  }
}
async function v4LiveCloseConfirm(
  ctx: any,
  tokenId: string,
  expiresAt: string,
) {
  if (Number(expiresAt) <= nowMs())
    return ctx.reply("Preview expired, create a new preview.");
  const db = repo();
  try {
    const wallet = dedicatedWallet();
    if (!wallet.address)
      return ctx.reply("Dedicated wallet is not configured.");
    const result = await executeV4LiveCanaryClose({
      repo: db,
      rpc,
      walletClient: guardedWalletClient(),
      wallet: wallet.address,
      runtime: {
        executionEnabled: env.EXECUTION_ENABLED,
        dryRun: env.DRY_RUN,
        emergencyPause: env.EMERGENCY_PAUSE,
        v4LiveCanaryEnabled: env.V4_LIVE_CANARY_ENABLED,
        signerConfigured: wallet.signerConfigured,
        allowlisted: allowed.has(owner(ctx)),
      },
      tokenId: BigInt(tokenId),
      idempotencyKey: `telegram-v4-close:${tokenId}`,
      limits: {
        maxTxGasUsd: env.V4_CANARY_MAX_TX_GAS_USD,
        totalGasUsd: env.V4_CANARY_TOTAL_GAS_BUDGET_USD,
        nativeUsd: env.GAS_USD_PER_NATIVE,
      },
    });
    return ctx.reply(
      result.status === "ALREADY_PROCESSING" ||
        result.status === "ALREADY_COMPLETED"
        ? result.status
        : "V4 POSITION CLOSED AND BURNED",
    );
  } catch (error) {
    return ctx.reply(`V4_CLOSE_FAILED\n${textError(error)}`);
  } finally {
    db.close();
  }
}
const usd = (value: OptionalUsd) =>
    value === null ? "Unavailable" : `$${value.toFixed(2)}`,
  signedUsd = (value: OptionalUsd) =>
    value === null ? "Unavailable" : value > 0 ? `+$${value.toFixed(2)}` : value < 0 ? `-$${Math.abs(value).toFixed(2)}` : "$0.00",
  pct = (value: OptionalUsd) =>
    value === null ? "Unavailable" : `${value.toFixed(2)}%`;
function positionSummary(position: PortfolioPosition) {
  return `${position.protocol} · ${position.pair} · ${usd(position.accounting.currentEquityUsd)} · ${position.rangeStatus} · PnL ${usd(position.accounting.netPnlUsd)}`;
}
function portfolioDetail(position: PortfolioPosition) {
  const a = position.accounting,
    p = position.price,
    adoption = position.adoption;
  return [
    `NFT: ${position.tokenId}`,
    `Protocol: ${position.protocol}`,
    `Pair: ${position.pair}`,
    `Pool: ${position.poolId}`,
    `Status: ${position.status}; ${position.rangeStatus}`,
    ...marketRangeLines(position.marketRange),
    `Current principal: ${usd(a.activePrincipalUsd)}`,
    `Uncollected fees: ${usd(a.uncollectedFeesUsd)}`,
    `Collected fees: ${usd(a.collectedFeesUsd)}`,
    `Current equity: ${usd(a.currentEquityUsd)}`,
    `Initial capital: ${usd(a.externalCapitalUsd)}`,
    `Realized proceeds: ${usd(a.realizedProceedsUsd)}`,
    `Gross PnL: ${usd(a.grossPnlUsd)} (${pct(a.grossPnlPct)})`,
    `Gas spent: ${usd(a.gasSpentUsd)}`,
    `Net PnL: ${usd(a.netPnlUsd)} (${pct(a.netPnlPct)})`,
    ...(adoption
      ? [
          `Adoption: ${adoption.source} · ${adoption.status}`,
          `Accounting: ${adoption.accountingStatus}`,
          `Baseline provenance: ${adoption.baselineProvenance ?? "Unavailable"}`,
          `Funding asset: ${adoption.fundingSymbol ?? "Explicit selection required"}${adoption.fundingProvenance ? ` · ${adoption.fundingProvenance}` : ""}`,
        ]
      : []),
    `Valuation: ${position.valuationStatus}${position.valuationReason ? ` · ${position.valuationReason}` : ""}`,
    `Price source: ${p?.source ?? "Unavailable"}`,
    `Price block/time: ${p ? `${p.blockNumber} · ${p.observedAt}` : "Unavailable"}`,
    `Reconciliation: ${position.reconciliation}`,
  ].join("\n");
}
async function portfolioReport(positionIds?: readonly string[]) {
  const db = repo();
  try {
    return positionIds?.length &&
      positionIds.every((id) => id.startsWith("v4:"))
      ? await buildPortfolioAudit({
          rpc,
          repo: db,
          wallet: dedicatedWallet().address,
          positionIds,
          protocolScope: "v4",
          wethUsdReference: () => trustedV4WethUsdReference({ rpc, repo: db }),
        })
      : await buildPortfolioAudit({
          rpc,
          repo: db,
          wallet: dedicatedWallet().address,
          positionIds,
        });
  } finally {
    db.close();
  }
}
function detailRows(
  position: ReturnType<typeof persistedPositionViews>[number],
) {
  const base = [
    [
      {
        label: "Refresh",
        data: `portfolio-position:${position.protocol}:${position.tokenId}`,
      },
    ],
    [
      {
        label: "Technical details",
        data: `position-technical:${position.protocol}:${position.tokenId}`,
      },
    ],
  ];
  if (
    position.lifecycle !== "CONFIRMED_ACTIVE_FRESH" &&
    position.lifecycle !== "CONFIRMED_ACTIVE_REFRESHING"
  )
    return base;
  const adoptionRows =
    position.source === "MANUAL_EXTERNAL"
      ? [
          ...(position.baselineProvenance
            ? []
            : [
                [
                  {
                    label: "Set cost basis",
                    data: `adoption-baseline:${position.protocol}:${position.tokenId}`,
                  },
                ],
              ]),
          ...(position.fundingProvenance
            ? []
            : [
                [
                  {
                    label: "Funding: USDG",
                    data: `adoption-funding:${position.protocol}:${position.tokenId}:USDG`,
                  },
                  {
                    label: "Funding: WETH",
                    data: `adoption-funding:${position.protocol}:${position.tokenId}:WETH`,
                  },
                ],
              ]),
        ]
      : [];
  return [
    ...base,
    ...adoptionRows,
    ...(position.protocol === "v4"
      ? [
          [
            {
              label: "Collect fees",
              data: `v4-action:${position.tokenId}:collect`,
            },
          ],
          [
            { label: "Close 25%", data: `v4-action:${position.tokenId}:25` },
            { label: "Close 50%", data: `v4-action:${position.tokenId}:50` },
            { label: "Close 75%", data: `v4-action:${position.tokenId}:75` },
          ],
          [
            {
              label: "Close all and burn",
              data: `v4-action:${position.tokenId}:all`,
            },
          ],
        ]
      : [
          [{ label: "Collect preview", data: `collect:${position.tokenId}` }],
          [
            { label: "Partial close", data: `partial:${position.tokenId}` },
            { label: "Full close", data: `full:${position.tokenId}` },
          ],
        ]),
  ];
}
async function refreshPositionDetail(
  ctx: any,
  protocol: "v3" | "v4",
  tokenId: string,
  messageId: number,
  interactionStarted: number,
  interactionId: string,
) {
  const rpcStarted = Date.now();
  try {
    const wallet = dedicatedWallet().address;
    if (!wallet) throw new Error("DEDICATED_WALLET_REQUIRED");
    const db = repo(),
      leaseOwner = `telegram-detail:${interactionId}`;
    let persisted,
      changed = false,
      result;
    try {
      if (!acquireRpcReadLease(db, leaseOwner, 5_000)) {
        log("telegram_rpc_attribution", {
          interaction: "position_detail",
          interactionId,
          tokenId,
          provider: "none",
          ethCallCount: 0,
          eth_blockNumberCount: 0,
          getCodeCount: 0,
          multicallCount: 0,
          multicallMembers: 0,
          startTimestamp: new Date(rpcStarted).toISOString(),
          endTimestamp: new Date().toISOString(),
          totalRpcDurationMs: 0,
          overlappedAnotherProcess: true,
          verdict: "DEFERRED_BY_GLOBAL_RPC_LEASE",
        });
        return;
      }
      result = await reconcileActivePositions({
        repo: db,
        rpc,
        wallet,
        positionIds: [protocol === "v4" ? `v4:${tokenId}` : `live:${tokenId}`],
        limit: 1,
        ttlMs: 90_000,
        interactionId,
      });
      persisted = persistedPositionViews(db).find(
        (value) => value.protocol === protocol && value.tokenId === tokenId,
      );
      if (!persisted) return;
      const text = persistedPositionDetail(persisted),
        rows = detailRows(persisted),
        contentHash = createHash("sha256")
          .update(JSON.stringify({ text, rows }))
          .digest("hex"),
        prior = db.db
          .prepare(
            "SELECT content_hash FROM position_detail_refresh_state WHERE protocol_version=? AND token_id=?",
          )
          .get(protocol, tokenId) as { content_hash: string } | undefined;
      changed = prior?.content_hash !== contentHash;
      db.db
        .prepare(
          "INSERT INTO position_detail_refresh_state(protocol_version,token_id,content_hash,refreshed_at_ms) VALUES(?,?,?,?) ON CONFLICT(protocol_version,token_id) DO UPDATE SET content_hash=excluded.content_hash,refreshed_at_ms=excluded.refreshed_at_ms",
        )
        .run(protocol, tokenId, contentHash, Date.now());
      if (changed)
        await ctx.api.editMessageText(Number(chat(ctx)), messageId, text, {
          reply_markup: keyboard(rows),
        });
    } finally {
      releaseRpcReadLease(db, leaseOwner);
      db.close();
    }
    log("telegram_rpc_attribution", {
      interaction: "position_detail",
      interactionId,
      tokenId,
      provider: result.provider,
      ethCallCount: result.ethCallCount,
      eth_blockNumberCount: result.eth_blockNumberCount,
      getCodeCount: result.getCodeCount,
      multicallCount: result.multicallCount,
      multicallMembers: result.multicallMembers,
      startTimestamp: result.startedAt,
      endTimestamp: result.endedAt,
      totalRpcDurationMs: result.totalRpcDurationMs,
      overlappedAnotherProcess: false,
    });
    log("telegram_interaction_latency", {
      interaction: "position_detail_refresh",
      interactionId,
      callbackAckMs: 0,
      firstPaintMs: 0,
      refreshMs: Date.now() - rpcStarted,
      rpcProvider: "alchemy",
      rpcMs: Date.now() - rpcStarted,
      totalMs: Date.now() - interactionStarted,
    });
  } catch (error) {
    log("telegram_targeted_refresh_deferred", {
      interaction: "position_detail",
      tokenId,
      reason: textError(error),
      rpcProvider: "alchemy",
      fallbackUsed: false,
      rpcMs: Date.now() - rpcStarted,
      totalMs: Date.now() - interactionStarted,
    });
  }
}
function money(value: number | null) { return value === null ? "Unavailable" : `${value<0?"-":""}$${Math.abs(value).toFixed(2)}`; }
async function periodPnlCard(ctx: any,kind:FuniPeriodKind) {
  const period=wibPeriodWindow(kind), db=repo();
  try {
    const events=db.realizedPnlEventsBetween(period.startMs,period.endMs), coverage=db.realizedPnlCoverage(), start=coverage?Number(coverage.started_at_ms):null;
    const presentation=periodPnlPresentation({period,coverageStartMs:start,events}),caption=presentation.caption;
    if(kind==="DAILY_PNL")db.ensurePnlCardDelivery({deliveryId:`daily:${period.key}:${chat(ctx)}`,cardKind:"DAILY",requestedDayWib:period.key,chatIdentity:chat(ctx),metadata:{readOnly:true}});
    try { return await ctx.replyWithPhoto(new InputFile(renderFuniPnlCard({model:presentation.card}),`funi-${kind.toLowerCase()}.png`),{caption}); } catch { return ctx.reply(caption); }
  } finally { db.close(); }
}
async function positionsCommand(ctx: any, page = 0, queueSync = true) {
  const started = Date.now(),
    interactionId = randomUUID(),
    db = repo();
  let positions: PersistedPositionDisplayItem[],
    pending: PersistedPositionDisplayItem[],
    openConfirming: PersistedPositionDisplayItem[],
    confirmedCount = 0,
    refreshingCount = 0,
    ledgerReadMs = 0,
    totalEquity: OptionalUsd = null,
    unclaimedFees: OptionalUsd = null,
    inventoryPnl: OptionalUsd = null,
    claimedFees: OptionalUsd = null,
    openLifecyclePnl: OptionalUsd = null;
  try {
    const ledgerStarted = Date.now(),
      all = persistedPositionDisplayItems(db, persistedPositionViews(db)),
      confirmed = all.filter(
        (position) =>
          displayLifecycle(position) === "CONFIRMED_ACTIVE_FRESH" ||
          displayLifecycle(position) === "CONFIRMED_ACTIVE_REFRESHING",
      );
    openConfirming = all.filter(
      (position) => displayLifecycle(position) === "OPEN_CONFIRMING",
    );
    confirmedCount = confirmed.length + openConfirming.length;
    refreshingCount = confirmed.filter(
      (position) =>
        displayLifecycle(position) === "CONFIRMED_ACTIVE_REFRESHING",
    ).length + openConfirming.length;
    positions = [...confirmed, ...openConfirming];
    pending = all.filter(
      (position) => displayLifecycle(position) === "PENDING_NEVER_VERIFIED",
    );
    const lifecyclePnl = aggregateFuniOpenLifecyclePnl(db, all);
    inventoryPnl = lifecyclePnl.inventoryPnlUsd;
    claimedFees = lifecyclePnl.claimedFeesUsd;
    openLifecyclePnl = lifecyclePnl.openLifecyclePnlUsd;
    totalEquity =
      confirmed.length &&
      confirmed.every((position) => displayEquity(position) !== null)
        ? confirmed.reduce((sum, position) => sum + displayEquity(position)!, 0)
        : null;
    unclaimedFees =
      confirmed.length &&
      confirmed.every((position) => displayUnclaimedFees(position) !== null)
        ? confirmed.reduce(
            (sum, position) => sum + displayUnclaimedFees(position)!,
            0,
          )
        : null;
    ledgerReadMs = Date.now() - ledgerStarted;
  } finally {
    db.close();
  }
  const pageSize = 9,
    totalPages = Math.max(1, Math.ceil(positions.length / pageSize)),
    current = Math.min(Math.max(0, page), totalPages - 1),
    shown = positions.slice(current * pageSize, current * pageSize + pageSize),
    rows = shown.map((position) => [
      position.kind === "bid_ladder"
        ? {
            label: compactLabel(persistedPositionDisplaySummary(position)),
            data: bidLadderCallback("view", position.ladderId),
          }
        : {
            label: compactLabel(persistedPositionDisplaySummary(position)),
            data: `portfolio-position:${position.position.protocol}:${position.position.tokenId}`,
          },
    ]);
  const navigation = [
    ...(current > 0
      ? [{ label: "Previous", data: `positions-page:${current - 1}` }]
      : []),
    ...(current + 1 < totalPages
      ? [{ label: "Next", data: `positions-page:${current + 1}` }]
      : []),
  ];
  if (navigation.length) rows.push(navigation);
  rows.push([{ label: "📈 Daily PnL", data: "pnl-period:daily" },{ label: "Weekly PnL", data: "pnl-period:weekly" },{ label: "Monthly PnL", data: "pnl-period:monthly" }]);
  const header = [
      `Portfolio positions`,
      `External positions are visible but excluded from FUNI manual execution totals.`,
      `Active: ${confirmedCount}${refreshingCount ? ` · ${refreshingCount} refreshing` : ""}`,
      `Total equity: ${usd(totalEquity)}`,
      `Inventory PnL: ${signedUsd(inventoryPnl)}`,
      `Unclaimed fees: ${usd(unclaimedFees)}`,
      `Claimed fees: ${usd(claimedFees)}`,
      `Open lifecycle PnL: ${signedUsd(openLifecyclePnl)}`,
      ...(pending.length ? [`Pending reconciliation: ${pending.length}`] : []),
      `Page ${current + 1}/${totalPages}`,
    ].join("\n"),
    cards = shown.map(persistedPositionDisplayCard).join("\n\n"),
    message = await ctx.reply(
      cards ? `${header}\n\n${cards}` : header,
      rows.length ? { reply_markup: keyboard(rows) } : undefined,
    ),
    firstPaintMs = Date.now() - started;
  log("telegram_rpc_attribution", {
    interaction: "positions",
    interactionId,
    provider: "none",
    ethCallCount: 0,
    eth_blockNumberCount: 0,
    getCodeCount: 0,
    multicallCount: 0,
    multicallMembers: 0,
    startTimestamp: new Date(started).toISOString(),
    endTimestamp: new Date().toISOString(),
    totalRpcDurationMs: 0,
    overlappedAnotherProcess: false,
  });
  log("telegram_interaction_latency", {
    interaction: "positions",
    interactionId,
    confirmedActiveCount: confirmedCount,
    refreshingCount,
    openConfirmingCount: openConfirming.length,
    pendingReconciliationCount: pending.length,
    positionsFirstPaintMs: firstPaintMs,
    callbackAckMs: null,
    firstPaintMs,
    ledgerReadMs,
    rpcProvider: "none",
    rpcMs: 0,
    totalMs: firstPaintMs,
    mainnetTransactionsSent: 0,
  });
  if (queueSync) {
    try {
      retrySqliteBusySync({
        operation: "positions_post_response_sync_enqueue",
        log,
        run: () => {
          const queueDb = repo();
          try {
            enqueueWalletPositionSync(queueDb, `telegram-positions:${interactionId}`);
          } finally {
            queueDb.close();
          }
        },
      });
    } catch (error) {
      log("telegram_positions_refresh_enqueue_deferred", {
        interactionId,
        transientSqliteContention: isSqliteBusy(error),
        ...safeTelegramError(error),
        responseAlreadySent: true,
        mainnetTransactionsSent: 0,
      });
    }
  }
  return message;
}
async function beginAdoptionBaseline(
  ctx: any,
  protocol: string,
  tokenId: string,
) {
  const positionId = protocol === "v4" ? `v4:${tokenId}` : `live:${tokenId}`,
    db = repo();
  try {
    const adoption = positionAdoption(db, positionId);
    if (!adoption) return ctx.reply("POSITION_NOT_EXTERNAL");
    if (adoption.baseline_provenance || adoption.original_capital_usd !== null)
      return ctx.reply("Cost basis already has trusted provenance.");
  } finally {
    db.close();
  }
  const flow = newFlow(ctx, {
    kind: "adoption_baseline_amount",
    positionId,
    protocol,
    tokenId,
  });
  return ctx.reply(
    "Enter the cost basis in USD. It is recorded only after final confirmation and cannot overwrite a trusted baseline.",
    { reply_markup: keyboard([flowControls(flow)]) },
  );
}
async function adoptionBaselineAmount(
  ctx: any,
  flow: TelegramFlowSession,
  value: string,
) {
  const baselineUsd = Number(value.replaceAll(",", "").replace(/^\$/, ""));
  if (!Number.isFinite(baselineUsd) || baselineUsd <= 0)
    return preserve(ctx, flow, "Enter one positive USD value, for example 5.");
  const db = repo();
  try {
    const confirmation = createAdoptionBaselineConfirmation(db, {
        positionId: String(flow.state.positionId),
        userId: owner(ctx),
        chatId: chat(ctx),
        baselineUsd,
        nowMs: nowMs(),
        ttlMs: sessionTtlMs,
      }),
      next =
        advanceFlow(
          ctx,
          flow,
          {
            ...flow.state,
            kind: "adoption_baseline_confirm",
            confirmationId: confirmation.id,
            baselineUsd,
          },
          "external cost basis awaiting final confirmation",
        ) ?? flow;
    return ctx.reply(`Set immutable cost basis to ${usd(baselineUsd)}?`, {
      reply_markup: keyboard([
        [
          {
            label: "Confirm cost basis",
            data: `adoption-baseline-confirm:${confirmation.id}`,
          },
        ],
        flowControls(next),
      ]),
    });
  } finally {
    db.close();
  }
}
async function confirmBaseline(ctx: any, id: string) {
  const db = repo();
  try {
    const result = confirmAdoptionBaseline(db, {
      id,
      userId: owner(ctx),
      chatId: chat(ctx),
      nowMs: nowMs(),
    });
    if (result.status === "CONFIRMED") {
      const flow = loadFlow(ctx);
      if (flow) cancelFlow(ctx, flow.sessionId);
      return ctx.reply(`Cost basis saved: ${usd(result.baselineUsd)}`);
    }
    return ctx.reply(`COST_BASIS_${result.status}`);
  } finally {
    db.close();
  }
}
async function selectAdoptedFunding(
  ctx: any,
  protocol: string,
  tokenId: string,
  symbol: "USDG" | "WETH",
) {
  const positionId = protocol === "v4" ? `v4:${tokenId}` : `live:${tokenId}`,
    token =
      symbol === "USDG"
        ? robinhoodMainnet.assets.USDG
        : robinhoodMainnet.assets.WETH,
    db = repo();
  try {
    const result = setAdoptedFundingAsset(db, {
      positionId,
      token,
      symbol,
      provenance: "USER_SELECTED_FUNDING",
    });
    return ctx.reply(
      `Original funding asset verified: ${result.funding_symbol}\nProvenance: ${result.funding_provenance}`,
    );
  } catch (error) {
    return ctx.reply(`FUNDING_SELECTION_BLOCKED\n${textError(error)}`);
  } finally {
    db.close();
  }
}
function portfolioSnapshotText(snapshot: any) {
  return formatPortfolioSnapshot(snapshot);
}
async function portfolioCommand(ctx: any) {
  const started = Date.now(),
    interactionId = randomUUID(),
    db = repo();
  let snapshot;
  try {
    snapshot = persistedPortfolioSnapshot(db);
  } finally {
    db.close();
  }
  const message = await ctx.reply(portfolioSnapshotText(snapshot)),
    firstPaintMs = Date.now() - started;
  log("telegram_rpc_attribution", {
    interaction: "portfolio",
    interactionId,
    provider: "none",
    ethCallCount: 0,
    eth_blockNumberCount: 0,
    getCodeCount: 0,
    multicallCount: 0,
    multicallMembers: 0,
    startTimestamp: new Date(started).toISOString(),
    endTimestamp: new Date().toISOString(),
    totalRpcDurationMs: 0,
    overlappedAnotherProcess: false,
  });
  log("telegram_interaction_latency", {
    interaction: "portfolio",
    interactionId,
    portfolioFirstPaintMs: firstPaintMs,
    firstPaintMs,
    rpcProvider: "none",
    rpcMs: 0,
    totalMs: firstPaintMs,
  });
  const queueDb = repo();
  try {
    enqueuePortfolioRefresh(queueDb, `telegram-portfolio:${interactionId}`);
  } finally {
    queueDb.close();
  }
  setTimeout(async () => {
    const refreshedDb = repo();
    let refreshed;
    try {
      refreshed = persistedPortfolioSnapshot(refreshedDb);
    } finally {
      refreshedDb.close();
    }
    if (refreshed.contentHash !== snapshot.contentHash)
      try {
        await ctx.api.editMessageText(
          Number(chat(ctx)),
          Number(message.message_id),
          portfolioSnapshotText(refreshed),
        );
        log("telegram_interaction_latency", {
          interaction: "portfolio_refresh",
          interactionId,
          portfolioRefreshMs: Date.now() - started,
        });
      } catch (error) {
        log("telegram_portfolio_refresh_deferred", {
          interactionId,
          reason: textError(error),
        });
      }
  }, 20_000);
  return message;
}
bot.api
  .setMyCommands([...FUNI_COMMAND_MENU], {
    scope: { type: "all_private_chats" },
  })
  .catch((error) =>
    log("telegram_command_menu_failed", { error: textError(error) }),
  );
bot.command("start", (ctx) => ctx.reply(START_TEXT));
bot.command("help", (ctx) => ctx.reply(HELP_TEXT));
registerMultichainUx(bot, process.env, {
  poolLookup: (chainId, protocol, address) => {
    const db = repo();
    try {
      return db.db
        .prepare(
          "SELECT * FROM chain_pools WHERE chain_id=? AND protocol=? AND lower(pool_address)=?",
        )
        .get(chainId, protocol, address.toLowerCase()) as
        Record<string, unknown> | undefined;
    } finally {
      db.close();
    }
  },
});
bot.command("chatid", (ctx) =>
  ctx.reply(
    `Chat ID: ${String(ctx.chat?.id ?? "unavailable")}\nChat type: ${String(ctx.chat?.type ?? "unavailable")}`,
  ),
);
bot.command("status", async (ctx) => {
  const db = repo();
  try {
    const deployment = await audit(),
      wallet = dedicatedWallet(),
      safety = safetyPayload(db),
      route = staticCanaryReachability({
        executionEnabled: env.EXECUTION_ENABLED,
        dryRun: env.DRY_RUN,
        emergencyPause: safety.effectiveEmergencyPause,
        liveCanaryEnabled: env.LIVE_CANARY_ENABLED,
        signerConfigured: wallet.signerConfigured,
        operatorConfigured: allowed.size > 0,
        chainId: env.RH_CHAIN_ID,
        deploymentVerified: deployment.status === "available",
      });
    return ctx.reply(
      JSON.stringify({
        wallet: wallet.address ?? "unconfigured",
        safety,
        executionReachable: route.executionReachable,
        executionRoute: route,
      }),
    );
  } finally {
    db.close();
  }
});
bot.command("arm_canary", (ctx) =>
  ctx.reply(
    "/arm_canary is disabled. The durable one-attempt $5 canary budget is claimed only by the final Open position confirmation.",
  ),
);
bot.command("disarm_canary", (ctx) =>
  ctx.reply(
    "/disarm_canary is disabled. Use the operator CLI to inspect or reset the durable canary budget.",
  ),
);
bot.command("canary_status", (ctx) => {
  const db = repo();
  try {
    const budget = db.canaryBudget(),
      safety = safetyPayload(db);
    return ctx.reply(
      JSON.stringify({
        budget,
        safety: {
          manualPause: safety.manualPause,
          executionEnabled: safety.executionEnabled,
          dryRun: safety.dryRun,
          emergencyPause: safety.emergencyPause,
          liveCanaryEnabled: safety.liveCanaryEnabled,
        },
        limits: { positionUsd: 5, approvalUsd: 5, attempts: 1 },
      }),
    );
  } finally {
    db.close();
  }
});
bot.command("range", async (ctx) => {
  const value = Number(ctx.match?.trim()),
    flow = loadFlow(ctx);
  if (!Number.isFinite(value) || value <= 0 || value >= 100)
    return ctx.reply("Usage: /range <percent>, e.g. /range 3.5");
  if (!flow) return unavailableFlow(ctx, "missing");
  return selectRange(ctx, flow.sessionId, value);
});
bot.command("amount", (ctx) => addPreview(ctx, ctx.match?.trim() ?? ""));
bot.command("bid_ladder_preview", (ctx) => bidLadderDryRunPreview(ctx));
bot.command("bid_ladder_create", (ctx) =>
  ctx.reply(
    "Create is available only from the explicit preview confirmation button.",
  ),
);
bot.command("bid_ladder_view", (ctx) =>
  bidLadderView(ctx, ctx.match?.trim() ?? ""),
);
bot.command("bid_ladder_list", (ctx) => bidLadderList(ctx));
bot.command("positions", (ctx) => positionsCommand(ctx));
bot.command("portfolio", (ctx) => portfolioCommand(ctx));
bot.command("cancel", (ctx) => {
  const flow = loadFlow(ctx);
  if (!flow || flow.status !== "active")
    return ctx.reply("No active flow to cancel.");
  if (
    flow.state.kind === "v4_bid_ladder_amount" ||
    flow.state.kind === "v4_bid_ladder_preview"
  )
    return bidLadderReturn(ctx, flow);
  cancelFlow(ctx, flow.sessionId);
  return ctx.reply("Flow cancelled. No transaction was sent.");
});
bot.command("position", (ctx) => positionView(ctx, ctx.match?.trim() ?? ""));
bot.command("collect", (ctx) =>
  managementPreview(ctx, ctx.match?.trim(), "COLLECT"),
);
bot.command("partial_close", (ctx) =>
  managementPreview(ctx, ctx.match?.trim(), "PARTIAL_CLOSE"),
);
bot.command("full_close", (ctx) =>
  managementPreview(ctx, ctx.match?.trim(), "FULL_CLOSE"),
);
bot.callbackQuery(/^pool:([^:]+)$/, async (ctx) => {
  const selectionId = ctx.match[1]!,
    db = repo();
  let selection: Record<string, unknown> | undefined;
  try {
    selection = db.poolSelection(selectionId);
  } finally {
    db.close();
  }
  if (
    !selection ||
    selection.user_id !== owner(ctx) ||
    selection.chat_id !== chat(ctx)
  )
    await ctx.reply("STALE_POOL_SELECTION");
  else await selectPool(ctx, String(selection.session_id), selectionId);
});
bot.callbackQuery(/^gmgn-open-lp:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  if (ctx.chat?.type !== "private") {
    await ctx.reply("Open LP is available only in the private operator chat.");
    return;
  }
  await beginToken(ctx, ctx.match[1]!);
});
bot.callbackQuery(/^direct-lookup-retry:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  await beginToken(ctx, ctx.match[1]!);
});
bot.callbackQuery(/^pool:([^:]+):([^:]+)$/, async (ctx) => {
  const [, sessionId, selectionId] = ctx.match;
  await selectPool(ctx, sessionId!, selectionId!);
});
bot.callbackQuery(/^pool-page:([^:]+):(\d+)$/, async (ctx) => {
  await pagePoolListing(ctx, ctx.match[1]!, ctx.match[2]!);
});
bot.callbackQuery(/^pool-unavailable-page:([^:]+):(\d+)$/, async (ctx) => {
  await pageUnavailablePoolListing(ctx, ctx.match[1]!, ctx.match[2]!);
});
bot.callbackQuery(/^positions-page:(\d+)$/, async (ctx) => {
  await positionsCommand(ctx, Number(ctx.match[1]!), false);
});
bot.callbackQuery(/^daily-pnl$/, async (ctx) => {
  await periodPnlCard(ctx,"DAILY_PNL");
});
bot.callbackQuery(/^pnl-period:(daily|weekly|monthly)$/, async (ctx) => {
  const kind={daily:"DAILY_PNL",weekly:"WEEKLY_PNL",monthly:"MONTHLY_PNL"}[ctx.match[1]!] as FuniPeriodKind;
  await periodPnlCard(ctx,kind);
});
bot.callbackQuery(/^portfolio-position:(v3|v4):(\d+)$/, async (ctx) => {
  const started = Date.now(),
    interactionId = randomUUID(),
    protocol = ctx.match[1]! as "v3" | "v4",
    tokenId = ctx.match[2]!,
    db = repo();
  let persisted;
  try {
    persisted = persistedPositionViews(db).find(
      (value) => value.protocol === protocol && value.tokenId === tokenId,
    );
  } finally {
    db.close();
  }
  if (!persisted)
    return ctx.reply("Position is unavailable or no longer tracked.");
  const rows = detailRows(persisted);
  const message = await ctx.reply(persistedPositionDetail(persisted), {
      reply_markup: keyboard(rows),
    }),
    firstPaintMs = Date.now() - started;
  log("telegram_interaction_latency", {
    interaction: "position_detail",
    interactionId,
    tokenId,
    callbackAckMs: 0,
    firstPaintMs,
    ledgerReadMs: firstPaintMs,
    rpcProvider: "none",
    rpcMs: 0,
    totalMs: firstPaintMs,
  });
  void refreshPositionDetail(
    ctx,
    protocol,
    tokenId,
    Number(message.message_id),
    started,
    interactionId,
  );
  return message;
});
bot.callbackQuery(/^position-technical:(v3|v4):(\d+)$/, async (ctx) => {
  const db = repo();
  try {
    const position = persistedPositionViews(db).find(
      (value) =>
        value.protocol === ctx.match[1] && value.tokenId === ctx.match[2],
    );
    return ctx.reply(
      position
        ? persistedPositionTechnicalDetails(position)
        : "Position technical details are unavailable.",
    );
  } finally {
    db.close();
  }
});
bot.callbackQuery(/^adoption-baseline:(v3|v4):(\d+)$/, async (ctx) => {
  await beginAdoptionBaseline(ctx, ctx.match[1]!, ctx.match[2]!);
});
bot.callbackQuery(/^adoption-baseline-confirm:([0-9a-f-]+)$/, async (ctx) => {
  await confirmBaseline(ctx, ctx.match[1]!);
});
bot.callbackQuery(
  /^adoption-funding:(v3|v4):(\d+):(USDG|WETH)$/,
  async (ctx) => {
    await selectAdoptedFunding(
      ctx,
      ctx.match[1]!,
      ctx.match[2]!,
      ctx.match[3]! as "USDG" | "WETH",
    );
  },
);
bot.callbackQuery(/^v4-pool:([^:]+)$/, async (ctx) => {
  await selectV4Pool(ctx, ctx.match[1]!);
});
bot.callbackQuery(/^v4-strategy:([^:]+):(BID_LADDER|SPOT)$/, async (ctx) => {
  if (ctx.match[2] === "BID_LADDER") await bidLadderStart(ctx, ctx.match[1]!);
  else await spotStart(ctx, ctx.match[1]!);
});
bot.callbackQuery(
  /^bid-ladder-depth:([0-9a-f-]+):(custom|\d+)$/,
  async (ctx) => {
    await bidLadderDepth(ctx, ctx.match[1]!, ctx.match[2]!);
  },
);
bot.callbackQuery(/^bid-ladder-create:([0-9a-f-]+)$/, async (ctx) => {
  await bidLadderCreate(ctx, ctx.match[1]!);
});
bot.callbackQuery(/^bl:v:(v4bid_[0-9a-f]{32})$/, async (ctx) => {
  await bidLadderView(ctx, ctx.match[1]!);
});
bot.callbackQuery(
  /^bl:op:(v4bid_[0-9a-f]{32})$/,
  async (ctx) => {
    await bidLadderLivePreview(ctx, ctx.match[1]!);
  },
);
bot.callbackQuery(
  /^bl:oo:(v4bid_[0-9a-f]{32})$/,
  async (ctx) => {
    await bidLadderLiveOpen(ctx, ctx.match[1]!);
  },
);
bot.callbackQuery(
  /^bl:cp:(v4bid_[0-9a-f]{32})$/,
  async (ctx) => {
    await bidLadderClosePreview(ctx, ctx.match[1]!);
  },
);
bot.callbackQuery(
  /^bl:cc:(v4bid_[0-9a-f]{32})$/,
  async (ctx) => {
    await bidLadderCloseConfirm(ctx, ctx.match[1]!);
  },
);
bot.callbackQuery(/^bl:fp:(v4bid_[0-9a-f]{32})$/, async (ctx) => { await bidLadderCollectPreview(ctx, ctx.match[1]!); });
bot.callbackQuery(/^bl:fc:([0-9a-f]{18}):(v4bid_[0-9a-f]{32})$/, async (ctx) => { await bidLadderCollectConfirm(ctx, ctx.match[1]!, ctx.match[2]!); });
bot.callbackQuery(/^bl:fx:(v4bid_[0-9a-f]{32})$/, async (ctx) => { await ctx.reply("Claim Fees cancelled. The ladder is unchanged; no transaction was sent."); });
bot.callbackQuery(
  /^bl:rp:([0-9a-f]{18}):(v4bid_[0-9a-f]{32})$/,
  async (ctx) => {
    await bidLadderRepositionPreview(ctx, ctx.match[1]!,ctx.match[2]!);
  },
);
bot.callbackQuery(
  /^bl:ra:([0-9a-f]{18}):(v4bid_[0-9a-f]{32})$/,
  async (ctx) => {
    await bidLadderRepositionPrepareAllowance(ctx,ctx.match[1]!,ctx.match[2]!);
  },
);
bot.callbackQuery(
  /^bl:rc:([0-9a-f]{18}):(v4bid_[0-9a-f]{32})$/,
  async (ctx) => {
    await bidLadderRepositionConfirm(ctx, ctx.match[1]!,ctx.match[2]!);
  },
);
bot.callbackQuery(
  /^bl:rx:([0-9a-f]{18}):(v4bid_[0-9a-f]{32})$/,
  async (ctx) => {
    await bidLadderRepositionCancel(ctx,ctx.match[1]!,ctx.match[2]!);
  },
);
bot.callbackQuery(
  /^bl:rs:([0-9a-f]{18}):(v4bid_[0-9a-f]{32})$/,
  async (ctx) => {
    await bidLadderRepositionStop(ctx,ctx.match[1]!,ctx.match[2]!);
  },
);
bot.callbackQuery(/^v4-pool-technical:([^:]+)$/, async (ctx) => {
  const db = repo();
  try {
    const row = db.v4PoolSelection(ctx.match[1]!);
    return ctx.reply(
      row
        ? [
            "Technical details",
            `Pool ID: ${String(row.pool_id)}`,
            `Pool key: ${String(row.pool_key_json)}`,
            `Raw liquidity: ${String(row.liquidity_raw)}`,
            `Fee semantics: ${String(row.fee_semantics_json)}`,
            `Hook status: ${String(row.hook_status_json)}`,
            `Refresh block: ${String(row.refresh_block ?? "Unavailable")}`,
          ].join("\n")
        : "Pool technical details are unavailable.",
    );
  } finally {
    db.close();
  }
});
bot.callbackQuery(/^v4-checking:/, async (ctx) => {
  await ctx.reply(
    "CHECKING\nHydration is in progress. This row cannot open a position.",
  );
});
bot.callbackQuery(/^v4-unavailable:([^:]+)$/, async (ctx) => {
  const db = repo();
  try {
    const row = db.v4PoolSelection(ctx.match[1]!);
    if (row && BigInt(String(row.liquidity_raw)) <= 0n)
      await ctx.reply(
        "SUPPORTED · NO ACTIVE LIQUIDITY\nThis protocol-compatible pool cannot open until fresh active liquidity is positive.",
      );
    else {
      const blockers = row
        ? JSON.parse(String(row.blockers_json))
        : ["STALE_SELECTION"];
      await ctx.reply(
        `V4_POOL_UNAVAILABLE\n${blockers.join(", ")}\nNo execution callback is available.`,
      );
    }
  } finally {
    db.close();
  }
});
bot.callbackQuery(
  /^v4-spot-range:([^:]+):(10|30|50|60|custom)$/,
  async (ctx) => {
    await selectV4Range(
      ctx,
      ctx.match[1]!,
      ctx.match[2]! as "10" | "30" | "50" | "60" | "custom",
    );
  },
);
bot.callbackQuery(/^v4-open:([^:]+)$/, async (ctx) => {
  await v4OpenConfirm(ctx, ctx.match[1]!);
});
bot.callbackQuery(/^v4-open-technical:([^:]+)$/, async (ctx) => {
  const db = repo();
  try {
    const row = db.v4LiveOpenIntent(ctx.match[1]!);
    if (!row) return ctx.reply("Preview technical details are unavailable.");
    const payload = JSON.parse(String(row.payload_json));
    return ctx.reply(
      [
        "Technical details",
        `Pool ID: ${String(row.pool_id)}`,
        `Pool key: ${String(row.pool_key_json)}`,
        `Effective ticks: ${String(payload.preflight?.range?.tickLower ?? "Unavailable")} → ${String(payload.preflight?.range?.tickUpper ?? "Unavailable")}`,
        `Selection ID: ${String(payload.selectionId ?? "Unavailable")}`,
      ].join("\n"),
    );
  } finally {
    db.close();
  }
});
bot.callbackQuery(/^v4-live-close:(\d+):(\d+)$/, async (ctx) => {
  await v4LiveCloseConfirm(ctx, ctx.match[1]!, ctx.match[2]!);
});
bot.callbackQuery(/^blocked-canary:/, async (ctx) => {
  await ctx.reply(
    "EXECUTION_BLOCKED\nInspect the shared gate reasons, durable budget, and exact pool, then create a fresh preview.",
  );
});
bot.callbackQuery(/^open-canary:([^:]+)$/, async (ctx) => {
  await runPreparedCanary(ctx, ctx.match[1]!);
});
bot.callbackQuery(/^v4-position:(\d+)$/, async (ctx) => {
  await v4PositionView(ctx, ctx.match[1]!);
});
bot.callbackQuery(/^v4-action:(\d+):(collect|25|50|75|all)$/, async (ctx) => {
  await v4ManagementPreview(ctx, ctx.match[1]!, ctx.match[2]!);
});
bot.callbackQuery(/^v4-confirm:([^:]+)$/, async (ctx) => {
  await v4ManagementConfirm(ctx, ctx.match[1]!);
});
bot.on("callback_query:data", async (ctx) => {
  try {
    const [kind, sessionId, arg] = ctx.callbackQuery.data.split(":");
    if (kind === "pool" && sessionId && arg)
      await selectPool(ctx, sessionId, arg);
    else if (kind === "downside") {
      if (arg === "custom") {
        const flow = loadFlow(ctx, sessionId);
        if (!flow || flow.status !== "active" || flow.state.kind !== "mode")
          return unavailableFlow(ctx, "stale");
        const next = advanceFlow(
          ctx,
          flow,
          { ...flow.state, kind: "custom_downside" },
          "custom downside selected",
        );
        await ctx.reply(
          "Enter start and finish downside percentages as `start,finish`, for example `30,60`.",
          { reply_markup: keyboard([flowControls(next ?? flow)]) },
        );
      } else await selectDownside(ctx, sessionId, 0, Number(arg));
    } else if (kind === "balanced") {
      const flow = loadFlow(ctx, sessionId);
      if (!flow) return unavailableFlow(ctx, "stale");
      const next = advanceFlow(
        ctx,
        flow,
        { ...flow.state, kind: "range" },
        "balanced mode selected",
      );
      if (next)
        await ctx.reply("Choose a symmetric price range:", {
          reply_markup: keyboard([
            [
              { label: "±2%", data: `range:${next.sessionId}:2` },
              { label: "±5%", data: `range:${next.sessionId}:5` },
              { label: "±10%", data: `range:${next.sessionId}:10` },
            ],
            [{ label: "Custom", data: `range:${next.sessionId}:custom` }],
            flowControls(next),
          ]),
        });
    } else if (kind === "range") {
      if (arg === "custom")
        await ctx.reply("Use /range <percent> for a custom balanced range.");
      else await selectRange(ctx, sessionId, Number(arg));
    } else if (kind === "asset")
      await chooseAsset(ctx, sessionId, Number(arg) as 0 | 1);
    else if (kind === "back") {
      const flow = loadFlow(ctx, sessionId);
      if (!flow) return unavailableFlow(ctx, "stale");
      if (flow.status === "expired") return unavailableFlow(ctx, "expired");
      const state = flow.state;
      if (state.kind === "v4_strategy") {
        const saved = state.poolSelectionState;
        const poolState = saved && typeof saved === "object" && !Array.isArray(saved)
          ? saved as Record<string, unknown>
          : {
              kind: "pool",
              token: state.token,
              poolSelections: state.poolSelections,
              v4PoolSelections: state.v4PoolSelections,
              poolListing: state.poolListing,
              poolListingRender: state.poolListingRender,
              poolHydrationPending: state.poolHydrationPending,
              interactiveMessageIds: state.interactiveMessageIds,
              entryPriceCooldowns: state.entryPriceCooldowns,
            };
        const next = advanceFlow(ctx, flow, poolState, "back to exact pool selection");
        if (!next) return unavailableFlow(ctx, "stale");
        await renderPoolListing(ctx, next, 0);
      } else if (state.kind === "pool") {
        const next = advanceFlow(
          ctx,
          flow,
          { kind: "token_entry", interactiveMessageIds: state.interactiveMessageIds },
          "back to token entry",
        );
        if (!next) return unavailableFlow(ctx, "stale");
        await ctx.reply("Paste a token contract address to choose pools.", {
          reply_markup: keyboard([flowControls(next)]),
        });
      } else if (
        state.kind === "v4_bid_ladder_depth" ||
        state.kind === "v4_bid_ladder_custom_depth" ||
        state.kind === "v4_bid_ladder_amount" ||
        state.kind === "v4_bid_ladder_preview" ||
        state.kind === "v4_spot_range" ||
        state.kind === "v4_custom_downside" ||
        state.kind === "v4_amount"
      ) {
        await bidLadderReturn(ctx, flow);
      } else if (
        state.kind === "amount" &&
        state.mode === "SINGLE_SIDED_DOWNSIDE"
      ) {
        const next = advanceFlow(
          ctx,
          flow,
          { ...state, kind: "mode" },
          "back to liquidity mode",
        );
        if (next)
          await ctx.reply("Choose liquidity mode again.", {
            reply_markup: keyboard([
              [
                {
                  label: `${tokenLabel(state.funding as DisplayToken, state.target as DisplayToken)}-only ↓30%`,
                  data: `downside:${next.sessionId}:30`,
                },
              ],
              [
                {
                  label: "Balanced range",
                  data: `balanced:${next.sessionId}:0`,
                },
              ],
              flowControls(next),
            ]),
          });
      } else if (state.kind === "amount") {
        const token0 = state.token0 as DisplayToken,
          token1 = state.token1 as DisplayToken,
          next = advanceFlow(
            ctx,
            flow,
            { ...state, kind: "asset" },
            "back to amount side",
          );
        if (!next) return unavailableFlow(ctx, "stale");
        await ctx.reply("Choose the asset amount you will enter:", {
          reply_markup: keyboard([
            [
              {
                label: `Enter ${tokenLabel(token0, token1)} amount`,
                data: `asset:${next.sessionId}:0`,
              },
            ],
            [
              {
                label: `Enter ${tokenLabel(token1, token0)} amount`,
                data: `asset:${next.sessionId}:1`,
              },
            ],
            flowControls(next),
          ]),
        });
      } else await unavailableFlow(ctx, "stale");
    } else if (kind === "cancel-flow") {
      const flow = loadFlow(ctx, sessionId);
      cancelFlow(ctx, sessionId);
      await ctx.reply("Flow cancelled. Paste a token contract address when ready.");
    } else if (kind === "start-over") {
      cancelFlow(ctx);
      await ctx.reply("Paste a token contract address to start over.");
    } else if (kind === "position") await positionView(ctx, sessionId);
    else if (kind === "collect")
      await managementPreview(ctx, sessionId, "COLLECT");
    else if (kind === "partial")
      await managementPreview(ctx, sessionId, "PARTIAL_CLOSE");
    else if (kind === "full")
      await managementPreview(ctx, sessionId, "FULL_CLOSE");
    else if (kind === "open-canary") await runConfirmedCanary(ctx, sessionId);
    else if (kind === "blocked-canary")
      await ctx.reply(
        "EXECUTION_BLOCKED\nArm the canary and enable every guarded execution gate, then create a fresh preview.",
      );
    else if (kind === "confirm" || kind === "cancel") {
      const db = repo();
      try {
        const current = await rpc.withClient((client) =>
          client.getBlockNumber(),
        );
        const result = db.resolveConfirmation(
          sessionId,
          owner(ctx),
          kind === "confirm" ? "confirm" : "cancel",
          current.toString(),
        );
        await ctx.reply(
          `Confirmation ${sessionId}: ${String(result.state)}. No transaction was sent.`,
        );
      } finally {
        db.close();
      }
    }
  } catch (error) {
    log("telegram_callback_handler_failed", { reason: textError(error) });
    await ctx.reply(`ACTION_UNAVAILABLE\n${textError(error)}`);
  }
});
bot.on("message:text", async (ctx) => {
  const pasteReceivedAtMs=Date.now(),value = ctx.message.text.trim();
  if (isEvmAddressText(value)) {
    log("telegram_text_routed", {
      classification: "token_address",
      user: reduced(owner(ctx)),
      chat: reduced(chat(ctx)),
    });
    return beginToken(ctx, value, pasteReceivedAtMs);
  }
  const active = loadFlow(ctx),
    route = routeTelegramText(active?.state.kind as string | undefined, value);
  if (active?.state.kind === "adoption_baseline_amount")
    return adoptionBaselineAmount(ctx, active, value);
  if (active?.state.kind === "custom_downside") {
    const pair = value.split(",").map((x) => Number(x.trim()));
    if (pair.length !== 2 || !pair.every(Number.isFinite))
      return preserve(
        ctx,
        active,
        "Enter two percentages as start,finish, for example 30,60.",
      );
    return selectDownside(ctx, active.sessionId, pair[0]!, pair[1]!);
  }
  if (active?.state.kind === "v4_custom_downside") {
    const pair = value.split(",").map((x) => Number(x.trim()));
    if (pair.length !== 2 || !pair.every(Number.isFinite))
      return preserve(
        ctx,
        active,
        "Enter two percentages as start,finish, for example 30,60.",
      );
    try {
      validateV4DownsideRange({
        upperDropPct: pair[0]!,
        lowerDropPct: pair[1]!,
      });
    } catch (error) {
      return preserve(ctx, active, textError(error));
    }
    return finishV4Range(ctx, active, {
      upperDropPct: pair[0]!,
      lowerDropPct: pair[1]!,
    });
  }
  if (active?.state.kind === "v4_bid_ladder_depth")
    return preserveBidLadderDepthText(ctx, active);
  if (active?.state.kind === "v4_bid_ladder_custom_depth") {
    const percent = Number(value),
      bps = Number.isFinite(percent) ? Math.floor(percent * 100) : NaN;
    if (!Number.isSafeInteger(bps) || bps <= 0 || bps >= 10_000)
      return preserve(
        ctx,
        active,
        "Enter a maximum downside percentage greater than 0 and below 100.",
      );
    try {
      return bidLadderSelectDepth(ctx, active, bps, "custom BID ladder max depth selected");
    } catch (error) {
      return preserve(ctx, active, textError(error));
    }
  }
  if (active?.state.kind === "v4_amount")
    return addPreview(ctx, parseAmountMessage(value) ?? "");
  if (active?.state.kind === "v4_bid_ladder_amount")
    return bidLadderDirectLive(ctx, value);
  if (route === "amount")
    return addPreview(ctx, parseAmountMessage(value) ?? "");
  if (active)
    return preserve(
      ctx,
      active,
      "Enter the requested amount, or use Back / Cancel / Start over.",
    );
  const latest = loadLatestFlow(ctx);
  if (
    latest?.status === "expired" &&
    (latest.state.kind === "amount" ||
      latest.state.kind === "custom_downside" ||
      latest.state.kind === "v4_custom_downside" ||
      latest.state.kind === "v4_amount" ||
      latest.state.kind === "adoption_baseline_amount")
  )
    return unavailableFlow(ctx, "expired");
  return ctx.reply("Paste a token contract address, or use /positions.");
});
bot.catch(async (error) => {
  const ctx = error.ctx as any,
    operation = safeTelegramOperation(ctx),
    busy = isSqliteBusy(error.error),
    details = safeTelegramError(error.error);
  log("telegram_update_failed", {
    operation,
    updateId:
      typeof ctx.update?.update_id === "number"
        ? ctx.update.update_id
        : undefined,
    ...details,
    retryable: busy,
    mainnetTransactionsSent: 0,
  });
  if (busy) {
    try {
      await ctx.reply(
        "Temporarily busy. Please tap the button again in a moment.",
      );
    } catch (deliveryError) {
      log("telegram_busy_response_failed", {
        operation,
        ...safeTelegramError(deliveryError),
      });
    }
    return;
  }
  try {
    await ctx.reply(
      "Temporary bot error. No transaction was sent; please try again.",
    );
  } catch (deliveryError) {
    log("telegram_error_response_failed", {
      operation,
      ...safeTelegramError(deliveryError),
    });
  }
});
const startupResult = startRuntime();
v4PreviewStaticPrewarmInitiated = true;
void prewarmV4OperationalPreviewStaticVerification(rpc)
  .then(() =>
    log("v4_preview_static_verification_prewarmed", {
      canonicalPool:
        process.env.V4_CANONICAL_NATIVE_USD_POOL ?? "configured-default",
      mainnetTransactionsSent: 0,
    }),
  )
  .catch((error) =>
    log("v4_preview_static_verification_failed", {
      error: textError(error),
      mainnetTransactionsSent: 0,
    }),
  );
void directLookupOutboxConsumer();
void positionClosedCardConsumer();
void usdResetRepositionConsumer();
log("telegram_started", {
  databasePath: runtimePaths.databasePath,
  executionEnabled: env.EXECUTION_ENABLED,
  dryRun: env.DRY_RUN,
  emergencyPause: env.EMERGENCY_PAUSE,
  liveCanaryEnabled: env.LIVE_CANARY_ENABLED,
  v4LiveCanaryEnabled: env.V4_LIVE_CANARY_ENABLED,
  safetyOwnership: "READ_ONLY_SAFETY_CONSUMER",
  authoritativeSafety:
    startupResult.status === "READY"
      ? startupResult.safety
      : {
          status: "DEFERRED",
          executionEnabled: false,
          dryRun: true,
          emergencyPause: true,
        },
  directLookupPollingIterations: 0,
  outboxCadenceMs,
  pnlCardDeliveryCadenceMs:250,
});
const stop = (signal: string) => {
  telegramStopping = true;
  log("telegram_stopping", { signal });
  bot.stop();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
bot.start();
