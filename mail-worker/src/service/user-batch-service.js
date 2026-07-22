import BizError from '../error/biz-error';
import cryptoUtils from '../utils/crypto-utils';
import emailUtils from '../utils/email-utils';
import reqUtils from '../utils/req-utils';
import roleService from './role-service';
import verifyUtils from '../utils/verify-utils';
import dayjs from 'dayjs';

const MAX_BATCH_SIZE = 500;
const WRITE_CHUNK_SIZE = 25;
const MAX_PAGE_SIZE = 100;
let groupSchemaReady = false;

async function ensureGroupSchema(c) {
	if (groupSchemaReady) return;
	await c.env.db.batch([
		c.env.db.prepare(`CREATE TABLE IF NOT EXISTS inbox_batch_group (
			group_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_id INTEGER NOT NULL,
			category TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', protected INTEGER NOT NULL DEFAULT 0,
			is_del INTEGER NOT NULL DEFAULT 0, create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
			update_time DATETIME DEFAULT CURRENT_TIMESTAMP
		)`),
		c.env.db.prepare(`CREATE TABLE IF NOT EXISTS inbox_batch_member (
			member_id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
			email TEXT NOT NULL, deleted_with_group INTEGER NOT NULL DEFAULT 0,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP
		)`),
		c.env.db.prepare('CREATE INDEX IF NOT EXISTS idx_inbox_group_owner ON inbox_batch_group(owner_id, is_del)'),
		c.env.db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_member_account ON inbox_batch_member(account_id)'),
		c.env.db.prepare('CREATE INDEX IF NOT EXISTS idx_inbox_member_group ON inbox_batch_member(group_id)'),
		c.env.db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_batch_request_id
			ON user_batch(json_extract(rule_json, '$.requestId'))
			WHERE json_extract(rule_json, '$.requestId') IS NOT NULL`)
	]);
	groupSchemaReady = true;
}

function pagination(params, defaultSize = 20) {
	const page = Math.max(1, Number(params.page) || 1);
	const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(params.size) || defaultSize));
	return { page, size, offset: (page - 1) * size };
}

function chunks(list, size) {
	const result = [];
	for (let index = 0; index < list.length; index += size) {
		result.push(list.slice(index, index + size));
	}
	return result;
}

const userBatchService = {
	async create(c, params) {
		const batchName = String(params.batchName || '').trim();
		const rule = params.rule || {};
		const mode = params.mode === 'inbox' ? 'inbox' : 'user';
		if (mode === 'inbox') await ensureGroupSchema(c);
		rule.mode = mode;
		const requestId = String(params.requestId || '').trim().slice(0, 80);
		if (requestId) {
			const previous = await c.env.db.prepare(`
				SELECT batch_id AS batchId, success_count AS successCount, failed_count AS failedCount,
					json_extract(rule_json, '$.groupId') AS groupId
				FROM user_batch WHERE json_extract(rule_json, '$.requestId') = ?
			`).bind(requestId).first();
			if (previous) {
				const { results } = await c.env.db.prepare(`SELECT email, status AS success, error FROM user_batch_item WHERE batch_id = ? ORDER BY item_id`).bind(previous.batchId).all();
				return { ...previous, mode, idempotent: true, results: results.map(item => ({...item, success: !!item.success})) };
			}
			rule.requestId = requestId;
		}
		const list = Array.isArray(params.list) ? params.list : [];

		if (!batchName) throw new BizError('请输入批次名称');
		if (!list.length) throw new BizError('没有可创建的邮箱');
		if (list.length > MAX_BATCH_SIZE) throw new BizError(`单批最多创建 ${MAX_BATCH_SIZE} 个邮箱`);

		const roleList = mode === 'user' ? await roleService.roleSelectUse(c) : [];
		const roleIds = new Set(roleList.map(item => item.roleId));
		const now = dayjs().format('YYYY-MM-DD HH:mm:ss');
		const operatorId = c.get('user').userId;
		const batch = await c.env.db.prepare(`
			INSERT INTO user_batch (name, rule_json, total, success_count, failed_count, operator_id, create_time)
			VALUES (?, ?, ?, 0, 0, ?, ?) RETURNING batch_id
		`).bind(batchName, JSON.stringify(rule), list.length, operatorId, now).first();
		let groupId = null;
		if (mode === 'inbox') {
			const group = await c.env.db.prepare(`
				INSERT INTO inbox_batch_group (name, owner_id, category, note, create_time, update_time)
				VALUES (?, ?, ?, ?, ?, ?) RETURNING group_id
			`).bind(batchName, operatorId, String(rule.category || '').slice(0, 30), String(rule.note || '').slice(0, 200), now, now).first();
			groupId = group.group_id;
			rule.groupId = groupId;
			await c.env.db.prepare('UPDATE user_batch SET rule_json = ? WHERE batch_id = ?')
				.bind(JSON.stringify(rule), batch.batch_id).run();
		}

		const normalized = [];
		const seen = new Set();
		for (const row of list) {
			const email = String(row.email || '').trim().toLowerCase();
			const password = String(row.password || '');
			const type = Number(row.type);
			let error = '';
			if (!verifyUtils.isEmail(email)) error = '邮箱格式不正确';
			else if (!c.env.domain.includes(emailUtils.getDomain(email))) error = '邮箱域名不可用';
			else if (mode === 'user' && password.length < 6) error = '密码至少需要 6 位';
			else if (mode === 'user' && !roleIds.has(type)) error = '权限身份不存在';
			else if (seen.has(email)) error = '本批次邮箱重复';
			seen.add(email);
			normalized.push({ email, password, type, error });
		}

		const validEmails = normalized.filter(item => !item.error).map(item => item.email);
		const existing = new Set();
		for (const group of chunks(validEmails, 80)) {
			if (!group.length) continue;
			const placeholders = group.map(() => '?').join(',');
			const { results } = await c.env.db.prepare(
				`SELECT email FROM ${mode === 'inbox' ? 'account' : 'user'} WHERE email COLLATE NOCASE IN (${placeholders})`
			).bind(...group).all();
			results.forEach(item => existing.add(item.email.toLowerCase()));
		}

		const activeIp = reqUtils.getIp(c);
		const { os, browser, device } = reqUtils.getUserAgent(c);
		const results = [];
		for (const item of normalized) {
			if (!item.error && existing.has(item.email)) item.error = '邮箱已存在';
			if (!item.error && mode === 'user') {
				const { salt, hash } = await cryptoUtils.hashPassword(item.password);
				item.salt = salt;
				item.hash = hash;
			}
			results.push({ email: item.email, success: !item.error, error: item.error });
		}
		if (params.stopOnConflict && results.some(item => !item.success)) {
			for (const item of normalized) {
				if (!item.error) item.error = '批次存在冲突，已停止创建';
			}
			results.splice(0, results.length, ...normalized.map(item => ({email: item.email, success: false, error: item.error})));
		}

		for (const group of chunks(normalized, WRITE_CHUNK_SIZE)) {
			const statements = [];
			for (const item of group) {
				if (!item.error && mode === 'user') {
					statements.push(c.env.db.prepare(`
						INSERT INTO user (email, password, salt, type, os, browser, active_ip, create_ip, device, active_time, create_time)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`).bind(item.email, item.hash, item.salt, item.type, os, browser, activeIp, activeIp, device, now, now));
					statements.push(c.env.db.prepare(`
						INSERT INTO account (email, name, user_id)
						SELECT ?, ?, user_id FROM user WHERE email COLLATE NOCASE = ?
					`).bind(item.email, emailUtils.getName(item.email), item.email));
				}
				if (!item.error && mode === 'inbox') {
					statements.push(c.env.db.prepare(`
						INSERT INTO account (email, name, user_id) VALUES (?, ?, ?)
					`).bind(item.email, emailUtils.getName(item.email), operatorId));
				}
				statements.push(c.env.db.prepare(`
					INSERT INTO user_batch_item (batch_id, email, status, error, create_time)
					VALUES (?, ?, ?, ?, ?)
				`).bind(batch.batch_id, item.email, item.error ? 0 : 1, item.error, now));
			}
			await c.env.db.batch(statements);
		}
		if (mode === 'inbox') {
			const createdEmails = normalized.filter(item => !item.error).map(item => item.email);
			for (const emailGroup of chunks(createdEmails, 80)) {
				if (!emailGroup.length) continue;
				const placeholders = emailGroup.map(() => '?').join(',');
				const { results: accounts } = await c.env.db.prepare(`
					SELECT account_id AS accountId, email FROM account
					WHERE user_id = ? AND email COLLATE NOCASE IN (${placeholders})
				`).bind(operatorId, ...emailGroup).all();
				if (accounts.length) {
					await c.env.db.batch(accounts.map(accountRow => c.env.db.prepare(`
						INSERT OR IGNORE INTO inbox_batch_member (group_id, account_id, email, create_time)
						VALUES (?, ?, ?, ?)
					`).bind(groupId, accountRow.accountId, accountRow.email, now)));
				}
			}
		}

		const successCount = results.filter(item => item.success).length;
		await c.env.db.prepare(`
			UPDATE user_batch SET success_count = ?, failed_count = ? WHERE batch_id = ?
		`).bind(successCount, results.length - successCount, batch.batch_id).run();

		return { batchId: batch.batch_id, groupId, mode, results, successCount, failedCount: results.length - successCount };
	},

	async list(c, params) {
		const keyword = String(params.keyword || '').trim();
		const domain = String(params.domain || '').trim();
		const category = String(params.category || '').trim();
		const mode = String(params.mode || '').trim();
		const resultStatus = String(params.resultStatus || '');
		const conditions = [];
		const bindings = [];
		if (keyword) {
			conditions.push('(name LIKE ? OR json_extract(rule_json, \'$.prefix\') LIKE ?)');
			bindings.push(`%${keyword}%`, `%${keyword}%`);
		}
		if (domain) {
			conditions.push("json_extract(rule_json, '$.suffix') = ?");
			bindings.push(domain);
		}
		if (category) {
			conditions.push("json_extract(rule_json, '$.category') = ?");
			bindings.push(category);
		}
		if (mode === 'user') conditions.push("COALESCE(json_extract(rule_json, '$.mode'), 'user') = 'user'");
		if (mode === 'inbox') conditions.push("json_extract(rule_json, '$.mode') = 'inbox'");
		if (params.archived !== '1') conditions.push("COALESCE(json_extract(rule_json, '$.archived'), 0) = 0");
		if (resultStatus === 'success') conditions.push('success_count = total');
		if (resultStatus === 'partial') conditions.push('success_count > 0 AND failed_count > 0');
		if (resultStatus === 'failed') conditions.push('success_count = 0 AND failed_count > 0');
		if (params.startDate) {
			conditions.push('create_time >= ?');
			bindings.push(`${String(params.startDate).slice(0, 10)} 00:00:00`);
		}
		if (params.endDate) {
			conditions.push('create_time <= ?');
			bindings.push(`${String(params.endDate).slice(0, 10)} 23:59:59`);
		}
		const condition = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
		const { page, size, offset } = pagination(params);
		const totalRow = await c.env.db.prepare(
			`SELECT COUNT(*) AS total FROM user_batch ${condition}`
		).bind(...bindings).first();
		const { results } = await c.env.db.prepare(`
			SELECT batch_id AS batchId, name, rule_json AS ruleJson, total,
				success_count AS successCount, failed_count AS failedCount,
				operator_id AS operatorId, create_time AS createTime
			FROM user_batch ${condition} ORDER BY batch_id DESC LIMIT ? OFFSET ?
		`).bind(...bindings, size, offset).all();
		const { results: categoryRows } = await c.env.db.prepare(`
			SELECT DISTINCT json_extract(rule_json, '$.category') AS category
			FROM user_batch
			WHERE COALESCE(json_extract(rule_json, '$.category'), '') <> ''
			ORDER BY category LIMIT 100
		`).all();
		return {
			list: results.map(item => ({ ...item, rule: JSON.parse(item.ruleJson || '{}') })),
			total: Number(totalRow?.total || 0), page, size,
			categories: categoryRows.map(item => item.category)
		};
	},

	async items(c, params) {
		const batchId = Number(params.batchId);
		if (!batchId) throw new BizError('请选择批次');
		const conditions = ['batch_id = ?'];
		const bindings = [batchId];
		if (params.email) {
			conditions.push('email LIKE ?');
			bindings.push(`%${String(params.email).trim()}%`);
		}
		if (params.status === '0' || params.status === '1') {
			conditions.push('status = ?');
			bindings.push(Number(params.status));
		}
		const where = conditions.join(' AND ');
		const totalRow = await c.env.db.prepare(
			`SELECT COUNT(*) AS total FROM user_batch_item WHERE ${where}`
		).bind(...bindings).first();
		const exportAll = params.export === '1';
		const { page, size, offset } = pagination(params, 50);
		const limit = exportAll ? 5000 : size;
		const queryOffset = exportAll ? 0 : offset;
		const { results } = await c.env.db.prepare(`
			SELECT item_id AS itemId, batch_id AS batchId, email, status, error, create_time AS createTime
			FROM user_batch_item WHERE ${where} ORDER BY item_id ASC LIMIT ? OFFSET ?
		`).bind(...bindings, limit, queryOffset).all();
		return { list: results, total: Number(totalRow?.total || 0), page, size };
	},

	async update(c, params) {
		const batchId = Number(params.batchId);
		const name = String(params.name || '').trim();
		if (!batchId) throw new BizError('请选择批次');
		if (!name) throw new BizError('请输入批次名称');
		if (name.length > 40) throw new BizError('批次名称最多 40 个字符');
		const row = await c.env.db.prepare('SELECT rule_json AS ruleJson FROM user_batch WHERE batch_id = ?').bind(batchId).first();
		if (!row) throw new BizError('批次不存在');
		const rule = JSON.parse(row.ruleJson || '{}');
		rule.category = String(params.category || '').trim().slice(0, 30);
		rule.note = String(params.note || '').trim().slice(0, 200);
		rule.archived = params.archived ? 1 : 0;
		await c.env.db.prepare('UPDATE user_batch SET name = ?, rule_json = ? WHERE batch_id = ?')
			.bind(name, JSON.stringify(rule), batchId).run();
		return { batchId };
	},

	async delete(c, params) {
		const batchId = Number(params.batchId);
		if (!batchId) throw new BizError('请选择批次');
		const batch = await c.env.db.prepare('SELECT batch_id AS batchId FROM user_batch WHERE batch_id = ?').bind(batchId).first();
		if (!batch) throw new BizError('批次不存在');
		await c.env.db.batch([
			c.env.db.prepare('DELETE FROM user_batch_item WHERE batch_id = ?').bind(batchId),
			c.env.db.prepare('DELETE FROM user_batch WHERE batch_id = ?').bind(batchId)
		]);
		return { batchId };
	},

	async precheck(c, params) {
		const emails = Array.isArray(params.emails) ? params.emails.map(value => String(value || '').trim().toLowerCase()) : [];
		if (!emails.length) throw new BizError('没有可检测的邮箱');
		if (emails.length > MAX_BATCH_SIZE) throw new BizError(`单批最多检测 ${MAX_BATCH_SIZE} 个邮箱`);
		const counts = new Map();
		emails.forEach(email => counts.set(email, (counts.get(email) || 0) + 1));
		const accountMap = new Map();
		for (const group of chunks([...new Set(emails)], 80)) {
			const placeholders = group.map(() => '?').join(',');
			const { results } = await c.env.db.prepare(`
				SELECT a.email, a.is_del AS isDel,
					CASE WHEN u.user_id IS NULL THEN 'inbox' ELSE 'user' END AS kind
				FROM account a LEFT JOIN user u ON u.user_id = a.user_id AND u.email COLLATE NOCASE = a.email
				WHERE a.email COLLATE NOCASE IN (${placeholders})
			`).bind(...group).all();
			results.forEach(row => accountMap.set(row.email.toLowerCase(), row));
		}
		const results = emails.map(email => {
			if (!verifyUtils.isEmail(email)) return { email, status: 'invalid', label: '格式无效' };
			if (!c.env.domain.includes(emailUtils.getDomain(email))) return { email, status: 'invalid', label: '域名不可用' };
			if (counts.get(email) > 1) return { email, status: 'duplicate', label: '本批次重复' };
			const existing = accountMap.get(email);
			if (!existing) return { email, status: 'available', label: '可创建' };
			if (existing.isDel) return { email, status: 'deleted', kind: existing.kind, label: '已删除，可恢复' };
			return { email, status: 'existing', kind: existing.kind, label: existing.kind === 'user' ? '已存在 · 独立账户' : '已存在 · 收件箱' };
		});
		return { results, availableCount: results.filter(item => item.status === 'available').length };
	},

	async groupList(c, params) {
		await ensureGroupSchema(c);
		const ownerId = c.get('user').userId;
		const deleted = params.deleted === '1' ? 1 : 0;
		const keyword = String(params.keyword || '').trim();
		const bindings = [ownerId, deleted];
		let keywordSql = '';
		if (keyword) {
			keywordSql = 'AND g.name LIKE ?';
			bindings.push(`%${keyword}%`);
		}
		const { results } = await c.env.db.prepare(`
			SELECT g.group_id AS groupId, g.name, g.category, g.note, g.protected, g.is_del AS isDel,
				g.create_time AS createTime, COUNT(m.member_id) AS inboxCount,
				COALESCE(SUM((SELECT COUNT(*) FROM email e WHERE e.account_id = m.account_id AND e.is_del = 0)), 0) AS emailCount,
				COALESCE(SUM((SELECT COUNT(*) FROM email e WHERE e.account_id = m.account_id AND e.is_del = 0 AND e.unread = 0)), 0) AS unreadCount
			FROM inbox_batch_group g LEFT JOIN inbox_batch_member m ON m.group_id = g.group_id
			WHERE g.owner_id = ? AND g.is_del = ? ${keywordSql}
			GROUP BY g.group_id ORDER BY g.group_id DESC LIMIT 200
		`).bind(...bindings).all();
		return results;
	},

	async groupMembers(c, params) {
		await ensureGroupSchema(c);
		const groupId = Number(params.groupId);
		if (!groupId) throw new BizError('请选择分组');
		await this.requireOwnedGroup(c, groupId, true);
		const { page, size, offset } = pagination(params, 50);
		const keyword = String(params.keyword || '').trim();
		const bindings = [groupId];
		let keywordSql = '';
		if (keyword) {
			keywordSql = 'AND m.email LIKE ?';
			bindings.push(`%${keyword}%`);
		}
		const totalRow = await c.env.db.prepare(`SELECT COUNT(*) AS total FROM inbox_batch_member m WHERE m.group_id = ? ${keywordSql}`).bind(...bindings).first();
		const { results } = await c.env.db.prepare(`
			SELECT m.member_id AS memberId, m.account_id AS accountId, m.email, a.is_del AS isDel,
				COUNT(e.email_id) AS emailCount, SUM(CASE WHEN e.unread = 0 THEN 1 ELSE 0 END) AS unreadCount,
				MAX(e.create_time) AS latestEmailTime
			FROM inbox_batch_member m JOIN account a ON a.account_id = m.account_id
			LEFT JOIN email e ON e.account_id = m.account_id AND e.is_del = 0
			WHERE m.group_id = ? ${keywordSql}
			GROUP BY m.member_id ORDER BY m.member_id ASC LIMIT ? OFFSET ?
		`).bind(...bindings, size, offset).all();
		return { list: results, total: Number(totalRow?.total || 0), page, size };
	},

	async requireOwnedGroup(c, groupId, includeDeleted = false) {
		await ensureGroupSchema(c);
		const ownerId = c.get('user').userId;
		const row = await c.env.db.prepare(`SELECT group_id AS groupId, name, protected, is_del AS isDel FROM inbox_batch_group WHERE group_id = ? AND owner_id = ?`)
			.bind(groupId, ownerId).first();
		if (!row || (!includeDeleted && row.isDel)) throw new BizError('分组不存在');
		return row;
	},

	async groupProtect(c, params) {
		const groupId = Number(params.groupId);
		await this.requireOwnedGroup(c, groupId);
		await c.env.db.prepare('UPDATE inbox_batch_group SET protected = ?, update_time = ? WHERE group_id = ?')
			.bind(params.protected ? 1 : 0, dayjs().format('YYYY-MM-DD HH:mm:ss'), groupId).run();
		return { groupId, protected: !!params.protected };
	},

	async groupDelete(c, params) {
		const groupId = Number(params.groupId);
		const group = await this.requireOwnedGroup(c, groupId);
		if (group.protected) throw new BizError('保护分组不能删除，请先解除保护');
		const stats = await c.env.db.prepare(`
			SELECT COUNT(DISTINCT m.account_id) AS inboxCount, COUNT(e.email_id) AS emailCount
			FROM inbox_batch_member m LEFT JOIN email e ON e.account_id = m.account_id AND e.is_del = 0
			WHERE m.group_id = ?
		`).bind(groupId).first();
		if (Number(stats?.emailCount || 0) > 0 && String(params.confirmName || '') !== group.name) throw new BizError('组内存在邮件，请输入完整组名确认');
		const deleteInboxes = params.deleteInboxes !== false;
		const statements = [c.env.db.prepare('UPDATE inbox_batch_group SET is_del = 1, update_time = ? WHERE group_id = ?').bind(dayjs().format('YYYY-MM-DD HH:mm:ss'), groupId)];
		if (deleteInboxes) {
			statements.push(c.env.db.prepare('UPDATE inbox_batch_member SET deleted_with_group = 1 WHERE group_id = ?').bind(groupId));
			statements.push(c.env.db.prepare('UPDATE account SET is_del = 1 WHERE account_id IN (SELECT account_id FROM inbox_batch_member WHERE group_id = ?)').bind(groupId));
		}
		await c.env.db.batch(statements);
		return { groupId, inboxCount: Number(stats?.inboxCount || 0), emailCount: Number(stats?.emailCount || 0), deleteInboxes };
	},

	async groupRestore(c, params) {
		const groupId = Number(params.groupId);
		const group = await this.requireOwnedGroup(c, groupId, true);
		if (!group.isDel) return { groupId };
		await c.env.db.batch([
			c.env.db.prepare('UPDATE account SET is_del = 0 WHERE account_id IN (SELECT account_id FROM inbox_batch_member WHERE group_id = ? AND deleted_with_group = 1)').bind(groupId),
			c.env.db.prepare('UPDATE inbox_batch_member SET deleted_with_group = 0 WHERE group_id = ?').bind(groupId),
			c.env.db.prepare('UPDATE inbox_batch_group SET is_del = 0, update_time = ? WHERE group_id = ?').bind(dayjs().format('YYYY-MM-DD HH:mm:ss'), groupId)
		]);
		return { groupId };
	}
};

export default userBatchService;
