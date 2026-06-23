# Ubuntu + 宝塔面板部署指南

目标：在私有 VPS 上运行 API、Worker、PostgreSQL、Redis，并通过宝塔 Nginx 反向代理 HTTPS 域名。

本部署方案避免使用公网 `443` 端口。示例使用公网 `8443` 提供 HTTPS，Node.js 只在服务器内部使用 `3000`。

宝塔面板不是必需依赖；如果你想使用纯 Ubuntu 一键部署，请看 `DEPLOY_UBUNTU_ONECLICK.md`。

## 1. 宝塔软件

建议安装：

- Nginx
- PostgreSQL
- Redis
- Node.js 20 或 22
- PM2 管理器

## 2. 上传项目

推荐目录：

```bash
/www/wwwroot/capi-saas
```

进入目录后安装依赖：

```bash
npm install --omit=dev
npm run check
```

## 3. 配置环境变量

复制示例：

```bash
cp .env.example .env
```

编辑 `.env`，至少修改：

- `DATABASE_URL`
- `REDIS_URL`
- `AES_SECRET_KEY`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

`AES_SECRET_KEY` 一旦上线后不要更换，否则已保存的 Meta access token 无法解密。

## 4. 初始化 PostgreSQL

在宝塔 PostgreSQL 中创建数据库和用户，然后执行：

```bash
psql "$DATABASE_URL" -f init.sql
```

如果宝塔终端没有 `psql`，也可以在 PostgreSQL 管理工具里导入 `init.sql`。

已有旧版本数据库时，更新代码后执行迁移：

```bash
npm run migrate
```

启动前运行自检：

```bash
npm run doctor
```

自检会确认环境变量、PostgreSQL 表字段、Redis 连接和队列配置是否可用。

## 5. 使用 PM2 启动

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 status
```

项目会启动两个进程：

- `capi-api`：Express API、后台面板、定时出箱任务
- `capi-worker`：BullMQ Worker，负责发送 Meta CAPI

健康检查：

```bash
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/readyz
```

`/healthz` 只确认进程存活，`/readyz` 会检查 PostgreSQL 和 Redis。

## 6. 宝塔 Nginx 非 443 HTTPS 反向代理

创建站点，例如：

```text
capi.example.com
```

不要让站点占用公网 `443`。建议在宝塔站点配置里删除或停用默认 `listen 443 ssl`，改用 `8443 ssl`。反向代理转发到：

```text
http://127.0.0.1:3000
```

推荐 Nginx 片段：

```nginx
listen 8443 ssl http2;
server_name capi.example.com;

ssl_certificate     /www/server/panel/vhost/cert/capi.example.com/fullchain.pem;
ssl_certificate_key /www/server/panel/vhost/cert/capi.example.com/privkey.pem;

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

生产环境必须使用 HTTPS，因为 Shopify Customer Events 和 Meta Pixel 都依赖安全上下文。可以使用非标准 HTTPS 端口，例如：

```text
https://capi.example.com:8443
```

服务器安全组和防火墙需要放行 `8443`，不需要放行 `443`。

证书建议使用 DNS 验证签发，避免面板为了 HTTP/HTTPS 文件验证临时依赖 `443`。如果宝塔当前证书工具只能使用端口验证，可以先在域名服务商或 acme.sh 使用 DNS API 签发证书，再把证书路径填入 Nginx。

## 7. 后台配置

访问：

```text
https://capi.example.com:8443/admin
```

操作顺序：

1. 添加 Shopify 店铺，域名格式为 `your-store.myshopify.com`。
2. 添加平台路由：
   - Facebook / Meta：填写 Pixel / Dataset ID 和 System User Access Token。
   - TikTok：填写 TikTok Pixel Code 和 Events API Access Token。
3. 测试阶段填入对应平台的 Test Event Code。
4. 打开“追踪代码”，填入店铺域名、Meta Pixel ID、可选 TikTok Pixel ID。
5. 确认 API 地址显示为 `https://capi.example.com:8443`。
6. 将生成代码粘贴到 Shopify 后台：Settings -> Customer events -> Add custom pixel。

## 8. Meta 验证

在 Meta Events Manager 中确认：

- Browser 和 Server 事件同时出现。
- 同一个事件的 browser `eventID` 与 server `event_id` 一致。
- `Purchase` 包含 `value`、`currency`、`content_ids`、`contents`、`order_id`。
- `_fbp`、`_fbc`、IP、User-Agent、email、phone、name、address、external_id 能尽量进入事件匹配。
- TikTok Browser 和 Events API 事件使用相同 `event_id`，`Purchase` 在 TikTok 中映射为 `CompletePayment`。

## 9. Shopify Purchase Webhook 兜底

Shopify Web Pixel 的 `checkout_completed` 依赖页面触发。为了降低漏单风险，建议再配置订单付款 webhook：

```text
Topic: orders/paid
URL: https://capi.example.com:8443/api/webhook/orders/paid
Format: JSON
```

后台添加店铺时填写的 `Shopify Webhook Secret` 必须与 Shopify 用于签名 webhook 的 app client secret 一致。服务端会校验 `X-Shopify-Hmac-Sha256`，并使用 `X-Shopify-Webhook-Id` 防止重复投递。

## 10. Shopify 权限提醒

Shopify App Web Pixel 的客户 PII 字段会受受保护客户数据权限影响。邮箱、电话、姓名、地址可能为 `null`，这属于平台限制，不是服务故障。要提高 EMQ，需要为正式 App 申请对应的受保护客户数据权限。

## 11. 运维命令

```bash
pm2 logs capi-api
pm2 logs capi-worker
pm2 restart capi-api
pm2 restart capi-worker
pm2 monit
```

更新代码后：

```bash
npm install --omit=dev
npm run check
npm run migrate
npm run doctor
pm2 restart ecosystem.config.js
```
