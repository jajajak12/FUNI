CREATE TABLE IF NOT EXISTS canary_execution_transitions (
  intent_id TEXT NOT NULL REFERENCES canary_execution_intents(id),
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (intent_id, state)
);

CREATE INDEX IF NOT EXISTS canary_transition_order
  ON canary_execution_transitions(intent_id, created_at);

INSERT OR IGNORE INTO canary_execution_transitions(intent_id, state, created_at)
SELECT id, 'PREVIEWED', created_at FROM canary_execution_intents;
