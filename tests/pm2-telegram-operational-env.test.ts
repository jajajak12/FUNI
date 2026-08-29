import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("Telegram PM2 operational flags", () => {
  it("loads FUNI configuration while keeping every non-Telegram worker signer-free", () => {
    const target = require.resolve("../infra/pm2/ecosystem.config.cjs");
    delete require.cache[target];
    const config = require(target) as {
      apps: Array<{ name: string; env: Record<string, string>; filter_env: string[] }>;
    };
    const telegram = config.apps.find((app) => app.name === "funi-telegram")!;
    expect(telegram.env).toMatchObject({
      EXECUTION_ENABLED: "false",
      DRY_RUN: "true",
      EMERGENCY_PAUSE: "true",
      FUNI_TELEGRAM_BOT_TOKEN: "",
      FUNI_TELEGRAM_CHAT_ID: "",
    });
    expect(telegram.filter_env).toEqual(["NOVA_", "GMGN_API_KEY"]);
    for (const app of config.apps.filter((item) => item.name !== "funi-telegram")) {
      expect(app.env.LP_PRIVATE_KEY).toBe("");
      expect(app.env.EXECUTION_ENABLED).toBe("false");
    }
  });
});
