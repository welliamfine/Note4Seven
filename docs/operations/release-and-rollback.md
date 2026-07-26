# 发布与回滚手册

最后验证：2026-07-25（仅代码与本地制品链）。真实 staging/生产证据尚未产生。

## 发布前门禁

1. 工作树干净，候选提交已通过 CI，高危/严重依赖漏洞为 0。
2. `config/cloud-actual.<date>.json` 由控制台采集，`npm run cloud:check-drift -- --environment=production --actual=<file>` 通过。
3. staging 与 production 的环境、服务、数据库、COS 桶、Token 和最小实例独立。
4. 对目标库完成发布前备份，记录 SHA-256、备份时间、库大小和恢复演练结果。
5. 显式迁移在应用部署前完成，同一套迁移重复执行无副作用，不变量检查通过。
6. staging iOS/Android 核心矩阵与故障场景通过，验收报告绑定 release ID。
7. 发布人、审批人、回滚操作人和当班观察人已确认。

## 构建与晋级

```powershell
npm run verify:all
npm run verify:production
npm run release:build -- --version=<semver>
```

`artifacts/<release-id>/release-manifest.json` 是发布事实源，三个 ZIP、SBOM、清单和回滚目标必须共享同一 release ID/commit。先部署 staging，不重新构建地将同一制品晋级到生产。生产部署保留人工审批、备份确认和回滚目标确认。

## 发布后观察

至少 30 分钟观察 `/health`、API 5xx/P95、媒体失败、Outbox 年龄/积压、Job 失败/死信、MySQL 连接/慢查询和 COS 调用。在发布记录中附上仪表盘查询或截图。

## 回滚

1. 停止新流量晋级，记录事故时间线和当前 release ID。
2. 云托管服务切回 `release-manifest.json` 中的上一已验证后端镜像/版本。
3. COS 函数切回上一个制品，保留当前和 previous Token 的轮换窗口。
4. 小程序按微信平台能力撤回/重新提交上一稳定版；后端在旧客户端兼容窗口内不删除 pending-record-first 等兼容接口。
5. 数据库迁移采用 expand/contract，默认不执行破坏性 down migration。若数据已损坏，按恢复手册进入隔离库验证后再决定前向修复或时点恢复。
6. 重新执行健康、不变量和核心冒烟，观察 30 分钟，将结果附到事故和发布记录。
