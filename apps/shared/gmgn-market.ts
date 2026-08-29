import { spawn } from "node:child_process";
import { getAddress, type Address } from "viem";
import { sanitizeSensitiveText } from "@funi/core";
import { funiGmgnChildEnv } from "./funi-gmgn-credential.js";

export type GmgnTokenObservation = {
  tokenAddress: Address;
  marketCapUsd?: number;
};

function positiveNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Normalize only the token identity and current market-cap fields needed by manual previews. */
export function normalizeGmgnObservation(raw: unknown): GmgnTokenObservation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("GMGN_TOKEN_INFO_INVALID");
  const row = raw as Record<string, unknown>;
  return {
    tokenAddress: getAddress(String(row.address)),
    marketCapUsd: positiveNumber(row.usd_market_cap ?? row.market_cap),
  };
}

/** Run one bounded read-only gmgn-cli request and return its JSON response. */
export async function gmgnCliJson(
  args: string[],
  timeoutMs = 15_000,
  envFilePath?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("gmgn-cli", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: funiGmgnChildEnv(process.env, envFilePath),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      work();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() =>
        reject(
          Object.assign(new Error("GMGN_CLI_TIMEOUT"), { code: "ETIMEDOUT" }),
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 2_000_000) {
        child.kill("SIGTERM");
        finish(() => reject(new Error("GMGN_CLI_RESPONSE_TOO_LARGE")));
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += String(chunk);
    });
    child.on("error", (error) =>
      finish(() =>
        reject(
          Object.assign(new Error("GMGN_CLI_UNAVAILABLE"), {
            code: "CONFIG_INVALID",
            cause: error,
          }),
        ),
      ),
    );
    child.on("close", (code) =>
      finish(() => {
        if (code !== 0) {
          const safe = sanitizeSensitiveText(stderr.trim()).slice(0, 500);
          if (/\b429\b|rate[_ -]?limit/i.test(safe))
            return reject(
              Object.assign(
                new Error(
                  `GMGN_PROVIDER_RATE_LIMITED${safe ? `: ${safe}` : ""}`,
                ),
                {
                  code: "HTTP_429",
                  status: 429,
                },
              ),
            );
          const network =
            /\b(ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\b/i
              .exec(safe)?.[1]
              ?.toUpperCase();
          return reject(
            Object.assign(
              new Error(`GMGN_CLI_FAILED${safe ? `: ${safe}` : ""}`),
              {
                code: network ?? `GMGN_CLI_EXIT_${code}`,
              },
            ),
          );
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("GMGN_CLI_INVALID_JSON"));
        }
      }),
    );
  });
}
