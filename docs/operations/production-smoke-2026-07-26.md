# Production 核心冒烟记录

- 执行日期：2026-07-26
- 执行环境：微信开发者工具 Stable `2.01.2510290`
- 执行人：项目维护者
- Release ID：`2026.07.25-rc.3+a7de960368ad`
- CloudBase 环境：`prod-d5g4tznceeecbaf39`
- 云托管服务：`express-bonj`，线上版本 `express-bonj-041`
- 数据库：MySQL 5.7，`record_life`
- 对象存储：`7072-prod-d5g4tznceeecbaf39-1346314817`，`ap-shanghai`

## 服务事实

- `/health` 返回 HTTP 200、`status=ok`、`environment=production`。
- `releaseId=2026.07.25-rc.3+a7de960368ad`。
- 微信集成状态为 `ready`，模式为 `transparent_proxy`。
- 存储集成状态为 `ready`，模式为 `temporary-credentials`。
- `AUTO_MIGRATE=false`、`ALLOW_DEV_AUTH=false`。
- COS ObjectCreated 触发器和存储事件功能均关闭；不依赖该可选链路上线。

## 核心链路结果

| 场景 | 结果 | 说明 |
|---|---|---|
| 小程序启动并加载首页 | 通过 | 生产云托管链路正常 |
| 微信登录/会话建立 | 通过 | 无开发鉴权回退 |
| 新建一条带单图记录 | 通过 | 数据库写入成功 |
| 获取临时凭证并直传私有 COS | 通过 | 存储集成正常 |
| 调用上传完成接口 | 通过 | 使用 `/media/:mediaId/upload-complete` 核心回退链路 |
| 图片处理完成 | 通过 | 不依赖 COS ObjectCreated 触发器 |
| 新记录在首页显示 | 通过 | 端到端读取正常 |

结论：当前发布所需的登录、数据库、图片上传、上传完成回调、图片处理和首页读取核心链路已通过。订阅消息、指标、分析和 COS 事件触发均保持关闭，不纳入本次上线门禁。
