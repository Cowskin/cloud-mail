import { parseHTML } from 'linkedom';

export const cardPattern = /(?<![A-Z0-9_])X(?:[\s\-\u200B-\u200D\uFEFF]*[A-Z0-9]){15}(?![A-Z0-9])/gi;
export const normalizeAddress = value => String(value || '').normalize('NFKC').trim().toLowerCase();
export const normalizeName = value => String(value || '').normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
const normalizeCard = value => value.replace(/[\s\-\u200B-\u200D\uFEFF]/g, '').toUpperCase();

export function mailText(mail) {
  if (String(mail.content || mail.text || '').length > 2 * 1024 * 1024) throw Error('Gift mail size limit');
  if (!mail.content) return String(mail.text || '').replace(/\s+/g, ' ').trim();
  const { document } = parseHTML(/<html(?:\s|>)/i.test(mail.content) ? mail.content : `<html><body>${mail.content}</body></html>`);
  document.querySelectorAll('style,script,head,template').forEach(node => node.remove());
  const blocks = new Set('html body table tr td th div p br wbr h1 h2 h3 h4 ul ol li section'.split(' '));
  const parts = [];
  const collect = node => {
    if (node.nodeType === 3) { parts.push(node.data); return; }
    const block = blocks.has(node.localName);
    if (block) parts.push(' ');
    for (const child of node.childNodes) collect(child);
    if (block) parts.push(' ');
  };
  collect(document.body);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function amount(text, source) {
  const found = new Map();
  for (const m of text.matchAll(/(US\$|CA\$|C\$|AU\$|A\$|NZ\$|\$|€|£)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?![\d.,])/g)) {
    const currency = ({'US$':'USD','CA$':'CAD','C$':'CAD','AU$':'AUD','A$':'AUD','NZ$':'NZD','€':'EUR','£':'GBP'})[m[1]] ||
      (/CREDIT-USA|\bUSD\b/i.test(source) ? 'USD' : null);
    const minor = Number(m[2].replaceAll(',', '')) * 100 + Number(m[3] || 0);
    if (Number.isSafeInteger(minor) && minor > 0) found.set(`${currency}:${minor}`, { currency, amountMinor:minor });
  }
  return found.size === 1 ? [...found.values()][0] : { currency:null, amountMinor:null };
}

// Parse each incoming body once. Matching below uses only these small fields.
// No result returned here may be logged: rawCard is ephemeral input to encryption.
export function extractGiftEvent(mail) {
  const sender = normalizeAddress(mail.sendEmail), subject = String(mail.subject || '');
  const kind = sender === 'order_acknowledgment@orders.apple.com' && /^Your Gift Card Order Confirmation:/i.test(subject) ? 'confirmation' :
    sender === 'just_for_you@giftcards.apple.com' && /sent you an Apple Gift Card/i.test(subject) ? 'card' : null;
  if (!kind) return null;
  const text = mailText(mail), issues = [];
  const recipientKey = normalizeAddress(mail.toEmail);
  const scopeValid = Number.isSafeInteger(mail.userId) && Number.isSafeInteger(mail.accountId);
  const ownerKey = scopeValid ? `${mail.userId}/${mail.accountId}` : '';
  const receivedAt = Date.parse(mail.receivedAt || (mail.createTime ? mail.createTime.replace(' ', 'T') + 'Z' : ''));
  if (!scopeValid) issues.push('missing_owner');
  if (!/^[^\s@]+@[^\s@]+$/.test(recipientKey)) issues.push('missing_recipient');
  if (!Number.isFinite(receivedAt)) issues.push('missing_received_time');
  // Correlation identifies a pair of email records, not authenticated Apple
  // ownership. Unknown auth does not disable field matching; an explicit failed
  // attestation from a trusted adapter, if available, requires manual review.
  if (mail.trustedSender === false) issues.push('sender_not_authenticated');
  const money = amount(kind === 'card' ? text.match(/Gift Card Value:\s*([^]*?)(?:Redeem to|Your Gift Card PIN)/i)?.[1] || text : text, (mail.content || '') + text);
  if (!money.currency || money.amountMinor === null) issues.push('amount_or_currency_unclear');
  let personKey = '', orderId = null, quantity = null, rawCard = null, cardIdentity = '';
  if (kind === 'confirmation') {
    orderId = subject.match(/^Your Gift Card Order Confirmation:\s*(W\d{7,15})\s*$/i)?.[1]?.toUpperCase() || null;
    const bodyOrder = text.match(/Order Number:\s*(W\d{7,15})\b/i)?.[1]?.toUpperCase();
    if (!orderId || (bodyOrder && bodyOrder !== orderId)) issues.push('order_number_unclear');
    const people = [...text.matchAll(/(?:Send to|\bTo):\s*([^()]+?)\s*\(([^()\s]+@[^()\s]+)\)/gi)]
      .map(m => ({ name:normalizeName(m[1]), address:normalizeAddress(m[2]) }));
    const distinct = new Map(people.map(p => [`${p.name}|${p.address}`, p]));
    if (distinct.size === 1) {
      const person = [...distinct.values()][0]; personKey = person.name;
      if (person.address !== recipientKey) issues.push('body_recipient_mismatch');
    } else issues.push('recipient_name_unclear');
    const quantities = [...text.matchAll(/\bQty\s*:?\s*(\d+)/gi)].map(m => Number(m[1]));
    quantity = quantities.length === 1 ? quantities[0] : null;
    if (quantity !== 1) issues.push('multiple_or_unknown_quantity');
  } else {
    const fullName = String(mail.name || '').match(/^(.+?)\s+via\s+Apple\s*$/i)?.[1];
    personKey = normalizeName(fullName);
    const shortName = normalizeName(subject.match(/^(.+?)\s+sent you an Apple Gift Card/i)?.[1]);
    if (!personKey) issues.push('recipient_name_unclear');
    else if (shortName !== personKey && !personKey.startsWith(shortName + ' ')) issues.push('name_subject_mismatch');
    const pinText = text.split(/Your Gift Card PIN/i)[1] || '';
    const cards = [...new Set([...pinText.matchAll(cardPattern)].map(m => normalizeCard(m[0])))];
    if (cards.length !== 1) issues.push('card_count_unclear');
    else rawCard = cards[0];
    cardIdentity = cards.sort().join('|') || String(mail.messageId || mail.emailId);
  }
  return { emailId:mail.emailId, kind, ownerKey, recipientKey, personKey, receivedAt, ...money,
    senderAuthenticated:mail.trustedSender === true,
    orderId, quantity, rawCard, cardIdentity, issues };
}

export const SETTLE_MS = 2 * 60_000;
export const ORDER_WAIT_MS = 30 * 60_000;
export const LOOKBACK_MS = 24 * 60 * 60_000;
export function decideAssociation(card, orders, { claimedBy, rivalCount, now }) {
  const manual = reason => ({relation:'manual',reason,orderId:null});
  const issues = JSON.parse(card.issues);
  if (issues.length) return manual(issues.join(','));
  if (orders.length >= 21) return manual('candidate_limit');
  if (orders.length > 1) return manual('multiple_orders');
  if (orders.length) {
    const selected = orders[0];
    if (selected.issues !== '[]' || selected.quantity !== 1) return manual('order_requires_review');
    if (claimedBy && claimedBy !== card.email_id) return manual('order_already_used');
    return rivalCount === 1 ? {relation:'matched',reason:'unique_exact_match',orderId:selected.email_id} : manual('multiple_cards');
  }
  return now < card.received_at + ORDER_WAIT_MS ? {relation:null,reason:'waiting_for_order',orderId:null} : manual('order_not_found');
}

const reasons = { order_not_found:'未找到符合条件的确认邮件',multiple_orders:'存在多个同邮箱、姓名、金额的订单',
  multiple_cards:'同一个订单对应多张不同卡，无法唯一配对',order_already_used:'候选订单已关联其他卡',
  order_requires_review:'订单字段或数量需要人工核对',candidate_limit:'候选过多，需要人工核对' };
export function formatNotification({orderId,cipher,currency,amountMinor,receivedAt,reason,recipient,emailId}) {
  const money = amountMinor === null ? '待人工确认' : (currency === 'USD' ? '$' : currency ? `${currency} ` : '')+
    (amountMinor/100).toFixed(2)+(currency ? '' : '（币种待确认）');
  const time = new Date(receivedAt + 8*60*60_000).toISOString().slice(0,19).replace('T',' ');
  const safeRecipient = typeof recipient === 'string' && /^[^\s@]+@[^\s@]+$/.test(recipient) &&
    ![...recipient.matchAll(/(?<![A-Z0-9_])X[A-Z0-9]{15}(?![A-Z0-9])/gi)].length ? recipient : '请按来源邮件ID定位';
  return ['收到新的邮箱卡',`原始订单：${orderId || '未关联（需人工确认）'}`,`邮箱卡号：${cipher}`,
    `面值金额：${money}`,`收件时间：${time}（北京时间）`,
    ...(!orderId ? [`关联说明：${reasons[reason] || '邮件身份、金额、姓名或卡号格式需要人工核对'}`,
      `收件邮箱：${safeRecipient}`,`来源邮件ID：${emailId}`] : [])].join('\n');
}
