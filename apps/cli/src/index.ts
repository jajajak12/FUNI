import "dotenv/config";
import { getAddress } from "viem";
import {
  auditRobinhoodV3Deployments,
  diagnoseV3SwapReadiness,
  sanitizeRpcError,
} from "@funi/core";
import {
  backupSqlite,
  migrateSqlite,
  restoreSqliteBackup,
  SQLITE_RUNTIME_BUSY_TIMEOUT_MS,
  SqliteTransientRetryExhaustedError,
  sqliteStatus,
  SqliteLedgerRepository,
  withSqliteTransientRetrySync,
} from "@funi/ledger";
import {
  allowanceAudit,
  dedicatedWallet,
  runtimeEnv as env,
  runtimePaths,
  runtimeRpc as rpc,
  safetyPayload,
  walletPreflight,
  walletStatus,
} from "./runtime.js";
import {
  refreshV4RegistryPool,
  syncV4PoolRegistry,
  v4PoolsForToken,
  v4RegistryStatus,
} from "./v4-registry.js";
import {
  v4DeploymentStatus,
  v4LifecycleAudit,
  v4PnlAudit,
  v4PositionInspect,
  v4PositionReconcile,
} from "./v4-cli.js";
import { runEconomicReconciliationCycle } from "./economic-reconciliation-cycle.js";
import {
  sendFuniMessage,
  sendFuniPhoto,
} from "../../telegram-lp-bot/src/telegram-sender.js";
import { drainClosePnlCardDeliveries } from "../../telegram-lp-bot/src/pnl-card-delivery.js";
import { enqueueTargetedPositionReconciliation } from "./active-position-reconciliation.js";
import { importKnownV4Position } from "./position-adoption.js";

const migrations = "infra/migrations";
const command = process.argv[2] ?? "help";
const argument = process.argv[3];
const output = (value: unknown) =>
  process.stdout.write(
    JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? item.toString() : item, 2) + "\n",
  );
const openRepository = () =>
  new SqliteLedgerRepository(runtimePaths.databasePath, { busyTimeoutMs: 5_000 });
const ensureDatabase = () => migrateSqlite(runtimePaths.databasePath, migrations);

async function main() {
  if (command === "help") {
    return output({
      name: "FUNI",
      commands: [
        "db-migrate", "db-status", "db-backup", "db-restore-test",
        "runtime-status", "bot-preflight", "wallet-status", "wallet-preflight",
        "allowance-audit", "reconcile-all", "v4-pool-registry-status",
        "reconcile-position", "v4-position-import", "v3-swap-readiness",
        "v4-pool-registry-sync", "v4-pools-for-token", "v4-pool-refresh",
        "v4-position-inspect", "v4-position-reconcile", "v4-pnl-audit",
        "v4-position-lifecycle-audit",
      ],
      transactionAuthority: "none in this CLI entrypoint",
    });
  }
  if (command === "db-status")
    return output(sqliteStatus(runtimePaths.databasePath, migrations));
  if (command === "db-migrate") return output(ensureDatabase());
  if (command === "db-backup") {
    ensureDatabase();
    return output(await backupSqlite(
      runtimePaths.databasePath,
      runtimePaths.backupDir,
      env.BACKUP_RETENTION,
    ));
  }
  if (command === "db-restore-test") {
    if (!argument) throw new Error("usage: db-restore-test <backup-path>");
    const target = `${runtimePaths.databasePath}.restore-test`;
    restoreSqliteBackup(argument, target);
    return output({ restored: target, status: sqliteStatus(target, migrations) });
  }

  if (command === "v3-swap-readiness") {
    const result = await diagnoseV3SwapReadiness(rpc);
    output(result);
    if (result.readinessStatus !== "available") process.exitCode = 1;
    return;
  }

  if (command === "reconcile-all") {
    try {
      migrateSqlite(runtimePaths.databasePath, migrations, {
        busyTimeoutMs: SQLITE_RUNTIME_BUSY_TIMEOUT_MS,
      });
      const base = withSqliteTransientRetrySync({
        operation: "reconcile_all",
        run: () => {
          const repository = openRepository();
          try {
            return {
              status: "SUCCESS" as const,
              reconciled: repository.reconcileAll(),
              pendingTransactions: repository.pendingTransactions(),
            };
          } finally { repository.close(); }
        },
      });
      const repository = openRepository();
      try {
        const economic = await runEconomicReconciliationCycle({
          repo: repository,
          rpc,
          owner: dedicatedWallet().address,
          limit: 16,
        });
        const destination = process.env.FUNI_TELEGRAM_CHAT_ID?.trim();
        if (destination) {
          const missing = repository.db.prepare(
            "SELECT e.event_id,e.created_at_ms FROM realized_pnl_events e LEFT JOIN pnl_card_deliveries d ON d.card_kind='CLOSE' AND d.economic_event_id=e.event_id AND d.chat_identity=? WHERE e.event_kind='CLOSE' AND d.delivery_id IS NULL ORDER BY e.economic_final_at_ms LIMIT 8",
          ).all(destination) as Array<{ event_id: string; created_at_ms: number }>;
          for (const event of missing)
            repository.ensurePnlCardDelivery({
              deliveryId: `close:${event.event_id}:${destination}`,
              cardKind: "CLOSE",
              economicEventId: event.event_id,
              chatIdentity: destination,
              metadata: {
                automatic: true,
                reconcileFallbackHandoff: true,
                eventPersistedAtMs: event.created_at_ms,
              },
            });
        }
        const closePnlCardDelivery = destination
          ? (await drainClosePnlCardDeliveries({
              openRepository,
              sendPhoto: sendFuniPhoto,
              sendMessage: sendFuniMessage,
              consumerSource: "RECONCILE_FALLBACK",
              limit: 8,
            })).results
          : [];
        return output({
          ...base,
          economic,
          closePnlCardDelivery,
          mainnetTransactionsSent: 0,
        });
      } finally { repository.close(); }
    } catch (error) {
      if (!(error instanceof SqliteTransientRetryExhaustedError)) throw error;
      process.exitCode = 75;
      return output({
        status: "DEFERRED",
        operation: error.operation,
        attempt: error.attempts,
        delayMs: 0,
        sqliteCode: error.sqliteCode,
        finalDisposition: "DEFERRED",
        reconciled: [],
        mainnetTransactionsSent: 0,
      });
    }
  }

  ensureDatabase();
  if (command === "wallet-status") return output(await walletStatus());
  if (command === "allowance-audit")
    return output(await allowanceAudit(await auditRobinhoodV3Deployments(rpc)));
  if (command === "wallet-preflight" || command === "bot-preflight") {
    const repository = openRepository();
    try {
      const [v3, v4] = await Promise.all([
        auditRobinhoodV3Deployments(rpc),
        v4DeploymentStatus(rpc),
      ]);
      return output({
        paths: runtimePaths,
        deployment: { v3, v4 },
        wallet: await walletPreflight(v3, repository),
        safety: safetyPayload(repository),
        mainnetTransactionsSent: 0,
      });
    } finally { repository.close(); }
  }
  if (command === "runtime-status") {
    const repository = openRepository();
    try {
      return output({
        paths: runtimePaths,
        migration: sqliteStatus(runtimePaths.databasePath, migrations),
        safety: safetyPayload(repository),
        wallet: await walletStatus(),
        pendingTransactions: repository.pendingTransactions(),
        mainnetTransactionsSent: 0,
      });
    } finally { repository.close(); }
  }
  if (command === "reconcile-position") {
    if (!argument || process.argv.length !== 4)
      throw new Error("usage: reconcile-position <v4:<token-id>|live:<token-id>>");
    const match = /^(v4|live):([1-9][0-9]*)$/.exec(argument);
    if (!match) throw new Error("RECONCILE_POSITION_ID_INVALID");
    const repository = openRepository();
    try {
      const safety = repository.safetyState() ?? {};
      if (!safety.manualPause || safety.executionEnabled || !safety.dryRun || !safety.emergencyPause)
        throw new Error("RECONCILE_POSITION_SAFETY_CLOSED_REQUIRED");
      const position = repository.listPositions().find((row) => row.id === argument);
      if (!position) throw new Error("RECONCILE_POSITION_NOT_FOUND");
      const queueStatus = enqueueTargetedPositionReconciliation(repository, {
        positionId: argument,
        tokenId: position.token_id,
        protocol: match[1] === "v4" ? "v4" : "v3",
        reason: "OPERATOR_TARGETED_RECONCILIATION",
      });
      return output({ command, positionId: argument, queueStatus, safetyVerified: true, signingUsed: false, broadcastUsed: false });
    } finally { repository.close(); }
  }
  if (command === "v4-position-import") {
    const tokenInput = argument,
      args = process.argv.slice(4),
      apply = args.includes("--apply"),
      confirmation = args[2];
    if (!tokenInput || !/^[1-9][0-9]*$/.test(tokenInput) ||
      (!apply && args.length) ||
      (apply && (args.length !== 3 || args[0] !== "--apply" || args[1] !== "--confirm" || confirmation !== `v4-position-import:${tokenInput}`)))
      throw new Error("usage: v4-position-import <token-id> [--apply --confirm v4-position-import:<token-id>]");
    const wallet = dedicatedWallet().address;
    if (!wallet) throw new Error("DEDICATED_WALLET_REQUIRED");
    const repository = openRepository();
    try {
      const safety = repository.safetyState() ?? {},
        safetyClosed = Boolean(safety.manualPause && !safety.executionEnabled && safety.dryRun && safety.emergencyPause),
        result = await importKnownV4Position({ repo: repository, rpc, wallet, tokenId: BigInt(tokenInput), apply, confirmed: apply, safetyClosed });
      const queueStatus = apply && (result.status === "ADOPTED" || result.status === "METADATA_REPAIRED") && result.positionId
        ? enqueueTargetedPositionReconciliation(repository, { positionId: result.positionId, tokenId: tokenInput, protocol: "v4", reason: "OPERATOR_KNOWN_EXTERNAL_V4_IMPORT" })
        : "NOT_QUEUED";
      return output({ command, ...result, queueStatus });
    } finally { repository.close(); }
  }
  if (command === "v4-pool-registry-status") {
    const repository = openRepository();
    try { return output(await v4RegistryStatus({ repo: repository, rpc })); }
    finally { repository.close(); }
  }
  if (command === "v4-pool-registry-sync") {
    const repository = openRepository();
    try {
      return output(await syncV4PoolRegistry({
        repo: repository,
        rpc,
        toBlock: argument ? BigInt(argument) : undefined,
      }));
    } finally { repository.close(); }
  }
  if (command === "v4-pools-for-token") {
    if (!argument) throw new Error("usage: v4-pools-for-token <token-address>");
    const repository = openRepository();
    try {
      return output(await v4PoolsForToken({
        repo: repository,
        rpc,
        token: getAddress(argument),
      }));
    } finally { repository.close(); }
  }
  if (command === "v4-pool-refresh") {
    if (!argument) throw new Error("usage: v4-pool-refresh <pool-id>");
    const repository = openRepository();
    try {
      return output(await refreshV4RegistryPool({
        repo: repository,
        rpc,
        poolId: argument,
      }));
    } finally { repository.close(); }
  }
  if ([
    "v4-position-inspect", "v4-position-reconcile", "v4-pnl-audit",
    "v4-position-lifecycle-audit",
  ].includes(command)) {
    if (!argument) throw new Error(`usage: ${command} <token-id>`);
    const repository = openRepository();
    const tokenId = BigInt(argument);
    try {
      if (command === "v4-position-inspect")
        return output(await v4PositionInspect(rpc, repository, tokenId));
      if (command === "v4-position-reconcile")
        return output(await v4PositionReconcile(rpc, repository, tokenId));
      if (command === "v4-pnl-audit") return output(v4PnlAudit(repository, tokenId));
      return output(v4LifecycleAudit(repository, tokenId));
    } finally { repository.close(); }
  }
  throw new Error(`unknown FUNI command: ${command}`);
}

void main().catch((error) => {
  process.stderr.write(JSON.stringify({
    level: "error",
    message: sanitizeRpcError(error, { stage: "funi_cli", method: command }),
  }) + "\n");
  process.exitCode = 1;
});
