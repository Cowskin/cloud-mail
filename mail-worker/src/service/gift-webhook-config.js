import BizError from '../error/biz-error';
import protection from './card-protection-service';
import { validateWebhook,webhookTarget } from '../utils/gift-webhook';

const enc = new TextEncoder();
const unavailable = () => new BizError('礼品卡通知配置暂不可用 / Gift notification configuration unavailable',503);
const encode = bytes => btoa(String.fromCharCode(...bytes));
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
async function key(c) {
  try {
    const bytes = decode(c.env.CARD_PROTECTION_SECRET);
    if (bytes.length !== 32) throw Error();
    return await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);
  } catch { throw unavailable(); }
}
const aad = version => enc.encode(`cloudmail/gift-webhook/v1:${version}`);
const service = {
  async read(c) {
    try {
      const row = await c.env.db.prepare('SELECT * FROM gift_webhook_config WHERE id=1').first();
      if (!row) throw Error();
      return row;
    } catch { throw unavailable(); }
  },
  async status(c) {
    const [row,policy] = await Promise.all([this.read(c),protection.read(c)]);
    return {version:row.version,configured:!!row.sealed_url,active:!!row.sealed_url && !!policy.enabled,
      provider:row.provider || null,url:row.sealed_url ? await this.url(c,row) : ''};
  },
  async url(c,row) {
    try {
      const bytes = decode(row.sealed_url);
      const value = await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12),additionalData:aad(row.version)},await key(c),bytes.slice(12));
      return validateWebhook(new TextDecoder().decode(value));
    } catch { throw unavailable(); }
  },
  async update(c,{version,protectionVersion,url,remove=false}) {
    if (!Number.isSafeInteger(version) || !Number.isSafeInteger(protectionVersion) || typeof remove !== 'boolean') throw new BizError('无效操作 / Invalid operation',400);
    const policy = await protection.read(c);
    if (policy.version !== protectionVersion) throw new BizError('加密设置已变更，请刷新 / Protection settings changed; refresh',409);
    if (!remove && !policy.enabled) throw new BizError('请先开启卡号加密 / Enable card protection first',400);
    const previous = await this.read(c);
    if (previous.version !== version) throw new BizError('设置已变更，请刷新后重试 / Settings changed; refresh and retry',409);
    let sealed = null, provider = null;
    if (!remove) {
      const target = webhookTarget(url), validated = target.url, iv = crypto.getRandomValues(new Uint8Array(12));
      // Saving the displayed URL again must not cancel pending notifications or
      // move the capture boundary. Still reject a concurrent settings change.
      if (previous.sealed_url && validated === await this.url(c,previous)) {
        const unchanged = await c.env.db.prepare(`SELECT c.id FROM gift_webhook_config c,card_protection p
          WHERE c.id=1 AND c.version=? AND p.id=1 AND p.version=? AND p.enabled=1`)
          .bind(version,protectionVersion).first();
        if (!unchanged) throw new BizError('设置已变更，请刷新后重试 / Settings changed; refresh and retry',409);
        return this.status(c);
      }
      provider = target.provider;
      const bytes = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(version+1)},await key(c),enc.encode(validated)));
      sealed = encode(new Uint8Array([...iv,...bytes]));
    }
    const updated = await c.env.db.prepare(`UPDATE gift_webhook_config SET version=version+1,sealed_url=?,provider=?,capture_after=datetime('now'),updated_at=datetime('now')
      WHERE id=1 AND version=? AND EXISTS(SELECT 1 FROM card_protection WHERE id=1 AND version=? AND (enabled=1 OR ?=1)) RETURNING version`)
      .bind(sealed,provider,version,protectionVersion,remove?1:0).first();
    if (!updated) throw new BizError('设置已变更，请刷新后重试 / Settings changed; refresh and retry',409);
    return this.status(c);
  }
};
export default service;
