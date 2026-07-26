# 优化执行状态

最后验证日期：2026-07-26。“代码完成”不等于“真实云/真机已验收”。

| ID | 状态 | 本次交付/证据 | 未完成的外部动作 |
|---|---|---|---|
| P0-01 | 完成 | 公开 GitHub 仓库、MIT License、`main`、baseline/release tags、真实 `@welliamfine` CODEOWNER、`Protect main` ruleset、私密漏洞报告 | 无 |
| P0-02 | 完成 | Node/npm 锁定，三项目 `npm ci`，独立测试边界，`verify:all`，远程 CI run `30190494400` 全部通过 | 无 |
| P0-03 | 完成 | production expected/actual 基线已与控制台、MySQL 和 `/health` 对齐，按环境漂移检查可执行 | 无 |
| P0-04 | 已生产部署 | `2026.07.25-rc.3+a7de960368ad` 制品已部署为 `express-bonj-041`，线上健康正常，历史版本可回退 | 首次实际回滚演练可在出现独立 staging 后进行 |
| P0-05 | 当前范围关闭 | COS handler 代码和测试保留；`ENABLE_STORAGE_EVENTS=false`，核心 `/upload-complete` 链路已通过 | 非上线必需，不再创建/排查 COS 触发器 |
| P0-06 | production 完成 | 现有 CloudBase、`express-bonj`、MySQL 和私有 COS 已按真实用途登记为 production；构建/校验目标已对齐 | 独立 staging 在多人协作、自动发布或破坏性演练前再创建 |
| P0-07 | 生产迁移/备份完成 | 001-005 迁移、校验和、生产前手动快照备份均成功 | 隔离恢复演练延后到需要保留正式用户数据前 |
| P0-08 | 核心冒烟完成 | 开发者工具已通过登录、数据库写入、单图直传、`upload-complete`、图片处理和首页显示 | 正式公开发布或扩大测试用户前补 iOS/Android 真机矩阵 |
| P0-09 | 代码完成 | 信任身份校验、回调 Token 轮换、IP/用户/模块/媒体维度限流和 429 | 云 WAF/网关全局限流、压测与 Token 实际轮换 |
| P0-10 | 当前范围关闭 | 健康端点和结构化运行日志可用；`ENABLE_METRICS=false` | 指标/告警属于后续运营能力，不阻断当前上线 |
| P1-01 | CI 完成/CD 待配置 | 固定 SHA 的 CI、MySQL 5.7 service、周审计、手工 release workflow、Dependabot；远程 run 全绿 | 仓库 secrets/environment approval、staging CD 与生产人工审批 |
| P1-02 | 完成 | 前端 45、后端 47、函数 6 项测试，覆盖率门禁、远程 MySQL 5.7 容器中的迁移重放、不变量与业务集成冒烟 | 无 |
| P1-03 | 代码完成 | 四 Tab 主包+十页分包，移除未用字体/生产 Mock，主包/分包/总量预算 | 微信开发者工具首包时间与 14 页真机视觉回归 |
| P1-04 | 代码完成 | AST 生成 74 operations 的 OpenAPI，漂移门禁和 ADR | 对外消费者合同测试证据 |
| P1-05 | 模型/手册完成 | 容量计算命令、压测指标、故障注入与扩展阈值 | staging 真实压测/故障注入、成本账单和参数调整证据 |
| P1-06 | 代码完成 | 优雅 drain、停止新工作、lease heartbeat、有界重试/dead letter、被动 Outbox 审计收敛 | staging 进程终止/租约丢失/重放演练 |
| P1-07 | 代码完成 | MySQL 5.7 CI、不变量、运营索引迁移、升级门禁 | production/staging `EXPLAIN`、数量基线和升级决策 |
| P1-08 | 部分完成 | 分包和已抽取的 motion/media/checkin 工具有独立测试 | 大页面与 local/remote API 全量按领域拆分需真机对照；本次不在无真机证据时做高风险改写 |
| P1-09 | 代码/手册完成 | 同意门禁、批量/上限/退避/离线队列、禁止字段、HMAC userHash、90 天清理 | 真实仪表盘、与服务端事实对账的运营期数据 |
| P1-10 | 代码/清单完成 | 个人数据清单、注销跨表/COS Outbox/匿名化/分析删除、备份再删除流程 | 法务批准、staging 完整删除报告、管理端最小权限复核 |
| P2-01 | 代码完成 | 重写 README、ADR 和固定运维目录 | 每次发布继续更新证据 |
| P2-02 | 代码完成 | 周审计、SBOM、Node 22.23.1/npm/action/MySQL/Docker 精确标签锁定、hash 制品 | Docker registry 本机不可达，尚未用 digest 替换精确标签；需在可访问 registry 的 CI 查询并更新 |
| P2-03 | 模型完成 | 容量/成本参数、Worker/DB 扩展阈值 | 导入真实账单与 7-14 天指标，每月复审 |
| P2-04 | 门禁未放行 | 准入条件已文档化 | P0 外部证据、首次稳定发布/回滚和 7-14 天基线未完成，不恢复新功能扩张 |

## 本地验证证据

```text
npm run verify:all
npm run verify:production
npm run cloud:check-drift -- --environment=production --actual=config/cloud-actual.2026-07-26.json
npm audit --audit-level=high (root/server/cloud function)
npm --prefix server run openapi:check
npm --prefix server run migrations:check
```

## 远程验证证据

- 仓库：<https://github.com/welliamfine/Note4Seven>
- 验证提交：`1f9c4f7900779dbca84ef34b9dc969d7c50d5439`
- CI run：<https://github.com/welliamfine/Note4Seven/actions/runs/30190740517>
- 结果：`miniprogram`、`backend`、`cos-trigger` 全部成功；`backend` 使用 `mysql:5.7.44` 服务容器完成双次迁移、不变量和业务集成冒烟。
- 仓库规则：<https://github.com/welliamfine/Note4Seven/rules/19757602>，要求 PR、线性历史、解决讨论并通过三个 CI 检查，禁止删除和强推；单维护者批准人数为 0。
- 保护流程实测：<https://github.com/welliamfine/Note4Seven/pull/3> 通过三个必需检查后以 squash 合并，合并后的 `main` CI 再次通过。
- 公开安全边界：MIT License、`SECURITY.md`、私密漏洞报告、依赖漏洞告警/自动安全更新、秘密扫描和推送保护已启用。

本机 Docker daemon 未运行，但远程 CI 的 MySQL 5.7 容器验证已经通过。Production CloudBase 与开发者工具核心冒烟已通过；COS 触发器明确关闭且不属于核心链路，iOS/Android 真机矩阵仍未执行。
