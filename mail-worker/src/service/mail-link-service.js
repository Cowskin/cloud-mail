import BizError from '../error/biz-error';
import protection from './card-protection-service';
import permService from './perm-service';
import userContext from '../security/user-context';
import { protectedMailLink } from '../utils/mail-links';

export async function authorizeMailLink(c,{emailId,linkIndex,version,currentPassword}) {
  if (!Number.isSafeInteger(emailId) || emailId<1 || !Number.isSafeInteger(linkIndex) || linkIndex<0 ||
      !Number.isSafeInteger(version)) throw new BizError('无效链接 / Invalid link',400);
  const user = userContext.getUser(c);
  // Check read access before password verification or retrieving source URLs.
  const row = await c.env.db.prepare(`SELECT e.user_id,e.account_id,e.is_del,a.is_del AS account_deleted FROM email e
    LEFT JOIN account a ON a.account_id=e.account_id WHERE e.email_id=?`).bind(emailId).first();
  if (!row || row.is_del) throw new BizError('邮件不可用 / Email unavailable',404);
  let allowed = row.user_id===user.userId && row.account_deleted===0;
  if (!allowed) {
    const keys = user.email===c.env.admin ? ['*'] : await permService.userPermKeys(c,user.userId);
    allowed = keys.includes('*') || keys.includes('all-email:query');
  }
  if (!allowed) throw new BizError('无权查看此邮件 / Email access denied',403);
  const policy = await protection.authorize(c,{version,currentPassword});
  const mail = await c.env.db.prepare(`SELECT e.subject,e.text,e.content,e.is_del,e.user_id,e.account_id,a.is_del AS account_deleted
    FROM email e LEFT JOIN account a ON a.account_id=e.account_id WHERE e.email_id=?`).bind(emailId).first();
  if (!mail || mail.is_del || mail.user_id!==row.user_id || mail.account_id!==row.account_id || mail.account_deleted!==row.account_deleted) {
    throw new BizError('邮件已变更，请刷新 / Email changed; refresh',409);
  }
  const url = protectedMailLink(mail,linkIndex);
  if (!url) throw new BizError('该链接不可授权，请刷新邮件 / Link cannot be authorized; refresh the email',400);
  const latest = await protection.read(c);
  if (!latest.enabled || latest.version!==policy.version) throw new BizError('保护设置已变更，请刷新 / Protection settings changed; refresh',409);
  return {url};
}
