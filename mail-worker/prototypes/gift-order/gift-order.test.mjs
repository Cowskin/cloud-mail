import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GiftOrderEngine } from './engine.mjs';
import { extractGiftEvent } from './extract.mjs';
import { localReceiver,localTransport } from './local-ws.mjs';
import { BASE,CARD,OTHER_CARD,FINGERPRINT_SECRET,confirmation,cardMail,simulationProtection } from './fixtures.mjs';

const minute = n => BASE+n*60_000;
async function setup(mails, callback) {
  const engine = new GiftOrderEngine({fingerprintSecret:FINGERPRINT_SECRET,clock:()=>minute(60)});
  try { for(const mail of mails) await engine.ingest(mail); await callback(engine); }
  finally { engine.close(); }
}
const runtime = await simulationProtection('CardTest-2026!');
function sink() { const messages=[]; return {messages,send:async message=>{messages.push(message);}}; }

test('extracts the Apple pair using full names, case-insensitive addresses, exact cents and the actual receipt timestamp',()=>{
  const a=extractGiftEvent(confirmation()),b=extractGiftEvent(cardMail());
  assert.deepEqual(a.issues,[]);assert.deepEqual(b.issues,[]);
  assert.equal(a.personKey,b.personKey);assert.equal(a.recipientKey,b.recipientKey);
  assert.equal(a.amountMinor,14995);assert.equal(a.currency,'USD');assert.equal(a.orderId,'W1000000001');
  assert.equal(b.rawCard,CARD);assert.equal(b.receivedAt-a.receivedAt,13*60_000);
  assert.equal(extractGiftEvent({...cardMail(),sendEmail:'attacker@example.test'}),null);
});
test('handles HTML entities and grouped PIN text, but does not guess currency or malformed amounts',()=>{
  const a=extractGiftEvent(confirmation({person:'Demo &amp; Recipient'}));
  const b=extractGiftEvent(cardMail({person:'Demo & Recipient',card:'XDEM 1234 5678 ABCD'}));
  assert.equal(a.personKey,b.personKey);assert.equal(b.rawCard,CARD);
  assert.ok(extractGiftEvent(cardMail({face:'1,49.95'})).issues.includes('amount_or_currency_unclear'));
  const unknown=cardMail();unknown.content=unknown.content.replace('CREDIT-USA','CREDIT-UNKNOWN');
  assert.ok(extractGiftEvent(unknown).issues.includes('amount_or_currency_unclear'));
});
test('uses the indexed unique match and emits only compatible ciphertext, then does not emit again',async()=>{
  await setup([confirmation(),cardMail()],async engine=>{
    assert.equal(engine.reconcile(minute(15))[0].state,'matched');
    assert.ok(engine.queryPlan(2).some(p=>p.includes('idx_gift_order_candidates')));
    const transport=sink();await engine.flush({protection:runtime,transport});await engine.flush({protection:runtime,transport});
    assert.equal(transport.messages.length,1);const output=JSON.stringify(transport.messages);
    assert.match(output,/W1000000001/);assert.match(output,/JG_XDEM_RUVJG1VADM3J_ABCD/);assert.match(output,/149\.95/);
    assert.doesNotMatch(output,new RegExp(CARD));assert.doesNotMatch(JSON.stringify(engine.metadata()),new RegExp(CARD));
    assert.doesNotMatch(JSON.stringify(engine.jobs()),/JG_|XDEM|password|sealed_key/);
  });
});
test('waits for an out-of-order confirmation instead of immediately issuing a missing-order alert',async()=>{
  await setup([cardMail({minutes:0})],async engine=>{
    assert.equal(engine.reconcile(minute(2))[0].state,'waiting_for_order');assert.equal(engine.jobs().length,0);
    await engine.ingest(confirmation({minutes:10}));assert.equal(engine.reconcile(minute(12))[0].state,'matched');
  });
});
test('missing order produces an encrypted manual-review notification only after the waiting window',async()=>{
  await setup([cardMail()],async engine=>{
    assert.equal(engine.reconcile(minute(42))[0].state,'waiting_for_order');
    assert.equal(engine.reconcile(minute(43))[0].reason,'order_not_found');const transport=sink();
    await engine.flush({protection:runtime,transport});const text=transport.messages[0].body.text.content;
    assert.match(text,/未关联（需人工确认）/);assert.match(text,/JG_/);assert.doesNotMatch(text,new RegExp(CARD));
  });
});
test('never guesses the nearest of multiple matching orders',async()=>{
  await setup([confirmation(),confirmation({emailId:3,orderId:'W1000000002',minutes:12}),cardMail()],async engine=>{
    assert.equal(engine.reconcile(minute(15))[0].reason,'multiple_orders');assert.equal(engine.jobs()[0].order_email_id,null);
  });
});
test('does not discard a multiple-quantity candidate to manufacture a unique match',async()=>{
  await setup([confirmation(),confirmation({emailId:3,orderId:'W1000000002',quantity:2}),cardMail()],async engine=>{
    assert.equal(engine.reconcile(minute(15))[0].reason,'multiple_orders');
  });
});
test('rechecks associations before sending when another order arrives while the notification is queued',async()=>{
  await setup([confirmation(),cardMail()],async engine=>{
    engine.reconcile(minute(15));assert.equal(engine.jobs()[0].relation,'matched');
    await engine.ingest(confirmation({emailId:3,orderId:'W1000000002',minutes:14}));const transport=sink();
    await engine.flush({protection:runtime,transport});assert.match(transport.messages[0].body.text.content,/未关联（需人工确认）/);
    assert.doesNotMatch(transport.messages[0].body.text.content,/W1000000001/);
  });
});
test('one single-card order cannot be automatically assigned to two distinct cards, including a not-yet-settled rival',async()=>{
  await setup([confirmation(),cardMail(),cardMail({emailId:3,card:OTHER_CARD,minutes:14})],async engine=>{
    assert.equal(engine.reconcile(minute(15))[0].reason,'multiple_cards');
    engine.reconcile(minute(16));assert.ok(engine.jobs().every(j=>j.relation==='manual'&&j.order_email_id===null));
  });
});
test('deduplicates a resent card and duplicate confirmation using password-independent HMAC keys',async()=>{
  await setup([confirmation(),cardMail()],async engine=>{
    assert.equal((await engine.ingest(cardMail({emailId:4,minutes:14}))).duplicate,true);
    assert.equal((await engine.ingest(confirmation({emailId:5}))).duplicate,true);
    assert.equal(engine.metadata().length,2);assert.equal(engine.reconcile(minute(16))[0].state,'matched');
  });
});
for(const [name,overrides] of [['mailbox',{toEmail:'other@example.test'}],['full name',{person:'Another Recipient'}],
  ['amount',{face:'150.00'}],['owner',{userId:2}],['mailbox ownership',{accountId:9}]]){
  test(`does not cross-match a different ${name}`,async()=>{
    await setup([confirmation(),cardMail(overrides)],async engine=>{
      assert.equal(engine.reconcile(minute(44))[0].reason,'order_not_found');assert.equal(engine.jobs()[0].order_email_id,null);
    });
  });
}
test('does not match an order older than 24 hours',async()=>{
  await setup([confirmation(),cardMail({minutes:1500})],async engine=>{
    assert.equal(engine.reconcile(minute(1531))[0].reason,'order_not_found');
  });
});
test('multiple quantities and an explicitly failed sender attestation require manual review',async()=>{
  await setup([confirmation({quantity:2}),cardMail()],async engine=>{
    assert.equal(engine.reconcile(minute(15))[0].reason,'order_requires_review');
  });
  await setup([confirmation(),cardMail({trustedSender:false})],async engine=>{
    assert.equal(engine.reconcile(minute(15))[0].reason,'sender_not_authenticated');
  });
});
test('unparseable or multiple PINs never leak original strings through the manual-review notification',async()=>{
  await setup([confirmation(),cardMail({card:CARD+' '+OTHER_CARD})],async engine=>{
    engine.reconcile(minute(15));const transport=sink();await engine.flush({protection:runtime,transport});
    assert.match(transport.messages[0].body.text.content,/未识别（需人工处理）/);
    assert.doesNotMatch(JSON.stringify(transport.messages),new RegExp(CARD+'|'+OTHER_CARD));
  });
});
test('manual notification metadata cannot reintroduce an unencrypted card-shaped mailbox',async()=>{
  await setup([cardMail({toEmail:CARD+'@example.test'})],async engine=>{
    engine.reconcile(minute(44));const transport=sink();await engine.flush({protection:runtime,transport});
    const output=transport.messages[0].body.text.content;
    assert.match(output,/请按来源邮件ID定位/);assert.match(output,/来源邮件ID：2/);assert.doesNotMatch(output,new RegExp(CARD,'i'));
  });
});
test('encryption off or an unavailable cipher never sends plaintext, while queued jobs can resume after enabling',async()=>{
  await setup([confirmation(),cardMail()],async engine=>{
    engine.reconcile(minute(15));const transport=sink();const protection=await simulationProtection();protection.setEnabled(false);
    assert.equal((await engine.flush({protection,transport}))[0].state,'blocked_encryption_off');assert.equal(transport.messages.length,0);
    protection.setEnabled(true);const unavailable={read:protection.read,encrypt:async()=>{throw Error('Unavailable');}};
    assert.equal((await engine.flush({protection:unavailable,transport}))[0].state,'blocked_encryption_unavailable');assert.equal(transport.messages.length,0);
    await engine.flush({protection,transport});assert.equal(transport.messages.length,1);
  });
});
test('re-checks policy at send time and encrypts pending jobs with the replacement password without rebuilding metadata',async()=>{
  await setup([confirmation(),cardMail()],async engine=>{
    engine.reconcile(minute(15));const before=JSON.stringify(engine.metadata());const protection=await simulationProtection();const transport=sink();
    const changed={read:protection.read,encrypt:async(raw,policy)=>{const result=await protection.encrypt(raw,policy);protection.setEnabled(false);return result;}};
    assert.equal((await engine.flush({protection:changed,transport}))[0].state,'blocked_policy_changed');assert.equal(transport.messages.length,0);
    protection.setEnabled(true);await protection.rotate('CardTest-2026!');await engine.flush({protection,transport});
    assert.match(transport.messages[0].body.text.content,/JG_XDEM_RUVJG1VADM3J_ABCD/);assert.equal(JSON.stringify(engine.metadata()),before);
  });
});
test('a real loopback WebSocket receiver deduplicates retry after losing the first ACK',async()=>{
  const receiver=await localReceiver({dropFirstAck:true});
  try {await setup([confirmation(),cardMail()],async engine=>{
    engine.reconcile(minute(15));const transport=localTransport(receiver.url);
    assert.equal((await engine.flush({protection:runtime,transport}))[0].state,'retry_pending');
    assert.equal((await engine.flush({protection:runtime,transport}))[0].state,'sent');
    assert.equal(receiver.messages().length,1);assert.equal(receiver.frameCount(),2);assert.equal(engine.jobs()[0].attempts,2);
  });}finally{await receiver.close();}
  assert.throws(()=>localTransport('wss://example.test/ws'),/loopback/);
});
test('pending notification and small-field metadata survive a local process restart',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'cloudmail-gift-order-'));
  const options={fingerprintSecret:FINGERPRINT_SECRET,database:join(folder,'prototype.sqlite'),clock:()=>minute(60)};
  let first,second;
  try {
    first=new GiftOrderEngine(options);await first.ingest(confirmation());await first.ingest(cardMail());first.reconcile(minute(15));
    await first.flush({protection:runtime,transport:{send:async()=>{throw Error('Synthetic network failure');}}});
    first.close();first=null;second=new GiftOrderEngine(options);const transport=sink();
    await second.flush({protection:runtime,transport});assert.equal(transport.messages.length,1);assert.equal(second.jobs()[0].state,'sent');
    assert.equal((await second.ingest(cardMail())).duplicate,true);
  }finally{first?.close();second?.close();rmSync(folder,{recursive:true,force:true});}
});
