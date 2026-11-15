import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import email from '../src/entity/email';
import user from '../src/entity/user';
import account from '../src/entity/account';
import { star } from '../src/entity/star';
import { att } from '../src/entity/att';
import emailService from '../src/service/email-service';
import accountService from '../src/service/account-service';
import migration from '../migrations/20261115_email_query_indexes.sql?raw';

// Local workerd D1/KV only; real production query code, synthetic records.
beforeAll(async () => {
  for (const table of [email, user, account, star, att]) {
    const config = getTableConfig(table);
    const columns = config.columns.map(c => `"${c.name}" ${c.getSQLType()} ${c.primary ? 'PRIMARY KEY' : ''} DEFAULT ${c.getSQLType() === 'integer' ? '0' : "''"}`);
    await env.db.prepare(`CREATE TABLE "${config.name}" (${columns.join(',')})`).run();
  }
  await env.db.prepare('CREATE TABLE inbox_batch_group (group_id INTEGER PRIMARY KEY,name TEXT,owner_id INTEGER,protected INTEGER,is_del INTEGER)').run();
  await env.db.prepare('CREATE TABLE inbox_batch_member (member_id INTEGER PRIMARY KEY,group_id INTEGER,account_id INTEGER,email TEXT)').run();
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const statement of migration.split(';').map(s => s.trim()).filter(Boolean)) await env.db.prepare(statement).run();
  }
  await env.db.prepare("INSERT INTO user (user_id,email) VALUES (1,'admin@example.test'),(2,'other@example.test')").run();
  await env.db.prepare("INSERT INTO account (account_id,email,user_id,is_del) VALUES (1,'box@example.test',1,0),(2,'other@example.test',2,0),(3,'deleted@example.test',1,1)").run();
  const rows = [
    [10, 1, 1, 'box@example.test', 'sender@example.test', 0, 0],
    [11, 1, 1, 'box@example.test', 'BOX@example.test', 0, 0],
    [12, 1, 1, 'else@example.test', 'BOX@example.test', 0, 0],
    [13, 1, 1, 'box@example.test', 'sender@example.test', 6, 0],
    [14, 1, 3, 'deleted@example.test', 'sender@example.test', 0, 0],
    [15, 2, 2, 'other@example.test', 'sender@example.test', 0, 0],
    [16, 1, 1, 'box@example.test', 'sender@example.test', 0, 1],
  ];
  for (const r of rows) await env.db.prepare("INSERT INTO email (email_id,user_id,account_id,to_email,send_email,status,is_del,type,content,text) VALUES (?,?,?,?,?,?,?,0,'<p>Retained body</p>','Retained body')").bind(...r).run();
  await env.db.prepare("INSERT INTO attachments (att_id,user_id,account_id,email_id,key,type) VALUES (1,1,1,10,'attachment-test',0)").run();
  await env.db.prepare("INSERT INTO inbox_batch_group VALUES (1,'Protected',1,1,0)").run();
  await env.db.prepare("INSERT INTO inbox_batch_member VALUES (1,1,1,'box@example.test')").run();
});

const context = () => ({ env });
const search = (overrides = {}) => emailService.allList(context(), { emailId: 0, size: 2, timeSort: 0, type: 'receive', accountEmail: 'box@example.test', ...overrides });

describe('D1 mail search and protection regressions', () => {
  it('matches recipient/sender, deduplicates, excludes unfinished mail, retains body and attachments', async () => {
    const result = await search({ size: 50 });
    expect(result.list.map(r => r.emailId)).toEqual([16, 12, 11, 10]);
    expect(result.total).toBe(4);
    expect(result.list[0].content).toContain('Retained body');
    expect(result.list.find(r => r.emailId === 10).attList).toHaveLength(1);
    expect(Object.keys(result.latestEmail).sort()).toEqual(['accountId', 'emailId', 'userId']);
  });
  it('normalizes case/whitespace and preserves partial search', async () => {
    const a = await search({ size: 50 });
    const b = await search({ accountEmail: ' BOX@EXAMPLE.TEST ', size: 50 });
    const c = await search({ accountEmail: 'box', size: 50 });
    expect(b.list.map(r => r.emailId)).toEqual(a.list.map(r => r.emailId));
    expect(c.total).toBe(a.total);
  });
  it('paginates both directions, without overlap or changing total', async () => {
    const a = await search();
    const b = await search({ emailId: a.list.at(-1).emailId });
    expect(b.list.map(r => r.emailId)).toEqual([11, 10]);
    expect(b.total).toBe(a.total);
    expect((await search({ timeSort: 1 })).list.map(r => r.emailId)).toEqual([10, 11]);
  });
  it('handles empty results and SQL-shaped input safely', async () => {
    expect((await search({ accountEmail: 'absent@example.test' })).total).toBe(0);
    expect((await search({ accountEmail: "' OR 1=1 --" })).total).toBe(0);
  });
  it('keeps user filtering in list and count', async () => {
    const result = await search({ accountEmail: '', userEmail: 'other@example.test', size: 50 });
    expect(result.total).toBe(1);
    expect(result.list.map(r => r.emailId)).toEqual([15]);
  });
  it('uses a covering address index for partial search', async () => {
    const { results } = await env.db.prepare("EXPLAIN QUERY PLAN SELECT email_id FROM email INDEXED BY idx_email_to_nocase_type WHERE to_email COLLATE NOCASE LIKE '%box%'").all();
    expect(results.some(r => r.detail.includes('COVERING INDEX idx_email_to_nocase_type'))).toBe(true);
  });
  it('isolates owners and hides deleted inboxes and deleted mails', async () => {
    const result = await emailService.list(context(), { emailId: 0, size: 50, timeSort: 0, type: 0, accountId: 1, allReceive: 1 }, 1);
    expect(result.list.length).toBeGreaterThan(0);
    expect(result.list.every(r => r.userId === 1 && r.accountId === 1 && r.isDel === 0)).toBe(true);
    expect(result.list.map(r => r.emailId)).not.toContain(14);
  });
  it('rejects deleting a protected group inbox without changing it', async () => {
    await expect(accountService.delete(context(), { accountId: 1 }, 1)).rejects.toThrow('Protected');
    expect(await env.db.prepare('SELECT is_del FROM account WHERE account_id=1').first('is_del')).toBe(0);
  });
  it('rejects unauthenticated private API requests', async () => {
    const result = await SELF.fetch('https://example.test/api/allEmail/list?size=1&type=receive').then(r => r.json());
    expect(result.code).toBe(401);
  });
});
