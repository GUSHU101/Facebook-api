# Ubuntu 一键生产部署指南

本方案不依赖宝塔/aaPanel。安装脚本会在 Ubuntu 上配置 Node.js、PM2、PostgreSQL、Redis、Nginx、数据库迁移、运行自检以及可选的 DNS-01 SSL。

默认架构使用：

- Node 内部端口：`3000`
- 公网 HTTPS 端口：`8443`
- 仓库：`https://github.com/GUSHU101/Facebook-api`
- 分支：`main`

## 1. 前置条件

- Ubuntu 20.04、22.04 或 24.04 VPS，拥有 root/sudo 权限。
- 域名已经解析到服务器。
- 云安全组允许 `8443/tcp`；启用 HTTP 跳转时还需 `80/tcp`。
- 不要向公网开放 `3000`、`5432`、`6379`。
- 自动签发证书需要 DNS 服务商 API 权限；脚本使用 acme.sh DNS-01，不依赖公网 `443`。

## 2. 最小一键安装

不自动签发证书时：

```bash
curl -fsSL https://raw.githubusercontent.com/GUSHU101/Facebook-api/main/deploy/install_ubuntu.sh -o /tmp/capi-install.sh \
  && sudo env \
    REPO_URL=https://github.com/GUSHU101/Facebook-api.git \
    DOMAIN=capi.example.com \
    PUBLIC_PORT=8443 \
    AUTO_SSL=0 \
    bash /tmp/capi-install.sh
```

脚本会生成数据库、后台和 AES 强随机密钥，并在最后显示首次登录信息。立即将这些信息存入密码管理器；尤其不能丢失 `.env` 中的 `AES_SECRET_KEY`。

没有有效证书时，脚本只生成：

```text
/etc/nginx/conf.d/capi-saas-8443.conf.example
```

补齐证书路径并复制为活动配置后执行：

```bash
cp /etc/nginx/conf.d/capi-saas-8443.conf.example /etc/nginx/conf.d/capi-saas.conf
nginx -t
systemctl reload nginx
```

## 3. Cloudflare DNS 自动 SSL

```bash
curl -fsSL https://raw.githubusercontent.com/GUSHU101/Facebook-api/main/deploy/install_ubuntu.sh -o /tmp/capi-install.sh \
  && sudo env \
    REPO_URL=https://github.com/GUSHU101/Facebook-api.git \
    DOMAIN=capi.example.com \
    PUBLIC_PORT=8443 \
    AUTO_SSL=1 \
    AUTO_ENABLE_NGINX=1 \
    ACME_DNS_PROVIDER=dns_cf \
    CF_Token=replace_with_scoped_cloudflare_token \
    CF_Zone_ID=replace_with_cloudflare_zone_id \
    ACME_EMAIL=admin@example.com \
    bash /tmp/capi-install.sh
```

Cloudflare Token 应只拥有目标 Zone 所需的 DNS 编辑权限。不要把 Token 写入 shell 历史、截图或仓库；更安全的做法是先在 root shell 临时导出变量，执行后立即清除。

阿里云 DNS 使用 `ACME_DNS_PROVIDER=dns_ali`，并提供 acme.sh 所需的 `Ali_Key` 和 `Ali_Secret`。

## 4. 常用安装参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `APP_DIR` | `/www/wwwroot/capi-saas` | 必须是安全的绝对目录 |
| `APP_USER` | `capi-saas` | API、Worker、Git 与备份使用的非 root 系统用户 |
| `REPO_URL` | 无 | 必填 Git 仓库地址 |
| `BRANCH` | `main` | 部署分支 |
| `INTERNAL_PORT` | `3000` | Node 内部端口 |
| `PUBLIC_PORT` | `8443` | Nginx 公网 HTTPS 端口 |
| `DOMAIN` | 无 | HTTPS 域名 |
| `DB_NAME` / `DB_USER` | `capi_saas` / `capi_user` | PostgreSQL 标识符 |
| `DB_PASSWORD` | 自动生成 | 只允许字母、数字、`.`、`_`、`~`、`-` |
| `ADMIN_USERNAME` | `admin` | 后台账号 |
| `ADMIN_PASSWORD` | 自动生成 | 后台强密码；自定义值不能含空白、`#` 或引号 |
| `AES_SECRET_KEY` | 自动生成 | 至少 32 字符且不能含空白、`#` 或引号，永久保留 |
| `INGEST_TOKEN_SECRET` | 自动生成 | 独立的店铺采集 Token 密钥，永久保留 |
| `CORS_ORIGIN` | `*` | 建议保持 `*` 以兼容 Shopify 客户事件沙箱；仅采集接口启用 CORS且不使用 Cookie 凭据 |
| `SHOPIFY_WEB_ORDER_SOURCES` | `web` | 可生成网站 Purchase 的 Shopify 来源白名单 |
| `SHOPIFY_APP_SECRET` | 空 | 同一个自建应用跨多个店铺时可选的共享 Client Secret；每店独立应用时留空 |
| `DB_POOL_MAX` | `20` | 每个 API/Worker 进程的连接池上限 |
| `API_INSTANCES` | `1` | API 进程数 |
| `WORKER_INSTANCES` | `1` | Worker 进程数 |
| `AUTO_SSL` | `0` | 是否用 DNS-01 自动签发证书 |
| `AUTO_ENABLE_NGINX` | `1` | 证书存在时自动启用 Nginx 配置 |
| `REDIRECT_HTTP` | `1` | 80 跳转到自定义 HTTPS 端口 |
| `ENABLE_UFW` | `1` | UFW 已启用时自动放行端口 |
| `SKIP_APT` | `0` | 已预装全部依赖时才可设为 `1` |
| `FORCE_ENV_REWRITE` | `0` | 危险选项，默认保护现有 `.env` |

生产示例：

```bash
sudo env \
  REPO_URL=https://github.com/GUSHU101/Facebook-api.git \
  DOMAIN=capi.example.com \
  PUBLIC_PORT=8443 \
  CORS_ORIGIN='*' \
  SHOPIFY_WEB_ORDER_SOURCES=web \
  DB_POOL_MAX=20 \
  API_INSTANCES=2 \
  WORKER_INSTANCES=2 \
  AUTO_SSL=1 \
  ACME_DNS_PROVIDER=dns_cf \
  CF_Token=replace_me \
  CF_Zone_ID=replace_me \
  bash /tmp/capi-install.sh
```

连接预算近似为 `(API_INSTANCES + WORKER_INSTANCES) × DB_POOL_MAX`。扩容前给 PostgreSQL 管理、迁移和监控连接预留空间。

## 5. 脚本执行内容

安装器会按顺序：

1. 验证 root、Ubuntu、端口、目录、域名和容量参数。
2. 安装缺失的 Node.js 20+、PM2、PostgreSQL、Redis、Nginx 等组件。
3. 启动系统服务并把 Redis 设置为 `maxmemory-policy=noeviction`。
4. 克隆仓库；升级现有安装时先备份数据库和 `.env`，再执行 `git pull --ff-only`。
5. 首次安装时创建数据库用户和数据库，并生成权限为 `600` 的 `.env`。
6. 运行 `npm ci --omit=dev`、语法检查、数据库迁移和 `npm run doctor`。
7. 使用 PM2 `startOrReload` 启动 API/Worker。
8. 轮询 `/healthz` 和 `/readyz`，未就绪时输出日志并中止。
9. 可选签发 DNS-01 SSL、生成安全的非 443 Nginx 配置并重载。

## 6. 重复执行和升级安全

升级脚本完成后，进入管理后台，把当前生成的 `shopify-pixel-v11` 代码重新复制到每个 Shopify 店铺。服务器升级不会自动修改 Shopify 后台已有的自定义像素代码。

安装器可以重复运行。只要 `${APP_DIR}/.env` 已存在且 `FORCE_ENV_REWRITE` 不是 `1`，脚本会：

- 保留数据库密码、管理员密码和 AES 密钥。
- 升级前自动执行数据库与 `.env` 备份。
- 只更新代码、依赖、数据库结构和 PM2 进程。

推荐升级方式是重新下载最新脚本并使用与首次部署相同的参数：

```bash
curl -fsSL https://raw.githubusercontent.com/GUSHU101/Facebook-api/main/deploy/install_ubuntu.sh -o /tmp/capi-install.sh
sudo env \
  REPO_URL=https://github.com/GUSHU101/Facebook-api.git \
  DOMAIN=capi.example.com \
  PUBLIC_PORT=8443 \
  AUTO_SSL=1 \
  ACME_DNS_PROVIDER=dns_cf \
  CF_Token=replace_me \
  CF_Zone_ID=replace_me \
  bash /tmp/capi-install.sh
```

不要在普通升级中使用 `FORCE_ENV_REWRITE=1`。如果确实要重建 `.env`，必须同时显式提供原有或计划使用的 `DB_PASSWORD`、`ADMIN_PASSWORD`、`AES_SECRET_KEY`、`INGEST_TOKEN_SECRET`；错误的 AES 密钥会让历史平台 Token 无法解密，错误的采集密钥会让尚未更新的 Shopify 像素返回 401。

## 7. 安装后配置

打开：

```text
https://capi.example.com:8443/admin
```

然后：

1. 在每个 Shopify 店铺创建并安装自建未上架应用，至少授予 `read_orders`；把 Client Secret 和 Admin API access token 填入本项目店铺配置。
2. 为店铺添加一个或多个 Meta/TikTok 像素路由。
3. 同一个平台凭证可关联多个店铺；一个店铺也可关联多个凭证。
4. 将生成的 Shopify Custom Pixel 代码粘贴到 `Settings → Customer events`；浏览器事件由这里采集，不依赖主题脚本或 OAuth 安装页。
5. 为每个店铺配置必需的付款 webhook：

```text
主题：orders/paid
地址：https://capi.example.com:8443/api/webhook/orders/paid
格式：JSON
```

浏览器 Purchase 在付款 webhook 验证前只处于 `AWAITING_PAYMENT`，不会提前发送。重复 webhook 使用稳定身份合并，不会重复创建 Purchase。

同一个自建应用跨多个店铺时，可以在首次安装命令中传入 `SHOPIFY_APP_SECRET=...`；每店独立创建应用时不要设置，后台逐店保存各自 Secret。若配置 Shopify 隐私 Webhook，可使用以下地址：

```text
https://capi.example.com:8443/api/webhook/customers/data_request
https://capi.example.com:8443/api/webhook/customers/redact
https://capi.example.com:8443/api/webhook/shop/redact
```

数据访问请求会出现在后台“Shopify 隐私请求”，下载并安全交付报告后确认完成即可清除暂存数据；删除类请求自动处理。

## 8. 上线验收

```bash
sudo -u capi-saas env HOME=/var/lib/capi-saas pm2 status
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
curl -I https://capi.example.com:8443/admin
sudo -u capi-saas env HOME=/var/lib/capi-saas npm --prefix /www/wwwroot/capi-saas run doctor
```

平台侧逐店验证 PageView、ViewContent、AddToCart、InitiateCheckout、AddPaymentInfo 和付款后的唯一 Purchase。一个像素故障时，其他已成功路由不应重发。

后台会显示数据库总量、事件账本和 Webhook 收件箱占用。生产环境还应为 PostgreSQL 数据目录配置磁盘告警；等待投递的 `PENDING` 不会被系统为腾空间而静默删除。

## 9. 手动备份、恢复和回滚

备份：

```bash
sudo -u capi-saas env HOME=/var/lib/capi-saas npm --prefix /www/wwwroot/capi-saas run backup
```

默认保存到 `/www/wwwroot/capi-saas/backups`。数据库 dump 与 `.env` 副本权限应保持严格，并复制到加密异机存储。默认保留 30 天（`BACKUP_RETENTION_DAYS=30`），只自动删除该目录中符合项目备份命名规则的过期文件。

恢复：

```bash
cd /www/wwwroot/capi-saas
sudo CONFIRM=RESTORE bash scripts/restore.sh backups/capi-db-YYYYMMDDTHHMMSSZ.dump
```

恢复脚本会进入维护态并停止 API/Worker，在单一数据库事务内恢复，然后执行迁移、凭据解密检查和运行时诊断；全部通过才重新加载 PM2。失败时维护态与停机状态会保留，避免未验证的数据被继续写入。

代码回滚时先切换到已验证提交，再执行 `npm ci --omit=dev`、`migrate`、`doctor` 和 PM2 reload。不要在没有数据库备份时回退跨版本数据库结构。

## 10. 故障排查

```bash
sudo -u capi-saas env HOME=/var/lib/capi-saas pm2 logs capi-api --lines 200 --nostream
sudo -u capi-saas env HOME=/var/lib/capi-saas pm2 logs capi-worker --lines 200 --nostream
nginx -t
journalctl -u nginx -n 100 --no-pager
journalctl -u postgresql -n 100 --no-pager
journalctl -u redis-server -n 100 --no-pager
redis-cli INFO memory
sudo -u capi-saas env HOME=/var/lib/capi-saas npm --prefix /www/wwwroot/capi-saas run doctor
```

- 后台无法访问：检查域名、证书、安全组、自定义 HTTPS 端口和 Nginx 错误日志。
- `/readyz` 失败：同时检查 PostgreSQL 与 Redis。Redis 异常时会返回 HTTP 503 和 `degraded`，表示持久写入能力仍可能存在、但即时队列派发尚未完全就绪；`/healthz` 用于单独确认进程存活。
- 事件积压：检查 Worker、Redis noeviction、平台限流冷却、数据库连接和最旧到期事件。
- Purchase 缺失：检查 `orders/paid` webhook、HMAC secret、付款状态和 `SHOPIFY_WEB_ORDER_SOURCES`。
- 重复或串店疑虑：运行 `npm run doctor` 并查看后台投递完整性；数据库触发器会拒绝跨店事件/路由组合。
