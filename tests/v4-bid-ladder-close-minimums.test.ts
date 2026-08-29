import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";
import {
  amountsForLiquidity,
  buildV4BatchFullDecrease,
  decodeV4BatchFullDecrease,
  sqrtPriceAtTick,
  V4_ACTIONS,
  type V4PoolKey,
} from "@funi/v4";
import {
  V4_BID_LADDER_CLOSE_SLIPPAGE_BPS,
  v4BidLadderCloseMinimums,
} from "../apps/cli/src/v4-bid-ladder-live.js";

const owner = "0x0000000000000000000000000000000000000003" as Address,
  key: V4PoolKey = {
    currency0: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    currency1: "0xac77646bcff9d52e99800534192e0290933f4094",
    fee: 9000,
    tickSpacing: 90,
    hooks: zeroAddress,
  },
  incidentReferenceSqrt = 2365747610385961252431926527708234352n,
  incidentExecutionSqrt = 2346206015761339928332710316635443912n,
  incidentLegs = [
    [862481n, 338940, 339480, 137482694215477372n],
    [862482n, 339480, 340380, 128262858474543379n],
    [862483n, 340380, 341910, 120241968585312146n],
    [862484n, 341910, 344340, 116048773467744169n],
    [862485n, 344340, 347940, 134695676032014718n],
  ] as const;

function integerSquareRoot(value: bigint) {
  if (value < 2n) return value;
  let current = 1n << BigInt((value.toString(2).length + 1) >> 1),
    next = (current + value / current) >> 1n;
  while (next < current) {
    current = next;
    next = (current + value / current) >> 1n;
  }
  return current;
}
function movedSqrt(sqrtPriceX96: bigint, bps: number, direction: -1 | 1) {
  return integerSquareRoot(
    (sqrtPriceX96 *
      sqrtPriceX96 *
      BigInt(10_000 + direction * bps)) /
      10_000n,
  );
}
function satisfies(
  referenceSqrt: bigint,
  executionSqrt: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
) {
  const mins = v4BidLadderCloseMinimums({
      sqrtPriceX96: referenceSqrt,
      tickLower,
      tickUpper,
      liquidity,
    }),
    actual = amountsForLiquidity(
      executionSqrt,
      tickLower,
      tickUpper,
      liquidity,
    );
  return {
    pass: actual.token0 >= mins.amount0Min && actual.token1 >= mins.amount1Min,
    mins,
    actual,
  };
}

describe("V4 BID Ladder CLOSE price-space minimums", () => {
  it("reproduces the incident fourth-member failure and lets all exact five members pass at 200 bps", () => {
    expect(V4_BID_LADDER_CLOSE_SLIPPAGE_BPS).toBe(200);
    const results = incidentLegs.map(([tokenId, tickLower, tickUpper, liquidity]) => {
      const reference = amountsForLiquidity(
          incidentReferenceSqrt,
          tickLower,
          tickUpper,
          liquidity,
        ),
        actual = amountsForLiquidity(
          incidentExecutionSqrt,
          tickLower,
          tickUpper,
          liquidity,
        ),
        oldMin0 = (reference.token0 * 9950n) / 10_000n,
        oldMin1 = (reference.token1 * 9950n) / 10_000n,
        fixed = satisfies(
          incidentReferenceSqrt,
          incidentExecutionSqrt,
          tickLower,
          tickUpper,
          liquidity,
        );
      return {
        tokenId,
        oldPass: actual.token0 >= oldMin0 && actual.token1 >= oldMin1,
        fixed,
        liquidity,
      };
    });
    expect(results.map((result) => result.oldPass)).toEqual([
      true,
      true,
      true,
      false,
      true,
    ]);
    expect(results.every((result) => result.fixed.pass)).toBe(true);
    expect(results[3]!.fixed).toMatchObject({
      mins: { amount1Min: 348963084589581911134568n },
      actual: { token1: 355166801785126587587142n },
    });

    const plan = buildV4BatchFullDecrease({
        recipient: owner,
        deadline: 999n,
        legs: results.map((result, index) => ({
          key,
          tokenId: result.tokenId,
          liquidity: result.liquidity,
          amount0Min: result.fixed.mins.amount0Min,
          amount1Min: result.fixed.mins.amount1Min,
          hookData: "0x" as const,
        })),
      }),
      decoded = decodeV4BatchFullDecrease(plan.calldata, {
        key,
        recipient: owner,
      });
    expect(decoded.legs).toHaveLength(5);
    expect(decoded.actions).toBe(
      `0x${V4_ACTIONS.DECREASE_LIQUIDITY.toString(16).padStart(2, "0").repeat(5)}${V4_ACTIONS.TAKE_PAIR.toString(16).padStart(2, "0")}`,
    );
    expect(decoded.legs.map((leg) => leg.tokenId)).toEqual(
      incidentLegs.map(([tokenId]) => tokenId),
    );
  });

  it.each([165, 200])("accepts an adverse %i bps price movement", (bps) => {
    const reference = sqrtPriceAtTick(0),
      liquidity = 10n ** 24n,
      down = satisfies(reference, movedSqrt(reference, bps, -1), -600, 600, liquidity),
      up = satisfies(reference, movedSqrt(reference, bps, 1), -600, 600, liquidity);
    expect(down.pass).toBe(true);
    expect(up.pass).toBe(true);
  });

  it("protects both token orientations at a deterministic adverse 201 bps movement", () => {
    const reference = sqrtPriceAtTick(0),
      liquidity = 10n ** 24n,
      down = satisfies(reference, movedSqrt(reference, 201, -1), -600, 600, liquidity),
      up = satisfies(reference, movedSqrt(reference, 201, 1), -600, 600, liquidity);
    expect(down.actual.token1).toBeLessThan(down.mins.amount1Min);
    expect(up.actual.token0).toBeLessThan(up.mins.amount0Min);
    expect(down.pass).toBe(false);
    expect(up.pass).toBe(false);
  });

  it("handles near-boundary and fully one-sided positions without decimal normalization", () => {
    const liquidity18 = 10n ** 24n,
      liquidity6 = 10n ** 12n,
      nearUpper = satisfies(
        sqrtPriceAtTick(599),
        movedSqrt(sqrtPriceAtTick(599), 165, -1),
        -600,
        600,
        liquidity18,
      ),
      nearLower = satisfies(
        sqrtPriceAtTick(-599),
        movedSqrt(sqrtPriceAtTick(-599), 165, 1),
        -600,
        600,
        liquidity6,
      ),
      above = satisfies(
        sqrtPriceAtTick(900),
        sqrtPriceAtTick(900),
        -600,
        600,
        liquidity18,
      ),
      below = satisfies(
        sqrtPriceAtTick(-900),
        sqrtPriceAtTick(-900),
        -600,
        600,
        liquidity6,
      );
    expect(nearUpper.pass).toBe(true);
    expect(nearLower.pass).toBe(true);
    expect(above.actual.token0).toBe(0n);
    expect(above.mins.amount1Min).toBe(above.actual.token1);
    expect(below.actual.token1).toBe(0n);
    expect(below.mins.amount0Min).toBe(below.actual.token0);
  });
});
