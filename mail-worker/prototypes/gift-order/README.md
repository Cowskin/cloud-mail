# 礼品卡订单关联本地模拟

使用 Node.js 24，在 `mail-worker` 执行：

```sh
pnpm run gift-order:test
pnpm run gift-order:simulate
pnpm test
```

默认模拟器自动开关随机端口的本机 HTTP Webhook 接收器，使用企业微信群机器人的
文本消息体及 `errcode:0` 成功响应，绝不连接真实企业微信。账号、订单、卡号均为虚构。
结果保存在 `.private/gift-order-simulation/results.md` 和 `results.json`。

- `extract.mjs`：转出与后端共用的解析器 `src/utils/gift-order.js`。
- `engine.mjs`、`schema.sql`：本机 SQLite 演示，源邮件表只是已有 D1 邮件表的替身。
- `fixtures.mjs`：虚构邮件及 CardCipher 加密样本，仅样本标记已认证发送者。
- `local-webhook.mjs`：仅允许本机接收，复用实际 HTTP 响应适配器；响应丢失时可重复通知。
- `local-ws.mjs`：保留早期网关协议测试，不是实际企业微信接口。
- `gift-order.test.mjs`：23 项原型测试；`test/gift-webhook.spec.js` 另测实际 D1 和 HTTP 路径。

生产运行代码和待执行迁移位于 `src/service/gift-notification-service.js`、
`src/service/gift-webhook-config.js`、`migrations/20261116_gift_webhook.sql`。
运行代码已部署并完成临时飞书连通性测试，详见方案发布记录。该模拟器仍只访问本机，
不向真实企业微信或飞书群发消息。
规则及认证缺口见 [关联通知方案](../../../docs/gift-order-notification-plan.md)。
