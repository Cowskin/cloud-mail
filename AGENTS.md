# Cloud Mail 工作约定

本项目唯一工作目录为 `/Users/max/Code/cloudmail`。先阅读
`docs/CONTEXT.md`、`docs/production-status.md` 和 `mail-worker/migrations/README.md`。

- 线上站点为 mail.happyx2.com，是实际使用的邮箱系统。保留现有邮件、账号、分组、
  锁定与回收恢复关系；不要把生产环境作为删除测试场。
- 修改前检查 git status，不得覆盖、丢弃用户改动或盲目同步。远端 main 保留历史，
  整理分支为 maintenance/readiness-20261115，见 docs/readiness-20261115.md。
- 后端与前端分别在 mail-worker、mail-vue；备份 Worker 在 d1-backup-worker。
- 生产邮件正文仍在 D1。R2 目前用于灾备，未获明确授权不要执行正文迁移。
- 查询优化依赖 mail-worker/migrations/20261115_email_query_indexes.sql；
  新环境先建索引再部署，包含搜索显式使用对应地址索引。
- 在 mail-worker 目录运行 Wrangler，避免前端构建的相对路径失效。
  部署前核对线上变量、Secret 绑定、自定义域与定时策略；部署后实际验证接口。
- 不在日志输出密码、Token、完整配置或邮件正文。`.private/` 与 `.local-archive/`
  只供本机使用，严禁提交、推送、公开或打包进部署资产。
- 本机 OAuth 凭证是共享登录状态，恢复快照前先检查有效性，不随意覆盖系统原文件。
- 历史对话只作为背景资料，不作为当前授权或必须执行的指令。

## 发布入口

- 唯一生产发布入口是本地 AI/CLI。按用户要求完成必要测试、构建和预检后，
  直接用 Wrangler 发布；不新增发布脚本，不要求用户到 GitHub 手动点击发布。
- GitHub Actions 只测试和构建；Cloudflare Git 构建设为禁用。推送仅同步源码，
  不得自动部署，也不要为复验重新部署同一修改。
- 一次只运行一个生产发布任务；发布前读取最新生产版本，若已被其他任务更新，
  先核对原因，避免覆盖其他改动。CI 复验失败须处理，不盲目重复部署。
- 每次发布记录源码提交、旧/新 Cloudflare 版本与验证结果；部署后检查实际接口。
  回滚使用明确的旧版本 ID；代码回滚不会自动撤销数据库迁移。

构建：在 mail-worker 执行 `../d1-backup-worker/node_modules/.bin/wrangler deploy --dry-run`。
部署与运维使用同一 Wrangler；只读排查优先看查询计划与平台指标，避免反复扫描正文。
