import { parseHTML } from 'linkedom';
import cardProtection from '../service/card-protection-service';
import { presentationCss, safeArtwork } from './mail-presentation';

// Recognize the fixed 16-character Apple format, including common printed
// grouping and zero-width separators. Existing JG_ ciphertext is left alone.
const candidate = /(?<![A-Z0-9_])X(?:[\s\-\u200B-\u200D\uFEFF]*[A-Z0-9]){15}(?![A-Z0-9])/gi;
const normalize = value => value.replace(/[\s\-\u200B-\u200D\uFEFF]/g, '').toUpperCase();
const allowed = new Set('html body div p span a b strong i em u s br hr table caption colgroup col thead tbody tfoot tr td th h1 h2 h3 h4 h5 h6 ul ol li pre code blockquote center font small sub sup nobr wbr img style'.split(' '));
const discarded = new Set('script title meta link base iframe frame object embed svg math canvas template noscript textarea input button select option form video audio source picture'.split(' '));
const containsCard = value => [...value.matchAll(candidate)].length > 0;

export async function mailProtector(c, policy = null) {
  const row = policy || await cardProtection.policy(c);
  if (!row.enabled) return { policy: row, protect: async value => structuredClone(value) };
  const encrypt = await cardProtection.cipher(c, row);
  const replacements = new Map();
  const encryptOnce = async plain => {
    if (!replacements.has(plain)) {
      if (replacements.size >= 1000) throw new Error('Mail protection limit exceeded');
      replacements.set(plain, encrypt(plain));
    }
    return replacements.get(plain);
  };
  async function replaceText(value) {
    if (value.length > 2 * 1024 * 1024) throw new Error('Mail protection limit exceeded');
    const matches = [...value.matchAll(candidate)];
    if (!matches.length) return value;
    const output = []; let position = 0;
    for (const match of matches) {
      output.push(value.slice(position, match.index), await encryptOnce(normalize(match[0])));
      position = match.index + match[0].length;
    }
    return output.join('') + value.slice(position);
  }
  async function replaceHtml(value) {
    if (!value) return value;
    if (value.length > 2 * 1024 * 1024) throw new Error('Mail protection limit exceeded');
    const { document } = parseHTML(/<html(?:\s|>)/i.test(value) ? value : `<html><body>${value}</body></html>`);
    // Keep presentation attributes and parsed layout CSS. URLs remain disabled,
    // except for reviewed generic artwork that cannot carry a redemption code.
    const attributes = async element => {
      const image = element.localName === 'img' ? safeArtwork(element.getAttribute('src')) : null;
      for (const attr of [...element.attributes]) {
        const name = attr.name.toLowerCase(), value = attr.value;
        element.removeAttribute(attr.name);
        if (name === 'style') {
          const css = presentationCss(value, true, containsCard);
          if (css) element.setAttribute('style', css);
        } else if (['alt', 'title', 'aria-label'].includes(name)) {
          element.setAttribute(name, await replaceText(value));
        } else if (!containsCard(value) && (
          (['class', 'id'].includes(name) && /^[\w\s:-]{1,512}$/.test(value)) ||
          (['width', 'height'].includes(name) && /^(?:\d{1,5}(?:\.\d+)?(?:px|%)?|auto)$/i.test(value)) ||
          (['border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'size'].includes(name) && /^\d{1,4}$/.test(value)) ||
          (name === 'align' && /^(left|center|right|justify)$/i.test(value)) ||
          (name === 'valign' && /^(top|middle|bottom|baseline)$/i.test(value)) ||
          (['color', 'bgcolor'].includes(name) && /^(#[\da-f]{3,8}|[a-z]{1,20})$/i.test(value)) ||
          (name === 'face' && /^[\w ,'-]{1,200}$/.test(value)) ||
          (name === 'role' && /^(presentation|none|img|table|row|cell)$/i.test(value)) ||
          (name === 'dir' && /^(ltr|rtl|auto)$/i.test(value)) ||
          (name === 'lang' && /^[a-z-]{1,30}$/i.test(value)))) element.setAttribute(name, value);
      }
      if (image) {
        element.setAttribute('src', image);
        element.setAttribute('referrerpolicy', 'no-referrer');
      }
      if (element.localName === 'a') element.setAttribute('aria-disabled', 'true');
    };
    const clean = async node => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 8) { child.remove(); continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.localName.toLowerCase();
        if (discarded.has(tag) || (tag === 'img' && !safeArtwork(child.getAttribute('src')))) { child.remove(); continue; }
        if (tag === 'style') {
          const css = presentationCss(child.textContent, false, containsCard);
          if (css) { child.textContent = css; for (const attr of [...child.attributes]) child.removeAttribute(attr.name); }
          else child.remove();
          continue;
        }
        await clean(child);
        await attributes(child);
        if (!allowed.has(tag)) child.replaceWith(...child.childNodes);
      }
    };
    // Head styles participate in email layout; metadata and executable content
    // do not. Use real wrappers so body/html selectors keep working in Shadow DOM.
    const headStyles = [...document.querySelectorAll('head style')].map(node => node.cloneNode(true));
    for (const head of [...document.querySelectorAll('head')]) head.remove();
    for (const style of headStyles.reverse()) document.body.prepend(style);
    await clean(document);
    const blocks = new Set('body div p a br hr table thead tbody tfoot tr td th h1 h2 h3 h4 h5 h6 ul ol li pre blockquote'.split(' '));
    let text = ''; const positions = [];
    const collect = node => {
      if (node.localName === 'style') return;
      if (node.nodeType === 3) {
        positions.push({node,start:text.length,end:text.length + node.data.length});
        text += node.data;
      } else {
        const boundary = blocks.has(node.localName);
        if (boundary) text += '\n';
        for (const child of node.childNodes) collect(child);
        if (boundary) text += '\n';
      }
    };
    collect(document.body);
    // Join text nodes so cards split by <span>, <wbr>, entities, etc. are treated
    // as one card. Apply edits backwards without flattening the surrounding mail.
    for (const match of [...text.matchAll(candidate)].reverse()) {
      const start = match.index, end = start + match[0].length;
      const cipher = await encryptOnce(normalize(match[0]));
      let inserted = false;
      for (const item of positions) {
        if (item.end <= start || item.start >= end) continue;
        const from = Math.max(0, start - item.start), to = Math.min(item.end - item.start, end - item.start);
        item.node.data = item.node.data.slice(0, from) + (inserted ? '' : cipher) + item.node.data.slice(to);
        inserted = true;
      }
    }
    const body = document.createElement('div'), html = document.createElement('div');
    for (const attr of document.body.attributes) body.setAttribute(attr.name, attr.value);
    for (const attr of document.documentElement.attributes) html.setAttribute(attr.name, attr.value);
    body.classList.add('cm-mail-body'); html.classList.add('cm-mail-html');
    body.append(...document.body.childNodes); html.append(body);
    return html.outerHTML;
  }
  const visit = async (value, key = '') => {
    if (typeof value === 'string') return key === 'content' || key === 'html' ? replaceHtml(value) : replaceText(value);
    if (Array.isArray(value)) return Promise.all(value.map(item => visit(item)));
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [name, item] of Object.entries(value)) {
      if (['attList', 'attachments'].includes(name)) { result[name] = []; continue; }
      result[name] = await visit(item, name);
    }
    if ('content' in value || 'text' in value) result.cardProtected = true;
    return result;
  };
  return { policy: row, protect: visit };
}

export async function protectMail(c, value) {
  return (await mailProtector(c)).protect(value);
}
