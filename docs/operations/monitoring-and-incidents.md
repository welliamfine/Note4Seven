# 监控、告警与事故手册

`/metrics` 只在 `ENABLE_METRICS=true` 时开启，并由至少 24 位的 `METRICS_TOKEN` 保护。不向公网仪表盘用户暴露 Token。

## 最小仪表盘与阈值

| 信号 | 告警建议 | 首要操作 |
|---|---|---|
| API 5xx | 5 分钟 > 2% 且请求 > 50 | 按 route/release 定位，评估回滚 |
| API P95 | 10 分钟 > 2s；媒体端点 > 5s | 查 CPU、DB 连接/慢查询和下游 |
| media failed | 10 分钟 > 5% 或连续 10 件 | 按 stage/failure_code 查 COS、安全、抠图 |
| media processing age | 最老 > 5 分钟 | 查 trigger、Runner 租约和死信 |
| outbox pending age | 最老 > 5 分钟或 pending > 100 | 查 event_type 与下游，谨慎重放 |
| job failure/dead letter | 任意 dead letter；同任务 3 次失败 | 冻结自动重试，保存 payload/request ID |
| analytics rejected | 10 分钟 > 1% | 核对客户端 schema/release，不放宽隐私规则 |
| DB connections | > 80% 10 分钟 | 查泄漏、慢查询、实例数与 pool |
| DB disk | > 70% 预警，> 85% 严重 | 扩容/清理前先确认备份 |
| backup | 24h 无成功备份或校验失败 | 禁止迁移/发布 |
| instance/health | 可用实例 < 1 或 health 2 次失败 | 切回稳定版，检查启动配置 |

云监控还需添加 MySQL 慢查询、容量增长、COS 错误/费用、微信 OpenAPI 失败和最小实例告警。告警通道、轮值表和升级人由运维在真实平台配置并截图取证。

## 事故级别

- SEV-1：数据丢失/泄露、全量不可用、无法回滚。立即停止发布并升级负责人。
- SEV-2：核心打卡/媒体/登录显著受损，有降级或局部回滚路径。
- SEV-3：非核心功能、少量用户或可重试的延迟。

## 处置顺序

1. 记录发现时间、release ID、环境、影响和请求 ID，指定指挥/操作/沟通角色。
2. 保存指标、日志、数据库和云配置证据，不在群聊粘贴密钥或个人数据。
3. 先止血：停止晋级、关闭对应 capability、限流或回滚。未完成备份不做破坏性数据修改。
4. 每 30 分钟更新影响和恢复预期，恢复后观察至少 30 分钟。
5. 48 小时内完成无责复盘：根因、检测缺口、时间线、修复、负责人和到期日。

## 告警演练记录模板

```markdown
# <date> <alert> drill
- Release/environment:
- Participants and roles:
- Trigger method:
- Detected at / acknowledged at / mitigated at:
- Dashboard and log evidence:
- User impact (expected/actual):
- Mitigation and rollback result:
- Gaps, owner, due date:
```
