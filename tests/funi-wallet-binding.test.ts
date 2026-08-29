import { describe, expect, it } from "vitest";
import { resolveCanonicalFuniWallet } from "../apps/shared/funi-wallet.js";

const canonical = "0x00000000000000000000000000000000000000AA";
describe("canonical FUNI wallet binding", () => {
  it("resolves Telegram execution and state-cache ownership identically", () => {
    expect(resolveCanonicalFuniWallet({ WALLET_ADDRESS: canonical })).toBe(
      resolveCanonicalFuniWallet({ WALLET_ADDRESS: canonical }),
    );
  });
  it("rejects a stale dedicated-wallet override before ownership mutation", () => {
    expect(() =>
      resolveCanonicalFuniWallet({
        WALLET_ADDRESS: canonical,
        DEDICATED_WALLET_ADDRESS: "0x00000000000000000000000000000000000000BB",
      }),
    ).toThrow(/FUNI_CANONICAL_WALLET_MISMATCH/);
  });
  it("requires a configured identity and signer to agree", () => {
    expect(() =>
      resolveCanonicalFuniWallet(
        { WALLET_ADDRESS: canonical },
        "0x00000000000000000000000000000000000000BB",
      ),
    ).toThrow(/FUNI_CANONICAL_WALLET_MISMATCH/);
  });
});
