// CardCipher fixed-8/v2 compatibility. FF1 is supplied by the MIT-licensed
// @noble/ciphers package, the same implementation family as CardCipher.
import { FF1 } from '@noble/ciphers/ff1.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

const enc = new TextEncoder();
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const profile = 'CardCipher|FF1|fixed-8|v2';

export function validPassword(password) {
  return typeof password === 'string' && password.length > 0 &&
    enc.encode(password).length <= 1024 && !/[\r\n]/.test(password) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(password);
}

export async function deriveMaterial(password) {
  if (!validPassword(password)) throw new Error('Invalid protection password');
  // Cloudflare's hosted WebCrypto caps PBKDF2 iterations below this compatible
  // profile. Keep all 210,000 rounds using the portable implementation; local
  // workerd does not reproduce the hosted limit. This runs only on password changes.
  const bytes = enc.encode(password);
  try {
    return await pbkdf2Async(sha256, bytes, enc.encode(profile), { c: 210000, dkLen: 32 });
  } finally { bytes.fill(0); }
}

export async function sign(material, message) {
  const key = await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export async function createCipher(material) {
  if (!(material instanceof Uint8Array) || material.length !== 32) throw new Error('Invalid protection key');
  const ff1Key = material.slice(0, 16);
  const hmacKey = await crypto.subtle.importKey('raw', material.slice(16), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async plain => {
    if (!/^X[A-Z0-9]{15}$/.test(plain)) throw new Error('Invalid card format');
    const head = plain.slice(0, 4), tail = plain.slice(12);
    const middle = FF1(36, ff1Key, enc.encode(`CC2|${head}|${tail}|fixed`))
      .encrypt([...plain.slice(4, 12)].map(c => alphabet.indexOf(c))).map(n => alphabet[n]).join('');
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, enc.encode(`CardCipher|fixed-8|${plain}`)));
    let number = new DataView(digest.buffer).getUint32(0) % (36 ** 4), tag = '';
    for (let i = 0; i < 4; i++) { tag = alphabet[number % 36] + tag; number = Math.floor(number / 36); }
    return `JG_${head}_${middle}${tag}_${tail}`;
  };
}
