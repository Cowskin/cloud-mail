import BizError from '../error/biz-error';
import verifyUtils from '../utils/verify-utils';
import emailUtils from '../utils/email-utils';
import userService from './user-service';
import emailService from './email-service';
import orm from '../entity/orm';
import account from '../entity/account';
import { and, eq, inArray, count, sql, ne } from 'drizzle-orm';
import {accountConst, isDel, settingConst} from '../const/entity-const';
import settingService from './setting-service';
import turnstileService from './turnstile-service';
import roleService from './role-service';
import { t } from '../i18n/i18n';
import verifyRecordService from './verify-record-service';

const accountService = {

	async add(c, params, userId) {

		const { addEmailVerify , addEmail, manyEmail, addVerifyCount, minEmailPrefix, emailPrefixFilter } = await settingService.query(c);

		let { email, token } = params;


		if (!(addEmail === settingConst.addEmail.OPEN && manyEmail === settingConst.manyEmail.OPEN)) {
			throw new BizError(t('addAccountDisabled'));
		}


		if (!email) {
			throw new BizError(t('emptyEmail'));
		}

		if (!verifyUtils.isEmail(email)) {
			throw new BizError(t('notEmail'));
		}

		if (!c.env.domain.includes(emailUtils.getDomain(email))) {
			throw new BizError(t('notExistDomain'));
		}

		if (emailUtils.getName(email).length < minEmailPrefix) {
			throw new BizError(t('minEmailPrefix', { msg: minEmailPrefix } ));
		}

		if (emailPrefixFilter.some(content => emailUtils.getName(email).includes(content))) {
			throw new BizError(t('banEmailPrefix'));
		}

		let accountRow = await this.selectByEmailIncludeDel(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelAccount'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		const userRow = await userService.selectById(c, userId);
		const roleRow = await roleService.selectById(c, userRow.type);

		if (userRow.email !== c.env.admin) {

			if (roleRow.accountCount > 0) {
				const userAccountCount = await accountService.countUserAccount(c, userId)
				if(userAccountCount >= roleRow.accountCount) throw new BizError(t('accountLimit'), 403);
			}

			if(!roleService.hasAvailDomainPerm(roleRow.availDomain, email)) {
				throw new BizError(t('noDomainPermAdd'),403)
			}

		}

		let addVerifyOpen = false

		if (addEmailVerify === settingConst.addEmailVerify.OPEN) {
			addVerifyOpen = true
			await turnstileService.verify(c, token);
		}

		if (addEmailVerify === settingConst.addEmailVerify.COUNT) {
			addVerifyOpen = await verifyRecordService.isOpenAddVerify(c, addVerifyCount);
			if (addVerifyOpen) {
				await turnstileService.verify(c,token)
			}
		}


		accountRow = await orm(c).insert(account).values({ email: email, userId: userId, name: emailUtils.getName(email) }).returning().get();

		if (addEmailVerify === settingConst.addEmailVerify.COUNT && !addVerifyOpen) {
			const row = await verifyRecordService.increaseAddCount(c);
			addVerifyOpen = row.count >= addVerifyCount
		}

		accountRow.addVerifyOpen = addVerifyOpen
		return accountRow;
	},

	selectByEmailIncludeDel(c, email) {
		return orm(c).select().from(account).where(sql`${account.email} COLLATE NOCASE = ${email}`).get();
	},

	async list(c, params, userId) {

		let { accountId, size, lastSort } = params;

		accountId = Number(accountId);
		size = Number(size);
		lastSort = Number(lastSort);

		if (size > 30) {
			size = 30;
		}

		if (!accountId) {
			accountId = 0;
		}

		if(Number.isNaN(lastSort)) {
			lastSort = 9999999999;
		}

		const { results } = await c.env.db.prepare(`
			SELECT a.account_id AS accountId, a.email, a.name, a.status,
				a.latest_email_time AS latestEmailTime, a.create_time AS createTime,
				a.user_id AS userId, a.all_receive AS allReceive, a.sort, a.is_del AS isDel,
				g.group_id AS groupId, g.name AS groupName, COALESCE(g.protected, 0) AS groupProtected
			FROM account a
			LEFT JOIN inbox_batch_member m ON m.account_id = a.account_id
			LEFT JOIN inbox_batch_group g ON g.group_id = m.group_id AND g.is_del = 0
			WHERE a.user_id = ? AND a.is_del = ?
				AND (a.sort < ? OR (a.sort = ? AND a.account_id > ?))
			ORDER BY a.sort DESC, a.account_id ASC
			LIMIT ?
		`).bind(userId, isDel.NORMAL, lastSort, lastSort, accountId, size).all();
		return results;
	},

	async delete(c, params, userId) {

		let { accountId } = params;

		const user = await userService.selectById(c, userId);
		const accountRow = await this.selectById(c, accountId);

		if (accountRow.email === user.email) {
			throw new BizError(t('delMyAccount'));
		}

		if (accountRow.userId !== user.userId) {
			throw new BizError(t('noUserAccount'));
		}

		const protectedGroup = await c.env.db.prepare(`
			SELECT g.name
			FROM inbox_batch_member m
			JOIN inbox_batch_group g ON g.group_id = m.group_id
			WHERE m.account_id = ? AND g.protected = 1 AND g.is_del = 0
			LIMIT 1
		`).bind(accountId).first();
		if (protectedGroup) {
			throw new BizError(`该收件箱属于已保护分组“${protectedGroup.name}”，请先在批量注册中解除保护`);
		}

		await orm(c).update(account).set({ isDel: isDel.DELETE }).where(
			and(eq(account.userId, userId),
				eq(account.accountId, accountId)))
			.run();
	},

	async deletedList(c, userId) {
		const { results } = await c.env.db.prepare(`
			SELECT a.account_id AS accountId, a.email, a.name, a.create_time AS createTime,
				g.group_id AS groupId, g.name AS groupName, COALESCE(g.protected, 0) AS groupProtected,
				(SELECT COUNT(*) FROM email e WHERE e.account_id = a.account_id) AS emailCount,
				(SELECT COUNT(*) FROM attachments att WHERE att.account_id = a.account_id) AS attachmentCount
			FROM account a
			LEFT JOIN inbox_batch_member m ON m.account_id = a.account_id
			LEFT JOIN inbox_batch_group g ON g.group_id = m.group_id
			WHERE a.user_id = ? AND a.is_del = 1
				AND COALESCE(m.deleted_with_group, 0) = 0
				AND (g.group_id IS NULL OR g.is_del = 0)
			ORDER BY a.account_id DESC LIMIT 500
		`).bind(userId).all();
		return results;
	},

	async restore(c, params, userId) {
		const accountId = Number(params.accountId);
		if (!accountId) throw new BizError('请选择要恢复的邮箱');
		const row = await c.env.db.prepare(`
			SELECT a.email, a.is_del AS isDel, g.is_del AS groupIsDel,
				COALESCE(m.deleted_with_group, 0) AS deletedWithGroup
			FROM account a
			LEFT JOIN inbox_batch_member m ON m.account_id = a.account_id
			LEFT JOIN inbox_batch_group g ON g.group_id = m.group_id
			WHERE a.account_id = ? AND a.user_id = ?
		`).bind(accountId, userId).first();
		if (!row) throw new BizError('邮箱不存在');
		if (row.groupIsDel || row.deletedWithGroup) throw new BizError('该邮箱随整个分组删除，请从已删除分组整体恢复');
		if (!row.isDel) return { accountId, email: row.email };
		await c.env.db.prepare('UPDATE account SET is_del = 0 WHERE account_id = ? AND user_id = ?').bind(accountId, userId).run();
		return { accountId, email: row.email };
	},

	async purge(c, params, userId) {
		const accountId = Number(params.accountId);
		if (!accountId) throw new BizError('请选择要永久删除的邮箱');
		const row = await c.env.db.prepare(`
			SELECT a.email, a.is_del AS isDel, g.name AS groupName, g.protected AS groupProtected,
				g.is_del AS groupIsDel, COALESCE(m.deleted_with_group, 0) AS deletedWithGroup,
				(SELECT COUNT(*) FROM email e WHERE e.account_id = a.account_id) AS emailCount,
				(SELECT COUNT(*) FROM attachments att WHERE att.account_id = a.account_id) AS attachmentCount
			FROM account a
			LEFT JOIN inbox_batch_member m ON m.account_id = a.account_id
			LEFT JOIN inbox_batch_group g ON g.group_id = m.group_id
			WHERE a.account_id = ? AND a.user_id = ?
		`).bind(accountId, userId).first();
		if (!row) throw new BizError('邮箱不存在');
		if (!row.isDel) throw new BizError('只能永久删除“已删除邮箱”中的邮箱');
		if (row.groupIsDel || row.deletedWithGroup) throw new BizError('该邮箱随整个分组删除，请在已删除分组中处理');
		if (row.groupProtected) throw new BizError(`该邮箱属于已保护分组“${row.groupName}”，请先恢复并解除保护`);
		const hasContent = Number(row.emailCount || 0) > 0 || Number(row.attachmentCount || 0) > 0;
		if (hasContent && String(params.confirmEmail || '').toLowerCase() !== String(row.email).toLowerCase()) {
			throw new BizError('邮箱内存在邮件或附件，请输入完整邮箱地址确认');
		}
		await c.env.db.prepare('DELETE FROM star WHERE email_id IN (SELECT email_id FROM email WHERE account_id = ?)').bind(accountId).run();
		await emailService.physicsDeleteByAccountId(c, accountId);
		await c.env.db.batch([
			c.env.db.prepare('DELETE FROM inbox_batch_member WHERE account_id = ?').bind(accountId),
			c.env.db.prepare('DELETE FROM account WHERE account_id = ? AND user_id = ?').bind(accountId, userId)
		]);
		return { accountId, email: row.email };
	},

	selectById(c, accountId) {
		return orm(c).select().from(account).where(
			and(eq(account.accountId, accountId),
				eq(account.isDel, isDel.NORMAL)))
			.get();
	},

	async insert(c, params) {
		await orm(c).insert(account).values({ ...params }).returning();
	},

	async insertList(c, list) {
		await orm(c).insert(account).values(list).run();
	},

	async physicsDeleteByUserIds(c, userIds) {
		await emailService.physicsDeleteUserIds(c, userIds);
		await orm(c).delete(account).where(inArray(account.userId,userIds)).run();
	},

	async selectUserAccountCountList(c, userIds, del = isDel.NORMAL) {
		const result = await orm(c)
			.select({
				userId: account.userId,
				count: count(account.accountId)
			})
			.from(account)
			.where(and(
				inArray(account.userId, userIds),
				eq(account.isDel, del)
			))
			.groupBy(account.userId)
		return result;
	},

	async countUserAccount(c, userId) {
		const { num } = await orm(c).select({num: count()}).from(account).where(and(eq(account.userId, userId),eq(account.isDel, isDel.NORMAL))).get();
		return num;
	},

	async restoreByEmail(c, email) {
		await orm(c).update(account).set({isDel: isDel.NORMAL}).where(eq(account.email, email)).run();
	},

	async restoreByUserId(c, userId) {
		await orm(c).update(account).set({isDel: isDel.NORMAL}).where(eq(account.userId, userId)).run();
	},

	async setName(c, params, userId) {
		const { name, accountId } = params
		if (name.length > 30) {
			throw new BizError(t('usernameLengthLimit'));
		}
		await orm(c).update(account).set({name}).where(and(eq(account.userId, userId),eq(account.accountId, accountId))).run();
	},

	async allAccount(c, params) {

		let { userId, num, size } = params

		userId = Number(userId)

		num = Number(num)
		size = Number(size)

		if (size > 30) {
			size = 30;
		}

		num = (num - 1) * size;

		const userRow = await userService.selectByIdIncludeDel(c, userId);

		const list = await orm(c).select().from(account).where(and(eq(account.userId, userId),ne(account.email,userRow.email))).limit(size).offset(num);
		const { total } = await orm(c).select({ total: count() }).from(account).where(eq(account.userId, userId)).get();

		return { list, total }
	},

	async physicsDelete(c, params) {
		const { accountId } = params
		await emailService.physicsDeleteByAccountId(c, accountId)
		await orm(c).delete(account).where(eq(account.accountId, accountId)).run();
	},

	async setAllReceive(c, params, userId) {
		let a = null
		const { accountId } = params;
		const accountRow = await this.selectById(c, accountId);
		if (accountRow.userId !== userId) {
			return;
		}
		await orm(c).update(account).set({ allReceive: accountConst.allReceive.CLOSE }).where(eq(account.userId, userId)).run();
		await orm(c).update(account).set({ allReceive: accountRow.allReceive ? 0 : 1 }).where(eq(account.accountId, accountId)).run();
	},

	async setAsTop(c, params, userId) {
		const { accountId } = params;
		const userRow = await userService.selectById(c, userId);
		const mainAccountRow = await accountService.selectByEmailIncludeDel(c, userRow.email);
		let mainSort = mainAccountRow.sort === 0 ? 2 : mainAccountRow.sort + 1;
		await orm(c).update(account).set({ sort: mainSort }).where(eq(account.email, userRow.email )).run();
		await orm(c).update(account).set({ sort: mainSort - 1 }).where(and(eq(account.accountId, accountId),eq(account.userId,userId))).run();
	}
};

export default accountService;
