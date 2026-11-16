import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';
import aiService from '../service/ai-service';
import { deliveryState, receiveOnce, finishDelivery } from './delivery-store';
import cardProtection from '../service/card-protection-service';
import { protectMail } from '../utils/protect-mail';

export async function processEmail(message, env, ctx, deliveryKey) {
	const reject = async reason => {
		if (deliveryKey) await env.db.prepare(`INSERT INTO email_delivery(delivery_key,state) VALUES (?,'rejected')
			ON CONFLICT(delivery_key) DO UPDATE SET state='rejected' WHERE state='pending'`).bind(deliveryKey).run();
		message.setReject(reason);
	};

	try {
		if (deliveryKey && ['delivered','rejected'].includes((await deliveryState(env,deliveryKey))?.state)) return;

		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient,
			blackSubject,
			blackContent,
			blackFrom,
			aiCode,
			aiCodeFilter
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			await reject('Service suspended');
			return;
		}

		// Parse bytes directly: decoding each stream chunk separately corrupts UTF-8
		// characters split between chunks (and needlessly copies the entire message).
		const email = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
		if (!email.from?.address) email.from={address:message.from,name:''};


		const blockFlag = checkBlock(blackSubject, blackContent, blackFrom, email);

		if (blockFlag) {
			await reject('Message rejected');
			return;
		}

		const account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			await reject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				await reject('The recipient is not authorized to use this domain.');
				return;
			}

			if(roleService.isBanEmail(banEmail, email.from.address)) {
				await reject('The recipient is disabled from receiving emails.');
				return;
			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';
		const protection = await cardProtection.read({ env });
		const protectionContext = { env, get: key => key === 'cardPolicy' ? Promise.resolve(protection) : null };
		// The AI must not receive raw cards either. Stored originals are unchanged.
		const aiEmail = protection.enabled ? await protectMail(protectionContext, email) : email;
		const code = await aiService.extractCode({ env }, aiEmail, { aiCode, aiCodeFilter });

		const params = {
			createTime:(message.receivedAt ? new Date(message.receivedAt) : new Date()).toISOString().replace('T',' ').slice(0,19),
			toEmail: message.to,
			toName: toName,
			sendEmail: email.from.address,
			name: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject,
			code,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		let emailRow;
		if (deliveryKey) {
			params.content=emailService.imgReplace(params.content,cidAttachments,r2Domain);
			const receipt=await receiveOnce({env},deliveryKey,params);
			if (receipt.state!=='pending') return;
			emailRow={...params,emailId:receipt.emailId};
		} else {
			emailRow=await emailService.receive({env},params,cidAttachments,r2Domain);
		}

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		if (attachments.length > 0) await attService.addReceivedAtt({env},attachments);

		const status=account ? emailConst.status.RECEIVE : emailConst.status.NOONE;
		if (deliveryKey) {
			if (!await finishDelivery(env,deliveryKey,emailRow.emailId,status)) return;
			emailRow={...emailRow,status,isDel:isDel.NORMAL};
		} else {
			emailRow=await emailService.completeReceive({env},status,emailRow.emailId);
		}


		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',');

			if (!emails.includes(message.to)) {
				return;
			}

		}

		//转发到TG
		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			try { await telegramService.sendEmailToBot({env},emailRow); }
			catch { console.error('mail_telegram_notification_failed'); }
		}

		//转发到其他邮箱
		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail && !(await cardProtection.read({env})).enabled) {

			const emails = forwardEmail.split(',');

			await Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error('mail_forward_failed');
				}

			}));

		}

	} catch (e) {
		console.error('mail_processing_failed');
		throw e
	}
}

function checkBlock(blackSubjectStr, blackContentStr, blackFromStr, email) {

	const blackFromList = blackFromStr ? blackFromStr.split(',') : []
	const blackContentList = blackContentStr ? blackContentStr.split(',') : []
	const blackSubjectList = blackSubjectStr ? blackSubjectStr.split(',') : []

	for (const blackSubject of blackSubjectList) {
		if (email.subject?.includes(blackSubject)) {
			return true
		}
	}

	for (const blackContent of blackContentList) {
		if (email.html?.includes(blackContent) || email.text?.includes(blackContent)) {
			return true
		}
	}

	for (const blackFrom of blackFromList) {
		if (email.from.address === blackFrom || emailUtils.getDomain(email.from.address) === blackFrom) {
			return true
		}
	}

	return false

}
