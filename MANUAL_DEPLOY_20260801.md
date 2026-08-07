# Facebook CAPI v17.0 手动部署与验收清单

> **历史归档，请勿用于当前生产更新。** 本文记录 2026-08-01 的 v17 手工修复流程，目录、像素版本和命令已经过时。当前宝塔日常更新请使用 [宝塔日常更新教程](BAOTA_UPDATE_GUIDE.md)；首次安装请使用 [宝塔完整部署指南](DEPLOY_BAOTA_UBUNTU.md)。不要把本文的旧目录或覆盖修复包步骤与当前正式 `main` 混用。

本清单针对当前宝塔生产目录 `/www/wwwroot/FacebookAPI`。本地修复包不会包含 `.env`、数据库、访问令牌、客户数据或宝塔凭证。

## 已确认的生产问题

1. 生产快照中共有 1,145 条事件、1,145 条成功投递；每条事件所在批次都有 Meta API 正数接收回执。旧版把同一批次的 `events_received` 重复保存到每条事件，不能相加为事件总量；新版改为逐事件 `accepted_event=true` 并保留对应 `fbtrace_id`，避免虚高统计。
2. 10 条 `orders/paid` Webhook 中有 9 条成功；ATELIERWRAP 有 1 条记录停在 `PROCESSING`，累计尝试 5,727 次，未生成对应 Purchase。这是唯一有数据库证据的真实 Purchase 漏报。
3. 两个 Shopify 店铺共用同一个 Meta Pixel/数据集；这是有意的信号聚合模式，因此 Meta 官方报表、诊断、受众和学习结果会是两个店铺的合并视图，本项目后台必须继续保留逐店对账视图。
4. 生产 Shopify Custom Pixel 仍为 `shopify-pixel-v14`；它没有采集 `payment_info_submitted`，因此历史 `AddPaymentInfo` 为 0。
5. `pixel.atelierwrap.cc` 的 HTTPS 证书与域名不匹配。Customer Events 浏览器请求可能在到达 API 前就被浏览器拒绝。
6. 服务器上的 PM2 曾指向旧目录 `/www/wwwroot/Facebook-api-main/src`，不能证明正确目录中的 Worker 持续在线。
7. Shopify 与数据库对账存在时区口径差异。示例：UTC 7 月 31 日 01:54 对应店铺时区 7 月 30 日 18:54。

## 本地修复内容

- Webhook 处理增加 45 秒硬超时，避免单条任务永久占用租约。
- 超过最大尝试次数的过期 `PROCESSING` 行会被隔离为 `FAILED_PERMANENT`，不再无限重领。
- 领取 SQL 只允许 `attempt_count < SHOPIFY_WEBHOOK_INBOX_MAX_ATTEMPTS` 的记录。
- v17 Customer Events 像素包含 `payment_info_submitted -> AddPaymentInfo`，并按 Shopify 官方 Pixel Privacy 接口动态响应授权变化。
- 结账中间阶段使用动作级 event ID；Purchase 继续使用 checkout/order 稳定别名合并浏览器与付款 Webhook。
- 后台增加来源版本、事件时间、漏斗和 Webhook 状态诊断。
- v17 监听 Shopify `visitorConsentCollected`，撤回营销或数据销售授权后停止浏览器/CAPI并清除未发送队列。
- v17 逐条处理批量采集响应，并把浏览器队列溢出、存储失败、重试到期/耗尽及永久拒绝写入隐私安全诊断；首条真实事件进入网关后即可证明店铺实际运行版本。
- 后台定时审计 Shopify `ORDERS_PAID` 订阅，可在正确 URI 缺失时通过 Admin GraphQL 手动修复，不会自动删除其他地址。
- 保存 Webhook 的 `X-Shopify-API-Version`；后台和 `npm run doctor` 会检查实际版本是否与 `2026-07` 一致。
- Meta CAPI 请求仅发送官方 `ServerEvent` 字段；新客/老客状态作为本地诊断元数据保存，不再发送未被官方字段模型定义的 `customer_segmentation`。
- Admin GraphQL 找回的在线订单仍按 `website` 上报，并优先使用成功 Sale/Capture 交易时间，减少延迟扣款订单落入错误日期的问题。
- 在线事件只使用真实浏览器 UA 与页面 URL；无法从先前结账事件恢复时会在后台显示“本地校验异常”，不会伪造 UA 或把在线购买错误标记为 `system_generated`。
- 已付款订单对账按“店铺 + 订单身份”隔离，并明确显示已进入 Purchase 台账、Meta API 已确认收件/待处理/永久失败和未入台账数量，适配多店共享 Dataset。
- 浏览器与付款订单都不再把临时 Cart/Checkout/Order LineItem ID 当作 Meta Catalog 商品 ID；只保留 Variant/Product/SKU 这类持久身份。
- 本地校验失败只有在后续重复事件确实补齐所需信息后才会重新投递，避免同一无效事件反复失败并消耗额度。

## 部署前

宝塔终端执行：

```bash
cd /www/wwwroot/FacebookAPI
pwd
node -v
cp -a .env /www/backup/facebookapi/FacebookAPI-env-pre-v17.0-20260801
```

已有回滚材料：

- 代码备份：`/www/backup/facebookapi/FacebookAPI-pre-v15-20260731T2100Z.tar.gz`
- 数据库快照：`/www/backup/facebookapi/capi_saas-readonly-20260801.dump`
- 数据库校验文件：`/www/backup/facebookapi/capi_saas-readonly-20260801.dump.sha256`

不要修改 `AES_SECRET_KEY`、`INGEST_TOKEN_SECRET`、数据库密码或现有平台访问令牌。

## 上传并覆盖修复包

把本地 `.deploy/capi-v17.0-runtime-20260801.zip` 上传到 `/www/backup/facebookapi/`，然后执行：

```bash
# 先在宝塔停止 Node/API；再停止唯一 Worker，避免覆盖过程中继续处理事件。
cd /www/wwwroot/FacebookAPI
APP_USER="$(stat -c '%U' /www/wwwroot/FacebookAPI)"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
runuser -u "$APP_USER" -- env HOME="$APP_HOME" pm2 stop capi-worker || true
cd /www/backup/facebookapi
sha256sum -c capi-v17.0-runtime-20260801.sha256
cd /www/wwwroot/FacebookAPI
unzip -o /www/backup/facebookapi/capi-v17.0-runtime-20260801.zip -d /www/wwwroot/FacebookAPI

grep -q '^SHOPIFY_WEBHOOK_PROCESS_TIMEOUT_MS=' .env \
  || printf '\nSHOPIFY_WEBHOOK_PROCESS_TIMEOUT_MS=45000\n' >> .env

if grep -q '^PUBLIC_BASE_URL=' .env; then
  sed -i 's|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://pixel.atelierwrap.cc:8443|' .env
else
  printf 'PUBLIC_BASE_URL=https://pixel.atelierwrap.cc:8443\n' >> .env
fi
if grep -q '^ALLOW_SHARED_FACEBOOK_DATASET_ROUTES=' .env; then
  sed -i 's/^ALLOW_SHARED_FACEBOOK_DATASET_ROUTES=.*/ALLOW_SHARED_FACEBOOK_DATASET_ROUTES=true/' .env
else
  printf 'ALLOW_SHARED_FACEBOOK_DATASET_ROUTES=true\n' >> .env
fi
grep -q '^REQUIRE_WORKER_HEARTBEAT=' .env \
  || printf 'REQUIRE_WORKER_HEARTBEAT=true\nWORKER_HEARTBEAT_TTL_SECONDS=45\n' >> .env
grep -q '^TEST_EVENT_CODE_TTL_MINUTES=' .env \
  || printf 'TEST_EVENT_CODE_TTL_MINUTES=30\n' >> .env
if grep -q '^SHOPIFY_RECONCILE_LOOKBACK_HOURS=' .env; then
  sed -i 's/^SHOPIFY_RECONCILE_LOOKBACK_HOURS=.*/SHOPIFY_RECONCILE_LOOKBACK_HOURS=144/' .env
else
  printf 'SHOPIFY_RECONCILE_LOOKBACK_HOURS=144\n' >> .env
fi
grep -q '^SHOPIFY_WEBHOOK_AUDIT_CRON=' .env \
  || printf 'SHOPIFY_WEBHOOK_AUDIT_CRON="41 7 * * * *"\n' >> .env
grep -q '^BROWSER_DIAGNOSTIC_RETENTION_DAYS=' .env \
  || printf 'BROWSER_DIAGNOSTIC_RETENTION_DAYS=30\n' >> .env

sudo env APP_DIR=/www/wwwroot/FacebookAPI bash deploy/update_baota.sh
```

保持 `SHOPIFY_WEBHOOK_INBOX_LEASE_SECONDS × 1000` 大于 `SHOPIFY_WEBHOOK_PROCESS_TIMEOUT_MS`；建议分别为 60 秒和 45,000 毫秒。`SHOPIFY_WEBHOOK_INBOX_MAX_ATTEMPTS` 建议保持 20。

## 修复 HTTPS

在宝塔“网站”中为 `pixel.atelierwrap.cc` 申请或上传包含该主机名的有效证书，并确认该域名的 HTTPS 站点反向代理到 `127.0.0.1:3000`。随后执行：

```bash
/www/server/nginx/sbin/nginx -t
curl -fsS https://pixel.atelierwrap.cc:8443/healthz
curl -fsS https://pixel.atelierwrap.cc:8443/readyz
```

在证书匹配之前，不要把新 Customer Events 像素视为验收通过。

## 修复 API 与 Worker 守护

先分别查看 root 与 `www` 用户的 PM2：

```bash
pm2 ls
sudo -u www -H pm2 ls
```

只保留实际使用的一个 PM2 运行上下文，并确保 `cwd` 为 `/www/wwwroot/FacebookAPI`。如果生产进程由 `www` 用户管理：

```bash
cd /www/wwwroot/FacebookAPI
sudo -u www -H pm2 startOrReload ecosystem.config.js --update-env
sudo -u www -H pm2 save
sudo -u www -H pm2 describe capi-api
sudo -u www -H pm2 describe capi-worker
```

验收必须同时看到 `capi-api` 与 `capi-worker` 为 `online`，且两者目录都不是旧的 `Facebook-api-main`。

新版本的 `/readyz` 会检查 Worker 心跳。即使 API 和 Redis 正常，只要 Worker 未运行或心跳过期，也会返回 HTTP 503，避免再次静默漏处理后台任务。

## 多店共享同一个 Meta Dataset

1. 保持 `ALLOW_SHARED_FACEBOOK_DATASET_ROUTES=true`。
2. 在项目后台编辑当前 Meta Pixel，把 CASEORA、ATELIERWRAP 都绑定到同一 Pixel/Dataset。
3. 两个店铺必须各自使用后台为该店铺生成的 v17 Customer Events 代码，不能互相复制；生成代码中的店铺域名和采集 Token 不同。
4. 系统会在所有浏览器/CAPI `event_id`、Purchase `order_id` 和 `external_id` 中保留店铺命名空间，并按店铺隔离归因缓存、订单别名、投递账本、失败重试和 Test Event Code。
5. Meta Events Manager 展示的是共享 Dataset 的合并数据；逐店准确性以本项目后台“店铺今天”漏斗和 Shopify 同时区数据对账。
6. “已付款订单”卡片用于链路闭环：符合网站来源 → Purchase 台账 → Meta 已成功。任何“未进入台账”“本地校验异常”或“Meta 永久失败”大于 0，都应先处理该异常，不要用 Meta 广告归因数反推采集链路是否正常。

共享 Dataset 可以集中学习信号，但不会把不同业务天然变成相同转化意图。若后续两个店铺的商品、地区、币种或客群差异明显，应按广告组/自定义转化规则区分，必要时再拆分 Dataset。

## 设置店铺报表时区

迁移后旧店铺默认时区为 `UTC`。在后台“店铺与租户”中分别点击“修改时区”，将两个当前店铺设置为 `America/Los_Angeles`。后台会同时展示：

- 最近滚动 24 小时漏斗；
- 按各店铺自然日计算的“店铺今天”漏斗；
- 当天付款 Webhook 成功、待处理和永久失败数量。

与 Shopify Today 对账时只使用“店铺今天”，不要拿滚动 24 小时或 UTC 日期直接比较。

Meta 官方质量接口若未返回事件级指标，后台现在显示 `EMPTY`（黄色），不再将空响应标成 `SUCCESS`。这不代表事件没有送达；先查看本地 EMQ 信号覆盖率，再核对质量 Token 的权限和 Meta 端的数据可用性。

## 替换 Shopify Customer Events 像素

完成服务器、HTTPS、进程和数据集修复后：

1. 打开本项目 `/admin`，分别为两个店铺复制最新生成的 `shopify-pixel-v19` 代码。
2. Shopify 后台进入 `Settings -> Customer events`。
3. 在 Custom Pixel 隐私设置中如实声明 Analytics、Marketing 与 Data sale；v18 会读取初始授权并监听后续变化。
4. 每店只保留一套本项目自定义像素，替换旧版本，不要并行启用 v14-v17 与 v18。
5. 检查主题 Meta 代码、GTM Meta 标签以及 Facebook & Instagram 应用的数据共享，避免同一数据集收到第二套相同浏览器 Pixel 事件。
6. 当前自动化读取 Customer Events 页面时触发 Shopify 连接验证，因此像素列表必须由你在部署时人工确认。
7. 返回项目后台“店铺租户”，逐店点击“检查 Webhook”；状态应为 `HEALTHY`。若为 `MISSING` 或 `URI_MISMATCH`，确认 `PUBLIC_BASE_URL` 与证书正确后点击“修复 Webhook”。
8. v19 首个真实事件进入网关后，店铺表中的“像素运行版本”应显示 `shopify-pixel-v19` 和最近事件时间；“浏览器投递丢失诊断”正常应为空。

## 上线验收

依次在两个店铺各执行一次测试路径：

1. 产品页浏览：`ViewContent`
2. 加入购物车：`AddToCart`
3. 发起结账：`InitiateCheckout`
4. 提交联系、地址和配送信息：对应 Checkout 事件
5. 提交支付信息：`AddPaymentInfo`
6. 完成一笔测试付款：只能生成一个规范化 `Purchase`

同时检查：

```bash
cd /www/wwwroot/FacebookAPI
npm run doctor
npm run verify:public
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
sudo -u www -H pm2 logs capi-api --lines 100 --nostream
sudo -u www -H pm2 logs capi-worker --lines 100 --nostream
```

对账时统一使用店铺时区、同一日期窗口和同一粒度。Shopify 会话漏斗、Meta 接收事件与 Meta 广告归因要分别比较。

那条 7 月 10 日的卡死付款记录已经超过 Meta 可接受的历史发送窗口；部署后应将其隔离，不要把它伪装成当前事件重发。修复用于避免未来订单再次卡死。

## 回滚

如果 `/healthz`、`/readyz`、数据库迁移或 PM2 验收失败，停止继续替换 Shopify 像素，使用既有代码备份恢复，再恢复原 `.env`。数据库结构回滚前必须保留当前快照，不要执行无快照的跨版本回退。
