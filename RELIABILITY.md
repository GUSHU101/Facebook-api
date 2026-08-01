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
17. Retention cleanup deletes terminal rows and payment candidates that remain
    unconfirmed beyond `EVENT_RETENTION_DAYS` in bounded `SKIP LOCKED` batches.
    Delivery-ready `PENDING` rows are never deleted. This bounds abandoned
    checkout growth without weakening the payment-confirmation window.
18. Worker continuation and rescue queries select only active routes that are
    missing a ledger row or whose retry/expired lease is due. Platform cooldowns
    therefore cannot create an immediate empty-job loop.
19. Events received before a shop has an active route remain `PENDING` in
    PostgreSQL. Creating or reactivating a route wakes that shop's outbox.
20. Manual dead-letter replay first uses the same row-locked merge path as live
    ingestion, then resets only `FAILED_PERMANENT` rows on currently active
    routes. Successful/inactive routes are never resent, and an unconfirmed
    Purchase can never be promoted by replay.
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
29. Attribution cache key classes have different schemas. Browser/session keys
    contain only device, click, page, and session signals; hashed customer and
    checkout/cart identity is restricted to commerce keys. Customer
    `external_id` is never used as a browser key, preventing cross-device cookie
    inheritance, and cache recency timestamps are server-generated.
30. Duplicate event payloads merge under a PostgreSQL row lock. Match-data
    arrays are unioned, while an HMAC-confirmed payment payload wins for order
    value, order ID, and event time. EMQ is recalculated from the unioned identity
    set. A late browser retry cannot downgrade an already confirmed Purchase.
31. Before contending for a shared credential lease, a worker verifies that the
    specific route has a due, claimable delivery. Successful, terminal, leased,
    and future-retry rows do not amplify queue work or create false busy retries.
32. Meta-bound identifiers pass a final outbound sanitizer. Hashes must be
    lowercase SHA-256, IP addresses must parse as IPv4/IPv6, and `fbp`/`fbc`
    must use Meta's cookie format. Browser JSON cannot override the trusted
    request IP, while Shopify webhook infrastructure is never mistaken for the shopper.
33. A confirmed item-level `contents` snapshot is authoritative for
    `content_ids`; older cart IDs are not unioned into Purchase. Meta-only
    parameter scope is enforced before sending: `num_items` is retained only
    for InitiateCheckout and `search_string` only for Search.
34. Generated event IDs and outbound order IDs are store-namespaced. This
    prevents two shops sharing one Meta Dataset from colliding on a locally
    identical Shopify event, checkout, or order identifier.
35. Browser queue duplicates merge richer later fields while preserving the
    earliest occurrence time. Under storage pressure, conversion-funnel events
    outrank old page views, so the queue does not discard Purchase first.
36. Explicit hash fields accept only valid SHA-256 values. Raw identifiers are
    normalized through a separate bounded scalar path, preventing malformed or
    deeply nested input from becoming plausible but unmatchable hashes.
37. Dispatch coalescing detects a retained terminal BullMQ job and creates a
    unique follow-up, closing the same-second arrival gap without removing the
    PostgreSQL rescue fallback.
38. Verified Shopify paid-order webhooks are committed to a PostgreSQL inbox
    before acknowledgment. Leased `SKIP LOCKED` processing, bounded retries,
    and a scheduler recover work after crashes without extending Shopify's
    five-second response path.
39. Platform outcomes carry internal `event_store_id` values. Public event IDs
    remain stable deduplication keys but cannot accidentally update a different
    event name that reused the same external identifier.
40. Delivery routes are read through ledger rows created for that worker
    snapshot. The exact route IDs are persisted on `event_store`; aggregate
    success requires a ledger row for every snapshotted route. A concurrently
    activated route belongs to a later snapshot and cannot cause a false
    terminal parent state or silently rewrite an in-flight event contract.
41. Delivery leases, pacing, and Redis cooldowns are keyed by a SHA-256 scope
    of platform plus decrypted access token. The scope and cooldown are also
    persisted on every matching credential row, so database rows sharing one
    token retain the same throttle after Redis or process restarts.
42. Backup and restore scripts parse dotenv without shell evaluation. Backups
    are written to private temporary files, structurally validated and only then
    atomically published. Restore validates the archive before maintenance,
    stops/drains writers, restores in one database transaction, validates the
    migrated database and credential key, then restarts only the PM2 processes
    it actually stopped. A failed restore or restart remains in maintenance mode.
43. Meta errors are explicitly scoped. HTTP 401/403 and credential,
    permission, application, or missing-object codes such as 10, 102, 190,
    200, 803, and 2500 never enter recursive event isolation. Unknown
    permanent errors fail closed; only an HTTP 400/code 100 failure carrying an
    explicit `data[index]` blame path is eligible for bounded splitting.
44. Bounded Meta isolation returns three disjoint outcomes: accepted events,
    confirmed permanent failures, and unresolved deferred events. Exhausting
    the request budget never discards the first two groups, and a transient
    child failure stops sibling probes so platform cooldown can begin.
45. Pixel removal is archival, not physical deletion. Active routes are
    disabled, unfinished ledgers become terminal with `ROUTE_ARCHIVED`, unused
    credentials are erased, and restrictive foreign keys preserve historical
    routes and deliveries.
46. Shopify order reconciliation paginates both orders and every order's line
    items. Recovered Purchase time uses `processedAt` (then `createdAt`), while
    `updatedAt` is only the moving scan index. Missing fields that the current
    Admin GraphQL Order schema cannot supply, including order-level user agent,
    remain absent instead of being fabricated.
47. Redis and process-local ingestion limiters charge the same weight: the
    larger of actual event count and one unit per 16 KiB of request body.
    During a Redis partition, a 50-event HTTP batch consumes at least 50 local
    units, an oversized single event cannot bypass protection by counting as
    one, and the bounded local key map cannot grow without limit.
48. `/readyz` returns HTTP 503 whenever Redis cannot support immediate BullMQ
    dispatch; `/healthz` remains the liveness endpoint. This prevents deployers
    from treating durable-only degraded mode as fully ready.
49. The generated Shopify custom pixel sends each Meta event through two
    independently failing channels. Browser `trackSingle`/`trackSingleCustom`
    and server CAPI use the same event name and store-scoped event ID; a browser
    SDK load or call failure cannot prevent PostgreSQL ingestion.
50. Every configured Meta Dataset is initialized once and targeted explicitly.
    A multi-pixel shop cannot turn a generic browser `track` call into an
    accidental broadcast, and duplicate Shopify callbacks are suppressed before
    either browser or server delivery is attempted.
51. Browser Pixel routing refreshes from a token-validated, server-authoritative
    configuration endpoint every 60 seconds. The endpoint returns only active
    Facebook routes, uses a bounded five-second process cache, and never accepts
    client-supplied delivery targets. A 500 ms first-event wait normally closes
    the stale embedded-route window; network failure falls back to the generated
    route list without delaying CAPI durability indefinitely.
52. The Meta browser SDK loader makes at most three attempts with bounded
    backoff. While the SDK is unavailable its queue is capped at 500 calls,
    discarding low-value page/browsing events before Purchase and preserving
    Pixel initialization calls whenever possible. Browser memory cannot grow
    without limit while server CAPI remains active.
53. New Shopify customer-event code uses the documented `event.clientId` and
    no longer reads `_shopify_y` or `_shopify_s`, which Shopify stopped setting
    in 2026. Server parsing retains legacy compatibility for already-stored and
    webhook-provided historical attributes. Oversized or whitespace-containing
    `fbclid` values cannot be written into `_fbc`.
54. Browser and server Purchase `order_id` values use the same shop namespace.
    Two shops sharing a Dataset cannot collide merely because both Shopify
    stores generated order `#1001`; their event IDs, order IDs, external IDs,
    aliases, outbox rows, and route ledgers remain tenant-scoped. Identifiers
    longer than the persistence limit are shortened with the same SHA-256
    suffix before both browser and CAPI delivery, preserving cross-channel
    deduplication instead of letting the server silently rewrite only one side.
55. Shared credential configuration is version-fenced. A worker must observe
    the same active `credential_version` before sending and before committing a
    failure. Token rotation during an in-flight request converts an unconfirmed
    old result into `LOCAL_CREDENTIAL_CHANGED` and reloads the current Token;
    stale failures cannot poison the replacement credential's cooldown state.
56. Updating a shared Pixel Token reopens only credential/permission failures
    for that Pixel and wakes every active routed shop. Confirmed successes and
    event-specific permanent failures remain immutable, preventing both data
    loss after credential repair and indiscriminate replay.
57. Meta Test Event Code belongs to `shop_pixel_routes`, not the shared
    credential. One shop can be tested without silently placing every other
    shop using the Dataset into test mode. Test codes have a bounded TTL, and
    production diagnostics fail while an active route is still in diagnostic
    test mode. Dataset Quality polling also uses
    the exact same credential-scope lease and cooldown as production delivery,
    so observability traffic cannot bypass shared Meta pacing.
58. Browser Pixel execution remains subordinate to Shopify Customer Events
    consent and sandbox controls. The integration never uses theme DOM scraping
    or treats browser delivery as the Purchase payment authority; verified
    `orders/paid` remains the server-side Purchase gate and fallback.
59. Commerce payload construction no longer discards every line after a fixed
    200-item boundary. Shopify reconciliation still paginates all line items;
    the final event retains up to the explicit `COMMERCE_ITEM_LIMIT` (1000 by
    default, at most 5000) and records a truncation diagnostic if an extreme
    order exceeds that operational safety boundary.
60. Admin authentication and brute-force limiting execute before JSON parsing,
    and every authenticated admin page/API response defaults to `private,
    no-store`. Unauthenticated oversized bodies cannot consume the full admin
    parser allowance, and browsers/proxies cannot retain operational customer
    data after logout.
61. Cron maintenance handlers are single-flight within each API process. Cron
    work, webhook-triggered immediate inbox drains, and manual privacy retries
    share one tracked background-task group. Graceful shutdown stops new work
    synchronously and waits for every active handler before closing PostgreSQL,
    Redis, or BullMQ; the existing shutdown deadline remains the final bound.
62. The scheduled Shopify webhook audit uses a renewable distributed Redis
    lock, so horizontally scaled API instances do not duplicate the same Admin
    API inspection run. Per-shop reconciliation and durable inbox drains retain
    their PostgreSQL advisory-lock or `SKIP LOCKED` coordination.
63. Worker health heartbeats are single-flight and a graceful Worker shutdown
    waits for the current heartbeat before closing Redis. A slow Redis command
    cannot create overlapping heartbeat promises or race connection teardown.
64. Dataset Quality requests use Meta's current `fields=web{...}` contract.
    Official `event_match_quality.composite_score` and its feedback objects are
    retained; a valid v26 response cannot be misclassified as empty merely
    because the parser expected a legacy score property.
65. `partner_agent` is emitted only at the CAPI request-body root and only when
    an operator configures the identifier agreed with Meta. Dataset Quality's
    optional `agent_name` filter is separately validated and normalized.
66. Shopify customer lifecycle is mapped only to Meta's documented
    `custom_data.customer_segmentation` values. Unknown lifecycle values and
    invalid segmentation enums are removed before transport.
67. Browser advanced matching initializes each Dataset once with normalized
    customer values from Shopify's event/init context. Pixel performs browser
    hashing; CAPI sends the corresponding SHA-256 values, while tenant-scoped
    `external_id` prevents cross-shop collision on a shared Dataset.

## Storefront ingestion abuse boundary

The generated shop token is a public routing capability embedded in Shopify's
custom pixel; it must not be treated as user authentication. The default
`PIXEL_RATE_LIMIT_PER_MINUTE=600` provides a generous per-shop/per-IP ceiling,
and both Redis and emergency process-local enforcement count actual events,
not HTTP envelopes. The browser retries HTTP 429 with stable event IDs. Set it to `0` only when
a distributed CDN/WAF limiter is verified in front of every API instance.

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
    match/custom data. Hash arrays must be unioned and confirmed payment fields
    must win regardless of arrival order. The browser-only state must remain
    `AWAITING_PAYMENT` and must not be claimable by a worker.
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
    rows and expired unconfirmed payment candidates should age out, delivery-ready
    pending rows must survive, and inserts must stay live.
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
24. Cache attribution for one customer on device A, then submit the same
    `external_id` from device B without a browser client/session key. Device B
    must not inherit device A's `fbp`, `fbc`, IP, or user agent.
25. Replay an unconfirmed Purchase dead letter. It must remain
    `AWAITING_PAYMENT`; replay cannot create a delivery claim until a verified
    paid webhook arrives.
26. Hash `Valéry`, a CJK name, a phone with international leading zeroes, and a
    US ZIP+4 in both the generated browser pixel and the server normalizer. The
    resulting hashes must match their official normalized forms exactly.
27. Merge an old cart containing a removed item with a confirmed paid order.
    The outbound Purchase `contents` and `content_ids` must contain only the
    confirmed order items.
28. Return Meta HTTP 403/code 200, HTTP 400/code 10, and code 803 for a
    100-event request. Exactly one platform call must occur and the full batch
    must become a request-level permanent failure.
29. Exhaust `FACEBOOK_ISOLATION_MAX_REQUESTS` after one child branch succeeds.
    The successful branch must remain `SUCCESS`, confirmed bad events must
    remain terminal, and only the unresolved branch may retry.
30. Activate another route while a worker holds the route-snapshot advisory
    lock. The event must complete exactly the persisted snapshot; later events
    must include the newly active route.
31. Archive a Pixel with in-progress deliveries. The token must be cleared,
    unfinished ledger rows must become `ROUTE_ARCHIVED`, historical successful
    rows must remain queryable, and a physical `DELETE FROM pixels` must fail.
32. Reconcile a paid order with more than 250 line items. Every page must be
    present in `contents`, and Purchase time must equal `processedAt`, not a
    later order edit's `updatedAt`.
33. Stop Redis and send repeated 50-event requests against a 600-event local
    ceiling. The thirteenth request must receive 429, and `/readyz` must return
    HTTP 503 while `/healthz` remains live.
34. Generate a shop with two Meta Datasets and trigger every supported Shopify
    event. Each Dataset must receive exactly one targeted browser call and one
    CAPI ledger using the same `event_name`/`eventID`; custom events must use
    `trackSingleCustom`.
35. Block `connect.facebook.net` or force `fbq` to throw. The corresponding
    event must still be persisted and delivered through CAPI without changing
    its event ID.
36. Fail the first Meta SDK download, then restore the network. A later bounded
    retry must inject the SDK again; more than 500 queued browser calls must
    retain Pixel initialization and Purchase while shedding old PageView calls.
37. Change a shop from two active Meta routes to a different route without
    replacing its Shopify custom-pixel code. After configuration refresh, only
    the new Dataset may receive targeted browser calls; CAPI must continue to
    derive its targets solely from PostgreSQL.
38. Bind two shops to the same Pixel, send the same Shopify-local event and
    order identifiers from both shops, and verify their store-scoped IDs,
    events, aliases, attribution, and delivery ledgers remain distinct. A
    cross-shop event/route ledger insert must fail with SQLSTATE `23514`.
39. Give only one of two shared-Pixel routes a Meta Test Event Code. Only that
    route's CAPI request may contain the code; the second shop and browser
    Pixel calls must remain unaffected.
40. Rotate a shared Pixel Token while one worker is in flight. An unconfirmed
    old-token failure must become `LOCAL_CREDENTIAL_CHANGED`, must not consume
    a platform attempt under the replacement version, and all active routed
    shops with recoverable credential failures must resume.
41. Start Dataset Quality refresh while a shared-Pixel delivery owns the
    credential lease. The refresh must defer rather than bypassing the lease,
    and both paths must honor the same persisted cooldown and usage state.
42. Return a Dataset Quality v26 payload whose only EMQ score property is
    `event_match_quality.composite_score`. The snapshot must be `SUCCESS`, must
    retain feedback/coverage/freshness/ACR, and must not fall back to `EMPTY`.
43. Configure `META_PARTNER_AGENT` and inspect a real Meta transport request.
    It must appear once beside `data`, never inside a ServerEvent; with the
    variable empty, the property must be absent.
44. Trigger a first-order checkout with customer fields. Browser Pixel init
    must receive normalized advanced-matching values, CAPI must receive their
    hashes, and both channels must share the identical store-scoped event ID.
45. Trigger AddToCart, InitiateCheckout, PageView, and Search. Browser and CAPI
    must retain `num_items` only for InitiateCheckout and `search_string` only
    for Search.

## Official references used

- Meta Marketing API changelog and available versions:
  https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/
- Meta Conversions API event deduplication:
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/deduplicate-pixel-and-server-events
- Meta Conversions API parameters:
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters
- Meta server event parameters:
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/server-event
- Meta customer information parameters:
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/customer-information-parameters
- Meta custom data parameters:
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/custom-data
- Meta Dataset Quality API:
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/dataset-quality-api
- Meta platform setup and `partner_agent`:
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/set-up-conversions-api-as-a-platform
- Meta Pixel advanced matching:
  https://developers.facebook.com/docs/facebook-pixel/advanced/advanced-matching
- Meta fbp/fbc parameters:
  https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/fbp-and-fbc
- Meta Graph API rate limits:
  https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- Meta Graph API error handling:
  https://developers.facebook.com/docs/graph-api/guides/error-handling/
- Meta guidance for using Conversions API with the Pixel:
  https://www.facebook.com/business/help/AboutConversionsAPI
- Meta Business Tools Terms and consent requirements:
  https://www.facebook.com/legal/terms/businesstools/preview
- Shopify Web Pixels API:
  https://shopify.dev/docs/api/web-pixels-api
- Shopify Web Pixels standard API (`analytics`, `browser`, `init`, privacy):
  https://shopify.dev/docs/api/web-pixels-api/standard-api
- Shopify custom pixels and Lax sandbox:
  https://help.shopify.com/en/manual/promoting-marketing/pixels/custom-pixels
- Shopify custom Meta pixel SDK/event example:
  https://help.shopify.com/en/manual/promoting-marketing/pixels/custom-pixels/code
- Shopify pixel sandbox behavior and consent:
  https://help.shopify.com/en/manual/promoting-marketing/pixels/overview
- Shopify custom-pixel testing and consent diagnostics:
  https://help.shopify.com/en/manual/promoting-marketing/pixels/custom-pixels/testing
- Shopify `checkout_completed` semantics:
  https://shopify.dev/docs/api/web-pixels-api/standard-events/checkout_completed
- Shopify `_shopify_y`/`_shopify_s` deprecation and `event.clientId` replacement:
  https://shopify.dev/changelog/shopifyy-and-shopifys-cookies-will-no-longer-be-set
- Shopify theme app extension checkout restriction:
  https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
- Shopify standard customer events:
  https://shopify.dev/docs/api/web-pixels-api/standard-events
- Shopify webhook verification and duplicate handling:
  https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
- Shopify order source attribution:
  https://shopify.dev/docs/api/admin-graphql/latest/objects/Order
- Shopify GraphQL cursor pagination:
  https://shopify.dev/docs/api/usage/pagination-graphql
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
