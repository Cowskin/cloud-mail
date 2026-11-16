import app from '../hono/hono';
import userService from '../service/user-service';
import result from '../model/result';
import userContext from '../security/user-context';
import { retryD1Read } from '../utils/d1-retry';

app.get('/my/loginUserInfo', async (c) => {
	const user = await retryD1Read(() => userService.loginUserInfo(c, userContext.getUserId(c)));
	return c.json(result.ok(user));
});

app.put('/my/resetPassword', async (c) => {
	await userService.resetPassword(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.delete('/my/delete', async (c) => {
	await userService.delete(c, userContext.getUserId(c));
	return c.json(result.ok());
});


