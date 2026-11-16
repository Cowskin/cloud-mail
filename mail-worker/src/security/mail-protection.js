import app from '../hono/hono';
import cardProtection from '../service/card-protection-service';
import { mailProtector } from '../utils/protect-mail';
import BizError from '../error/biz-error';

const readPaths = new Set(['/email/list', '/email/latest', '/email/send', '/star/list',
  '/allEmail/list', '/allEmail/latest', '/public/emailList', '/email/protectDraft', '/email/attList']);

app.use('*', async (c, next) => {
  if (!readPaths.has(c.req.path) && c.req.path !== '/allEmail/batchDelete') return next();
  const policy = await cardProtection.policy(c);
  if (policy.enabled && ['/allEmail/list', '/public/emailList', '/allEmail/batchDelete'].includes(c.req.path)) {
    const params = c.req.method === 'POST' ? await c.req.json() : c.req.query();
    // Ordinary subject/sender searches keep using the existing metadata indexes.
    // Do not introduce body scans or change destructive batch-cleanup filters.
    const blocked = c.req.path === '/allEmail/batchDelete'
      ? ['content', 'text', 'subject', 'name', 'sendName'] : ['content', 'text'];
    if (blocked.some(key => params[key])) {
      throw new BizError(c.req.path === '/allEmail/batchDelete'
        ? '保护开启时批量清理仅支持邮箱地址和日期筛选 / Protected batch cleanup supports address and date filters only'
        : '保护开启时暂不支持正文检索 / Body search is unavailable while card protection is enabled', 400);
    }
  }
  if (c.req.path === '/allEmail/batchDelete') return next();
  await next();
  if (!c.res.headers.get('Content-Type')?.includes('application/json')) return;
  c.header('Cache-Control', 'no-store, private');
  c.header('X-Card-Protection-Version', String(policy.version));
  c.header('X-Card-Protection-Enabled', String(policy.enabled));
  if (!policy.enabled) {
    if ((await cardProtection.read(c)).version !== policy.version) {
      throw new BizError('保护设置已变更，请刷新重试 / Protection settings changed; refresh and retry', 409);
    }
    // Default-off traffic does not parse, clone or scan the response body.
    return;
  }
  const payload = await c.res.json();
  if (payload.code === 200) {
    try {
      payload.data = policy.enabled && c.req.path === '/email/attList' ? [] :
        await (await mailProtector(c, policy)).protect(payload.data);
      if ((await cardProtection.read(c)).version !== policy.version) {
        throw new BizError('保护设置已变更，请刷新重试 / Protection settings changed; refresh and retry', 409);
      }
    } catch (error) {
      // Never return the unprotected payload or a parser exception containing it.
      if (error instanceof BizError) throw error;
      throw new BizError('邮件保护处理失败，请稍后重试 / Mail protection failed; please retry', 503);
    }
  }
  c.res = new Response(JSON.stringify(payload), { status: c.res.status, headers: c.res.headers });
});

app.get('/email/protectionState', async c => {
  const row = await cardProtection.policy(c);
  c.header('Cache-Control', 'no-store, private');
  return c.json({ code: 200, data: { enabled: !!row.enabled, version: row.version } });
});

// Used only to protect an existing local draft when it is opened, or before a
// new draft is saved. No draft is logged or stored by this endpoint.
app.post('/email/protectDraft', async c => {
  const data = await c.req.json();
  if (JSON.stringify(data).length > 2 * 1024 * 1024) throw new BizError('Draft too large', 413);
  return c.json({ code: 200, data });
});
