import { describe, expect, it } from "vitest";
import {
  formatV4BidLadderGasCapExceeded,
  v4BidLadderGasProjection,
} from "../apps/cli/src/v4-bid-ladder-live.js";

describe("V4 BID ladder gas transparency", () => {
  const evidence = (capUsd: number) =>
    v4BidLadderGasProjection({
      estimatedGas: 720_496n,
      gasPrice: 1_000_000_000n,
      gasPriceAlreadyBuffered: true,
      nativeUsd: 500,
      nativeUsdSource: "fixture canonical native/USD",
      capUsd,
    });

  it("keeps one gas-limit inflation and strict greater-than cap semantics", () => {
    const baseline = evidence(1);
    expect(baseline.signedGasLimit).toBe(864_595n);
    expect(baseline.gasLimitInflationFactor).toBeCloseTo(1.2, 5);
    expect(evidence(baseline.maximumProjectedFeeUsd).exceedsCap).toBe(false);
    expect(evidence(baseline.maximumProjectedFeeUsd + 0.001).exceedsCap).toBe(false);
    expect(evidence(baseline.maximumProjectedFeeUsd - 0.001).exceedsCap).toBe(true);
  });

  it("renders likely and maximum projected cost separately with exact cap evidence", () => {
    const projection = evidence(0.7), text = formatV4BidLadderGasCapExceeded(projection);
    expect(text).toContain("V4_BID_LADDER_GAS_CAP_EXCEEDED");
    expect(text).toContain("Estimated execution: $0.360");
    expect(text).toContain("Maximum projected fee: $0.432");
    expect(text).toContain("Safety cap: $0.70");
    expect(text).toContain("Gas limit: 864595");
    expect(text).toContain("Gas price: 1.000 gwei");
    expect(text).not.toMatch(/actual receipt/i);
  });

  it("fails only above the exact public $0.70 cap", () => {
    const project=(estimatedGas:bigint)=>v4BidLadderGasProjection({estimatedGas,gasPrice:1_000_000_000n,gasPriceAlreadyBuffered:true,nativeUsd:500,capUsd:0.70});
    expect(project(1_166_666n)).toMatchObject({maximumProjectedFeeUsd:0.6999995,exceedsCap:false});
    expect(project(1_166_667n)).toMatchObject({maximumProjectedFeeUsd:0.7,exceedsCap:false});
    expect(project(1_166_668n).maximumProjectedFeeUsd).toBeCloseTo(0.7000005,10);
    expect(project(1_166_668n).exceedsCap).toBe(true);
  });
});
