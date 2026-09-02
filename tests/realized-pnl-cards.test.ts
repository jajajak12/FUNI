import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateSqlite, SqliteLedgerRepository } from "@funi/ledger";
import {
  closePnlCardModel,
  dailyPnlPresentation,
  lifecyclePnlPresentation,
  periodPnlPresentation,
  renderFuniPnlCard,
  wibDayWindow,
  wibPeriodWindow,
} from "../apps/telegram-lp-bot/src/pnl-card.js";
import {
  consumeGenericV4Basis,
  rawUsdMicros,
  valueGenericV4Returns,
  valueV4ReturnsFromSqrtPriceX96 as checkedV4Returns,
} from "../apps/cli/src/v4-realized-accounting.js";
import { robinhoodMainnet } from "@funi/core";
import { poolId, sqrtPriceAtTick, V4_MAX_TICK, V4_MIN_TICK } from "@funi/v4";
import { v4BidLadderClosePairLabel } from "../apps/cli/src/v4-bid-ladder-live.js";
import {
  aggregateFuniOpenLifecyclePnl,
  type PersistedPositionDisplayItem,
} from "../apps/telegram-lp-bot/src/persisted-portfolio.js";

function tickAtSqrt(sqrtPriceX96:bigint){let low=V4_MIN_TICK,high=V4_MAX_TICK;while(low<high){const mid=Math.ceil((low+high)/2);if(sqrtPriceAtTick(mid)<=sqrtPriceX96)low=mid;else high=mid-1;}return low;}
function valueV4ReturnsFromSqrtPriceX96(input:{token0:string;token1:string;decimals0:number;decimals1:number;amount0:bigint;amount1:bigint;sqrtPriceX96:bigint}){const ordered=[input.token0,input.token1].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())),key={currency0:ordered[0]!,currency1:ordered[1]!,fee:3000,tickSpacing:10,hooks:"0x0000000000000000000000000000000000000000"},tick=tickAtSqrt(input.sqrtPriceX96);return checkedV4Returns({...input,source:{poolId:poolId(key as any),poolKey:key as any,sqrtPriceX96:input.sqrtPriceX96,tick,activeLiquidity:1_000_000n,initialized:true,blockNumber:1n,token0Decimals:input.decimals0,token1Decimals:input.decimals1}});}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "funi-realized-pnl-")),
    path = join(dir, "ledger.sqlite");
  migrateSqlite(path, "infra/migrations");
  return { dir, repo: new SqliteLedgerRepository(path) };
}
const event = (
  id: string,
  kind: "CLAIM" | "CLOSE",
  hash: string,
  at = 1_725_000_000_000,
) => ({
  eventId: id,
  eventKind: kind,
  protocol: "v4",
  strategyType: "V4_BID_LADDER",
  ladderIdentity: "ladder",
  workflowIdentity: "ladder",
  journalStage: kind === "CLAIM" ? "COLLECT_BATCH:a" : "CLOSE_BATCH",
  transactionHash: hash,
  blockNumber: 1n,
  blockHash: "0x" + "1".repeat(64),
  economicFinalAtMs: at,
  capitalBasisUsd: kind === "CLOSE" ? "100" : undefined,
  newlyRealizedFeesUsd: kind === "CLAIM" ? "5" : "0",
  realizedPnlUsd: kind === "CLAIM" ? "5" : "-10",
  token0Raw: 5n,
  token1Raw: 0n,
  token0Decimals: 6,
  token1Decimals: 18,
  valuationStatus: "AVAILABLE" as const,
  valuationEvidence: { source: "fixture" },
});
describe("realized PnL V1 durable truth", () => {
  it("migrates idempotently and appends a claim once by economic identity", () => {
    const f = fixture();
    try {
      expect(
        f.repo.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='realized_pnl_events'",
          )
          .get(),
      ).toBeTruthy();
      f.repo.appendRealizedPnlEvent(
        event("claim", "CLAIM", "0x" + "a".repeat(64)),
      );
      expect(() =>
        f.repo.appendRealizedPnlEvent(
          event("other", "CLAIM", "0x" + "a".repeat(64)),
        ),
      ).toThrow("REALIZED_PNL_EVENT_IDENTITY_CONFLICT");
      expect(
        f.repo.realizedPnlEventsBetween(0, 2_000_000_000_000),
      ).toHaveLength(1);
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("keeps recurring claims separate and daily close plus claims sums each fee once", () => {
    const f = fixture();
    try {
      const base = 1_725_000_000_000;
      f.repo.appendRealizedPnlEvent(
        event("c1", "CLAIM", "0x" + "1".repeat(64), base),
      );
      f.repo.appendRealizedPnlEvent({
        ...event("c2", "CLAIM", "0x" + "2".repeat(64), base + 1),
        journalStage: "COLLECT_BATCH:b",
      });
      f.repo.appendRealizedPnlEvent({
        ...event("close", "CLOSE", "0x" + "3".repeat(64), base + 2),
      });
      const rows = f.repo.realizedPnlEventsBetween(base, base + 10),
        total = rows.reduce(
          (sum, row) => sum + Number(row.realized_pnl_usd),
          0,
        );
      expect(total).toBe(0);
      expect(rows.filter((row) => row.event_kind === "CLAIM")).toHaveLength(2);
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("repairs one incomplete CLAIM once without duplicating its economic identity", () => {
    const f = fixture();
    try {
      const base = event("claim", "CLAIM", "0x" + "d".repeat(64));
      f.repo.appendRealizedPnlEvent({
        ...base,
        newlyRealizedFeesUsd: undefined,
        realizedPnlUsd: undefined,
        valuationStatus: "INCOMPLETE",
        valuationEvidence: { reason: "PRICE_UNAVAILABLE" },
      });
      const repaired = {
        ...base,
        newlyRealizedFeesUsd: "8.25",
        realizedPnlUsd: "8.25",
        valuationEvidence: { source: "CLAIM_BLOCK_STATEVIEW" },
      };
      f.repo.appendRealizedPnlEvent(repaired);
      f.repo.appendRealizedPnlEvent(repaired);
      expect(
        f.repo.realizedPnlEventsBetween(0, 2_000_000_000_000),
      ).toMatchObject([
        {
          event_id: "claim",
          valuation_status: "AVAILABLE",
          newly_realized_fees_usd: "8.25",
          realized_pnl_usd: "8.25",
        },
      ]);
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("repairs one CLOSE fee decomposition once without mutating event-local PnL", () => {
    const f = fixture();
    try {
      const close = {
        ...event("close", "CLOSE", "0x" + "e".repeat(64)),
        newlyRealizedFeesUsd: undefined,
        realizedPnlUsd: "30",
      };
      f.repo.appendRealizedPnlEvent(close);
      const before = f.repo.realizedPnlEventsBetween(0, 2_000_000_000_000)[0]!,
        one = f.repo.repairCloseRealizedFeeAttribution({
          eventId: "close",
          newlyRealizedFeesUsd: "9.5",
          valuationEvidence: { source: "EXACT_CLOSE_SPLIT" },
        }),
        two = f.repo.repairCloseRealizedFeeAttribution({
          eventId: "close",
          newlyRealizedFeesUsd: "9.5",
          valuationEvidence: { source: "EXACT_CLOSE_SPLIT" },
        }),
        after = f.repo.realizedPnlEventsBetween(0, 2_000_000_000_000)[0]!;
      expect(one.changed).toBe(1);
      expect(two.changed).toBe(0);
      expect(after).toMatchObject({
        newly_realized_fees_usd: "9.5",
        realized_pnl_usd: "30",
        capital_basis_usd: before.capital_basis_usd,
        token0_raw: before.token0_raw,
        token1_raw: before.token1_raw,
      });
      expect(() =>
        f.repo.repairCloseRealizedFeeAttribution({
          eventId: "close",
          newlyRealizedFeesUsd: "10",
          valuationEvidence: {},
        }),
      ).toThrow("REALIZED_PNL_CLOSE_FEE_REPAIR_CONFLICT");
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("aggregates no CLAIM, one CLAIM, or multiple CLAIMs plus CLOSE fees exactly once", () => {
    const close = (fee: string) => ({
        event_id: "close",
        event_kind: "CLOSE",
        valuation_status: "AVAILABLE",
        realized_pnl_usd: "30",
        newly_realized_fees_usd: fee,
        capital_basis_usd: "100",
      }),
      claim = (id: string, fee: string) => ({
        event_id: id,
        event_kind: "CLAIM",
        valuation_status: "AVAILABLE",
        realized_pnl_usd: fee,
        newly_realized_fees_usd: fee,
      });
    expect(
      lifecyclePnlPresentation({
        closeEvent: close("3"),
        events: [close("3")],
      }),
    ).toMatchObject({ pnl: 30, lpFees: 3 });
    expect(
      lifecyclePnlPresentation({
        closeEvent: close("3"),
        events: [claim("c1", "5"), close("3")],
      }),
    ).toMatchObject({ pnl: 35, lpFees: 8 });
    expect(
      lifecyclePnlPresentation({
        closeEvent: close("3"),
        events: [claim("c1", "5"), claim("c2", "7"), close("3")],
      }),
    ).toMatchObject({ pnl: 42, lpFees: 15 });
    expect(
      lifecyclePnlPresentation({
        closeEvent: close("0"),
        events: [claim("c1", "5"), claim("c2", "7"), close("0")],
      }),
    ).toMatchObject({ pnl: 42, lpFees: 12 });
  });
  it("marks LP fees unavailable when a required CLAIM or CLOSE decomposition is incomplete", () => {
    const close = {
        event_id: "close",
        event_kind: "CLOSE",
        valuation_status: "AVAILABLE",
        realized_pnl_usd: "30",
        newly_realized_fees_usd: "0",
        capital_basis_usd: "100",
      },
      result = lifecyclePnlPresentation({
        closeEvent: close,
        events: [
          close,
          {
            event_id: "claim",
            event_kind: "CLAIM",
            valuation_status: "INCOMPLETE",
            realized_pnl_usd: null,
            newly_realized_fees_usd: null,
          },
        ],
      });
    expect(result).toMatchObject({
      coverage: "PARTIAL",
      pnl: null,
      knownPnl: 30,
      lpFees: null,
      incompleteEventIds: ["claim"],
      incompleteFeeEventIds: ["claim"],
    });
    expect(
      closePnlCardModel({
        pnl: result.pnl,
        pct: result.pct,
        basis: result.basis,
        returnedValue: null,
        lpFees: result.lpFees,
        coverage: result.coverage,
        closedAt: "now",
        transactionHash: "0x1",
      }),
    ).toMatchObject({
      badge: "PARTIAL",
      hero: "Unavailable",
      facts: expect.arrayContaining([
        { label: "LP fees", value: "Unavailable" },
      ]),
    });
    const missingClose = { ...close, newly_realized_fees_usd: null },
      availableClaim = {
        event_id: "claim",
        event_kind: "CLAIM",
        valuation_status: "AVAILABLE",
        realized_pnl_usd: "5",
        newly_realized_fees_usd: "5",
      };
    expect(
      lifecyclePnlPresentation({
        closeEvent: missingClose,
        events: [availableClaim, missingClose],
      }),
    ).toMatchObject({
      pnl: 35,
      lpFees: null,
      incompleteFeeEventIds: ["close"],
    });
  });
  it("records delivery intent separately and produces deterministic profit/loss/flat PNGs", () => {
    const f = fixture();
    try {
      const d = f.repo.ensurePnlCardDelivery({
        deliveryId: "d",
        cardKind: "DAILY",
        requestedDayWib: "2024-08-01",
        chatIdentity: "chat",
      });
      expect(f.repo.claimPnlCardDelivery(String(d.delivery_id))).toBeTruthy();
      f.repo.finalizePnlCardDelivery({
        deliveryId: "d",
        delivered: false,
        uncertain: true,
        renderStatus: "RENDERED",
      });
      expect(
        f.repo.db
          .prepare(
            "SELECT delivery_status FROM pnl_card_deliveries WHERE delivery_id='d'",
          )
          .get(),
      ).toEqual({ delivery_status: "DELIVERY_UNCERTAIN" });
      for (const pnl of [5, -5, 0]) {
        const model = closePnlCardModel({
            pair: "FUNI/USDG",
            pnl,
            pct: null,
            basis: null,
            returnedValue: null,
            held: "Unavailable",
            reason: "NORMAL_OPERATOR_CLOSE",
            closedAt: "28 Aug 2026, 11:30",
            transactionHash: "0x" + "a".repeat(64),
          }),
          png = renderFuniPnlCard({ model });
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(png.toString("latin1")).toContain("REALIZED PNL");
      }
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

const openPortfolioItem = (
  workflowId: string,
  inventoryPnlUsd: number,
  unclaimedFeesUsd: number,
  overrides: Record<string, unknown> = {},
): PersistedPositionDisplayItem => ({
  kind: "position",
  position: {
    positionId: `v4:${workflowId}`,
    protocol: "v4",
    tokenId: workflowId,
    pair: "TOKEN/USDG",
    feeTier: 3000,
    range: "0 ↔ 1",
    liquidity: "1",
    status: "open",
    source: "BOT_OPERATIONAL",
    openIntentId: workflowId,
    lifecycle: "CONFIRMED_ACTIVE_FRESH",
    accounting: {
      externalCapitalUsd: 100,
      activePrincipalUsd: 100 + inventoryPnlUsd,
      uncollectedFeesUsd: unclaimedFeesUsd,
      currentEquityUsd: 100 + inventoryPnlUsd + unclaimedFeesUsd,
    },
    ...overrides,
  } as any,
});
const appendPortfolioClaim = (
  repo: SqliteLedgerRepository,
  args: {
    id: string;
    workflowId: string;
    fees?: string;
    available?: boolean;
    hashDigit: string;
  },
) =>
  repo.appendRealizedPnlEvent({
    ...event(args.id, "CLAIM", `0x${args.hashDigit.repeat(64)}`),
    ladderIdentity: args.workflowId,
    workflowIdentity: args.workflowId,
    journalStage: `COLLECT_BATCH:${args.id}`,
    newlyRealizedFeesUsd:
      args.available === false ? undefined : (args.fees ?? "5"),
    realizedPnlUsd: args.available === false ? undefined : (args.fees ?? "5"),
    valuationStatus: args.available === false ? "INCOMPLETE" : "AVAILABLE",
    valuationEvidence:
      args.available === false
        ? { reason: "PRICE_UNAVAILABLE" }
        : { source: "fixture" },
  });

describe("OPEN lifecycle portfolio summary", () => {
  it("uses zero claimed fees when an OPEN workflow has no CLAIM", () => {
    const f = fixture();
    try {
      expect(
        aggregateFuniOpenLifecyclePnl(f.repo, [
          openPortfolioItem("current", -10, 4),
        ]),
      ).toMatchObject({
        inventoryPnlUsd: -10,
        unclaimedFeesUsd: 4,
        claimedFeesUsd: 0,
        openLifecyclePnlUsd: -6,
      });
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("sums one or multiple AVAILABLE event-local CLAIMs exactly once on replay", () => {
    const f = fixture();
    try {
      const one = {
          id: "claim-1",
          workflowId: "current",
          fees: "6.25",
          hashDigit: "4",
        },
        two = {
          id: "claim-2",
          workflowId: "current",
          fees: "7.75",
          hashDigit: "5",
        };
      appendPortfolioClaim(f.repo, one);
      appendPortfolioClaim(f.repo, two);
      appendPortfolioClaim(f.repo, two);
      f.repo.appendRealizedPnlEvent({
        ...event("close", "CLOSE", "0x" + "6".repeat(64)),
        ladderIdentity: "current",
        workflowIdentity: "current",
        realizedPnlUsd: "999",
      });
      expect(
        aggregateFuniOpenLifecyclePnl(f.repo, [
          openPortfolioItem("current", 2, 3),
        ]),
      ).toMatchObject({ claimedFeesUsd: 14, openLifecyclePnlUsd: 19 });
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("fails claimed fees and lifecycle closed when an attributable CLAIM is INCOMPLETE", () => {
    const f = fixture();
    try {
      appendPortfolioClaim(f.repo, {
        id: "incomplete",
        workflowId: "current",
        available: false,
        hashDigit: "7",
      });
      expect(
        aggregateFuniOpenLifecyclePnl(f.repo, [
          openPortfolioItem("current", 2, 3),
        ]),
      ).toMatchObject({
        inventoryPnlUsd: 2,
        unclaimedFeesUsd: 3,
        claimedFeesUsd: null,
        openLifecyclePnlUsd: null,
      });
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("binds CLAIMs to the exact current generation and excludes external and CLOSED workflows", () => {
    const f = fixture();
    try {
      for (const [id, workflowId, fees, hashDigit] of [
        ["old", "generation-0", "100", "8"],
        ["current", "generation-1", "7", "9"],
        ["external", "external", "200", "a"],
        ["closed", "closed", "300", "b"],
      ] as const)
        appendPortfolioClaim(f.repo, { id, workflowId, fees, hashDigit });
      const items = [
        openPortfolioItem("generation-1", 1, 2),
        openPortfolioItem("external", 999, 999, { source: "MANUAL_EXTERNAL" }),
        openPortfolioItem("closed", 999, 999, {
          status: "closed",
          lifecycle: "TERMINAL",
        }),
      ];
      expect(aggregateFuniOpenLifecyclePnl(f.repo, items)).toMatchObject({
        inventoryPnlUsd: 1,
        unclaimedFeesUsd: 2,
        claimedFeesUsd: 7,
        openLifecyclePnlUsd: 10,
        workflowIds: ["generation-1"],
      });
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("aggregates multiple current OPEN workflows and satisfies the equity-minus-basis identity", () => {
    const f = fixture();
    try {
      appendPortfolioClaim(f.repo, {
        id: "a",
        workflowId: "a",
        fees: "116.94",
        hashDigit: "c",
      });
      appendPortfolioClaim(f.repo, {
        id: "b",
        workflowId: "b",
        fees: "200",
        hashDigit: "d",
      });
      const items = [
          openPortfolioItem("a", -60, 60),
          openPortfolioItem("b", -39.72, 58.61),
        ],
        summary = aggregateFuniOpenLifecyclePnl(f.repo, items),
        equity = items.reduce(
          (sum, item) =>
            sum +
            (item.kind === "position"
              ? item.position.accounting.currentEquityUsd!
              : 0),
          0,
        ),
        basis = 200;
      expect(summary).toMatchObject({
        inventoryPnlUsd: -99.72,
        unclaimedFeesUsd: 118.61,
        claimedFeesUsd: 316.94,
        openLifecyclePnlUsd: 335.83,
      });
      expect(summary.openLifecyclePnlUsd).toBeCloseTo(
        equity - basis + summary.claimedFeesUsd!,
        8,
      );
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("makes inventory and lifecycle unavailable when one managed OPEN basis is unavailable", () => {
    const f = fixture();
    try {
      const item = openPortfolioItem("current", 1, 2);
      (item as any).position.accounting.externalCapitalUsd = null;
      expect(aggregateFuniOpenLifecyclePnl(f.repo, [item])).toMatchObject({
        inventoryPnlUsd: null,
        claimedFeesUsd: 0,
        openLifecyclePnlUsd: null,
      });
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

const token = (n: string) => `0x${n.repeat(40)}`;
function generic(
  repo: SqliteLedgerRepository,
  basisRaw = 100_000_000n,
  liquidity = 1_000n,
) {
  const usdg = robinhoodMainnet.assets.USDG,
    target = token("2"),
    positionId = "v4:7";
  repo.ensurePosition(positionId, "7", "pool");
  repo.upsertV4Position({
    tokenId: 7n,
    owner: token("3"),
    poolId: "pool",
    poolKey: {
      currency0: target,
      currency1: usdg,
      fee: 3000,
      tickSpacing: 10,
      hooks: token("0"),
    },
    currency0: target,
    currency1: usdg,
    fee: 3000,
    tickSpacing: 10,
    hooks: token("0"),
    tickLower: -10,
    tickUpper: 10,
    liquidity,
    initialAmount0: 0n,
    initialAmount1: basisRaw,
    mintHash: "0x" + "a".repeat(64),
    fundingToken: usdg,
    targetToken: target,
    fundingSymbol: "USDG",
    targetSymbol: "TOKEN",
    fundingDecimals: 6,
    targetDecimals: 18,
    fundingIndex: 1,
    targetIndex: 0,
    openIntentId: "open",
  });
  repo.ingestDeposit({
    id: "open",
    positionId,
    txHash: "0x" + "a".repeat(64),
    logIndex: 0,
    amounts: { token0: 0n, token1: basisRaw },
    blockNumber: 1n,
    blockTimestamp: new Date(1_000).toISOString(),
  });
  return positionId;
}
function intent(repo: SqliteLedgerRepository, key: string) {
  return String(
    repo.createV4LifecycleIntent({
      tokenId: 7n,
      action: "partial_close",
      idempotencyKey: key,
    }).id,
  );
}
function receipt(hashDigit: string, block: number, index = 0) {
  return {
    transactionHash: `0x${hashDigit.repeat(64)}`,
    blockNumber: BigInt(block),
    blockHash: `0x${block.toString(16).padStart(64, "0")}`,
    transactionIndex: index,
    status: "success",
    gasUsed: 1n,
    effectiveGasPrice: 1n,
    logs: [],
  } as any;
}
describe("generic V4 immutable remaining basis", () => {
  it("keeps basis additions structurally impossible in the executable generic lifecycle", () => {
    const lifecycle = readFileSync("apps/cli/src/v4-lifecycle.ts", "utf8"),
      adapter = readFileSync(
        "packages/uniswap-v4-adapter/src/index.ts",
        "utf8",
      );
    expect(lifecycle).toContain(
      "'collect'|'partial_close'|'full_close'|'burn'",
    );
    expect(lifecycle).not.toMatch(/action:\s*'increase'|buildV4Increase/);
    expect(adapter).not.toContain("export function buildV4Increase");
  });
  it("consumes all basis on a fresh terminal close", () => {
    const f = fixture();
    try {
      generic(f.repo);
      const id = intent(f.repo, "full");
      const row = consumeGenericV4Basis({
        repo: f.repo,
        positionId: "v4:7",
        tokenId: "7",
        intentId: id,
        stage: "V4_LIFECYCLE:full_close",
        receipt: receipt("b", 10),
        liquidityBefore: 1000n,
        liquidityRemoved: 1000n,
        liquidityAfter: 0n,
      })!;
      expect(row).toMatchObject({
        basis_before_usd_micros: "100000000",
        basis_delta_usd_micros: "100000000",
        basis_after_usd_micros: "0",
      });
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("allocates 25 percent then absorbs all terminal rounding residue", () => {
    const f = fixture();
    try {
      generic(f.repo, 1n, 3n);
      let id = intent(f.repo, "p1"),
        first = consumeGenericV4Basis({
          repo: f.repo,
          positionId: "v4:7",
          tokenId: "7",
          intentId: id,
          stage: "V4_LIFECYCLE:partial_close",
          receipt: receipt("b", 10),
          liquidityBefore: 3n,
          liquidityRemoved: 1n,
          liquidityAfter: 2n,
        })!;
      expect(first.basis_delta_usd_micros).toBe("0");
      f.repo.db
        .prepare(
          "UPDATE v4_lifecycle_intents SET state='RECONCILED' WHERE id=?",
        )
        .run(id);
      id = intent(f.repo, "full");
      const final = consumeGenericV4Basis({
        repo: f.repo,
        positionId: "v4:7",
        tokenId: "7",
        intentId: id,
        stage: "V4_LIFECYCLE:full_close",
        receipt: receipt("c", 11),
        liquidityBefore: 2n,
        liquidityRemoved: 2n,
        liquidityAfter: 0n,
      })!;
      expect(final).toMatchObject({
        basis_delta_usd_micros: "1",
        basis_after_usd_micros: "0",
      });
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("is replay-idempotent and blocks an unresolved predecessor", () => {
    const f = fixture();
    try {
      generic(f.repo);
      const older = intent(f.repo, "older");
      f.repo.db
        .prepare("UPDATE v4_lifecycle_intents SET state='SUBMITTED' WHERE id=?")
        .run(older);
      const newer = intent(f.repo, "newer");
      expect(() =>
        consumeGenericV4Basis({
          repo: f.repo,
          positionId: "v4:7",
          tokenId: "7",
          intentId: newer,
          stage: "V4_LIFECYCLE:partial_close",
          receipt: receipt("c", 11),
          liquidityBefore: 1000n,
          liquidityRemoved: 250n,
          liquidityAfter: 750n,
        }),
      ).toThrow("V4_REALIZED_BASIS_PREDECESSOR_UNRESOLVED");
      f.repo.db
        .prepare(
          "UPDATE v4_lifecycle_intents SET state='RECONCILED' WHERE id=?",
        )
        .run(older);
      const one = consumeGenericV4Basis({
          repo: f.repo,
          positionId: "v4:7",
          tokenId: "7",
          intentId: newer,
          stage: "V4_LIFECYCLE:partial_close",
          receipt: receipt("c", 11),
          liquidityBefore: 1000n,
          liquidityRemoved: 250n,
          liquidityAfter: 750n,
        }),
        two = consumeGenericV4Basis({
          repo: f.repo,
          positionId: "v4:7",
          tokenId: "7",
          intentId: newer,
          stage: "V4_LIFECYCLE:partial_close",
          receipt: receipt("c", 11),
          liquidityBefore: 1000n,
          liquidityRemoved: 250n,
          liquidityAfter: 750n,
        });
      expect(two).toEqual(one);
      expect(
        f.repo.db
          .prepare(
            "SELECT COUNT(*) count FROM v4_position_basis_events WHERE event_kind='CONSUME'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      f.repo.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("values token0/token1 orientations and non-18 decimals from immutable price", () => {
    const usdg = robinhoodMainnet.assets.USDG,
      target = token("2"),
      a = valueGenericV4Returns({
        token0: target,
        token1: usdg,
        decimals0: 8,
        decimals1: 6,
        amount0: 200_000_000n,
        amount1: 3_000_000n,
        price1Per0: "2.5",
      }),
      b = valueGenericV4Returns({
        token0: usdg,
        token1: target,
        decimals0: 6,
        decimals1: 8,
        amount0: 3_000_000n,
        amount1: 200_000_000n,
        price1Per0: "0.4",
      });
    expect(a.status).toBe("AVAILABLE");
    expect(b.status).toBe("AVAILABLE");
    expect(a.status === "AVAILABLE" && a.totalUsdMicros).toBe(8_000_000n);
    expect(b.status === "AVAILABLE" && b.totalUsdMicros).toBe(8_000_000n);
    expect(rawUsdMicros(1_000_000n, 6, "1")).toBe(1_000_000n);
  });
  it("marks a non-USDG pair incomplete rather than manufacturing value", () => {
    expect(
      valueGenericV4Returns({
        token0: token("2"),
        token1: token("3"),
        decimals0: 18,
        decimals1: 18,
        amount0: 1n,
        amount1: 1n,
        price1Per0: "1",
      }),
    ).toMatchObject({ status: "INCOMPLETE" });
  });
  it("values USDG-only and dual-asset returns exactly from bound sqrt price in both orientations", () => {
    const usdg = robinhoodMainnet.assets.USDG,
      lowerTarget = token("2"),
      higherTarget = token("f"),
      q96 = 2n ** 96n,
      a = valueV4ReturnsFromSqrtPriceX96({
        token0: usdg,
        token1: higherTarget,
        decimals0: 6,
        decimals1: 18,
        amount0: 3_000_000n,
        amount1: 2_000_000n,
        sqrtPriceX96: q96,
      }),
      b = valueV4ReturnsFromSqrtPriceX96({
        token0: lowerTarget,
        token1: usdg,
        decimals0: 18,
        decimals1: 6,
        amount0: 2_000_000n,
        amount1: 3_000_000n,
        sqrtPriceX96: q96,
      }),
      only = valueV4ReturnsFromSqrtPriceX96({
        token0: usdg,
        token1: higherTarget,
        decimals0: 6,
        decimals1: 18,
        amount0: 3_000_000n,
        amount1: 0n,
        sqrtPriceX96: q96,
      });
    expect(a.status === "AVAILABLE" && a.totalUsdMicros).toBe(5_000_000n);
    expect(b.status === "AVAILABLE" && b.totalUsdMicros).toBe(5_000_000n);
    expect(only.status === "AVAILABLE" && only.totalUsdMicros).toBe(3_000_000n);
  });
  it("supports arbitrary target decimals and keeps an earlier bound price immutable", () => {
    const usdg = robinhoodMainnet.assets.USDG,
      target = token("2"),
      bound = 2n ** 96n,
      first = valueV4ReturnsFromSqrtPriceX96({
        token0: target,
        token1: usdg,
        decimals0: 8,
        decimals1: 6,
        amount0: 2_000_000n,
        amount1: 3_000_000n,
        sqrtPriceX96: bound,
      }),
      later = valueV4ReturnsFromSqrtPriceX96({
        token0: target,
        token1: usdg,
        decimals0: 8,
        decimals1: 6,
        amount0: 2_000_000n,
        amount1: 3_000_000n,
        sqrtPriceX96: bound * 2n,
      });
    expect(first.status === "AVAILABLE" && first.totalUsdMicros).toBe(
      5_000_000n,
    );
    expect(later.status === "AVAILABLE" && later.totalUsdMicros).not.toBe(
      5_000_000n,
    );
    expect(first.status === "AVAILABLE" && first.evidence.sqrtPriceX96).toBe(
      bound.toString(),
    );
  });
  it("fails closed without a valid direct USDG pool price", () => {
    expect(
      valueV4ReturnsFromSqrtPriceX96({
        token0: token("2"),
        token1: token("3"),
        decimals0: 18,
        decimals1: 6,
        amount0: 1n,
        amount1: 1n,
        sqrtPriceX96: 2n ** 96n,
      }),
    ).toMatchObject({ status: "INCOMPLETE" });
  });
  it("rejects protocol boundaries, tick mismatch, and zero active liquidity",()=>{
    const usdg=robinhoodMainnet.assets.USDG,target=token("f"),key={currency0:usdg,currency1:target,fee:3000,tickSpacing:10,hooks:token("0")} as any,run=(sqrtPriceX96:bigint,tick:number,activeLiquidity=1n)=>checkedV4Returns({token0:usdg,token1:target,decimals0:6,decimals1:18,amount0:1_000_000n,amount1:0n,sqrtPriceX96,source:{poolId:poolId(key),poolKey:key,sqrtPriceX96,tick,activeLiquidity,initialized:true,blockNumber:1n,token0Decimals:6,token1Decimals:18}});
    expect(run(sqrtPriceAtTick(V4_MIN_TICK),V4_MIN_TICK)).toMatchObject({status:"INCOMPLETE",reason:"POOL_PRICE_AT_PROTOCOL_BOUNDARY"});
    expect(run(sqrtPriceAtTick(100),99)).toMatchObject({status:"INCOMPLETE",reason:"POOL_PRICE_TICK_INCONSISTENT"});
    expect(run(sqrtPriceAtTick(100),100,0n)).toMatchObject({status:"INCOMPLETE",reason:"POOL_ACTIVE_LIQUIDITY_UNAVAILABLE"});
    expect(run(sqrtPriceAtTick(100),100)).toMatchObject({status:"AVAILABLE"});
  });
});

describe("synthetic pre-CLOSE CLAIM regressions", () => {
  const target = "0xffffffffffffffffffffffffffffffffffffffff";
  const q96 = 2n ** 96n;
  const valued = (amount0: bigint, amount1: bigint) =>
    valueV4ReturnsFromSqrtPriceX96({
      token0: robinhoodMainnet.assets.USDG,
      token1: target,
      decimals0: 6,
      decimals1: 18,
      amount0,
      amount1,
      sqrtPriceX96: q96,
    });

  it("keeps CLAIM, CLOSE fees, lifecycle fees, and lifecycle PnL independent", () => {
    const claim = valued(3_000_000n, 2_000_000n),
      close = valued(4_000_000n, 1_000_000n);
    expect(claim.status).toBe("AVAILABLE");
    expect(close.status).toBe("AVAILABLE");
    if (claim.status !== "AVAILABLE" || close.status !== "AVAILABLE") return;
    expect(claim.totalUsdMicros).toBe(5_000_000n);
    expect(close.totalUsdMicros).toBe(5_000_000n);
    expect(claim.totalUsdMicros + close.totalUsdMicros).toBe(10_000_000n);
    expect(claim.totalUsdMicros + 2_000_000n).toBe(7_000_000n);
  });
  it("counts multiple CLAIMs plus exact CLOSE fees exactly once", () => {
    const first = valued(1_000_000n, 1_000_000n),
      second = valued(2_000_000n, 1_000_000n),
      close = valued(3_000_000n, 2_000_000n);
    expect(first.status).toBe("AVAILABLE");
    expect(second.status).toBe("AVAILABLE");
    expect(close.status).toBe("AVAILABLE");
    if (
      first.status !== "AVAILABLE" ||
      second.status !== "AVAILABLE" ||
      close.status !== "AVAILABLE"
    )
      return;
    expect(first.totalUsdMicros).toBe(2_000_000n);
    expect(second.totalUsdMicros).toBe(3_000_000n);
    expect(close.totalUsdMicros).toBe(5_000_000n);
    expect(
      first.totalUsdMicros + second.totalUsdMicros + close.totalUsdMicros,
    ).toBe(10_000_000n);
  });
  it("rejects prior CLAIM-only LP fees as the lifecycle total", () => {
    const close = valued(6_000_000n, 4_000_000n);
    expect(close.status).toBe("AVAILABLE");
    if (close.status !== "AVAILABLE") return;
    const priorClaim = 2_000_000n,
      lifecycleFees = priorClaim + close.totalUsdMicros,
      lifecyclePnl = priorClaim + 8_000_000n;
    expect(close.totalUsdMicros).toBe(10_000_000n);
    expect(lifecycleFees).toBe(12_000_000n);
    expect(lifecycleFees).not.toBe(priorClaim);
    expect(lifecyclePnl).toBe(10_000_000n);
  });
});

describe("Daily PnL WIB coverage and incomplete truth", () => {
  const day = wibDayWindow(new Date("2026-08-26T18:00:00.000Z")),
    close = (
      status: "AVAILABLE" | "INCOMPLETE",
      pnl: string | null,
      basis = "2000",
    ) => ({
      event_kind: "CLOSE",
      valuation_status: status,
      realized_pnl_usd: pnl,
      capital_basis_usd: basis,
    }),
    claim = (pnl: string) => ({
      event_kind: "CLAIM",
      valuation_status: "AVAILABLE",
      realized_pnl_usd: pnl,
      capital_basis_usd: null,
    });
  it("uses exact WIB boundaries for full, partial, following, and historical coverage", () => {
    expect(day.startMs).toBe(Date.parse("2026-08-26T17:00:00.000Z"));
    expect(
      dailyPnlPresentation({ day, coverageStartMs: day.startMs, events: [] })
        .status,
    ).toBe("FULL");
    expect(
      dailyPnlPresentation({
        day,
        coverageStartMs: day.startMs + 55 * 60_000,
        events: [],
      }).status,
    ).toBe("PARTIAL");
    const next = wibDayWindow(new Date(day.endMs + 1));
    expect(
      dailyPnlPresentation({
        day: next,
        coverageStartMs: day.startMs + 55 * 60_000,
        events: [],
      }).status,
    ).toBe("FULL");
    expect(
      dailyPnlPresentation({ day, coverageStartMs: day.endMs, events: [] })
        .status,
    ).toBe("HISTORICAL_UNAVAILABLE");
  });
  it("never presents unknown as zero or exposes a period denominator", () => {
    const result = dailyPnlPresentation({
      day,
      coverageStartMs: day.startMs + 55 * 60_000,
      events: [claim("5"), close("INCOMPLETE", null)],
    });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.caption).toContain("KNOWN PNL: +$5.00");
    expect(result.caption).toContain(
      "Valuation incomplete · unpriced events present",
    );
    expect(result.caption).not.toContain("Capital Basis");
    expect(result.caption).not.toContain("Coverage: full");
    expect(result.caption).not.toContain("REALIZED PNL: $0.00");
  });
  it("propagates one invalid CLOSE through Daily, Weekly, Monthly, and lifecycle coverage",()=>{
    const invalid={event_id:"synthetic-invalid-close",event_kind:"CLOSE",valuation_status:"INCOMPLETE",realized_pnl_usd:null,newly_realized_fees_usd:null,capital_basis_usd:"100"};
    expect(lifecyclePnlPresentation({closeEvent:invalid,events:[invalid]})).toMatchObject({coverage:"INCOMPLETE",pnl:null});
    for(const kind of ["DAILY_PNL","WEEKLY_PNL","MONTHLY_PNL"] as const){const period=wibPeriodWindow(kind,new Date("2026-08-30T12:00:00.000Z")),result=periodPnlPresentation({period,coverageStartMs:period.startMs,events:[invalid]});expect(result).toMatchObject({status:"INCOMPLETE",incompleteCount:1});expect(result.caption).not.toContain("Coverage: full");}
  });
  it("shows true zero only for fully valued events", () => {
    const result = dailyPnlPresentation({
      day,
      coverageStartMs: day.startMs,
      events: [close("AVAILABLE", "0")],
    });
    expect(result.status).toBe("FULL");
    expect(result.caption).toContain("REALIZED PNL: $0.00");
  });
  it("assigns CLAIM to day A and CLOSE to day B without adding descriptive CLOSE fees to period PnL", () => {
    const a = wibPeriodWindow("DAILY_PNL", new Date("2026-08-26T18:00:00Z")),
      b = wibPeriodWindow("DAILY_PNL", new Date(a.endMs + 1)),
      claimRow = {
        event_id: "claim",
        event_kind: "CLAIM",
        valuation_status: "AVAILABLE",
        realized_pnl_usd: "12",
        newly_realized_fees_usd: "12",
        economic_final_at_ms: a.endMs - 1,
      },
      closeRow = {
        event_id: "close",
        event_kind: "CLOSE",
        valuation_status: "AVAILABLE",
        realized_pnl_usd: "30",
        newly_realized_fees_usd: "9",
        capital_basis_usd: "100",
        economic_final_at_ms: b.startMs,
      };
    expect(
      periodPnlPresentation({
        period: a,
        coverageStartMs: a.startMs,
        events: [claimRow],
      }).knownPnlMicros,
    ).toBe(12_000_000n);
    expect(
      periodPnlPresentation({
        period: b,
        coverageStartMs: a.startMs,
        events: [closeRow],
      }).knownPnlMicros,
    ).toBe(30_000_000n);
    expect(
      lifecyclePnlPresentation({
        closeEvent: closeRow,
        events: [claimRow, closeRow],
      }),
    ).toMatchObject({ pnl: 42, lpFees: 21 });
  });
  it("isolates reposition generations by exact lifecycle identity", () => {
    const sourceClaim = {
        event_id: "g0-claim",
        event_kind: "CLAIM",
        valuation_status: "AVAILABLE",
        realized_pnl_usd: "5",
        newly_realized_fees_usd: "5",
      },
      sourceClose = {
        event_id: "g0-close",
        event_kind: "CLOSE",
        valuation_status: "AVAILABLE",
        realized_pnl_usd: "20",
        newly_realized_fees_usd: "7",
        capital_basis_usd: "100",
      },
      childClaim = {
        event_id: "g1-claim",
        event_kind: "CLAIM",
        valuation_status: "AVAILABLE",
        realized_pnl_usd: "3",
        newly_realized_fees_usd: "3",
      },
      childClose = {
        event_id: "g1-close",
        event_kind: "CLOSE",
        valuation_status: "AVAILABLE",
        realized_pnl_usd: "8",
        newly_realized_fees_usd: "2",
        capital_basis_usd: "100",
      };
    expect(
      lifecyclePnlPresentation({
        closeEvent: sourceClose,
        events: [sourceClaim, sourceClose],
      }),
    ).toMatchObject({ pnl: 25, lpFees: 12 });
    expect(
      lifecyclePnlPresentation({
        closeEvent: childClose,
        events: [childClaim, childClose],
      }),
    ).toMatchObject({ pnl: 11, lpFees: 5 });
  });
  it.each([
    [
      "FULL",
      day.startMs,
      [close("AVAILABLE", "5")],
      ["+$5.00", "Positions closed", "Closed PnL"],
    ],
    [
      "PARTIAL",
      day.startMs + 55 * 60_000,
      [claim("5")],
      ["PARTIAL", "KNOWN PNL", "+$5.00", "Fee claims", "Coverage partial"],
    ],
    [
      "INCOMPLETE",
      day.startMs,
      [claim("5"), close("INCOMPLETE", null)],
      ["KNOWN PNL", "+$5.00", "Unpriced events", "Valuation incomplete"],
    ],
  ] as const)(
    "renders a populated 1080 card for %s coverage",
    (_label, start, events, required) => {
      const presentation = dailyPnlPresentation({
          day,
          coverageStartMs: start,
          events: [...events],
        }),
        png = renderFuniPnlCard({ model: presentation.card }),
        semantic = png.toString("utf8");
      expect(png.readUInt32BE(16)).toBe(1080);
      expect(png.readUInt32BE(20)).toBe(1080);
      for (const text of required)
        expect(semantic.toUpperCase()).toContain(text.toUpperCase());
    },
  );
});

describe("Close card presentation contract", () => {
  it("uses canonical pair/held evidence, defaults to privacy, and preserves branding", () => {
    const source = readFileSync(
        "apps/telegram-lp-bot/src/pnl-card-delivery.ts",
        "utf8",
      ),
      card = readFileSync("apps/telegram-lp-bot/src/pnl-card.ts", "utf8"),
      ladder = readFileSync("apps/cli/src/v4-bid-ladder-live.ts", "utf8"),
      reconcile = ladder.slice(
        ladder.indexOf("async function reconcileClose"),
        ladder.indexOf("function closeExpectedFromJournal"),
      ),
      close = ladder.slice(
        ladder.indexOf("export async function executeV4BidLadderManualClose"),
      );
    expect(source).toContain('"FUNI · POSITION CLOSED"');
    expect(source).toContain('dateStyle:"medium"');
    expect(source).toContain("`Closed: ${when} · WIB`");
    expect(source).not.toContain("`Tx: ${text(event.transaction_hash)");
    expect(source).not.toContain("`Event: ${text(event.event_id)}`");
    expect(source).toContain("transactionHash:event.transaction_hash");
    expect(source).toContain("showCapitalBasis:false");
    expect(card).toContain("normalizePositionPrivacy");
    expect(ladder).toContain("OPEN_RECEIPT_BLOCK_TIMESTAMP");
    expect(card).toContain("t.me/Jajajakbothouse");
    expect(reconcile).not.toContain("USDG_ONLY_CANONICAL_VALUE");
    expect(close).toContain("inlineCanonicalBidLadderReceipt");
    expect(close).not.toContain("await reconcileClose");
  });
  it("prefers canonical symbols and otherwise shortens addresses", () => {
    expect(
      v4BidLadderClosePairLabel({
        targetSymbol: "BISCOTTI",
        fundingSymbol: "USDG",
        targetAddress: token("2"),
        fundingAddress: token("3"),
      }),
    ).toBe("BISCOTTI/USDG");
    const fallback = v4BidLadderClosePairLabel({
      targetAddress: token("2"),
      fundingAddress: token("3"),
    });
    expect(fallback).toContain("…");
    expect(fallback).not.toContain(token("2"));
  });
});
