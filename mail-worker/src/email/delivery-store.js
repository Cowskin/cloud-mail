// D1 batches are transactions. Persist the email and its receipt together, so an
// ambiguous network failure or queue replay never inserts a second email.
export async function receiveOnce(c, deliveryKey, params) {
  const fields = {
    toEmail:'to_email', toName:'to_name', sendEmail:'send_email', name:'name', subject:'subject', code:'code',
    content:'content', text:'text', cc:'cc', bcc:'bcc', recipient:'recipient', inReplyTo:'in_reply_to',
    relation:'relation', messageId:'message_id', userId:'user_id', accountId:'account_id', isDel:'is_del', status:'status', createTime:'create_time'
  };
  const entries = Object.entries(fields);
  const values = entries.map(([key]) => params[key] ?? (key==='createTime' ? new Date().toISOString().replace('T',' ').slice(0,19) : ['content','text','subject'].includes(key) ? null : ''));
  const results = await c.env.db.batch([
    c.env.db.prepare('INSERT OR IGNORE INTO email_delivery(delivery_key) VALUES (?)').bind(deliveryKey),
    c.env.db.prepare(`INSERT INTO email(${entries.map(([,column]) => column).join(',')})
      SELECT ${entries.map(() => '?').join(',')} WHERE EXISTS (
        SELECT 1 FROM email_delivery WHERE delivery_key=? AND email_id IS NULL AND state='pending'
      )`).bind(...values, deliveryKey),
    c.env.db.prepare(`UPDATE email_delivery SET email_id=last_insert_rowid()
      WHERE delivery_key=? AND email_id IS NULL AND state='pending'`).bind(deliveryKey),
    c.env.db.prepare('SELECT email_id AS emailId, state FROM email_delivery WHERE delivery_key=?').bind(deliveryKey)
  ]);
  return results[3].results[0];
}

export async function deliveryState(env, key) {
  return env.db.prepare('SELECT email_id AS emailId,state FROM email_delivery WHERE delivery_key=?').bind(key).first();
}

export async function finishDelivery(env, key, emailId, status) {
  const results = await env.db.batch([
    env.db.prepare(`UPDATE email SET is_del=0,status=? WHERE email_id=? AND EXISTS
      (SELECT 1 FROM email_delivery WHERE delivery_key=? AND state='pending')`).bind(status,emailId,key),
    env.db.prepare("UPDATE email_delivery SET state='delivered' WHERE delivery_key=? AND state='pending' RETURNING email_id").bind(key)
  ]);
  return results[1].results.length > 0;
}
