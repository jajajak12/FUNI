CREATE TABLE v4_bid_ladder_usdg_reset_v1 (
  ladder_id TEXT PRIMARY KEY,
  root_ladder_id TEXT NOT NULL,
  previous_ladder_id TEXT UNIQUE,
  next_ladder_id TEXT UNIQUE,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  policy TEXT NOT NULL CHECK(policy = 'USDG_RESET_REPOSITION_V1'),
  creation_reason TEXT NOT NULL CHECK(creation_reason IN ('INITIAL_OPEN','USDG_RESET_REPOSITION')),
  phase TEXT NOT NULL CHECK(phase IN (
    'OPEN_PENDING','WATCHING','CLOSE_PREPARED','CLOSE_SUBMITTED',
    'CLOSE_CONFIRMED','PRINCIPAL_RECONCILED','REOPEN_PLANNED',
    'REOPEN_PREPARED','REOPEN_SUBMITTED','COMPLETED','BLOCKED',
    'OPERATOR_CLOSED'
  )),
  close_reason TEXT CHECK(close_reason IS NULL OR close_reason IN ('NORMAL_OPERATOR_CLOSE','USDG_RESET_REPOSITION')),
  close_workflow_identity TEXT UNIQUE,
  reopen_workflow_identity TEXT UNIQUE,
  returned_usdg_principal_raw TEXT CHECK(
    returned_usdg_principal_raw IS NULL OR
    (length(returned_usdg_principal_raw) > 0 AND returned_usdg_principal_raw NOT GLOB '*[^0-9]*')
  ),
  returned_target_principal_raw TEXT CHECK(
    returned_target_principal_raw IS NULL OR
    (length(returned_target_principal_raw) > 0 AND returned_target_principal_raw NOT GLOB '*[^0-9]*')
  ),
  returned_usdg_fee_raw TEXT CHECK(
    returned_usdg_fee_raw IS NULL OR
    (length(returned_usdg_fee_raw) > 0 AND returned_usdg_fee_raw NOT GLOB '*[^0-9]*')
  ),
  returned_target_fee_raw TEXT CHECK(
    returned_target_fee_raw IS NULL OR
    (length(returned_target_fee_raw) > 0 AND returned_target_fee_raw NOT GLOB '*[^0-9]*')
  ),
  block_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  FOREIGN KEY(ladder_id) REFERENCES v4_bid_ladders(ladder_id) ON DELETE RESTRICT,
  FOREIGN KEY(root_ladder_id) REFERENCES v4_bid_ladders(ladder_id) ON DELETE RESTRICT,
  FOREIGN KEY(previous_ladder_id) REFERENCES v4_bid_ladders(ladder_id) ON DELETE RESTRICT,
  FOREIGN KEY(next_ladder_id) REFERENCES v4_bid_ladders(ladder_id) ON DELETE RESTRICT,
  UNIQUE(root_ladder_id,generation),
  CHECK(
    (generation = 0 AND previous_ladder_id IS NULL AND root_ladder_id = ladder_id AND creation_reason = 'INITIAL_OPEN') OR
    (generation > 0 AND previous_ladder_id IS NOT NULL AND creation_reason = 'USDG_RESET_REPOSITION')
  ),
  CHECK(previous_ladder_id IS NULL OR previous_ladder_id <> ladder_id),
  CHECK(next_ladder_id IS NULL OR next_ladder_id <> ladder_id),
  CHECK(close_reason IS NULL OR phase IN ('CLOSE_CONFIRMED','PRINCIPAL_RECONCILED','REOPEN_PLANNED','REOPEN_PREPARED','REOPEN_SUBMITTED','COMPLETED','BLOCKED','OPERATOR_CLOSED')),
  CHECK(phase <> 'OPERATOR_CLOSED' OR close_reason = 'NORMAL_OPERATOR_CLOSE'),
  CHECK(phase NOT IN ('CLOSE_CONFIRMED','PRINCIPAL_RECONCILED','REOPEN_PLANNED','REOPEN_PREPARED','REOPEN_SUBMITTED','COMPLETED') OR close_reason = 'USDG_RESET_REPOSITION')
);

CREATE INDEX v4_bid_ladder_usdg_reset_phase_idx
ON v4_bid_ladder_usdg_reset_v1(phase,updated_at_ms);
