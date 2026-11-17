import protection from './card-protection-service';
import config from './gift-webhook-config';
import { postWebhook } from '../utils/gift-webhook';
import { extractGiftEvent,decideAssociation,formatNotification,SETTLE_MS,ORDER_WAIT_MS,LOOKBACK_MS } from '../utils/gift-order';

const sourceSql = `SELECT email_id AS emailId,user_id AS userId,account_id AS accountId,to_email AS toEmail,
  send_email AS sendEmail,name,subject,content,text,message_id AS messageId,create_time AS createTime,status,is_del AS isDel
  FROM email WHERE email_id=?`;
const candidateSql = `SELECT * FROM gift_mail_event INDEXED BY idx_gift_mail_candidates
  WHERE config_version=? AND kind=? AND owner_key=? AND recipient_key=? AND person_key=?
  AND currency=? AND amount_minor=? AND received_at BETWEEN ? AND ? LIMIT 21`;
const bindCandidates = (row,kind,start,end) => [row.config_version,kind,row.owner_key,row.recipient_key,
  row.person_key,row.currency,row.amount_minor,start,end];

async function fingerprint(c,event) {
  const raw = Uint8Array.from(atob(c.env.CARD_PROTECTION_SECRET), ch => ch.charCodeAt(0));
  if (raw.length !== 32) throw Error('gift_key_unavailable');
  const key = await crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const identity = event.kind === 'card' ? event.cardIdentity : event.orderId || event.emailId;
  const digest = await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(
    ['cloudmail/gift-dedup/v1',event.kind,event.ownerKey,event.recipientKey,identity])));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
}

async function ingest(c,row,now) {
  const mail = await c.env.db.prepare(sourceSql).bind(row.email_id).first();
  if (!mail || (mail.isDel && mail.status !== 6)) {
    await c.env.db.prepare("UPDATE gift_mail_work SET state='cancelled' WHERE email_id=?").bind(row.email_id).run();
    return;
  }
  if (mail.status === 6) return; // Attachment saving/recovery has not completed.
  // Stored From/template fields identify matching records only. Do not create
  // trustedSender from user-controlled From/Authentication-Results headers.
  let event;
  try { event = extractGiftEvent(mail); }
  catch {
    event = extractGiftEvent({...mail,content:'',text:''});
    event?.issues.push('body_parse_failed');
  }
  if (!event) {
    await c.env.db.prepare("UPDATE gift_mail_work SET state='ignored' WHERE email_id=?").bind(row.email_id).run();
    return;
  }
  if (!Number.isFinite(event.receivedAt)) event.receivedAt = now;
  const eventKey = await fingerprint(c,event);
  const statements = [c.env.db.prepare(`INSERT OR IGNORE INTO gift_mail_event
    (email_id,event_key,config_version,kind,owner_key,recipient_key,person_key,currency,amount_minor,received_at,order_id,quantity,issues)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM gift_mail_work w,gift_webhook_config c,card_protection p
      WHERE w.email_id=? AND w.state='pending' AND c.id=1 AND c.version=w.config_version AND c.sealed_url IS NOT NULL AND p.id=1 AND p.enabled=1)`)
    .bind(event.emailId,eventKey,row.config_version,event.kind,event.ownerKey,
      event.recipientKey,event.personKey,event.currency,event.amountMinor,event.receivedAt,event.orderId,event.quantity,JSON.stringify(event.issues),event.emailId)];
  if (event.kind === 'card') statements.push(c.env.db.prepare(`INSERT OR IGNORE INTO gift_notification
    (event_key,config_version,card_email_id,due_at) SELECT event_key,config_version,email_id,? FROM gift_mail_event WHERE email_id=?
      AND EXISTS(SELECT 1 FROM gift_mail_work WHERE email_id=? AND state='pending')`)
    .bind(event.receivedAt + SETTLE_MS,event.emailId,event.emailId));
  statements.push(c.env.db.prepare("UPDATE gift_mail_work SET state='parsed' WHERE email_id=? AND state='pending'").bind(row.email_id));
  await c.env.db.batch(statements);
}

async function decision(c,card,now) {
  const {results:orders} = await c.env.db.prepare(candidateSql).bind(...bindCandidates(card,'confirmation',card.received_at-LOOKBACK_MS,card.received_at+ORDER_WAIT_MS)).all();
  const order = orders[0];
  let claim, rivals = [];
  if (order) {
    claim = await c.env.db.prepare("SELECT card_email_id FROM gift_notification WHERE order_email_id=? AND state!='cancelled'").bind(order.email_id).first();
    ({results:rivals} = await c.env.db.prepare(candidateSql).bind(...bindCandidates(order,'card',order.received_at-ORDER_WAIT_MS,order.received_at+LOOKBACK_MS)).all());
  }
  return decideAssociation(card,orders,{claimedBy:claim?.card_email_id,rivalCount:rivals.filter(r=>r.issues==='[]').length,now});
}

async function sendJob(c,job,row,now,send,runner) {
  const policy = await protection.read(c);
  if (!policy.enabled) return;
  const card = await c.env.db.prepare('SELECT * FROM gift_mail_event WHERE email_id=?').bind(job.card_email_id).first();
  const match = await decision(c,card,now);
  if (!match.relation) {
    await c.env.db.prepare('UPDATE gift_notification SET due_at=? WHERE event_key=?').bind(card.received_at+ORDER_WAIT_MS,job.event_key).run();
    return;
  }
  const mail = await c.env.db.prepare(sourceSql).bind(job.card_email_id).first();
  if (!mail || mail.isDel || mail.status === 6) {
    await c.env.db.prepare("UPDATE gift_notification SET state='cancelled',order_email_id=NULL WHERE event_key=?").bind(job.event_key).run();
    return;
  }
  let event;
  try { event = extractGiftEvent(mail); } catch { event = extractGiftEvent({...mail,content:'',text:''}); }
  const encrypt = await protection.cipher(c,policy);
  const cipher = event?.rawCard ? await encrypt(event.rawCard) : '未识别（需人工处理）';
  if (event?.rawCard && !/^JG_X[A-Z0-9]{3}_[A-Z0-9]{12}_[A-Z0-9]{4}$/.test(cipher)) throw Error('gift_cipher_unavailable');
  const orderId = match.orderId ? await c.env.db.prepare('SELECT order_id FROM gift_mail_event WHERE email_id=?').bind(match.orderId).first('order_id') : null;
  const content = formatNotification({orderId,cipher,currency:card.currency,amountMinor:card.amount_minor,
    receivedAt:card.received_at,reason:match.reason,recipient:card.recipient_key,emailId:card.email_id});
  const url = await config.url(c,row);
  // Last checks before a network send. A request already accepted by the robot
  // cannot be recalled by a later settings change.
  const latest = await protection.read(c), current = await config.read(c);
  if (!latest.enabled || latest.version !== policy.version || current.version !== row.version || !current.sealed_url) return;
  const next = await decision(c,card,now);
  if (JSON.stringify(next) !== JSON.stringify(match)) return;
  const clock = Date.now();
  const lease = await c.env.db.prepare('UPDATE gift_webhook_runner SET lease_until=? WHERE id=1 AND token=? AND lease_until>? RETURNING id')
    .bind(clock+120000,runner,clock).first();
  if (!lease) return;
  // Reserve below the official robot limit (20/minute), across Worker instances.
  const minute = Math.floor(clock/60000);
  const rate = await c.env.db.prepare(`UPDATE gift_webhook_rate SET used=CASE WHEN minute=? THEN used+1 ELSE 1 END,minute=?
    WHERE id=1 AND (minute!=? OR used<18) RETURNING used`).bind(minute,minute,minute).first();
  if (!rate) return;
  const claimed = await c.env.db.prepare(`UPDATE gift_notification SET attempts=attempts+1,relation=?,reason=?,order_email_id=?,lease_token=?,due_at=?
    WHERE event_key=? AND state='pending' AND config_version=?
      AND EXISTS(SELECT 1 FROM card_protection WHERE id=1 AND enabled=1 AND version=?)
      AND EXISTS(SELECT 1 FROM gift_webhook_config WHERE id=1 AND version=? AND sealed_url IS NOT NULL) RETURNING event_key`)
    .bind(match.relation,match.reason,match.orderId,runner,now+120000,job.event_key,row.version,policy.version,row.version).first();
  if (!claimed) return;
  try {
    await send(url,{msgtype:'text',text:{content}});
    await c.env.db.prepare(`UPDATE gift_notification SET state='sent',sent_at=datetime('now'),last_error=NULL,lease_token=NULL
      WHERE event_key=? AND lease_token=?`).bind(job.event_key,runner).run();
  } catch (error) {
    const attempts = job.attempts+1;
    const reason = /^(?:network_error|timeout|invalid_destination|invalid_payload|invalid_response|response_too_large|http_\d{3}|(?:wecom|feishu)_error_-?\d{1,16})$/.test(error?.deliveryReason || '')
      ? error.deliveryReason : 'webhook_delivery_failed';
    await c.env.db.prepare(`UPDATE gift_notification SET last_error=?,lease_token=NULL,
      state=?,due_at=? WHERE event_key=? AND lease_token=?`)
      .bind(reason,attempts >= 8 ? 'failed' : 'pending',now+Math.min(3600000,60000*2**attempts),job.event_key,runner).run();
  }
}

export async function runGiftNotifications(env, { now=Date.now(),send=postWebhook } = {}) {
  const c = {env};
  const row = await config.read(c), policy = await protection.read(c);
  if (!row.sealed_url || !policy.enabled) return {active:false};
  const runner = crypto.randomUUID(), clock = Date.now();
  const lease = await env.db.prepare(`UPDATE gift_webhook_runner SET token=?,lease_until=? WHERE id=1 AND lease_until<=? RETURNING id`)
    .bind(runner,clock+120000,clock).first();
  if (!lease) return {busy:true};
  // Incoming-email waitUntil has a shorter lifetime than scheduled events.
  // Leave room for one bounded HTTP request and retain the rest in D1.
  const deadline = clock+20000;
  try {
    const {results:work} = await env.db.prepare(`SELECT * FROM gift_mail_work INDEXED BY idx_gift_mail_work_due
      WHERE state='pending' AND due_at<=? ORDER BY due_at,email_id LIMIT 100`).bind(now).all();
    for (const item of work) {
      if (Date.now() >= deadline) return {waitingForIngest:true};
      if (item.config_version !== row.version) {
        await env.db.prepare("UPDATE gift_mail_work SET state='cancelled' WHERE email_id=?").bind(item.email_id).run();
      } else await ingest(c,item,now);
    }
    // Finish parsing enrolled mail before making an association; a queued
    // competing order/card must not be invisible merely due to batch size.
    const remaining = await env.db.prepare("SELECT email_id FROM gift_mail_work INDEXED BY idx_gift_mail_work_due WHERE state='pending' LIMIT 1").first();
    if (remaining) return {waitingForIngest:true};
    const {results:jobs} = await env.db.prepare(`SELECT * FROM gift_notification INDEXED BY idx_gift_notification_due
      WHERE state='pending' AND due_at<=? ORDER BY due_at,card_email_id LIMIT 15`).bind(now).all();
    for (const job of jobs) {
      if (Date.now()+8000 >= deadline) break;
      if (job.config_version !== row.version) continue;
      try { await sendJob(c,job,row,now,send,runner); }
      catch {
        await env.db.prepare("UPDATE gift_notification SET last_error='processing_unavailable',due_at=? WHERE event_key=? AND state='pending'")
          .bind(now+300000,job.event_key).run();
      }
    }
    return {active:true,parsed:work.length,processed:jobs.length};
  } finally {
    await env.db.prepare('UPDATE gift_webhook_runner SET lease_until=0,token=NULL WHERE id=1 AND token=?').bind(runner).run();
  }
}

export async function safelyRunGiftNotifications(env) {
  try { await runGiftNotifications(env); }
  catch { console.error('gift_notifications_deferred'); }
}
