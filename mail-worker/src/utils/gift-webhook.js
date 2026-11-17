import BizError from '../error/biz-error.js';

// Infer the provider from a strict official endpoint, not from a caller-supplied
// provider flag. A saved URL can switch providers without changing the workflow.
export function webhookTarget(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw Error();
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) throw Error();
    if (url.hostname === 'qyapi.weixin.qq.com' && url.pathname === '/cgi-bin/webhook/send' &&
        [...url.searchParams.keys()].length === 1 && /^[a-zA-Z0-9_-]{8,128}$/.test(url.searchParams.get('key') || '')) {
      return {url:url.href,provider:'wecom'};
    }
    if (url.hostname === 'open.feishu.cn' && !url.search &&
        /^\/open-apis\/bot\/v2\/hook\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(url.pathname)) {
      return {url:url.href,provider:'feishu'};
    }
    throw Error();
  } catch { throw new BizError('请填写有效的企业微信或飞书群机器人 Webhook 地址 / Enter a valid WeCom or Feishu group robot webhook', 400); }
}
export const validateWebhook = value => webhookTarget(value).url;

export async function postWebhook(url, body, { fetcher = fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reason = 'invalid_destination';
  try {
    const target = webhookTarget(url);
    reason = 'invalid_payload';
    if (body?.msgtype !== 'text' || typeof body.text?.content !== 'string' || !body.text.content) throw Error();
    const payload = target.provider === 'feishu' ? {msg_type:'text',content:{text:body.text.content}} : body;
    reason = 'network_error';
    const response = await fetcher(target.url, {
      // Workers implements only follow/manual. Refuse redirects by checking
      // the returned status instead of using the unsupported "error" mode.
      method:'POST', redirect:'manual', signal:controller.signal,
      headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
    });
    if (!response.ok) { reason = `http_${response.status}`; await response.body?.cancel(); throw Error(); }
    reason = 'invalid_response';
    const reader = response.body?.getReader();
    if (!reader) throw Error();
    let length = 0;
    const chunks = [];
    try {
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 4096) { reason = 'response_too_large'; throw Error(); }
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
    const result = JSON.parse(new TextDecoder().decode(bytes));
    const success = target.provider === 'wecom' ? result.errcode === 0 :
      result.code === 0 || (result.code === undefined && result.StatusCode === 0);
    if (!success) {
      const code = target.provider === 'wecom' ? result.errcode : result.code ?? result.StatusCode;
      reason = Number.isSafeInteger(code) ? `${target.provider}_error_${code}` : 'invalid_response';
      throw Error();
    }
  } catch {
    const error = new Error('webhook_delivery_failed');
    error.deliveryReason = controller.signal.aborted ? 'timeout' : reason;
    throw error;
  }
  finally { clearTimeout(timer); }
}

// Kept for the original WeCom prototype callers.
export const postWecom = postWebhook;
