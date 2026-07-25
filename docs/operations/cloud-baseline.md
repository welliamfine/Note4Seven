# 云配置基线与漂移核对

`config/cloud-expected.json` 是代码期望，`config/cloud-actual.example.json` 是控制台取证模板。它们不代表已核实真实云状态。

## 采集范围

- AppID、CloudBase 环境 ID、服务名、当前版本/release ID、最小/最大实例、健康检查。
- MySQL 引擎/版本、库名、迁移记录/校验和、容量、最近备份时间。
- COS 桶/地域/私有访问/CORS/生命周期，ObjectCreated 触发器的 event/prefix/suffix 和目标函数。
- 云函数版本、Node runtime、超时/重试、环境变量名（不采集值）、近期错误。
- 微信回调、订阅模板字段、安全接口权限与 `callContainer` 真实调用。

将采集值写入一份不含密钥的日期文件后执行：

```powershell
npm run cloud:check-drift -- --actual=config/cloud-actual.2026-07-25.json
```

任何未采集值、与期望不一致或 staging/prod 资源复用都会阻断晋级。Token 与密码只记录“已配置/轮换日期”，不记录真实值。
