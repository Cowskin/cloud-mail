import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GiftOrderEngine } from './engine.mjs';
import { extractGiftEvent } from './extract.mjs';
import { localReceiver,localTransport } from './local-webhook.mjs';
import { BASE,CARD,OTHER_CARD,FINGERPRINT_SECRET,confirmation,cardMail,simulationProtection } from './fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const output = resolve(root,'.private/gift-order-simulation');
mkdirSync(output,{recursive:true,mode:0o700});
const protection = await simulationProtection();
const scenarios = [
  {name:'正常：邮箱大小写不同，间隔 13 分钟',mails:[confirmation(),cardMail()],minute:15},
  {name:'乱序：卡先到，10 分钟后确认邮件补齐',mails:[cardMail({minutes:0}),confirmation({minutes:10})],minute:12},
  {name:'缺失：等待 30 分钟仍未找到订单',mails:[cardMail()],minute:44},
  {name:'歧义：两个同邮箱、同名、同金额订单',mails:[confirmation(),confirmation({emailId:3,orderId:'W1000000002',minutes:1}),cardMail()],minute:15},
  {name:'冲突：一个单卡订单收到两张不同卡',mails:[confirmation(),cardMail(),cardMail({emailId:3,card:OTHER_CARD,minutes:14})],minute:16},
  {name:'重复：同卡换 Message-ID 重发',mails:[confirmation(),cardMail(),cardMail({emailId:4,minutes:14})],minute:16},
  {name:'关闭加密：不发任何通知',mails:[confirmation(),cardMail()],minute:15,off:true},
  {name:'金额不一致：转人工',mails:[confirmation({face:'100.00'}),cardMail()],minute:44},
  {name:'Webhook 成功响应丢失：重试可能重复',mails:[confirmation(),cardMail()],minute:15,dropResponse:true},
  {name:'排队后修改密码：使用发送时的新密文',mails:[confirmation(),cardMail()],minute:15,rotate:true},
  {name:'排队后新订单到达：发送前转人工',mails:[confirmation(),cardMail()],minute:15,
    afterQueue:[confirmation({emailId:3,orderId:'W1000000002',minutes:14})]}
];
const reports=[];
for(const scenario of scenarios){
  const engine=new GiftOrderEngine({fingerprintSecret:FINGERPRINT_SECRET,clock:()=>BASE+scenario.minute*60_000});
  const receiver=await localReceiver({dropFirstResponse:scenario.dropResponse});
  try {
    const ingestion=[];for(const mail of scenario.mails)ingestion.push(await engine.ingest(mail));
    const relations=engine.reconcile(BASE+scenario.minute*60_000);
    for(const mail of scenario.afterQueue || [])ingestion.push(await engine.ingest(mail));
    protection.setEnabled(!scenario.off);
    if(scenario.rotate)await protection.rotate('New local simulation password');
    const transport=localTransport(receiver.url);
    const delivery=await engine.flush({protection,transport});
    const retry=scenario.dropResponse?await engine.flush({protection,transport}):[];
    const report={scenario:scenario.name,ingestion,relations,delivery,retry,
      httpRequests:receiver.frameCount(),notifications:receiver.messages(),jobs:engine.jobs(),
      metadataContainsPlainCard:JSON.stringify(engine.metadata()).includes(CARD),
      queryPlan:scenario.mails.some(m=>m.emailId===2)?engine.queryPlan(2):[]};
    if(report.metadataContainsPlainCard)throw Error('Prototype index contains a raw card');
    reports.push(report);
  } finally {await receiver.close();engine.close();}
}

const samples=resolve(output,'source-samples.json');
let sourceCheck=null;
if(existsSync(samples)){
  // Private, read-only reference check. No real card, name, mailbox or order is
  // written to the public report or sent to the local webhook receiver.
  const extracted=JSON.parse(readFileSync(samples,'utf8')).map(extractGiftEvent);
  const order=extracted.find(e=>e?.kind==='confirmation'), card=extracted.find(e=>e?.kind==='card');
  sourceCheck={samples:extracted.length,orderParsed:!!order?.orderId,cardParsed:!!card?.rawCard,
    sameMailbox:order?.recipientKey===card?.recipientKey,samePerson:order?.personKey===card?.personKey,
    sameAmount:order?.amountMinor===card?.amountMinor&&order?.currency===card?.currency,
    gapMinutes:order&&card?(card.receivedAt-order.receivedAt)/60_000:null,
    providerAuthenticationAvailable:false,productionWrites:false};
  writeFileSync(resolve(output,'source-shape-check.json'),JSON.stringify(sourceCheck,null,2)+'\n',{mode:0o600});
}
const json={createdAt:new Date().toISOString(),localOnly:true,sourceCheck,scenarios:reports};
writeFileSync(resolve(output,'results.json'),JSON.stringify(json,null,2)+'\n',{mode:0o600});
const table=reports.map(r=>`| ${r.scenario} | ${r.notifications.length} | ${r.jobs.map(j=>j.relation==='matched'?'已关联':'需人工确认').join('、')||'无'} | ${r.jobs.every(j=>j.state==='sent')?'sent':r.delivery.map(d=>d.state).join('、')} |`).join('\n');
const example=reports[0].notifications[0].body.text.content;
const markdown = ['# 邮箱卡关联与通知本地模拟','',
  '全部账号、订单、卡号均为虚构；HTTP POST 仅连接本机，消息体及成功响应兼容企业微信群机器人。没有向企业微信发送真实消息。','',
  '成功响应丢失时，机器人不支持幂等去重，重试可能展示两条通知。','',
  '| 场景 | 实际通知数 | 关联 | 投递结果 |','| --- | --- | --- | --- |',table,'',
  '## 正常通知','','```text',example,'```','',
  '## 无匹配通知','','```text',reports[2].notifications[0].body.text.content,'```',''].join('\n');
writeFileSync(resolve(output,'results.md'),markdown,{mode:0o600});
console.log(JSON.stringify({scenarios:reports.length,notifications:reports.reduce((n,r)=>n+r.notifications.length,0),
  allIndexesWithoutRawCards:reports.every(r=>!r.metadataContainsPlainCard),sourceCheck,
  report:resolve(output,'results.md')},null,2));
