import { processEmail } from './email';
import { deliveryState } from './delivery-store';

const PREFIX = 'pending/';

function log(event, extra = {}) {
  // Never log message content, envelope addresses, headers, secrets or raw errors.
  console.log(JSON.stringify({event,...extra}));
}

async function removeDelivered(env, key) {
  try { await env.MAIL_SPOOL.delete(key); }
  catch { log('mail_buffer_cleanup_deferred'); }
}

export async function bufferedEmail(message, env, ctx) {
  if (!env.MAIL_SPOOL || !env.MAIL_QUEUE) throw new Error('Durable mail buffer is not configured');
  const key = `${PREFIX}${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}.eml`;
  const raw = await new Response(message.raw).arrayBuffer();
  // No D1 access precedes this durable write. A storage failure is propagated;
  // never acknowledge a message whose only remaining copy is in memory.
  const receivedAt=new Date().toISOString();
  await env.MAIL_SPOOL.put(key, raw, {
    customMetadata:{from:message.from,to:message.to,receivedAt},
    httpMetadata:{contentType:'message/rfc822'}
  });
  try { await env.MAIL_QUEUE.send({key}, {delaySeconds:120}); }
  catch { log('mail_buffer_enqueue_deferred'); } // Scheduled recovery covers this crash window too.

  let rejected = false;
  const processingRaw = new Response(raw).body;
  try {
    await processEmail({
      from:message.from,to:message.to,raw:processingRaw,headers:message.headers,receivedAt,
      setReject(reason) { rejected=true; message.setReject(reason); },
      forward:message.forward.bind(message)
    },env,ctx,key);
    await removeDelivered(env,key);
    log(rejected ? 'mail_rejected_by_policy' : 'mail_delivered');
  } catch {
    // The durable raw message and automatic replayer now own the delivery.
    // In particular, D1 overload must not become a permanent SMTP rejection.
    log('mail_delivery_deferred');
  } finally {
    if (!processingRaw.locked) await processingRaw.cancel();
  }
}

export async function deliverBuffered(key,env,ctx) {
  if (typeof key!=='string' || !/^pending\/\d{4}-\d{2}-\d{2}\/[\da-f-]+\.eml$/.test(key)) throw new Error('Invalid buffered mail key');
  const receipt = await deliveryState(env,key);
  if (['delivered','rejected'].includes(receipt?.state)) { await removeDelivered(env,key); return; }
  const object = await env.MAIL_SPOOL.get(key);
  if (!object) return;
  let rejected=false;
  try { await processEmail({
    from:object.customMetadata.from,to:object.customMetadata.to,raw:object.body,receivedAt:object.customMetadata.receivedAt,
    headers:new Headers(),
    setReject() { rejected=true; },
    // Email Routing's forward() exists only during the original SMTP invocation.
    // Normal delivery retains it; deferred delivery is still kept in the local inbox.
    async forward() { log('mail_deferred_forward_unavailable'); }
  },env,ctx,key); }
  finally { if (!object.bodyUsed) await object.body.cancel(); }
  await removeDelivered(env,key);
  log(rejected ? 'mail_deferred_rejected_by_policy' : 'mail_delivery_recovered');
}

export async function consumeMail(batch,env,ctx) {
  for (const message of batch.messages) {
    try { await deliverBuffered(message.body.key,env,ctx); message.ack(); }
    catch {
      log('mail_delivery_retry',{attempt:message.attempts});
      message.retry({delaySeconds:Math.min(3600,30*2**Math.min(message.attempts,7))});
    }
  }
}

export async function recoverMail(env) {
  // R2 remains the durable source even after Queue retention/retry limits. Cycle
  // the listing cursor so one permanently malformed message cannot starve others.
  const cursor=await env.kv.get('mail-buffer-recovery-cursor');
  const page=await env.MAIL_SPOOL.list({prefix:PREFIX,limit:100,...(cursor?{cursor}: {})});
  let queued=0;
  for (const object of page.objects) {
    if (Date.now()-object.uploaded.getTime()<5*60*1000) continue;
    await env.MAIL_QUEUE.send({key:object.key});
    queued++;
  }
  if (page.truncated) await env.kv.put('mail-buffer-recovery-cursor',page.cursor);
  else await env.kv.delete('mail-buffer-recovery-cursor');
  if (queued) log('mail_buffer_recovery_queued',{count:queued});
}

export async function mailBufferStatus(env) {
  const page=await env.MAIL_SPOOL.list({prefix:PREFIX,limit:1000});
  const oldest=page.objects.reduce((value,object)=>Math.min(value,object.uploaded.getTime()),Date.now());
  return {
    pendingAtLeast:page.objects.length,hasMore:page.truncated,
    oldestListedPendingSeconds:page.objects.length?Math.floor((Date.now()-oldest)/1000):0
  };
}
