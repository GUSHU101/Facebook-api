# Ubuntu + 宝塔面板生产部署指南

本文用于在 Ubuntu VPS 上通过宝塔/aaPanel 部署本项目。生产架构为：

```text
Shopify / 管理员
        │ HTTPS :8443
        ▼
宝塔 Nginx
        │ http://127.0.0.1:3000
        ▼
PM2: capi-api + capi-worker
        ├── PostgreSQL：事件、路由、去重和投递账本
        └── Redis/BullMQ：异步调度、租约和限流状态
```

示例使用公网 HTTPS `8443`，不占用 `443`。如果你使用标准 `443`，需同步修改 Nginx、云安全组和所有 Shopify URL。

## 1. 部署前检查

- Ubuntu 20.04、22.04 或 24.04，建议至少 2 核 CPU、4 GB 内存。
- 域名 A/AAAA 记录已经指向服务器。
- 云安全组放行 `80/tcp` 和 `8443/tcp`；不要公开 PostgreSQL `5432`、Redis `6379` 和 Node `3000`。
- 宝塔安装 Nginx、PostgreSQL、Redis、Node.js 20/22/24 和 PM2。
- Redis `maxmemory-policy` 必须为 `noeviction`。
- 服务器时间和时区同步正常；事件时间统一由应用按 UTC 处理。

检查版本：

```bash
node --version
npm --version
pm2 --version
psql --version
redis-cli ping
redis-cli CONFIG GET maxmemory-policy
```

如果 Redis 策略不是 `noeviction`：

```bash
redis-cli CONFIG SET maxmemory-policy noeviction
redis-cli CONFIG REWRITE
```

## 2. 下载项目

推荐目录为 `/www/wwwroot/capi-saas`：

```bash
cd /www/wwwroot
git clone https://github.com/GUSHU101/Facebook-api.git capi-saas
cd /www/wwwroot/capi-saas
git branch --show-current
```

只提交编译后的后台 CSS/Vue 资源，不需要在生产服务器安装开发依赖：

```bash
npm ci --omit=dev
npm run check
```

## 3. 创建 PostgreSQL 数据库

新安装可进入 PostgreSQL：

```bash
sudo -u postgres psql
```

执行以下 SQL，并替换强密码：

```sql
CREATE USER capi_user WITH PASSWORD 'replace_with_a_strong_database_password';
CREATE DATABASE capi_saas OWNER capi_user;
GRANT ALL PRIVILEGES ON DATABASE capi_saas TO capi_user;
\q
```

如果数据库或用户已经存在，不要重复创建，也不要随意更换数据库密码。旧版本升级时保留原数据库和 `.env`。

## 4. 配置 `.env`

```bash
cd /www/wwwroot/capi-saas
cp .env.example .env
chmod 600 .env
nano .env
```

必须修改：

```env
PORT=3000
DATABASE_URL=postgres://capi_user:replace_with_a_strong_database_password@127.0.0.1:5432/capi_saas
REDIS_URL=redis://127.0.0.1:6379

AES_SECRET_KEY=replace_with_at_least_32_random_characters
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace_with_a_strong_admin_password
REQUIRE_INGEST_TOKEN=true

# 只有这些 Shopify source_name 可生成网站 Purchase。
SHOPIFY_WEB_ORDER_SOURCES=web

# 建议填写实际店铺来源；多个来源用英文逗号分隔且不要带路径。
CORS_ORIGIN=https://shop-a.example.com,https://shop-b.example.com
TRUST_PROXY_HOPS=1
```

重要规则：

- `AES_SECRET_KEY` 上线后必须永久保存。更换它会导致已保存的平台 Token 无法解密。
- `SHOPIFY_WEB_ORDER_SOURCES=web` 是安全默认值。只有确认某个 Headless/自定义销售渠道属于网站流量时，才加入对应 `source_name`。
- 不建议把 `CORS_ORIGIN` 长期设为 `*`。
- `PIXEL_RATE_LIMIT_PER_MINUTE=0` 表示不在应用层拒绝合法高峰流量；滥用防护应放在 CDN/WAF。
- 不要把 `.env` 上传到 GitHub、网盘或工单。

### 多实例容量

PostgreSQL 最大连接数近似为：

```text
(API_INSTANCES + WORKER_INSTANCES) × DB_POOL_MAX
```

默认 `1 + 1` 个实例、每实例连接池 `20`，理论上最多约 40 条应用连接。扩容前必须给 PostgreSQL 管理连接、迁移和监控预留余量。

## 5. 迁移和自检

```bash
cd /www/wwwroot/capi-saas
npm run migrate
npm run doctor
```

`migrate` 可重复运行：它不会清空店铺、像素、事件或投递历史；大型索引使用在线创建方式。`doctor` 会检查数据库结构、跨店路由一致性、事件汇总一致性、Redis 策略、连接权限和超时配置。

任何 `FAIL` 都应在启动前处理，不要跳过。

## 6. 使用 PM2 启动

```bash
cd /www/wwwroot/capi-saas
pm2 startOrReload ecosystem.config.js --update-env
pm2 save
pm2 status
pm2 startup
```

`pm2 startup` 会输出一条需要以 root 执行的命令；执行后再次运行 `pm2 save`。

进程职责：

- `capi-api`：接收事件、验证 Shopify webhook、管理后台、出箱救援和定时维护。
- `capi-worker`：按店铺与凭证租约投递 Meta CAPI/TikTok Events API。

本机检查：

```bash
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
```

`/readyz` 在 PostgreSQL 可写但 Redis 暂时异常时会返回 `status=degraded`；事件仍持久化到 PostgreSQL，Redis 恢复后自动继续派发。

## 7. 配置宝塔 Nginx 和非 443 HTTPS

仓库提供完整模板：[deploy/baota-nginx-non443.conf.template](deploy/baota-nginx-non443.conf.template)。复制到宝塔“网站 → 配置文件”，替换：

- `__DOMAIN__`：例如 `capi.example.com`
- `__PROJECT_DIR__`：`/www/wwwroot/capi-saas`
- `__BT_SITE_NAME__`：宝塔站点标识/证书目录名
- `__PUBLIC_PORT__`：`8443`
- `__INTERNAL_PORT__`：`3000`

必须确认：

- 配置中没有 `listen 443 ssl` 或 `listen 443 quic`。
- SSL 证书与私钥路径真实存在，建议用 DNS-01 方式签发。
- `proxy_pass` 指向 `127.0.0.1:3000`，不要指向公网 IP。
- `X-Forwarded-Proto` 为 `https`，`X-Forwarded-Port` 为 `8443`。
- Nginx 已阻止访问 `.env`、`.git`、备份、日志、SQL 和 `node_modules`。

保存前检查并平滑重载：

```bash
nginx -t
systemctl reload nginx
curl -I https://capi.example.com:8443/admin
```

如果使用 Cloudflare，需确保所选代理模式支持自定义 HTTPS 端口；否则先使用 DNS only 验证源站。

## 8. 后台配置多店铺和多像素

打开：

```text
https://capi.example.com:8443/admin
```

推荐顺序：

1. 添加 Shopify 店铺，域名使用 `store.myshopify.com`，保存 webhook secret 和独立采集 Token。
2. 添加 Meta Dataset/Pixel 或 TikTok Pixel 凭证。
3. 在路由选择中把一个凭证关联到多个店铺，或把一个店铺关联到多个凭证。
4. 复制该店铺生成的 Shopify Custom Pixel 代码到 `Settings → Customer events`。
5. 测试阶段设置平台 Test Event Code，验证后再清空。

本地数据库始终按认证后的 `shop_id` 隔离事件、别名、重试和投递账本。多个店铺共用同一个外部 Pixel 时，平台侧数据会按你的配置聚合，但本系统不会把店铺事件路由串到未关联的像素。

## 9. 配置 Shopify 付款 webhook

每个店铺都必须配置：

```text
Topic: orders/paid
URL: https://capi.example.com:8443/api/webhook/orders/paid
Format: JSON
```

后台填写的 Shopify Webhook Secret 必须与签名 webhook 的 App Client Secret 一致。服务端验证 `X-Shopify-Hmac-Sha256`，使用 `X-Shopify-Webhook-Id` 防重复。

浏览器 `checkout_completed` 只创建 `AWAITING_PAYMENT` 候选；只有 HMAC 验证成功的 `orders/paid` 才能解锁 Purchase。这样不会把未付款、延迟付款或失败付款误判为成功购买。

## 10. 上线验收

按店铺逐一完成：

- `PageView`、`ViewContent`、`AddToCart`、`InitiateCheckout`、`AddPaymentInfo` 可见。
- 支付前没有 Purchase；付款后只有一个相同 `event_id` 的 Purchase。
- Purchase 包含正确 `value`、`currency`、`content_ids`、`contents` 和 `order_id`。
- `_fbp`/`_ttp` 只在真实 Cookie 存在时发送，`_fbc` 只来自真实 `fbclid`。
- 一个店铺绑定多个像素时，每条路由都有独立成功/失败状态。
- 多店铺共用像素时，管理后台的事件和投递诊断仍按店铺隔离。
- `/readyz`、PM2 状态、Worker 日志和后台“投递完整性”均正常。

## 11. 安全升级、备份和回滚

升级前：

```bash
cd /www/wwwroot/capi-saas
npm run backup
git status --short
git pull --ff-only origin main
npm ci --omit=dev
npm run check
npm test
npm run migrate
npm run doctor
pm2 startOrReload ecosystem.config.js --update-env
pm2 save
```

不要覆盖已有 `.env`。备份目录默认为 `/www/wwwroot/capi-saas/backups`，其中的 `.env` 副本含解密密钥，权限必须保持 `600/700`，并应复制到受保护的异机存储。

数据库回滚：

```bash
cd /www/wwwroot/capi-saas
CONFIRM=RESTORE bash scripts/restore.sh backups/capi-db-YYYYMMDDTHHMMSSZ.dump
npm run migrate
npm run doctor
pm2 startOrReload ecosystem.config.js --update-env
```

## 12. 故障排查

```bash
pm2 status
pm2 logs capi-api --lines 200 --nostream
pm2 logs capi-worker --lines 200 --nostream
npm run doctor
redis-cli INFO memory
redis-cli INFO clients
sudo -u postgres psql -d capi_saas -c 'select now();'
tail -n 200 /www/wwwlogs/你的站点.error.log
```

- 后台打不开：先检查 Nginx `nginx -t`、安全组端口、证书和 `capi-api`。
- 事件已接收但未发送：检查 `capi-worker`、Redis、平台凭证冷却和后台最旧到期事件。
- Purchase 不出现：检查 `orders/paid` webhook 响应、HMAC secret、订单来源白名单及付款状态。
- 部分像素失败：只修复对应路由凭证；成功路由不会被重发。
- 数据增长：检查保留周期、autovacuum、数据库空间和 Worker 消费速率，不要直接删除 `PENDING` 数据。
