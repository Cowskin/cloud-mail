import { env } from 'cloudflare:test';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import email from '../src/entity/email';
import account from '../src/entity/account';
import user from '../src/entity/user';
import {att} from '../src/entity/att';
import migration from '../migrations/20261116_mail_stability.sql?raw';
import {bufferedEmail,consumeMail,deliverBuffered,recoverMail} from '../src/email/mail-buffer';
import {receiveOnce,finishDelivery} from '../src/email/delivery-store';
import {isTransientD1,retryD1Read} from '../src/utils/d1-retry';
import emailService from '../src/service/email-service';

const raw=new TextEncoder().encode('From: sender@example.test\r\nTo: box@example.test\r\nSubject: Recovery 中文\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nRetained recovery message 中文');
const setting={receive:0,noRecipient:1,emailPrefixFilter:'',aiCode:1,tgBotStatus:1,forwardStatus:1};
beforeAll(async()=>{
  for (const table of [email,account,user,att]) {
    const config=getTableConfig(table);
    const columns=config.columns.map(c=>`"${c.name}" ${c.getSQLType()} ${c.primary?'PRIMARY KEY':''} DEFAULT ${c.getSQLType()==='integer'?'0':"''"}`);
    await env.db.prepare(`CREATE TABLE "${config.name}" (${columns.join(',')})`).run();
  }
  for (const statement of migration.match(/CREATE (?:TABLE|INDEX)[\s\S]*?;|CREATE TRIGGER[\s\S]*?END;/g)) await env.db.prepare(statement).run();
  await env.db.prepare("INSERT INTO account(account_id,email,user_id) VALUES(1,'box@example.test',1)").run();
  await env.db.prepare("INSERT INTO user(user_id,email) VALUES(1,'admin@example.test')").run();
  await env.kv.put('setting:',JSON.stringify(setting));
});
afterEach(()=>vi.restoreAllMocks());

const message=()=>({from:'sender@example.test',to:'box@example.test',raw:new Response(raw).body,headers:new Headers(),setReject:vi.fn(),forward:vi.fn()});
const context={waitUntil:vi.fn()};
const live=(extra={})=>({...env,admin:'admin@example.test',domain:['example.test'],...extra});
const queue=()=>({send:vi.fn().mockResolvedValue(undefined)});
const key='pending/2026-11-16/12345678-1234-1234-1234-123456789abc.eml';
const store=()=>env.MAIL_SPOOL.put(key,raw,{customMetadata:{from:'sender@example.test',to:'box@example.test'}});

describe('durable incoming mail',()=>{
  it('persists raw mail before D1 access; overload is retained for automatic recovery',async()=>{
    const transport=queue();
    const offline=live({db:{prepare(){throw new Error('D1_ERROR: D1 DB is overloaded');}},MAIL_QUEUE:transport});
    const incoming=message();
    await bufferedEmail(incoming,offline,context);
    expect(incoming.setReject).not.toHaveBeenCalled();
    const sentKey=transport.send.mock.calls[0][0].key;
    expect(await (await env.MAIL_SPOOL.get(sentKey)).arrayBuffer()).toEqual(raw.buffer);
    await deliverBuffered(sentKey,live(),context);
    expect(await env.MAIL_SPOOL.get(sentKey)).toBeNull();
    const receipt=await env.db.prepare('SELECT state,email_id FROM email_delivery WHERE delivery_key=?').bind(sentKey).first();
    expect(receipt.state).toBe('delivered');
    const received=await env.db.prepare('SELECT subject,text FROM email WHERE email_id=?').bind(receipt.email_id).first();
    expect(received.subject).toContain('中文');
    expect(received.text).toContain('Retained recovery message 中文');
  });
  it('propagates a durable storage failure without falsely accepting delivery',async()=>{
    const transport=queue();
    await expect(bufferedEmail(message(),live({MAIL_SPOOL:{put:vi.fn().mockRejectedValue(new Error('R2 unavailable'))},MAIL_QUEUE:transport}),context)).rejects.toThrow('R2 unavailable');
    expect(transport.send).not.toHaveBeenCalled();
  });
  it('keeps the raw copy when queue submission fails and D1 is unavailable',async()=>{
    const transport={send:vi.fn().mockRejectedValue(new Error('Queue unavailable'))};
    await bufferedEmail(message(),live({MAIL_QUEUE:transport,db:{prepare(){throw new Error('D1_ERROR: overloaded');}}}),context);
    const sentKey=transport.send.mock.calls[0][0].key;
    expect(await env.MAIL_SPOOL.head(sentKey)).not.toBeNull();
  });
  it('inserts one email under concurrent replay and never resurrects a completed deleted email',async()=>{
    const params={userId:1,accountId:1,isDel:1,status:6,text:'body',content:'<p>body</p>'};
    const [a,b]=await Promise.all([receiveOnce({env},key,params),receiveOnce({env},key,params)]);
    expect(a.emailId).toBe(b.emailId);
    expect(await finishDelivery(env,key,a.emailId,0)).toBe(true);
    expect(await finishDelivery(env,key,a.emailId,0)).toBe(false);
    await env.db.prepare('DELETE FROM email WHERE email_id=?').bind(a.emailId).run();
    await store();
    await deliverBuffered(key,live(),context);
    expect(await env.db.prepare('SELECT email_id FROM email WHERE email_id=?').bind(a.emailId).first()).toBeNull();
    expect(await env.MAIL_SPOOL.head(key)).toBeNull();
  });
  it('only acknowledges queue delivery after success and retries failures with backoff',async()=>{
    await store();
    const m={body:{key},attempts:2,ack:vi.fn(),retry:vi.fn()};
    await consumeMail({messages:[m]},live({db:{prepare(){throw new Error('D1_ERROR: overloaded');}}}),context);
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.retry).toHaveBeenCalledWith({delaySeconds:120});
    expect(await env.MAIL_SPOOL.head(key)).not.toBeNull();
  });
  it('requeues old orphaned raw messages even without a surviving Queue message',async()=>{
    const transport=queue();
    const spool={list:vi.fn().mockResolvedValue({objects:[{key,uploaded:new Date(Date.now()-600000)}],truncated:false})};
    await recoverMail(live({MAIL_SPOOL:spool,MAIL_QUEUE:transport}));
    expect(transport.send).toHaveBeenCalledWith({key});
  });
  it('retains a partially saved email when attachment storage fails, then completes it once',async()=>{
    const mime='From: sender@example.test\r\nTo: box@example.test\r\nSubject: Attachment recovery\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nRetained text\r\n--b\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="test.txt"\r\n\r\nAttachment bytes\r\n--b--';
    const duplicatedMime=mime.replace('--b--','--b\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="test.txt"\r\n\r\nAttachment bytes\r\n--b--');
    const transport=queue();
    const realPut=env.kv.put.bind(env.kv);
    const kv={get:env.kv.get.bind(env.kv),put:vi.fn().mockRejectedValue(new Error('Attachment storage unavailable'))};
    await bufferedEmail({...message(),raw:new Response(duplicatedMime).body},live({MAIL_QUEUE:transport,kv}),context);
    const bufferedKey=transport.send.mock.calls[0][0].key;
    const before=await env.db.prepare('SELECT state,email_id FROM email_delivery WHERE delivery_key=?').bind(bufferedKey).first();
    expect(before.state).toBe('pending');
    await emailService.completeReceiveAll({env});
    expect(await env.db.prepare('SELECT status FROM email WHERE email_id=?').bind(before.email_id).first('status')).toBe(6);
    await deliverBuffered(bufferedKey,live({kv:{get:env.kv.get.bind(env.kv),put:realPut}}),context);
    expect(await env.db.prepare('SELECT count(*) AS n FROM attachments WHERE email_id=?').bind(before.email_id).first('n')).toBe(2);
    expect(await env.db.prepare('SELECT status,is_del FROM email WHERE email_id=?').bind(before.email_id).first()).toEqual({status:0,is_del:0});
  });
  it('keeps a policy rejection final even if the raw cleanup failed',async()=>{
    await env.kv.put('setting:',JSON.stringify({...setting,receive:1}));
    const transport=queue();
    const incoming=message();
    await bufferedEmail(incoming,live({MAIL_QUEUE:transport,MAIL_SPOOL:{put:env.MAIL_SPOOL.put.bind(env.MAIL_SPOOL),delete:vi.fn().mockRejectedValue(new Error('Cleanup unavailable'))}}),context);
    expect(incoming.setReject).toHaveBeenCalledWith('Service suspended');
    const bufferedKey=transport.send.mock.calls[0][0].key;
    await env.kv.put('setting:',JSON.stringify(setting));
    await deliverBuffered(bufferedKey,live(),context);
    const receipt=await env.db.prepare('SELECT email_id,state FROM email_delivery WHERE delivery_key=?').bind(bufferedKey).first();
    expect(receipt).toEqual({email_id:null,state:'rejected'});
    expect(await env.MAIL_SPOOL.head(bufferedKey)).toBeNull();
  });
  it('recovers an ambiguous committed insert without duplicating email or attachment metadata',async()=>{
    let committed=false;
    const uncertain={...env.db,prepare:env.db.prepare.bind(env.db),async batch(statements){const result=await env.db.batch(statements);if(!committed){committed=true;throw new Error('Connection reset after commit');}return result;}};
    const params={userId:1,accountId:1,isDel:1,status:6,text:'Recover after commit'};
    await expect(receiveOnce({env:{db:uncertain}},key,params)).rejects.toThrow('after commit');
    const second=await receiveOnce({env},key,params);
    expect(await env.db.prepare('SELECT count(*) AS n FROM email WHERE text=?').bind(params.text).first('n')).toBe(1);
    expect(second.state).toBe('pending');
  });
  it('keeps committed delivery final when its completion response is lost',async()=>{
    const params={userId:1,accountId:1,isDel:1,status:6,text:'Committed completion'};
    const receipt=await receiveOnce({env},key,params);
    const uncertain={prepare:env.db.prepare.bind(env.db),async batch(statements){
      await env.db.batch(statements);
      throw new Error('Connection reset after completion commit');
    }};
    await expect(finishDelivery({db:uncertain},key,receipt.emailId,0)).rejects.toThrow('after completion commit');
    await store();
    await deliverBuffered(key,live(),context);
    expect(await env.db.prepare('SELECT state FROM email_delivery WHERE delivery_key=?').bind(key).first('state')).toBe('delivered');
    expect(await env.db.prepare('SELECT count(*) AS n FROM email WHERE text=? AND status=0 AND is_del=0').bind(params.text).first('n')).toBe(1);
    expect(await env.MAIL_SPOOL.head(key)).toBeNull();
  });
  it('cycles orphan-recovery pages without enqueueing recently buffered messages',async()=>{
    const transport=queue();
    const old={key,uploaded:new Date(Date.now()-600000)};
    const nextKey=key.replace('12345678','87654321');
    const spool={list:vi.fn()
      .mockResolvedValueOnce({objects:[old,{key:'recent',uploaded:new Date()}],truncated:true,cursor:'opaque-next-page'})
      .mockResolvedValueOnce({objects:[{...old,key:nextKey}],truncated:false})};
    const runtime=live({MAIL_SPOOL:spool,MAIL_QUEUE:transport});
    await recoverMail(runtime);
    await recoverMail(runtime);
    expect(spool.list).toHaveBeenNthCalledWith(2,{prefix:'pending/',limit:100,cursor:'opaque-next-page'});
    expect(transport.send.mock.calls.map(([body])=>body.key)).toEqual([key,nextKey]);
    expect(await env.kv.get('mail-buffer-recovery-cursor')).toBeNull();
  });
});

describe('bounded safe read retry',()=>{
  it('recognizes nested overload, retries reads, and propagates index/schema errors immediately',async()=>{
    expect(isTransientD1(new Error('Failed query',{cause:new Error('D1_ERROR: D1 DB is overloaded')}))).toBe(true);
    const read=vi.fn().mockRejectedValueOnce(new Error('D1_ERROR: overloaded')).mockResolvedValue(42);
    expect(await retryD1Read(read,[0])).toBe(42);
    const invalid=vi.fn().mockRejectedValue(new Error('D1_ERROR: no such index'));
    await expect(retryD1Read(invalid,[0])).rejects.toThrow('no such index');
    expect(invalid).toHaveBeenCalledTimes(1);
  });
});
