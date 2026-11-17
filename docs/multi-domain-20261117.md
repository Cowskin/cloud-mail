# 多域名与子域邮箱接入

更新时间：2026-11-17，Asia/Shanghai。

## 当前状态

- [x] 系统邮箱后缀为 `@happyx2.com`、`@mail.c2cool.com`，新地址示例 `myname@mail.c2cool.com`。
- [x] `mail.c2cool.com` 已在 Cloudflare Email Routing 设置中添加并显示“已启用”。
- [x] 区域全收规则启用，目标为现有 `cloud-mail` Worker，覆盖该区域其他收件地址。
- [x] 权威 DNS 和 1.1.1.1 均确认子域 MX；子域 SPF TXT 可查。
- [x] 配置发布、生产预检、公开接口和登录页域名列表验证通过。
- [ ] 真实外部 SMTP 到新邮箱的端到端到信验证。
- [ ] 新域名的外部发送服务验证；本次仅接入收信。

网站入口仍为 `https://mail.happyx2.com`，邮箱后缀与网站域名是独立配置。
系统原生支持多个完整后缀，无需改邮件表或增加数据库迁移；创建账号、邮箱及批量界面
读取后端域名列表。现有普通角色的 `avail_domain` 为空，允许使用全部已配置后缀。
没有创建、复制或改名任何现有账号；移除根域后缀前只读确认 `@c2cool.com` 账号数为 0。

## DNS 与以后增加子域

邮箱收信使用 MX，不是 A 记录。当前 `mail.c2cool.com` 的记录为：

| 类型 | 名称 | 值 | 优先级 |
| --- | --- | --- | --- |
| MX | mail.c2cool.com | route1.mx.cloudflare.net | 27 |
| MX | mail.c2cool.com | route3.mx.cloudflare.net | 52 |
| MX | mail.c2cool.com | route2.mx.cloudflare.net | 77 |
| TXT | mail.c2cool.com | v=spf1 include:_spf.mx.cloudflare.net ~all | — |

以后增加例如 `post.c2cool.com`：

1. 在 c2cool.com 的 Email Routing → 设置 → 子域名添加 `post`，等待启用并确认 MX。
2. 确认区域全收规则仍启用且发送到 `cloud-mail`。
3. 在 `mail-worker/wrangler.toml` 的 `vars.domain` 加入完整字符串 `post.c2cool.com`。
   按正常发布流程预检、构建、发布，并验证公开接口和页面域名列表。
4. 在系统中创建需要的新后缀邮箱，使用真实外部邮件验证收信。

优先新增后缀并保留旧后缀及旧路由，待旧地址不再使用后再单独退役。
`myname@mail.c2cool.com` 与 `myname@post.c2cool.com` 是不同邮箱，不会自动互为别名，
也没有自动故障切换。更换后缀不能恢复旧地址的收信，旧地址仍依赖其原 MX/邮件路由。
Cloudflare 子域依赖所属区域的邮件服务；不要禁用 c2cool.com 的父级 Email Routing，
该操作会停止子域服务。根域 `@c2cool.com` 不在当前应用允许创建的后缀列表中。

## 发布记录

| 时间 | 源码 | 旧生产版本 | 新生产版本 | 内容 |
| --- | --- | --- | --- | --- |
| 2026-11-17 00:25 | 1bf7503 | e6aedae6-b4d8-49d6-856f-668516c67168 | 748a7aa5-cc0c-40de-9cfc-57291c0b309b | 首次增加根域 c2cool.com |
| 2026-11-17 00:37 | b6e5257 | 748a7aa5-cc0c-40de-9cfc-57291c0b309b | e7dc8208-b137-4dd4-b4ee-5826f92cdaac | 按需求改为 mail.c2cool.com |

第二次发布从已提交源码的私有隔离快照构建，避免共享目录中其他任务的在途修改被打包。
功能源码延续 `194ae19`；配置修改不改变运行代码，沿用前次通过的 74 项 workerd 回归，
本次重新完成前端/Worker dry-run 和生产预检：14 个必需索引存在、3 个同步触发器存在、
缺失元数据为 0。发布前再次确认旧版本没有被其他发布替换。

发布后公开配置返回 `code=200`、`domainList=["@happyx2.com","@mail.c2cool.com"]`，
真实登录页面选项一致，首页 HTTP 200；生产版本为新版本且流量 100%。
其他平台绑定、Secret 名称、Cron（`*/5 * * * *`、`0 16 * * *`）、
站点自定义域及卡号保护/飞书配置前后一致，未更换密码或 Secret，未操作生产邮件。
未声称真实外部 SMTP 到信或新域发送已验证。

私有证据为 `.private/multidomain-before.json`、`multidomain-after.json`（根域阶段），
以及 `.private/subdomain-before.json`、`subdomain-after.json`（子域阶段）；不提交完整平台配置。
截图位于 `.private/multidomain-qa/`。回滚至 `748a7aa5-cc0c-40de-9cfc-57291c0b309b`
会恢复根域后缀列表，但不会自动撤销子域 DNS/路由；已有新后缀账号使用后应先评估影响。
