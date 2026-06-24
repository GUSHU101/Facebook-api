# CAPI SaaS Data Hub


Private VPS service for Shopify Customer Events, Meta Conversions API, and TikTok Events API tracking.

Baota/aaPanel is optional. For a clean Ubuntu VPS, use the one-command deployment guide: [DEPLOY_UBUNTU_ONECLICK.md](DEPLOY_UBUNTU_ONECLICK.md). For Baota-based operations, use [DEPLOY_BAOTA_UBUNTU.md](DEPLOY_BAOTA_UBUNTU.md). Before uploading to GitHub, see [GITHUB_RELEASE_CHECKLIST.md](GITHUB_RELEASE_CHECKLIST.md).

One-command install after uploading the project to GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USER/YOUR_REPO/main/deploy/install_ubuntu.sh -o /tmp/capi-install.sh \
  && sudo env \
    REPO_URL=https://github.com/YOUR_GITHUB_USER/YOUR_REPO.git \
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
- `checkout_completed` -> `Purchase`
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
- `Purchase` -> `CompletePayment`
- `Search` -> `Search`
- Custom Shopify events keep their generated custom event name.

## Accuracy notes

- Meta server-side deduplication depends on stable `event_name` and `event_id` values across Shopify Customer Events and order webhooks.
- TikTok server-side delivery preserves the same `event_id` and maps standard events to TikTok Events API names, for example `Purchase` -> `CompletePayment`.
- `Purchase` uses a two-layer dedupe strategy: Redis absorbs obvious repeat traffic, while PostgreSQL merges Shopify Customer Events and Shopify webhook payloads with the same `event_id` before successful delivery. This lets webhook order data enrich checkout events without double-sending already successful events.
- Partial platform failures preserve delivery history. When replaying or retrying a partially failed event, pixels/platform routes already marked `SUCCESS` are skipped so only failed destinations are retried.
- Purchase events have a short settle window (`PURCHASE_SETTLE_MS`, default 8000ms) before batching. This gives Shopify `orders/paid` webhook data a chance to merge with browser pixel data before server-side delivery.
- Stale database events still marked `PENDING` are automatically re-queued after `STALE_PENDING_MINUTES` to recover from queue metadata loss, old-version residue, or interrupted deployments.
- The Shopify pixel uses the Web Pixels `browser.cookie` API to read or persist fallback `_fbp`, `_fbc`, `_ttp`, and `ttclid` when official cookies are missing but URL click IDs are present, improving attribution continuity without DOM access.
- Shopify `checkout_completed` is emitted once per checkout, usually on the thank-you page; upsell flows can emit it earlier.
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

   `npm run migrate` applies the unified `init.sql` schema. It is safe to run on both a fresh database and an existing database; it does not delete business data.

3. Configure `.env`:

   ```env
   PORT=3000
   DATABASE_URL=postgres://user:password@host:5432/db
   REDIS_URL=redis://host:6379
   FB_API_VERSION=v24.0
   AES_SECRET_KEY=replace-with-a-long-random-secret
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=replace-with-a-strong-password
   ```

4. Start API and worker:

   ```bash
   npm run doctor
   ```

   ```bash
   npm start
   npm run worker
   ```

5. Open the admin panel. If you avoid public port `443`, use a custom HTTPS port such as `https://capi.example.com:8443/admin`.
6. Add a Shopify shop, add one or more platform routes:
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

The unit tests cover Shopify order-to-Purchase conversion, TikTok Events API payload mapping, event ID preservation for deduplication, and private-field stripping before Meta CAPI sends.

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
9. Configure Shopify `orders/paid` webhook to:

   ```text
   https://your-domain:8443/api/webhook/orders/paid
   ```

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
