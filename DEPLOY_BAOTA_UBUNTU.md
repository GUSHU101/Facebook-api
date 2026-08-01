# Ubuntu 宝塔面板完整部署指南（Node 项目 + 8443）

本文只讲一种部署方式：**宝塔面板管理 API，PM2 只管理 Worker，Nginx 对外提供 8443 HTTPS**。
不要把本文命令和 Ubuntu 一键安装脚本混用，也不要同时用宝塔和 `ecosystem.config.js` 启动 API，否则会争用 3000 端口。

本文统一使用以下示例；你的值不同才需要替换：

```text
项目目录：/www/wwwroot/Facebook-api-main
宝塔站点标识：Facebook_api_main
公网域名：pixel.atelierwrap.cc
公网 HTTPS：8443
Node 内部端口：3000
数据库名：capi_saas
数据库用户：capi_saas
```

## 1. 最终运行结构

```text
Shopify Customer Events / Shopify Webhook / 管理员
                         │
                         │ https://pixel.atelierwrap.cc:8443
                         ▼
                 宝塔 Nginx（SSL）
                         │
                         │ http://127.0.0.1:3000
                         ▼
              宝塔 Node 项目：src/server.js
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
       PostgreSQL                Redis / BullMQ
             ▲                       │
             └──── PM2：capi-worker ─┘
```

端口规则：

- 公网只开放 `80/tcp` 和 `8443/tcp`。
- Node 保持 `PORT=3000`，不要改成 8443。
- 不要向公网开放 `3000`、`5432`、`6379`。
- Nginx 负责证书和 HTTPS，Node 只接收本机 HTTP。

## 2. 宝塔需要安装的软件

在“软件商店”安装并启动：

- Nginx
- PostgreSQL
- Redis
- Node.js 版本管理器
- Node.js 20 或更高版本
- PM2

宝塔可能把程序安装在自定义目录，例如：

```text
/www/server/nodejs/v20.20.2/bin/node
/www/server/pgsql/bin/psql
/www/server/nginx/sbin/nginx
```

因此 root 终端直接执行 `node` 或 `psql` 可能显示找不到命令。项目脚本会自动扫描这些宝塔目录，**不要再创建 `/tmp` 修复脚本，也不需要手工创建软链接**。

Redis 必须使用不驱逐队列元数据的策略。在宝塔终端执行：

```bash
redis-cli ping
redis-cli CONFIG GET maxmemory-policy
```

正确结果包含：

```text
PONG
noeviction
```

如果不是 `noeviction`：

```bash
redis-cli CONFIG SET maxmemory-policy noeviction
redis-cli CONFIG REWRITE
```

## 3. 下载正式 main 代码

首次部署：

```bash
cd /www/wwwroot
git clone --branch main https://github.com/GUSHU101/Facebook-api.git Facebook-api-main
cd /www/wwwroot/Facebook-api-main
git status -sb
```

应该看到当前分支为 `main`。

已有目录只更新代码：

```bash
cd /www/wwwroot/Facebook-api-main
git pull --ff-only origin main
```

如果 `git pull` 提示本地修改冲突，不要使用 `git reset --hard`。先备份 `.env`，并确认修改来自哪里。

## 4. 创建 PostgreSQL 数据库

推荐直接在宝塔 PostgreSQL 管理页面创建：

```text
数据库名：capi_saas
用户名：capi_saas
密码：使用至少 24 位随机密码
访问权限：仅本机
```

数据库密码建议只用字母、数字、点、下划线、波浪号或连字符，避免连接 URL 需要额外编码。

不要执行：

```bash
sudo -u postgres psql -d capi_saas -f init.sql
```

这样会让表归 `postgres` 所有，导致后台出现 `500 Database permission denied`。项目结构只通过 `npm run migrate` 创建。

如果数据库曾由 `postgres` 创建也不用删除；第 6 节的宝塔更新脚本会自动修复数据库、schema、表和序列所有权，不清空数据。

## 5. 创建并填写 `.env`

```bash
cd /www/wwwroot/Facebook-api-main
cp .env.example .env
```

在服务器终端生成两个不同的密钥：

```bash
openssl rand -hex 32
openssl rand -hex 32
```

第一组填入 `AES_SECRET_KEY`，第二组填入 `INGEST_TOKEN_SECRET`。再生成后台密码：

```bash
openssl rand -hex 16
```

也可以在已经安装 Node.js 的 Windows 本地 CMD 一次生成两组密钥：

```cmd
node -e "const c=require('crypto');console.log('AES_SECRET_KEY='+c.randomBytes(32).toString('hex'));console.log('INGEST_TOKEN_SECRET='+c.randomBytes(32).toString('hex'))"
```

实际输出只复制到服务器 `.env` 和自己的密码管理器，不要发送到聊天或提交到 GitHub。

编辑文件：

```bash
nano /www/wwwroot/Facebook-api-main/.env
```

至少确认以下内容：

```env
NODE_ENV=production
PORT=3000

DATABASE_URL=postgres://capi_saas:这里填写真实数据库密码@127.0.0.1:5432/capi_saas
REDIS_URL=redis://127.0.0.1:6379

FB_API_VERSION=v26.0

AES_SECRET_KEY=第一组64位随机字符
INGEST_TOKEN_SECRET=第二组不同的64位随机字符
INGEST_TOKEN_PREVIOUS_SECRET=

ADMIN_USERNAME=capiadmin
ADMIN_PASSWORD=至少16位的新随机密码
REQUIRE_INGEST_TOKEN=true

SHOPIFY_WEB_ORDER_SOURCES=web
SHOPIFY_APP_SECRET=
SHOPIFY_API_VERSION=2026-07

CORS_ORIGIN=*
TRUST_PROXY_HOPS=1

API_INSTANCES=1
WORKER_INSTANCES=1
```

规则：

- 示例文字不能原样使用。
- `AES_SECRET_KEY` 与 `INGEST_TOKEN_SECRET` 必须不同。
- `.env` 不得提交到 GitHub、发送到聊天或放进截图。
- 正式保存 Meta/Shopify Token 后不能随意更换 `AES_SECRET_KEY`。
- 轮换采集密钥时，旧值临时放入 `INGEST_TOKEN_PREVIOUS_SECRET`；所有店铺更新后再清空。
- 多店铺确实安装同一个 Shopify 应用时，可在 `SHOPIFY_APP_SECRET` 填共享 Client Secret；每店独立应用时保持为空，在项目后台逐店保存。
- `SHOPIFY_WEB_ORDER_SOURCES=web` 不要随意加入 POS、草稿订单等来源。

设置文件权限，使宝塔运行用户可读取、其他用户不可读取：

```bash
chown root:www /www/wwwroot/Facebook-api-main/.env
chmod 640 /www/wwwroot/Facebook-api-main/.env
```

## 6. 首次准备或以后更新：只运行这一条脚本

先在宝塔 Node 项目页面停止 API，然后执行：

```bash
cd /www/wwwroot/Facebook-api-main
sudo bash deploy/update_baota.sh
```

不要在命令前手工添加 Node 或 PostgreSQL 路径。脚本会自动：

1. 找到宝塔安装的最新 Node.js、npm 与 PostgreSQL 工具。
2. 按项目目录所有者确定 Node/PM2 运行用户，避免 root 与 `www` 各启动一个 Worker。
3. 在改动数据库前创建数据库快照和受限权限的 `.env` 备份；数据库归档通过 `pg_restore --list` 校验后才会以正式文件名原子发布，中断或损坏的临时文件会自动清理。
4. 开启维护模式并停止唯一 Worker。
5. 执行 `npm ci --omit=dev`、JavaScript 语法检查和数据库所有权修复。
6. 执行 `npm run migrate` 与 `npm run doctor`。
7. 仅创建或重启 `capi-worker`，不会额外启动与宝塔争用 3000 端口的 API。
8. 执行 `pm2 save` 并在全部步骤成功后退出维护模式。

如果任一步失败，脚本会保留 `.maintenance`，尝试恢复更新前的 Worker，并明确要求修复后重新执行；不要手工删除维护文件后带病运行。

需要进行灾难恢复时，先选择 `backups/capi-db-*.dump` 中经过校验的归档，再明确确认执行：

```bash
cd /www/wwwroot/Facebook-api-main
sudo env CONFIRM=RESTORE bash scripts/restore.sh /绝对路径/capi-db-时间戳-进程号.dump
```

恢复脚本会在进入维护模式前再次检查归档，只停止并重新启动恢复前实际存在的 `capi-api`/`capi-worker` PM2 进程，并在迁移、自检或进程重启失败时保留维护模式。恢复会覆盖数据库对象，必须先确认文件路径和目标数据库正确。

成功结尾应为：

```text
[baota-update] update completed successfully
[baota-update] restart the API project once in Baota
```

任何一步失败，先处理屏幕上第一条 `[baota-update:error]` 或 `FAIL`，不要跳过自检启动生产服务。

## 7. 在宝塔创建 Node 项目

宝塔 → 网站/Node 项目 → 添加 Node 项目：

```text
项目名称：Facebook_api_main
项目目录：/www/wwwroot/Facebook-api-main
Node 版本：20 或更高
运行方式：npm
启动命令：npm start
内部端口：3000
绑定域名：先不依赖宝塔默认 443，后面由 8443 脚本接管
```

如果面板要求“启动文件”而不是命令，填写：

```text
src/server.js
```

不能填写：

```text
src
```

否则会报：

```text
Cannot find module '/www/wwwroot/Facebook-api-main/src'
```

启动 API 后检查：

```bash
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
```

`healthz` 表示进程存活；`readyz` 只有 PostgreSQL 和 Redis 都正常时才返回 HTTP 200。

检查 Worker：

```bash
pm2 status
pm2 logs capi-worker --lines 50 --nostream
```

API 由宝塔管理，Worker 由 PM2 管理。不要再运行：

```bash
pm2 startOrReload ecosystem.config.js
```

否则它会额外启动一个 `capi-api`，与宝塔 API 争用 3000 端口。

## 8. 首次自动配置 8443 HTTPS

先在宝塔创建站点并为当前域名成功签发 SSL 证书。确认文件存在：

```bash
ls -l /www/server/panel/vhost/cert/Facebook_api_main/fullchain.pem
ls -l /www/server/panel/vhost/cert/Facebook_api_main/privkey.pem
```

然后只执行一次：

```bash
cd /www/wwwroot/Facebook-api-main
sudo env DOMAIN=pixel.atelierwrap.cc BT_SITE_NAME=Facebook_api_main PROJECT_DIR=/www/wwwroot/Facebook-api-main PUBLIC_PORT=8443 INTERNAL_PORT=3000 INSTALL_WATCHER=1 bash deploy/configure_baota_nginx.sh
```

这一次需要明确域名，因为 Nginx 必须知道证书对应的主机名。参数会保存到 systemd 服务，普通部署和重启不需要再次输入。

脚本会：

- 备份原 vhost 到 `/www/backup/capi-nginx-vhosts`。
- 生成 `80 → https://域名:8443` 跳转。
- 生成 `8443 SSL → 127.0.0.1:3000` 反向代理。
- 禁止访问 `.env`、`.git`、日志、SQL、备份和 `node_modules`。
- 执行 `nginx -t`，失败则自动恢复旧配置。
- 只验证宝塔的 `/www/server/nginx/sbin/nginx`，不会误用 Ubuntu 的另一套 Nginx。
- 成功后直接向宝塔 Nginx 主进程发送平滑重载信号，避免两套 Nginx 争抢 80/443 端口。
- 安装 systemd 文件监视器；宝塔重写 vhost 后自动恢复 8443。

检查监视器：

```bash
systemctl status capi-baota-nginx-facebook-api-main.path
```

检查 Nginx：

```bash
/www/server/nginx/sbin/nginx -t
curl -I https://pixel.atelierwrap.cc:8443/healthz
```

云服务器安全组和本机防火墙必须开放 TCP 8443：

```bash
ufw allow 8443/tcp
```

不要开放公网 3000。

### 更换域名

1. 修改 DNS。
2. 在宝塔为新域名重新签发证书。
3. 使用新 `DOMAIN` 再执行一次上面的配置脚本。
4. 更新 Shopify Webhook 地址。
5. 从新域名后台重新复制各店铺 Customer Events 代码。

如果宝塔站点标识仍为 `Facebook_api_main`，脚本会更新原监视器。如果重新创建站点并改变了标识，先停用旧监视器：

```bash
systemctl disable --now capi-baota-nginx-facebook-api-main.path
```

## 9. Shopify 自建应用配置

本项目是独立服务器端，不是应用商店上架应用。对每个店铺：

1. 创建并安装你有权管理的 Shopify 自建应用。
2. 至少授予 `read_orders`。
3. 把 Client Secret 填入项目后台该店铺的 Webhook Secret。
4. 把 Admin API access token 填入项目后台该店铺的 Admin API Token。
5. 配置 `orders/paid` webhook：

```text
主题：orders/paid
格式：JSON
地址：https://pixel.atelierwrap.cc:8443/api/webhook/orders/paid
```

可选隐私 webhook：

```text
https://pixel.atelierwrap.cc:8443/api/webhook/customers/data_request
https://pixel.atelierwrap.cc:8443/api/webhook/customers/redact
https://pixel.atelierwrap.cc:8443/api/webhook/shop/redact
```

浏览器端：

1. 打开 `https://pixel.atelierwrap.cc:8443/admin`。
2. 添加 Shopify 店铺。
3. 添加一个或多个 Meta/TikTok 凭证。
4. 建立店铺与像素路由；支持多店铺共用一个像素，也支持一个店铺投递到多个像素。
5. 复制该店铺生成的 Shopify Custom Pixel 代码。
6. 粘贴到 Shopify `Settings → Customer events` 并连接。

同一个 Meta Dataset 不要同时再启用主题 Meta Pixel、GTM Meta 标签或 Shopify Facebook & Instagram 数据共享，否则第三方事件无法保证复用同一 eventID，会造成重复。

## 10. 日常操作：只记住三种情况

### A. 普通重启服务器或 Node

只需在宝塔重启 Node 项目。数据库修复、依赖安装和迁移不会自动执行，也不需要执行。Worker 在正确完成 `pm2 save` 与 PM2 开机设置后自动恢复。

### B. 更新正式 main 代码

先在宝塔停止 API，然后：

```bash
cd /www/wwwroot/Facebook-api-main
git pull --ff-only origin main
sudo bash deploy/update_baota.sh
```

脚本成功后在宝塔启动 API。8443 监视器不需要重新安装。

### C. 更换域名

重新签发证书，再用新 `DOMAIN` 执行一次 `configure_baota_nginx.sh`，然后更新 Shopify Webhook 和 Customer Events 代码。

## 11. 上线验收

```bash
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
curl -I https://pixel.atelierwrap.cc:8443/admin
pm2 status
```

然后逐店在测试事件中检查：

- PageView
- ViewContent
- AddToCart
- InitiateCheckout
- AddPaymentInfo
- 付款成功后的唯一 Purchase

测试完成后清空每个店铺路由上的 Meta Test Event Code。新版测试码默认 30 分钟自动失效，`npm run doctor` 在生产环境发现仍有效的测试路由时会阻止误发布。

## 12. 常见错误对照

### `Cannot find module 'dotenv'`

原因：没有安装生产依赖。停止 API 后执行：

```bash
cd /www/wwwroot/Facebook-api-main
sudo bash deploy/update_baota.sh
```

### `ERROR: node is required`

原因：服务器仍是旧脚本。先拉取最新正式代码：

```bash
cd /www/wwwroot/Facebook-api-main
git pull --ff-only origin main
sudo bash deploy/update_baota.sh
```

最新版会自动寻找 `/www/server/nodejs/*/bin/node`。

### `runuser: failed to execute psql`

同样说明仍是旧脚本。最新版会自动寻找 `/www/server/**/bin/psql` 和 `/usr/lib/postgresql/*/bin/psql`，不需要 `/tmp` 临时脚本。

### `500 Database permission denied`

执行统一更新脚本；它会自动调用 `scripts/repair-db-ownership.sh`：

```bash
sudo bash /www/wwwroot/Facebook-api-main/deploy/update_baota.sh
```

### `Cannot find module .../src`

宝塔启动文件错误。改成 `src/server.js` 或启动命令 `npm start`。

### 公网 502

先检查内部 API：

```bash
curl -v http://127.0.0.1:3000/healthz
```

内部失败就查看宝塔 Node 日志；内部成功再看：

```bash
tail -n 100 /www/wwwlogs/Facebook_api_main.error.log
```

### 8443 连接被拒绝

检查：

```bash
systemctl status capi-baota-nginx-facebook-api-main.path
ss -lntp | grep ':8443'
ufw status
```

同时检查云厂商安全组 TCP 8443。

### `bind() to 0.0.0.0:443 failed` 或提示重复 Nginx

这不是 Node.js 的 `3000` 端口冲突。通常是系统 Nginx 与宝塔 Nginx 同时存在，或旧版配置脚本误向系统 Nginx 发送了重载命令。最新版脚本只操作宝塔 Nginx。

先查看当前 Nginx 主进程和监听者，不要执行 `killall nginx`：

```bash
ps -ef | grep '[n]ginx: master'
sudo ss -ltnp | grep -E ':(80|443|8443)\b'
sudo cat /www/server/nginx/logs/nginx.pid
sudo readlink -f "/proc/$(cat /www/server/nginx/logs/nginx.pid)/exe"
```

最后一条命令正常应输出：

```text
/www/server/nginx/sbin/nginx
```

随后拉取最新版并重新配置：

```bash
cd /www/wwwroot/Facebook-api-main
git pull --ff-only origin main
sudo /www/server/nginx/sbin/nginx -t
sudo env DOMAIN=pixel.atelierwrap.cc BT_SITE_NAME=Facebook_api_main PROJECT_DIR=/www/wwwroot/Facebook-api-main PUBLIC_PORT=8443 INTERNAL_PORT=3000 INSTALL_WATCHER=1 bash deploy/configure_baota_nginx.sh
```

如果 PID 对应的程序不是 `/www/server/nginx/sbin/nginx`，或者显示两个 `nginx: master process`，请先在宝塔“软件商店 → Nginx”中重启宝塔 Nginx；不要继续启动 Ubuntu 的 `nginx.service`。新版脚本会拒绝修改配置并给出明确错误，避免再次争抢端口。

## 13. 停用自动 8443 管理

只有你确定要重新交给宝塔管理端口时才执行：

```bash
systemctl disable --now capi-baota-nginx-facebook-api-main.path
```

停用监视器不会删除当前 Nginx 配置，也不会删除备份。
