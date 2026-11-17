import {env} from 'cloudflare:test';
import {beforeAll, describe, expect, it} from 'vitest';
import {getTableConfig} from 'drizzle-orm/sqlite-core';
import email from '../src/entity/email';
import account from '../src/entity/account';
import perm from '../src/entity/perm';
import {att} from '../src/entity/att';
import {dbInit} from '../src/init/init';
import service from '../src/service/user-batch-service';
import migration from '../migrations/20261117_group_query_indexes.sql?raw';

const context = (owner = 1) => ({env, get: () => ({userId: owner})});
beforeAll(async () => {
  for (const table of [email, account, perm, att]) {
    const config = getTableConfig(table);
    const columns = config.columns.map(c => `"${c.name}" ${c.getSQLType()} ${c.primary ? 'PRIMARY KEY' : ''} DEFAULT ${c.getSQLType() === 'integer' ? '0' : "''"}`);
    await env.db.prepare(`CREATE TABLE "${config.name}" (${columns.join(',')})`).run();
  }
  await dbInit.userBatchDB(context());
  for (let i=0; i<2; i++) {
    for (const sql of migration.replace(/^--.*$/gm,'').split(';').filter(s=>s.trim())) await env.db.prepare(sql).run();
  }
  await env.db.prepare("INSERT INTO inbox_batch_group(group_id,name,owner_id,protected,is_del) VALUES (1,'Main',1,1,0),(2,'Empty',1,0,0),(3,'Other owner',2,0,0),(4,'Recycled',1,0,1)").run();
  await env.db.prepare("INSERT INTO account(account_id,email,user_id,is_del) VALUES (1,'first@example.test',1,0),(2,'second@example.test',1,1),(3,'empty@example.test',1,0),(4,'other@example.test',2,0)").run();
  await env.db.prepare("INSERT INTO inbox_batch_member(member_id,group_id,account_id,email) VALUES (1,1,1,'first@example.test'),(2,1,2,'second@example.test'),(3,1,3,'empty@example.test'),(4,3,4,'other@example.test')").run();
  await env.db.prepare(`INSERT INTO email(email_id,account_id,user_id,is_del,unread,create_time,content) VALUES
    (1,1,1,0,0,'2026-11-01','body'),(2,1,1,0,1,'2026-11-02','body'),
    (3,1,1,1,0,'2026-11-03','deleted body'),(4,2,1,0,0,'2026-11-04','body'),
    (5,4,2,0,0,'2026-11-05','private body')`).run();
  await env.db.prepare("INSERT INTO attachments(att_id,account_id,email_id) VALUES (1,1,1),(2,2,4)").run();
});

describe('group statistics without message-body reads', () => {
  it('retains totals, empty groups, deleted inboxes and owner/archive isolation', async () => {
    const groups = await service.groupList(context(), {});
    expect(groups.map(g=>g.groupId)).toEqual([2,1]);
    expect(groups[0]).toMatchObject({inboxCount:0,activeInboxCount:0,deletedInboxCount:0,emailCount:0,unreadCount:0,attachmentCount:0});
    expect(groups[1]).toMatchObject({protected:1,inboxCount:3,activeInboxCount:2,deletedInboxCount:1,emailCount:3,unreadCount:2,attachmentCount:2});
    expect((await service.groupList(context(), {deleted:'1'})).map(g=>g.groupId)).toEqual([4]);
    expect((await service.groupList(context(), {keyword:'Main'})).map(g=>g.groupId)).toEqual([1]);
  });
  it('paginates members before counting and keeps empty inbox and status/search semantics', async () => {
    const first = await service.groupMembers(context(), {groupId:1,size:1});
    const second = await service.groupMembers(context(), {groupId:1,size:1,page:2});
    expect(first.total).toBe(3);
    expect(first.list[0]).toMatchObject({memberId:1,emailCount:2,unreadCount:1,latestEmailTime:'2026-11-02'});
    expect(second.list[0]).toMatchObject({memberId:2,isDel:1,emailCount:1,unreadCount:1});
    const active = await service.groupMembers(context(), {groupId:1,status:'active'});
    expect(active.total).toBe(2);
    expect(active.list[1]).toMatchObject({memberId:3,emailCount:0,unreadCount:0,latestEmailTime:null});
    expect((await service.groupMembers(context(), {groupId:1,keyword:'second',status:'deleted'})).total).toBe(1);
    expect((await service.groupMembers(context(), {groupId:1,page:9,size:1})).list).toEqual([]);
    await expect(service.groupMembers(context(2), {groupId:1})).rejects.toThrow();
  });
  it('uses a covering index for counts, unread and latest time, including recycled mail', async () => {
    for (const sql of [
      'SELECT count(email_id),sum(unread=0),max(create_time) FROM email INDEXED BY idx_email_account_del_unread_time WHERE account_id=1 AND is_del=0',
      'SELECT count(*) FROM email WHERE account_id=1',
      'SELECT count(*) FROM attachments WHERE account_id=1'
    ]) {
      const {results} = await env.db.prepare('EXPLAIN QUERY PLAN '+sql).all();
      expect(results.some(r=>r.detail.includes('COVERING INDEX'))).toBe(true);
    }
  });
  it('preserves protected-group deletion and group restore relationships', async () => {
    await expect(service.groupDelete(context(),{groupId:1,confirmName:'Main'})).rejects.toThrow('保护分组');
    await env.db.prepare('UPDATE inbox_batch_group SET protected=0 WHERE group_id=1').run();
    const deleted = await service.groupDelete(context(),{groupId:1,confirmName:'Main'});
    expect(deleted).toMatchObject({emailCount:3,inboxCount:3});
    await service.groupRestore(context(),{groupId:1});
    expect((await service.groupMembers(context(),{groupId:1})).total).toBe(3);
    expect(await env.db.prepare('SELECT count(*) AS n FROM email').first('n')).toBe(5);
  });
});
