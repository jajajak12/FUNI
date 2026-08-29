import { describe, expect, it } from "vitest";
import { parseHumanAmount } from "../apps/telegram-lp-bot/src/amount-ux.js";
import {
  canResolveV4BidLadderPool,
  enterV4BidLadderAmount,
  returnToV4SelectedPool,
  selectV4BidLadderDepth,
  selectV4Strategy,
} from "../apps/telegram-lp-bot/src/bid-ladder-flow.js";
import { readFileSync } from "node:fs";

const selected = {
  kind: "v4_strategy",
  v4SelectionId: "asset-usdg",
  poolKey: { currency0: "0x1", currency1: "0x2" },
  funding: { symbol: "USDG", address: "0x2", decimals: 6 },
  target: { symbol: "ASSET", address: "0x1", decimals: 18 },
  fundingIndex: 1,
  targetIndex: 0,
};
describe("V4 BID ladder selected-pool flow", () => {
  it("requires strategy and depth selection before the funding amount", () => {
    expect(canResolveV4BidLadderPool(selected)).toBe(true);
    const depth = selectV4Strategy(selected, "BID_LADDER");
    expect(depth).toMatchObject({
      ...selected,
      strategy: "BID_LADDER",
      kind: "v4_bid_ladder_depth",
    });
    expect(enterV4BidLadderAmount(depth)).toMatchObject(depth);
    expect(selectV4BidLadderDepth(depth, 3000)).toMatchObject({
      ...selected,
      strategy: "BID_LADDER",
      kind: "v4_bid_ladder_amount",
      maxDownsideBps: 3000,
    });
    expect(() => selectV4Strategy(depth, "SPOT")).toThrow(
      "V4_STRATEGY_SELECTION_STALE",
    );
  });
  it("keeps ordinary text at depth, preserving Custom and amount routing", () => {
    const depth = selectV4Strategy(selected, "BID_LADDER"),
      source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      handler = source.slice(source.indexOf('bot.on("message:text"')),
      depthGuard = handler.indexOf(
        'active?.state.kind === "v4_bid_ladder_depth"',
      ),
      customDepth = handler.indexOf(
        'active?.state.kind === "v4_bid_ladder_custom_depth"',
      ),
      amount = handler.indexOf('active?.state.kind === "v4_bid_ladder_amount"');
    for (const text of ["60", "2000"]) {
      expect(text).toMatch(/^\d+$/);
      expect(depth).toMatchObject({
        kind: "v4_bid_ladder_depth",
        strategy: "BID_LADDER",
        v4SelectionId: selected.v4SelectionId,
        poolKey: selected.poolKey,
      });
      expect(depth).not.toHaveProperty("maxDownsideBps");
      expect(depth).not.toHaveProperty("amount");
    }
    expect(selectV4BidLadderDepth(depth, 3000)).toMatchObject({
      kind: "v4_bid_ladder_amount",
      maxDownsideBps: 3000,
    });
    expect(selectV4BidLadderDepth(depth, 6000)).toMatchObject({
      kind: "v4_bid_ladder_amount",
      maxDownsideBps: 6000,
    });
    expect(depthGuard).toBeGreaterThanOrEqual(0);
    expect(customDepth).toBeGreaterThan(depthGuard);
    expect(amount).toBeGreaterThan(customDepth);
    expect(handler.slice(depthGuard, customDepth)).toContain(
      "return preserveBidLadderDepthText(ctx, active);",
    );
    expect(handler).toContain("return bidLadderDirectLive(ctx, value);");
    expect(source).toContain(
      '"Choose one of the available max-downside buttons, or select Custom."',
    );
    expect(source).toContain('kind: "v4_bid_ladder_custom_depth"');
    expect(source).toContain("bidLadderDepthRows(active)");
    expect(source).toContain("flowControls(active)");
  });
  it("parses 500 as 500 funding-token units for ASSET/USDG-like orientation", () => {
    expect(parseHumanAmount("500", 6)).toBe(500_000_000n);
  });
  it("isolates Spot from Bid callbacks and returns Back to strategy selection", () => {
    const spot = selectV4Strategy(selected, "SPOT"),
      normal = { ...spot, kind: "v4_amount" };
    expect(canResolveV4BidLadderPool(normal)).toBe(true);
    expect(() => selectV4BidLadderDepth(spot, 3000)).toThrow(
      "V4_BID_LADDER_MAX_DOWNSIDE_INVALID",
    );
    expect(returnToV4SelectedPool(normal)).toMatchObject({
      ...selected,
      kind: "v4_strategy",
    });
    expect(returnToV4SelectedPool(normal)).not.toHaveProperty("strategy");
  });
  it("shows strategy before ranges and wires LIVE preview to explicit initial confirmation only", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      live = readFileSync("apps/cli/src/v4-bid-ladder-live.ts", "utf8"),
      poolRows = source.slice(
        source.indexOf("function v4SelectedPoolRows"),
        source.indexOf("function poolCooldownUntil"),
      );
    expect(poolRows).toContain("🪜 Bid Ladder");
    expect(poolRows).toContain("🎯 Spot");
    expect(poolRows).not.toContain("v4RangeButtons");
    expect(source).toContain("v4-strategy:");
    expect(source).toMatch(
      /active\?\.state\.kind\s*===\s*["']v4_bid_ladder_amount["']/,
    );
    expect(source).toContain("return bidLadderDirectLive(ctx, value);");
    expect(source).toContain("function bidLadderDepthRows");
    for (const value of [-10, -30, -50, -60])
      expect(source).toContain(String(value));
    expect(source).toContain("v4BidLadderGeometry({");
    expect(source).toContain("V4_BID_LADDER_DEPTH_NOT_REPRESENTABLE");
    expect(live).toContain("V4 BID Ladder V1 · LIVE PREVIEW");
    expect(live).toContain(
      "Manual reposition: USDG reset · explicit confirmation · same depth · no swap",
    );
    expect(source).toContain("Confirm Live Open");
    expect(source).not.toContain("CLOSE_AND_SWAP");
  });
  it("checks exact state and zero active liquidity before geometry and again before direct LIVE creation", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      depth = source.slice(
        source.indexOf("async function bidLadderSelectDepth"),
        source.indexOf("async function bidLadderDepth"),
      ),
      direct = source.slice(
        source.indexOf("async function bidLadderDirectLiveOnce"),
        source.indexOf("async function bidLadderDirectLive(ctx"),
      );
    expect(depth).toContain("exactV4PoolState");
    expect(depth).toContain("BID Ladder unavailable");
    expect(depth).toContain("Pool state: NO ACTIVE LIQUIDITY");
    expect(depth.indexOf("current.value.liquidity === 0n")).toBeLessThan(
      depth.indexOf("v4BidLadderGeometry({"),
    );
    expect(direct).toContain("The pool lost active liquidity before creation.");
    expect(direct.indexOf("current.value.liquidity === 0n")).toBeLessThan(
      direct.indexOf("previewV4BidLadder({"),
    );
  });
  it("uses exact-pair pool liquidity in selected-pool UI, rejects a pool that drains before click, and keeps raw StateView L out of Telegram text", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      selection = source.slice(
        source.indexOf("async function selectV4Pool"),
        source.indexOf("async function bidLadderDryRunPreview"),
      );
    expect(selection).toContain("if (current.value.liquidity <= 0n)");
    expect(selection).toContain(
      'return ctx.reply("POOL_ZERO_ACTIVE_LIQUIDITY")',
    );
    expect(selection).toContain(
      "await dexV4PoolLiquidityLine(String(selection.pool_id), key)",
    );
    expect(selection).toContain(
      'Liquidity status: ${activeLiquidity ? "Active" : "NO ACTIVE LIQUIDITY"}',
    );
    expect(selection).not.toContain("formatV4PoolUsdMetric");
    expect(selection).not.toContain("Active liquidity:");
  });
});
