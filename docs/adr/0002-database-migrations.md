# ADR-0002：生产迁移与应用启动解耦

- 状态：已接受
- 日期：2026-07-25

## 决策

开发环境默认允许自动迁移；`NODE_ENV=production` 时 `AUTO_MIGRATE` 默认且必须为 `false`。发布人在应用部署前使用独立迁移账号执行 `npm run migrate`，随后运行 `npm run db:check-invariants`。应用运行账号不应拥有建库或 DDL 权限。

每个 SQL 文件以 SHA-256 写入 `migrations/manifest.json`，已经应用的迁移不可修改。MySQL 5.7 的 DDL 不能假定可由事务完整回滚，因此每个新迁移必须在发布记录中写明前向兼容、旧客户端兼容和失败处置。

## 复审条件

只有备份恢复演练、staging 全量迁移、字符集/排序规则检查和应用兼容测试均通过后，才评估 MySQL 8 升级。
