-- Additive only: no mail data is modified. Run during a quiet period.
CREATE INDEX IF NOT EXISTS idx_email_user_type_del_id ON email(user_id, type, is_del, email_id DESC);
CREATE INDEX IF NOT EXISTS idx_email_account_user_type_del_id ON email(account_id, user_id, type, is_del, email_id DESC);
CREATE INDEX IF NOT EXISTS idx_email_type_status_id ON email(type, email_id DESC, status);
CREATE INDEX IF NOT EXISTS idx_email_to_nocase_type ON email(to_email COLLATE NOCASE, type, status);
CREATE INDEX IF NOT EXISTS idx_email_from_nocase_type ON email(send_email COLLATE NOCASE, type, status);
CREATE INDEX IF NOT EXISTS idx_attachment_email_id ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_star_user_email ON star(user_id, email_id);
