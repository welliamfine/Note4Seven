# 生产后端

Node.js 22 + Express 5 + MySQL 5.7 兼容基线的 CloudBase 后端。它提供会话、模块/记录/协作 API、私有媒体处理、微信回调、任务调度、指标与合规分析。

## 本地验证

```powershell
npm ci
npm run verify
```

`verify` 包含类型、单元测试、OpenAPI 合同、迁移校验和构建。需要真实 MySQL 5.7 的集成验证由根目录 Docker 联调或 CI service 执行。

## 配置

- 本地模板：`env.local.example`
- 生产安全模板：`.env.example`
- 真实密码、Token 和盐只能由密钥管理/部署平台注入
- `AUTO_MIGRATE=false` 是生产强制条件
- `ALLOW_DEV_AUTH=true` 在生产会直接启动失败
- 回调、COS 事件、订阅、`/metrics` 和 `/analytics/events` 只在对应 `ENABLE_*` 打开后提供

`GET /health` 返回数据库、微信和存储 readiness，并包含 release ID 和环境。业务 API 前缀为 `/api/v1`，机器可读合同位于 `openapi/openapi.json`。

## 迁移

```powershell
npm run migrations:check
npm run db:backup -- --environment=staging --release=<release-id>
npm run migrate
npm run db:check-invariants
```

应用运行账号只授权必要 DML；备份/迁移使用独立账号。恢复命令只接受 `--environment=restore`，且要求目标库名与应用库不同。完整演练见 [备份恢复手册](../docs/operations/backup-and-restore.md)。

## 发布与停机

`npm run deploy -- --environment=<staging|production> --release=<id>` 默认 dry-run，生产还需显式确认。进程收到 `SIGTERM` 后先停止接收新任务，等待当前 Runner 周期结束，再关闭 HTTP 和数据库连接。Outbox 与 Job 经过租约心跳、有界重试和死信收敛。

## MySQL 升级边界

当前只保证 MySQL 5.7 兼容。未完成最新备份恢复、staging 全量迁移、查询计划和旧客户端兼容验证前，不安排 MySQL 8 升级。
