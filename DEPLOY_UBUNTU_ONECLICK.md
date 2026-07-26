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
| `CORS_ORIGIN` | `*` | 建议改成逗号分隔的店铺 HTTPS Origin |
| `SHOPIFY_WEB_ORDER_SOURCES` | `web` | 可生成网站 Purchase 的 Shopify 来源白名单 |
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
  CORS_ORIGIN=https://shop-a.example.com,https://shop-b.example.com \
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

升级脚本完成后，进入管理后台，把当前生成的 `shopify-pixel-v10` 代码重新复制到每个 Shopify 店铺。服务器升级不会自动修改 Shopify 后台已有的自定义像素代码。

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

不要在普通升级中使用 `FORCE_ENV_REWRITE=1`。如果确实要重建 `.env`，必须同时显式提供原有或计划使用的 `DB_PASSWORD`、`ADMIN_PASSWORD`、`AES_SECRET_KEY`；错误的 AES 密钥会让历史平台 Token 永久无法解密。

## 7. 安装后配置

打开：

```text
https://capi.example.com:8443/admin
```

然后：

1. 添加 Shopify 店铺及其 webhook secret。
2. 为店铺添加一个或多个 Meta/TikTok 像素路由。
3. 同一个平台凭证可关联多个店铺；一个店铺也可关联多个凭证。
4. 复制生成的 Shopify Custom Pixel 代码。
5. 为每个店铺配置必需的付款 webhook：

```text
主题：orders/paid
地址：https://capi.example.com:8443/api/webhook/orders/paid
格式：JSON
```

浏览器 Purchase 在付款 webhook 验证前只处于 `AWAITING_PAYMENT`，不会提前发送。重复 webhook 使用稳定身份合并，不会重复创建 Purchase。

## 8. 上线验收

```bash
pm2 status
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
curl -I https://capi.example.com:8443/admin
cd /www/wwwroot/capi-saas && npm run doctor
```

平台侧逐店验证 PageView、ViewContent、AddToCart、InitiateCheckout、AddPaymentInfo 和付款后的唯一 Purchase。一个像素故障时，其他已成功路由不应重发。

## 9. 手动备份、恢复和回滚

备份：

```bash
cd /www/wwwroot/capi-saas
npm run backup
```

默认保存到 `/www/wwwroot/capi-saas/backups`。数据库 dump 与 `.env` 副本权限应保持严格，并复制到加密异机存储。

恢复：

```bash
cd /www/wwwroot/capi-saas
CONFIRM=RESTORE bash scripts/restore.sh backups/capi-db-YYYYMMDDTHHMMSSZ.dump
npm run migrate
npm run doctor
pm2 startOrReload ecosystem.config.js --update-env
```

代码回滚时先切换到已验证提交，再执行 `npm ci --omit=dev`、`migrate`、`doctor` 和 PM2 reload。不要在没有数据库备份时回退跨版本数据库结构。

## 10. 故障排查

```bash
pm2 logs capi-api --lines 200 --nostream
pm2 logs capi-worker --lines 200 --nostream
nginx -t
journalctl -u nginx -n 100 --no-pager
journalctl -u postgresql -n 100 --no-pager
journalctl -u redis-server -n 100 --no-pager
redis-cli INFO memory
cd /www/wwwroot/capi-saas && npm run doctor
```

- 后台无法访问：检查域名、证书、安全组、自定义 HTTPS 端口和 Nginx 错误日志。
- `/readyz` 失败：优先检查 PostgreSQL；Redis 异常通常显示 `degraded`，不会阻止持久写入。
- 事件积压：检查 Worker、Redis noeviction、平台限流冷却、数据库连接和最旧到期事件。
- Purchase 缺失：检查 `orders/paid` webhook、HMAC secret、付款状态和 `SHOPIFY_WEB_ORDER_SOURCES`。
- 重复或串店疑虑：运行 `npm run doctor` 并查看后台投递完整性；数据库触发器会拒绝跨店事件/路由组合。
