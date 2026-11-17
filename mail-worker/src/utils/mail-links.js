import { parseHTML } from 'linkedom';

const card = /(?<![A-Z0-9_])X(?:[\s\-\u200B-\u200D\uFEFF]*[A-Z0-9]){15}(?![A-Z0-9])/i;
const gift = /gift[\s-]*(?:card|code)|礼品卡|ギフトカード|JG_X[A-Z0-9]{3}_/i;
const redemption = /redeem|redemption|gift[\s_/-]*(?:card|code)|兑换|兌換/i;
const staticApplePaths = new Set(['/', '/shop/help', '/shop/gift-cards', '/legal', '/privacy']);
export const protectedLinkText = '[受保护链接 / Protected link]';
const urlPattern = /https?:\/\/[^\s<>"']+/gi;
export const textLinks = text => [...text.matchAll(urlPattern)];

export function mailDocument(html) {
  if (typeof html !== 'string' || html.length > 2 * 1024 * 1024) throw Error('Mail protection limit exceeded');
  return parseHTML(/<html(?:\s|>)/i.test(html) ? html : `<html><body>${html}</body></html>`).document;
}

export function isGiftMail(mail, visibleText = '') {
  const text = [mail.subject,mail.text,visibleText].filter(v=>typeof v==='string').join('\n');
  return gift.test(mail.subject || '') || card.test(text) ||
    /gift card\s+(?:pin|value)|sent you an apple gift card|check your email for an apple gift card|APPLE GIFT CODE CREDIT/i.test(text);
}

// Ordinary messages keep verification/order links. Inside gift messages only
// reviewed public Apple pages bypass authorization; opaque URLs stay protected.
// A redirect wrapper is checked after percent decoding as well as on the wire.
export function mailLink(href, giftMail = false, label = '') {
  try {
    if (typeof href !== 'string' || href.length > 8192 || /[\u0000-\u001f\u007f]/.test(href)) return {kind:'blocked'};
    const url = new URL(href.trim());
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return {kind:'blocked'};
    let decoded = url.href;
    for (let i=0;i<3;i++) {
      let next;
      try { next = decodeURIComponent(decoded); } catch { break; }
      if (next === decoded) break;
      decoded = next;
    }
    const sensitive = card.test(decoded) || card.test(label) || redemption.test(decoded) || redemption.test(label) || /%[0-9a-f]{2}/i.test(decoded);
    const publicApple = !url.search && !url.hash && !url.port && url.protocol==='https:' &&
      ((['apple.com','www.apple.com'].includes(url.hostname) && staticApplePaths.has(url.pathname.replace(/\/$/,'')||'/')) ||
        (url.hostname==='support.apple.com' && /^\/(?:[a-z]{2}-[a-z]{2}\/)?\d{6}\/?$/i.test(url.pathname)));
    if (publicApple) return {kind:'safe',url:url.href};
    const authorize = sensitive || giftMail;
    if (authorize && url.protocol !== 'https:') return {kind:'blocked'};
    return {kind:authorize?'protected':'safe',url:url.href};
  } catch { return {kind:'blocked'}; }
}

export function hideProtectedUrls(text, giftMail) {
  return text.replace(urlPattern, url => mailLink(url,giftMail).kind === 'safe' ? url : protectedLinkText);
}

// The client sends only a position, never a destination. Both rendering and
// authorization enumerate original anchors in the same order.
export function protectedMailLink(mail, index) {
  if (!mail.content && !mail.html) {
    const link = textLinks(mail.text || '')[index];
    const result = mailLink(link?.[0],isGiftMail(mail));
    return result.kind === 'protected' ? result.url : null;
  }
  const document = mailDocument(mail.content || mail.html || '');
  const link = [...document.querySelectorAll('a[href]')][index];
  if (!link) return null;
  const result = mailLink(link.getAttribute('href'),isGiftMail(mail,document.body.textContent),link.textContent);
  return result.kind === 'protected' ? result.url : null;
}
