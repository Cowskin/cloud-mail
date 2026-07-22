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
		const list = Array.isArray(params.list) ? params.list : [];

		if (!batchName) throw new BizError('请输入批次名称');
		if (!list.length) throw new BizError('没有可创建的邮箱');
		if (list.length > MAX_BATCH_SIZE) throw new BizError(`单批最多创建 ${MAX_BATCH_SIZE} 个邮箱`);

		const roleList = await roleService.roleSelectUse(c);
		const roleIds = new Set(roleList.map(item => item.roleId));
		const now = dayjs().format('YYYY-MM-DD HH:mm:ss');
		const operatorId = c.get('user').userId;
		const batch = await c.env.db.prepare(`
			INSERT INTO user_batch (name, rule_json, total, success_count, failed_count, operator_id, create_time)
			VALUES (?, ?, ?, 0, 0, ?, ?) RETURNING batch_id
		`).bind(batchName, JSON.stringify(rule), list.length, operatorId, now).first();

		const normalized = [];
		const seen = new Set();
		for (const row of list) {
			const email = String(row.email || '').trim().toLowerCase();
			const password = String(row.password || '');
			const type = Number(row.type);
			let error = '';
			if (!verifyUtils.isEmail(email)) error = '邮箱格式不正确';
			else if (!c.env.domain.includes(emailUtils.getDomain(email))) error = '邮箱域名不可用';
			else if (password.length < 6) error = '密码至少需要 6 位';
			else if (!roleIds.has(type)) error = '权限身份不存在';
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
				`SELECT email FROM user WHERE email COLLATE NOCASE IN (${placeholders})`
			).bind(...group).all();
			results.forEach(item => existing.add(item.email.toLowerCase()));
		}

		const activeIp = reqUtils.getIp(c);
		const { os, browser, device } = reqUtils.getUserAgent(c);
		const results = [];
		for (const item of normalized) {
			if (!item.error && existing.has(item.email)) item.error = '邮箱已存在';
			if (!item.error) {
				const { salt, hash } = await cryptoUtils.hashPassword(item.password);
				item.salt = salt;
				item.hash = hash;
			}
			results.push({ email: item.email, success: !item.error, error: item.error });
		}

		for (const group of chunks(normalized, WRITE_CHUNK_SIZE)) {
			const statements = [];
			for (const item of group) {
				if (!item.error) {
					statements.push(c.env.db.prepare(`
						INSERT INTO user (email, password, salt, type, os, browser, active_ip, create_ip, device, active_time, create_time)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`).bind(item.email, item.hash, item.salt, item.type, os, browser, activeIp, activeIp, device, now, now));
					statements.push(c.env.db.prepare(`
						INSERT INTO account (email, name, user_id)
						SELECT ?, ?, user_id FROM user WHERE email COLLATE NOCASE = ?
					`).bind(item.email, emailUtils.getName(item.email), item.email));
				}
				statements.push(c.env.db.prepare(`
					INSERT INTO user_batch_item (batch_id, email, status, error, create_time)
					VALUES (?, ?, ?, ?, ?)
				`).bind(batch.batch_id, item.email, item.error ? 0 : 1, item.error, now));
			}
			await c.env.db.batch(statements);
		}

		const successCount = results.filter(item => item.success).length;
		await c.env.db.prepare(`
			UPDATE user_batch SET success_count = ?, failed_count = ? WHERE batch_id = ?
		`).bind(successCount, results.length - successCount, batch.batch_id).run();

		return { batchId: batch.batch_id, results, successCount, failedCount: results.length - successCount };
	},

	async list(c, params) {
		const keyword = String(params.keyword || '').trim();
		const domain = String(params.domain || '').trim();
		const category = String(params.category || '').trim();
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
	}
};

export default userBatchService;
