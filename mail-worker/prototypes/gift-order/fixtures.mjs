// All identities, orders and cards in this module are fictional test data.
export const BASE = Date.parse('2026-11-16T10:27:00Z');
export const CARD = 'XDEM12345678ABCD';
export const OTHER_CARD = 'XDEMO7K2P9Q4ABCD';
export const SIMULATION_PASSWORD = 'Local simulation only';
export const FINGERPRINT_SECRET = 'LOCAL-SIMULATION-ONLY-INDEPENDENT-HMAC-KEY';
const when = minutes => new Date(BASE + minutes*60_000).toISOString();
const base = {userId:1,accountId:5,toEmail:'demo005@example.test',trustedSender:true};

export function confirmation(overrides = {}) {
  const {emailId=1,minutes=0,orderId='W1000000001',person='Demo Recipient',address=base.toEmail,face='149.95',quantity=1,...rest} = overrides;
  return { ...base,emailId,receivedAt:when(minutes),sendEmail:'order_acknowledgment@orders.apple.com',name:'Apple Store',
    subject:`Your Gift Card Order Confirmation: ${orderId}`,messageId:`<confirmation-${emailId}@example.test>`,
    content:`<html><body><h1>Check your email for an Apple Gift Card.</h1><table><tr><td><b>Order Number:</b> ${orderId}</td></tr></table>
      <h2>Items to Be Emailed</h2><p><b>Send to: </b>${person} (${address})</p>
      <table><tr><td>APPLE GIFT CODE CREDIT-USA</td><td>Your gift card details: <b>To: </b>${person} (${address})</td></tr>
      <tr><td>$${face}</td><td>Qty ${quantity}</td><td><b>$${face}</b></td></tr></table></body></html>`,...rest };
}
export function cardMail(overrides = {}) {
  const {emailId=2,minutes=13,person='Demo Recipient',card=CARD,face='149.95',...rest} = overrides;
  return { ...base,toEmail:'DEMO005@EXAMPLE.TEST',emailId,receivedAt:when(minutes),sendEmail:'just_for_you@giftcards.apple.com',
    name:`${person} via Apple`,subject:`${person.split(' ')[0]} sent you an Apple Gift Card.`,messageId:`<gift-${emailId}@example.test>`,
    content:`<html><body><h1>${person.split(' ')[0]} sent you an Apple Gift Card.</h1>
      <img src="https://email.images.apple.com/rover/aos/egc/gc_def_hero_lg.jpg" alt="APPLE GIFT CODE CREDIT-USA">
      <p>Gift Card Value: $${face}</p><p>Redeem to your Apple Account.</p><p>Your Gift Card PIN</p><div>${card}</div>
      <a href="https://example.test/redeem?code=${card}">Redeem Now</a></body></html>`,...rest };
}

export async function simulationProtection(password = SIMULATION_PASSWORD) {
  const {deriveMaterial,createCipher} = await import('../../src/utils/card-cipher.js');
  let enabled = true, version = 1, cipher;
  const rotate = async next => {
    const material = await deriveMaterial(next);
    try { cipher = await createCipher(material); version++; } finally { material.fill(0); }
  };
  await rotate(password);
  return { read:async () => ({enabled,version}), setEnabled:value => {enabled=value;version++;}, rotate,
    encrypt:async (raw,policy) => {if(!enabled || policy.version!==version)throw Error('Simulation policy changed');return cipher(raw);} };
}
