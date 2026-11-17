-- LOCAL PROTOTYPE ONLY. Not a production migration. Existing mail stays in D1.
-- This stand-in represents the existing source email table in the simulation.
CREATE TABLE IF NOT EXISTS source_mail (email_id INTEGER PRIMARY KEY, mail_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gift_event (
  email_id INTEGER PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  recipient_key TEXT NOT NULL,
  person_key TEXT NOT NULL,
  currency TEXT,
  amount_minor INTEGER,
  received_at INTEGER NOT NULL,
  order_id TEXT,
  quantity INTEGER,
  issues TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gift_order_candidates ON gift_event
  (kind,owner_key,recipient_key,person_key,currency,amount_minor,received_at);
CREATE INDEX IF NOT EXISTS idx_gift_card_pending ON gift_event(kind,received_at,email_id);
CREATE TABLE IF NOT EXISTS notification (
  event_key TEXT PRIMARY KEY,
  card_email_id INTEGER NOT NULL UNIQUE,
  order_email_id INTEGER UNIQUE,
  relation TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gift_notification_pending ON notification(state,card_email_id);
