const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const { Pool } = require('pg');

const enabled = process.env.RUN_INTEGRATION_TESTS === '1';

async function waitForReady(url, child) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
        try {
            const response = await fetch(url);
            if (response.status === 200) return;
        } catch (error) {
            // Server socket is not accepting connections yet.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('server did not become ready');
}

async function waitForStatus(url, expectedStatus, child) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
        try {
            const response = await fetch(url);
            if (response.status === expectedStatus) return response;
        } catch (error) {
            // Server socket is not accepting connections yet.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`server did not return HTTP ${expectedStatus}`);
}

async function waitForCondition(check, description, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    while (Date.now() < deadline) {
        lastValue = await check();
        if (lastValue) return lastValue;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${description}; last value=${JSON.stringify(lastValue)}`);
}

async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('storefront ingestion reaches the real worker, Meta transport, ledger, and paid Purchase merge', { skip: !enabled }, async () => {
    const apiPort = Number(process.env.INTEGRATION_DELIVERY_PORT || 39093);
    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    const suffix = crypto.randomUUID();
    const shopDomain = `delivery-${suffix}.myshopify.com`;
    const appSecret = `delivery_webhook_secret_${crypto.randomBytes(18).toString('hex')}`;
    const metaPixelId = `9${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const metaToken = `integration-meta-token-${suffix}`;
    const metaRequests = [];
    let transientEventId;
    const transientAttempts = new Map();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const fakeMeta = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            const body = JSON.parse(rawBody || '{}');
            const containsTransientEvent = Array.isArray(body.data)
                && body.data.some(event => event.event_id === transientEventId);
            const transientAttempt = containsTransientEvent
                ? (transientAttempts.get(transientEventId) || 0) + 1
                : 0;
            if (containsTransientEvent) transientAttempts.set(transientEventId, transientAttempt);
            const simulatedStatus = containsTransientEvent && transientAttempt === 1 ? 503 : 200;
            metaRequests.push({
                method: req.method,
                url: req.url,
                authorization: req.headers.authorization,
                body,
                simulatedStatus,
            });
            if (simulatedStatus === 503) {
                res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
                res.end(JSON.stringify({ error: { message: 'simulated transient Meta outage', code: 2, is_transient: true } }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    events_received: Array.isArray(body.data) ? body.data.length : 0,
                    fbtrace_id: `trace-${metaRequests.length}`,
                }));
            }
        });
    });
    await new Promise((resolve, reject) => {
        fakeMeta.once('error', reject);
        fakeMeta.listen(0, '127.0.0.1', resolve);
    });
    const metaPort = fakeMeta.address().port;
    const runtimeEnv = {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(apiPort),
        FB_GRAPH_BASE_URL: `http://127.0.0.1:${metaPort}`,
        REQUIRE_WORKER_HEARTBEAT: 'false',
        PURCHASE_SETTLE_MS: '50',
        BATCH_CRON: '*/1 * * * * *',
        WATCHDOG_CRON: '*/1 * * * * *',
        SHOPIFY_WEBHOOK_INBOX_CRON: '*/1 * * * * *',
        SHOP_CONTINUATION_DELAY_MS: '25',
        DELIVERY_RETRY_BASE_SECONDS: '1',
        QUEUE_BACKOFF_MS: '100',
    };
    const cwd = require('node:path').join(__dirname, '..');
    const server = spawn(process.execPath, ['src/server.js'], {
        cwd,
        env: runtimeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const worker = spawn(process.execPath, ['src/worker.js'], {
        cwd,
        env: runtimeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    for (const child of [server, worker]) {
        child.stdout.on('data', chunk => { diagnostics += chunk.toString(); });
        child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
    }
    const authorization = `Basic ${Buffer.from(
        `${process.env.ADMIN_USERNAME}:${process.env.ADMIN_PASSWORD}`,
    ).toString('base64')}`;
    const adminHeaders = {
        Authorization: authorization,
        'Content-Type': 'application/json',
        'X-CAPI-Admin-Request': '1',
    };
    let shopId;
    let secondShopId;
    let pixelId;
    try {
        await waitForReady(`${apiOrigin}/readyz`, server);

        const rejectedAdminMutation = await fetch(`${apiOrigin}/api/admin/shops`, {
            method: 'POST',
            headers: { Authorization: authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify({ shop_domain: shopDomain, app_secret: appSecret }),
        });
        assert.equal(rejectedAdminMutation.status, 403);

        const shopResponse = await fetch(`${apiOrigin}/api/admin/shops`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ shop_domain: shopDomain, app_secret: appSecret }),
        });
        assert.equal(shopResponse.status, 201, await shopResponse.text());
        const shopsResponse = await fetch(`${apiOrigin}/api/admin/shops`, {
            headers: { Authorization: authorization },
        });
        const shopsBody = await shopsResponse.json();
        assert.equal(shopsResponse.status, 200, JSON.stringify(shopsBody));
        const shop = shopsBody.find(item => item.shop_domain === shopDomain);
        assert.ok(shop?.id);
        assert.match(shop.ingest_token, /^[a-f0-9]{64}$/);
        shopId = Number(shop.id);

        const pixelResponse = await fetch(`${apiOrigin}/api/admin/pixels`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({
                shop_id: shopId,
                shop_ids: [shopId],
                platform: 'facebook',
                name: 'integration-meta',
                pixel_id: metaPixelId,
                access_token: metaToken,
                test_event_code: 'TEST-E2E',
            }),
        });
        assert.equal(pixelResponse.ok, true, await pixelResponse.text());
        ({ rows: [{ id: pixelId }] } = await pool.query(
            'SELECT id FROM pixels WHERE platform = $1 AND pixel_id = $2',
            ['facebook', metaPixelId],
        ));

        const eventHeaders = {
            'Content-Type': 'application/json',
            'User-Agent': 'CAPI-E2E/1.0',
            'X-CAPI-Ingest-Token': shop.ingest_token,
        };
        const commonEvent = {
            shop_domain: shopDomain,
            schema_version: '2.0',
            source_version: 'shopify-pixel-v17',
            source_provider: 'shopify_web_pixels',
            timestamp: new Date().toISOString(),
            url: `https://${shopDomain}/products/integration?utm_source=e2e&email=remove@example.com`,
            client_id: `client-${suffix}`,
        };
        const invalidMapping = await fetch(`${apiOrigin}/api/pixel-event`, {
            method: 'POST',
            headers: eventHeaders,
            body: JSON.stringify({
                ...commonEvent,
                event_name: 'AddToCart',
                event_id: `${shopDomain}:invalid-mapping`,
                source_event_name: 'page_viewed',
            }),
        });
        assert.equal(invalidMapping.status, 422, await invalidMapping.text());

        const pageViewId = `${shopDomain}:page-${suffix}`;
        const pageViewPayload = {
            ...commonEvent,
            event_name: 'PageView',
            event_id: pageViewId,
            source_event_name: 'page_viewed',
            source_event_id: `source-page-${suffix}`,
        };
        const firstIngest = await fetch(`${apiOrigin}/api/pixel-event`, {
            method: 'POST', headers: eventHeaders, body: JSON.stringify(pageViewPayload),
        });
        assert.equal(firstIngest.status, 202, await firstIngest.text());
        const duplicateIngest = await fetch(`${apiOrigin}/api/pixel-event`, {
            method: 'POST', headers: eventHeaders, body: JSON.stringify(pageViewPayload),
        });
        assert.ok([200, 202].includes(duplicateIngest.status), await duplicateIngest.text());

        const pageViewLedger = await waitForCondition(async () => {
            const { rows } = await pool.query(
                `SELECT event.status, event.request_payload, delivery.status AS delivery_status,
                        delivery.platform_response
                 FROM event_store event
                 JOIN event_deliveries delivery ON delivery.event_store_id = event.id
                 WHERE event.shop_id = $1 AND event.event_name = 'PageView' AND event.event_id = $2`,
                [shopId, pageViewId],
            );
            return rows[0]?.status === 'SUCCESS' ? rows[0] : null;
        }, 'PageView SUCCESS ledger');
        assert.equal(pageViewLedger.delivery_status, 'SUCCESS');
        assert.equal(pageViewLedger.platform_response.accepted_event, true);
        assert.doesNotMatch(pageViewLedger.request_payload.event_source_url, /email=/i);

        transientEventId = `${shopDomain}:transient-${suffix}`;
        const transientResponse = await fetch(`${apiOrigin}/api/pixel-event`, {
            method: 'POST',
            headers: eventHeaders,
            body: JSON.stringify({
                ...commonEvent,
                event_name: 'ViewContent',
                event_id: transientEventId,
                source_event_name: 'product_viewed',
                source_event_id: `source-transient-${suffix}`,
                value: 9.99,
                currency: 'USD',
                content_ids: ['variant-transient'],
                contents: [{ id: 'variant-transient', quantity: 1, item_price: 9.99 }],
                content_type: 'product',
            }),
        });
        assert.equal(transientResponse.status, 202, await transientResponse.text());
        const transientLedger = await waitForCondition(async () => {
            const { rows } = await pool.query(
                `SELECT event.status, delivery.status AS delivery_status,
                        delivery.attempt_count, delivery.platform_response
                 FROM event_store event
                 JOIN event_deliveries delivery ON delivery.event_store_id = event.id
                 WHERE event.shop_id = $1 AND event.event_name = 'ViewContent' AND event.event_id = $2`,
                [shopId, transientEventId],
            );
            return rows[0]?.status === 'SUCCESS' ? rows[0] : null;
        }, 'transient Meta failure retry SUCCESS ledger', 30_000);
        assert.equal(transientLedger.delivery_status, 'SUCCESS');
        assert.ok(Number(transientLedger.attempt_count) >= 2);
        assert.equal(transientLedger.platform_response.accepted_event, true);
        const transientMetaRequests = metaRequests.filter(request => (
            (request.body.data || []).some(event => event.event_id === transientEventId)
        ));
        assert.ok(transientMetaRequests.some(request => request.simulatedStatus === 503));
        assert.equal(transientMetaRequests.filter(request => request.simulatedStatus === 200).length, 1);

        const secondShopDomain = `delivery-second-${suffix}.myshopify.com`;
        const secondShopResponse = await fetch(`${apiOrigin}/api/admin/shops`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({
                shop_domain: secondShopDomain,
                app_secret: `second_webhook_secret_${crypto.randomBytes(18).toString('hex')}`,
            }),
        });
        assert.equal(secondShopResponse.status, 201, await secondShopResponse.text());
        const refreshedShopsResponse = await fetch(`${apiOrigin}/api/admin/shops`, {
            headers: { Authorization: authorization },
        });
        const refreshedShops = await refreshedShopsResponse.json();
        assert.equal(refreshedShopsResponse.status, 200, JSON.stringify(refreshedShops));
        const secondShop = refreshedShops.find(item => item.shop_domain === secondShopDomain);
        assert.ok(secondShop?.id);
        secondShopId = Number(secondShop.id);

        const sharedPixelResponse = await fetch(`${apiOrigin}/api/admin/pixels`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({
                shop_id: shopId,
                shop_ids: [shopId, secondShopId],
                platform: 'facebook',
                name: 'integration-shared-meta',
                pixel_id: metaPixelId,
                access_token: metaToken,
                test_event_code: 'TEST-E2E',
            }),
        });
        assert.equal(sharedPixelResponse.ok, true, await sharedPixelResponse.text());
        const secondPageViewId = `${secondShopDomain}:page-${suffix}`;
        const secondPageResponse = await fetch(`${apiOrigin}/api/pixel-event`, {
            method: 'POST',
            headers: {
                ...eventHeaders,
                'X-CAPI-Ingest-Token': secondShop.ingest_token,
            },
            body: JSON.stringify({
                ...commonEvent,
                shop_domain: secondShopDomain,
                url: `https://${secondShopDomain}/products/shared`,
                client_id: `second-client-${suffix}`,
                event_name: 'PageView',
                event_id: secondPageViewId,
                source_event_name: 'page_viewed',
                source_event_id: `second-source-page-${suffix}`,
            }),
        });
        assert.equal(secondPageResponse.status, 202, await secondPageResponse.text());
        await waitForCondition(async () => {
            const { rows } = await pool.query(
                `SELECT event.status, delivery.status AS delivery_status
                 FROM event_store event
                 JOIN event_deliveries delivery ON delivery.event_store_id = event.id
                 WHERE event.shop_id = $1 AND event.event_id = $2`,
                [secondShopId, secondPageViewId],
            );
            return rows[0]?.status === 'SUCCESS' && rows[0]?.delivery_status === 'SUCCESS' ? rows[0] : null;
        }, 'second shop shared-Pixel PageView SUCCESS ledger');
        const { rows: [sharedRouteCount] } = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM shop_pixel_routes
             WHERE pixel_id = $1 AND shop_id = ANY($2::int[]) AND status = 'active'`,
            [pixelId, [shopId, secondShopId]],
        );
        assert.equal(sharedRouteCount.count, 2);

        const checkoutToken = `checkout-${suffix}`;
        const purchaseId = `${shopDomain}:${checkoutToken}`;
        const browserPurchase = await fetch(`${apiOrigin}/api/pixel-event`, {
            method: 'POST',
            headers: eventHeaders,
            body: JSON.stringify({
                ...commonEvent,
                event_name: 'Purchase',
                event_id: purchaseId,
                source_event_name: 'checkout_completed',
                source_event_id: `source-purchase-${suffix}`,
                checkout_token: checkoutToken,
                order_id: `${shopDomain}:90071992547409931234`,
                value: 12.5,
                currency: 'USD',
                content_ids: ['variant-2'],
                contents: [{ id: 'variant-2', quantity: 1, item_price: 12.5 }],
                content_type: 'product',
            }),
        });
        const browserPurchaseBody = await browserPurchase.json();
        assert.equal(browserPurchase.status, 202, JSON.stringify(browserPurchaseBody));
        assert.equal(browserPurchaseBody.awaiting_payment_confirmation, true);

        const paidPayload = Buffer.from(JSON.stringify({
            id: '90071992547409931234',
            name: '#E2E',
            source_name: 'web',
            financial_status: 'paid',
            processed_at: new Date().toISOString(),
            checkout_token: checkoutToken,
            total_price: '12.50',
            currency: 'USD',
            line_items: [{ id: '1', variant_id: '2', quantity: 1, price: '12.50' }],
        }));
        const paidHeaders = {
            'Content-Type': 'application/json',
            'X-Shopify-Shop-Domain': shopDomain,
            'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', appSecret).update(paidPayload).digest('base64'),
            'X-Shopify-Topic': 'orders/paid',
            'X-Shopify-Webhook-Id': `paid-${suffix}`,
            'X-Shopify-Triggered-At': new Date().toISOString(),
        };
        for (let replay = 0; replay < 2; replay += 1) {
            const paidResponse = await fetch(`${apiOrigin}/api/webhook/orders/paid`, {
                method: 'POST', headers: paidHeaders, body: paidPayload,
            });
            assert.equal(paidResponse.status, 200, await paidResponse.text());
        }

        const purchaseLedger = await waitForCondition(async () => {
            const { rows } = await pool.query(
                `SELECT event.status, event.request_payload, delivery.status AS delivery_status,
                        delivery.platform_response
                 FROM event_store event
                 JOIN event_deliveries delivery ON delivery.event_store_id = event.id
                 WHERE event.shop_id = $1 AND event.event_name = 'Purchase' AND event.event_id = $2`,
                [shopId, purchaseId],
            );
            return rows[0]?.status === 'SUCCESS' ? rows[0] : null;
        }, 'paid Purchase SUCCESS ledger', 30_000);
        assert.equal(purchaseLedger.delivery_status, 'SUCCESS');
        assert.equal(purchaseLedger.request_payload._payment_confirmed, true);
        assert.equal(purchaseLedger.platform_response.accepted_event, true);

        const deliveredEvents = metaRequests
            .filter(request => request.simulatedStatus === 200)
            .flatMap(request => request.body.data || []);
        assert.equal(deliveredEvents.filter(event => event.event_name === 'PageView').length, 2);
        assert.equal(deliveredEvents.filter(event => event.event_name === 'ViewContent').length, 1);
        assert.equal(deliveredEvents.filter(event => event.event_name === 'Purchase').length, 1);
        assert.ok(metaRequests.every(request => request.authorization === `Bearer ${metaToken}`));
        assert.ok(metaRequests.every(request => request.url === `/v26.0/${metaPixelId}/events`));
        assert.ok(metaRequests.every(request => request.body.test_event_code === 'TEST-E2E'));
    } catch (error) {
        let ledgerDiagnostics = [];
        if (shopId) {
            const result = await pool.query(
                `SELECT event.event_name, event.event_id, event.status AS event_status,
                        delivery.status AS delivery_status, delivery.attempt_count,
                        delivery.next_attempt_at, delivery.last_attempt_at,
                        delivery.error_code, delivery.error_message,
                        pixel.rate_limit_until, pixel.consecutive_failures
                 FROM event_store event
                 LEFT JOIN event_deliveries delivery ON delivery.event_store_id = event.id
                 LEFT JOIN shop_pixel_routes route ON route.id = delivery.route_id
                 LEFT JOIN pixels pixel ON pixel.id = route.pixel_id
                 WHERE event.shop_id = $1
                 ORDER BY event.id, delivery.route_id`,
                [shopId],
            ).catch(queryError => ({ rows: [{ diagnostic_query_error: queryError.message }] }));
            ledgerDiagnostics = result.rows;
        }
        error.message = `${error.message}\nRuntime diagnostics:\n${diagnostics}`
            + `\nLedger diagnostics:\n${JSON.stringify(ledgerDiagnostics, null, 2)}`
            + `\nMeta requests:\n${JSON.stringify(metaRequests, null, 2)}`;
        throw error;
    } finally {
        await stopChild(server);
        await stopChild(worker);
        await new Promise(resolve => fakeMeta.close(resolve));
        const cleanupShopIds = [shopId, secondShopId].filter(Boolean);
        if (cleanupShopIds.length) {
            await pool.query('DELETE FROM event_store WHERE shop_id = ANY($1::int[])', [cleanupShopIds]).catch(() => {});
            await pool.query('DELETE FROM shopify_webhook_inbox WHERE shop_id = ANY($1::int[])', [cleanupShopIds]).catch(() => {});
            await pool.query('DELETE FROM shop_pixel_routes WHERE shop_id = ANY($1::int[])', [cleanupShopIds]).catch(() => {});
        }
        if (pixelId) await pool.query('DELETE FROM pixels WHERE id = $1', [pixelId]).catch(() => {});
        if (cleanupShopIds.length) await pool.query('DELETE FROM shops WHERE id = ANY($1::int[])', [cleanupShopIds]).catch(() => {});
        await pool.end().catch(() => {});
    }
});

test('hard worker crash and partial multiroute failure recover without resending successful routes', { skip: !enabled }, async () => {
    const suffix = crypto.randomUUID();
    const shopDomain = `crash-recovery-${suffix}.myshopify.com`;
    const firstPixelExternalId = `8${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const secondPixelExternalId = `7${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const crashEventId = `${shopDomain}:crash-${suffix}`;
    const partialEventId = `${shopDomain}:partial-${suffix}`;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const queueRedis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue('capi-events', { connection: queueRedis });
    const metaRequests = [];
    let holdFirstRequest = true;
    let heldResponse;
    let firstRequestResolve;
    const firstRequestSeen = new Promise(resolve => { firstRequestResolve = resolve; });
    let secondPixelTransientFailures = 0;

    const fakeMeta = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            const eventIds = (body.data || []).map(event => event.event_id);
            const isSecondPixelPartial = req.url.includes(`/${secondPixelExternalId}/events`)
                && eventIds.includes(partialEventId);
            const simulatedStatus = isSecondPixelPartial && secondPixelTransientFailures === 0
                ? 503
                : 200;
            if (simulatedStatus === 503) secondPixelTransientFailures += 1;
            metaRequests.push({ url: req.url, body, simulatedStatus });

            if (holdFirstRequest) {
                holdFirstRequest = false;
                heldResponse = res;
                firstRequestResolve();
                return;
            }
            if (simulatedStatus === 503) {
                res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
                res.end(JSON.stringify({
                    error: { message: 'simulated partial-route outage', code: 2, is_transient: true },
                }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                events_received: Array.isArray(body.data) ? body.data.length : 0,
                fbtrace_id: `recovery-trace-${metaRequests.length}`,
            }));
        });
    });
    await new Promise((resolve, reject) => {
        fakeMeta.once('error', reject);
        fakeMeta.listen(0, '127.0.0.1', resolve);
    });

    const runtimeEnv = {
        ...process.env,
        NODE_ENV: 'test',
        FB_GRAPH_BASE_URL: `http://127.0.0.1:${fakeMeta.address().port}`,
        FB_REQUEST_TIMEOUT_MS: '1000',
        CREDENTIAL_LEASE_MS: '1000',
        DELIVERY_RETRY_BASE_SECONDS: '1',
        QUEUE_BACKOFF_MS: '100',
        REQUIRE_WORKER_HEARTBEAT: 'false',
    };
    const cwd = require('node:path').join(__dirname, '..');
    let worker;
    let diagnostics = '';
    const startWorker = () => {
        const child = spawn(process.execPath, ['src/worker.js'], {
            cwd,
            env: runtimeEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', chunk => { diagnostics += chunk.toString(); });
        child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
        return child;
    };
    let shopId;
    let firstPixelId;
    let secondPixelId;
    let firstRouteId;
    let secondRouteId;
    let crashEventStoreId;
    let partialEventStoreId;

    try {
        ({ rows: [{ id: shopId }] } = await pool.query(
            `INSERT INTO shops (shop_domain, app_secret)
             VALUES ($1, 'crash-recovery-secret') RETURNING id`,
            [shopDomain],
        ));
        ({ rows: [{ id: firstPixelId }] } = await pool.query(
            `INSERT INTO pixels (shop_id, platform, name, pixel_id, access_token)
             VALUES ($1, 'facebook', 'crash-primary', $2, $3) RETURNING id`,
            [shopId, firstPixelExternalId, `crash-token-${suffix}`],
        ));
        ({ rows: [{ id: firstRouteId }] } = await pool.query(
            `INSERT INTO shop_pixel_routes (shop_id, pixel_id)
             VALUES ($1, $2) RETURNING id`,
            [shopId, firstPixelId],
        ));
        const crashPayload = {
            event_name: 'PageView',
            event_time: Math.floor(Date.now() / 1000),
            event_id: crashEventId,
            action_source: 'website',
            event_source_url: `https://${shopDomain}/products/crash-test`,
            user_data: {
                external_id: `visitor-${suffix}`,
                client_ip_address: '127.0.0.1',
                client_user_agent: 'CAPI-Crash-Recovery/1.0',
            },
            custom_data: {},
        };
        ({ rows: [{ id: crashEventStoreId }] } = await pool.query(
            `INSERT INTO event_store
                (shop_id, event_name, event_id, request_payload, delivery_route_snapshot)
             VALUES ($1, 'PageView', $2, $3::jsonb, ARRAY[$4]::bigint[])
             RETURNING id`,
            [shopId, crashEventId, JSON.stringify(crashPayload), firstRouteId],
        ));
        await pool.query(
            `INSERT INTO event_deliveries (event_store_id, route_id)
             VALUES ($1, $2)`,
            [crashEventStoreId, firstRouteId],
        );

        worker = startWorker();
        await waitForCondition(
            () => diagnostics.includes('CAPI worker started'),
            'first crash-test worker startup',
        );
        await queue.add(
            'send-fb-batch',
            { shopId: Number(shopId) },
            { jobId: `crash-start-${suffix}`, attempts: 1 },
        );
        await Promise.race([
            firstRequestSeen,
            new Promise((resolve, reject) => setTimeout(
                () => reject(new Error('worker never reached the held Meta request')),
                10_000,
            )),
        ]);
        await waitForCondition(async () => {
            const { rows } = await pool.query(
                `SELECT status, attempt_count FROM event_deliveries
                 WHERE event_store_id = $1 AND route_id = $2`,
                [crashEventStoreId, firstRouteId],
            );
            return rows[0]?.status === 'IN_PROGRESS' ? rows[0] : null;
        }, 'crash delivery IN_PROGRESS state');

        worker.kill('SIGKILL');
        await new Promise(resolve => worker.once('exit', resolve));
        if (heldResponse && !heldResponse.destroyed) heldResponse.destroy();
        const { rows: [credential] } = await pool.query(
            'SELECT credential_scope FROM pixels WHERE id = $1',
            [firstPixelId],
        );
        assert.ok(credential.credential_scope);
        await pool.query(
            `UPDATE event_deliveries
             SET lease_expires_at = NOW() - INTERVAL '1 second'
             WHERE event_store_id = $1 AND route_id = $2`,
            [crashEventStoreId, firstRouteId],
        );
        await waitForCondition(async () => {
            const [shopLock, credentialLock] = await Promise.all([
                queueRedis.exists(`lock:delivery-shop:${shopId}`),
                queueRedis.exists(`lock:delivery-credential:${credential.credential_scope}`),
            ]);
            return shopLock === 0 && credentialLock === 0;
        }, 'crashed worker Redis leases to expire', 10_000);

        diagnostics = '';
        worker = startWorker();
        await waitForCondition(
            () => diagnostics.includes('CAPI worker started'),
            'replacement worker startup',
        );
        await queue.add(
            'send-fb-batch',
            { shopId: Number(shopId) },
            { jobId: `crash-recover-${suffix}`, attempts: 3, backoff: { type: 'fixed', delay: 100 } },
        );
        const recoveredCrashDelivery = await waitForCondition(async () => {
            const { rows } = await pool.query(
                `SELECT event.status AS event_status, delivery.status AS delivery_status,
                        delivery.attempt_count, delivery.platform_response
                 FROM event_store event
                 JOIN event_deliveries delivery ON delivery.event_store_id = event.id
                 WHERE event.id = $1 AND delivery.route_id = $2`,
                [crashEventStoreId, firstRouteId],
            );
            return rows[0]?.event_status === 'SUCCESS' ? rows[0] : null;
        }, 'hard-crash delivery recovery', 20_000);
        assert.equal(recoveredCrashDelivery.delivery_status, 'SUCCESS');
        assert.equal(Number(recoveredCrashDelivery.attempt_count), 2);
        assert.equal(recoveredCrashDelivery.platform_response.accepted_event, true);
        assert.equal(metaRequests.filter(request => (
            (request.body.data || []).some(event => event.event_id === crashEventId)
        )).length, 2);

        ({ rows: [{ id: secondPixelId }] } = await pool.query(
            `INSERT INTO pixels (shop_id, platform, name, pixel_id, access_token)
             VALUES ($1, 'facebook', 'partial-secondary', $2, $3) RETURNING id`,
            [shopId, secondPixelExternalId, `partial-token-${suffix}`],
        ));
        ({ rows: [{ id: secondRouteId }] } = await pool.query(
            `INSERT INTO shop_pixel_routes (shop_id, pixel_id)
             VALUES ($1, $2) RETURNING id`,
            [shopId, secondPixelId],
        ));
        const partialPayload = {
            ...crashPayload,
            event_name: 'ViewContent',
            event_id: partialEventId,
            custom_data: {
                value: 18.5,
                currency: 'USD',
                content_ids: ['partial-variant'],
                contents: [{ id: 'partial-variant', quantity: 1, item_price: 18.5 }],
                content_type: 'product',
            },
        };
        ({ rows: [{ id: partialEventStoreId }] } = await pool.query(
            `INSERT INTO event_store
                (shop_id, event_name, event_id, request_payload, delivery_route_snapshot)
             VALUES ($1, 'ViewContent', $2, $3::jsonb, ARRAY[$4, $5]::bigint[])
             RETURNING id`,
            [shopId, partialEventId, JSON.stringify(partialPayload), firstRouteId, secondRouteId],
        ));
        await pool.query(
            `INSERT INTO event_deliveries (event_store_id, route_id)
             VALUES ($1, $2), ($1, $3)`,
            [partialEventStoreId, firstRouteId, secondRouteId],
        );
        await queue.add(
            'send-fb-batch',
            { shopId: Number(shopId) },
            { jobId: `partial-routes-${suffix}`, attempts: 3, backoff: { type: 'fixed', delay: 100 } },
        );
        const partialDeliveries = await waitForCondition(async () => {
            const { rows } = await pool.query(
                `SELECT event.status AS event_status, delivery.route_id,
                        delivery.status AS delivery_status, delivery.attempt_count
                 FROM event_store event
                 JOIN event_deliveries delivery ON delivery.event_store_id = event.id
                 WHERE event.id = $1
                 ORDER BY delivery.route_id`,
                [partialEventStoreId],
            );
            return rows.length === 2 && rows.every(row => row.delivery_status === 'SUCCESS')
                ? rows
                : null;
        }, 'partial multiroute retry completion', 20_000);
        assert.ok(partialDeliveries.every(row => row.event_status === 'SUCCESS'));
        const firstRouteDelivery = partialDeliveries.find(row => String(row.route_id) === String(firstRouteId));
        const secondRouteDelivery = partialDeliveries.find(row => String(row.route_id) === String(secondRouteId));
        assert.equal(Number(firstRouteDelivery.attempt_count), 1);
        assert.equal(Number(secondRouteDelivery.attempt_count), 2);
        const firstRouteRequests = metaRequests.filter(request => (
            request.url.includes(`/${firstPixelExternalId}/events`)
            && (request.body.data || []).some(event => event.event_id === partialEventId)
        ));
        const secondRouteRequests = metaRequests.filter(request => (
            request.url.includes(`/${secondPixelExternalId}/events`)
            && (request.body.data || []).some(event => event.event_id === partialEventId)
        ));
        assert.equal(firstRouteRequests.length, 1);
        assert.equal(secondRouteRequests.filter(request => request.simulatedStatus === 503).length, 1);
        assert.equal(secondRouteRequests.filter(request => request.simulatedStatus === 200).length, 1);
    } catch (error) {
        error.message = `${error.message}\nWorker diagnostics:\n${diagnostics}`
            + `\nMeta requests:\n${JSON.stringify(metaRequests, null, 2)}`;
        throw error;
    } finally {
        await stopChild(worker);
        if (heldResponse && !heldResponse.destroyed) heldResponse.destroy();
        await new Promise(resolve => fakeMeta.close(resolve));
        if (shopId) await pool.query('DELETE FROM event_store WHERE shop_id = $1', [shopId]).catch(() => {});
        if (shopId) await pool.query('DELETE FROM shop_pixel_routes WHERE shop_id = $1', [shopId]).catch(() => {});
        if (secondPixelId) await pool.query('DELETE FROM pixels WHERE id = $1', [secondPixelId]).catch(() => {});
        if (firstPixelId) await pool.query('DELETE FROM pixels WHERE id = $1', [firstPixelId]).catch(() => {});
        if (shopId) await pool.query('DELETE FROM shops WHERE id = $1', [shopId]).catch(() => {});
        await queue.close().catch(() => {});
        await queueRedis.quit().catch(() => {});
        await pool.end().catch(() => {});
    }
});

test('HTTP webhook replay is durably deduplicated before BullMQ dispatch', { skip: !enabled }, async () => {
    const port = Number(process.env.INTEGRATION_TEST_PORT || 39091);
    const origin = `http://127.0.0.1:${port}`;
    const shopDomain = `integration-${process.pid}.myshopify.com`;
    const appSecret = `integration_webhook_secret_${crypto.randomBytes(16).toString('hex')}`;
    const webhookId = `integration-replay-${crypto.randomUUID()}`;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const server = spawn(process.execPath, ['src/server.js'], {
        cwd: require('node:path').join(__dirname, '..'),
        env: { ...process.env, PORT: String(port), REQUIRE_WORKER_HEARTBEAT: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    server.stdout.on('data', chunk => { diagnostics += chunk.toString(); });
    server.stderr.on('data', chunk => { diagnostics += chunk.toString(); });

    try {
        await waitForReady(`${origin}/readyz`, server);
        const authorization = `Basic ${Buffer.from(
            `${process.env.ADMIN_USERNAME}:${process.env.ADMIN_PASSWORD}`,
        ).toString('base64')}`;
        const shopResponse = await fetch(`${origin}/api/admin/shops`, {
            method: 'POST',
            headers: {
                Authorization: authorization,
                'Content-Type': 'application/json',
                'X-CAPI-Admin-Request': '1',
            },
            body: JSON.stringify({ shop_domain: shopDomain, app_secret: appSecret }),
        });
        assert.equal(shopResponse.status, 201, await shopResponse.text());

        const payload = Buffer.from(JSON.stringify({
            id: '90071992547409931234',
            name: '#INTEGRATION',
            source_name: 'web',
            financial_status: 'paid',
            processed_at: new Date().toISOString(),
            total_price: '12.50',
            currency: 'USD',
            line_items: [{ id: '1', variant_id: '2', quantity: 1, price: '12.50' }],
        }));
        const hmac = crypto.createHmac('sha256', appSecret).update(payload).digest('base64');
        const headers = {
            'Content-Type': 'application/json',
            'X-Shopify-Shop-Domain': shopDomain,
            'X-Shopify-Hmac-Sha256': hmac,
            'X-Shopify-Topic': 'orders/paid',
            'X-Shopify-Webhook-Id': webhookId,
            'X-Shopify-Triggered-At': new Date().toISOString(),
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const response = await fetch(`${origin}/api/webhook/orders/paid`, {
                method: 'POST',
                headers,
                body: payload,
            });
            assert.equal(response.status, 200, await response.text());
        }

        const { rows } = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM shopify_webhook_inbox inbox
             JOIN shops shop ON shop.id = inbox.shop_id
             WHERE shop.shop_domain = $1 AND inbox.webhook_id = $2`,
            [shopDomain, webhookId],
        );
        assert.equal(rows[0].count, 1);
    } catch (error) {
        error.message = `${error.message}\nServer diagnostics:\n${diagnostics}`;
        throw error;
    } finally {
        await pool.query(
            `DELETE FROM event_store
             WHERE shop_id IN (SELECT id FROM shops WHERE shop_domain = $1)`,
            [shopDomain],
        ).catch(() => {});
        await pool.query('DELETE FROM shops WHERE shop_domain = $1', [shopDomain]).catch(() => {});
        await pool.end().catch(() => {});
        if (server.exitCode === null) server.kill('SIGTERM');
        await Promise.race([
            new Promise(resolve => server.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
        if (server.exitCode === null) server.kill('SIGKILL');
    }
});

test('database prevents physical Pixel deletion from cascading delivery history', { skip: !enabled }, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const suffix = crypto.randomUUID();
    let shopId;
    let pixelId;
    let routeId;
    let eventId;
    try {
        ({ rows: [{ id: shopId }] } = await pool.query(
            `INSERT INTO shops (shop_domain, app_secret)
             VALUES ($1, 'integration-secret') RETURNING id`,
            [`ledger-${suffix}.myshopify.com`],
        ));
        ({ rows: [{ id: pixelId }] } = await pool.query(
            `INSERT INTO pixels (shop_id, name, pixel_id, access_token)
             VALUES ($1, 'integration', $2, 'token') RETURNING id`,
            [shopId, suffix],
        ));
        ({ rows: [{ id: routeId }] } = await pool.query(
            `INSERT INTO shop_pixel_routes (shop_id, pixel_id)
             VALUES ($1, $2) RETURNING id`,
            [shopId, pixelId],
        ));
        ({ rows: [{ id: eventId }] } = await pool.query(
            `INSERT INTO event_store
                (shop_id, event_name, event_id, request_payload, delivery_route_snapshot)
             VALUES ($1, 'PageView', $2, '{}'::jsonb, ARRAY[$3]::bigint[])
             RETURNING id`,
            [shopId, suffix, routeId],
        ));
        await pool.query(
            'INSERT INTO event_deliveries (event_store_id, route_id) VALUES ($1, $2)',
            [eventId, routeId],
        );
        await assert.rejects(
            pool.query('DELETE FROM pixels WHERE id = $1', [pixelId]),
            error => error?.code === '23503',
        );
        const { rows: [snapshot] } = await pool.query(
            `SELECT delivery_route_snapshot, CARDINALITY(delivery_route_snapshot) AS route_count
             FROM event_store WHERE id = $1`,
            [eventId],
        );
        assert.deepEqual(snapshot.delivery_route_snapshot.map(String), [String(routeId)]);
        assert.equal(snapshot.route_count, 1);
    } finally {
        if (eventId) await pool.query('DELETE FROM event_store WHERE id = $1', [eventId]).catch(() => {});
        if (routeId) await pool.query('DELETE FROM shop_pixel_routes WHERE id = $1', [routeId]).catch(() => {});
        if (pixelId) await pool.query('DELETE FROM pixels WHERE id = $1', [pixelId]).catch(() => {});
        if (shopId) await pool.query('DELETE FROM shops WHERE id = $1', [shopId]).catch(() => {});
        await pool.end().catch(() => {});
    }
});

test('two shops sharing one Pixel retain isolated routes, test codes, and ledgers', { skip: !enabled }, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const suffix = crypto.randomUUID();
    const shopIds = [];
    const routeIds = [];
    const eventIds = [];
    let pixelId;
    try {
        for (const label of ['a', 'b']) {
            const { rows: [{ id }] } = await pool.query(
                `INSERT INTO shops (shop_domain, app_secret)
                 VALUES ($1, 'integration-secret') RETURNING id`,
                [`shared-${label}-${suffix}.myshopify.com`],
            );
            shopIds.push(id);
        }
        ({ rows: [{ id: pixelId }] } = await pool.query(
            `INSERT INTO pixels
                (shop_id, platform, name, pixel_id, access_token, credential_scope)
             VALUES ($1, 'facebook', 'shared-integration', $2, 'shared-token', $3)
             RETURNING id`,
            [shopIds[0], suffix, `scope-${suffix}`],
        ));
        for (let index = 0; index < shopIds.length; index += 1) {
            const { rows: [{ id: routeId }] } = await pool.query(
                `INSERT INTO shop_pixel_routes (
                     shop_id, pixel_id, test_event_code, test_event_code_expires_at
                 )
                 VALUES (
                     $1, $2, $3::varchar(100),
                     CASE WHEN $3::varchar(100) IS NOT NULL THEN NOW() + INTERVAL '30 minutes' ELSE NULL END
                 ) RETURNING id`,
                [shopIds[index], pixelId, index === 0 ? 'TEST-SHOP-A' : null],
            );
            routeIds.push(routeId);
            const { rows: [{ id: eventStoreId }] } = await pool.query(
                `INSERT INTO event_store
                    (shop_id, event_name, event_id, request_payload, delivery_route_snapshot)
                 VALUES ($1, 'Purchase', 'same-local-order', '{}'::jsonb, ARRAY[$2]::bigint[])
                 RETURNING id`,
                [shopIds[index], routeId],
            );
            eventIds.push(eventStoreId);
            await pool.query(
                'INSERT INTO event_deliveries (event_store_id, route_id) VALUES ($1, $2)',
                [eventStoreId, routeId],
            );
        }

        await assert.rejects(
            pool.query(
                'INSERT INTO event_deliveries (event_store_id, route_id) VALUES ($1, $2)',
                [eventIds[0], routeIds[1]],
            ),
            error => error?.code === '23514',
        );
        const { rows } = await pool.query(
            `SELECT event.shop_id, delivery.route_id, route.test_event_code
             FROM event_store event
             JOIN event_deliveries delivery ON delivery.event_store_id = event.id
             JOIN shop_pixel_routes route ON route.id = delivery.route_id
             WHERE event.id = ANY($1::bigint[])
             ORDER BY event.shop_id`,
            [eventIds],
        );
        assert.equal(rows.length, 2);
        assert.equal(String(rows[0].route_id), String(routeIds[0]));
        assert.equal(rows[0].test_event_code, 'TEST-SHOP-A');
        assert.equal(String(rows[1].route_id), String(routeIds[1]));
        assert.equal(rows[1].test_event_code, null);
    } finally {
        if (eventIds.length) {
            await pool.query('DELETE FROM event_store WHERE id = ANY($1::bigint[])', [eventIds]).catch(() => {});
        }
        if (routeIds.length) {
            await pool.query('DELETE FROM shop_pixel_routes WHERE id = ANY($1::bigint[])', [routeIds]).catch(() => {});
        }
        if (pixelId) await pool.query('DELETE FROM pixels WHERE id = $1', [pixelId]).catch(() => {});
        if (shopIds.length) {
            await pool.query('DELETE FROM shops WHERE id = ANY($1::int[])', [shopIds]).catch(() => {});
        }
        await pool.end().catch(() => {});
    }
});

test('Redis outage keeps liveness green but makes readiness fail closed', { skip: !enabled }, async () => {
    const port = Number(process.env.INTEGRATION_DEGRADED_PORT || 39092);
    const server = spawn(process.execPath, ['src/server.js'], {
        cwd: require('node:path').join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(port),
            REDIS_URL: 'redis://127.0.0.1:1',
            REQUIRE_WORKER_HEARTBEAT: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    server.stdout.on('data', chunk => { diagnostics += chunk.toString(); });
    server.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
    try {
        const health = await waitForStatus(`http://127.0.0.1:${port}/healthz`, 200, server);
        assert.equal((await health.json()).status, 'ok');
        const readiness = await waitForStatus(`http://127.0.0.1:${port}/readyz`, 503, server);
        const body = await readiness.json();
        assert.equal(body.status, 'degraded');
        assert.equal(body.postgres, 'ready');
        assert.equal(body.redis, 'degraded');
        assert.equal(body.immediate_dispatch, false);
    } catch (error) {
        error.message = `${error.message}\nServer diagnostics:\n${diagnostics}`;
        throw error;
    } finally {
        if (server.exitCode === null) server.kill('SIGTERM');
        await Promise.race([
            new Promise(resolve => server.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
        if (server.exitCode === null) server.kill('SIGKILL');
    }
});
