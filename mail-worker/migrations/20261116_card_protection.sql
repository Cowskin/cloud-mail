-- Singleton system policy. Never stores raw passwords or modifies email records.
CREATE TABLE IF NOT EXISTS card_protection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  sealed_key TEXT,
  verifier_salt TEXT,
  verifier TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO card_protection (id) VALUES (1);
