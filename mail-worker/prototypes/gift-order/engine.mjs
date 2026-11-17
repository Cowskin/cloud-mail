import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { extractGiftEvent } from './extract.mjs';
import { decideAssociation,formatNotification } from '../../src/utils/gift-order.js';
export { formatNotification } from '../../src/utils/gift-order.js';

export const SETTLE_MS = 2 * 60_000;
export const ORDER_WAIT_MS = 30 * 60_000;
export const LOOKBACK_MS = 24 * 60 * 60_000;
const candidatesSql = `SELECT * FROM gift_event INDEXED BY idx_gift_order_candidates
  WHERE kind='confirmation' AND owner_key=? AND recipient_key=? AND person_key=?
  AND currency=? AND amount_minor=? AND received_at BETWEEN ? AND ? LIMIT 21`;

export class GiftOrderEngine {
  constructor({ fingerprintSecret, database = ':memory:', clock = Date.now }) {
    if (!fingerprintSecret) throw Error('Independent fingerprint secret is required');
    this.db = new DatabaseSync(database);
    this.clock = clock;
    this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    this.fingerprintKey = crypto.subtle.importKey('raw', new TextEncoder().encode(fingerprintSecret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  }
  close() { this.db.close(); }
  async ingest(mail) {
    const event = extractGiftEvent(mail);
    if (!event) return { ignored:true };
    if (!Number.isSafeInteger(event.emailId) || !Number.isFinite(event.receivedAt)) throw Error('Email ID and receive time are required');
    const identity = event.kind === 'confirmation' ? event.orderId || mail.messageId || event.emailId : event.cardIdentity;
    const signature = await crypto.subtle.sign('HMAC', await this.fingerprintKey,
      new TextEncoder().encode(JSON.stringify([event.kind,event.ownerKey,event.recipientKey,identity])));
    const key = Buffer.from(signature).toString('hex');
    const existing = this.db.prepare('SELECT * FROM gift_event WHERE event_key=? OR email_id=?').get(key,event.emailId);
    if (existing) return { duplicate:true, emailId:existing.email_id };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO source_mail VALUES (?,?)').run(event.emailId,JSON.stringify(mail));
      this.db.prepare(`INSERT INTO gift_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.emailId,key,event.kind,event.ownerKey,
        event.recipientKey,event.personKey,event.currency,event.amountMinor,event.receivedAt,event.orderId,event.quantity,JSON.stringify(event.issues));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { inserted:true, emailId:event.emailId, kind:event.kind };
  }
  candidates(card) {
    return this.db.prepare(candidatesSql).all(card.owner_key,card.recipient_key,card.person_key,card.currency,
      card.amount_minor,card.received_at - LOOKBACK_MS,card.received_at + ORDER_WAIT_MS);
  }
  decision(card, now) {
    const all = this.candidates(card);
    const selected = all[0];
    const claim = selected && this.db.prepare('SELECT card_email_id FROM notification WHERE order_email_id=?').get(selected.email_id);
    const rivals = selected ? this.db.prepare(`SELECT email_id FROM gift_event INDEXED BY idx_gift_order_candidates
        WHERE kind='card' AND owner_key=? AND recipient_key=? AND person_key=? AND currency=? AND amount_minor=?
        AND received_at BETWEEN ? AND ? AND issues='[]' LIMIT 2`).all(selected.owner_key,selected.recipient_key,
          selected.person_key,selected.currency,selected.amount_minor,selected.received_at - ORDER_WAIT_MS,selected.received_at + LOOKBACK_MS) : [];
    return decideAssociation(card,all,{claimedBy:claim?.card_email_id,rivalCount:rivals.length,now});
  }
  reconcile(now) {
    const cards = this.db.prepare(`SELECT e.* FROM gift_event e INDEXED BY idx_gift_card_pending
      LEFT JOIN notification n ON n.card_email_id=e.email_id
      WHERE e.kind='card' AND e.received_at<=? AND n.card_email_id IS NULL ORDER BY e.received_at,e.email_id LIMIT 200`).all(now - SETTLE_MS);
    const outcomes = [];
    for (const card of cards) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const {relation,reason,orderId} = this.decision(card,now);
        if (relation) this.db.prepare(`INSERT OR IGNORE INTO notification(event_key,card_email_id,order_email_id,relation,reason)
          VALUES (?,?,?,?,?)`).run(card.event_key,card.email_id,orderId,relation,reason);
        this.db.exec('COMMIT');
        outcomes.push({emailId:card.email_id,state:relation || 'waiting_for_order',reason});
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    return outcomes;
  }
  jobs() { return this.db.prepare('SELECT * FROM notification ORDER BY card_email_id').all(); }
  metadata() { return this.db.prepare('SELECT * FROM gift_event ORDER BY email_id').all(); }
  queryPlan(cardEmailId) {
    const c = this.db.prepare('SELECT * FROM gift_event WHERE email_id=?').get(cardEmailId);
    return this.db.prepare('EXPLAIN QUERY PLAN '+candidatesSql).all(c.owner_key,c.recipient_key,c.person_key,c.currency,c.amount_minor,
      c.received_at - LOOKBACK_MS,c.received_at + ORDER_WAIT_MS).map(row => row.detail);
  }
  refresh(job, now) {
    const card = this.db.prepare('SELECT * FROM gift_event WHERE email_id=?').get(job.card_email_id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const decision = this.decision(card,now);
      if (decision.relation) this.db.prepare(`UPDATE notification SET relation=?,reason=?,order_email_id=?
        WHERE event_key=? AND state='pending'`).run(decision.relation,decision.reason,decision.orderId,job.event_key);
      this.db.exec('COMMIT');
      return decision.relation ? this.db.prepare('SELECT * FROM notification WHERE event_key=?').get(job.event_key) : null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async flush({ protection, transport, now = this.clock() }) {
    const results = [];
    const pendingJobs = this.db.prepare("SELECT * FROM notification INDEXED BY idx_gift_notification_pending WHERE state='pending' ORDER BY card_email_id LIMIT 100").all();
    for (const pending of pendingJobs) {
      const job = this.refresh(pending,now);
      if (!job) { results.push({emailId:pending.card_email_id,state:'waiting_for_order'}); continue; }
      const policy = await protection.read();
      if (!policy.enabled) { results.push({emailId:job.card_email_id,state:'blocked_encryption_off'}); continue; }
      const mail = JSON.parse(this.db.prepare('SELECT mail_json FROM source_mail WHERE email_id=?').get(job.card_email_id).mail_json);
      const card = extractGiftEvent(mail);
      let cipher;
      try {
        cipher = card.rawCard ? await protection.encrypt(card.rawCard,policy) : '未识别（需人工处理）';
        if (card.rawCard && !/^JG_X[A-Z0-9]{3}_[A-Z0-9]{12}_[A-Z0-9]{4}$/.test(cipher)) throw Error('Encryption is required');
      } catch { results.push({emailId:job.card_email_id,state:'blocked_encryption_unavailable'}); continue; }
      const orderId = job.order_email_id ? this.db.prepare('SELECT order_id FROM gift_event WHERE email_id=?').get(job.order_email_id).order_id : null;
      const content = formatNotification({orderId,cipher,currency:card.currency,amountMinor:card.amountMinor,
        receivedAt:card.receivedAt,reason:job.reason,recipient:card.recipientKey,emailId:card.emailId});
      // Re-read just before the wire. Queued jobs never contain raw cards or
      // stale ciphertext, and changing the password does not rebuild an index.
      const latest = await protection.read();
      if (!latest.enabled || latest.version !== policy.version) { results.push({emailId:job.card_email_id,state:'blocked_policy_changed'}); continue; }
      const checked = this.refresh(job,now);
      if (!checked || checked.relation !== job.relation || checked.order_email_id !== job.order_email_id || checked.reason !== job.reason) {
        results.push({emailId:job.card_email_id,state:'blocked_relation_changed'}); continue;
      }
      this.db.prepare('UPDATE notification SET attempts=attempts+1 WHERE event_key=?').run(job.event_key);
      try {
        await transport.send({type:'gift_card.notification',idempotencyKey:'gift-card:'+job.event_key,
          body:{msgtype:'text',text:{content}}});
        this.db.prepare("UPDATE notification SET state='sent' WHERE event_key=?").run(job.event_key);
        results.push({emailId:job.card_email_id,state:'sent',relation:job.relation});
      } catch { results.push({emailId:job.card_email_id,state:'retry_pending'}); }
    }
    return results;
  }
}
