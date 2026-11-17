import { env,SELF,fetchMock } from 'cloudflare:test';
import { beforeAll,beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import email from '../src/entity/email';
import user from '../src/entity/user';
import account from '../src/entity/account';
import role from '../src/entity/role';
import perm from '../src/entity/perm';
import rolePerm from '../src/entity/role-perm';
import verifyRecord from '../src/entity/verify-record';
import protection from '../src/service/card-protection-service';
import config from '../src/service/gift-webhook-config';
import { runGiftNotifications } from '../src/service/gift-notification-service';
import { postWecom,postWebhook,validateWebhook,webhookTarget } from '../src/utils/gift-webhook';
import { createCipher,deriveMaterial } from '../src/utils/card-cipher';
import { extractGiftEvent } from '../src/utils/gift-order';
import jwtUtils from '../src/utils/jwt-utils';
import kvConst from '../src/const/kv-const';
import protectionSql from '../migrations/20261116_card_protection.sql?raw';
import webhookSql from '../migrations/20261116_gift_webhook.sql?raw';
import { BASE,CARD,confirmation,cardMail } from '../prototypes/gift-order/fixtures.mjs';

const c = {env}, password = 'CardTest-2026!';
const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fictional-test-only-key';
const feishuUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/00000000-1111-2222-3333-444444444444';
const send = vi.fn().mockResolvedValue(undefined);
let adminToken,userToken;
async function insert(mail) {
  await env.db.prepare(`INSERT INTO email(email_id,user_id,account_id,to_email,send_email,name,subject,content,text,message_id,create_time,type,status,is_del)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,0,0,0)`).bind(mail.emailId,mail.userId,mail.accountId,mail.toEmail,mail.sendEmail,mail.name,
      mail.subject,mail.content || '',mail.text || '',mail.messageId,mail.receivedAt.replace('T',' ').slice(0,19)).run();
}
const enable = () => protection.update(c,{action:'enable',version:1,newPassword:password,confirmPassword:password});
async function configure() {
  const result = await config.update(c,{version:1,protectionVersion:2,url});
  // The fixtures have a deterministic receive clock, independent of wall time.
  await env.db.prepare("UPDATE gift_webhook_config SET capture_after='2026-11-16 10:00:00'").run();
  return result;
}
const run = minute => runGiftNotifications(env,{now:BASE+minute*60000,send});
const job = () => env.db.prepare('SELECT * FROM gift_notification ORDER BY card_email_id LIMIT 1').first();
async function seed() {
  await enable(); await configure(); await insert(confirmation()); await insert(cardMail());
  await run(13); // Parse, but the two-minute settling window has not elapsed.
}
async function request(path,{token=adminToken,body}={}) {
  return (await SELF.fetch('https://example.test/api'+path,{
    method:body?'PUT':'GET',headers:{Authorization:token,'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{})
  })).json();
}
beforeAll(async()=>{
  for (const table of [email,user,account,role,perm,rolePerm,verifyRecord]) {
    const cfg = getTableConfig(table);
    const columns = cfg.columns.map(col => `"${col.name}" ${col.getSQLType()} ${col.primary?'PRIMARY KEY':''} DEFAULT ${col.getSQLType()==='integer'?'0':"''"}`);
    await env.db.prepare(`CREATE TABLE "${cfg.name}" (${columns.join(',')})`).run();
  }
  for (const s of protectionSql.replace(/^--.*$/gm,'').split(';').filter(s=>s.trim())) await env.db.prepare(s).run();
  for (const s of webhookSql.match(/CREATE TABLE[\s\S]*?;|CREATE INDEX[\s\S]*?;|CREATE TRIGGER[\s\S]*?END;|INSERT OR IGNORE[\s\S]*?;/g)) await env.db.prepare(s).run();
  for (const [id,address] of [[1,'admin@example.test'],[2,'user@example.test']]) {
    await env.db.prepare('INSERT INTO user(user_id,email,type) VALUES(?,?,2)').bind(id,address).run();
    const session = `webhook-test-session-${id}`;
    await env.kv.put(kvConst.AUTH_INFO+id,JSON.stringify({tokens:[session],user:{userId:id,email:address},refreshTime:new Date().toISOString()}));
    const token = await jwtUtils.generateToken(c,{userId:id,token:session},3600);
    if (id===1) adminToken=token; else userToken=token;
  }
});
beforeEach(()=>{send.mockClear();});
afterEach(()=>vi.restoreAllMocks());

describe('gift webhook configuration',()=>{
  it('requires protection, seals the URL and displays the saved URL in system settings',async()=>{
    await expect(configure()).rejects.toMatchObject({code:409});
    await expect(config.update(c,{version:1,protectionVersion:1,url})).rejects.toMatchObject({code:400});
    await enable();
    expect(await configure()).toEqual({version:2,configured:true,active:true,provider:'wecom',url});
    const row = await config.read(c);
    expect(JSON.stringify(row)).not.toContain('fictional-test-only-key');
    expect(await config.url(c,row)).toBe(url);
    expect((await config.status(c)).url).toBe(url);
    await expect(configure()).rejects.toMatchObject({code:409});
    await expect(config.url({env:{...env,CARD_PROTECTION_SECRET:undefined}},row)).rejects.toMatchObject({code:503});
  });
  it('displays the URL only through authorized non-cacheable system settings endpoints',async()=>{
    for (const path of ['/setting/giftWebhook/status','/setting/giftWebhook/update']) {
      const body = path.endsWith('update') ? {version:1,protectionVersion:1,url} : undefined;
      expect((await request(path,{token:'',body})).code).toBe(401);
      expect((await request(path,{token:userToken,body})).code).toBe(403);
    }
    await enable();
    expect(await request('/setting/giftWebhook/update',{body:{version:1,protectionVersion:2,url}})).toMatchObject({code:200,data:{configured:true}});
    expect(await request('/setting/giftWebhook/status')).toMatchObject({code:200,data:{configured:true,provider:'wecom',url}});
    const response = await SELF.fetch('https://example.test/api/setting/giftWebhook/status',{headers:{Authorization:adminToken}});
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    await env.kv.put(kvConst.SETTING,JSON.stringify({emailPrefixFilter:'',resendTokens:{}}));
    for (const path of ['/setting/query','/setting/websiteConfig']) {
      const result = await request(path);
      expect(result.code).toBe(200);
      expect(JSON.stringify(result)).not.toContain('fictional-test-only');
    }
  });
  it('keeps the saved URL readable while protection is off and clears it when removed',async()=>{
    await enable(); await configure();
    await protection.update(c,{action:'disable',version:2,currentPassword:password});
    expect(await config.status(c)).toMatchObject({active:false,url});
    expect(await config.update(c,{version:2,protectionVersion:3,remove:true})).toMatchObject({configured:false,url:''});
  });
  it('leaves queued work and the capture boundary intact when the same URL is saved again',async()=>{
    await seed();
    const before = await config.read(c);
    expect(await config.update(c,{version:2,protectionVersion:2,url:' '+url+' '})).toMatchObject({version:2,url});
    expect(await config.read(c)).toEqual(before);
    expect((await job()).state).toBe('pending');
    await expect(config.update(c,{version:1,protectionVersion:2,url})).rejects.toMatchObject({code:409});
    await run(15); expect(send).toHaveBeenCalledOnce();
  });
  it('rejects a concurrent replacement even when the submitted URL was initially unchanged',async()=>{
    await enable(); await configure();
    const original = config.url.bind(config);
    vi.spyOn(config,'url').mockImplementationOnce(async(...args)=>{
      const value = await original(...args);
      await config.update(c,{version:2,protectionVersion:2,url:url.replace('fictional','replacement')});
      return value;
    });
    await expect(config.update(c,{version:2,protectionVersion:2,url})).rejects.toMatchObject({code:409});
  });
  it('limits destinations to the official HTTPS robot endpoint',()=>{
    for (const invalid of ['http://127.0.0.1/send','https://example.test/send',url+'&extra=1',url+'&key=another-key',
      url.replace('qyapi.weixin.qq.com','qyapi.weixin.qq.com.evil.test'),url.replace('/send?','/upload_media?'),
      url+'#fragment',url.replace('https://','https://user:secret@')]) {
      expect(()=>validateWebhook(invalid)).toThrow('valid WeCom or Feishu');
    }
    expect(validateWebhook(' '+url+' ')).toBe(url);
  });
});

describe('durable receive, matching and delivery',()=>{
  it('enrolls only newly inserted candidate emails after configuration; scans no historic bodies',async()=>{
    await insert(confirmation()); await enable(); await configure();
    expect(await env.db.prepare('SELECT count(*) n FROM gift_mail_work').first('n')).toBe(0);
    await insert(cardMail()); await run(13);
    expect(await env.db.prepare('SELECT count(*) n FROM gift_mail_event').first('n')).toBe(1);
    expect(send).not.toHaveBeenCalled();
    await run(43);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1].text.content).toContain('需人工确认');
    expect(send.mock.calls[0][1].text.content).toContain('JG_XDEM_');
    expect(JSON.stringify(send.mock.calls)).not.toContain(CARD);
  });
  it('excludes old buffered mail delivered after configuration and does not backfill it on re-enable',async()=>{
    await enable(); await configure();
    await insert(confirmation({minutes:-60}));
    expect(await env.db.prepare('SELECT count(*) n FROM gift_mail_work').first('n')).toBe(0);
    await protection.update(c,{action:'disable',version:2,currentPassword:password});
    await protection.update(c,{action:'enable',version:3,newPassword:password,confirmPassword:password});
    await insert(cardMail({receivedAt:new Date(Date.now()-60000).toISOString()}));
    expect(await env.db.prepare('SELECT count(*) n FROM gift_mail_work').first('n')).toBe(0);
  });
  it('matches stored mail fields, preserves originals and deduplicates card resends',async()=>{
    await seed(); await run(15);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]).toEqual([url,{msgtype:'text',text:{content:expect.stringContaining('原始订单：W1000000001')}}]);
    expect((await job()).state).toBe('sent');
    expect(JSON.stringify((await env.db.prepare('SELECT * FROM gift_mail_event').all()).results)).not.toContain(CARD);
    expect(await env.db.prepare('SELECT content FROM email WHERE email_id=2').first('content')).toContain(CARD);
    await insert(cardMail({emailId:4,minutes:14})); await run(18);
    expect(send).toHaveBeenCalledOnce();
    expect(await env.db.prepare('SELECT count(*) n FROM gift_notification').first('n')).toBe(1);
  });
  it('delivers queued mail with the default sender through Workers fetch',async()=>{
    await seed();
    fetchMock.activate(); fetchMock.disableNetConnect();
    try {
      fetchMock.get('https://qyapi.weixin.qq.com').intercept({path:'/cgi-bin/webhook/send?key=fictional-test-only-key',method:'POST',
        body:value=>typeof value==='string' && value.includes('JG_XDEM_') && !value.includes(CARD)})
        .reply(200,{errcode:0});
      await runGiftNotifications(env,{now:BASE+15*60000});
      expect(await job()).toMatchObject({state:'sent',attempts:1,last_error:null});
      fetchMock.assertNoPendingInterceptors();
    } finally { fetchMock.deactivate(); }
  });
  it('persists safe transport reasons without copying downstream details',async()=>{
    await seed();
    const error = new Error('secret response details'); error.deliveryReason='wecom_error_93000';
    send.mockRejectedValueOnce(error);
    await run(15);
    expect(await job()).toMatchObject({state:'pending',last_error:'wecom_error_93000'});
    error.deliveryReason=url;
    send.mockRejectedValueOnce(error);
    await run(18);
    expect(await job()).toMatchObject({state:'pending',last_error:'webhook_delivery_failed'});
  });
  it('correlates records without claiming that a From header authenticates the sender',async()=>{
    await seed(); await run(15);
    expect((await job()).relation).toBe('matched');
    const stored = await env.db.prepare('SELECT content FROM email WHERE email_id=2').first('content');
    expect(extractGiftEvent({...cardMail(),content:stored,trustedSender:undefined}).senderAuthenticated).toBe(false);
    expect(send.mock.calls[0][1].text.content).toContain('原始订单：W1000000001');
  });
  it('waits for an out-of-order confirmation and falls back after 30 minutes',async()=>{
    await enable(); await configure(); await insert(cardMail()); await run(13);
    await run(15); expect(send).not.toHaveBeenCalled();
    await run(43); expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1].text.content).toContain('未找到符合条件');
  });
  it('rechecks competing orders before sending instead of choosing the most recent one',async()=>{
    await seed();
    await insert(confirmation({emailId:3,orderId:'W1000000002',minutes:14}));
    await run(15);
    expect((await job()).relation).toBe('manual');
    expect((await job()).reason).toBe('multiple_orders');
    expect(send.mock.calls[0][1].text.content).not.toContain('原始订单：W');
  });
  it('uses the current password for queued notifications without rebuilding the metadata index',async()=>{
    await seed();
    const before = JSON.stringify((await env.db.prepare('SELECT * FROM gift_mail_event').all()).results);
    const nextPassword = 'new-local-test-password';
    await protection.update(c,{action:'change',version:2,currentPassword:password,newPassword:nextPassword,confirmPassword:nextPassword});
    await run(15);
    const expected = await (await createCipher(await deriveMaterial(nextPassword)))(CARD);
    expect(send.mock.calls[0][1].text.content).toContain(expected);
    expect(JSON.stringify((await env.db.prepare('SELECT * FROM gift_mail_event').all()).results)).toBe(before);
  });
  it('cancels queued notifications when protection is disabled and does not replay them on re-enable',async()=>{
    await seed();
    await protection.update(c,{action:'disable',version:2,currentPassword:password});
    expect((await job()).state).toBe('cancelled');
    expect(await config.status(c)).toMatchObject({configured:true,active:false});
    await run(15); expect(send).not.toHaveBeenCalled();
    await protection.update(c,{action:'enable',version:3,newPassword:password,confirmPassword:password});
    await run(20); expect(send).not.toHaveBeenCalled();
  });
  it('cancels old pending work when a webhook is replaced or removed',async()=>{
    await seed();
    await config.update(c,{version:2,protectionVersion:2,url:url.replace('fictional','replacement')});
    await run(20); expect(send).not.toHaveBeenCalled();
    expect((await job()).state).toBe('cancelled');
    await config.update(c,{version:3,protectionVersion:2,remove:true});
    expect(await config.status(c)).toMatchObject({configured:false,active:false});
    await insert(cardMail({emailId:4,minutes:21}));
    expect(await env.db.prepare('SELECT email_id FROM gift_mail_work WHERE email_id=4').first()).toBeNull();
  });
  it('persists delivery failures with backoff and allows a later retry without duplicating the job',async()=>{
    await seed();
    send.mockRejectedValueOnce(Error('secret downstream error must never be stored'));
    await run(15);
    expect(await job()).toMatchObject({state:'pending',attempts:1,last_error:'webhook_delivery_failed'});
    await run(16); expect(send).toHaveBeenCalledOnce();
    await run(18); expect(send).toHaveBeenCalledTimes(2);
    expect(await job()).toMatchObject({state:'sent',attempts:2,last_error:null});
  });
  it('retains an exhausted job for operational inspection instead of retrying indefinitely',async()=>{
    await seed();
    await env.db.prepare('UPDATE gift_notification SET attempts=7').run();
    send.mockRejectedValueOnce(Error('local downstream failure'));
    await run(15);
    expect(await job()).toMatchObject({state:'failed',attempts:8,last_error:'webhook_delivery_failed'});
    await run(300); expect(send).toHaveBeenCalledOnce();
  });
  it('rechecks protection if it changes while ciphertext is being generated',async()=>{
    await seed();
    const original = protection.cipher.bind(protection);
    vi.spyOn(protection,'cipher').mockImplementation(async(...args)=>{
      const encrypt = await original(...args);
      return async card=>{
        const cipher = await encrypt(card);
        await protection.update(c,{action:'disable',version:2,currentPassword:password});
        return cipher;
      };
    });
    await run(15);
    expect(send).not.toHaveBeenCalled();
    expect((await job()).state).toBe('cancelled');
  });
  it('serializes concurrent drains and respects the shared robot rate budget',async()=>{
    await seed();
    await Promise.all([run(15),run(15)]); expect(send).toHaveBeenCalledOnce();
    await env.db.prepare("UPDATE gift_notification SET state='pending',due_at=0").run();
    await env.db.prepare('UPDATE gift_webhook_rate SET minute=?,used=18').bind(Math.floor(Date.now()/60000)).run();
    await run(20); expect(send).toHaveBeenCalledOnce();
  });
  it('holds notifications until all enrolled mail has been parsed, including saving emails',async()=>{
    await seed();
    await insert(confirmation({emailId:3,orderId:'W1000000002'}));
    await env.db.prepare('UPDATE email SET status=6,is_del=1 WHERE email_id=3').run();
    expect(await run(15)).toEqual({waitingForIngest:true});
    expect(send).not.toHaveBeenCalled();
    await env.db.prepare('UPDATE email SET status=0,is_del=0 WHERE email_id=3').run();
    await run(20); expect(send).toHaveBeenCalledOnce();
    expect((await job()).reason).toBe('multiple_orders');
  });
  it('fails closed on corrupted encryption material, and retains the job for recovery',async()=>{
    await seed();
    await env.db.prepare("UPDATE card_protection SET sealed_key='broken'").run();
    await run(15); expect(send).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({state:'pending',last_error:'processing_unavailable'});
  });
});

describe('official WeCom HTTP response handling',()=>{
  it('posts the official text body and accepts only errcode zero',async()=>{
    const body = {msgtype:'text',text:{content:'local encrypted notification'}};
    const fetcher = vi.fn().mockImplementation(async()=>new Response('{"errcode":0,"errmsg":"ok"}'));
    await postWecom(url,body,{fetcher});
    expect(fetcher).toHaveBeenCalledWith(url,expect.objectContaining({method:'POST',redirect:'manual',body:JSON.stringify(body)}));
    for (const response of [new Response('{"errcode":45009}'),new Response('{}'),new Response('bad'),new Response('down',{status:503}),new Response('x'.repeat(5000))]) {
      await expect(postWecom(url,body,{fetcher:async()=>response})).rejects.toThrow('webhook_delivery_failed');
    }
  });
  it('aborts stalled requests and keeps downstream secrets out of errors',async()=>{
    const fetcher = vi.fn((_,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error(url)))));
    await expect(postWecom(url,{msgtype:'text',text:{content:'synthetic test'}},{fetcher,timeoutMs:1})).rejects.toThrow(/^webhook_delivery_failed$/);
  });
});

describe('Feishu webhook support and provider replacement',()=>{
  it.each([['wecom',url,{errcode:0,errmsg:'ok'}],['feishu',feishuUrl,{code:0}]])('sends %s through the real Workers fetch implementation',async(_,target,response)=>{
    fetchMock.activate();
    fetchMock.disableNetConnect();
    try {
      const parsed = new URL(target);
      fetchMock.get(parsed.origin).intercept({path:parsed.pathname+parsed.search,method:'POST'}).reply(200,response);
      await postWebhook(target,{msgtype:'text',text:{content:'synthetic Workers delivery regression'}});
      fetchMock.assertNoPendingInterceptors();
    } finally { fetchMock.deactivate(); }
  });
  it('refuses redirects in Workers and retains only a safe failure reason',async()=>{
    fetchMock.activate(); fetchMock.disableNetConnect();
    try {
      fetchMock.get('https://qyapi.weixin.qq.com').intercept({path:'/cgi-bin/webhook/send?key=fictional-test-only-key',method:'POST'})
        .reply(302,'redirect',{headers:{location:'https://untrusted.example.test/'}});
      await expect(postWebhook(url,{msgtype:'text',text:{content:'synthetic redirect regression'}}))
        .rejects.toMatchObject({message:'webhook_delivery_failed',deliveryReason:'http_302'});
      fetchMock.assertNoPendingInterceptors();
    } finally { fetchMock.deactivate(); }
    await expect(postWebhook(url,{msgtype:'text',text:{content:'synthetic platform error'}},{fetcher:async()=>new Response('{"errcode":93000,"errmsg":"secret downstream details"}')}))
      .rejects.toMatchObject({message:'webhook_delivery_failed',deliveryReason:'wecom_error_93000'});
  });
  it('detects official Feishu endpoints and blocks alternative hosts, paths and query parameters',()=>{
    expect(webhookTarget(feishuUrl)).toEqual({url:feishuUrl,provider:'feishu'});
    for (const invalid of [feishuUrl+'?key=extra',feishuUrl+'#secret',feishuUrl.replace('open.feishu.cn','open.feishu.cn.evil.test'),
      feishuUrl.replace('https:','http:'),feishuUrl.replace('/bot/v2/hook/','/bot/v1/hook/'),feishuUrl.replace('00000000','not-a-uuid')]) {
      expect(()=>validateWebhook(invalid)).toThrow('valid WeCom or Feishu');
    }
  });
  it('converts text to Feishu format and validates modern and legacy success codes',async()=>{
    const body = {msgtype:'text',text:{content:'local encrypted gift card test'}};
    const fetcher = vi.fn().mockImplementation(async()=>new Response('{"code":0,"msg":"success"}'));
    await postWebhook(feishuUrl,body,{fetcher});
    expect(fetcher).toHaveBeenCalledWith(feishuUrl,expect.objectContaining({method:'POST',redirect:'manual',
      body:JSON.stringify({msg_type:'text',content:{text:body.text.content}})}));
    await postWebhook(feishuUrl,body,{fetcher:async()=>new Response('{"StatusCode":0,"StatusMessage":"success"}')});
    for (const response of ['{"code":19024}','{"code":19021,"StatusCode":0}','{"errcode":0}','{}','{"code":"0"}']) {
      await expect(postWebhook(feishuUrl,body,{fetcher:async()=>new Response(response)})).rejects.toThrow(/^webhook_delivery_failed$/);
    }
  });
  it('seals a Feishu URL, sends a matched encrypted notification and later accepts a WeCom replacement',async()=>{
    await seed();
    await config.update(c,{version:2,protectionVersion:2,url:feishuUrl});
    expect(await config.status(c)).toMatchObject({configured:true,active:true,provider:'feishu'});
    expect(JSON.stringify(await config.read(c))).not.toContain('00000000-1111');
    await env.db.prepare("UPDATE gift_webhook_config SET capture_after='2026-11-16 10:00:00'").run();
    await insert(confirmation({emailId:5,orderId:'W1000000002',minutes:20}));
    await insert(cardMail({emailId:6,card:'XDEMO7K2P9Q4ABCD',minutes:25}));
    const fetcher = vi.fn().mockImplementation(async()=>new Response('{"code":0}'));
    await runGiftNotifications(env,{now:BASE+28*60000,send:(target,body)=>postWebhook(target,body,{fetcher})});
    expect(fetcher).toHaveBeenCalledOnce();
    const payload = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload.msg_type).toBe('text');
    expect(payload.content.text).toContain('原始订单：W1000000002');
    expect(payload.content.text).toContain('JG_XDEM_');
    expect(payload.content.text).not.toContain('XDEMO7K2P9Q4ABCD');
    await config.update(c,{version:3,protectionVersion:2,url});
    expect(await config.status(c)).toMatchObject({configured:true,provider:'wecom'});
  });
});
