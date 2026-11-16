import app from './hono/webs';
import { bufferedEmail, consumeMail, recoverMail } from './email/mail-buffer';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import kvObjService from './service/kv-obj-service';
import oauthService from "./service/oauth-service";
import analysisService from './service/analysis-service';
import cardProtection from './service/card-protection-service';
export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 if (url.pathname.startsWith('/attachments/')) {
				 try {
					 if ((await cardProtection.read({env})).enabled) return new Response('Attachments unavailable while protection is enabled', {status:403,headers:{'Cache-Control':'no-store'}});
				 } catch { return new Response('Protection unavailable', {status:503,headers:{'Cache-Control':'no-store'}}); }
			 }
			 return await kvObjService.toObjResp( { env }, url.pathname.substring(1));
		 }

		return env.assets.fetch(req);
	},
	email: bufferedEmail,
	queue: consumeMail,
	async scheduled(c, env, ctx) {
		if (c.cron === '*/5 * * * *') {
			await recoverMail(env);
			return;
		}
		if (c.cron === '*/30 * * * *') {
			await analysisService.refreshEchartsCache({ env })
			return;
		}

		await verifyRecordService.clearRecord({ env })
		await userService.resetDaySendCount({ env })
		await emailService.completeReceiveAll({ env })
		await oauthService.clearNoBindOathUser({ env })
		await analysisService.refreshEchartsCache({ env })
	},
};
