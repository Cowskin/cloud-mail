import app from '../hono/hono';
import emailService from '../service/email-service';
import result from '../model/result';
import userContext from '../security/user-context';
import attService from '../service/att-service';
import { retryD1Read } from '../utils/d1-retry';
import { authorizeMailLink } from '../service/mail-link-service';

app.post('/email/authorizeLink',async c => {
	c.header('Cache-Control','no-store, private');
	c.header('Referrer-Policy','no-referrer');
	return c.json(result.ok(await authorizeMailLink(c,await c.req.json())));
});

app.get('/email/list', async (c) => {
	const data = await retryD1Read(() => emailService.list(c, c.req.query(), userContext.getUserId(c)));
	return c.json(result.ok(data));
});

app.get('/email/latest', async (c) => {
	const list = await retryD1Read(() => emailService.latest(c, c.req.query(), userContext.getUserId(c)));
	return c.json(result.ok(list));
});

app.delete('/email/delete', async (c) => {
	await emailService.delete(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.get('/email/attList', async (c) => {
	const attList = await attService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(attList));
});

app.post('/email/send', async (c) => {
	const email = await emailService.send(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(email));
});

app.put('/email/read', async (c) => {
	await emailService.read(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
})

