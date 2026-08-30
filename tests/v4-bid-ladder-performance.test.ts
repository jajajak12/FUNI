import { describe, expect, it } from "vitest";
import { robinhoodMainnet, type FallbackRpc } from "@funi/core";
import {
  amountsForLiquidity,
  inspectV4ClaimableFeesBatch,
  poolId,
  sqrtPriceAtTick,
  type V4PoolKey,
} from "@funi/v4";
import {
  calculateOpenV4BidLadderPerformance,
  formatPersistedV4BidLadder,
  type BidLadderToken,
  type V4BidLadderPerformance,
} from "../apps/cli/src/v4-bid-ladder-operator.js";

const zero = "0x0000000000000000000000000000000000000000" as const,
  target = "0xffffffffffffffffffffffffffffffffffffffff" as const,
  usdg = robinhoodMainnet.assets.USDG;
const [currency0, currency1] = [usdg, target].sort((a, b) =>
  a.toLowerCase().localeCompare(b.toLowerCase()),
) as [typeof usdg, typeof target];
const key: V4PoolKey = {
  currency0,
  currency1,
  fee: 500,
  tickSpacing: 10,
  hooks: zero,
};
const token = (address: string): BidLadderToken => ({
  address: address as `0x${string}`,
  symbol: address.toLowerCase() === usdg.toLowerCase() ? "USDG" : "TARGET",
  decimals: 0,
});
const token0 = token(currency0),
  token1 = token(currency1),
  sqrtPriceX96 = sqrtPriceAtTick(0);
const ranges = [
  [-300, -200],
  [-200, -100],
  [-100, 100],
  [100, 200],
  [200, 300],
] as const;
const legs = ranges.map((_, leg_index) => ({
  leg_index,
  token_id: String(leg_index + 1),
  funding_amount_raw: "400",
  planned_liquidity_raw: "1",
  tick_lower: -1,
  tick_upper: 1,
}));
const parent = (status = "OPEN", deployed = 2_000) => ({
  ladder_id: "ladder",
  status,
  entry_usd_snapshot: deployed,
  pool_id: poolId(key),
  currency0,
  currency1,
  fee: key.fee,
  tick_spacing: key.tickSpacing,
  hooks: key.hooks,
  funding_token: usdg,
  target_token: target,
  funding_index: currency0.toLowerCase() === usdg.toLowerCase() ? 0 : 1,
  target_index: currency0.toLowerCase() === target.toLowerCase() ? 0 : 1,
  reference_tick: 0,
  reference_block: "1",
});
const positions = (
  liquidities: readonly bigint[],
  claimed0: readonly unknown[] = [],
  claimed1: readonly unknown[] = [],
) =>
  ranges.map(([tick_lower, tick_upper], index) => ({
    token_id: String(index + 1),
    tick_lower,
    tick_upper,
    liquidity_raw: (liquidities[index] ?? 0n).toString(),
    claimed_fee0_raw: index in claimed0 ? claimed0[index] : "0",
    claimed_fee1_raw: index in claimed1 ? claimed1[index] : "0",
    withdrawn_principal0_raw: "999999999",
    withdrawn_principal1_raw: "999999999",
  }));
const calculate = (
  input: Partial<
    Parameters<typeof calculateOpenV4BidLadderPerformance>[0]
  > = {},
) =>
  calculateOpenV4BidLadderPerformance({
    parent: parent(),
    legs,
    positions: positions([
      1_000_000n,
      1_000_000n,
      1_000_000n,
      1_000_000n,
      1_000_000n,
    ]),
    current: { sqrtPriceX96, liquidity: 1n, initialized: true },
    token0,
    token1,
    unclaimed: {
      status: "available",
      token0: 0n,
      token1: 0n,
      rpcRoundTrips: 2,
      latencyMs: 7,
    },
    ...input,
  })!;

function liquidityForExactToken0(
  amount: bigint,
  tickLower = 100,
  tickUpper = 200,
) {
  let low = 0n,
    high = 1n;
  while (
    amountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, high).token0 <
    amount
  )
    high *= 2n;
  while (low <= high) {
    const mid = (low + high) / 2n,
      value = amountsForLiquidity(
        sqrtPriceX96,
        tickLower,
        tickUpper,
        mid,
      ).token0;
    if (value === amount) return mid;
    if (value < amount) low = mid + 1n;
    else high = mid - 1n;
  }
  throw new Error("exact liquidity not found");
}

describe("OPEN V4 BID Ladder aggregate performance", () => {
  it("includes all five persisted NFTs across 2 above / 1 in / 2 below, including both one-sided states and both in-range tokens", () => {
    const rows = positions([101n, 202n, 303n, 404n, 505n]),
      value = calculate({ positions: rows }),
      expected = rows.reduce(
        (sum, row) => {
          const amount = amountsForLiquidity(
            sqrtPriceX96,
            row.tick_lower,
            row.tick_upper,
            BigInt(row.liquidity_raw),
          );
          return {
            token0: sum.token0 + amount.token0,
            token1: sum.token1 + amount.token1,
          };
        },
        { token0: 0n, token1: 0n },
      );
    expect(value.principal).toEqual(expected);
    expect(amountsForLiquidity(sqrtPriceX96, 100, 200, 404n)).toMatchObject({
      token1: 0n,
    });
    expect(amountsForLiquidity(sqrtPriceX96, -300, -200, 101n)).toMatchObject({
      token0: 0n,
    });
    const middle = amountsForLiquidity(sqrtPriceX96, -100, 100, 303n);
    expect(middle.token0).toBeGreaterThan(0n);
    expect(middle.token1).toBeGreaterThan(0n);
  });

  it("excludes claimed fees, withdrawn principal, and unrelated pool liquidity; a zero-liquidity leg does not affect the other four", () => {
    const base = positions([0n, 202n, 303n, 404n, 505n]),
      withFees = base.map((row) => ({
        ...row,
        claimed_fee0_raw: "999",
        claimed_fee1_raw: "888",
        withdrawn_principal0_raw: "777",
      })),
      a = calculate({ positions: base }),
      b = calculate({ positions: withFees });
    expect(a.principal).toEqual(b.principal);
    expect(a.currentPrincipalUsd).toBe(b.currentPrincipalUsd);
    expect(a.principal.token0 + a.principal.token1).toBeGreaterThan(0n);
  });

  it("uses cumulative claimed_fee columns once, ignores principal-return columns, current-marks target fees, and fails soft on malformed durable evidence", () => {
    const claimed0 = ["1", "2", "3", "4", "5"],
      claimed1 = ["0", "1", "1", "1", "1"],
      rows = positions([0n, 0n, 0n, 0n, 0n], claimed0, claimed1),
      value = calculate({ positions: rows });
    expect(value.claimedFeesUsd).toBe(19);
    expect(value.claimedCurrentValue).toBe(true);
    expect(
      rows.reduce((sum, row) => sum + BigInt(row.withdrawn_principal0_raw), 0n),
    ).toBeGreaterThan(0n);
    const malformed = calculate({
      positions: positions([0n, 0n, 0n, 0n, 0n], [null, "0", "0", "0", "0"]),
    });
    expect(malformed.claimedFeesUsd).toBeNull();
    expect(malformed.totalFeesUsd).toBeNull();
    expect(malformed.totalPnlUsd).toBeNull();
  });

  it("computes the required PnL examples and preserves unrealized PnL when unclaimed fees are unavailable", () => {
    const liquidity = liquidityForExactToken0(1_900n),
      rows = positions([0n, 0n, 0n, liquidity, 0n], ["0", "0", "0", "20", "0"]),
      a = calculate({
        positions: rows,
        unclaimed: {
          status: "available",
          token0: 10n,
          token1: 0n,
          rpcRoundTrips: 2,
          latencyMs: 3,
        },
      });
    expect(a.currentPrincipalUsd).toBe(1_900);
    expect(a.unrealizedPnlUsd).toBe(-100);
    expect(a.unrealizedPnlPct).toBe(-5);
    expect(a.totalFeesUsd).toBe(30);
    expect(a.totalPnlUsd).toBe(-70);
    expect(a.totalPnlPct).toBeCloseTo(-3.5, 12);
    const liquidity2050 = liquidityForExactToken0(2_050n),
      rows2050 = positions(
        [0n, 0n, 0n, liquidity2050, 0n],
        ["0", "0", "0", "10", "0"],
      ),
      b = calculate({
        positions: rows2050,
        unclaimed: {
          status: "available",
          token0: 5n,
          token1: 0n,
          rpcRoundTrips: 2,
          latencyMs: 3,
        },
      });
    expect(b.currentPrincipalUsd).toBe(2_050);
    expect(b.totalPnlUsd).toBe(65);
    const unavailable = calculate({
      positions: rows,
      unclaimed: { status: "unavailable" },
    });
    expect(unavailable.unrealizedPnlUsd).toBe(-100);
    expect(unavailable.unclaimedFeesUsd).toBeNull();
    expect(unavailable.totalFeesUsd).toBeNull();
    expect(unavailable.totalPnlUsd).toBeNull();
  });

  it("renders signed two-decimal OPEN accounting only and never invents CLOSED/CANCELLED performance", () => {
    const performance: V4BidLadderPerformance = {
        deployedUsd: 2000,
        currentPrincipalUsd: 1900,
        principal: { token0: 1900n, token1: 0n },
        unrealizedPnlUsd: -100,
        unrealizedPnlPct: -5,
        claimedFeesUsd: 20,
        unclaimedFeesUsd: 10,
        totalFeesUsd: 30,
        totalPnlUsd: -70,
        totalPnlPct: -3.5,
        claimedCurrentValue: true,
        feeBatchRpcCount: 1,
        feeBatchLatencyMs: 3,
      },
      current = {
        id: poolId(key),
        key,
        sqrtPriceX96,
        tick: 0,
        liquidity: 1n,
        initialized: true,
      };
    const open = formatPersistedV4BidLadder({
      parent: parent(),
      legs,
      funding: token(usdg),
      target: token(target),
      current,
      performance,
    });
    expect(open).toContain("V4 BID Ladder V1 · OPEN");
    expect(open).toContain("Deployed: $2,000.00");
    expect(open).toContain("Unrealized PnL: -$100.00 (-5.00%)");
    expect(open).toContain("Claimed: $20.00 (current value)");
    expect(open).toContain("Total PnL incl. fees: -$70.00 (-3.50%)");
    expect(open).not.toContain("Fees: not modeled in Phase 1");
    const dust = formatPersistedV4BidLadder({
      parent: parent(),
      legs,
      funding: token(usdg),
      target: token(target),
      current,
      performance: {
        ...performance,
        unrealizedPnlUsd: -0.000005,
        unrealizedPnlPct: -0.00000025,
        totalPnlUsd: -0.000005,
        totalPnlPct: -0.00000025,
      },
    });
    expect(dust).toContain("Unrealized PnL: $0.00 (0.00%)");
    expect(dust).toContain("Total PnL incl. fees: $0.00 (0.00%)");
    for (const status of ["CLOSED", "CANCELLED"]) {
      const text = formatPersistedV4BidLadder({
        parent: parent(status),
        legs,
        funding: token(usdg),
        target: token(target),
        current,
        performance,
      });
      expect(text).not.toContain("Performance");
      expect(text).not.toContain("Current principal:");
    }
  });

  it("reproduces the exact production boundary-price corruption and fails soft without hiding independently valid USDG principal", () => {
    const incidentKey = {
        currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        currency1: "0xAc77646bcff9d52e99800534192E0290933F4094",
        fee: 28095,
        tickSpacing: 281,
        hooks: zero,
      } as const,
      incidentRanges = [
        [340572, 340853],
        [340853, 341696],
        [341696, 342820],
        [342820, 344787],
        [344787, 347035],
      ] as const,
      liquidities = [
        284819575299023284n,
        146458415076845146n,
        173060205304381389n,
        148343063022375226n,
        213424826551720524n,
      ],
      claims = [
        [12664512n, 7914089845296676516114n],
        [23190452n, 15349903367640780193208n],
        [13117069n, 9478763292031893810171n],
        [2595328n, 2038439257447554833905n],
        [0n, 0n],
      ] as const,
      incidentPositions = incidentRanges.map(([tick_lower, tick_upper], i) => ({
        token_id: String(859930 + i),
        tick_lower,
        tick_upper,
        liquidity_raw: liquidities[i]!.toString(),
        claimed_fee0_raw: "0",
        claimed_fee1_raw: "0",
      })),
      incidentLegs = incidentRanges.map(([tick_lower, tick_upper], leg_index) => ({
        leg_index,
        token_id: String(859930 + leg_index),
        tick_lower,
        tick_upper,
        funding_amount_raw: ["160000000", "240000000", "360000000", "500000000", "740000000"][leg_index],
      })),
      incidentParent = {
        ...parent(),
        pool_id: poolId(incidentKey),
        currency0: incidentKey.currency0,
        currency1: incidentKey.currency1,
        fee: incidentKey.fee,
        tick_spacing: incidentKey.tickSpacing,
        hooks: incidentKey.hooks,
        funding_token: incidentKey.currency0,
        target_token: incidentKey.currency1,
        funding_index: 0,
        target_index: 1,
      },
      total0 = claims.reduce((sum, row) => sum + row[0], 0n),
      total1 = claims.reduce((sum, row) => sum + row[1], 0n),
      boundary = 4295128740n,
      legacyRatio = (Number(boundary) / 2 ** 96) ** 2 * 10 ** -12,
      legacyUsd = Number(total0) / 1e6 + Number(total1) / 1e18 / legacyRatio;
    expect(total0).toBe(51567361n);
    expect(total1).toBe(34781195762416905353398n);
    expect(legacyUsd).toBe(1.183453790214995e55);
    const value = calculateOpenV4BidLadderPerformance({
      parent: incidentParent,
      legs: incidentLegs,
      positions: incidentPositions,
      current: { sqrtPriceX96: boundary, liquidity: 0n, initialized: true },
      token0: { address: incidentKey.currency0, symbol: "USDG", decimals: 6 },
      token1: {
        address: incidentKey.currency1,
        symbol: "MARTIANS",
        decimals: 18,
      },
      unclaimed: {
        status: "available",
        token0: total0,
        token1: total1,
        rpcRoundTrips: 2,
        latencyMs: 1,
      },
    })!;
    expect(value.currentPrincipalUsd).toBe(1999.999995);
    expect(value.unclaimedFeesUsd).toBeNull();
    expect(value.totalFeesUsd).toBeNull();
    expect(value.totalPnlUsd).toBeNull();
    const text = formatPersistedV4BidLadder({
      parent: incidentParent,
      legs: incidentLegs,
      funding: { address: incidentKey.currency0, symbol: "USDG", decimals: 6 },
      target: {
        address: incidentKey.currency1,
        symbol: "MARTIANS",
        decimals: 18,
      },
      current: {
        id: poolId(incidentKey),
        key: incidentKey,
        sqrtPriceX96: boundary,
        tick: -887272,
        liquidity: 0n,
        initialized: true,
      },
      performance: value,
    });
    expect(text).toContain("Current principal: $2,000.00");
    expect(text).toContain("Unclaimed: Unavailable");
    expect(text).toContain("Total fees: Unavailable");
    expect(text).toContain("Total PnL incl. fees: Unavailable");
    expect(text).not.toContain("1.183453790214995e+55");
  });
});

describe("five-position StateView fee batching", () => {
  const batchPositions = ranges.map(([tickLower, tickUpper], index) => ({
    tokenId: BigInt(index + 1),
    key,
    tickLower,
    tickUpper,
    liquidity: BigInt(index + 1),
  }));
  function rpc(results: unknown, throws = false) {
    let providerRoundTrips = 0,
      multicalls = 0;
    const value = {
      withClient: async (operation: (client: any) => Promise<unknown>) => {
        providerRoundTrips++;
        return operation({
          getBlockNumber: async () => 123n,
          multicall: async (input: any) => {
            multicalls++;
            expect(input.contracts).toHaveLength(17);
            expect(input.blockNumber).toBe(123n);
            expect(input.allowFailure).toBe(true);
            if (throws) throw new Error("provider failed");
            return results;
          },
        });
      },
    } as unknown as FallbackRpc;
    return { value, counts: () => ({ providerRoundTrips, multicalls }) };
  }
  const info = (lower: number, upper: number) =>
      (BigInt(lower & 0xffffff) << 8n) | (BigInt(upper & 0xffffff) << 32n),
    q128 = 2n ** 128n,
    prefix = [
      { status: "success", result: [sqrtPriceX96, 0, 0, 500] },
      { status: "success", result: 1n },
    ],
    success = [
      ...prefix,
      ...batchPositions.flatMap((position, index) => [
        {
          status: "success",
          result: [position.key, info(position.tickLower, position.tickUpper)],
        },
        { status: "success", result: [position.liquidity, 0n, 0n] },
        { status: "success", result: [q128 * BigInt(index + 1), q128 * 2n] },
      ]),
    ];

  it("pins one block then uses one Multicall3 snapshot and matches five canonical fee-growth calculations", async () => {
    const mock = rpc(success),
      before = JSON.stringify(batchPositions, (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
      result = await inspectV4ClaimableFeesBatch(mock.value, batchPositions);
    expect(mock.counts()).toEqual({ providerRoundTrips: 1, multicalls: 1 });
    expect(
      result.positions.map((value) => [value.token0, value.token1]),
    ).toEqual(
      batchPositions.map((position, index) => [
        position.liquidity * BigInt(index + 1),
        position.liquidity * 2n,
      ]),
    );
    expect(result.token0).toBe(55n);
    expect(result.token1).toBe(30n);
    expect(
      JSON.stringify(batchPositions, (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).toBe(before);
  });

  it("returns proven literal zero and fails closed for provider, partial, malformed, association, or liquidity-mismatch batches", async () => {
    const zeroResults = [
        ...prefix,
        ...batchPositions.flatMap((position) => [
          {
            status: "success",
            result: [
              position.key,
              info(position.tickLower, position.tickUpper),
            ],
          },
          { status: "success", result: [position.liquidity, 0n, 0n] },
          { status: "success", result: [0n, 0n] },
        ]),
      ],
      zeroMock = rpc(zeroResults);
    await expect(
      inspectV4ClaimableFeesBatch(zeroMock.value, batchPositions),
    ).resolves.toMatchObject({
      token0: 0n,
      token1: 0n,
      pool: { blockNumber: 123n, liquidity: 1n },
      rpcRoundTrips: 2,
    });
    await expect(
      inspectV4ClaimableFeesBatch(rpc([], true).value, batchPositions),
    ).rejects.toThrow("provider failed");
    const partial: unknown[] = [...success];
    partial[4] = { status: "failure" };
    await expect(
      inspectV4ClaimableFeesBatch(rpc(partial).value, batchPositions),
    ).rejects.toThrow("V4_FEE_BATCH_PARTIAL_OR_MALFORMED");
    const malformed: unknown[] = [...success];
    malformed[4] = { status: "success", result: [1n] };
    await expect(
      inspectV4ClaimableFeesBatch(rpc(malformed).value, batchPositions),
    ).rejects.toThrow("V4_FEE_BATCH_PARTIAL_OR_MALFORMED");
    const association: unknown[] = [...success];
    association[2] = {
      status: "success",
      result: [{ ...key, fee: 3000 }, info(ranges[0][0], ranges[0][1])],
    };
    await expect(
      inspectV4ClaimableFeesBatch(rpc(association).value, batchPositions),
    ).rejects.toThrow("V4_FEE_BATCH_POSITION_ASSOCIATION_MISMATCH");
    const mismatch: unknown[] = [...success];
    mismatch[3] = { status: "success", result: [999n, 0n, 0n] };
    await expect(
      inspectV4ClaimableFeesBatch(rpc(mismatch).value, batchPositions),
    ).rejects.toThrow("V4_FEE_BATCH_LIQUIDITY_MISMATCH");
  });

  it("preserves uint256 wrap semantics, ordering, boundary ticks, zero active liquidity, and legitimate high fees without a magnitude cap", async () => {
    const wrapped = [...success];
    wrapped[0] = {
      status: "success",
      result: [sqrtPriceAtTick(-887272), -887272, 0, 500],
    };
    wrapped[1] = { status: "success", result: 0n };
    wrapped[3] = {
      status: "success",
      result: [batchPositions[0]!.liquidity, q128 * 9n, 0n],
    };
    wrapped[4] = { status: "success", result: [q128 * 8n, q128 * 2n ** 120n] };
    const result = await inspectV4ClaimableFeesBatch(
      rpc(wrapped).value,
      batchPositions,
    );
    expect(result.pool).toMatchObject({
      tick: -887272,
      liquidity: 0n,
      initialized: true,
    });
    expect(result.positions.map((row) => row.tokenId)).toEqual([
      1n,
      2n,
      3n,
      4n,
      5n,
    ]);
    expect(result.positions[0]!.token0).toBe(
      (batchPositions[0]!.liquidity * (2n ** 256n - q128)) / q128,
    );
    expect(result.positions[0]!.token1).toBe(
      batchPositions[0]!.liquidity * 2n ** 120n,
    );
    for (const tick of [-887272, -887271, 887272]) {
      const boundary = [...success];
      boundary[0] = {
        status: "success",
        result: [sqrtPriceAtTick(tick), tick, 0, 500],
      };
      await expect(
        inspectV4ClaimableFeesBatch(rpc(boundary).value, batchPositions),
      ).resolves.toMatchObject({ pool: { tick } });
    }
  });
});
