import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import { poolId, sqrtPriceAtTick, type V4PoolState } from "@funi/v4";
import {
  bindPersistedV4BidLadderCurrentState,
  createV4BidLadderDryRun,
  createV4BidLadderLive,
  displayV4BidLadderMarketCapEvidence,
  estimateV4BidLadderMarketCapRange,
  evaluatePersistedV4BidLadder,
  formatPersistedV4BidLadder,
  formatV4BidLadderPreview,
  previewV4BidLadder,
  restoreV4BidLadderPreview,
  snapshotV4BidLadderPreview,
} from "../apps/cli/src/v4-bid-ladder-operator.js";
import { evaluateV4BidLadderV1 } from "../apps/cli/src/v4-bid-ladder-planner.js";
import { bidLadderRepositionActionState } from "../apps/telegram-lp-bot/src/persisted-portfolio.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const c0 = "0x0000000000000000000000000000000000000001" as const,
  c1 = "0x0000000000000000000000000000000000000002" as const,
  owner = "0x0000000000000000000000000000000000000003" as const,
  hook = "0x0000000000000000000000000000000000000000" as const;
function pool(): V4PoolState {
  const key = {
    currency0: c0,
    currency1: c1,
    fee: 3000,
    tickSpacing: 10,
    hooks: hook,
  } as const;
  return {
    id: poolId(key),
    key,
    sqrtPriceX96: sqrtPriceAtTick(0),
    tick: 0,
    liquidity: 1_000_000_000_000n,
    initialized: true,
    blockNumber: 123n,
  };
}
function preview(
  funding: typeof c0 | typeof c1 = c1,
  target: typeof c0 | typeof c1 = c0,
  state = pool(),
) {
  return previewV4BidLadder({
    pool: state,
    funding: {
      address: funding,
      symbol: funding === c1 ? "USDG" : "WETH",
      decimals: funding === c1 ? 6 : 18,
    },
    target: {
      address: target,
      symbol: target === c0 ? "WETH" : "USDG",
      decimals: target === c0 ? 18 : 6,
    },
    totalFundingAmount: 10_000_000n,
    owner,
    deadline: 999999n,
    nowMs: 1000,
  });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "v4-bid-ladder-tg-"));
  roots.push(root);
  const path = join(root, "db.sqlite");
  migrateSqlite(path, "infra/migrations");
  return new SqliteLedgerRepository(path);
}

describe("V4 BID ladder manual dry-run operator surface", () => {
  it("previews five approved legs without persistence and labels dry run", () => {
    const repo = fixture();
    try {
      const value = preview(),
        text = formatV4BidLadderPreview(value);
      expect(value.plan.legs).toHaveLength(5);
      expect(text).toContain("DRY RUN");
      expect(text).toContain("No transaction will be signed or broadcast.");
      expect(repo.listBidLadders()).toEqual([]);
    } finally {
      repo.close();
    }
  });
  it("creates atomically and idempotently without any live intent or journal", () => {
    const repo = fixture();
    try {
      const value = preview(),
        first = createV4BidLadderDryRun(repo, value),
        second = createV4BidLadderDryRun(
          repo,
          restoreV4BidLadderPreview(snapshotV4BidLadderPreview(value)),
        );
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(repo.listBidLadders()).toHaveLength(1);
      expect(repo.listBidLadderLegs(value.plan.ladderId)).toHaveLength(5);
      for (const table of [
        "v4_live_open_intents",
        "v4_positions",
        "v4_lifecycle_intents",
        "chain_transaction_journal",
      ])
        expect(
          repo.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
    } finally {
      repo.close();
    }
  });
  it("persists trusted preview symbols by exact address across restart, without cache fallback", () => {
    const repo = fixture();
    try {
      const value = preview(),
        created = createV4BidLadderLive(repo, value, 10),
        parent = created.ladder;
      expect(parent).toMatchObject({
        target_symbol: "WETH",
        funding_symbol: "USDG",
      });
      const evidence = JSON.parse(String(parent.symbol_provenance_json));
      expect(evidence).toMatchObject({
        source: "TRUSTED_SELECTION_ERC20_METADATA_V1",
      });
      expect(evidence.bindings).toContainEqual({ address: c0, symbol: "WETH" });
      repo.close();
      const reopened = new SqliteLedgerRepository(repo.path);
      try {
        expect(reopened.loadBidLadder(value.plan.ladderId)).toMatchObject({
          target_symbol: "WETH",
          funding_symbol: "USDG",
        });
      } finally {
        reopened.close();
      }
    } finally {
      try {
        repo.close();
      } catch {}
    }
  });
  it("creates the normal operator ladder as LIVE/PLANNED with atomic generation-zero reset enablement and no signing artifacts", () => {
    const repo = fixture();
    try {
      const value = preview(),
        first = createV4BidLadderLive(repo, value, 10),
        second = createV4BidLadderLive(
          repo,
          restoreV4BidLadderPreview(snapshotV4BidLadderPreview(value)),
          10,
        );
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(first.ladder).toMatchObject({
        execution_mode: "LIVE",
        status: "PLANNED",
        entry_usd_snapshot: 10,
      });
      expect(repo.listBidLadders()).toHaveLength(1);
      expect(repo.loadBidLadderUsdReset(value.plan.ladderId)).toMatchObject({
        ladder_id: value.plan.ladderId,
        root_ladder_id: value.plan.ladderId,
        previous_ladder_id: null,
        generation: 0,
        policy: "USDG_RESET_REPOSITION_V1",
        creation_reason: "INITIAL_OPEN",
        phase: "OPEN_PENDING",
      });
      for (const table of [
        "v4_live_open_intents",
        "v4_positions",
        "v4_lifecycle_intents",
        "chain_transaction_journal",
        "nonce_mutex",
      ])
        expect(
          repo.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
    } finally {
      repo.close();
    }
  });
  it("conflicts safely for a changed plan with the same identity", () => {
    const repo = fixture();
    try {
      const value = preview();
      createV4BidLadderDryRun(repo, value);
      const changed = {
        ...value,
        plan: { ...value.plan, referenceTick: value.plan.referenceTick + 1 },
      };
      expect(() => createV4BidLadderDryRun(repo, changed)).toThrow(
        "V4_BID_LADDER_PLAN_CONFLICT",
      );
    } finally {
      repo.close();
    }
  });
  it("supports both orientations and rejects hook or dynamic fee pools", () => {
    expect(preview(c1, c0).plan.fundingIndex).toBe(1);
    expect(preview(c0, c1).plan.fundingIndex).toBe(0);
    expect(() =>
      preview(c1, c0, {
        ...pool(),
        key: {
          ...pool().key,
          hooks: "0x0000000000000000000000000000000000000001",
        },
      }),
    ).toThrow("V4_BID_LADDER_POOL_BLOCKED");
    expect(() =>
      preview(c1, c0, { ...pool(), key: { ...pool().key, fee: 0x800000 } }),
    ).toThrow("V4_BID_LADDER_POOL_BLOCKED");
  });
  it("renders active status and no raw StateView L in normal views", () => {
    const repo = fixture();
    try {
      const value = preview(),
        state = pool();
      createV4BidLadderDryRun(repo, value);
      const parent = repo.loadBidLadder(value.plan.ladderId)!,
        legs = repo.listBidLadderLegs(value.plan.ladderId),
        tokens = { funding: value.funding, target: value.target };
      const above = evaluatePersistedV4BidLadder({
        parent,
        legs,
        current: { tick: 0, sqrtPriceX96: sqrtPriceAtTick(0) },
      });
      expect(above.counts).toEqual({ above: 5, in: 0, below: 0 });
      const rendered = formatPersistedV4BidLadder({
          parent,
          legs,
          ...tokens,
          current: undefined,
        }),
        normal = formatPersistedV4BidLadder({
          parent,
          legs,
          ...tokens,
          current: state,
          poolUsdMetricLine: "Pool liquidity: $30.4K",
        });
      expect(rendered).toContain("Current state: Unavailable");
      expect(normal).toContain("Liquidity status: Active");
      expect(normal).toContain("Pool liquidity: $30.4K");
      expect(normal).not.toContain("Active liquidity:");
      expect(normal).not.toContain("1000000000000");
      expect(normal).toContain("#1 ABOVE_RANGE");
      expect(rendered).not.toMatch(/APR|PnL|earned fees|return %/i);
    } finally {
      repo.close();
    }
  });
  it("requires exact PoolId and every PoolKey field before current inventory evaluation", () => {
    const repo = fixture();
    try {
      const value = preview(),
        state = pool();
      createV4BidLadderDryRun(repo, value);
      const parent = repo.loadBidLadder(value.plan.ladderId)!;
      expect(bindPersistedV4BidLadderCurrentState(parent, state).status).toBe(
        "available",
      );
      const variants = [
        { ...state, id: "0x" + "11".repeat(32) },
        { ...state, key: { ...state.key, currency0: c1 } },
        { ...state, key: { ...state.key, currency1: c0 } },
        { ...state, key: { ...state.key, fee: 500 } },
        { ...state, key: { ...state.key, tickSpacing: 20 } },
        {
          ...state,
          key: {
            ...state.key,
            hooks: "0x0000000000000000000000000000000000000004" as const,
          },
        },
      ];
      for (const current of variants)
        expect(
          bindPersistedV4BidLadderCurrentState(parent, current as V4PoolState)
            .status,
        ).toBe("unavailable");
    } finally {
      repo.close();
    }
  });
  it("shows compact separately sourced pool liquidity in fresh LIVE state views", () => {
    const repo = fixture();
    try {
      const value = preview(),
        state = pool();
      createV4BidLadderDryRun(repo, value);
      const parent = repo.loadBidLadder(value.plan.ladderId)!,
        legs = repo.listBidLadderLegs(value.plan.ladderId),
        text = formatPersistedV4BidLadder({
          parent,
          legs,
          funding: value.funding,
          target: value.target,
          current: state,
          poolUsdMetricLine: "Pool liquidity: $30.4K",
        });
      expect(text).toContain("Liquidity status: Active");
      expect(text).toContain("Pool liquidity: $30.4K");
      expect(text).not.toContain("Active liquidity:");
    } finally {
      repo.close();
    }
  });
  it("estimates aggregate MC from the persisted executable boundaries for target currency0", () => {
    const repo = fixture();
    try {
      const value = preview(),
        state = pool();
      createV4BidLadderDryRun(repo, value);
      const parent = repo.loadBidLadder(value.plan.ladderId)!,
        legs = repo.listBidLadderLegs(value.plan.ladderId),
        first = legs[0]!,
        last = legs.at(-1)!,
        probe = estimateV4BidLadderMarketCapRange({
          parent,
          legs,
          target: value.target,
          funding: value.funding,
          evidence: { marketCapUsd: 1_000_000, tokenPriceUsd: 1 },
        })!;
      expect(probe.startTick).toBe(Number(first.tick_upper));
      expect(probe.deepestTick).toBe(Number(last.tick_lower));
      const exact = estimateV4BidLadderMarketCapRange({
        parent,
        legs,
        target: value.target,
        funding: value.funding,
        evidence: {
          marketCapUsd: 1_000_000,
          tokenPriceUsd: probe.startUsd / 800_000,
        },
      })!;
      expect(exact.startUsd).toBeCloseTo(800_000, 5);
      expect(exact.startUsd).toBeGreaterThan(exact.deepestUsd);
      const text = formatPersistedV4BidLadder({
        parent,
        legs,
        funding: value.funding,
        target: value.target,
        current: state,
        marketCapEvidence: {
          marketCapUsd: 1_000_000,
          tokenPriceUsd: probe.startUsd / 800_000,
        },
      });
      expect(text).toContain("Current MC: $1M");
      expect(text).toContain("Estimated ladder MC range: $800K");
    } finally {
      repo.close();
    }
  });
  it("keeps target currency1 MC orientation uninverted and uses its persisted boundaries", () => {
    const repo = fixture();
    try {
      const value = preview(c0, c1),
        state = pool();
      createV4BidLadderDryRun(repo, value);
      const parent = repo.loadBidLadder(value.plan.ladderId)!,
        legs = repo.listBidLadderLegs(value.plan.ladderId),
        estimate = estimateV4BidLadderMarketCapRange({
          parent,
          legs,
          target: value.target,
          funding: value.funding,
          evidence: { marketCapUsd: 1_000_000, tokenPriceUsd: 1 },
        })!;
      expect(estimate.startTick).toBe(Number(legs[0]!.tick_lower));
      expect(estimate.deepestTick).toBe(Number(legs.at(-1)!.tick_upper));
      expect(estimate.startUsd).toBeGreaterThan(estimate.deepestUsd);
      expect(
        formatPersistedV4BidLadder({
          parent,
          legs,
          funding: value.funding,
          target: value.target,
          current: state,
          marketCapEvidence: { marketCapUsd: 1_000_000, tokenPriceUsd: 1 },
        }),
      ).toContain("Estimated ladder MC range:");
    } finally {
      repo.close();
    }
  });
  it("fails soft when GMGN market cap or token price evidence is missing or invalid", () => {
    const repo = fixture();
    try {
      const value = preview(),
        parent = createV4BidLadderDryRun(repo, value).ladder,
        legs = repo.listBidLadderLegs(value.plan.ladderId);
      for (const evidence of [
        undefined,
        { marketCapUsd: 0, tokenPriceUsd: 1 },
        { marketCapUsd: 1_000_000, tokenPriceUsd: 0 },
      ]) {
        const text = formatPersistedV4BidLadder({
          parent,
          legs,
          funding: value.funding,
          target: value.target,
          marketCapEvidence: evidence,
        });
        expect(text).toContain("Current MC: Unavailable");
        expect(text).toContain("Estimated ladder MC range: Unavailable");
        expect(text).toContain("V4 BID Ladder V1");
      }
    } finally {
      repo.close();
    }
  });
  it("uses canonical GMGN MC first and otherwise derives display-only MC from fresh price and circulating supply", () => {
    const target = "0x0000000000000000000000000000000000000047",
      raw = {
        address: target,
        price: { price: "0.0026462332" },
        circulating_supply: "1000000000",
        total_supply: "2000000000",
      },
      observation = { tokenAddress: target, marketCapUsd: 123 };
    const canonical = displayV4BidLadderMarketCapEvidence({
      raw,
      observation,
      targetAddress: target,
    })!;
    expect(canonical).toEqual({
      marketCapUsd: 123,
      tokenPriceUsd: 0.0026462332,
    });
    const fallback = displayV4BidLadderMarketCapEvidence({
      raw,
      observation: { tokenAddress: target },
      targetAddress: target,
    })!;
    expect(fallback.marketCapUsd).toBeCloseTo(2_646_233.2, 5);
    expect(observation.marketCapUsd).toBe(123);
  });
  it("uses total supply only when circulating supply is missing or invalid", () => {
    const target = "0x0000000000000000000000000000000000000047",
      input = { observation: { tokenAddress: target }, targetAddress: target };
    expect(
      displayV4BidLadderMarketCapEvidence({
        ...input,
        raw: { address: target, price: { price: "2" }, total_supply: "3" },
      }),
    ).toEqual({ marketCapUsd: 6, tokenPriceUsd: 2 });
    expect(
      displayV4BidLadderMarketCapEvidence({
        ...input,
        raw: {
          address: target,
          price: { price: "2" },
          circulating_supply: "4",
          total_supply: "3",
        },
      }),
    ).toEqual({ marketCapUsd: 8, tokenPriceUsd: 2 });
  });
  it("fails soft for invalid fresh price or supplies and never substitutes liquidity, ATH, or FDV", () => {
    const target = "0x0000000000000000000000000000000000000047",
      input = { observation: { tokenAddress: target }, targetAddress: target };
    for (const raw of [
      { address: target, price: {}, circulating_supply: "1" },
      { address: target, price: { price: "0" }, circulating_supply: "1" },
      { address: target, price: { price: "NaN" }, circulating_supply: "1" },
      {
        address: target,
        price: { price: "1" },
        circulating_supply: "0",
        total_supply: "NaN",
      },
      {
        address: target,
        price: { price: "1" },
        liquidity: "9",
        ath_mc: "8",
        fdv: "7",
      },
    ])
      expect(
        displayV4BidLadderMarketCapEvidence({ ...input, raw }),
      ).toBeUndefined();
  });
  it("requires normalized GMGN address to match the exact target before display evidence", () => {
    const target = "0x0000000000000000000000000000000000000047";
    expect(
      displayV4BidLadderMarketCapEvidence({
        raw: {
          address: target,
          price: { price: "1" },
          circulating_supply: "2",
        },
        observation: {
          tokenAddress: "0x0000000000000000000000000000000000000001",
        },
        targetAddress: target,
      }),
    ).toBeUndefined();
  });
  it("preserves boundary ticks and separately sourced pool liquidity while zero-liquidity inventory is unavailable", () => {
    const repo = fixture();
    try {
      const value = preview(),
        state = pool();
      createV4BidLadderDryRun(repo, value);
      const parent = repo.loadBidLadder(value.plan.ladderId)!,
        legs = repo.listBidLadderLegs(value.plan.ladderId);
      for (const tick of [-887272, 887272]) {
        const text = formatPersistedV4BidLadder({
          parent,
          legs,
          funding: value.funding,
          target: value.target,
          poolUsdMetricLine: "Pool liquidity: $30.4K",
          current: { ...state, tick, sqrtPriceX96: 4295128740n, liquidity: 0n },
        });
        expect(text).toContain(`Current tick: ${tick}`);
        expect(text).toContain("Liquidity status: NO ACTIVE LIQUIDITY");
        expect(text).toContain("Pool liquidity: $30.4K");
        expect(text).not.toContain("Active liquidity:");
        expect(text).toContain("Current inventory: Unavailable");
        expect(text.match(/Inventory unavailable/g)).toHaveLength(5);
        expect(text).not.toMatch(/BELOW_RANGE|IN_RANGE|ABOVE_RANGE/);
      }
    } finally {
      repo.close();
    }
  });
  it("round-trips the 500 USDG virtual inventory at reference without disappearance", () => {
    const repo = fixture();
    try {
      const key = {
          currency0: c0,
          currency1: c1,
          fee: 3000,
          tickSpacing: 10,
          hooks: hook,
        } as const,
        state: V4PoolState = {
          id: poolId(key),
          key,
          sqrtPriceX96: sqrtPriceAtTick(0),
          tick: 0,
          liquidity: 1_000_000_000_000n,
          initialized: true,
          blockNumber: 100n,
        },
        value = previewV4BidLadder({
          pool: state,
          funding: { address: c0, symbol: "USDG", decimals: 6 },
          target: { address: c1, symbol: "ASSET", decimals: 18 },
          totalFundingAmount: 500_000_000n,
          owner,
          deadline: 999999n,
          nowMs: 1000,
        });
      createV4BidLadderDryRun(repo, value);
      const parent = repo.loadBidLadder(value.plan.ladderId)!,
        legs = repo.listBidLadderLegs(value.plan.ladderId),
        persisted = evaluatePersistedV4BidLadder({
          parent,
          legs,
          current: state,
        }),
        memory = evaluateV4BidLadderV1(value.plan, state);
      expect(persisted.legs.map((leg) => leg.state)).toEqual([
        "BELOW_RANGE",
        "BELOW_RANGE",
        "BELOW_RANGE",
        "BELOW_RANGE",
        "BELOW_RANGE",
      ]);
      expect(persisted.plannedFunding).toBe(500_000_000n);
      expect(persisted.totalTarget).toBe(0n);
      expect(persisted.totalFunding).toBe(memory.aggregateFundingTokenAmount);
      expect(persisted.deployedFundingAtReference).toBe(persisted.totalFunding);
      expect(persisted.unallocatedFundingDust).toBe(5n);
      expect(persisted.totalFunding + persisted.unallocatedFundingDust).toBe(
        500_000_000n,
      );
      const rendered = formatPersistedV4BidLadder({
        parent,
        legs,
        funding: value.funding,
        target: value.target,
        current: state,
      });
      expect(rendered).toContain("39.999999 USDG · 0 ASSET");
      expect(rendered).toContain("Planned funding: 500 USDG");
      expect(rendered).toContain("Fees: not modeled in Phase 1");
      const ticks = [
        0,
        Number(legs[0]!.tick_lower),
        Number(legs[2]!.tick_lower),
        Number(legs[4]!.tick_lower),
        Number(legs[4]!.tick_upper) + 1,
      ];
      for (const tick of ticks) {
        const moved = evaluatePersistedV4BidLadder({
          parent,
          legs,
          current: { tick, sqrtPriceX96: sqrtPriceAtTick(tick) },
        });
        expect(moved.totalFunding + moved.totalTarget).toBeGreaterThan(0n);
      }
      expect(
        evaluatePersistedV4BidLadder({
          parent,
          legs,
          current: {
            tick: ticks[4]!,
            sqrtPriceX96: sqrtPriceAtTick(ticks[4]!),
          },
        }).totalTarget,
      ).toBeGreaterThan(0n);
    } finally {
      repo.close();
    }
  });
  it("routes normal amount entry directly to LIVE preview while retaining explicit dry-run tooling", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      direct = source.slice(
        source.indexOf("async function bidLadderDirectLiveOnce"),
        source.indexOf("async function bidLadderDirectLive(ctx"),
      );
    for (const command of [
      "bid_ladder_preview",
      "bid_ladder_create",
      "bid_ladder_view",
      "bid_ladder_list",
    ])
      expect(source).toContain(`bot.command("${command}"`);
    expect(direct).toContain("createV4BidLadderLive(");
    expect(direct).toContain("v4BidLadderNativeUsd({ repo: db, rpc })");
    expect(direct).toContain(
      "return bidLadderLivePreview(ctx, preview.plan.ladderId,{messageId:",
    );
    expect(direct).not.toContain("bid-ladder-create:");
    expect(source).toContain("Confirm Live Open");
    expect(source).toContain("Close Ladder");
    expect(source).toContain("Confirm Manual Close");
    expect(source).not.toMatch(/CLOSE_AND_SWAP|BURN_POSITION/);
  });
  it("offers eligible manual reposition through preview, cancel/back, and one explicit confirmation identity", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      reset = readFileSync("apps/cli/src/v4-bid-ladder-usdg-reset.ts", "utf8"),
      preview = source.slice(
        source.indexOf("async function bidLadderRepositionPreview"),
        source.indexOf("async function bidLadderRepositionPrepareAllowance"),
      ),
      confirm = source.slice(
        source.indexOf("async function bidLadderRepositionConfirm"),
        source.indexOf("async function selectV4Range"),
      );
    expect(source).toContain("♻️ Reposition");
    expect(preview).toContain("previewV4BidLadderUsdReset");
    expect(preview).toContain("Confirm Reposition");
    expect(preview).toContain("Back");
    expect(preview).toContain("Cancel");
    expect(preview).not.toMatch(
      /executeV4BidLadderManualClose|guardedWalletClient\(\)/,
    );
    expect(confirm).toContain("manualAuthorizationIdentity: manualIdentity");
    expect(confirm).toContain("processV4BidLadderUsdReset");
    for (const text of [
      "Slices: 8% / 12% / 18% / 25% / 37%",
      "Only receipt-reconciled returned USDG PRINCIPAL funds the child.",
      "fees remain wallet profit and are not compounded.",
      "NO SWAP",
      "NO BURN",
      "does not close, sign, broadcast, or create a child",
    ])
      expect(reset).toContain(text);
    expect(source).toContain(
      "Reposition cancelled before CLOSE. No Reposition transaction was signed or broadcast; no replacement child can open.",
    );
  });
  it("derives Reposition from canonical OPEN/WATCHING ownership, independent of snapshot valuation, and blocks active lifecycle phases", () => {
    const repo = fixture();
    try {
      const value = preview(),
        id = value.plan.ladderId;
      createV4BidLadderLive(repo, value, 10);
      repo.db
        .prepare("UPDATE v4_bid_ladders SET status='OPEN' WHERE ladder_id=?")
        .run(id);
      for (const leg of repo.listBidLadderLegs(id)) {
        const tokenId = String(100 + Number(leg.leg_index)),
          positionId = `v4:${tokenId}`;
        repo.db
          .prepare(
            "UPDATE v4_bid_ladder_legs SET status='OPEN',token_id=? WHERE ladder_id=? AND leg_index=?",
          )
          .run(tokenId, id, leg.leg_index);
        repo.ensurePosition(positionId, tokenId, String(pool().id));
        repo.upsertV4Position({
          tokenId: BigInt(tokenId),
          owner,
          poolId: pool().id,
          poolKey: pool().key,
          currency0: c0,
          currency1: c1,
          fee: 3000,
          tickSpacing: 10,
          hooks: hook,
          tickLower: Number(leg.tick_lower),
          tickUpper: Number(leg.tick_upper),
          liquidity: 1n,
          initialAmount0: 0n,
          initialAmount1: 1n,
          mintHash: "0xmint",
          targetToken: c0,
          fundingToken: c1,
          targetSymbol: "WETH",
          fundingSymbol: "USDG",
          targetDecimals: 18,
          fundingDecimals: 6,
          targetIndex: 0,
          fundingIndex: 1,
          openIntentId: id,
        });
        repo.db
          .prepare(
            "INSERT INTO active_position_reconciliations(position_id,protocol_version,token_id,manager_address,owner_result,owner_status,liquidity_raw,confirmed_active,contributes_equity,checked_at_ms,fresh_until_ms,retry_count,details_json) VALUES(?,'v4',?,'manager',?,'VERIFIED_OWNED','1',1,1,1,9999999999999,0,'{}')",
          )
          .run(positionId, tokenId, owner);
      }
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "OPEN_PENDING",
        to: "WATCHING",
      });
      repo.db
        .prepare(
          "INSERT INTO portfolio_persisted_snapshot(snapshot_key,payload_json,content_hash,refreshed_at_ms) VALUES('current','{\"positions\":[]}','stale',1)",
        )
        .run();
      expect(bidLadderRepositionActionState(repo, id)).toEqual({
        executable: true,
        reason: null,
      });
      repo.transitionBidLadderUsdReset({
        ladderId: id,
        from: "WATCHING",
        to: "CLOSE_PREPARED",
        closeWorkflowIdentity:
          "manual-reposition:7:00000000-0000-4000-8000-000000000007",
      });
      expect(bidLadderRepositionActionState(repo, id)).toMatchObject({
        executable: false,
      });
      repo.db
        .prepare(
          "UPDATE v4_bid_ladder_usdg_reset_v1 SET phase='REOPEN_PLANNED' WHERE ladder_id=?",
        )
        .run(id);
      expect(bidLadderRepositionActionState(repo, id)).toMatchObject({
        executable: false,
        reason: "REPOSITION_REOPEN_PLANNED",
      });
      repo.db
        .prepare("UPDATE v4_bid_ladders SET status='CLOSED' WHERE ladder_id=?")
        .run(id);
      expect(bidLadderRepositionActionState(repo, id)).toMatchObject({
        executable: false,
        reason: "LADDER_NOT_OPEN",
      });
    } finally {
      repo.close();
    }
  });
  it("binds each Claim Fees preview to a durable operator authorization and compact callback", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      preview = source.slice(
        source.indexOf("async function bidLadderCollectPreview"),
        source.indexOf("async function bidLadderCollectConfirm"),
      ),
      confirm = source.slice(
        source.indexOf("async function bidLadderCollectConfirm"),
        source.indexOf("async function bidLadderRepositionPreview"),
      );
    expect(preview).toContain("authorizeChainCallback");
    expect(preview).toContain("feeEvidenceRevision");
    expect(preview).toContain(
      'bidLadderCallback("collectConfirm", ladderId, authorizationId)',
    );
    expect(confirm).toContain("authorization.user_id");
    expect(confirm).toContain("authorization.chat_id");
    expect(confirm).toContain("expectedTokenIds");
    expect(confirm).toContain("collectAuthorizationId: authorizationId");
    expect(source).toContain("/^bl:fc:([0-9a-f]{18}):(v4bid_[0-9a-f]{32})$/");
  });
  it("serializes eligible BigInt principal in cycle telemetry without changing economic state", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      logger = source.slice(
        source.indexOf("const log ="),
        source.indexOf("let v4PreviewStaticPrewarmInitiated"),
      );
    expect(logger).toContain('typeof value === "bigint"');
    expect(logger).toContain("? value.toString()");
  });
  it("keeps duplicate direct creation and restart at preview, never an automatic open", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      view = source.slice(
        source.indexOf("async function bidLadderView"),
        source.indexOf("function bidLadderList"),
      );
    expect(source).toContain("bidLadderDirectLiveInFlight");
    expect(view).toContain("Preview Live Open");
    expect(view).toContain("leg.open_batch_id");
    expect(view).toContain('bidLadderCallback("livePreview", ladderId)');
  });
  it("uses only the V4 native USD reference in BID Ladder live context", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      context = source.slice(
        source.indexOf("async function ladderLiveContext"),
        source.indexOf("async function bidLadderLivePreview"),
      ),
      live = readFileSync("apps/cli/src/v4-bid-ladder-live.ts", "utf8"),
      native = live.slice(
        live.indexOf("export async function v4BidLadderNativeUsd"),
        live.indexOf("async function openState"),
      );
    expect(context).toContain("v4BidLadderNativeUsd({ repo: db, rpc })");
    expect(context).not.toMatch(
      /operationalNativeUsd|operationalFundingUsd|trustedWethUsdReference|cachedV3DeploymentAudit|auditRobinhoodV3Deployments|v3_deployment_audit/,
    );
    expect(native).toContain("trustedV4WethUsdReference");
    expect(native).not.toContain("trustedWethUsdReference");
    expect(native).not.toMatch(
      /cachedV3DeploymentAudit|auditRobinhoodV3Deployments|v3_deployment_audit/,
    );
  });
});
