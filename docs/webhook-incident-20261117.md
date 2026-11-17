# 礼品卡通知发送故障与恢复

时间：2026-11-17，Asia/Shanghai。

## 原因

用户反馈新卡未收到企业微信通知。生产只读核验确认，当前微信配置 version=3 的
3 张卡均已通过收信引用、解析、唯一订单关联，任务处于 pending，错误为 `webhook_delivery_failed`。
这不是域名过滤、未读取邮件或未创建任务；两个域名走同一流程。

发送器使用 `fetch(...,{redirect:'error'})`。Cloudflare Workers 只支持 `follow` 和 `manual`，
该参数在请求构造时抛出 `TypeError: Invalid redirect value`，因此实际请求没有发往机器人。
此前本机 Node 请求成功，但 workerd 测试注入了发送 mock，没有覆盖平台实际 fetch。
此前关于通知可用性的结论不够充分；本机模拟成功不能替代真实云端发送验证。

## 修复与验证

- [x] 改用 `redirect:'manual'`，并拒绝非 2xx 响应，仍不跟随重定向或放宽地址校验。
- [x] 保存安全的失败分类（网络、超时、HTTP 状态、平台数字错误码），不记录完整 URL、响应文本或原始卡号。
- [x] 补真实 workerd fetch 回归：微信、飞书、重定向拒绝，以及默认发送器完整处理待发邮件。
- [x] 121 项测试、前端/Worker dry-run、16 索引与元数据完整性预检通过。
- [x] 本地 CLI 发布源码 `db017f9`；旧版本 `0b7fdb4d-a5d6-4324-8a60-7db52023f5d7`，
  新版本 `6ab8cf38-a49d-4628-bb2e-8f701a407ca1`，17:51 发布。
- [x] 仅将当前配置下 3 条既有 pending 任务提前到期，保留尝试次数和去重记录。
- [x] 17:55 现有云端定时任务成功补发全部 3 条：D1 的 sent_at 分别为 09:55:26、09:55:30、09:55:33（UTC），
  对应北京时间 17:55:26、17:55:30、17:55:33；state=sent、last_error=NULL，均保持 matched 关联。

该结果来自生产 Worker 的正常定时入口、实际发送器及微信 `errcode=0` 响应，
本机没有代发这 3 条通知，也没有手工把任务标成 sent。恢复读取的邮件主键为
99614、99615、99618，关联确认邮件主键为 99612、99611、99613；卡号仅在发送时加密，未输出原卡号。
这验证了真实已收邮件至企业微信接口的链路；群内人工阅读不属于机器可验证证据。

不扫描、修改或重插生产正文，不补录历史邮件，不重放更换 Webhook 前已取消/终止的任务，
不更换密码、地址、Secret、域名或 Cron。当前 3 条任务都仍属于当前微信配置，
故恢复它们的正常发送不涉及将旧群任务转发到新群。

截图中的 `Your gift card has been sent.` 是另一个不含 PIN 的 Apple 状态模板，
不作为卡号通知触发来源；对应的 `… sent you an Apple Gift Card.` 卡邮件和
`Your Gift Card Order Confirmation: W…` 确认邮件已被正确识别，无需扩大正文扫描范围。

私有证据：`.private/webhook-incident-before.json`、`webhook-incident-release-before.json`、
`webhook-incident-release-after.json`、`webhook-incident-requeued.json`、`webhook-incident-recovery.json`。
回滚到旧版本会恢复该发送故障，不应作为通知链路的正常回滚目标。
