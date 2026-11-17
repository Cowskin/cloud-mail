import {env} from 'cloudflare:test';
import {beforeAll, describe, expect, it} from 'vitest';
import {getTableConfig} from 'drizzle-orm/sqlite-core';
import user from '../src/entity/user';
import account from '../src/entity/account';
import role from '../src/entity/role';
import perm from '../src/entity/perm';
import {dbInit as init} from '../src/init/init';
import userBatchService from '../src/service/user-batch-service';
import cryptoUtils from '../src/utils/crypto-utils';
import {generateBatchAddresses} from '../../mail-vue/src/utils/batch-address.js';

const context = () => ({env, get: () => ({userId: 1}), req: {header: () => ''}});
const rule = overrides => ({addressMode: 'random', prefix: '', separator: '_', start: 1, padding: 3, count: 3, suffix: '@example.test', randomLength: 8, randomCharset: 'alphanumeric', excludeAmbiguous: true, ...overrides});
const request = (config, overrides = {}) => ({mode: 'inbox', batchName: 'Synthetic batch', rule: {...config}, requestId: crypto.randomUUID(), stopOnConflict: true, list: generateBatchAddresses(config).map(email => ({email, type: 0})), ...overrides});

beforeAll(async () => {
    for (const table of [user, account, role, perm]) {
        const config = getTableConfig(table);
        const columns = config.columns.map(c => `"${c.name}" ${c.getSQLType()} ${c.primary ? 'PRIMARY KEY' : ''} DEFAULT ${c.getSQLType() === 'integer' ? '0' : "''"}`);
        await env.db.prepare(`CREATE TABLE "${config.name}" (${columns.join(',')})`).run();
    }
    await init.userBatchDB(context());
    await env.db.prepare("INSERT INTO user(user_id,email) VALUES (1,'admin@example.test')").run();
    await env.db.prepare("INSERT INTO role(role_id,name,key) VALUES (1,'Synthetic user','test')").run();
});

describe('random addresses through the existing D1 batch workflow', () => {
    it('creates exactly the checked inboxes, preserves membership and rules, and replays the same request without duplicates', async () => {
        const input = request(rule());
        expect((await userBatchService.precheck(context(), {emails: input.list.map(item => item.email)})).availableCount).toBe(3);
        const result = await userBatchService.create(context(), input);
        expect(result.successCount).toBe(3);
        expect(result.results.map(item => item.email)).toEqual(input.list.map(item => item.email));
        const {results: members} = await env.db.prepare('SELECT m.email,a.user_id AS owner FROM inbox_batch_member m JOIN account a ON a.account_id=m.account_id WHERE group_id=? ORDER BY member_id').bind(result.groupId).all();
        expect(members).toEqual(input.list.map(item => ({email: item.email, owner: 1})));
        const saved = JSON.parse(await env.db.prepare('SELECT rule_json FROM user_batch WHERE batch_id=?').bind(result.batchId).first('rule_json'));
        expect(saved).toMatchObject({...input.rule, mode: 'inbox', groupId: result.groupId});
        const replay = await userBatchService.create(context(), input);
        expect(replay).toMatchObject({idempotent: true, batchId: result.batchId, successCount: 3});
        expect(await env.db.prepare('SELECT COUNT(*) AS n FROM inbox_batch_member WHERE group_id=?').bind(result.groupId).first('n')).toBe(3);
    });

    it('protects deleted addresses at precheck and create without restoring or overwriting them', async () => {
        const input = request(rule());
        const email = input.list[0].email;
        await env.db.prepare('INSERT INTO account(email,user_id,is_del) VALUES (?,1,1)').bind(email).run();
        const checked = await userBatchService.precheck(context(), {emails: input.list.map(item => item.email)});
        expect(checked.results[0].status).toBe('deleted');
        const created = await userBatchService.create(context(), input);
        expect(created.successCount).toBe(0);
        expect(await env.db.prepare('SELECT is_del FROM account WHERE email=?').bind(email).first('is_del')).toBe(1);
        expect(await env.db.prepare('SELECT COUNT(*) AS n FROM inbox_batch_member WHERE group_id=?').bind(created.groupId).first('n')).toBe(0);
    });

    it('supports independent users with sequence + random addresses and retains only password hashes', async () => {
        const input = request(rule({addressMode: 'sequenceRandom', prefix: 'test', count: 2}), {mode: 'user'});
        input.list.forEach(item => Object.assign(item, {type: 1, password: 'Synthetic-Test-Password'}));
        const created = await userBatchService.create(context(), input);
        expect(created.successCount).toBe(2);
        for (const item of input.list) {
            const saved = await env.db.prepare('SELECT u.password,u.salt,u.user_id,a.user_id AS owner FROM user u JOIN account a ON a.email=u.email WHERE u.email=?').bind(item.email).first();
            expect(saved.password).not.toBe(item.password);
            expect(await cryptoUtils.verifyPassword(item.password, saved.salt, saved.password)).toBe(true);
            expect(saved.owner).toBe(saved.user_id);
        }
        const history = await userBatchService.items(context(), {batchId: created.batchId});
        expect(history.list.map(item => item.email)).toEqual(input.list.map(item => item.email));
        expect(history.list.every(item => !('password' in item))).toBe(true);
    });

    it('still creates sequential batches whose rules omit the new mode', async () => {
        const config = rule({addressMode: undefined, prefix: 'legacy', separator: '', count: 2});
        const input = request(config);
        const created = await userBatchService.create(context(), input);
        expect(created.successCount).toBe(2);
        expect(created.results.map(item => item.email)).toEqual(['legacy001@example.test', 'legacy002@example.test']);
    });
});
