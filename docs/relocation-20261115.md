# 目录迁移记录

2026-11-15 将 Cloud Mail 工作资料统一到 `/Users/max/Code/cloudmail`。

原路径：`/Users/max/Documents/Codex/2026-07-22/https-dash-cloudflare-com-d07e8add7d5d4a068815315d8cc5d733-domains/work/cloud-mail`。
原路径现在为指向新根目录的符号链接。

已保留：完整 `.git`（包括未引用对象）、所有原文件与依赖、未提交改动、前端 env、
Wrangler 配置、构建产物、备份 Worker、当前运维文档。迁移校验使用 rsync 校验和，
原文件只有新添加忽略规则的 `.gitignore` 发生预期差异。

历史源码压缩包、未完成下载、早期克隆及源码树 JSON 均移至 `.local-archive/imports/`。
迁移前工作副本归档于 `.local-archive/previous-checkout/`（其 Git 元数据现位于新根目录），
保留作为此次搬迁的额外可恢复副本，因此本机占用会高于单份仓库。
提交历史同时导出成 Git bundle 并验证成功；Git 检查发现一个原有未引用提交，已随 `.git` 保留。

本任务原始 JSONL 对话复制至 `.local-archive/history/`。这是整理时点快照，
之后的新对话仍由 Codex 保管，不自动同步。其他任务或软件的聊天历史未纳入本次迁移。

共享 OAuth 登录配置复制到 `.private/`，原系统文件保留，避免破坏其他项目的登录。
Cloudflare 可读变量与部署资源已私有导出；加密 Secret 只有名称，原值无法从平台导出。
线上 D1/R2 数据继续位于 Cloudflare，不因本次目录迁移而转移或删除。

本次没有提交或推送 GitHub，也没有更改生产部署。后续工作从新根目录开始。
