import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';
import { cors } from 'hono/cors';

app.use('*', cors());

app.onError((err, c) => {
	const sensitive = /^\/(?:email|allEmail|star|public\/emailList|telegram|setting\/(?:cardProtection|giftWebhook))(?:\/|$)/.test(c.req.path);
	if (sensitive && err.name !== 'BizError') {
		console.error(JSON.stringify({name:err.name,path:c.req.path.split('/').slice(0,3).join('/'),method:c.req.method}));
		return c.json(result.fail('请求处理失败，请稍后重试 / Request failed; please retry', 503));
	}
	if (err.name === 'BizError') {
		console.log(err.message);
	} else {
		console.error(JSON.stringify({
			name: err.name, message: err.message,
			cause: err.cause?.message, stack: err.stack,
			path: c.req.path, method: c.req.method
		}));
	}

	if (err.message === `Cannot read properties of undefined (reading 'get')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'put')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'prepare')`) {
		return c.json(result.fail('D1数据库未绑定 D1 database not bound',502));
	}

	return c.json(result.fail(err.message, err.code));
});

export default app;


