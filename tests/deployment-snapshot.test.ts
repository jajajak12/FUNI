import { describe, expect, it } from "vitest";
import {
  auditRobinhoodV3PinnedTestSnapshot,
  comparePinnedDeploymentSnapshot,
  deploymentSnapshotChecksum,
  loadDeploymentSnapshot,
  PINNED_VERIFIED_DEPLOYMENT_SNAPSHOT,
  type FallbackRpc,
  type ObservedDeploymentSnapshot,
} from "@funi/core";

async function awaitGuardedHookOrEarlyExit<
  T extends { status?: string; reason?: unknown },
>(
  hook: Promise<void>,
  execution: Promise<T>,
  phase: string,
  timeoutMs = 60_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const outcome = await Promise.race([
    hook.then(() => ({ kind: "hook" }) as const),
    execution.then(
      (value) => ({ kind: "execution" as const, value }),
      (error) => ({ kind: "execution-error" as const, error }),
    ),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.kind === "hook") return;
  if (outcome.kind === "execution")
    throw new Error(
      `${phase}_NOT_REACHED: executor terminated with ${outcome.value.status ?? "unknown"}: ${String(outcome.value.reason ?? "no reason")}`,
    );
  if (outcome.kind === "execution-error") throw outcome.error;
  throw new Error(`${phase}_TIMEOUT_AFTER_${timeoutMs}MS`);
}

describe("pinned deployment snapshot", () => {
  it("has a stable checksum and required historical pin", () => {
    const snapshot = loadDeploymentSnapshot();
    const { checksum, ...body } = snapshot;
    expect(checksum).toBe(deploymentSnapshotChecksum(body));
    expect(snapshot.chainId).toBe(4663);
    expect(snapshot.verificationBlock).toBe("16574811");
    expect(snapshot.contracts.factory.runtimeCodeHash).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
  });
  it("detects a code-hash mutation before any RPC work can begin", () => {
    const snapshot = loadDeploymentSnapshot();
    const { checksum, ...body } = snapshot;
    const altered = {
      ...body,
      contracts: {
        ...body.contracts,
        factory: {
          ...body.contracts.factory,
          runtimeCodeHash: ("0x" + "00".repeat(32)) as `0x${string}`,
        },
      },
    };
    expect(deploymentSnapshotChecksum(altered)).not.toBe(checksum);
  });
  it("accepts exact chain, addresses, sizes, and code hashes", () => {
    const snapshot = loadDeploymentSnapshot(),
      observed: ObservedDeploymentSnapshot = {
        chainId: snapshot.chainId,
        blockNumber: BigInt(snapshot.verificationBlock),
        contracts: Object.fromEntries(
          Object.entries(snapshot.contracts).map(([name, value]) => [
            name,
            { ...value },
          ]),
        ),
      };
    expect(comparePinnedDeploymentSnapshot(snapshot, observed)).toEqual([]);
  });
  it("rejects wrong chain, changed address, and changed code hash", () => {
    const snapshot = loadDeploymentSnapshot(),
      base: ObservedDeploymentSnapshot = {
        chainId: snapshot.chainId,
        blockNumber: BigInt(snapshot.verificationBlock),
        contracts: Object.fromEntries(
          Object.entries(snapshot.contracts).map(([name, value]) => [
            name,
            { ...value },
          ]),
        ),
      };
    expect(
      comparePinnedDeploymentSnapshot(snapshot, { ...base, chainId: 1 }).join(
        "\n",
      ),
    ).toContain("chainId");
    expect(
      comparePinnedDeploymentSnapshot(snapshot, {
        ...base,
        contracts: {
          ...base.contracts,
          factory: {
            ...base.contracts.factory!,
            address: "0x0000000000000000000000000000000000000001",
          },
        },
      }).join("\n"),
    ).toContain("address expected");
    expect(
      comparePinnedDeploymentSnapshot(snapshot, {
        ...base,
        contracts: {
          ...base.contracts,
          factory: {
            ...base.contracts.factory!,
            runtimeCodeHash: ("0x" + "00".repeat(32)) as `0x${string}`,
          },
        },
      }).join("\n"),
    ).toContain("expected 0x");
  });
  it("rejects snapshot mode on public RPC and for production execution", async () => {
    const publicRpc = {
        config: { rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"] },
      } as unknown as FallbackRpc,
      localRpc = {
        config: { rpcUrls: ["http://127.0.0.1:8545"] },
      } as unknown as FallbackRpc;
    expect(
      (
        await auditRobinhoodV3PinnedTestSnapshot(publicRpc, {
          mode: PINNED_VERIFIED_DEPLOYMENT_SNAPSHOT,
          rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
          productionExecutionEnabled: false,
        })
      ).status,
    ).toBe("unavailable");
    const production = await auditRobinhoodV3PinnedTestSnapshot(localRpc, {
      mode: PINNED_VERIFIED_DEPLOYMENT_SNAPSHOT,
      rpcUrl: "http://127.0.0.1:8545",
      productionExecutionEnabled: true,
    });
    expect(production.status).toBe("unavailable");
    if (production.status === "unavailable")
      expect(production.reason).toBe(
        "PINNED_SNAPSHOT_REJECTED_FOR_PRODUCTION_EXECUTION",
      );
  });
  it("cancels the hook wait when execution terminates before approval", async () => {
    const never = new Promise<void>(() => {}),
      started = Date.now();
    await expect(
      awaitGuardedHookOrEarlyExit(
        never,
        Promise.resolve({
          status: "FAILED",
          reason: "deployment verification failed",
        }),
        "AFTER_APPROVAL_CONFIRMED",
        250,
      ),
    ).rejects.toThrow("AFTER_APPROVAL_CONFIRMED_NOT_REACHED");
    expect(Date.now() - started).toBeLessThan(200);
  });
  it("bounds a hook that is never reached", async () => {
    await expect(
      awaitGuardedHookOrEarlyExit(
        new Promise<void>(() => {}),
        new Promise<{ status: string }>(() => {}),
        "AFTER_APPROVAL_CONFIRMED",
        20,
      ),
    ).rejects.toThrow("TIMEOUT_AFTER_20MS");
  });
});
