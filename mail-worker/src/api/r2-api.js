import r2Service from '../service/r2-service';
import app from '../hono/hono';
import cardProtection from '../service/card-protection-service';
import BizError from '../error/biz-error';

app.get('/oss/*', async (c) => {
	const key = c.req.path.split('/oss/')[1];
	if (key.startsWith('attachments/') && (await cardProtection.policy(c)).enabled) {
		throw new BizError('Attachments unavailable while protection is enabled', 403);
	}
	c.header('Cache-Control', 'no-store, private');
	const obj = await r2Service.getObj(c, key);
	return new Response(obj.body, {
		headers: {
			'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
			'Content-Disposition': obj.httpMetadata?.contentDisposition || null
		}
	});
});


