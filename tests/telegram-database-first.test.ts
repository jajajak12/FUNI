import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import { persistedPositionViews } from "../apps/telegram-lp-bot/src/persisted-portfolio.js";

const key = {
  currency0: "0x0000000000000000000000000000000000000001",
  currency1: "0x0000000000000000000000000000000000000002",
  fee: 500,
  tickSpacing: 10,
  hooks: "0x0000000000000000000000000000000000000000",
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "persisted-portfolio-")),
    path = join(dir, "db.sqlite");
  migrateSqlite(path, "infra/migrations");
  const repo = new SqliteLedgerRepository(path);
  return {
    dir,
    repo,
    close() {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("database-first Telegram positions", () => {
  it("composes receipt OPEN_CONFIRMING truth over a stale snapshot and converges without duplicates", () => {
    const f = fixture();
    try {
      f.repo.db
        .prepare(
          "INSERT INTO portfolio_persisted_snapshot(snapshot_key,payload_json,content_hash,refreshed_at_ms) VALUES('current','{\"positions\":[]}','stale',1)",
        )
        .run();
      f.repo.ensurePosition("v4:101", "101", "pool");
      f.repo.upsertV4Position({
        tokenId: 101n,
        owner: "0x0000000000000000000000000000000000000003",
        poolId: "pool",
        poolKey: key,
        currency0: key.currency0,
        currency1: key.currency1,
        fee: 500,
        tickSpacing: 10,
        hooks: key.hooks,
        tickLower: -20,
        tickUpper: -10,
        liquidity: 1n,
        initialAmount0: 0n,
        initialAmount1: 5_000_000n,
        mintHash: "0xmint",
        targetToken: key.currency0,
        fundingToken: key.currency1,
        targetSymbol: "ASSET_A",
        fundingSymbol: "USDG",
        targetDecimals: 18,
        fundingDecimals: 6,
        targetIndex: 0,
        fundingIndex: 1,
        openIntentId: "v4bid_00000000000000000000000000000001",
        openEvidence: { receiptConfirmed: true },
      });
      f.repo.db
        .prepare(
          "INSERT INTO active_position_reconciliations(position_id,protocol_version,token_id,manager_address,owner_status,confirmed_active,contributes_equity,checked_at_ms,fresh_until_ms,retry_count,details_json) VALUES('v4:101','v4','101','manager','UNKNOWN',0,0,2,2,0,'{\"presentationState\":\"OPEN_CONFIRMING\"}')",
        )
        .run();
      const first = persistedPositionViews(f.repo);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        pair: "ASSET_A/USDG",
        lifecycle: "OPEN_CONFIRMING",
        openIntentId: "v4bid_00000000000000000000000000000001",
        accounting: { currentEquityUsd: null },
      });
      f.repo.db
        .prepare(
          "UPDATE portfolio_persisted_snapshot SET payload_json=?,content_hash='caught-up',refreshed_at_ms=3",
        )
        .run(JSON.stringify({ positions: first }));
      expect(
        persistedPositionViews(f.repo).filter(
          (row) => row.positionId === "v4:101",
        ),
      ).toHaveLength(1);
    } finally {
      f.close();
    }
  });
  it("overrides stale OPEN presentation with newly terminal canonical truth", () => {
    const f = fixture();
    try {
      f.repo.ensurePosition("v4:9", "9", "pool");
      f.repo.upsertV4Position({
        tokenId: 9n,
        owner: "0x0000000000000000000000000000000000000003",
        poolId: "pool",
        poolKey: key,
        currency0: key.currency0,
        currency1: key.currency1,
        fee: 500,
        tickSpacing: 10,
        hooks: key.hooks,
        tickLower: -20,
        tickUpper: -10,
        liquidity: 0n,
        initialAmount0: 0n,
        initialAmount1: 1n,
        mintHash: "0xmint",
        targetToken: key.currency0,
        fundingToken: key.currency1,
        targetSymbol: "ASSET_A",
        fundingSymbol: "USDG",
        targetDecimals: 18,
        fundingDecimals: 6,
        targetIndex: 0,
        fundingIndex: 1,
        openIntentId: "intent",
      });
      const base = persistedPositionViews(f.repo)[0]!;
      f.repo.db
        .prepare(
          "INSERT INTO portfolio_persisted_snapshot(snapshot_key,payload_json,content_hash,refreshed_at_ms) VALUES('current',?,'stale',1)",
        )
        .run(
          JSON.stringify({
            positions: [{ ...base, lifecycle: "CONFIRMED_ACTIVE_FRESH" }],
          }),
        );
      f.repo.db
        .prepare(
          "INSERT INTO active_position_reconciliations(position_id,protocol_version,token_id,manager_address,owner_status,terminal_reason,confirmed_active,contributes_equity,checked_at_ms,fresh_until_ms,retry_count,details_json) VALUES('v4:9','v4','9','manager','VERIFIED_OWNED','CLOSED_EMPTY',0,0,2,2,0,'{\"presentationState\":\"TERMINAL\"}')",
        )
        .run();
      expect(persistedPositionViews(f.repo)[0]).toMatchObject({
        lifecycle: "TERMINAL",
        terminalReason: "CLOSED_EMPTY",
        rangeStatus: "CLOSED",
      });
    } finally {
      f.close();
    }
  });
  it("renders bot-operational provenance and receipt-proven USDG capital without RPC", () => {
    const f = fixture();
    try {
      f.repo.ensurePosition("v4:7", "7", "pool");
      f.repo.upsertV4Position({
        tokenId: 7n,
        owner: "0x0000000000000000000000000000000000000003",
        poolId: "pool",
        poolKey: key,
        currency0: key.currency0,
        currency1: key.currency1,
        fee: 500,
        tickSpacing: 10,
        hooks: key.hooks,
        tickLower: -20,
        tickUpper: -10,
        liquidity: 1n,
        initialAmount0: 0n,
        initialAmount1: 5_000_000n,
        mintHash: "0xmint",
        targetToken: key.currency0,
        fundingToken: key.currency1,
        targetSymbol: "ASSET_B",
        fundingSymbol: "USDG",
        targetDecimals: 18,
        fundingDecimals: 6,
        targetIndex: 0,
        fundingIndex: 1,
        openIntentId: "intent-1",
        openEvidence: { lane: "operational" },
      });
      f.repo.ingestDeposit({
        id: "d",
        positionId: "v4:7",
        txHash: "0xmint",
        logIndex: 0,
        amounts: { token0: 0n, token1: 5_000_000n },
        blockNumber: 1n,
        blockTimestamp: new Date().toISOString(),
      });
      expect(persistedPositionViews(f.repo)[0]).toMatchObject({
        source: "BOT_OPERATIONAL",
        accountingStatus: "RECEIPT_ACCOUNTED",
        openIntentId: "intent-1",
        accounting: { externalCapitalUsd: 5 },
      });
    } finally {
      f.close();
    }
  });
  it("contains no production Telegram fork or sequential simulator invocation", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8");
    expect(source).not.toMatch(
      /\bsequentialApprovalMintSimulation\b|\bfork-artifacts\b|\bfromBlock\s*:\s*0n/,
    );
  });
  it("keeps list pagination SQLite-only and queues adoption only after first paint", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      start = source.indexOf("async function positionsCommand"),
      end = source.indexOf("async function beginAdoptionBaseline"),
      command = source.slice(start, end);
    expect(command).not.toMatch(/\bsyncWalletPositions\b/);
    expect(command.search(/await\s+ctx\.reply\s*\(/)).toBeLessThan(
      command.search(/\benqueueWalletPositionSync\s*\(/),
    );
    expect(source).toMatch(
      /positionsCommand\s*\(\s*ctx\s*,\s*Number\s*\(\s*ctx\.match\[1\]\s*!\s*\)\s*,\s*false\s*\)/,
    );
  });
  it("treats post-response sync enqueue contention as best effort with bounded retry and no second reply", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      start = source.indexOf("async function positionsCommand"),
      end = source.indexOf("async function beginAdoptionBaseline"),
      command = source.slice(start, end),
      reply = command.indexOf("message = await ctx.reply"),
      enqueue = command.indexOf(
        'operation: "positions_post_response_sync_enqueue"',
      ),
      deferred = command.indexOf("telegram_positions_refresh_enqueue_deferred");
    expect(reply).toBeGreaterThanOrEqual(0);
    expect(enqueue).toBeGreaterThan(reply);
    expect(deferred).toBeGreaterThan(enqueue);
    expect(command.slice(enqueue)).not.toContain("ctx.reply(");
    expect(command).toContain("retrySqliteBusySync");
    expect(command).toContain("responseAlreadySent: true");
  });
  it("renders portfolio from SQLite before one deduplicated refresh enqueue", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      start = source.indexOf("async function portfolioCommand"),
      end = source.indexOf('bot.command("portfolio"', start),
      command = source.slice(start, end);
    expect(command).toMatch(/\bpersistedPortfolioSnapshot\s*\(/);
    expect(command).not.toMatch(/\bportfolioReport\s*\(/);
    expect(command.search(/await\s+ctx\.reply\s*\(/)).toBeLessThan(
      command.search(/\benqueuePortfolioRefresh\s*\(/),
    );
  });
  it("acknowledges callbacks in middleware before RPC-bearing handlers", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      middleware = source.search(
        /bot\.use\s*\(\s*async\s*\(\s*ctx\s*,\s*next\s*\)\s*=>\s*\{\s*if\s*\(\s*ctx\.callbackQuery\s*\)\s*await\s+acknowledgeCallback\s*\(\s*ctx\s*\)/,
      );
    expect(middleware).toBeGreaterThanOrEqual(0);
    expect(middleware).toBeLessThan(
      source.search(/bot\.callbackQuery\s*\(\s*\/\^portfolio-position/),
    );
  });
  it("refreshes only the selected token and suppresses unchanged message edits", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      start = source.indexOf("async function refreshPositionDetail"),
      end = source.indexOf("async function positionsCommand"),
      refresh = source.slice(start, end);
    expect(refresh).not.toMatch(/\bsyncWalletPositions\b/);
    expect(refresh).toMatch(/prior\?\.content_hash\s*!==\s*contentHash/);
    expect(refresh).toMatch(/if\s*\(\s*changed\s*\)/);
    expect(refresh).toMatch(/reply_markup\s*:\s*keyboard\s*\(\s*rows\s*\)/);
  });
  it("uses one canonical keyboard, retains actions while a verified position refreshes, and removes them for non-active lifecycle", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      start = source.indexOf("function detailRows"),
      end = source.indexOf("async function refreshPositionDetail"),
      renderer = source.slice(start, end);
    expect(renderer).toMatch(
      /position\.lifecycle\s*!==\s*['"]CONFIRMED_ACTIVE_FRESH['"]\s*&&\s*position\.lifecycle\s*!==\s*['"]CONFIRMED_ACTIVE_REFRESHING['"]/,
    );
    expect(renderer).toContain("Close all and burn");
    expect(source.match(/detailRows\s*\(\s*persisted\s*\)/g)?.length).toBe(2);
  });
  it("acknowledges amount input before bounded preview work and emits complete stage telemetry without sync or Anvil", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      start = source.indexOf("async function v4OpenPreview"),
      end = source.indexOf("async function v4OpenConfirm"),
      preview = source.slice(start, end);
    expect(
      preview.indexOf("ctx.reply('Preparing final preview...')"),
    ).toBeLessThan(preview.indexOf("v4OperationalOpenPreflight"));
    for (const field of [
      "amountInputAckMs",
      "deploymentCacheMs",
      "deploymentCacheHit",
      "staticVerificationPrewarmed",
      "sharedBlockNumber",
      "dynamicMulticallCount",
      "dynamicMulticallMembers",
      "canonicalPriceCacheHit",
      "duplicateReadsEliminated",
      "rpcCountsByStage",
      "tokenMetadataMs",
      "balanceMs",
      "allowanceMs",
      "poolStateMs",
      "pricingMs",
      "nativeUsdMs",
      "nativeUsdNestedInPricing",
      "approvalEstimateMs",
      "mintEstimateMs",
      "lifecycleProjectionMs",
      "databaseMs",
      "telegramReplyMs",
      "totalPreviewMs",
      "rpcMethodCounts",
    ])
      expect(preview).toContain(field);
    expect(preview).not.toContain("syncWalletPositions");
    expect(preview).not.toContain("Anvil");
    expect(preview).not.toContain("operationalFundingUsd");
    expect(preview).not.toContain("operationalNativeUsd");
  });
  it("does not let a presentation preview context bypass the fresh final execution preflight", () => {
    const source = readFileSync(
        "apps/cli/src/v4-operational-executor.ts",
        "utf8",
      ),
      start = source.indexOf("export async function executeV4OperationalOpen"),
      execution = source.slice(start);
    expect(execution).toContain(
      "v4OperationalOpenPreflight({...input,intentId:input.intentId})",
    );
    expect(execution).not.toContain("previewContext:");
  });
  it("returns direct-CA handlers after one durable request and uses a global outbox instead of per-message polling", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      start = source.indexOf("async function beginToken"),
      end = source.indexOf("function renderPoolListing"),
      lookup = source.slice(start, end);
    expect(lookup).toContain("createOrReuseDirectLookup");
    expect(lookup).toContain("attachDirectLookupSubscriber");
    expect(lookup).not.toContain("setTimeout");
    expect(source).not.toContain("scheduleHydrationEdit");
    expect(source).not.toContain("noChangeRenderCount");
    expect(source).toContain("directLookupOutboxConsumer");
  });
});
