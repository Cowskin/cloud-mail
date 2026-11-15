# happyx2.com 生产运维状态

更新时间：2026-11-15（Asia/Shanghai）

2026-11-15 更新：已部署 D1 查询优化，版本
`966cbbd3-aa63-4e4d-896a-c9f1bc109159`。新增 7 个查询索引，优化完整及部分邮箱地址搜索、
最新邮件元数据查询和错误日志。迁移顺序、验证结果及回滚版本见
[查询优化记录](../mail-worker/migrations/README.md)。正文仍在 D1，未进行数据清理或迁移。

本文记录当前生产架构和已验证的恢复路径。不得在本文件或 Git 历史中写入密码、
API Token、Worker Secret、邮箱正文或用户个人信息。

## 仓库与服务

- Git 远端：`https://github.com/Cowskin/cloud-mail.git`
- 生产站点：`https://mail.happyx2.com`
- 主分支：`main`
- 邮件应用 Worker：`cloud-mail`
- 备份 Worker：`happyx2-d1-backup`
- 备份 Workflow：`happyx2-d1-backup-workflow`

## 数据资源

- D1 数据库：`cloud-mail-db`
- D1 数据库 ID：`c72f3087-b46f-429b-99f2-7c0e177c1699`
- R2 私有备份桶：`happyx2-mail-backups`
- R2 公共访问：关闭
- 邮件正文现状：仍保存在 D1，尚未迁移到 R2
- R2 当前用途：D1 灾备，不是线上正文主存储

Cloudflare Workers Paid 下，单个 D1 数据库的硬上限为 10 GB；每月前 5 GB
存储包含在套餐额度内，超过部分按量计费。分析页的 `storage_d1_limit_mb=10240`
表示 10 GB 单库硬上限，不表示 10 GB 都免费。

容量监控应区分两个阈值：

- 5 GB：包含额度用尽，继续增长会产生 D1 存储费。
- 10 GB：单数据库硬上限，必须在此前完成迁移或分库。

## 自动备份策略

- 执行时间：每周日北京时间 12:00。
- Cron：`0 4 * * SUN`（UTC）。
- 备份格式：完整 D1 SQL 导出后进行 gzip 压缩。
- R2 路径：`weekly/YYYY-MM-DD/<database-export>.sql.gz`。
- 上传方式：5 MiB 分片上传，避免将完整数据库加载进 Worker 内存。
- 保留策略：`weekly/` 对象保留 90 天。
- R2 费用保护：已配置每月 1 美元预算提醒。
- API 凭证：仅保存在 Worker Secret `D1_REST_API_TOKEN` 中。

## 最近恢复演练

2026-11-15 21:41 完成新的完整 D1 备份离线恢复验证：

- 最近五次每周任务均为 completed；本次任务执行时间为当天 12:00–12:04。
- 实例：`0 4 * * SUN-1794715200000`。
- 对象：`weekly/2026-11-08/c72f3087-b46f-429b-99f2-7c0e177c1699-00005281-00000014-00005124-5613061a928e4a7b65428611c812549d.sql.gz`。
- 路径日期来自 Workflow event.timestamp，可能是排队创建日期；不能只靠目录名判断
  备份新鲜度。恢复后最新一行邮件的 create_time 为 `2026-11-15 03:59:58`（数据库原值）。
- 压缩大小：605,476,629 字节；恢复库：4,329,033,728 字节。
- gzip 完整性通过；SQLite `PRAGMA integrity_check` 为 `ok`；必需表存在。
- 邮件 97,792 条、邮箱 708 个、用户 7 个、分组 3 个、分组成员 700 个；附件表 0 条。
- SHA-256：`40484547ed2a4e4361c6d1d1ae9ad2df73252882d9566aee6d9719db9277327d`。
- 私有报告：`.private/restore-20261115.report.json`。

普通下载在最后不足 1 MB 处中断；改用临时、密钥保护的只读 Worker 获取同一对象尾段，
拼接达到预期大小后通过全量 gzip CRC 和数据库校验。临时 Worker 已删除，并通过
Cloudflare API 确认临时自定义域绑定不存在。没有向生产导入、删除或迁移邮件。
完整可用压缩包为 `.private/restore-complete-20261115.sql.gz`；另两个下载文件不完整，
只能用于排查，不能拿来恢复。本次验证不包括外部附件对象或灾难重建整个账户。

### 早期演练

2026-08-16 完成一次生产 D1 的只读导出和离线恢复演练：

- Workflow 实例：`cf_4fe953b15b0aed28ca0e1048ba2be0cdf82d69da2fb56def67d98573740b04d5`
- 工作流结果：成功。
- 总耗时：46 秒。
- 压缩对象大小：71,405,482 字节。
- 离线恢复数据库大小：503,001,088 字节。
- gzip 完整性检查：通过。
- SQLite `PRAGMA integrity_check`：`ok`。
- 恢复出的邮件记录：10,952 条。
- 演练后生产库只读复查：10,954 条，且线上邮件列表正常读取。

演练没有向生产 D1 导入数据，也没有删除或迁移邮件。演练过程中发现的轮询间隔
和未知长度压缩流问题已经修复；失效实例均已终止。

## 安全验证流程

下载某个备份并验证压缩包时使用：

```bash
npx wrangler r2 object get \
  "happyx2-mail-backups/weekly/YYYY-MM-DD/<backup>.sql.gz" \
  --remote --file /tmp/cloud-mail-restore-check.sql.gz

gzip -t /tmp/cloud-mail-restore-check.sql.gz
gzip -dc /tmp/cloud-mail-restore-check.sql.gz | \
  sqlite3 /tmp/cloud-mail-restore-check.sqlite
sqlite3 /tmp/cloud-mail-restore-check.sqlite "PRAGMA integrity_check;"
```

以上命令只恢复到本地临时 SQLite 文件。未经单独审批和新鲜备份验证，不得把演练
文件直接导回生产 D1。

## 待办与边界

- 分析页应同时展示 5 GB 费用阈值和 10 GB 硬容量阈值。
- 邮件正文和附件迁移到 R2 尚未实施。
- 若实施正文迁移，需要完成双写、D1/R2 一致性校验、双读取、搜索兼容、分批迁移
  和可回滚验证后，才能删除 D1 中的历史正文。
- 每次修改备份 Worker 后，应至少验证 Workflow 成功、R2 对象可下载、gzip 完整、
  SQLite 可恢复以及生产邮件列表可读取。
