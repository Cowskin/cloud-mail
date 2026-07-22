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
