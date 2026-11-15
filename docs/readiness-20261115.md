# 发布与恢复准备记录

工作目录：`/Users/max/Code/cloudmail`。日期：2026-11-15。

## 代码与远端

本地原先仅有导入基线提交，大量业务修改留在工作区；GitHub main 实际已有历史功能
提交，不能称为远端从未同步。整理版本采用独立分支
`maintenance/readiness-20261115`，保留远端 main 历史，不自动合并、发布。
如 Git smart HTTP 连接超时，可使用 `scripts/sync-reviewed-snapshot.mjs`：
要求工作区先提交干净，生成以远端 main 为父提交的新分支，并校验 Git 树与本地一致。
本地与远端提交 ID 可以不同，映射记录在 `.private/github-sync.json`。

`.private/`、`.local-archive/`、数据库、备份包、凭证快照均不进入 Git。
环境变量文件中公开的前端 URL 不属于 Secret；不得将私有变量放入 VITE_*。

## 迁移与测试

`.gitignore` 已对 `mail-worker/migrations/*.sql` 放行。生产查询显式依赖索引，
新环境必须先执行迁移，详见迁移目录 README；CI 不自动对生产执行建索引。

```sh
cd /Users/max/Code/cloudmail/mail-worker
pnpm install --frozen-lockfile
pnpm test
# 交互式本地预览，需先构建前端
pnpm test:serve
```

测试使用独立 Miniflare D1/KV、本地域名及显式测试密钥，不连接生产资源。
12 项测试覆盖地址搜索、去重、大小写、翻页、正文/附件保持、注入形态输入、
查询索引、所属用户隔离、锁定分组防删除、未登录权限、备份分片及失败中止。
本地预览实际验证首页 HTTP 200、私有接口业务码 401；已关闭测试服务。
前端 frozen-lockfile 安装和 release 构建通过。现有大包及 Browserslist 警告保留。
这不是外部邮件投递、压力测试或完整云端预发布环境验收。

## 发布检查

```sh
cd /Users/max/Code/cloudmail
node scripts/release-preflight.mjs
```

预检只读取生产版本、必要绑定和七个索引，并检查公开配置接口；报告在
`.private/release-preflight.json`。2026-11-15 实际通过，生产版本仍为
`966cbbd3-aa63-4e4d-896a-c9f1bc109159`。
Wrangler 对未授予的其他产品权限提示，不等同于这些实际操作失败。
未来部署、域名变更等仍可能需要相应权限，不能据此认定所有权限齐全。

发布方式按用户选择调整为本地 AI/CLI 唯一生产入口，不新增发布脚本。AI 按 AGENTS.md
完成必要测试、构建、预检、发布记录与上线验证，直接用 Wrangler 发布。
GitHub Actions 的 push/PR/workflow_dispatch 均只做测试和构建，不读取 Cloudflare
凭证、不含发布任务；Cloudflare Git 构建禁用。同步源码不应触发任何生产发布。
CI 是独立复验，本地发布不等待它，因此不能将 CI 称为部署前强制拦截。
每次发布保存提交、旧/新版本和验证结果，一次只执行一个生产发布任务。
旧流程的自动初始化、覆盖 Secret 和清除运行日志行为已移除。

## 恢复操作与密钥限制

完整恢复包括：源码/依赖版本、D1 数据、附件所在 KV/R2/S3、线上变量、加密 Secret、
自定义域与 Email Routing。D1 SQL 验证成功不代表附件对象或整套基础设施均可恢复。

Cloudflare 不允许导出 `jwt_secret`、`D1_REST_API_TOKEN` 的明文。当前快照只保证
已能读取的变量和 Secret 名称；如本地没有原值，密钥备份仍不完整。
不要为了补全记录而盲目轮换：JWT 轮换会使会话失效，备份 Token 轮换需更新 Worker
后运行备份验证。应将找到的原始密钥存入受控密码库，项目内副本仅放 `.private/`。
灾难重建时确实找不到原值，才创建最小权限替代密钥并记录轮换影响。

下载备份到 `.private/`，随后执行：

```sh
gzip -t .private/restore-complete-20261115.sql.gz
python3 scripts/restore-verify.py \
  .private/restore-complete-20261115.sql.gz .private/restore-20261115-new.sqlite
```

恢复脚本拒绝覆盖目标，仅导入新建本地 SQLite，不连接 Cloudflare；验证完整性、
记录计数和压缩包 SHA-256。绝不能把本地演练导回生产覆盖现有邮件。
最新演练结果记录在 production-status.md。
2026-11-15 实际完整恢复成功：97,792 封邮件，gzip 校验通过，SQLite integrity_check=ok。
