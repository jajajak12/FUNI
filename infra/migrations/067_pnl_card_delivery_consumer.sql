-- Durable bounded consumer support for Position Closed cards.  The explicit
-- send boundary lets recovery retry definitely-unsent claims without treating
-- an ambiguous Telegram outcome as safe to resend.
ALTER TABLE pnl_card_deliveries ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);
ALTER TABLE pnl_card_deliveries ADD COLUMN send_started_at_ms INTEGER;
ALTER TABLE pnl_card_deliveries ADD COLUMN consumer_source TEXT CHECK(consumer_source IN ('TELEGRAM_EVENT_DRIVEN','RECONCILE_FALLBACK'));

CREATE INDEX pnl_card_delivery_due_idx
  ON pnl_card_deliveries(card_kind, delivery_status, updated_at_ms, delivery_id);
