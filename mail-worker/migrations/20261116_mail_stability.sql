-- Additive metadata projection. Bodies remain in email; no mail is removed.
CREATE TABLE IF NOT EXISTS email_metadata (
  email_id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  type INTEGER NOT NULL, status INTEGER NOT NULL, is_del INTEGER NOT NULL,
  subject TEXT, name TEXT, create_time TEXT, content_bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_meta_owner ON email_metadata(user_id,type,is_del,account_id);
CREATE INDEX IF NOT EXISTS idx_email_meta_type_status ON email_metadata(type,status,is_del);
CREATE INDEX IF NOT EXISTS idx_email_meta_subject ON email_metadata(subject COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_email_meta_name ON email_metadata(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_email_meta_date ON email_metadata(type,create_time);
CREATE INDEX IF NOT EXISTS idx_email_meta_storage ON email_metadata(create_time,content_bytes);
CREATE TRIGGER IF NOT EXISTS email_metadata_insert AFTER INSERT ON email BEGIN
  INSERT OR REPLACE INTO email_metadata SELECT NEW.email_id,NEW.account_id,NEW.user_id,NEW.type,NEW.status,NEW.is_del,
    NEW.subject,NEW.name,NEW.create_time,
    LENGTH(COALESCE(NEW.subject,''))+LENGTH(COALESCE(NEW.text,''))+LENGTH(COALESCE(NEW.content,''))+
    LENGTH(COALESCE(NEW.message,''))+LENGTH(COALESCE(NEW.cc,''))+LENGTH(COALESCE(NEW.bcc,''));
END;
CREATE TRIGGER IF NOT EXISTS email_metadata_update AFTER UPDATE ON email BEGIN
  INSERT OR REPLACE INTO email_metadata SELECT NEW.email_id,NEW.account_id,NEW.user_id,NEW.type,NEW.status,NEW.is_del,
    NEW.subject,NEW.name,NEW.create_time,
    LENGTH(COALESCE(NEW.subject,''))+LENGTH(COALESCE(NEW.text,''))+LENGTH(COALESCE(NEW.content,''))+
    LENGTH(COALESCE(NEW.message,''))+LENGTH(COALESCE(NEW.cc,''))+LENGTH(COALESCE(NEW.bcc,''));
END;
CREATE TRIGGER IF NOT EXISTS email_metadata_delete AFTER DELETE ON email BEGIN
  DELETE FROM email_metadata WHERE email_id=OLD.email_id;
END;
-- This receipt survives deletion of its email, so a delayed delivery cannot resurrect it.
CREATE TABLE IF NOT EXISTS email_delivery (
  delivery_key TEXT PRIMARY KEY, email_id INTEGER, state TEXT NOT NULL DEFAULT 'pending',
  create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_delivery_pending ON email_delivery(email_id,state);
