import type { SqliteLedgerRepository } from "@funi/ledger";

export type V4BidLadderTerminalProvenance =
  | "FUNI_CLOSE_CONFIRMED"
  | "EXTERNAL_OR_UNKNOWN_TERMINAL";

const CHAIN_ID = 4663;

function successfulConfirmedClose(repo: SqliteLedgerRepository, ladderId: string) {
  const row = repo.db.prepare(
    "SELECT * FROM chain_transaction_journal WHERE chain_id=? AND protocol='uniswap_v4' AND workflow_identity=? AND semantic_stage='CLOSE_BATCH' AND status='CONFIRMED' ORDER BY attempt DESC LIMIT 1",
  ).get(CHAIN_ID, ladderId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  try {
    if (JSON.parse(String(row.receipt_json ?? "{}")).status !== "success") return undefined;
  } catch { return undefined; }
  return row;
}

/** Canonical, transaction-scoped convergence. This function never reads RPC,
 * creates economic receipts, or writes accounting amounts. */
export function convergeTerminalV4BidLadder(input: {
  repo: SqliteLedgerRepository;
  ladderId: string;
  provenance?: V4BidLadderTerminalProvenance;
  nowMs?: number;
}) {
  const run = input.repo.db.transaction(() => {
    const nowMs = input.nowMs ?? Date.now(), parent = input.repo.loadBidLadder(input.ladderId);
    if (!parent) return { status: "NOT_A_LADDER" as const, writes: 0 };
    const legs = input.repo.listBidLadderLegs(input.ladderId), close = successfulConfirmedClose(input.repo, input.ladderId);
    if (legs.length !== 5 || legs.some(leg => !leg.token_id)) throw new Error("V4_BID_LADDER_TERMINAL_IDENTITY_INCOMPLETE");
    const provenance = input.provenance ?? (close ? "FUNI_CLOSE_CONFIRMED" : "EXTERNAL_OR_UNKNOWN_TERMINAL");
    if (provenance === "FUNI_CLOSE_CONFIRMED" && !close) throw new Error("V4_BID_LADDER_TERMINAL_FUNI_RECEIPT_REQUIRED");
    if (provenance === "EXTERNAL_OR_UNKNOWN_TERMINAL" && close) throw new Error("V4_BID_LADDER_TERMINAL_PROVENANCE_CONFLICT");
    const unresolved = input.repo.db.prepare(
      "SELECT COUNT(*) count FROM chain_transaction_journal WHERE chain_id=? AND workflow_identity=? AND status IN ('PREPARED','SUBMITTED')",
    ).get(CHAIN_ID, input.ladderId) as { count: number };
    if (unresolved.count) throw new Error("V4_BID_LADDER_TERMINAL_TRANSACTION_IN_PROGRESS");
    if (provenance === "EXTERNAL_OR_UNKNOWN_TERMINAL") for (const leg of legs) {
      const truth = input.repo.db.prepare(
        "SELECT owner_status,liquidity_raw,claimable0_raw,claimable1_raw,terminal_reason,fresh_until_ms,last_error FROM active_position_reconciliations WHERE position_id=?",
      ).get(`v4:${String(leg.token_id)}`) as Record<string, unknown> | undefined;
      if (!truth || truth.owner_status !== "VERIFIED_OWNED" || truth.liquidity_raw !== "0" || truth.claimable0_raw !== "0" || truth.claimable1_raw !== "0" || truth.terminal_reason !== "CLOSED_EMPTY" || Number(truth.fresh_until_ms) < nowMs || truth.last_error)
        throw new Error("V4_BID_LADDER_TERMINAL_EVIDENCE_INCOMPLETE_OR_STALE");
    }
    let writes = 0;
    for (const leg of legs) {
      const tokenId = String(leg.token_id), positionId = `v4:${tokenId}`, v4 = input.repo.v4Position(tokenId);
      if (!v4 || String(v4.open_intent_id) !== input.ladderId) throw new Error("V4_BID_LADDER_TERMINAL_TOKEN_LINEAGE_MISMATCH");
      writes += input.repo.db.prepare("UPDATE positions SET status='closed' WHERE id=? AND status<>'closed'").run(positionId).changes;
      writes += input.repo.db.prepare("UPDATE v4_positions SET status='closed',liquidity_raw='0',updated_at=? WHERE token_id=? AND (status<>'closed' OR liquidity_raw<>'0')").run(new Date(nowMs).toISOString(), tokenId).changes;
      if (provenance === "FUNI_CLOSE_CONFIRMED") writes += input.repo.db.prepare(
        "UPDATE active_position_reconciliations SET owner_status='VERIFIED_OWNED',liquidity_raw='0',claimable0_raw='0',claimable1_raw='0',terminal_reason='CLOSED_EMPTY',confirmed_active=0,contributes_equity=0,checked_at_ms=max(checked_at_ms,?),fresh_until_ms=max(fresh_until_ms,?),last_error=NULL WHERE position_id=? AND (owner_status<>'VERIFIED_OWNED' OR liquidity_raw<>'0' OR COALESCE(claimable0_raw,'')<>'0' OR COALESCE(claimable1_raw,'')<>'0' OR COALESCE(terminal_reason,'')<>'CLOSED_EMPTY' OR confirmed_active<>0 OR contributes_equity<>0 OR last_error IS NOT NULL)",
      ).run(nowMs, nowMs, positionId).changes;
    }
    writes += input.repo.db.prepare("UPDATE v4_bid_ladder_legs SET status='CLOSED',close_batch_id=CASE WHEN ? IS NULL THEN close_batch_id ELSE COALESCE(close_batch_id,?) END,updated_at_ms=? WHERE ladder_id=? AND status='OPEN'")
      .run(close?.journal_id ?? null, close?.journal_id ?? null, nowMs, input.ladderId).changes;
    writes += input.repo.db.prepare("UPDATE v4_bid_ladders SET status='CLOSED',close_provenance=?,updated_at_ms=?,revision=revision+1 WHERE ladder_id=? AND status='OPEN'")
      .run(provenance === "FUNI_CLOSE_CONFIRMED" ? "FUNI_EXECUTED" : "UNKNOWN_EXTERNAL", nowMs, input.ladderId).changes;
    const reset = input.repo.loadBidLadderUsdReset(input.ladderId);
    if (reset && provenance === "EXTERNAL_OR_UNKNOWN_TERMINAL" && !["BLOCKED", "COMPLETED", "OPERATOR_CLOSED"].includes(String(reset.phase)))
      writes += input.repo.db.prepare("UPDATE v4_bid_ladder_usdg_reset_v1 SET phase='BLOCKED',block_reason='EXTERNAL_OR_UNKNOWN_TERMINAL_ACCOUNTING_RECONCILIATION_REQUIRED',revision=revision+1,updated_at_ms=? WHERE ladder_id=?").run(nowMs, input.ladderId).changes;
    if (reset && provenance === "FUNI_CLOSE_CONFIRMED" && String(reset.phase) === "WATCHING")
      writes += input.repo.db.prepare("UPDATE v4_bid_ladder_usdg_reset_v1 SET phase='OPERATOR_CLOSED',close_reason='NORMAL_OPERATOR_CLOSE',close_workflow_identity=COALESCE(close_workflow_identity,?),revision=revision+1,updated_at_ms=? WHERE ladder_id=?").run(input.ladderId, nowMs, input.ladderId).changes;
    return { status: writes ? "CONVERGED" as const : "ALREADY_CONVERGED" as const, provenance, writes };
  });
  return run();
}
