# Staging 真机 E2E 验收

报告必须记录 release ID、commit、staging 环境/服务/数据库/COS 标识、测试账号、设备/系统/微信版本、执行人、时间、结果、请求 ID 和截图/日志链接。

## 环境门禁

- staging 不得包含 production 环境 ID、服务名、桶或数据库。
- 小程序基础库最低/目标版本各一台，iOS 和 Android 各一台。
- 真实 `wx.cloud.callContainer`、真实 COS 上传/触发、内容安全、数据万象、订阅消息和小程序码必须在 staging 账号下运行。

## 核心矩阵

| 场景 | iOS | Android | 服务端事实 |
|---|---|---|---|
| 登录、隐私同意/撤回、会话失效 | 待执行 | 待执行 | session/consent/analytics |
| 创建模块、置顶、移除、回收/恢复 | 待执行 | 待执行 | module/audit/outbox |
| 选图、压缩、上传、COS 触发、审核、抠图、ready | 待执行 | 待执行 | media/record/outbox |
| WebP/PNG、签名过期刷新、双触发去重 | 待执行 | 待执行 | media uniqueness/status |
| 新增/编辑/删除/重试打卡与 pending-record-first 旧客户端 | 待执行 | 待执行 | record revision/compatibility |
| 邀请、加入审批、转让、移除/退出 | 待执行 | 待执行 | member/invite/audit |
| 补卡、回应、通知/待办、提醒 | 待执行 | 待执行 | approval/reaction/job |
| 月度回忆、换一组、导出相册 | 待执行 | 待执行 | snapshot/memory/export |
| 账号删除、COS 删除、Outbox 重试、匿名化 | 待执行 | 待执行 | cross-table deletion |

## 故障场景

断网/恢复、重复点击、重复 COS 事件、审核超时、抠图失败、订阅拒绝、过期签名、无效/伪造微信身份、无效回调 Token、限流 429、Runner 重启和优雅停机。每个场景同时核对 UI、HTTP 包络、数据库状态和指标。
