# CAPI SaaS Data Hub

Private VPS service for Shopify Web Pixel, Meta Pixel, Meta Conversions API, TikTok Pixel and TikTok Events API tracking.

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

The generated Shopify custom pixel subscribes to Shopify Web Pixels standard events and sends the same `event_id` to browser Pixel and server CAPI for deduplication.

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

- Meta Pixel and CAPI deduplication depends on matching `event_name` and `event_id`.
- TikTok Pixel and Events API deduplication depends on matching `event` and `event_id`; TikTok can deduplicate overlapping Pixel/API events within its deduplication window.
- `Purchase` uses a two-layer dedupe strategy: Redis absorbs obvious repeat traffic, while PostgreSQL merges browser pixel and Shopify webhook payloads with the same `event_id` before successful delivery. This lets webhook order data enrich browser events without double-sending already successful events.
- Partial platform failures preserve delivery history. When replaying or retrying a partially failed event, pixels/platform routes already marked `SUCCESS` are skipped so only failed destinations are retried.
- Purchase events have a short settle window (`PURCHASE_SETTLE_MS`, default 8000ms) before batching. This gives Shopify `orders/paid` webhook data a chance to merge with browser pixel data before server-side delivery.
- Browser tracking generates/persists fallback `_fbp`, `_fbc`, `_ttp`, and `ttclid` when official cookies are missing but URL click IDs are present, improving attribution continuity.
- Shopify `checkout_completed` is emitted once per checkout, usually on the thank-you page; upsell flows can emit it earlier.
- Shopify may return protected customer data as `null` when the app lacks approved protected scopes. The generated pixel tolerates missing email, phone, name and address data.
- Highest matching quality comes from combining `_fbp`, `_fbc`, browser user agent, server IP, Shopify `clientId`, email, phone, name and address when available.
- No implementation can guarantee 100% capture because browser blocking, consent, platform privacy rules and checkout surface limitations can suppress events or identifiers. This project maximizes official coverage and adds order webhook fallback for Purchase.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create PostgreSQL tables:

   ```bash
   psql "$DATABASE_URL" -f init.sql
   ```

   For an existing installation, run migrations after pulling new code:

   ```bash
   npm run migrate
   ```

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
- Confirm browser and server events show the same event ID in Meta Events Manager.
- Confirm TikTok browser and server events show the same event ID in TikTok Events Manager.
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
   - Optional Meta Test Event Code
6. Optional: add TikTok route:
   - Platform: `TikTok`
   - TikTok Pixel Code
   - Events API Access Token
   - Optional test event code
7. Go to "追踪代码", enter the shop domain, Meta Pixel ID, and optional TikTok Pixel ID.
8. Copy the generated code into Shopify Admin -> Settings -> Customer events -> Add custom pixel.
9. Configure Shopify `orders/paid` webhook to:

   ```text
   https://your-domain:8443/api/webhook/orders/paid
   ```

10. Test in Meta Events Manager:
    - Browser and Server events appear.
    - `eventID` and `event_id` match.
    - `Purchase` includes value, currency, contents, content_ids, and order_id.
    - EMQ improves as email, phone, fbp, fbc, IP, user-agent, and address become available.
11. Watch the admin "日志与死信" page:
    - Low EMQ usually means missing email/phone/fbp/fbc/address.
    - DLQ means token, permission, rate limit, or platform API issues need action.
