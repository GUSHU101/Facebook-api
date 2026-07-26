# CAPI SaaS Data Hub

The admin console uses pinned, locally served Tailwind CSS and Vue browser
assets instead of runtime CDNs. After changing admin HTML/CSS or upgrading Vue,
run `npm install` and `npm run build:admin`, then commit the regenerated
`src/public/admin.css` and `src/public/vue.global.prod.js`. Production installs
do not need these build dependencies because both compiled assets are included
in the repository.


Private VPS service for Shopify Customer Events, Meta Conversions API, and TikTok Events API tracking.

Baota/aaPanel is optional. For a clean Ubuntu VPS, use the one-command deployment guide: [DEPLOY_UBUNTU_ONECLICK.md](DEPLOY_UBUNTU_ONECLICK.md). For Baota-based operations, use [DEPLOY_BAOTA_UBUNTU.md](DEPLOY_BAOTA_UBUNTU.md). Before uploading to GitHub, see [GITHUB_RELEASE_CHECKLIST.md](GITHUB_RELEASE_CHECKLIST.md).

One-command install after uploading the project to GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/GUSHU101/Facebook-api/main/deploy/install_ubuntu.sh -o /tmp/capi-install.sh \
  && sudo env \
    REPO_URL=https://github.com/GUSHU101/Facebook-api.git \
    DOMAIN=capi.example.com \
    PUBLIC_PORT=8443 \
    AUTO_SSL=1 \
    ACME_DNS_PROVIDER=dns_cf \
    CF_Token=your_cloudflare_api_token \
    CF_Zone_ID=your_cloudflare_zone_id \
    bash /tmp/capi-install.sh
```

The installer auto-installs missing Ubuntu dependencies, generates secrets when passwords are not provided, applies DNS-01 SSL with acme.sh when `AUTO_SSL=1`, enables non-443 HTTPS, and can redirect HTTP to `https://domain:8443`. If you already have DNS-validated SSL files, pass `CERT_FULLCHAIN=/path/fullchain.pem CERT_KEY=/path/privkey.pem` instead.

## What it tracks

The generated Shopify custom pixel subscribes to Shopify Customer Events and sends those events to this hub with stable `event_id` values. The hub then delivers events server-side to Meta CAPI and TikTok Events API through the configured Pixel routes.

The custom pixel intentionally does not inject the Meta or TikTok browser SDK. Shopify Customer Events run in sandboxed environments where DOM access and script injection are unavailable or unreliable, so browser SDK events should not be treated as the primary tracking path.
The generated code can include configured Meta/TikTok Pixel IDs as route hints for diagnostics, but the server still chooses delivery destinations from the saved Pixel Routes, not from client-supplied IDs.

Meta standard events:

- `page_viewed` -> `PageView`
- `product_viewed` -> `ViewContent`
- `product_added_to_cart` -> `AddToCart`
- `checkout_started` -> `InitiateCheckout`
- `payment_info_submitted` -> `AddPaymentInfo`
- `checkout_completed` -> durable `Purchase` candidate; delivery unlocks only after verified `orders/paid`
- `search_submitted` -> `Search`

Meta custom events:

- `cart_viewed` -> `CartView`
- `collection_viewed` -> `CollectionView`
- `product_removed_from_cart` -> `RemoveFromCart`
- `checkout_contact_info_submitted` -> `CheckoutContactInfoSubmitted`
- `checkout_address_info_submitted` -> `CheckoutAddressInfoSubmitted`
- `checkout_shipping_info_submitted` -> `CheckoutShippingInfoSubmitted`
- `alert_displayed` -> `ShopifyAlertDisplayed`
- `ui_extension_errored` -> `ShopifyUiExtensionErrored`

TikTok event mapping:

- `PageView` -> `PageView`
- `ViewContent` -> `ViewContent`
- `AddToCart` -> `AddToCart`
- `InitiateCheckout` -> `InitiateCheckout`
- `AddPaymentInfo` -> `AddPaymentInfo`
- `Purchase` -> `Purchase` (TikTok's current standard name)
- `Search` -> `Search`
- Custom Shopify events keep their generated custom event name.

## Accuracy notes

- Meta server-side deduplication depends on stable `event_name` and `event_id` values across Shopify Customer Events and order webhooks.
- TikTok server-side delivery preserves the same `event_id` and uses TikTok's current `Purchase` standard event name.
- `Purchase` uses a durable alias registry: PostgreSQL transaction locks unify checkout/order/cart identifiers even after Redis restarts. Browser and webhook payloads then merge on the exact `(shop_id, event_name, event_id)` key before delivery; no write-only Redis dedupe shadow can diverge from that authority.
- `shop_pixel_routes` provides true many-to-many routing: one credential can serve multiple shops and one shop can use multiple pixels. Shared credentials intentionally aggregate those shops in the same external Meta Dataset/TikTok Pixel, while local event, attribution, dedupe, retry, and delivery rows remain separated by authenticated `shop_id`. Client-supplied route hints never select a destination.
- `event_deliveries` is the durable per-event/per-route ledger. A unique `(event_store_id, route_id)` key, leases, attempt counters, retry timestamps, and terminal success records prevent one shop or failed pixel from overwriting another route. A PostgreSQL trigger rejects any cross-shop event/route pairing even if a future application bug attempts one.
- Removing a shop from a shared credential marks that route inactive instead of deleting it, preserving historical per-route delivery evidence. Re-adding the shop activates the same route again.
- Events that arrive before any Pixel is configured stay durably `PENDING`; adding or reactivating a route wakes the shop backlog instead of silently failing it.
- Ingestion writes the normalized event to PostgreSQL before returning `202`. Redis/BullMQ accelerates dispatch but is no longer the only copy; if Redis is unavailable after the durable write, the watchdog dispatches the PostgreSQL outbox after recovery.
- Partial platform failures preserve delivery history. When replaying or retrying a partially failed event, routes already marked `SUCCESS` are never claimed again; only pending or retryable route rows are sent.
- Manual DLQ replay resets only permanently failed active routes. Successful routes remain immutable and inactive routes stay disabled.
- Shared credentials use a renewable distributed delivery lease plus per-attempt fencing. A stale worker cannot overwrite a newer attempt, and multiple shops cannot intentionally send concurrent batches through the same credential.
- Meta response headers (`Retry-After`, `X-Business-Use-Case-Usage`, `X-App-Usage`, `X-Ad-Account-Usage`) feed a persistent credential cooldown. High usage slows future dispatch before another 429; an actual 429 pauses every shop sharing that credential.
- The authenticated pixel ingestion limiter is disabled by default (`PIXEL_RATE_LIMIT_PER_MINUTE=0`) so legitimate traffic spikes are buffered instead of answered with `429 Too Many Requests`. Put abuse controls at the WAF/CDN layer; enabling this setting intentionally re-enables 429 responses.
- Browser `checkout_completed` persists a durable `AWAITING_PAYMENT` Purchase candidate containing attribution and checkout data. It is not delivered to ad platforms until an HMAC-verified `orders/paid` webhook for the same checkout/order/cart alias confirms payment. This avoids counting unpaid, deferred, failed, or payment-on-delivery checkouts as paid purchases.
- Shopify test orders are excluded, and paid orders use a positive website-source allowlist. `SHOPIFY_WEB_ORDER_SOURCES=web` is the safe default; explicitly add a verified headless/custom sales-channel source only when that channel belongs to the tracked storefront. Missing, POS, mobile-app, draft-order, and unknown sources are acknowledged without creating a website Purchase. Paid-order payloads with no stable order identity or invalid value/currency are rejected so Shopify retries instead of silently creating an unusable conversion.
- Confirmed Purchase events retain the short settle window (`PURCHASE_SETTLE_MS`, default 8000ms) so browser and webhook data arriving close together can finish merging before platform delivery.
- Stale database events still marked `PENDING` are automatically re-queued after `DELIVERY_RESCUE_MINUTES` when an active route is due, recovering from queue metadata loss, old-version residue, or interrupted deployments without spinning on platform cooldowns.
- Queue jobs carry only `shopId`; workers re-read a bounded PostgreSQL batch with both `shop_id` and `PENDING` predicates. A corrupt or stale queue payload cannot pull another shop's event IDs into the current job.
- `WORKER_EVENT_BATCH_SIZE` bounds how long a busy shop or shared credential can occupy a worker. Successful batches enqueue continuations until the database backlog is empty, while the rescue cursor rotates across shops so a large store cannot starve smaller stores.
- Only Purchase uses the advisory-lock alias registry. Other events use the `(shop_id, event_name, event_id)` unique index directly, avoiding unnecessary locks and alias-table growth.
- Hourly bounded cleanup removes only old terminal events and expired diagnostics. `PENDING` and `AWAITING_PAYMENT` rows are never removed. Scale indexes are built online with `CREATE INDEX CONCURRENTLY`.
- `/readyz` returns HTTP 200 with `status=degraded` when PostgreSQL is healthy but Redis is temporarily unavailable. Durable ingestion continues and dispatch resumes after Redis recovery.
- A PostgreSQL-ledger reconciliation pass repairs the narrow crash window where every per-route delivery is terminal but the parent event summary was not updated. It uses a transaction advisory lock and bounded `SKIP LOCKED` batches, so multiple API instances cannot race or scan an unlimited backlog.
- Duplicate paid webhooks can unlock only an `AWAITING_PAYMENT` Purchase. They cannot resurrect `SUCCESS`, `FAILED`, or `PARTIAL_FAILED` events and cannot cause already successful routes to be resent.
- Redis cache/producer/lock commands fail promptly during a partition, while a dedicated BullMQ Worker connection continues reconnecting. This prevents HTTP requests from accumulating behind an unbounded Redis offline queue.
- The generated Shopify pixel serializes local-storage writes and retains in-flight batches until acknowledgment. A page close can cause a safe stable-ID retry, but cannot overwrite the unconfirmed batch with a newer event.
- `LEGACY_REDIS_DRAIN_ENABLED=false` avoids scanning every shop for obsolete Redis-list queues. Enable it only temporarily when upgrading a deployment that still contains pre-PostgreSQL-outbox list entries.
- The Shopify pixel uses the Web Pixels `browser.cookie` API to preserve real `_fbp`, `_fbc`, and click IDs without DOM access. It creates `_fbc` only from an actual `fbclid`. Meta `_fbp` and TikTok `_ttp` are forwarded only when their real cookies already exist; the gateway never fabricates either browser identifier.
- Shopify `checkout_completed` is emitted once per checkout, usually on the thank-you page; upsell flows can emit it earlier, and Shopify documents that it can be missed if the relevant page does not load. The required `orders/paid` webhook is therefore both the payment authority and the server-side fallback.
- Shopify may return protected customer data as `null` when the app lacks approved protected scopes. The generated pixel tolerates missing email, phone, name and address data.
- Highest matching quality comes from combining `_fbp`, `_fbc`, browser user agent, server IP, Shopify `clientId`, email, phone, name and address when available.
- No implementation can guarantee 100% capture because browser blocking, consent, platform privacy rules and checkout surface limitations can suppress events or identifiers. This project maximizes official coverage and adds order webhook fallback for Purchase.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create or update PostgreSQL tables:

   ```bash
   npm run migrate
   ```

   `npm run migrate` applies the unified schema and then builds scale indexes online. It is safe to run on both a fresh database and an existing database; it does not delete business data.

3. Configure `.env`:

   ```env
   PORT=3000
   DATABASE_URL=postgres://user:password@host:5432/db
   REDIS_URL=redis://host:6379
   FB_API_VERSION=v25.0
   REQUIRE_INGEST_TOKEN=true
   SHOPIFY_WEB_ORDER_SOURCES=web
   HTTP_REQUEST_TIMEOUT_MS=30000
   HTTP_HEADERS_TIMEOUT_MS=15000
   HTTP_KEEP_ALIVE_TIMEOUT_MS=5000
   SHUTDOWN_TIMEOUT_MS=120000
   DELIVERY_RETRY_BASE_SECONDS=5
   DELIVERY_RETRY_MAX_SECONDS=900
   DELIVERY_RETRY_AFTER_MAX_SECONDS=86400
   # 0 keeps transient failures retryable until event-age validation expires them.
   DELIVERY_MAX_ATTEMPTS=0
   DELIVERY_RESCUE_MINUTES=1
   AGGREGATE_RECONCILE_BATCH_SIZE=5000
   CREDENTIAL_LEASE_MS=60000
   CREDENTIAL_BUSY_DELAY_SECONDS=2
   FACEBOOK_ISOLATION_MAX_REQUESTS=16
   PIXEL_RATE_LIMIT_PER_MINUTE=0
   # Use * only if every storefront may submit events; otherwise list exact origins.
   CORS_ORIGIN=https://shop.example.com,https://www.shop.example.com
   TRUST_PROXY_HOPS=1
   DB_POOL_MAX=20
   DB_IDLE_TIMEOUT_MS=30000
   DB_CONNECTION_TIMEOUT_MS=10000
   DB_STATEMENT_TIMEOUT_MS=30000
   DB_POOL_MAX_USES=7500
   LEGACY_REDIS_DRAIN_ENABLED=false
   WORKER_EVENT_BATCH_SIZE=100
   DELIVERY_RESCUE_SHOP_LIMIT=500
   CLEANUP_CRON=17 * * * *
   CLEANUP_BATCH_SIZE=10000
   CLEANUP_MAX_BATCHES=2
   EVENT_RETENTION_DAYS=90
   DEAD_LETTER_RETENTION_DAYS=90
   ALIAS_RETENTION_DAYS=120
   QUALITY_RETENTION_DAYS=30
   API_INSTANCES=1
   WORKER_INSTANCES=1
   AES_SECRET_KEY=replace-with-a-long-random-secret
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=replace-with-a-strong-password
    ```

   `AES_SECRET_KEY` must contain at least 32 characters. `CORS_ORIGIN` accepts
   `*` or a comma-separated list of exact HTTP(S) origins (no paths or trailing
   slash). CORS is intentionally enabled only on `/api/pixel-event`; admin APIs
   stay same-origin. Set `TRUST_PROXY_HOPS=0` when Node is reached directly.

4. Start API and worker:

   ```bash
   npm run doctor
   ```

   ```bash
   npm start
   npm run worker
   ```

5. Open the admin panel. If you avoid public port `443`, use a custom HTTPS port such as `https://capi.example.com:8443/admin`.
6. Add Shopify shops, then add one or more platform routes. The route form supports selecting several shops for the same credential:
   - Facebook / Meta: Pixel or Dataset ID plus System User Access Token.
   - TikTok: Pixel Code plus Events API Access Token.
7. Paste the generated code into Shopify Customer events as a custom pixel. Make sure the generated API URL includes the same custom HTTPS port, for example `https://capi.example.com:8443`.

## Verification

- Use the Meta test event code in the Pixel route while testing.
- Confirm Meta server events arrive with the expected `event_id`, URL, user agent, `_fbp` / `_fbc` when available, and customer match fields when Shopify exposes them.
- Confirm TikTok server events arrive with the expected `event_id`, `_ttp` / `ttclid` when available, value, currency, and contents.
- Confirm purchase values, currency, content IDs and order ID are populated for `Purchase`.

Local code checks:

```bash
npm run check
npm test
npm audit --audit-level=moderate
```

The unit tests cover Shopify order-to-Purchase conversion, TikTok Events API payload mapping, event ID preservation for deduplication, private-field stripping, Meta transient-error classification, `Retry-After`, proactive usage-header cooldowns, stale-attempt fencing, runtime security configuration, and partial-delivery safeguards.

For failure semantics, operational thresholds, official references, and the
load/fault-injection checklist, see [RELIABILITY.md](RELIABILITY.md).

### Upgrading an existing installation

Stop the API and worker, back up PostgreSQL, pull the new code, and run:

```bash
npm run migrate
```

The migration preserves existing shops, pixels, events, and tokens. Each legacy
`pixels.shop_id` relationship is copied into `shop_pixel_routes`; the old owner
column becomes nullable so deleting one shop cannot delete a credential still
used by another shop. Start the API and worker only after the migration
completes.

For horizontal scaling, increase `API_INSTANCES` and `WORKER_INSTANCES`
gradually. Approximate maximum PostgreSQL connections are
`(API_INSTANCES + WORKER_INSTANCES) * DB_POOL_MAX`; keep this below the
database server's reserved capacity. Per-shop leases prevent duplicate drains,
shared-credential leases serialize calls to the same external Pixel, and
per-attempt fencing rejects stale results.

After upgrading, open the admin panel and copy the newly generated Shopify
Customer Events code into every connected shop. The generated code contains a
shop-scoped ingestion token; with `REQUIRE_INGEST_TOKEN=true` (the default),
events that merely spoof another `shop_domain` are rejected before routing.

## Usage Tutorial

1. Upload the project to GitHub and confirm CI passes.
2. Run the one-command Ubuntu installer from [DEPLOY_UBUNTU_ONECLICK.md](DEPLOY_UBUNTU_ONECLICK.md).
3. Open the admin panel at `https://your-domain:8443/admin`.
4. Add your Shopify shop using the `myshopify.com` domain and webhook secret.
5. Add a Facebook / Meta route:
   - Platform: `Facebook / Meta`
   - Pixel / Dataset ID
   - System User Access Token
   - Optional Meta Dataset Quality API token for official EMQ snapshots
   - Optional Meta Test Event Code
6. Optional: add TikTok route:
   - Platform: `TikTok`
   - TikTok Pixel Code
   - Events API Access Token
   - Optional test event code
7. Go to "追踪代码", select or enter the shop domain, and confirm the API origin is your public HTTPS origin such as `https://your-domain:8443`.
8. Copy the generated code into Shopify Admin -> Settings -> Customer events -> Add custom pixel.
9. Configure the required Shopify `orders/paid` webhook to:

   ```text
    https://your-domain:8443/api/webhook/orders/paid
    ```

   Purchase delivery intentionally remains `AWAITING_PAYMENT` until this
   webhook arrives. Shopify retries failed webhook deliveries, while the
   browser candidate preserves attribution and checkout identifiers for the
   later merge.

10. Test in Meta Events Manager:
    - Server events appear from the configured Pixel route.
    - `event_id` is stable across checkout and webhook enrichment.
    - `Purchase` includes value, currency, contents, content_ids, and order_id.
    - EMQ improves as email, phone, fbp, fbc, IP, user-agent, and address become available.
11. Watch the admin "日志与死信" page:
    - Low EMQ usually means missing email/phone/fbp/fbc/address.
    - Meta official dataset quality appears when a Dataset Quality API-capable token is configured; this cached official snapshot can lag behind live events.
    - DLQ means token, permission, rate limit, or platform API issues need action.
   
    - shopify权限
    - | 你列的权限 | 建议 | 原因 |
|---|---|---|
| `read_orders` | 需要 | 读取订单金额、币种、商品、客户信息，用于 `Purchase` 和 webhook |
| `write_orders` | 不需要 | 项目不创建/修改订单 |
| `read_assigned_fulfillment_orders` | 不需要 | 项目不处理履约/发货 |
| `write_assigned_fulfillment_orders` | 不需要 | 项目不创建/修改履约单 |
| `read_checkouts` | 不需要 | 加购、发起结账由 Shopify Customer Events Pixel 捕获，不靠 Admin API 读取 |
| `write_checkouts` | 不需要 | 项目不创建/修改 checkout |
| `read_draft_orders` | 不需要 | 项目不读取草稿订单 |
| `write_draft_orders` | 不需要 | 项目不创建/修改草稿订单 |
| `read_customers` | 可选 | 若 Shopify 要求客户数据权限，可开启；有助于客户匹配数据完整性 |
| `write_customers` | 不需要 | 项目不创建/修改客户 |
| `read_products` | 不需要 | Pixel/webhook 已带商品 ID，项目不需要额外读商品 |
| `write_products` | 不需要 | 项目不创建/修改商品 |
| `read_merchant_managed_fulfillment_orders` | 不需要 | 项目不处理商家履约订单 |
| `write_merchant_managed_fulfillment_orders` | 不需要 | 项目不创建/修改履约订单 |
| `read_price_rules` | 不需要 | 项目不读取 Shopify 价格规则；订单事件里已有实际成交金额 |
| `write_price_rules` | 不需要 | 项目不创建/修改价格规则 |
| `read_discounts` | 不需要 | 项目不读取折扣规则；订单 webhook 会包含最终成交信息 |
| `write_discounts` | 不需要 | 项目不创建/修改折扣 |
| `read_markets` | 不需要 | 项目不上 Shopify 查询市场/汇率配置 |
| `read_locations` | 不需要 | 项目不根据库存地点或门店位置处理归因 |
| `read_online_store_navigation` | 不需要 | 项目不读取网站导航 |
| `read_online_store_pages` | 不需要 | 项目不读取页面内容 |
