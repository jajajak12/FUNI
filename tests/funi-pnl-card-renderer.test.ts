import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FUNI_APPROVED_TEMPLATE_REFERENCE,
  FUNI_APPROVED_TEMPLATE_SHA256,
  FUNI_RENDERED_LOGO_SIZE,
  FUNI_WORDMARK_ASSET,
  FUNI_WORDMARK_SHA256,
  closePnlCardModel,
  funiBadgePalette,
  lifecyclePnlPresentation,
  normalizePositionPrivacy,
  periodPnlPresentation,
  renderFuniPnlCard,
  wibPeriodWindow,
} from "../apps/telegram-lp-bot/src/pnl-card.js";

const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const semantic = (png: Buffer) => {
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset),
      type = png.subarray(offset + 4, offset + 8).toString("ascii"),
      body = png.subarray(offset + 8, offset + 8 + length);
    if (
      type === "tEXt" &&
      body.subarray(0, 10).toString("utf8") === "funi_card\0"
    )
      return body.subarray(10).toString("utf8");
    offset += 12 + length;
  }
  throw new Error("FUNI_CARD_SEMANTIC_MISSING");
};
const events = (status: "AVAILABLE" | "INCOMPLETE", pnl: string | null) => [
  { event_kind: "CLOSE", valuation_status: status, realized_pnl_usd: pnl },
  { event_kind: "CLAIM", valuation_status: "AVAILABLE", realized_pnl_usd: "5" },
];
const close = (pnl: number | null, privacy = {}) =>
  closePnlCardModel({
    pair: "FUNI / USDG",
    strategy: "V4",
    mode: "LIVE",
    pnl,
    pct: pnl === null ? null : pnl / 20,
    basis: 2_000,
    returnedValue: "2248.30",
    lpFees: 12.5,
    held: "18h",
    reason: "NORMAL_OPERATOR_CLOSE",
    closedAt: "28 Aug 2026, 11:30",
    transactionHash: "0x" + "a".repeat(64),
    privacy,
  });
function assertPng(png: Buffer, items: string[]) {
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.readUInt32BE(16)).toBe(1080);
  expect(png.readUInt32BE(20)).toBe(1080);
  for (const item of items) expect(semantic(png)).toContain(item);
  expect(semantic(png)).toContain("@jajajakbtc · t.me/Jajajakbothouse");
}

describe("FUNI approved public PnL cards", () => {
  it("preserves approved reference and logo provenance exactly", () => {
    expect(existsSync(FUNI_APPROVED_TEMPLATE_REFERENCE)).toBe(true);
    expect(hash(FUNI_APPROVED_TEMPLATE_REFERENCE)).toBe(
      FUNI_APPROVED_TEMPLATE_SHA256,
    );
    expect(existsSync(FUNI_WORDMARK_ASSET)).toBe(true);
    expect(hash(FUNI_WORDMARK_ASSET)).toBe(FUNI_WORDMARK_SHA256);
    expect(FUNI_RENDERED_LOGO_SIZE).toBe(150);
    expect(FUNI_RENDERED_LOGO_SIZE / 170).toBeCloseTo(0.8824, 4);
  });
  it("uses canonical WIB daily, Monday-weekly, and monthly windows", () => {
    const now = new Date("2026-08-28T12:00:00.000Z"),
      daily = wibPeriodWindow("DAILY_PNL", now),
      weekly = wibPeriodWindow("WEEKLY_PNL", now),
      monthly = wibPeriodWindow("MONTHLY_PNL", now);
    expect(daily.label).toBe("28 Aug 2026");
    expect(weekly.label).toBe("24–30 Aug 2026");
    expect(monthly.label).toBe("Aug 2026");
    expect(weekly.endMs - weekly.startMs).toBe(7 * 86_400_000);
  });
  it.each(["DAILY_PNL", "WEEKLY_PNL", "MONTHLY_PNL"] as const)(
    "renders privacy-safe %s FULL cards",
    (kind) => {
      const period = wibPeriodWindow(
          kind,
          new Date("2026-08-28T12:00:00.000Z"),
        ),
        card = periodPnlPresentation({
          period,
          coverageStartMs: period.startMs,
          events: events("AVAILABLE", "125"),
        }).card,
        png = renderFuniPnlCard({ model: card });
      assertPng(png, [
        card.title,
        "FULL",
        "REALIZED PNL",
        "+$130.00",
        "Closed PnL",
        "Claimed fees",
      ]);
      expect(semantic(png)).not.toMatch(/Capital basis|ROI|PnL %|%/);
    },
  );
  it.each([
    ["PARTIAL", 60_000, events("AVAILABLE", "5"), "Coverage partial"],
    ["INCOMPLETE", 0, events("INCOMPLETE", null), "Valuation incomplete"],
  ] as const)(
    "renders %s as KNOWN PNL without denominator leakage",
    (_name, offset, eventRows, notice) => {
      const period = wibPeriodWindow(
          "DAILY_PNL",
          new Date("2026-08-28T12:00:00.000Z"),
        ),
        card = periodPnlPresentation({
          period,
          coverageStartMs: period.startMs + offset,
          events: eventRows,
        }).card,
        png = renderFuniPnlCard({ model: card });
      assertPng(png, ["KNOWN PNL", notice, "Unpriced events"]);
      expect(semantic(png)).not.toMatch(/Capital basis|ROI|PnL %|%/);
    },
  );
  it("uses green, red, and neutral hero tones without sign inversion", () => {
    expect(close(248).tone).toBe("profit");
    expect(close(-91.4).tone).toBe("loss");
    expect(close(0).tone).toBe("flat");
    expect(close(null).tone).toBe("flat");
    assertPng(renderFuniPnlCard({ model: close(248) }), ["+$248.00", "PROFIT"]);
    assertPng(renderFuniPnlCard({ model: close(-91.4) }), ["-$91.40", "LOSS"]);
    assertPng(renderFuniPnlCard({ model: close(0) }), ["$0.00", "BREAKEVEN"]);
  });
  it("renders identifier-free, date-only metadata in Privacy, Amounts, and Full Detail", () => {
    const variants = [
      close(248.3),
      close(248.3, { showCapitalBasis: true, showReturnedValue: true }),
      close(248.3, {
        showCapitalBasis: true,
        showReturnedValue: true,
        showPnlPercent: true,
      }),
    ];
    for (const model of variants) {
      const text = semantic(renderFuniPnlCard({ model }));
      assertPng(renderFuniPnlCard({ model }), [
        "LP fees",
        "Close reason",
        "Held duration",
        "Closed at · 28 Aug 2026 WIB",
      ]);
      expect(text).not.toMatch(
        /CLOSE tx|0x[0-9a-f]+|event-private|ladder-private|tokenId|wallet|pool|block|nonce|11:30/i,
      );
      expect(model.metadata).toEqual([
        "Closed at · 28 Aug 2026 WIB",
        "@jajajakbtc · t.me/Jajajakbothouse",
      ]);
    }
    expect(variants[0]!.facts.map((x) => x.label)).toEqual([
      "LP fees",
      "Close reason",
      "Held duration",
    ]);
  });
  it("preserves Privacy, Amounts, and Full Detail financial visibility", () => {
    const privacy = semantic(renderFuniPnlCard({ model: close(248.3) })),
      amounts = semantic(
        renderFuniPnlCard({
          model: close(248.3, {
            showCapitalBasis: true,
            showReturnedValue: true,
          }),
        }),
      ),
      full = semantic(
        renderFuniPnlCard({
          model: close(248.3, {
            showCapitalBasis: true,
            showReturnedValue: true,
            showPnlPercent: true,
          }),
        }),
      );
    expect(privacy).not.toMatch(
      /Capital basis|Returned value|PnL %|2248\.30|12\.42%/,
    );
    expect(amounts).toContain(
      "Capital basis | $2000.00 | Returned value | $2,248.30",
    );
    expect(amounts).not.toContain("PnL %");
    expect(full).toContain("PnL % | +12.42%");
  });
  it("normalizes a leaking combination to privacy-safe output", () => {
    expect(
      normalizePositionPrivacy({
        showCapitalBasis: false,
        showReturnedValue: true,
        showPnlPercent: true,
      }),
    ).toEqual({
      showCapitalBasis: false,
      showReturnedValue: false,
      showPnlPercent: false,
    });
    const png = renderFuniPnlCard({
      model: close(248.3, { showReturnedValue: true }),
    });
    expect(semantic(png)).not.toContain("Returned value");
    expect(semantic(png)).not.toContain("2248.30");
  });
  it("is deterministic and fits long dynamic fields", () => {
    const model = closePnlCardModel({
        pair: "A_VERY_LONG_TOKEN_SYMBOL_THAT_MUST_FIT / USDG",
        pnl: 12_345_678.9,
        pct: null,
        basis: null,
        returnedValue: null,
        lpFees: null,
        held: "Unavailable",
        reason: "NORMAL_OPERATOR_CLOSE_WITH_A_LONG_INTERNAL_REASON",
        closedAt: "28 Aug 2026, 11:30",
        transactionHash: "0x" + "b".repeat(64),
      }),
      one = renderFuniPnlCard({ model }),
      two = renderFuniPnlCard({ model });
    expect(one.equals(two)).toBe(true);
    assertPng(one, ["+$12345678.90", "Operator close"]);
  });
  it("keeps FULL coverage chip semantics independent from profit and loss hero tones", () => {
    const period = wibPeriodWindow(
        "DAILY_PNL",
        new Date("2026-08-28T12:00:00.000Z"),
      ),
      profit = periodPnlPresentation({
        period,
        coverageStartMs: period.startMs,
        events: events("AVAILABLE", "125"),
      }).card,
      loss = periodPnlPresentation({
        period,
        coverageStartMs: period.startMs,
        events: events("AVAILABLE", "-125"),
      }).card;
    expect(profit).toMatchObject({
      badge: "FULL",
      badgeKind: "coverage",
      tone: "profit",
    });
    expect(loss).toMatchObject({
      badge: "FULL",
      badgeKind: "coverage",
      tone: "loss",
    });
    expect(
      funiBadgePalette(profit.badgeKind, profit.badge, profit.tone),
    ).toEqual(funiBadgePalette(loss.badgeKind, loss.badge, loss.tone));
    expect(profit.hero).toBe("+$130.00");
    expect(loss.hero).toBe("-$120.00");
    expect(funiBadgePalette("coverage", "PARTIAL", "profit").text).toBe(
      "0xE9C46A",
    );
    expect(funiBadgePalette("coverage", "INCOMPLETE", "loss").text).toBe(
      "0xF0A15A",
    );
  });
  it("keeps close outcome chips separate and visibly renders Full Detail's PnL percentage", () => {
    const profit = close(248.3),
      loss = close(-91.4),
      flat = close(0),
      amounts = close(248.3, {
        showCapitalBasis: true,
        showReturnedValue: true,
      }),
      full = close(248.3, {
        showCapitalBasis: true,
        showReturnedValue: true,
        showPnlPercent: true,
      });
    expect(profit).toMatchObject({ badge: "PROFIT", badgeKind: "outcome" });
    expect(loss).toMatchObject({ badge: "LOSS", badgeKind: "outcome" });
    expect(flat).toMatchObject({ badge: "BREAKEVEN", badgeKind: "outcome" });
    expect(full.facts.map((fact) => fact.label)).toContain("PnL %");
    const amountsPng = renderFuniPnlCard({ model: amounts }),
      fullPng = renderFuniPnlCard({ model: full });
    expect(amountsPng.equals(fullPng)).toBe(false);
    expect(semantic(fullPng)).toContain("PnL % | +12.42%");
    expect(semantic(amountsPng)).not.toContain("PnL %");
  });
  it("does not use supplied transaction identity in public PNG metadata", () => {
    const model = closePnlCardModel({
        pnl: 1,
        pct: null,
        basis: null,
        returnedValue: null,
        closedAt: "29 Aug 2026, 03:37",
        transactionHash: "0x1234567890abcdef1234567890abcdef",
      }),
      text = semantic(renderFuniPnlCard({ model }));
    expect(text).toContain("Closed at · 29 Aug 2026 WIB");
    expect(text).not.toMatch(/CLOSE tx|0x123456|03:37/);
  });
  it("consumes synthetic total lifecycle fee output without renderer summation", () => {
    const build = (
      pair: string,
      claims: string[],
      closeValue: string,
      closeFee: string,
    ) => {
      const closeEvent = {
          event_id: pair + ":close",
          event_kind: "CLOSE",
          valuation_status: "AVAILABLE",
          realized_pnl_usd: closeValue,
          newly_realized_fees_usd: closeFee,
          capital_basis_usd: "1000",
        },
        events = [
          ...claims.map((value, index) => ({
            event_id: pair + ":claim:" + index,
            event_kind: "CLAIM",
            valuation_status: "AVAILABLE",
            realized_pnl_usd: value,
            newly_realized_fees_usd: value,
          })),
          closeEvent,
        ],
        lifecycle = lifecyclePnlPresentation({ closeEvent, events });
      return closePnlCardModel({
        pair,
        pnl: lifecycle.pnl,
        pct: lifecycle.pct,
        basis: lifecycle.basis,
        returnedValue: null,
        lpFees: lifecycle.lpFees,
        coverage: lifecycle.coverage,
        closedAt: "now",
        transactionHash: "0x" + "c".repeat(64),
      });
    };
    const assetA = build("ASSET_A/USDG", ["10"], "5", "2"),
      assetB = build("ASSET_B/USDG", ["3", "4"], "-2", "1");
    expect(assetA).toMatchObject({ hero: "+$15.00" });
    expect(assetA.facts).toContainEqual({ label: "LP fees", value: "+$12.00" });
    expect(assetB).toMatchObject({ hero: "+$5.00" });
    expect(assetB.facts).toContainEqual({
      label: "LP fees",
      value: "+$8.00",
    });
    const renderer = readFileSync(
      "apps/telegram-lp-bot/src/pnl-card.ts",
      "utf8",
    ).slice(
      readFileSync("apps/telegram-lp-bot/src/pnl-card.ts", "utf8").indexOf(
        "export function renderFuniPnlCard",
      ),
    );
    expect(renderer).not.toContain("lifecyclePnlPresentation(");
  });
});
