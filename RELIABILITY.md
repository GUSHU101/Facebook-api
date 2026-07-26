# Reliability and event-accuracy model

This service is designed for at-least-once transport with stable event IDs and
per-route idempotency. That is the strongest honest model available when an
external HTTP request can time out after the platform accepted it but before
the response reached this service. Stable `event_name` + `event_id` values let
Meta deduplicate a safe retry.

No browser or server integration can truthfully guarantee 100% capture or that
Meta will never rate-limit a request. Consent, browser privacy controls, network
failure, protected-customer-data access, invalid credentials, and platform
outages remain external constraints. The implementation guarantees that these
conditions do not silently mix shops, overwrite a successful route with a stale
failure, or discard a PostgreSQL-persisted event merely because Redis or a
worker restarted.

## Reliability invariants

1. The API normalizes and stores an event in PostgreSQL before returning `202`.
2. `(shop_id, event_name, event_id)` is the event identity boundary.
   Purchase checkout/order/cart aliases are resolved in PostgreSQL under
   transaction-scoped advisory locks. PostgreSQL is the only dedupe authority.
3. `(event_store_id, route_id)` is the delivery identity boundary.
4. A route marked `SUCCESS` is never reclaimed.
5. Every claim increments `attempt_count`; success/failure updates must match
   that exact attempt. Late results from an expired worker are ignored.
6. A shared credential has one renewable Redis lease. The lease is extended
   while a request is active and released only by its unique owner token.
7. Meta usage headers create a persistent credential cooldown shared by all
   shops using that credential.
8. `Retry-After` takes precedence over local exponential backoff and is allowed
   to exceed the normal local retry cap.
9. Transient delivery failures have no fixed retry-count cutoff by default.
   Stable event IDs continue retrying until local Meta event-age validation
   reaches the seven-day boundary. Setting `DELIVERY_MAX_ATTEMPTS` above zero is
   an explicit early-abandonment policy.
10. Storefront retries preserve the same event ID, use persistent storage,
   exponential backoff with jitter, and stop before Meta's seven-day event-age
   boundary.
11. Shopify webhook request IP/user-agent values are never sent as shopper
    identifiers. Only order payload values such as `browser_ip` and
    `client_details.user_agent` are eligible.
12. Browser `checkout_completed` records are stored as `AWAITING_PAYMENT` and
    cannot create delivery-ledger rows. Only an HMAC-verified `orders/paid`
    webhook changes the canonical Purchase to `PENDING`; its
    `X-Shopify-Triggered-At` value becomes the payment event timestamp.
13. Test orders and every order source not present in the positive
    `SHOPIFY_WEB_ORDER_SOURCES` allowlist are excluded from the website Purchase
    stream. Missing and unknown sources fail closed. Malformed paid-order payloads
    fail before acknowledgment, allowing Shopify's delivery retry policy to
    recover transient/schema issues.
14. Multi-shop/multi-pixel routing remains many-to-many. A worker job contains
    only `shopId`, reloads rows with `event_store.shop_id = shopId`, and selects
    routes with `shop_pixel_routes.shop_id = shopId`. Sharing one external pixel
    is intentional aggregation at that platform, not local tenant co-mingling.
15. Only Purchase creates durable alias rows. Other event types avoid the
    advisory-lock path and use the shop-scoped unique event index directly.
16. A renewable per-shop lease allows only one active drain for a shop, while a
    renewable per-credential lease serializes shops sharing a credential.
    Bounded batches and continuation jobs preserve throughput and fairness.
17. Retention cleanup deletes only terminal rows in bounded `SKIP LOCKED`
    batches. Pending delivery and payment-confirmation states are preserved.
18. Worker continuation and rescue queries select only active routes that are
    missing a ledger row or whose retry/expired lease is due. Platform cooldowns
    therefore cannot create an immediate empty-job loop.
19. Events received before a shop has an active route remain `PENDING` in
    PostgreSQL. Creating or reactivating a route wakes that shop's outbox.
20. Manual dead-letter replay resets only `FAILED_PERMANENT` rows on currently
    active routes. Successful routes and inactive routes are never resent.
21. Browser storage retains both queued and in-flight batches until a response
    is confirmed. Storage writes and flushes are serialized to prevent a later
    event from overwriting an unconfirmed earlier request.
22. Redis producer/cache/lock commands fail quickly during partitions, while
    the dedicated BullMQ Worker connection keeps reconnecting. PostgreSQL, not
    an unbounded Redis command queue, remains the durability boundary.
23. Ingestion rejects a missing `event_id` instead of inventing a different ID
    on every retry. The generated Shopify Pixel and paid-order webhook always
    provide stable identifiers.
24. PostgreSQL itself rejects a delivery whose event shop differs from its
    route shop. A unique `(platform, pixel_id)` credential identity also makes
    shared cooldowns and leases impossible to bypass with duplicate rows.
25. A duplicate payment webhook may transition only `AWAITING_PAYMENT` to
    `PENDING`. Terminal event summaries cannot be resurrected, and the immutable
    successful route ledger remains authoritative.
26. A bounded PostgreSQL reconciliation pass repairs an interrupted aggregate
    status update only after every route delivery is terminal. A transaction
    advisory lock and `SKIP LOCKED` make this safe across clustered API instances.
27. HTTP header, request, keep-alive, and graceful-shutdown deadlines are
    explicit. A forced worker stop remains retry-safe because claims use expiring
    leases, fencing attempts, and stable event IDs.
28. Browser match identifiers are provenance-safe: `_fbp` and `_ttp` are sent
    only when their real cookies exist, while `_fbc` is created only from an
    actual `fbclid`. Synthetic browser identifiers are never generated.

## Why the system does not return ingestion 429 by default

`PIXEL_RATE_LIMIT_PER_MINUTE=0` disables the Express limiter only for the
authenticated `/api/pixel-event` data path. Payload-size and batch-size limits,
shop-scoped tokens, body parsing limits, and the upstream reverse proxy remain
active. Abuse controls belong at a CDN/WAF because rejecting a valid tracking
event after authentication creates measurement loss. If an operator enables a
positive application limit, HTTP 429 is an intentional configuration outcome.

Meta can still issue a rate-limit response. The worker classifies it as
retryable, honors `Retry-After`, persists the cooldown on the pixel credential,
and leaves the event in the durable ledger for a later attempt.

## Data-quality checks

Run these queries or equivalent monitoring by shop, event, route, and hour:

- Completeness: received events versus events with at least one delivery row.
- Uniqueness: duplicate `(shop_id, event_name, event_id)` must remain zero.
- Route integrity: orphaned `event_deliveries` must remain zero.
- Isolation: every delivery route's shop must equal its event's shop.
- Timeliness: p50/p95/p99 from event-store timestamp to `delivered_at`.
- Retry health: rate of `RETRYABLE_FAILED`, attempts per success, and oldest
  `next_attempt_at` that is already due.
- Accuracy: Purchase value/currency/order ID population; PageView/ViewContent/
  AddToCart/Purchase event mix; future or older-than-seven-day event times.
- Funnel completeness: value/currency/content IDs/contents coverage for
  AddToCart, InitiateCheckout, AddPaymentInfo, and Purchase; count and oldest
  age of `AWAITING_PAYMENT` events.
- Match signals: coverage rates for `client_user_agent`, `client_ip_address`,
  `fbp`, `fbc`, `external_id`, email, and phone. `external_id` is hashed from
  the server-authoritative shop domain plus the store-local identifier, so two
  shops sharing one dataset cannot collide on the same Shopify numeric ID. Missing protected customer
  data is a Shopify permission/privacy limitation, not a reason to fabricate it.
- Throttling: `last_usage_pct`, active `rate_limit_until`, 429/error-code rate,
  and consecutive failures per credential.
- Capacity: PostgreSQL `PENDING` count and oldest age per shop, worker batch
  drain time, Redis memory/eviction policy, table/index size, autovacuum lag,
  and database connection saturation.

Alert on the oldest due event, not just queue length. A growing queue during an
active platform cooldown can be expected; a due event that remains untouched
indicates a dispatcher or database problem.

## Fault-injection checklist

Before production rollout, verify all of the following in a staging stack:

1. Stop Redis during ingestion. The API should persist to PostgreSQL and return
   `202` with `dispatch_scheduled=false`; after Redis returns, the watchdog must
   dispatch the event.
2. Kill a worker after Meta accepts a request but before the database update.
   The retry must use the identical event ID, and the stale attempt must not
   overwrite the newer ledger row.
3. Return HTTP 429 with numeric and HTTP-date `Retry-After` values. No request
   for that credential should be sent before the persisted cooldown expires.
4. Return Meta usage headers at 80%, 90%, 95%, and 100%. Verify progressively
   longer proactive cooldowns. `estimated_time_to_regain_access` is expressed
   by Meta in minutes and must be converted to seconds before persistence.
5. Bind one credential to two shops and generate simultaneous traffic. Verify
   no concurrent platform calls for that credential and no cross-shop rows.
6. Bind two credentials to one shop. Make one fail and one succeed. The success
   must remain terminal while only the failed route retries.
7. Deliver the same Shopify webhook ID twice. The second delivery must return
   success without creating another event.
8. Send browser Purchase and `orders/paid` in both arrival orders. They must
    converge on the checkout token when Shopify supplies it and retain the richer
    match/custom data. The browser-only state must remain `AWAITING_PAYMENT` and
    must not be claimable by a worker.
9. Exhaust BullMQ job attempts. A later watchdog rescue must use a new job ID
   and reclaim only ledger rows whose `next_attempt_at` is due.
10. Run `npm run check`, `npm test`, `npm audit --audit-level=moderate`,
    `npm run migrate`, and `npm run doctor`.
11. Burst more than `WORKER_EVENT_BATCH_SIZE` events into one shop, then add
    traffic for at least two other shops. Continuations must drain every shop;
    the rescue cursor must not repeatedly select only the lowest shop ID.
12. Inject a queue job containing event IDs from two shops. The worker must
    reload and mutate only rows matching the job's `shopId`.
13. Run retention cleanup while ingestion and delivery remain active. Terminal
    rows should age out, pending rows must survive, and inserts must stay live.
14. Hold a route in `RETRYABLE_FAILED` with a future `next_attempt_at`. Verify
    continuation jobs stop until the retry becomes due instead of spinning.
15. Ingest events before adding any Pixel route. They must remain `PENDING`;
    adding a route must wake and deliver them without manual replay.
16. Make a DLQ event fail on two routes after a third route succeeds. Manual
    replay must reset only the two active failed routes and never resend the
    successful route.
17. Interrupt the storefront while a fetch is in flight and then reload it.
    The event must still exist in browser storage and retry with the same ID.
18. Force `CREATE INDEX CONCURRENTLY` to leave an invalid index, then rerun the
    migration. It must drop only the invalid index and rebuild it successfully.
19. Attempt to insert an `event_deliveries` row that combines one shop's event
    with another shop's route. PostgreSQL must reject it with SQLSTATE `23514`.
20. Kill a worker after its last route ledger update but before the parent event
    summary update. The reconciliation pass must convert the stranded `PENDING`
    summary to `SUCCESS`, `PARTIAL_FAILED`, or `FAILED` without resending a route.
21. Redeliver an `orders/paid` webhook after a Purchase has reached each terminal
    state. None may transition back to `PENDING`; delivery attempts must not grow.
22. Send paid orders with missing, POS, mobile-app, draft-order, and unknown
    `source_name` values. None may create a website Purchase unless the exact
    verified source is explicitly added to `SHOPIFY_WEB_ORDER_SOURCES`.
23. Start the admin service with external network access blocked. `/admin`, its
    CSS, and its pinned Vue runtime must still load from authenticated local
    routes with no CDN dependency.

## Official references used

- Meta Graph API v25.0 changelog:
  https://developers.facebook.com/docs/graph-api/changelog/version25.0/
- Meta Conversions API event deduplication:
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/deduplicate-pixel-and-server-events
- Meta Conversions API parameters:
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters
- Meta Graph API rate limits:
  https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- Meta Graph API error handling:
  https://developers.facebook.com/docs/graph-api/guides/error-handling/
- Shopify Web Pixels API:
  https://shopify.dev/docs/api/web-pixels-api
- Shopify standard customer events:
  https://shopify.dev/docs/api/web-pixels-api/standard-events
- Shopify webhook verification and duplicate handling:
  https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
- Shopify order source attribution:
  https://shopify.dev/docs/api/admin-graphql/latest/objects/Order
- BullMQ retry and backoff:
  https://docs.bullmq.io/guide/retrying-failing-jobs
- BullMQ production Redis guidance:
  https://docs.bullmq.io/guide/going-to-production
- BullMQ connection guidance:
  https://docs.bullmq.io/guide/connections
- TikTok event deduplication:
  https://ads.tiktok.com/help/article/event-deduplication?lang=en
- Redis distributed locks:
  https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/
- PostgreSQL row locking and `SKIP LOCKED`:
  https://www.postgresql.org/docs/current/sql-select.html
- PostgreSQL transaction isolation and `ON CONFLICT`:
  https://www.postgresql.org/docs/current/transaction-iso.html
- PostgreSQL partial indexes:
  https://www.postgresql.org/docs/current/indexes-partial.html
- PostgreSQL routine vacuuming:
  https://www.postgresql.org/docs/current/routine-vacuuming.html
