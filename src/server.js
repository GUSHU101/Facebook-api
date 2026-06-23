require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const basicAuth = require('express-basic-auth');
const cron = require('node-cron');
const { Queue } = require('bullmq');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');

const config = require('./config');
const pool = require('./utils/db');
const redis = require('./utils/redis');
const { hashUserData, encryptToken, timingSafeCompare } = require('./utils/crypto');
const { calculateEMQ, missingMatchSignals } = require('./utils/emq');
const { compactObject, firstPresent } = require('./events/common');
const { buildShopifyOrderPurchasePayload } = require('./events/shopify');

const app = express();
app.set('trust proxy', config.trustProxy);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.corsOrigin, credentials: false }));
app.use(express.json({
    limit: config.jsonLimit,
    verify: (req, res, buf) => {
        req.rawBody = buf;
    },
}));

const capiQueue = new Queue('capi-events', {
    connection: redis,
    defaultJobOptions: {
        attempts: config.queueAttempts,
        backoff: { type: 'exponential', delay: config.queueBackoffMs },
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 604800, count: 5000 },
    },
});

const pixelLimiter = rateLimit({
    windowMs: 60_000,
    max: config.pixelRateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
});

const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.adminRateLimitPerWindow,
    standardHeaders: true,
    legacyHeaders: false,
});

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function normalizeShopDomain(domain) {
    return String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function requireString(value, fieldName) {
    const normalized = String(value || '').trim();
    if (!normalized) {
        const error = new Error(`Missing ${fieldName}`);
        error.statusCode = 400;
        throw error;
    }
    return normalized;
}

function firstForwardedIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress;
}

function hashMany(values, type = 'default') {
    const hashes = [];
    const seen = new Set();
    for (const value of values.flat()) {
        const hash = hashUserData(value, type);
        if (hash && !seen.has(hash)) {
            seen.add(hash);
            hashes.push(hash);
        }
    }
    return hashes.length ? hashes : undefined;
}

function buildUserData(req, payload) {
    const email = firstPresent(payload.email, payload.customer_email);
    const phone = firstPresent(payload.phone, payload.customer_phone);
    const firstName = firstPresent(payload.firstName, payload.first_name, payload.customer_first_name);
    const lastName = firstPresent(payload.lastName, payload.last_name, payload.customer_last_name);
    const city = firstPresent(payload.city, payload.customer_city);
    const state = firstPresent(payload.state, payload.province, payload.province_code, payload.customer_state);
    const zip = firstPresent(payload.zip, payload.postal_code, payload.postalCode, payload.customer_zip);
    const country = firstPresent(payload.country, payload.country_code, payload.customer_country);
    const externalIds = [
        payload.external_id,
        payload.client_id,
        payload.checkout_token,
        payload.cart_token,
        payload.order_id,
        payload.shopify_y,
    ];

    const hashed = {
        em: hashMany([email], 'email'),
        ph: hashMany([phone], 'phone'),
        fn: hashMany([firstName], 'name'),
        ln: hashMany([lastName], 'name'),
        ct: hashMany([city], 'city'),
        st: hashMany([state], 'state'),
        zp: hashMany([zip], 'zip'),
        country: hashMany([country], 'country'),
        external_id: hashMany(externalIds, 'default'),
    };

    return compactObject({
        client_ip_address: firstPresent(payload.client_ip, firstForwardedIp(req)),
        client_user_agent: firstPresent(payload.user_agent, req.headers['user-agent']),
        fbc: firstPresent(payload.fbc, payload._fbc),
        fbp: firstPresent(payload.fbp, payload._fbp),
        em: hashed.em,
        ph: hashed.ph,
        fn: hashed.fn,
        ln: hashed.ln,
        ct: hashed.ct,
        st: hashed.st,
        zp: hashed.zp,
        country: hashed.country,
        external_id: hashed.external_id,
    });
}

function buildPlatformData(payload) {
    return compactObject({
        tiktok: compactObject({
            ttp: payload.ttp,
            ttclid: payload.ttclid,
        }),
    });
}

function buildCustomData(payload) {
    const contentIds = Array.isArray(payload.content_ids)
        ? payload.content_ids.filter(Boolean).map(String)
        : undefined;
    const contents = Array.isArray(payload.contents)
        ? payload.contents.filter(Boolean)
        : undefined;

    return compactObject({
        value: payload.value !== undefined && Number.isFinite(Number(payload.value)) ? Number(payload.value) : undefined,
        currency: payload.currency ? String(payload.currency).trim().toUpperCase() : undefined,
        content_ids: contentIds,
        contents,
        content_type: payload.content_type,
        content_name: payload.content_name,
        content_category: payload.content_category,
        num_items: Number.isFinite(Number(payload.num_items)) ? Number(payload.num_items) : undefined,
        order_id: payload.order_id,
        search_string: payload.search_string,
    });
}

function resolveEventTime(payload) {
    const fromPayload = Date.parse(payload.timestamp);
    if (Number.isFinite(fromPayload)) return Math.floor(fromPayload / 1000);
    return Math.floor(Date.now() / 1000);
}

async function queueForOutbox(req, res, payload, shopId) {
    const eventName = requireString(payload.event_name, 'event_name');
    const eventId = String(payload.event_id || `${eventName}_${crypto.randomUUID()}`).trim();
    const dedupKey = `dedup:${shopId}:${eventName}:${eventId}`;
    const ttlSeconds = eventName === 'Purchase' ? 30 * 24 * 60 * 60 : 7 * 24 * 60 * 60;

    const isNew = await redis.set(dedupKey, '1', 'EX', ttlSeconds, 'NX');
    if (!isNew && eventName !== 'Purchase') {
        return res.status(200).json({ success: true, deduplicated: true });
    }

    const userData = buildUserData(req, payload);
    const fbEventData = {
        event_name: eventName,
        event_time: resolveEventTime(payload),
        action_source: 'website',
        event_id: eventId,
        event_source_url: firstPresent(payload.source_url, payload.url, req.headers.referer),
        user_data: userData,
        custom_data: buildCustomData(payload),
        _emq_estimate: calculateEMQ(userData),
        _quality: { missing_match_signals: missingMatchSignals(userData) },
        _platform_data: buildPlatformData(payload),
        _duplicate_candidate: !isNew,
        _received_at: Date.now(),
    };

    await redis.rpush(`pending:events:${shopId}`, JSON.stringify(fbEventData));
    return res.status(202).json({ success: true, queued: true, event_id: eventId, duplicate_candidate: !isNew });
}

app.post('/api/pixel-event', pixelLimiter, asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const shopDomain = normalizeShopDomain(payload.shop_domain);
    if (!shopDomain) return res.status(400).json({ error: 'Missing shop_domain' });

    const { rows } = await pool.query(
        'SELECT id FROM shops WHERE shop_domain = $1 AND status = $2',
        [shopDomain, 'active'],
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Shop inactive' });

    return queueForOutbox(req, res, { ...payload, shop_domain: shopDomain }, rows[0].id);
}));

async function handleShopifyPurchaseWebhook(req, res) {
    const shopDomain = normalizeShopDomain(req.headers['x-shopify-shop-domain']);
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const webhookId = req.headers['x-shopify-webhook-id'];
    if (!shopDomain || !hmacHeader) return res.status(400).send('Missing Headers');

    const { rows } = await pool.query(
        'SELECT id, app_secret FROM shops WHERE shop_domain = $1 AND status = $2',
        [shopDomain, 'active'],
    );
    if (rows.length === 0) return res.status(401).send('Unauthorized');

    const generatedHash = crypto.createHmac('sha256', rows[0].app_secret).update(req.rawBody).digest('base64');
    if (!timingSafeCompare(generatedHash, hmacHeader)) return res.status(401).send('HMAC Failed');

    if (webhookId) {
        const deliveryKey = `shopify:webhook:${shopDomain}:${webhookId}`;
        const isNewDelivery = await redis.set(deliveryKey, '1', 'EX', 7 * 24 * 60 * 60, 'NX');
        if (!isNewDelivery) return res.status(200).json({ success: true, duplicate_webhook: true });
    }

    const order = req.body || {};
    const payload = buildShopifyOrderPurchasePayload(order, shopDomain);

    return queueForOutbox(req, res, payload, rows[0].id);
}

app.post('/api/webhook/purchase', asyncHandler(handleShopifyPurchaseWebhook));
app.post('/api/webhook/orders/paid', asyncHandler(handleShopifyPurchaseWebhook));

app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/readyz', asyncHandler(async (req, res) => {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ status: 'ready' });
}));

cron.schedule(config.batchCron, async () => {
    const lock = await redis.set('lock:batch_packing', '1', 'EX', 4, 'NX');
    if (!lock) return;

    try {
        const { rows: shops } = await pool.query("SELECT id FROM shops WHERE status = 'active'");
        for (const shop of shops) {
            const pendingKey = `pending:events:${shop.id}`;
            const processingKey = `processing:events:${shop.id}`;
            const heartbeatKey = `heartbeat:processing:${shop.id}`;
            const len = await redis.llen(pendingKey);
            if (len === 0) continue;

            const itemsToProcess = await redis.safePopAndTransfer(
                pendingKey,
                processingKey,
                Math.min(len, config.batchSize),
            );
            if (!itemsToProcess?.length) continue;

            await redis.set(heartbeatKey, '1', 'EX', 30);
            const parsedEvents = itemsToProcess.map(item => JSON.parse(item));
            const now = Date.now();
            const readyEvents = [];
            const deferredEvents = [];
            for (const event of parsedEvents) {
                const age = now - Number(event._received_at || now);
                if (event.event_name === 'Purchase' && age < config.purchaseSettleMs) {
                    deferredEvents.push(event);
                } else {
                    readyEvents.push(event);
                }
            }

            if (deferredEvents.length > 0) {
                for (let index = deferredEvents.length - 1; index >= 0; index -= 1) {
                    await redis.lpush(pendingKey, JSON.stringify(deferredEvents[index]));
                }
            }

            if (readyEvents.length === 0) {
                await redis.del(processingKey);
                await redis.del(heartbeatKey);
                continue;
            }

            const shopIds = [];
            const eventNames = [];
            const eventIds = [];
            const statuses = [];
            const emqs = [];
            const payloads = [];

            readyEvents.forEach(event => {
                const purePayload = { ...event };
                delete purePayload._emq_estimate;
                shopIds.push(shop.id);
                eventNames.push(event.event_name);
                eventIds.push(event.event_id);
                statuses.push('PENDING');
                emqs.push(event._emq_estimate);
        payloads.push(JSON.stringify(purePayload));
            });

            const outboxQuery = `
                INSERT INTO event_store (shop_id, event_name, event_id, status, emq_estimate, request_payload)
                SELECT * FROM UNNEST ($1::int[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::jsonb[])
                ON CONFLICT (shop_id, event_name, md5(event_id)) DO UPDATE SET
                    emq_estimate = GREATEST(event_store.emq_estimate, EXCLUDED.emq_estimate),
                    request_payload =
                        event_store.request_payload ||
                        EXCLUDED.request_payload ||
                        jsonb_build_object(
                            'user_data',
                            COALESCE(event_store.request_payload->'user_data', '{}'::jsonb) ||
                            COALESCE(EXCLUDED.request_payload->'user_data', '{}'::jsonb),
                            'custom_data',
                            COALESCE(event_store.request_payload->'custom_data', '{}'::jsonb) ||
                            COALESCE(EXCLUDED.request_payload->'custom_data', '{}'::jsonb),
                            '_platform_data',
                            COALESCE(event_store.request_payload->'_platform_data', '{}'::jsonb) ||
                            COALESCE(EXCLUDED.request_payload->'_platform_data', '{}'::jsonb)
                        )
                WHERE event_store.status <> 'SUCCESS'
                RETURNING id, request_payload, status, fb_response;
            `;
            const { rows: validDbEvents } = await pool.query(
                outboxQuery,
                [shopIds, eventNames, eventIds, statuses, emqs, payloads],
            );

            const eventsToSend = validDbEvents.filter(event => event.status !== 'SUCCESS');
            if (eventsToSend.length > 0) {
                await capiQueue.add('send-fb-batch', { shopId: shop.id, dbEvents: eventsToSend });
            }

            await redis.del(processingKey);
            await redis.del(heartbeatKey);
        }
    } catch (error) {
        console.error('Outbox pack error:', error);
    }
});

cron.schedule(config.watchdogCron, async () => {
    const lock = await redis.set('lock:watchdog', '1', 'EX', 50, 'NX');
    if (!lock) return;

    try {
        const { rows: shops } = await pool.query('SELECT id FROM shops');
        for (const shop of shops) {
            const processingKey = `processing:events:${shop.id}`;
            const pendingKey = `pending:events:${shop.id}`;
            const heartbeatKey = `heartbeat:processing:${shop.id}`;
            const [isAlive, processingLen] = await Promise.all([
                redis.exists(heartbeatKey),
                redis.llen(processingKey),
            ]);

            if (processingLen > 0 && !isAlive) {
                const restored = await redis.rollbackProcessing(processingKey, pendingKey);
                console.warn(`[Watchdog] restored ${restored} processing events for shop ${shop.id}`);
            }
        }
    } catch (error) {
        console.error('Watchdog error:', error);
    }
});

const authMw = basicAuth({
    users: { [config.adminUsername]: config.adminPassword },
    challenge: true,
});

app.use('/admin', adminLimiter, authMw);
app.use('/api/admin', authMw);

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queue');
createBullBoard({ queues: [new BullMQAdapter(capiQueue)], serverAdapter });
app.use('/admin/queue', serverAdapter.getRouter());

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/admin/shops', asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT id, shop_domain, status, created_at FROM shops ORDER BY id DESC');
    res.json(rows);
}));

app.post('/api/admin/shops', asyncHandler(async (req, res) => {
    const shopDomain = normalizeShopDomain(req.body.shop_domain);
    const appSecret = requireString(req.body.app_secret, 'app_secret');
    if (!shopDomain.endsWith('.myshopify.com')) {
        return res.status(400).json({ error: 'shop_domain must be a myshopify.com domain' });
    }

    await pool.query(
        `INSERT INTO shops (shop_domain, app_secret)
         VALUES ($1, $2)
         ON CONFLICT (shop_domain) DO UPDATE SET app_secret = EXCLUDED.app_secret, status = 'active'`,
        [shopDomain, appSecret],
    );
    res.status(201).json({ success: true });
}));

app.delete('/api/admin/shops/:id', asyncHandler(async (req, res) => {
    const shopId = Number(req.params.id);
    if (!Number.isInteger(shopId) || shopId <= 0) return res.status(400).json({ error: 'Invalid shop_id' });

    const client = await pool.connect();
    let rowCount = 0;
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM dead_letters WHERE shop_id = $1', [shopId]);
        const result = await client.query('DELETE FROM shops WHERE id = $1', [shopId]);
        rowCount = result.rowCount;
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }

    await Promise.all([
        redis.del(`pending:events:${shopId}`),
        redis.del(`processing:events:${shopId}`),
        redis.del(`heartbeat:processing:${shopId}`),
    ]);

    if (rowCount === 0) return res.status(404).json({ error: 'Shop not found' });
    res.json({ success: true });
}));

app.get('/api/admin/pixels', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`
        SELECT p.id, s.shop_domain, p.platform, p.name, p.pixel_id, p.test_event_code
        FROM pixels p
        JOIN shops s ON p.shop_id = s.id
        ORDER BY p.id DESC
    `);
    res.json(rows);
}));

app.post('/api/admin/pixels', asyncHandler(async (req, res) => {
    const shopId = Number(req.body.shop_id);
    const platform = String(req.body.platform || 'facebook').trim().toLowerCase();
    const name = requireString(req.body.name, 'name');
    const pixelId = requireString(req.body.pixel_id, 'pixel_id');
    const accessToken = requireString(req.body.access_token, 'access_token');
    const testEventCode = String(req.body.test_event_code || '').trim() || null;
    if (!Number.isInteger(shopId) || shopId <= 0) return res.status(400).json({ error: 'Invalid shop_id' });
    if (!['facebook', 'tiktok'].includes(platform)) return res.status(400).json({ error: 'Unsupported platform' });

    await pool.query(
        `INSERT INTO pixels (shop_id, platform, name, pixel_id, access_token, test_event_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [shopId, platform, name, pixelId, encryptToken(accessToken), testEventCode],
    );
    res.status(201).json({ success: true });
}));

app.delete('/api/admin/pixels/:id', asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM pixels WHERE id = $1', [req.params.id]);
    res.json({ success: true });
}));

app.get('/api/admin/logs', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`
        SELECT e.id, s.shop_domain, e.event_name, e.event_id, e.status, e.emq_estimate,
               e.fb_response, e.timestamp
        FROM event_store e
        JOIN shops s ON e.shop_id = s.id
        ORDER BY e.id DESC
        LIMIT 100
    `);
    res.json(rows);
}));

app.get('/api/admin/summary', asyncHandler(async (req, res) => {
    const [
        statusResult,
        emqResult,
        dlqResult,
        shopsResult,
        pixelsResult,
        queueCounts,
    ] = await Promise.all([
        pool.query(`
            SELECT status, COUNT(*)::int AS count
            FROM event_store
            WHERE timestamp >= NOW() - INTERVAL '24 hours'
            GROUP BY status
        `),
        pool.query(`
            SELECT COUNT(*)::int AS total_events,
                   ROUND(AVG(emq_estimate)::numeric, 2) AS avg_emq
            FROM event_store
            WHERE timestamp >= NOW() - INTERVAL '24 hours'
        `),
        pool.query("SELECT COUNT(*)::int AS count FROM dead_letters WHERE status = 'FAILED_PERMANENT'"),
        pool.query("SELECT COUNT(*)::int AS count FROM shops WHERE status = 'active'"),
        pool.query("SELECT platform, COUNT(*)::int AS count FROM pixels GROUP BY platform"),
        capiQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
    ]);

    const { rows: shops } = await pool.query("SELECT id FROM shops WHERE status = 'active'");
    const pendingByShop = [];
    for (const shop of shops) {
        const pending = await redis.llen(`pending:events:${shop.id}`);
        const processing = await redis.llen(`processing:events:${shop.id}`);
        if (pending || processing) pendingByShop.push({ shop_id: shop.id, pending, processing });
    }

    res.json({
        last24h: {
            total_events: emqResult.rows[0]?.total_events || 0,
            avg_emq: emqResult.rows[0]?.avg_emq || null,
            by_status: statusResult.rows,
        },
        active_shops: shopsResult.rows[0]?.count || 0,
        pixels_by_platform: pixelsResult.rows,
        dead_letters: dlqResult.rows[0]?.count || 0,
        queue: queueCounts,
        redis_pending: pendingByShop,
    });
}));

app.get('/api/admin/dlq', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`
        SELECT d.*, s.shop_domain
        FROM dead_letters d
        JOIN shops s ON d.shop_id = s.id
        WHERE d.status = 'FAILED_PERMANENT'
        ORDER BY d.id DESC
        LIMIT 50
    `);
    res.json(rows);
}));

app.post('/api/admin/dlq/replay', asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    const params = ids.length ? [ids] : [];
    const query = ids.length
        ? "SELECT id, shop_id, payload FROM dead_letters WHERE status = 'FAILED_PERMANENT' AND id = ANY($1::bigint[])"
        : "SELECT id, shop_id, payload FROM dead_letters WHERE status = 'FAILED_PERMANENT'";
    const { rows } = await pool.query(query, params);

    let replayed = 0;
    for (const row of rows) {
        const dbEvents = JSON.parse(row.payload);
        await capiQueue.add('send-fb-batch', { shopId: row.shop_id, dbEvents });
        await pool.query("UPDATE dead_letters SET status = 'REPLAYED' WHERE id = $1", [row.id]);
        replayed += 1;
    }

    res.json({ success: true, replayed });
}));

app.use((err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    if (statusCode >= 500) console.error(err);
    res.status(statusCode).json({ error: statusCode >= 500 ? 'Internal Server Error' : err.message });
});

const server = app.listen(config.port, () => {
    console.log(`CAPI SaaS API listening on port ${config.port}`);
});

async function shutdown(signal) {
    console.log(`Received ${signal}, shutting down API server`);
    server.close(async () => {
        try {
            await capiQueue.close();
            await pool.end();
            await redis.quit();
            process.exit(0);
        } catch (error) {
            console.error('Shutdown error:', error);
            process.exit(1);
        }
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
