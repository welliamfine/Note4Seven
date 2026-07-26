# 云配置基线与漂移核对

`config/cloud-expected.json` 是代码期望，`config/cloud-actual.example.json` 是控制台取证模板。它们不代表已核实真实云状态。

当前采用单生产环境模式：现有 CloudBase 环境、`express-bonj`、MySQL 和私有 COS 桶共同构成 production。独立 staging 暂未配置，不作为当前单维护者、未正式发布阶段的上线阻断项；需要多人协作、自动发布或破坏性演练前再建立完全隔离的 staging。

COS 桶用于图片存储，必须保留。COS ObjectCreated 触发器属于可选加速链路，当前明确关闭；图片处理通过客户端上传完成后调用 `/media/:mediaId/upload-complete` 的核心链路触发。

## 采集范围

- AppID、CloudBase 环境 ID、服务名、当前版本/release ID、最小/最大实例、健康检查。
- MySQL 引擎/版本、库名、迁移记录/校验和、容量、最近备份时间。
- COS 桶/地域/私有访问/CORS/生命周期，ObjectCreated 触发器的 event/prefix/suffix 和目标函数。
- 云函数版本、Node runtime、超时/重试、环境变量名（不采集值）、近期错误。
- 微信回调、订阅模板字段、安全接口权限与 `callContainer` 真实调用。

将采集值写入一份不含密钥的日期文件后执行：

```powershell
npm run cloud:check-drift -- --environment=production --actual=config/cloud-actual.2026-07-26.json
```

production 的任何未采集值或与期望不一致都会阻断发布。staging 配置完成后，检查器还会强制核对两套资源不能复用。Token 与密码只记录“已配置/轮换日期”，不记录真实值。
