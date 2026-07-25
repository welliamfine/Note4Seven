# 备份与恢复手册

暂定业务目标为 RPO 24 小时、RTO 4 小时；正式上线前需由产品与运维负责人签字确认。平台每日自动备份与每次生产迁移前手工一致性备份同时保留。

## 账号与保留

- 应用账号：仅授予业务 DML，不授予 DDL、建库或备份权限。
- 迁移账号：仅在受控作业中注入，具备需要的 DDL。
- 备份账号：只读与备份必要权限，不与应用账号共享密码。
- 建议保留：日备份 14 天、周备份 8 周、月备份 12 个月；最终期限须与隐私/合同要求一致。

## 发布前备份

```powershell
$env:MIGRATION_MYSQL_ADDRESS='<internal-host>:3306'
$env:MIGRATION_MYSQL_USERNAME='<backup-user>'
$env:MIGRATION_MYSQL_PASSWORD='<secret>'
$env:MIGRATION_MYSQL_DATABASE='record_life'
npm --prefix server run db:backup -- --environment=production --release=<release-id>
```

命令采用 single-transaction/quick dump，在可用空间少于 512 MiB 时拒绝执行，输出备份路径和 SHA-256。密码通过子进程环境传递，不进入命令行。将备份上传到限制访问的备份仓，不要提交到 Git。

## 隔离恢复演练

1. 创建与 production 不同库名、不对外提供流量的 MySQL 5.7 实例/数据库。
2. 校验备份 SHA-256，注入 `RESTORE_MYSQL_*` 变量。
3. 执行：

```powershell
npm --prefix server run db:restore -- --environment=restore --backup=<file.sql> --sha256=<sha256>
```

4. 将应用 DB 变量指向恢复库，执行 `npm --prefix server run migrate` 两次，再执行 `npm --prefix server run db:check-invariants`。
5. 对比表数、核心表行数、媒体对象键数和重点业务抽样，运行登录/创建模块/打卡/邀请/回应/删除冒烟。
6. 记录开始、可用恢复点、完成时间，计算实际 RPO/RTO。

## 账号删除与备份

在线库删除不能从已封存备份中就地删除单条数据。每次恢复后，必须在对外开放前重放“已完成注销用户”的删除/匿名化清单，再运行跨表、COS Outbox 和分析哈希核对。

## 演练证据

每次记录 release ID、备份 ID/SHA-256、源/目标 MySQL 版本、执行人/审核人、起止时间、行数对比、不变量结果、冒烟结果、实际 RPO/RTO 与改进项。
