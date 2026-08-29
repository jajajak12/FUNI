-- One active continuation owner per USDG Reset Reposition source ladder.
-- Expiry is the crash-recovery boundary; phase/journal rows remain authority.
CREATE TABLE v4_bid_ladder_usdg_reset_execution_leases (
  ladder_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  caller_source TEXT NOT NULL CHECK(caller_source IN (
    'USER_CONFIRM','IMMEDIATE_RECOVERY','PERIODIC_RECOVERY'
  )),
  generation INTEGER NOT NULL CHECK(generation >= 0),
  phase_at_acquire TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL CHECK(acquired_at_ms >= 0),
  lease_until_ms INTEGER NOT NULL CHECK(lease_until_ms > acquired_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= acquired_at_ms),
  FOREIGN KEY(ladder_id) REFERENCES v4_bid_ladder_usdg_reset_v1(ladder_id) ON DELETE CASCADE
);
