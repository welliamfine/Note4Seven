# ADR 0006: 只信任网关注入的微信身份

状态：Accepted，2026-07-25。

业务登录只信任 CloudBase/CloudRun 网关在受控调用中注入的 OpenID、AppID、环境和调用来源，不信任公网客户端自行填写的身份 Header。后端签发短期 Bearer 会话，日志对授权、Cookie 和云令牌脱敏。

`X-Dev-OpenId` 仅在非生产且 `ALLOW_DEV_AUTH=true` 时存在，生产配置该值会拒绝启动。微信 XML 回调与 COS 内部事件使用独立 Token，支持 current/previous 无停机轮换，不与用户会话共用。
