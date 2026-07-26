# 发布与回滚手册

最后验证：2026-07-26。production 发布和核心开发者工具冒烟证据见 `production-smoke-2026-07-26.md`。

## 发布前门禁

1. 工作树干净，候选提交已通过 CI，高危/严重依赖漏洞为 0。
2. `config/cloud-actual.<date>.json` 由控制台采集，`npm run cloud:check-drift -- --environment=production --actual=<file>` 通过。
3. 独立 staging 配置后必须与 production 的环境、服务、数据库、COS 桶和 Token 隔离。当前单维护者、未正式发布阶段采用 production 手工发布和核心冒烟，不执行破坏性测试。
4. 对目标库完成发布前备份，记录 SHA-256、备份时间、库大小和恢复演练结果。
5. 显式迁移在应用部署前完成，同一套迁移重复执行无副作用，不变量检查通过。
6. 当前至少完成 production 核心冒烟并绑定 release ID；正式公开发布或扩大测试用户前补充 iOS/Android 真机矩阵。
7. 发布人和回滚操作人已确认；无第二位审核人时保留平台人工发布确认。

## 构建与晋级

```powershell
npm run verify:all
npm run verify:production
npm run release:build -- --version=<semver>
```

`artifacts/<release-id>/release-manifest.json` 是发布事实源，三个 ZIP、SBOM、清单和回滚目标必须共享同一 release ID/commit。当前 production 部署保留人工确认、备份确认和回滚目标确认；独立 staging 建成后再恢复“同一制品先 staging 后 production”的晋级流程。

## 发布后观察

至少 30 分钟观察 `/health`、API 5xx/P95、媒体失败、Outbox 年龄/积压、Job 失败/死信、MySQL 连接/慢查询和 COS 调用。在发布记录中附上仪表盘查询或截图。

## 回滚

1. 停止新流量晋级，记录事故时间线和当前 release ID。
2. 云托管服务切回 `release-manifest.json` 中的上一已验证后端镜像/版本。
3. 仅当 `ENABLE_STORAGE_EVENTS=true` 时回滚 COS 函数；当前该可选链路关闭，无需处理。
4. 小程序按微信平台能力撤回/重新提交上一稳定版；后端在旧客户端兼容窗口内不删除 pending-record-first 等兼容接口。
5. 数据库迁移采用 expand/contract，默认不执行破坏性 down migration。若数据已损坏，按恢复手册进入隔离库验证后再决定前向修复或时点恢复。
6. 重新执行健康、不变量和核心冒烟，观察 30 分钟，将结果附到事故和发布记录。
