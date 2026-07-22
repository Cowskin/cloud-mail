import app from '../hono/hono';
import result from '../model/result';
import userBatchService from '../service/user-batch-service';

app.post('/userBatch/create', async c => {
	return c.json(result.ok(await userBatchService.create(c, await c.req.json())));
});

app.get('/userBatch/list', async c => {
	return c.json(result.ok(await userBatchService.list(c, c.req.query())));
});

app.get('/userBatch/items', async c => {
	return c.json(result.ok(await userBatchService.items(c, c.req.query())));
});

app.put('/userBatch/update', async c => {
	return c.json(result.ok(await userBatchService.update(c, await c.req.json())));
});

app.delete('/userBatch/delete', async c => {
	return c.json(result.ok(await userBatchService.delete(c, c.req.query())));
});

app.post('/userBatch/precheck', async c => {
	return c.json(result.ok(await userBatchService.precheck(c, await c.req.json())));
});

app.get('/inboxGroup/list', async c => {
	return c.json(result.ok(await userBatchService.groupList(c, c.req.query())));
});

app.get('/inboxGroup/members', async c => {
	return c.json(result.ok(await userBatchService.groupMembers(c, c.req.query())));
});

app.put('/inboxGroup/protect', async c => {
	return c.json(result.ok(await userBatchService.groupProtect(c, await c.req.json())));
});

app.delete('/inboxGroup/delete', async c => {
	return c.json(result.ok(await userBatchService.groupDelete(c, await c.req.json())));
});

app.put('/inboxGroup/restore', async c => {
	return c.json(result.ok(await userBatchService.groupRestore(c, await c.req.json())));
});

app.delete('/inboxGroup/purge', async c => {
	return c.json(result.ok(await userBatchService.groupPurge(c, await c.req.json())));
});
