-- Preserve flow history while enforcing exactly zero or one active flow per user/chat.
ALTER TABLE telegram_flow_sessions RENAME TO telegram_flow_sessions_legacy;

CREATE TABLE telegram_flow_sessions (
  session_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','expired','cancelled','completed','superseded')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

INSERT INTO telegram_flow_sessions(session_id,scope,user_id,chat_id,state_json,status,created_at_ms,updated_at_ms,expires_at_ms)
SELECT session_id,scope,user_id,chat_id,state_json,status,created_at_ms,updated_at_ms,expires_at_ms
FROM telegram_flow_sessions_legacy;

DROP TABLE telegram_flow_sessions_legacy;

CREATE UNIQUE INDEX telegram_flow_sessions_one_active_scope
  ON telegram_flow_sessions(scope) WHERE status='active';
CREATE INDEX telegram_flow_sessions_scope_updated
  ON telegram_flow_sessions(scope,updated_at_ms DESC);
CREATE INDEX telegram_flow_sessions_expiry
  ON telegram_flow_sessions(status,expires_at_ms);
