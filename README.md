# 记录我的一辈子

微信原生小程序与 CloudBase 后端。仓库包含小程序、Express/MySQL 服务、COS 对象创建触发函数，三者使用同一 release ID 发布。

## 环境要求

- Node.js 22.x（见 `.nvmrc` 和 `.node-version`）
- npm 11.x
- 本地后端联调需 Docker Desktop 及 MySQL 5.7 容器
- 真实云联调需已配置的 development/staging CloudBase 资源

## 干净安装与验证

```powershell
npm run ci:install
npm run verify:all
```

`ci:install` 会对根项目、`server/` 和 COS 触发函数执行锁定依赖安装。`verify:all` 覆盖静态检查、类型检查、测试、OpenAPI/迁移漂移检查和三个发布单元构建。

## 构建模式

```powershell
npm run build:mock
npm run build:local-backend
npm run build:staging
npm run build:production
```

- `mock` 仅用于本地 UI/交互验收，Mock 图片不会进入生产包。
- `local-backend` 连接本地 Express/MySQL。
- `staging` 和 `production` 必须显式读取 `config/environments.json`，staging 未完成独立资源配置时构建会失败。

微信开发者工具导入仓库根目录，实际运行目录为 `dist/`。主包只保留四个 Tab 页，其他业务页在 `subpackages` 分包。

## 本地后端

```powershell
Copy-Item server/env.local.example server/.env
npm run dev:local-backend
```

该命令依赖 Docker daemon。停止环境使用 `npm run local:down`。不要把 `.env` 或真实云密钥提交到仓库。

## 发布

```powershell
npm run verify:production
npm run release:build -- --release-id=2026.07.25-rc.2+<git-short-sha> --rollback-release-id=<previous-stable-release>
```

发布命令要求工作树干净，生成三个 ZIP、SHA-256 清单、CycloneDX SBOM、发布记录和回滚目标，输出到已忽略的 `artifacts/`。部署、数据库备份与回滚步骤见 [运维手册](docs/operations/release-and-rollback.md)。

## 安全与运营边界

生产自动迁移默认关闭；微信回调、COS 触发、订阅消息、指标和分析都是显式 capability。分析在用户同意前不收集，且不接收照片地址、Token、昵称、自由文本或业务对象 ID。

当前可自动验证的代码状态与必须在真实云/真机完成的项目见 [优化执行状态](docs/operations/optimization-status.md)。

## 关键目录

```text
src/                         小程序源码
server/                      Express/MySQL 后端
cloudfunctions/              COS 事件转发函数
config/                      环境与云基线（不含密钥）
scripts/                     构建、审计、发布和漂移检查
docs/adr/                    架构决策
docs/operations/             发布、恢复、监控、验收与隐私手册
```
