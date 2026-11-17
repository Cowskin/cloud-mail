-- Cover group, unread and recycle-bin statistics without loading message bodies.
-- Apply before deploying the group query changes; retains all existing records.
CREATE INDEX IF NOT EXISTS idx_email_account_del_unread_time ON email(account_id,is_del,unread,create_time);
CREATE INDEX IF NOT EXISTS idx_attachment_account_id ON attachments(account_id);
