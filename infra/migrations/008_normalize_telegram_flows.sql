-- One-time normalization. History is retained; only stale active qualification changes.
UPDATE telegram_flow_sessions
SET status='expired', updated_at_ms=CAST(strftime('%s','now') AS INTEGER)*1000
WHERE status='active'
  AND expires_at_ms<=CAST(strftime('%s','now') AS INTEGER)*1000;
