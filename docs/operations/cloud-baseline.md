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

## 2026-07-26 production 采集结论

- 服务实例为 1 核、2 GiB，最小 1 个、最大 5 个实例，日志采集路径为 `stdout`，`/health` 公网检查成功。
- `record_life` 为可用的 MySQL 5.7 数据库，字符集/排序规则为 `utf8mb4` / `utf8mb4_unicode_ci`。
- 运行账号没有 DDL 权限，维护账号已在迁移前快照成功后应用 `004` 与 `005`；迁移记录见
  [`production-database-migration-2026-07-26.md`](./production-database-migration-2026-07-26.md)。
- 云托管已发布 `express-bonj-041`，Release ID 为 `2026.07.25-rc.3+a7de960368ad`。
- COS ObjectCreated 触发器明确关闭，`ENABLE_STORAGE_EVENTS=false`；图片处理使用已通过冒烟的 `/media/:mediaId/upload-complete` 核心链路。
