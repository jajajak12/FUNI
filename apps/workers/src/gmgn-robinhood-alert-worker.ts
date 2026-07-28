import { setTimeout as sleep } from 'node:timers/promises';
import {
  migrateSqlite,
  productionDatabasePaths,
  SqliteLedgerRepository,
} from '@robin/ledger';
import {
  DEFAULT_RE_ALERT_INTERVAL_MS,
  RE_ALERT_INTERVAL_ENV,
  decideRealert,
  enrichLocalPools,
  extractTrendingRank,
  formatGmgnAlert,
  formatGmgnGroupAlert,
  gmgnAlertButtons,
  gmgnCliJson,
  loadNaturalDedupe,
  normalizeTrendingObservation,
  persistGmgnObservation,
  recordNaturalAlert,
} from './gmgn-robinhood-alert.js';
import { emitRobinSenderTelemetry } from '../../telegram-lp-bot/src/telegram-sender.js';
import { assertRobinCredentialIsolation } from '../../shared/credential-isolation.js';

// PM2 injects an explicit allowlist.  Never load .env here.
assertRobinCredentialIsolation(process.env);
for (const key of Object.keys(process.env))
  if (/(PRIVATE_KEY|SIGNER|MNEMONIC|WALLET|SEED)/i.test(key))
    delete process.env[key];

const paths = productionDatabasePaths({ dataDir: process.env.DATA_DIR, databasePath: process.env.DATABASE_PATH });
const interval = Math.max(100_000, Number(process.env.GMGN_ALERT_INTERVAL_MS ?? 100_000));
const reAlertIntervalMs = Math.max(60_000, Number(process.env[RE_ALERT_INTERVAL_ENV] ?? DEFAULT_RE_ALERT_INTERVAL_MS));
const log = (event: string, data: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ event, ...data, at: new Date().toISOString() }) + '\n');

const retry = async <T>(work: () => Promise<T>): Promise<T> => {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await work();
    } catch (error) {
      failure = error;
      if (attempt < 2) await sleep(250 * 2 ** attempt + Math.floor(Math.random() * 100));
    }
  }
  throw failure;
};

async function deliver(chatId: string, text: string, category: string, buttons:Array<Array<{text:string;url?:string;callback_data?:string}>>): Promise<boolean> {
  const token = process.env.ROBIN_TELEGRAM_BOT_TOKEN;
  if (!token) {
    emitRobinSenderTelemetry({
      delivered: false,
      category,
      destination: chatId,
      failureReason: 'PROJECT_CREDENTIAL_OR_DESTINATION_MISSING',
    });
    return false;
  }
  try {
    return await retry(async () => {
      const payload: Record<string, unknown> = { chat_id: chatId, text };
      payload.reply_markup = { inline_keyboard: buttons };
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null) as { result?: { message_id?: number } } | null;
      if (!response.ok) throw new Error('GMGN_ALERT_DELIVERY_FAILED');
      emitRobinSenderTelemetry({
        delivered: true,
        category,
        destination: chatId,
        messageId: body?.result?.message_id ?? null,
      });
      return true;
    });
  } catch (error) {
    emitRobinSenderTelemetry({
      delivered: false,
      category,
      destination: chatId,
      failureReason: 'TRANSPORT_ERROR',
    });
    throw error;
  }
}

async function deliverDestination(
  db: SqliteLedgerRepository,
  token: string,
  destinationType: 'private' | 'group',
  chatId: string | undefined,
  text: string,
  buttons:Array<Array<{text:string;url?:string;callback_data?:string}>>,
): Promise<'sent' | 'dedup' | 'failed' | 'skipped'> {
  if (process.env.GMGN_ALERT_TELEGRAM_DELIVERY_ENABLED !== 'true' || !chatId) return 'skipped';
  // Destination-level dedup: per (token, snapshot-hash, destination).  The
  // snapshot-hash is unique per delivery event, so this guards against
  // re-running the same alert event twice.  Cross-event dedup lives in
  // gmgn_robinhood_alert_dedupe (loaded above) and is enforced BEFORE we
  // call this function.
  const prior = db.db
    .prepare(
      `SELECT status FROM gmgn_robinhood_alert_deliveries
        WHERE token_address=? AND admission_snapshot_hash=? AND destination_type=?`,
    )
    .get(token, lastDeliveredHash(db, token, destinationType) ?? '__none__', destinationType) as { status: string } | undefined;
  if (prior?.status === 'SENT') return 'dedup';
  const at = Date.now();
  try {
    await deliver(chatId, text, `gmgn_alert_${destinationType}`, buttons);
    db.db
      .prepare(
        `INSERT INTO gmgn_robinhood_alert_deliveries
          (token_address, admission_snapshot_hash, destination_type, status, attempts, delivered_at_ms, last_attempt_at_ms)
          VALUES (?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(token_address, admission_snapshot_hash, destination_type) DO UPDATE SET
            status='SENT',
            attempts = gmgn_robinhood_alert_deliveries.attempts + 1,
            delivered_at_ms = excluded.delivered_at_ms,
            last_attempt_at_ms = excluded.last_attempt_at_ms`,
      )
      .run(token, snapshotForDelivery(db, token), destinationType, 'SENT', at, at);
    return 'sent';
  } catch {
    db.db
      .prepare(
        `INSERT INTO gmgn_robinhood_alert_deliveries
          (token_address, admission_snapshot_hash, destination_type, status, attempts, last_attempt_at_ms)
          VALUES (?, ?, ?, ?, 1, ?)
          ON CONFLICT(token_address, admission_snapshot_hash, destination_type) DO UPDATE SET
            status='FAILED',
            attempts = gmgn_robinhood_alert_deliveries.attempts + 1,
            last_attempt_at_ms = excluded.last_attempt_at_ms`,
      )
      .run(token, snapshotForDelivery(db, token), destinationType, 'FAILED', at);
    return 'failed';
  }
}

// We do not store snapshot-hashes in gmgn_robinhood_alert_deliveries any more
// because the natural key is (token_address, natural_key).  We synthesize a
// per-event hash from the natural key + destination so the unique constraint
// is still meaningful without re-deriving the full metric snapshot.
function snapshotForDelivery(db: SqliteLedgerRepository, token: string): string {
  const row = loadNaturalDedupe(db, token as `0x${string}`);
  return row ? row.natural_key : `nokey:${token.toLowerCase()}`;
}
function lastDeliveredHash(db: SqliteLedgerRepository, token: string, destinationType: 'private' | 'group'): string | null {
  const r = db.db
    .prepare(
      `SELECT admission_snapshot_hash AS h FROM gmgn_robinhood_alert_deliveries
        WHERE token_address=? AND destination_type=? AND status='SENT'
        ORDER BY delivered_at_ms DESC LIMIT 1`,
    )
    .get(token, destinationType) as { h: string } | undefined;
  return r?.h ?? null;
}

type Candidate = { address: string; row: Record<string, unknown> };

/**
 * Trending is the sole natural-alert discovery source.  The CLI envelope is
 * `{"code":0,"data":{"rank":[...]}}`.  We discard `pump`, `new_creation`,
 * `completed`, and `near_completion` entirely.
 */
async function fetchTrendingCandidates(): Promise<Candidate[]> {
  const parsed = await retry(() => gmgnCliJson([
    'market', 'trending',
    '--chain', 'robinhood',
    '--interval', '1h',
    '--limit', '80',
    '--raw',
  ]));
  const rank = extractTrendingRank(parsed);
  const out: Candidate[] = [];
  for (const raw of rank) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const address = String(row.address ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
    out.push({ address, row });
  }
  return out;
}

/**
 * Hydration priority (1..4):
 *   1. never-hydrated newly discovered tokens
 *   2. previously rejected whose snapshot-hash drifted materially
 *   3. stale admitted candidates
 *   4. recently-admitted repeated ones LAST
 *
 * Cap 20 per cycle; group-4 capped to 1 slot to prevent a single admitted
 * token from consuming the entire budget.
 */
function prioritize(repo: SqliteLedgerRepository, candidates: Candidate[], now: number, maxBudget = 20): Candidate[] {
  type Tagged = Candidate & { group: 0 | 1 | 2 | 3; age: number; snapshotHash: string };
  const q = repo.db.prepare(
    `SELECT last_hydrated_at_ms, last_admission_status, last_snapshot_hash
       FROM gmgn_robinhood_seen_tokens WHERE token_address=?`,
  );
  const snap = (row: Record<string, unknown>): string =>
    `${row.address}|${row.market_cap}|${row.liquidity}|${row.volume}|${row.holder_count}|${row.gas_fee}`;

  const tagged: Tagged[] = candidates.map((c) => {
    const seen = q.get(c.address) as
      | { last_hydrated_at_ms: number | null; last_admission_status: string | null; last_snapshot_hash: string | null }
      | undefined;
    const hydrated = seen?.last_hydrated_at_ms;
    const age = hydrated === null || hydrated === undefined ? Number.POSITIVE_INFINITY : now - hydrated;
    const newHash = snap(c.row);
    const status = seen?.last_admission_status ?? null;
    const oldHash = seen?.last_snapshot_hash ?? null;
    const STALE_MS = reAlertIntervalMs;
    let group: 0 | 1 | 2 | 3;
    if (!seen) group = 0;
    else if (status === 'REJECT' && oldHash !== null && oldHash !== newHash) group = 1;
    else if (age >= STALE_MS) group = 2;
    else group = 3;
    return { ...c, group, age, snapshotHash: newHash };
  });

  tagged.sort((a, b) => a.group - b.group || b.age - a.age);

  // Enforce the "group 4 capped to 1" rule before applying the budget cap.
  const group4 = tagged.filter((t) => t.group === 3);
  const rest = tagged.filter((t) => t.group !== 3);
  const group4Slot = group4.slice(0, 1);
  const budget = maxBudget;
  const combined = [...rest, ...group4Slot];
  return combined.slice(0, budget);
}

export async function runCycle(): Promise<{
  discovered: number;
  hydrated: number;
  pass: number;
  reject: number;
  reAlertSuppressed: number;
  naturalAlerts: number;
  deliveredPrivate: number;
  deliveredGroup: number;
  deliveryFailedPrivate: number;
  deliveryFailedGroup: number;
  mainnetTransactionsSent: 0;
}> {
  const started = Date.now();
  const db = new SqliteLedgerRepository(paths.databasePath);
  const summary = {
    discovered: 0,
    hydrated: 0,
    pass: 0,
    reject: 0,
    reAlertSuppressed: 0,
    naturalAlerts: 0,
    deliveredPrivate: 0,
    deliveredGroup: 0,
    deliveryFailedPrivate: 0,
    deliveryFailedGroup: 0,
    mainnetTransactionsSent: 0 as const,
  };
  try {
    const candidates = await fetchTrendingCandidates();
    summary.discovered = candidates.length;

    // Record "seen" for every candidate (cheap, dedup-safe via PK).
    const seen = db.db.prepare(
      `INSERT INTO gmgn_robinhood_seen_tokens(token_address, first_seen_at_ms, last_seen_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(token_address) DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms`,
    );
    for (const c of candidates) seen.run(c.address, started, started);

    const selected = prioritize(db, candidates, started);
    const updateSeen = db.db.prepare(
      `UPDATE gmgn_robinhood_seen_tokens
         SET last_hydrated_at_ms=?, last_admission_status=?, last_snapshot_hash=?
         WHERE token_address=?`,
    );

    for (const candidate of selected) {
      try {
        const observation = normalizeTrendingObservation(candidate.row, Date.now());
        persistGmgnObservation(db, observation);
        summary.hydrated++;
        const snapHash = `${candidate.address}|${candidate.row.market_cap}|${candidate.row.liquidity}|${candidate.row.volume}|${candidate.row.holder_count}|${candidate.row.gas_fee}`;
        updateSeen.run(observation.observedAt, observation.admission.status, snapHash, candidate.address);
        if (observation.admission.status === 'REJECT') {
          summary.reject++;
          continue;
        }
        summary.pass++;

        // Natural-alert dedup.  This is the gate that prevents the GME
        // repeat problem: re-alert only if BOTH the cooldown has elapsed
        // AND a material metric change occurred.
        const previous = loadNaturalDedupe(db, observation.tokenAddress);
        const decision = decideRealert({
          now: observation.observedAt,
          previous,
          candidate: {
            marketCapUsd: observation.marketCapUsd,
            liquidityUsd: observation.liquidityUsd,
            volume1hUsd: observation.volume1hUsd,
            totalFeeEth: observation.totalFeeEth,
          },
          reAlertIntervalMs,
        });
        if (!decision.eligible) {
          summary.reAlertSuppressed++;
          continue;
        }
        summary.naturalAlerts++;

        const pools = enrichLocalPools(db, observation.tokenAddress);
        const [privateResult, groupResult] = await Promise.all([
          deliverDestination(
            db,
            observation.tokenAddress,
            'private',
            process.env.GMGN_ALERT_TELEGRAM_CHAT_ID,
            formatGmgnAlert(observation, pools),
            gmgnAlertButtons('private',observation.tokenAddress,pools.length),
          ),
          deliverDestination(
            db,
            observation.tokenAddress,
            'group',
            process.env.GMGN_ALERT_GROUP_CHAT_ID,
            formatGmgnGroupAlert(observation, pools),
            gmgnAlertButtons('group',observation.tokenAddress,pools.length),
          ),
        ]);
        // Only record the natural-alert dedup row once BOTH delivery attempts
        // have completed (so a delivery failure is itself a reason to re-attempt
        // within the same cycle, not silently swallowed by dedup).
        const bothTerminal = (r: typeof privateResult): boolean => r === 'sent' || r === 'failed';
        if (bothTerminal(privateResult) && bothTerminal(groupResult)) {
          recordNaturalAlert(db, observation.tokenAddress, observation, observation.observedAt);
        }
        if (privateResult === 'sent') summary.deliveredPrivate++;
        if (groupResult === 'sent') summary.deliveredGroup++;
        if (privateResult === 'failed') summary.deliveryFailedPrivate++;
        if (groupResult === 'failed') summary.deliveryFailedGroup++;
      } catch (err) {
        summary.reject++;
      }
    }

    db.db
      .prepare(
        `INSERT INTO gmgn_robinhood_provider_health(
           observed_at_ms, status, duration_ms, row_count, hydrated_count, rate_limited, error_code, source_version, details_json
         ) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        Date.now(),
        'OK',
        Date.now() - started,
        summary.discovered,
        summary.hydrated,
        0,
        null,
        'gmgn-cli-robinhood-token-info-v1',
        JSON.stringify({
          source: 'gmgn-cli market trending --chain robinhood --interval 1h',
          selected: selected.length,
          pagination: 'fixed top list; CLI exposes no cursor',
          reAlertIntervalMs,
          materialChange: RE_ALERT_MATERIAL_CHANGE_SNAPSHOT(),
        }),
      );
    log('gmgn_alert_cycle', {
      ...summary,
      durationMs: Date.now() - started,
      deliveryConfigured: process.env.GMGN_ALERT_TELEGRAM_DELIVERY_ENABLED === 'true',
    });
    return summary;
  } catch (error) {
    db.db
      .prepare(
        `INSERT INTO gmgn_robinhood_provider_health(
           observed_at_ms, status, duration_ms, row_count, hydrated_count, rate_limited, error_code, source_version, details_json
         ) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        Date.now(),
        'DEGRADED',
        Date.now() - started,
        summary.discovered,
        summary.hydrated,
        0,
        'GMGN_PROVIDER_FAILURE',
        'gmgn-cli-robinhood-token-info-v1',
        '{}',
      );
    log('gmgn_alert_provider_degraded', {
      durationMs: Date.now() - started,
      mainnetTransactionsSent: 0,
    });
    return summary;
  } finally {
    db.close();
  }
}

function RE_ALERT_MATERIAL_CHANGE_SNAPSHOT() {
  return { marketCapUsd: 0.20, liquidityUsd: 0.20, volume1hUsd: 0.30, totalFeeEth: 0.25 };
}

async function main(): Promise<void> {
  if (process.env.GMGN_ALERT_ENABLED !== 'true') {
    log('gmgn_alert_disabled', { mainnetTransactionsSent: 0 });
    return;
  }
  migrateSqlite(paths.databasePath, 'infra/migrations');
  let stopping = false;
  let running = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  while (!stopping) {
    if (!running) {
      running = true;
      try {
        await runCycle();
      } finally {
        running = false;
      }
    }
    if (!stopping) await sleep(interval);
  }
}

main().catch(() => {
  log('gmgn_alert_worker_failed', { mainnetTransactionsSent: 0 });
  process.exitCode = 1;
});
