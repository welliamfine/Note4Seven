# 最小产品分析与事实对账

分析事件用来解释“用户做了什么”，业务表用来确认“系统真正完成了什么”。成功转化不能只依赖客户端点击。

| 漏斗步骤 | 客户端事件 | 服务端事实 |
|---|---|---|
| 登录成功 | `app_open` 的 loginStatus | `auth_session` + `user_account.last_login_at` |
| 创建模块 | `module_create_success` | `life_module.created_at` |
| 选图 | `photo_source_select` | 无，只表示意图 |
| 完成上传 | `media_upload_complete` | `media_asset.status` 进入 processing |
| 媒体 ready | 客户端仅作体验辅助 | `media_asset.status='ready'` |
| 打卡成功 | `record_submit_success` | `life_record.status IN ('active','locked')` |
| 邀请转化 | landing/application 事件 | `join_application.status='approved'` + `module_member` |
| D1/D7 留存 | `app_open` | 账号首见日后第 1/7 日的会话或有效记录 |

看板至少包含选图 -> 上传 -> ready -> 记录成功的分阶段数量/转化率，媒体 failure_code/stage，邀请申请/通过率，D1/D7 留存。按 environment/release/device/network 分组，但不下钻到单个自然人。

每日对账应输出：客户端成功事件数、对应服务端事实数、差异率、重复事件数、拒绝事件数和按 release 的差异原因。差异阈值暂定 3%，上线后用 7-14 天基线调整。
