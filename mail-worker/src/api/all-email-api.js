import app from '../hono/hono';
import emailService from '../service/email-service';
import result from '../model/result';
import { retryD1Read } from '../utils/d1-retry';

app.get('/allEmail/list', async (c) => {
	const data = await retryD1Read(() => emailService.allList(c, c.req.query()));
	return c.json(result.ok(data));
})

app.delete('/allEmail/delete', async (c) => {
	const list = await emailService.physicsDelete(c, c.req.query());
	return c.json(result.ok(list));
})

app.delete('/allEmail/batchDelete', async (c) => {
	await emailService.batchDelete(c, c.req.query());
	return c.json(result.ok());
})

app.get('/allEmail/latest', async (c) => {
	const list = await retryD1Read(() => emailService.allEmailLatest(c, c.req.query()));
	return c.json(result.ok(list));
})
