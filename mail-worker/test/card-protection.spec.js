import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import email from '../src/entity/email';
import user from '../src/entity/user';
import account from '../src/entity/account';
import { star } from '../src/entity/star';
import { att } from '../src/entity/att';
import role from '../src/entity/role';
import perm from '../src/entity/perm';
import rolePerm from '../src/entity/role-perm';
import protection from '../src/service/card-protection-service';
import emailService from '../src/service/email-service';
import { createCipher, deriveMaterial, validPassword } from '../src/utils/card-cipher';
import { protectMail } from '../src/utils/protect-mail';
import jwtUtils from '../src/utils/jwt-utils';
import kvConst from '../src/const/kv-const';
import migration from '../migrations/20261116_card_protection.sql?raw';
import indexes from '../migrations/20261115_email_query_indexes.sql?raw';
import stability from '../migrations/20261116_mail_stability.sql?raw';

// Synthetic test data only. Expected ciphertext comes independently from the
// original CardCipher browser and apple_manage_tool compatibility tests.
const card = 'XDEM12345678ABCD', password = 'CardTest-2026!';
const expected = 'JG_XDEM_RUVJG1VADM3J_ABCD';
const context = (overrides = {}) => {
  const data = new Map();
  return { env: { ...env, ...overrides }, get: key => data.get(key), set: (key, value) => data.set(key, value) };
};
let adminToken, userToken;
beforeAll(async () => {
  for (const table of [email, user, account, star, att, role, perm, rolePerm]) {
    const config = getTableConfig(table);
    const columns = config.columns.map(c => `"${c.name}" ${c.getSQLType()} ${c.primary ? 'PRIMARY KEY' : ''} DEFAULT ${c.getSQLType() === 'integer' ? '0' : "''"}`);
    await env.db.prepare(`CREATE TABLE "${config.name}" (${columns.join(',')})`).run();
  }
  for (const sql of [migration, indexes]) for (const s of sql.replace(/^--.*$/gm, '').split(';').filter(s => s.trim())) await env.db.prepare(s).run();
  for (const s of stability.match(/CREATE (?:TABLE|INDEX)[\s\S]*?;|CREATE TRIGGER[\s\S]*?END;/g)) await env.db.prepare(s).run();
  await env.db.prepare("INSERT INTO user(user_id,email,type) VALUES(1,'admin@example.test',0),(2,'user@example.test',2)").run();
  await env.db.prepare("INSERT INTO role(role_id,name,key) VALUES(0,'Administrator','admin')").run();
  await env.db.prepare("INSERT INTO account(account_id,email,user_id) VALUES(1,'admin@example.test',1),(2,'user@example.test',2)").run();
  await env.db.prepare('INSERT INTO email(email_id,user_id,account_id,type,text,content,subject,name,to_email,send_email,recipient) VALUES(1,1,1,0,?,?,?,?,?,?,?)')
    .bind(card, `<p>${card}</p><a href="https://example.test/redeem?code=${card}">Redeem</a>`, card, 'Sender', 'admin@example.test', 'sender@example.test', '[]').run();
  await env.db.prepare('INSERT INTO email(email_id,user_id,account_id,type,text,content,subject,to_email,send_email,recipient) VALUES(2,2,2,0,?,?,?,?,?,?)')
    .bind(card, `<p>${card}</p>`, card, 'user@example.test', 'sender@example.test', '[]').run();
  await env.db.prepare('INSERT INTO star(star_id,email_id,user_id) VALUES(1,1,1)').run();
  await env.db.prepare("INSERT INTO attachments(att_id,email_id,user_id,account_id,key,type) VALUES(1,1,1,1,'attachments/test.txt',0)").run();
  for (const [id, address] of [[1, 'admin@example.test'], [2, 'user@example.test']]) {
    const session = `isolated-protection-session-${id}`;
    await env.kv.put(kvConst.AUTH_INFO + id, JSON.stringify({ tokens:[session], user:{userId:id,email:address}, refreshTime:new Date().toISOString() }));
    const token = await jwtUtils.generateToken(context(), { userId:id,token:session }, 3600);
    if (id === 1) adminToken = token; else userToken = token;
  }
  await env.kv.put(kvConst.PUBLIC_KEY, 'synthetic-public-token');
  await env.kv.put(kvConst.SETTING, JSON.stringify({resendTokens:{},emailPrefixFilter:'',r2Domain:'',register:1}));
});
beforeEach(async () => {
  await env.db.prepare('UPDATE card_protection SET enabled=0,version=1,sealed_key=NULL,verifier_salt=NULL,verifier=NULL,attempts=0,window_start=0 WHERE id=1').run();
});
const enable = () => protection.update(context(), {action:'enable',version:1,newPassword:password,confirmPassword:password});
async function request(path, {token = adminToken, body, method} = {}) {
  return SELF.fetch('https://example.test/api' + path, {
    method: method || (body ? 'POST' : 'GET'), headers: {Authorization:token,'Content-Type':'application/json'},
    ...(body ? {body:JSON.stringify(body)} : {})
  });
}

describe('CardCipher compatibility and protected mail', () => {
  it('keeps the compatible 210,000 rounds when hosted WebCrypto rejects PBKDF2', async () => {
    const native = vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValue(new DOMException(
      'Pbkdf2 failed: iteration counts above 100000 are not supported (requested 210000).', 'NotSupportedError'));
    let material;
    try {
      material = await deriveMaterial(password);
      expect(await (await createCipher(material))(card)).toBe(expected);
    } finally {
      material?.fill(0);
      native.mockRestore();
    }
  });
  it('matches independent fixed-8/v2 vectors, including Unicode and significant spaces', async () => {
    const material = await deriveMaterial(password);
    const encrypt = await createCipher(material);
    expect(await encrypt(card)).toBe(expected);
    expect(await encrypt('XDEMO7K2P9Q4ABCD')).toBe('JG_XDEM_DY9T4769OML9_ABCD');
    expect(await (await createCipher(await deriveMaterial(' 密码Aa-2026 ')))(card)).toBe('JG_XDEM_3WT0E5UABZE1_ABCD');
    expect(validPassword('line1\nline2')).toBe(false);
    expect(validPassword('\uD800')).toBe(false);
    expect(validPassword('a'.repeat(1025))).toBe(false);
  });
  it('defaults off without requiring a sealing secret or changing originals', async () => {
    expect(await protection.status(context({CARD_PROTECTION_SECRET:undefined}))).toEqual({enabled:false,version:1,configured:false,ready:false});
    const mail = {subject:card,content:`<p>${card}</p>`,attList:[{key:'kept'}]};
    expect(await protectMail(context(),mail)).toEqual(mail);
  });
  it('protects grouped, lowercase and split-HTML codes, removes hidden URLs/resources and does not mutate input', async () => {
    await enable();
    const source = {text:`${card} xdem-1234-5678-abcd ${expected}`,subject:card,
      content:`<!--${card}--><p data-code="${card}" style="background:url(https://test/${card})">XDEM<span>1234</span><b>5678</b>ABCD</p><a href="https://test/?code=%58DEM12345678ABCD">Redeem</a><img src="${card}"><script>${card}</script><input value="${card}">`,
      recipient:JSON.stringify([{name:card,address:'test@example.test'}]),attList:[{key:card,filename:card}]};
    const output = await protectMail(context(), source);
    expect(output.subject).toBe(expected);
    expect(output.text).toBe(`${expected} ${expected} ${expected}`);
    expect(output.content).toContain(expected);
    expect(output.content).not.toMatch(/href|data-code|img|script|style|input|%58DEM/);
    expect(JSON.stringify(output)).not.toContain(card);
    expect(output.attList).toEqual([]);
    expect(source.subject).toBe(card);
    expect(source.attList).toHaveLength(1);
  });
  it('handles entities, adjacent cards and multiple edits in one text node', async () => {
    await enable();
    const result = await protectMail(context(),{content:`<p>&#88;DEM12345678ABCD ${card} ${card}</p>`});
    expect(result.content.split(expected)).toHaveLength(4);
    expect(result.content).not.toContain(card);
    const table = await protectMail(context(),{content:'<table><tr><td>XDEM</td><td>1234</td><td>5678</td><td>ABCD</td></tr></table>'});
    expect(table.content).toContain(expected);
  });
  it('preserves Apple email layout, responsive CSS and reviewed decorative artwork without enabling redemption links', async () => {
    await enable();
    const input = `<!doctype html><html lang="en"><head><style>
      body { margin:0; background-color:#fff; }
      .gift { max-width:600px; font-family:Arial,sans-serif; }
      @media only screen and (max-width:600px) { .gift { width:100%!important; } .heading { font-size:28px; } }
    </style></head><body class="original" style="width:100%;margin:0;padding:0;background-color:#fff">
      <table class="gift" width="600" align="center" border="0" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:48px 20px;color:#333">
      <img src="https://email.images.apple.com/rover/aos/moe/apple_icon_2x.png" height="25" alt="Apple">
      <h1 class="heading" style="font-size:36px;line-height:40px;font-weight:400">Demo sent you an Apple Gift Card.</h1>
      <img src="https://email.images.apple.com/rover/aos/egc/gc_def_hero_lg.jpg" width="400" height="auto" style="width:400px;max-width:100%" alt="Gift Card">
      <img src="https://email.images.apple.com/rover/aos/moe/icon-icloud_v2.jpg" height="45" alt="iCloud">
      <img src="https://email.images.apple.com/rover/aos/moe/icon-news_v2.jpg" height="45" alt="Apple News">
      <img src="https://email.images.apple.com/rover/aos/moe/icon-books.jpg" height="45" alt="Apple Books">
      <p style="border:2px solid #111;padding:12px">${card}</p>
      <a href="https://example.test/redeem?code=${card}" target="_blank" style="display:block;background:#1473e6;color:#fff;padding:12px;border-radius:4px">Redeem Now</a>
      </td></tr></table></body></html>`;
    const output = await protectMail(context(), {content:input});
    const { document } = parseHTML(`<html><body>${output.content}</body></html>`);
    expect(document.querySelector('table').getAttribute('width')).toBe('600');
    expect(document.querySelector('table').getAttribute('cellspacing')).toBe('0');
    expect(document.querySelector('td').getAttribute('style')).toContain('padding:48px 20px');
    expect(document.querySelector('.heading').getAttribute('style')).toContain('font-size:36px');
    expect(document.querySelector('.cm-mail-body.original').getAttribute('style')).toContain('width:100%');
    expect(document.querySelector('style').textContent).toContain('@media only screen and (max-width:600px)');
    expect(document.querySelector('style').textContent).toContain('.cm-mail-body');
    expect(document.querySelectorAll('img')).toHaveLength(5);
    expect([...document.querySelectorAll('img')].every(e => e.getAttribute('referrerpolicy') === 'no-referrer')).toBe(true);
    expect(document.querySelector('a').hasAttribute('href')).toBe(false);
    expect(document.querySelector('a').getAttribute('style')).toContain('background:#1473e6');
    expect(document.querySelector('p').textContent).toBe(expected);
    expect(output.content).not.toContain(card);
    expect(input).toContain(card);
  });
  it('rejects unknown or personalized images and CSS exfiltration while retaining safe declarations', async () => {
    await enable();
    const output = await protectMail(context(), {content:String.raw`
      <style>@import url("https://example.test/${card}");
      @font-face { font-family:leak; src:url(https://example.test/font); }
      .good { color:#123; background:u\72l("https://example.test/${card}"); }
      .evil { font-family:"\58 DEM12345678ABCD"; width:expression(alert(1)); height:var(--secret); }
      .good::after { content:attr(data-pin); }
      </style>
      <div data-pin="${card}" onclick="alert(1)" style="padding:20px;background:image-set(url(https://example.test/q) 1x);color:red;--secret:${card}">${card}</div>
      <img src="https://example.test/qr.png"><img src="data:image/png;base64,AAAA">
      <img src="https://email.images.apple.com/rover/aos/egc/gc_def_hero_lg.jpg?code=${card}">
      <img src="https://email.images.apple.com/rover/aos/egc/personalized.png">
      <img src="https://email.images.apple.com.evil.test/rover/aos/egc/gc_def_hero_lg.jpg">
      <img src="https://email.images.apple.com/rover/aos/egc/gc_def_hero_lg.jpg" srcset="https://example.test/qr.png 2x" onerror="alert(1)">
    `});
    const {document} = parseHTML(`<html><body>${output.content}</body></html>`);
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(output.content).toContain('padding:20px');
    expect(output.content).toContain('color:#123');
    expect(output.content).toContain(expected);
    expect(output.content).not.toMatch(/example\.test|personalized|data-pin|srcset|onerror|onclick|expression|image-set|@import|@font-face|attr\(|var\(|--secret|\\58/);
    expect(output.content).not.toContain(card);
  });
});

describe('password lifecycle and concurrency', () => {
  it('matches manage-tool password bounds: one character is valid; empty, multiline, malformed and oversized text are rejected', async () => {
    for (const invalid of ['', 'line1\nline2', '\uD800', '中'.repeat(342)]) {
      await expect(protection.update(context(),{action:'enable',version:1,newPassword:invalid,confirmPassword:invalid})).rejects.toMatchObject({code:400});
    }
    await protection.update(context(),{action:'enable',version:1,newPassword:'a',confirmPassword:'a'});
    expect((await protectMail(context(),{text:card})).text).toMatch(/^JG_/);
    await protection.update(context(),{action:'change',version:2,currentPassword:'a',newPassword:'短',confirmPassword:'短'});
    await protection.update(context(),{action:'disable',version:3,currentPassword:'短'});
    expect((await protectMail(context(),{text:card})).text).toBe(card);
    expect(validPassword('a'.repeat(1024))).toBe(true);
    expect(validPassword('中'.repeat(341))).toBe(true);
    expect(validPassword(' ')).toBe(true);
  });
  it('seals material separately and never returns a verifier, salt, key or password', async () => {
    const state = await enable();
    expect(state).toEqual({enabled:true,version:2,configured:true,ready:true});
    const row = await protection.read(context());
    expect(row.sealed_key).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(password);
    expect(Object.keys(state).sort()).toEqual(['configured','enabled','ready','version']);
    const original = await env.db.prepare('SELECT text,subject FROM email WHERE email_id=1').first();
    expect(original).toEqual({text:card,subject:card});
  });
  it('requires the current password only to change or disable and re-enables with a new password without rewriting D1', async () => {
    await enable();
    const before = await protectMail(context(),{text:card});
    await expect(protection.update(context(),{action:'disable',version:2,currentPassword:'incorrect'})).rejects.toThrow('Incorrect');
    await expect(protection.update(context(),{action:'change',version:2,currentPassword:'incorrect',newPassword:'NewPassword-2026',confirmPassword:'NewPassword-2026'})).rejects.toThrow('Incorrect');
    const nextPassword = 'NewPassword-2026';
    await protection.update(context(),{action:'change',version:2,currentPassword:password,newPassword:nextPassword,confirmPassword:nextPassword});
    expect((await protectMail(context(),{text:card})).text).not.toBe(before.text);
    await expect(protection.update(context(),{action:'disable',version:3,currentPassword:password})).rejects.toThrow('Incorrect');
    await protection.update(context(),{action:'disable',version:3,currentPassword:nextPassword});
    expect((await protectMail(context(),{text:card})).text).toBe(card);
    await protection.update(context(),{action:'enable',version:4,newPassword:password,confirmPassword:password});
    expect((await protectMail(context(),{text:card})).text).toBe(expected);
    expect(await env.db.prepare('SELECT text FROM email WHERE email_id=1').first('text')).toBe(card);
  });
  it('rejects stale updates and allows only one concurrent policy writer', async () => {
    const results = await Promise.allSettled([enable(),enable()]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected')[0].reason.code).toBe(409);
    await expect(protection.update(context(),{action:'disable',version:1,currentPassword:password})).rejects.toThrow('changed');
  });
  it('rate-limits password verification across separate request contexts', async () => {
    await enable();
    for (let i=0;i<5;i++) await expect(protection.update(context(),{action:'disable',version:2,currentPassword:'wrong-password'})).rejects.toThrow('Incorrect');
    await expect(protection.update(context(),{action:'disable',version:2,currentPassword:password})).rejects.toMatchObject({code:429});
    expect((await protection.status(context())).enabled).toBe(true);
  });
  it('fails closed on missing secrets, corrupted sealed keys and unavailable policy, never reverting to plaintext', async () => {
    await enable();
    await expect(protectMail(context({CARD_PROTECTION_SECRET:undefined}),{text:card})).rejects.toThrow('unavailable');
    await env.db.prepare("UPDATE card_protection SET sealed_key='invalid'").run();
    const response = await request('/email/list?accountId=1&allReceive=1&type=0&size=50');
    const payload = await response.text();
    expect(payload).not.toContain(card);
    expect(JSON.parse(payload).code).toBe(503);
    await expect(protectMail(context({db:{prepare(){throw Error('unavailable');}}}),{text:card})).rejects.toThrow('unavailable');
  });
});

describe('real HTTP boundaries and permissions', () => {
  it('re-enables through the settings API without an old password and verifies the replacement password for later changes', async () => {
    const update = body => request('/setting/cardProtection/update', {method:'PUT',body}).then(r => r.json());
    expect((await update({action:'enable',version:1,newPassword:password,confirmPassword:password})).code).toBe(200);
    expect((await update({action:'enable',version:2,newPassword:'a',confirmPassword:'a'})).code).toBe(409);
    expect((await update({action:'disable',version:2,currentPassword:password})).code).toBe(200);
    const replacement = 'a';
    const enabled = await update({action:'enable',version:3,newPassword:replacement,confirmPassword:replacement});
    expect(enabled).toMatchObject({code:200,data:{enabled:true,version:4,configured:true}});
    expect((await update({action:'change',version:4,newPassword:password,confirmPassword:password})).code).toBe(400);
    expect((await update({action:'disable',version:4})).code).toBe(400);
    expect((await update({action:'disable',version:4,currentPassword:password})).code).toBe(400);
    expect((await update({action:'disable',version:4,currentPassword:replacement}))).toMatchObject({code:200,data:{enabled:false,version:5}});
  });
  it('denies unauthenticated and non-admin policy changes and exposes only public state to ordinary readers', async () => {
    expect((await (await request('/setting/cardProtection/status',{token:''})).json()).code).toBe(401);
    expect((await (await request('/setting/cardProtection/update',{token:userToken,method:'PUT',body:{action:'enable',version:1,newPassword:password,confirmPassword:password}})).json()).code).toBe(403);
    expect((await (await request('/setting/cardProtection/status',{token:userToken})).json()).code).toBe(403);
    expect((await (await request('/email/protectionState',{token:userToken})).json()).data).toEqual({enabled:false,version:1});
  });
  it('enables through the authorized route, protecting every JSON read route and preserving owner isolation', async () => {
    const enabled = await (await request('/setting/cardProtection/update',{method:'PUT',body:{action:'enable',version:1,newPassword:password,confirmPassword:password}})).json();
    expect(enabled.code).toBe(200);
    const paths = ['/email/list?accountId=1&allReceive=1&type=0&size=50', '/email/latest?emailId=0&accountId=1&allReceive=1',
      '/allEmail/list?size=50&type=receive','/allEmail/latest?emailId=0','/star/list?size=50'];
    for (const path of paths) {
      const response = await request(path);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(response.headers.get('X-Card-Protection-Version')).toBe('2');
      const payload = await response.text();
      expect(JSON.parse(payload).code).toBe(200);
      expect(payload).not.toContain(card);
      expect(payload).toContain(expected);
    }
    const own = await (await request('/email/list?accountId=2&allReceive=1&type=0&size=50',{token:userToken})).json();
    expect(own.data.list.map(row=>row.userId)).toEqual([2]);
    const attachments = await (await request('/email/attList?emailId=1')).json();
    expect(attachments.data).toEqual([]);
    expect((await (await request('/oss/attachments/test.txt',{token:''})).json()).code).toBe(403);
    const direct = await SELF.fetch('https://example.test/attachments/test.txt');
    expect(direct.status).toBe(403);
    const original = await env.db.prepare('SELECT text FROM email WHERE email_id=1').first('text');
    expect(original).toBe(card);
  });
  it('protects public API and Telegram pages while keeping body search disabled', async () => {
    await enable();
    const publicResult = await request('/public/emailList',{token:'synthetic-public-token',body:{size:10}});
    const data = await publicResult.text();
    expect(data).toContain(expected); expect(data).not.toContain(card);
    for (const query of [{content:card},{text:card}]) {
      const result = await (await request('/public/emailList',{token:'synthetic-public-token',body:query})).json();
      expect(result.code).toBe(400);
    }
    const token = await jwtUtils.generateToken(context(),{emailId:1},3600);
    const page = await request('/telegram/getEmail/'+token,{token:''});
    expect(page.headers.get('Cache-Control')).toContain('no-store');
    const html = await page.text();
    expect(html).toContain(expected); expect(html).not.toContain(card);
    const denied = await (await request('/allEmail/list?size=10&type=receive&content=1234')).json();
    expect(denied.code).toBe(400);
  });
  it('searches order numbers and sender names through metadata while returning protected results and accurate totals', async () => {
    await env.db.prepare('UPDATE email SET subject=?,name=? WHERE email_id=1')
      .bind(`Order W123456789 for Demo ${card}`, 'Demo Sender').run();
    await enable();
    for (const query of ['subject=w123456789', 'subject=Order%20W123', 'name=demo%20sender']) {
      const response = await request('/allEmail/list?size=10&type=receive&' + query);
      const json = await response.json();
      expect(json.code).toBe(200);
      expect(json.data.total).toBe(1);
      expect(json.data.list.map(row => row.emailId)).toEqual([1]);
      expect(json.data.list[0].subject).toContain(expected);
      expect(JSON.stringify(json)).not.toContain(card);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
    }
    const empty = await (await request('/allEmail/list?size=10&type=receive&subject=MissingOrder')).json();
    expect(empty).toMatchObject({code:200,data:{total:0,list:[]}});
    for (const query of [{subject:'%W123456789%'},{sendName:'%Demo Sender%'}]) {
      const json = await (await request('/public/emailList',{token:'synthetic-public-token',body:{size:10,...query}})).json();
      expect(json.code).toBe(200);
      expect(json.data.map(row => row.emailId)).toEqual([1]);
      expect(JSON.stringify(json)).toContain(expected);
      expect(JSON.stringify(json)).not.toContain(card);
    }
    const forbidden = await (await request('/allEmail/list?size=10&type=receive&subject=W123456789',{token:userToken})).json();
    expect(forbidden.code).toBe(403);
    for (const [column,index] of [['subject','idx_email_meta_subject'],['name','idx_email_meta_name']]) {
      const {results} = await env.db.prepare(`EXPLAIN QUERY PLAN SELECT email_id FROM email_metadata INDEXED BY ${index} WHERE ${column} COLLATE NOCASE LIKE ?`).bind('%Demo%').all();
      expect(results.some(row => row.detail.includes(`COVERING INDEX ${index}`))).toBe(true);
    }
  });
  it('protects local draft copies and never passes supplied attachments through the protected endpoint', async () => {
    await enable();
    const draft = await (await request('/email/protectDraft',{body:{subject:card,content:`<p>${card}</p>`,attachments:[{filename:card}]}})).json();
    expect(draft.data.subject).toBe(expected);
    expect(draft.data.attachments).toEqual([]);
    expect(JSON.stringify(draft)).not.toContain(card);
  });
  it('protects outgoing content and reply/forward quotes before transport, rejecting attachment bypasses', async () => {
    await enable();
    await env.kv.put(kvConst.SETTING,JSON.stringify({resendTokens:{},emailPrefixFilter:'',send:0,r2Domain:''}));
    const transport = {send:vi.fn().mockResolvedValue({messageId:'synthetic-delivery'})};
    const form = {accountId:1,name:'Synthetic sender',receiveEmail:['recipient@example.net'],subject:card,text:card,content:`<p>${card}</p>`,attachments:[]};
    await emailService.send(context({email:transport}),form,1);
    expect(transport.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(transport.send.mock.calls[0])).toContain(expected);
    expect(JSON.stringify(transport.send.mock.calls[0])).not.toContain(card);
    await expect(emailService.send(context({email:transport}),{...form,attachments:[{content:'raw'}]},1)).rejects.toThrow('Attachments');
  });
});
