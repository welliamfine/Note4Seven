# 生产后端

本目录是“记录我的一辈子”小程序的生产后端，目标平台为微信云托管。技术栈为 Node.js、Express、MySQL 8、私有对象存储和数据万象。

## 已实现

- 微信云托管可信身份登录，并签发自有 Bearer 会话
- 模块、成员、记录、回应、邀请、加入审批、补卡、提醒、通知和回收站 API
- MySQL 迁移、事务、唯一约束、行锁、接口幂等和并发人数限制
- 私有文件上传校验、短期签名地址、图片压缩、缩略图和通用抠图
- 文字与图片内容安全检查，以及图片异步审核回调
- 每分钟提醒、每日上海时区快照、审批过期、七天永久删除和账号注销任务
- 订阅消息、小程序码、失败重试、任务抢占和日志脱敏

服务监听 `8080` 端口，健康检查地址为 `GET /health`，业务接口前缀为 `/api/v1`。

## 当前 prod 环境

- AppID：`wxa64faf2abab7e388`
- 环境 ID：`prod-d5g4tznceeecbaf39`
- 服务名：`express-bonj`
- 对象存储桶：`7072-prod-d5g4tznceeecbaf39-1346314817`
- 地域：`ap-shanghai`
- 订阅消息模板：`fTNBBNLftez9i-ZcduqQ98r3az3IE2IZOWGLqnyUT5s`

## 首次部署

1. 打开微信云托管，切换到 `prod`，进入服务 `express-bonj`。
2. 点击“部署发布”中的“发布”，选择“本地代码/代码包”方式。
3. 代码目录选择本机的 `E:\hqw\workspace\打卡小程序\server`，Dockerfile 路径填 `Dockerfile`，监听端口填 `8080`。
4. 建议首发规格至少 `0.5 核 / 1 GB`，最小实例数必须为 `1`，最大实例数先设 `3`。最小实例不能为 `0`，否则提醒和每日任务在缩容后不会执行。
5. 在服务环境变量中填写下一节的生产配置。数据库连接优先使用平台自动注入的 `MYSQL_*`；如果当前控制台不注入，就填写页面显示的 `DB_*` 连接信息。
6. 健康检查路径填 `/health`，发布后必须返回 `status: ok`。
7. 首次部署完成后，检查运行日志中是否出现 `server started`，并确认没有数据库迁移错误。

## 生产环境变量

以下项目可以直接填写：

```dotenv
NODE_ENV=production
PORT=8080
APP_ID=wxa64faf2abab7e388
WECHAT_CLOUD_ENV_ID=prod-d5g4tznceeecbaf39
WECHAT_CLOUD_SERVICE=express-bonj
MYSQL_DATABASE=record_life
OBJECT_BUCKET=7072-prod-d5g4tznceeecbaf39-1346314817
COS_REGION=ap-shanghai
SUBSCRIBE_TEMPLATE_ID=fTNBBNLftez9i-ZcduqQ98r3az3IE2IZOWGLqnyUT5s
AUTO_MIGRATE=true
ALLOW_DEV_AUTH=false
LOG_LEVEL=info
WECHAT_OPEN_API_BASE=http://api.weixin.qq.com
PRIVACY_VERSION=1.0.0
```

订阅消息字段已根据模板卡片确认：活动名称、提醒时间、打卡状态依次对应：

```dotenv
SUBSCRIBE_THING_KEY=thing1
SUBSCRIBE_TIME_KEY=time2
SUBSCRIBE_NOTE_KEY=thing3
```

如果平台没有自动注入数据库变量，再额外填写以下一组；值只能从微信云托管 MySQL 的连接信息页面取得，不能提交到仓库：

```dotenv
DB_HOST=<数据库内网地址>
DB_PORT=3306
DB_USER=<数据库用户名>
DB_PASSWORD=<数据库密码>
DB_NAME=record_life
```

后端同时兼容旧版 `MYSQL_ADDRESS/MYSQL_USERNAME/MYSQL_PASSWORD/MYSQL_DATABASE` 和新版 `DB_HOST/DB_USER/DB_PASSWORD/DB_NAME`。

## 已完成的控制台配置

1. 云调用已开启。
2. 已配置 `security.mediaCheckAsync`、`security.msgSecCheck`、`subscribeMessage.send`、`wxacode.getUnlimited` 和 `/_/cos/getauth`。
3. 订阅模板和 `thing1/time2/thing3` 字段已确认。

## 部署后再完成

1. 发布成功并取得服务公网域名后，在微信公众平台配置消息推送：URL 为 `https://<服务域名>/wechat/events`，EncodingAESKey 暂不填写，消息加密方式选“明文模式”，数据格式选 XML。
2. 在服务环境变量新增 `WECHAT_CALLBACK_TOKEN`。它必须是自行生成的至少 16 位随机字符串，并与消息推送页面的 Token 完全相同。不要把它发到聊天或提交到仓库。

小程序仅通过 `wx.cloud.callContainer` 调用业务接口，不需要把 AppSecret 放入后端或小程序。所有数据库密码、云密钥和回调 Token 都只保存在云托管环境变量中。

由于图片审核结果需要微信服务器回调，服务必须保留公网访问；业务登录会同时校验云托管网关注入的 OpenID、AppID、环境 ID 和调用来源。不要通过普通 `wx.request` 访问业务接口。

## 本地验证

```powershell
npm install
npm run verify
```

本地数据库连接写入 `server/.env`；该文件已被忽略。迁移默认随实例启动自动执行，并通过 MySQL 命名锁避免多个实例重复迁移。
