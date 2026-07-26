# Staging 数据库迁移记录：2026-07-26

## 范围

- 环境：现有未发布的 CloudBase 环境，按项目决策归类为 staging。
- 数据库：`record_life`，MySQL 5.7，`utf8mb4` / `utf8mb4_unicode_ci`。
- 迁移：`004_operational_indexes.sql`、`005_analytics_events.sql`。
- 变更性质：新增运营索引与 `analytics_event` 表，不删除或改写现有业务数据。

## 迁移前证据

- `schema_migration` 仅包含 `001` 至 `003`。
- `information_schema.statistics` 确认 4 个目标索引均不存在。
- `information_schema.tables` 确认 `analytics_event` 不存在。
- 2026-07-26 17:10:50 +08:00 完成手动快照，备注为
  `pre-migration-004-005-20260726`，大小 2.710 MiB，平台状态为成功。

## 账号边界

- 运行账号 `notemylife_app` 执行 `ALTER TABLE` 时被 MySQL 拒绝，证明运行账号没有 DDL 权限。
- 迁移改用维护账号 `notemylife`；`SHOW GRANTS` 确认其具备本次所需的
  `ALTER`、`INDEX`、`CREATE` 权限。
- 密码、Token 和授权值未写入仓库或本记录。

## 执行结果

| 迁移 | SHA-256 | 应用时间（+08:00） | 结果 |
|---|---|---|---|
| `004_operational_indexes.sql` | `78abfc8e99b6151f7abefea2d959bea407442b2b167724b57e749084d505187d` | 2026-07-26 17:26:37.663 | 成功 |
| `005_analytics_events.sql` | `f05b2ab9e9897a21bb8bce12809b72dc05d8ec1648ce281418ad4f6f7a32ec7b` | 2026-07-26 17:28:56.471 | 成功 |

`schema_migration` 已追平仓库中的 5 个迁移。迁移后从公网访问 `/health`，
服务于 2026-07-26 17:29:47 +08:00 返回 `status: ok`。

## 尚未完成

- 尚未执行隔离恢复演练，因此不能把备份标记为“已验证可恢复”。
- 尚未在新版本 staging 服务中运行完整数据库不变量与业务 E2E。
- 平台自动备份当前保留 7 天，低于手册建议的 14 天；上线前需完成保留期决策。
