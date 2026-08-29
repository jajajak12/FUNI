import type { SqliteLedgerRepository } from "@funi/ledger";

export const BID_LADDER_PLANNED_AUTO_EXPIRY_MS = 30 * 60 * 1000;
export const BID_LADDER_AUTO_EXPIRY_REASON =
  "AUTO_EXPIRED_PLANNED_30M" as const;

// Reuses the canonical BID Ladder listing bound; cleanup remains bounded and
// repeated previews can drain additional oldest-first candidates.
const BID_LADDER_AUTO_EXPIRY_CANDIDATE_LIMIT = 20;
const harmlessIntentStates = new Set(["PREVIEWED", "CANCELLED", "EXPIRED"]);

type LadderRow = Record<string, unknown>;
export type PlannedV4BidLadderCancellationStatus = {
  ladderId: string;
  eligible: boolean;
  idempotent: boolean;
  blockers: string[];
  parent?: LadderRow;
};
export type CancelPlannedV4BidLadderResult =
  | {
      status: "CANCELLED";
      ladderId: string;
      reason: typeof BID_LADDER_AUTO_EXPIRY_REASON;
      revision: number;
    }
  | {
      status: "ALREADY_CANCELLED" | "CONCURRENT_STATE_CHANGED" | "BLOCKED";
      ladderId: string;
      blockers: string[];
    };

function exactJsonReference(value: unknown, ladderId: string) {
  const visit = (item: unknown): boolean => {
    if (item === ladderId) return true;
    if (Array.isArray(item)) return item.some(visit);
    if (item && typeof item === "object")
      return Object.values(item as Record<string, unknown>).some(visit);
    return false;
  };
  try {
    return { exact: visit(JSON.parse(String(value))), ambiguous: false };
  } catch {
    return {
      exact: false,
      ambiguous: String(value ?? "").includes(ladderId),
    };
  }
}

function referencedRows(
  repo: SqliteLedgerRepository,
  sql: string,
  ladderId: string,
  jsonColumns: string[],
) {
  const argumentsForSql = Array.from(
      { length: (sql.match(/\?/g) ?? []).length },
      () => ladderId,
    ),
    rows = repo.db.prepare(sql).all(...argumentsForSql) as LadderRow[];
  return rows.filter((row) =>
    jsonColumns.some((column) => {
      const reference = exactJsonReference(row[column], ladderId);
      return reference.exact || reference.ambiguous;
    }),
  );
}

function activeIsoTimestamp(value: unknown, nowMs: number) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed > nowMs : null;
}

/** Read-only, fail-closed evidence evaluation. Call again inside the write transaction. */
export function plannedV4BidLadderCancellationStatus(
  repo: SqliteLedgerRepository,
  input: { ladderId: string; expectedRevision: number; nowMs: number },
): PlannedV4BidLadderCancellationStatus {
  const parent = repo.loadBidLadder(input.ladderId),
    blockers: string[] = [];
  if (!parent)
    return {
      ladderId: input.ladderId,
      eligible: false,
      idempotent: false,
      blockers: ["V4_BID_LADDER_NOT_FOUND"],
    };
  if (String(parent.status) === "CANCELLED")
    return {
      ladderId: input.ladderId,
      eligible: false,
      idempotent: true,
      blockers: [],
      parent,
    };
  if (String(parent.strategy_version) !== "V4_BID_LADDER_V1")
    blockers.push("V4_BID_LADDER_CANCEL_STRATEGY_INVALID");
  if (String(parent.execution_mode) !== "LIVE")
    blockers.push("V4_BID_LADDER_CANCEL_MODE_INVALID");
  if (String(parent.status) !== "PLANNED")
    blockers.push("V4_BID_LADDER_CANCEL_STATE_NOT_PLANNED");
  if (Number(parent.revision) !== input.expectedRevision)
    blockers.push("V4_BID_LADDER_CANCEL_REVISION_CHANGED");
  const updatedAt = Number(parent.updated_at_ms);
  if (
    !Number.isSafeInteger(updatedAt) ||
    input.nowMs < updatedAt ||
    input.nowMs - updatedAt < BID_LADDER_PLANNED_AUTO_EXPIRY_MS
  )
    blockers.push("V4_BID_LADDER_CANCEL_TTL_NOT_ELAPSED");

  const legs = repo.listBidLadderLegs(input.ladderId);
  if (legs.length !== 5)
    blockers.push("V4_BID_LADDER_CANCEL_LEG_SET_AMBIGUOUS");
  if (legs.some((leg) => String(leg.status) !== "PLANNED"))
    blockers.push("V4_BID_LADDER_CANCEL_LEG_STATE_ADVANCED");
  if (legs.some((leg) => leg.token_id != null))
    blockers.push("V4_BID_LADDER_CANCEL_MINTED_TOKEN_EVIDENCE");
  if (legs.some((leg) => leg.open_batch_id != null || leg.close_batch_id != null))
    blockers.push("V4_BID_LADDER_CANCEL_BATCH_EVIDENCE");

  const journal = repo.db
    .prepare(
      "SELECT status,expected_hash,receipt_json,nonce FROM chain_transaction_journal WHERE workflow_identity=? LIMIT 1",
    )
    .get(input.ladderId) as LadderRow | undefined;
  if (journal)
    blockers.push(
      `V4_BID_LADDER_CANCEL_TRANSACTION_JOURNAL_EVIDENCE:${String(journal.status)}`,
    );

  const transactionIntents = referencedRows(
    repo,
    "SELECT * FROM transaction_intents WHERE id=? OR instr(idempotency_key,?)>0 OR instr(payload_json,?)>0",
    input.ladderId,
    ["id", "idempotency_key", "payload_json"],
  );
  if (
    transactionIntents.some((row) =>
      !["CANCELLED", "EXPIRED"].includes(String(row.state)),
    )
  )
    blockers.push("V4_BID_LADDER_CANCEL_TRANSACTION_INTENT_EVIDENCE");
  const transactionReceipts = referencedRows(
    repo,
    "SELECT * FROM transaction_receipts WHERE intent_id=? OR instr(receipt_json,?)>0",
    input.ladderId,
    ["intent_id", "receipt_json"],
  );
  if (transactionReceipts.length)
    blockers.push("V4_BID_LADDER_CANCEL_TRANSACTION_RECEIPT_EVIDENCE");

  const openIntents = referencedRows(
    repo,
    "SELECT * FROM v4_live_open_intents WHERE id=? OR instr(idempotency_key,?)>0 OR instr(payload_json,?)>0",
    input.ladderId,
    ["id", "idempotency_key", "payload_json"],
  );
  const advancedOpenIntents = openIntents.filter(
    (row) =>
      !harmlessIntentStates.has(String(row.state)) ||
      row.erc20_approval_hash != null ||
      row.permit2_approval_hash != null ||
      row.mint_hash != null ||
      row.token_id != null,
  );
  if (advancedOpenIntents.length)
    blockers.push("V4_BID_LADDER_CANCEL_OPEN_INTENT_ADVANCED");
  const relatedIntentIds = new Set(
    openIntents.map((row) => String(row.id)).concat(input.ladderId),
  );
  for (const intentId of relatedIntentIds) {
    if (
      repo.db
        .prepare("SELECT 1 FROM v4_live_gas WHERE intent_id=? LIMIT 1")
        .get(intentId)
    )
      blockers.push("V4_BID_LADDER_CANCEL_GAS_EVIDENCE");
    if (
      repo.db
        .prepare(
          "SELECT 1 FROM v4_operational_open_receipts WHERE intent_id=? LIMIT 1",
        )
        .get(intentId)
    )
      blockers.push("V4_BID_LADDER_CANCEL_OPEN_RECEIPT_EVIDENCE");
  }

  const v4Positions = referencedRows(
    repo,
    "SELECT * FROM v4_positions WHERE open_intent_id=? OR instr(open_evidence_json,?)>0",
    input.ladderId,
    ["open_intent_id", "open_evidence_json"],
  );
  if (v4Positions.length)
    blockers.push("V4_BID_LADDER_CANCEL_CANONICAL_POSITION_EVIDENCE");
  const legTokenIds = legs.flatMap((leg) =>
    leg.token_id == null ? [] : [String(leg.token_id)],
  );
  if (
    legTokenIds.some((tokenId) =>
      repo.db
        .prepare("SELECT 1 FROM positions WHERE token_id=? LIMIT 1")
        .get(tokenId),
    )
  )
    blockers.push("V4_BID_LADDER_CANCEL_GENERIC_POSITION_EVIDENCE");
  for (const tokenId of legTokenIds) {
    const lifecycle = repo.db
      .prepare("SELECT * FROM v4_lifecycle_intents WHERE token_id=?")
      .all(tokenId) as LadderRow[];
    if (
      lifecycle.some(
        (row) =>
          !harmlessIntentStates.has(String(row.state)) || row.tx_hash != null,
      )
    )
      blockers.push("V4_BID_LADDER_CANCEL_LIFECYCLE_INTENT_ADVANCED");
    if (
      repo.db
        .prepare(
          "SELECT 1 FROM v4_lifecycle_receipts r JOIN v4_lifecycle_intents i ON i.id=r.intent_id WHERE i.token_id=? LIMIT 1",
        )
        .get(tokenId)
    )
      blockers.push("V4_BID_LADDER_CANCEL_LIFECYCLE_RECEIPT_EVIDENCE");
  }

  if (
    repo.db
      .prepare(
        "SELECT 1 FROM chain_exposure_commitments WHERE workflow_id=? AND released_at IS NULL LIMIT 1",
      )
      .get(input.ladderId)
  )
    blockers.push("V4_BID_LADDER_CANCEL_EXPOSURE_COMMITMENT_EVIDENCE");

  const sessionRows = repo.db
    .prepare(
      "SELECT state_json,status,expires_at_ms FROM telegram_flow_sessions WHERE instr(state_json,?)>0",
    )
    .all(input.ladderId) as LadderRow[];
  for (const session of sessionRows) {
    const reference = exactJsonReference(session.state_json, input.ladderId);
    if (reference.ambiguous)
      blockers.push("V4_BID_LADDER_CANCEL_SESSION_IDENTITY_AMBIGUOUS");
    if (
      reference.exact &&
      String(session.status) === "active" &&
      Number(session.expires_at_ms) > input.nowMs
    )
      blockers.push("V4_BID_LADDER_CANCEL_ACTIVE_SESSION");
  }
  const callback = repo.db
    .prepare(
      "SELECT 1 FROM chain_callback_authorizations WHERE workflow_or_position_id=? AND consumed_at_ms IS NULL AND expires_at_ms>? LIMIT 1",
    )
    .get(input.ladderId, input.nowMs);
  if (callback)
    blockers.push("V4_BID_LADDER_CANCEL_ACTIVE_CALLBACK_AUTHORIZATION");
  const confirmations = referencedRows(
    repo,
    "SELECT * FROM confirmation_requests WHERE id=? OR instr(idempotency_key,?)>0 OR instr(payload_json,?)>0",
    input.ladderId,
    ["id", "idempotency_key", "payload_json"],
  );
  for (const confirmation of confirmations) {
    if (String(confirmation.state) !== "AWAITING_CONFIRMATION") continue;
    const active = activeIsoTimestamp(confirmation.expires_at, input.nowMs);
    if (active === null)
      blockers.push("V4_BID_LADDER_CANCEL_CONFIRMATION_EXPIRY_AMBIGUOUS");
    else if (active)
      blockers.push("V4_BID_LADDER_CANCEL_ACTIVE_CONFIRMATION");
  }

  const mutexes = [
    ...(repo.db.prepare("SELECT expires_at FROM nonce_mutex").all() as LadderRow[]),
    ...(repo.db
      .prepare("SELECT expires_at FROM chain_nonce_mutex")
      .all() as LadderRow[]),
  ];
  for (const mutex of mutexes) {
    const active = activeIsoTimestamp(mutex.expires_at, input.nowMs);
    if (active === null)
      blockers.push("V4_BID_LADDER_CANCEL_NONCE_EXPIRY_AMBIGUOUS");
    else if (active)
      blockers.push("V4_BID_LADDER_CANCEL_NONCE_MUTEX_PRESENT");
  }

  return {
    ladderId: input.ladderId,
    eligible: blockers.length === 0,
    idempotent: false,
    blockers: [...new Set(blockers)],
    parent,
  };
}

export function cancelPlannedV4BidLadder(
  repo: SqliteLedgerRepository,
  input: {
    ladderId: string;
    expectedRevision: number;
    reason: typeof BID_LADDER_AUTO_EXPIRY_REASON;
    nowMs: number;
  },
): CancelPlannedV4BidLadderResult {
  const run = repo.db.transaction((): CancelPlannedV4BidLadderResult => {
    const current = repo.loadBidLadder(input.ladderId);
    if (String(current?.status ?? "") === "CANCELLED")
      return {
        status: "ALREADY_CANCELLED",
        ladderId: input.ladderId,
        blockers: [],
      };
    if (
      !current ||
      String(current.status) !== "PLANNED" ||
      Number(current.revision) !== input.expectedRevision
    )
      return {
        status: "CONCURRENT_STATE_CHANGED",
        ladderId: input.ladderId,
        blockers: ["V4_BID_LADDER_CANCEL_CONCURRENT_STATE_CHANGED"],
      };
    const safety = plannedV4BidLadderCancellationStatus(repo, input);
    if (!safety.eligible)
      return {
        status: "BLOCKED",
        ladderId: input.ladderId,
        blockers: safety.blockers,
      };
    const parentChanged = repo.db
      .prepare(
        "UPDATE v4_bid_ladders SET status='CANCELLED',terminal_reason=?,terminal_at_ms=?,updated_at_ms=?,revision=revision+1 WHERE ladder_id=? AND status='PLANNED' AND revision=?",
      )
      .run(
        input.reason,
        input.nowMs,
        input.nowMs,
        input.ladderId,
        input.expectedRevision,
      ).changes;
    if (parentChanged !== 1)
      return {
        status: "CONCURRENT_STATE_CHANGED",
        ladderId: input.ladderId,
        blockers: ["V4_BID_LADDER_CANCEL_CONCURRENT_STATE_CHANGED"],
      };
    const legsChanged = repo.db
      .prepare(
        "UPDATE v4_bid_ladder_legs SET status='CANCELLED',updated_at_ms=? WHERE ladder_id=? AND status='PLANNED' AND token_id IS NULL AND open_batch_id IS NULL AND close_batch_id IS NULL",
      )
      .run(input.nowMs, input.ladderId).changes;
    if (legsChanged !== 5)
      throw new Error("V4_BID_LADDER_CANCEL_LEG_TRANSITION_CONFLICT");
    return {
      status: "CANCELLED",
      ladderId: input.ladderId,
      reason: input.reason,
      revision: input.expectedRevision + 1,
    };
  });
  return run();
}

export function expireAbandonedPlannedV4BidLadders(
  repo: SqliteLedgerRepository,
  input: { nowMs?: number; limit?: number } = {},
) {
  const nowMs = input.nowMs ?? Date.now(),
    limit = input.limit ?? BID_LADDER_AUTO_EXPIRY_CANDIDATE_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > BID_LADDER_AUTO_EXPIRY_CANDIDATE_LIMIT
  )
    throw new Error("V4_BID_LADDER_AUTO_EXPIRY_LIMIT_INVALID");
  const candidates = repo.db
    .prepare(
      "SELECT ladder_id,revision FROM v4_bid_ladders WHERE strategy_version='V4_BID_LADDER_V1' AND execution_mode='LIVE' AND status='PLANNED' AND updated_at_ms<=? ORDER BY updated_at_ms ASC,ladder_id ASC LIMIT ?",
    )
    .all(nowMs - BID_LADDER_PLANNED_AUTO_EXPIRY_MS, limit) as Array<{
    ladder_id: string;
    revision: number;
  }>;
  return candidates.map((candidate) =>
    cancelPlannedV4BidLadder(repo, {
      ladderId: candidate.ladder_id,
      expectedRevision: Number(candidate.revision),
      reason: BID_LADDER_AUTO_EXPIRY_REASON,
      nowMs,
    }),
  );
}
