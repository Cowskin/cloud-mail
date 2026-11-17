import BizError from '../error/biz-error';
import { createCipher, deriveMaterial, sign, validPassword } from '../utils/card-cipher';

const enc = new TextEncoder();
const unavailable = () => new BizError('卡号保护暂不可用，请联系管理员 / Card protection unavailable', 503);
export const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const same = (a, b) => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
};

async function sealingKey(c) {
  try {
    const raw = fromBase64(c.env.CARD_PROTECTION_SECRET);
    if (raw.length !== 32) throw new Error();
    return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch { throw unavailable(); }
}

async function seal(c, material, version) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: enc.encode(`cloudmail/card-protection/v1:${version}`)
  }, await sealingKey(c), material));
  return toBase64(new Uint8Array([...iv, ...encrypted]));
}

async function checkPassword(row, password) {
  if (!validPassword(password)) throw new BizError('请输入原保护密码 / Enter current protection password',400);
  if (!row.verifier) throw unavailable();
  const material = await deriveMaterial(password);
  try {
    if (!same(await sign(material, `cloudmail/verify/${row.verifier_salt}`),fromBase64(row.verifier))) {
      throw new BizError('原保护密码不正确 / Incorrect protection password',400);
    }
  } finally { material.fill(0); }
}

// Only cryptographic contexts are cached. Policy/version is read from D1 for
// every request; KV eventual consistency must never re-enable raw output.
const contexts = new Map();
const service = {
  async read(c) {
    try {
      const row = await c.env.db.prepare('SELECT * FROM card_protection WHERE id=1').first();
      if (!row) throw new Error();
      return row;
    } catch { throw unavailable(); }
  },
  async policy(c) {
    if (!c.get?.('cardPolicy')) {
      const promise = this.read(c);
      c.set?.('cardPolicy', promise);
      return promise;
    }
    return c.get('cardPolicy');
  },
  async status(c) {
    const row = await this.read(c);
    let ready = true;
    try { await sealingKey(c); } catch { ready = false; }
    return { enabled: row.enabled === 1, version: row.version, configured: !!row.verifier, ready };
  },
  async cipher(c, row) {
    if (!row.enabled) return null;
    const cacheKey = `${c.env.CARD_PROTECTION_SECRET}:${row.version}:${row.sealed_key}`;
    if (contexts.has(cacheKey)) return contexts.get(cacheKey);
    try {
      const data = fromBase64(row.sealed_key);
      const material = new Uint8Array(await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: data.slice(0, 12), additionalData: enc.encode(`cloudmail/card-protection/v1:${row.version}`)
      }, await sealingKey(c), data.slice(12)));
      try {
        const cipher = await createCipher(material);
        contexts.clear();
        contexts.set(cacheKey, cipher);
        return cipher;
      } finally { material.fill(0); }
    } catch { throw unavailable(); }
  },
  // Shared by password changes and one-link authorization. Failed or abandoned
  // attempts count atomically across Worker instances for 15 minutes.
  async reserveAttempt(c,version) {
    const now = Math.floor(Date.now()/1000);
    const reserved = await c.env.db.prepare(`UPDATE card_protection SET
      attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,
      window_start=CASE WHEN window_start<=? THEN ? ELSE window_start END
      WHERE id=1 AND version=? AND (window_start<=? OR attempts<5) RETURNING id`)
      .bind(now-900,now-900,now,version,now-900).first();
    if (!reserved) throw new BizError('尝试过于频繁或设置已变更，请稍后刷新重试 / Too many attempts or settings changed; retry later',429);
  },
  async authorize(c,{version,currentPassword}) {
    const row = await this.read(c);
    if (!row.enabled || row.version !== version) throw new BizError('保护设置已变更，请刷新 / Protection settings changed; refresh',409);
    if (!validPassword(currentPassword)) throw new BizError('请输入原保护密码 / Enter current protection password',400);
    await this.reserveAttempt(c,version);
    await checkPassword(row,currentPassword);
    const verified = await c.env.db.prepare('UPDATE card_protection SET attempts=0,window_start=0 WHERE id=1 AND enabled=1 AND version=? RETURNING version')
      .bind(version).first();
    if (!verified) throw new BizError('保护设置已变更，请刷新 / Protection settings changed; refresh',409);
    return row;
  },
  async update(c, params) {
    const { action, version, currentPassword, newPassword, confirmPassword } = params;
    if (!['enable', 'change', 'disable'].includes(action) || !Number.isSafeInteger(version)) {
      throw new BizError('无效操作 / Invalid operation', 400);
    }
    const row = await this.read(c);
    if (row.version !== version) throw new BizError('设置已变更，请刷新 / Settings changed; refresh first', 409);
    if ((action === 'enable' && row.enabled) || (action !== 'enable' && !row.enabled)) {
      throw new BizError('设置状态已变更，请刷新 / Settings state changed', 409);
    }
    const verifyCurrent = action !== 'enable';
    if (verifyCurrent && !row.verifier) throw unavailable();
    if (verifyCurrent && !validPassword(currentPassword)) throw new BizError('请输入原保护密码 / Enter current protection password', 400);
    if (action !== 'disable' && (!validPassword(newPassword) || newPassword !== confirmPassword)) {
      throw new BizError('新密码不能为空、不能换行、最多 1024 个 UTF-8 字节且两次输入一致 / New passwords must match, be nonempty single-line text, and fit in 1024 UTF-8 bytes', 400);
    }
    await this.reserveAttempt(c,version);
    let material;
    try {
      if (verifyCurrent) {
        await checkPassword(row,currentPassword);
      }
      let sealed = row.sealed_key, salt = row.verifier_salt, verifier = row.verifier;
      const nextVersion = version + 1;
      if (action !== 'disable') {
        material = await deriveMaterial(newPassword);
        sealed = await seal(c, material, nextVersion);
        salt = toBase64(crypto.getRandomValues(new Uint8Array(32)));
        verifier = toBase64(await sign(material, `cloudmail/verify/${salt}`));
      } else {
        // No runtime key is needed while disabled. The retained verifier is
        // replaced on the next enable without checking the previous password.
        sealed = null;
      }
      const updated = await c.env.db.prepare(`UPDATE card_protection SET enabled=?,version=?,sealed_key=?,
        verifier_salt=?,verifier=?,attempts=0,window_start=0,updated_at=datetime('now')
        WHERE id=1 AND version=? RETURNING version`)
        .bind(action === 'disable' ? 0 : 1, nextVersion, sealed, salt, verifier, version).first();
      if (!updated) throw new BizError('设置已变更，请刷新 / Settings changed; refresh first', 409);
      contexts.clear();
      c.set?.('cardPolicy', null);
      return this.status(c);
    } finally { material?.fill(0); }
  }
};
export default service;
