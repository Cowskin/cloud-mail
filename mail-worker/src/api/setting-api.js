import app from '../hono/hono';
import result from '../model/result';
import settingService from '../service/setting-service';
import userContext from "../security/user-context";
import cardProtection from '../service/card-protection-service';
import giftWebhook from '../service/gift-webhook-config';

app.get('/setting/giftWebhook/status', async c => {
	c.header('Cache-Control', 'no-store, private');
	return c.json(result.ok(await giftWebhook.status(c)));
});
app.put('/setting/giftWebhook/update', async c => {
	c.header('Cache-Control', 'no-store, private');
	return c.json(result.ok(await giftWebhook.update(c, await c.req.json())));
});

app.get('/setting/cardProtection/status', async c => {
	c.header('Cache-Control', 'no-store, private');
	return c.json(result.ok(await cardProtection.status(c)));
});

app.put('/setting/cardProtection/update', async c => {
	c.header('Cache-Control', 'no-store, private');
	return c.json(result.ok(await cardProtection.update(c, await c.req.json())));
});

app.put('/setting/set', async (c) => {
	await settingService.set(c, await c.req.json());
	return c.json(result.ok());
});

app.get('/setting/query', async (c) => {
	const setting = await settingService.get(c);
	return c.json(result.ok(setting));
});

app.get('/setting/websiteConfig', async (c) => {
	const setting = await settingService.websiteConfig(c);
	return c.json(result.ok(setting));
})

app.put('/setting/setBackground', async (c) => {
	const key = await settingService.setBackground(c, await c.req.json());
	return c.json(result.ok(key));
});

app.delete('/setting/deleteBackground', async (c) => {
	await settingService.deleteBackground(c);
	return c.json(result.ok());
});

app.put('/setting/setBlacklist', async (c) => {
	const setting = await settingService.setBlacklist(c, await c.req.json());
	return c.json(result.ok(setting));
})

