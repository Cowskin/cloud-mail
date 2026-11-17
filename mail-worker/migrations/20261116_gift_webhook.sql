-- Additive only: no backfill, body scan or production mail mutation.
CREATE TABLE IF NOT EXISTS gift_webhook_config (
  id INTEGER PRIMARY KEY CHECK (id=1),
  version INTEGER NOT NULL DEFAULT 1,
  sealed_url TEXT,
  provider TEXT CHECK(provider IN ('wecom','feishu')),
  capture_after TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO gift_webhook_config(id) VALUES(1);
CREATE TABLE IF NOT EXISTS gift_webhook_rate (
  id INTEGER PRIMARY KEY CHECK(id=1), minute INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO gift_webhook_rate(id) VALUES(1);
CREATE TABLE IF NOT EXISTS gift_webhook_runner (
  id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, lease_until INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO gift_webhook_runner(id) VALUES(1);

-- Durable references, captured atomically with new email inserts. Existing mail
-- is never enrolled by enabling protection or configuring a webhook.
CREATE TABLE IF NOT EXISTS gift_mail_work (
  email_id INTEGER PRIMARY KEY,
  config_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gift_mail_work_due ON gift_mail_work(state,due_at,email_id);
CREATE TRIGGER IF NOT EXISTS gift_mail_capture AFTER INSERT ON email
WHEN NEW.type=0 AND NEW.send_email COLLATE NOCASE IN
  ('order_acknowledgment@orders.apple.com','just_for_you@giftcards.apple.com')
  AND (SELECT enabled FROM card_protection WHERE id=1)=1
  AND (SELECT sealed_url FROM gift_webhook_config WHERE id=1) IS NOT NULL
  AND NEW.create_time >= (SELECT capture_after FROM gift_webhook_config WHERE id=1)
BEGIN
  INSERT OR IGNORE INTO gift_mail_work(email_id,config_version)
    SELECT NEW.email_id,version FROM gift_webhook_config WHERE id=1;
END;

CREATE TABLE IF NOT EXISTS gift_mail_event (
  email_id INTEGER PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  config_version INTEGER NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_gift_mail_candidates ON gift_mail_event
  (config_version,kind,owner_key,recipient_key,person_key,currency,amount_minor,received_at);
CREATE TABLE IF NOT EXISTS gift_notification (
  event_key TEXT PRIMARY KEY,
  config_version INTEGER NOT NULL,
  card_email_id INTEGER NOT NULL UNIQUE,
  order_email_id INTEGER UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending',
  relation TEXT,
  reason TEXT,
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  last_error TEXT,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gift_notification_due ON gift_notification(state,due_at,card_email_id);

-- A new destination or disabling protection invalidates pending work. Password
-- changes do not: those jobs must use the current cipher when they are sent.
CREATE TRIGGER IF NOT EXISTS gift_webhook_replaced AFTER UPDATE OF version ON gift_webhook_config
BEGIN
  UPDATE gift_mail_work SET state='cancelled' WHERE state='pending';
  UPDATE gift_notification SET state='cancelled',lease_token=NULL,order_email_id=NULL WHERE state='pending';
END;
CREATE TRIGGER IF NOT EXISTS gift_protection_disabled AFTER UPDATE OF enabled ON card_protection
WHEN NEW.enabled=0 AND OLD.enabled=1
BEGIN
  UPDATE gift_mail_work SET state='cancelled' WHERE state='pending';
  UPDATE gift_notification SET state='cancelled',lease_token=NULL,order_email_id=NULL WHERE state='pending';
END;
CREATE TRIGGER IF NOT EXISTS gift_protection_enabled AFTER UPDATE OF enabled ON card_protection
WHEN NEW.enabled=1 AND OLD.enabled=0
BEGIN
  UPDATE gift_webhook_config SET capture_after=datetime('now') WHERE id=1;
END;
