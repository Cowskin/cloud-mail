import app from '../hono/hono';
import telegramService from '../service/telegram-service';
import cardProtection from '../service/card-protection-service';
import BizError from '../error/biz-error';

app.get('/telegram/getEmail/:token', async (c) => {
	const content = await telegramService.getEmailContent(c, c.req.param());
	const policy = await c.get('cardPolicy');
	if (policy && (await cardProtection.read(c)).version !== policy.version) {
		throw new BizError('Protection settings changed; refresh and retry', 409);
	}
	c.header('Cache-Control', 'no-store, private');
	return c.html(content)
});

