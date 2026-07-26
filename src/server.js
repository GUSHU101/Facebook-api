require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');
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
const {
    collectHashedUserData,
    credentialFingerprint,
    encryptToken,
    decryptTokenIfPossible,
    timingSafeCompare,
    timingSafeStringCompare,
} = require('./utils/crypto');
const { calculateEMQ, missingMatchSignals } = require('./utils/emq');
const {
    compactObject,
    firstPresent,
    missingCommerceSignals,
    normalizeEventId,
    normalizeShopifyId,
    stripPrivateFields,
    tenantScopedExternalId,
    tenantScopedIdentifier,
} = require('./events/common');
const { buildShopifyOrderPurchasePayload, paidOrderIgnoreReason } = require('./events/shopify');
const {
    browserAttributionIdentity,
    sanitizeStoredAttribution,
    snapshotForAttributionKey,
} = require('./events/attribution');
const {
    mergeCustomData,
    mergePersistedEventPayload,
    mergePlatformData,
    mergeUserData,
} = require('./events/merge');
const { classifyFacebookError, metaRateControlFromHeaders } = require('./platforms/rate-control');
const { normalizeMetaCookie, prepareMetaEvent, validateMetaEvent } = require('./platforms/meta');
const { parseJsonPreservingLargeIntegers } = require('./utils/json');

const app = express();
app.set('trust proxy', config.trustProxy);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
            ],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'self'"],
        },
    },
}));
// Only the storefront ingestion endpoint needs browser CORS. Keeping CORS off
// admin routes prevents an unrelated website from reading authenticated admin
// responses through a browser session that already has Basic Auth credentials.
app.use('/api/pixel-event', cors({ origin: config.corsOrigin, credentials: false }));
app.use(express.json({
    limit: config.jsonLimit,
    verify: (req, res, buf) => {
        req.rawBody = buf;
    },
}));

app.use((req, res, next) => {
    if (!fs.existsSync(config.maintenanceFile)) return next();
    if (req.path === '/healthz') {
        return res.json({ status: 'maintenance', uptime: process.uptime() });
    }
    res.set('Retry-After', '60');
    return res.status(503).json({
        error: 'Service temporarily unavailable for maintenance',
        retryable: true,
    });
});

const capiQueue = new Queue('capi-events', {
    connection: redis,
    defaultJobOptions: {
        attempts: config.queueAttempts,
        backoff: { type: 'exponential', delay: config.queueBackoffMs },
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 604800, count: 5000 },
    },
});

const pixelLimiter = config.pixelRateLimitPerMinute > 0
    ? rateLimit({
        windowMs: 60_000,
        max: config.pixelRateLimitPerMinute,
        keyGenerator: req => `${normalizeShopDomain(shopDomainFromPixelBody(req.body)) || 'unknown'}:${firstForwardedIp(req)}`,
        standardHeaders: true,
        legacyHeaders: false,
    })
    : (req, res, next) => next();

const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.adminRateLimitPerWindow,
    standardHeaders: true,
    legacyHeaders: false,
});

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ATTRIBUTION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_PIXEL_BATCH_SIZE = 50;
const META_QUALITY_METRIC_TYPE = 'EVENT_MATCH_QUALITY';
const META_CUSTOMER_SEGMENTS = new Set([
    'new_customer_to_business',
    'new_customer_to_business_line',
    'new_customer_to_product_area',
    'new_customer_to_medium',
    'existing_customer_to_business',
    'existing_customer_to_business_line',
    'existing_customer_to_product_area',
    'existing_customer_to_medium',
    'customer_in_loyalty_program',
]);

function normalizeShopDomain(domain) {
    return String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function shopIngestToken(shopDomain) {
    return crypto
        .createHmac('sha256', config.ingestTokenSecret)
        .update(`shop-ingest:${normalizeShopDomain(shopDomain)}`)
        .digest('hex');
}

function validShopIngestToken(shopDomain, suppliedToken) {
    const candidates = [config.ingestTokenSecret, config.ingestTokenPreviousSecret].filter(Boolean);
    return candidates.some(secret => {
        const expected = crypto
            .createHmac('sha256', secret)
            .update(`shop-ingest:${normalizeShopDomain(shopDomain)}`)
            .digest('hex');
        return timingSafeStringCompare(expected, suppliedToken);
    });
}

function requireMyshopifyDomain(value) {
    const shopDomain = normalizeShopDomain(value);
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
        const error = new Error('shop_domain must be a valid myshopify.com domain');
        error.statusCode = 400;
        throw error;
    }
    return shopDomain;
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

function requireBoundedString(value, fieldName, maxLength) {
    const normalized = requireString(value, fieldName);
    if (normalized.length > maxLength) {
        const error = new Error(`${fieldName} must be ${maxLength} characters or fewer`);
        error.statusCode = 400;
        throw error;
    }
    return normalized;
}

function optionalBoundedString(value, fieldName, maxLength) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    if (normalized.length > maxLength) {
        const error = new Error(`${fieldName} must be ${maxLength} characters or fewer`);
        error.statusCode = 400;
        throw error;
    }
    return normalized;
}

function readOptionalShopId(req) {
    const raw = req.query.shop_id;
    if (raw === undefined || raw === null || raw === '') return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        const error = new Error('Invalid shop_id');
        error.statusCode = 400;
        throw error;
    }
    return value;
}

function readPositiveId(value, fieldName) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
        const error = new Error(`Invalid ${fieldName}`);
        error.statusCode = 400;
        throw error;
    }
    return id;
}

function firstForwardedIp(req) {
    if (req.ip) return req.ip;
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress;
}

function cleanKeyPart(value) {
    if (value === undefined || value === null || value === '') return undefined;
    return String(value).trim().slice(0, 256);
}

function firstScalar(value) {
    if (Array.isArray(value)) return value.find(item => item !== undefined && item !== null && item !== '');
    return value;
}

function normalizeActionSource(value) {
    const allowed = new Set([
        'email',
        'website',
        'app',
        'phone_call',
        'chat',
        'physical_store',
        'system_generated',
        'business_messaging',
        'other',
    ]);
    const normalized = String(value || '').trim();
    return allowed.has(normalized) ? normalized : 'website';
}

function normalizeCustomerSegmentation(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return META_CUSTOMER_SEGMENTS.has(normalized) ? normalized : undefined;
}

function normalizeUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
        parsed.username = '';
        parsed.password = '';
        parsed.hash = '';
        return parsed.toString();
    } catch (error) {
        return undefined;
    }
}

function fallbackShopUrl(payload) {
    const shopDomain = normalizeShopDomain(payload.shop_domain);
    return shopDomain ? `https://${shopDomain}/` : undefined;
}

function eventSourceUrlForPayload(req, payload) {
    return firstPresent(
        normalizeUrl(payload.event_source_url),
        normalizeUrl(payload.source_url),
        normalizeUrl(payload.url),
        normalizeUrl(req.headers.referer),
        fallbackShopUrl(payload),
    );
}

function primaryExternalId(payload) {
    const externalId = firstScalar(payload.external_id);
    return firstPresent(
        normalizeShopifyId(externalId),
        normalizeShopifyId(payload.customer_id),
        normalizeShopifyId(payload.client_id),
        normalizeShopifyId(payload.shopify_y),
        normalizeShopifyId(payload.checkout_token),
    );
}

function isPayloadObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pixelPayloadsFromBody(body) {
    if (Array.isArray(body)) return body.filter(isPayloadObject);
    if (Array.isArray(body?.events)) {
        return body.events
            .filter(isPayloadObject)
            .map(event => ({
                ...event,
                shop_domain: event.shop_domain || body.shop_domain,
            }));
    }
    return isPayloadObject(body) ? [body] : [];
}

function shopDomainFromPixelBody(body) {
    if (Array.isArray(body)) return body[0]?.shop_domain;
    if (Array.isArray(body?.events)) return body.shop_domain || body.events[0]?.shop_domain;
    return body?.shop_domain;
}

function durableAliasEntries(eventName, eventId, payload) {
    if (eventName !== 'Purchase') return [];
    const entries = [
        ['id', eventId],
        ['checkout', payload.checkout_token],
        ['order', payload.order_id],
        ['cart', payload.cart_token],
    ];

    const seen = new Set();
    return entries.map(([type, rawValue]) => ({
        type,
        value: cleanKeyPart(normalizeEventId(rawValue) || rawValue),
    })).filter(entry => {
        if (!entry.value) return false;
        const key = `${entry.type}:${entry.value}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function resolveCanonicalEventIdDurably(shopId, eventName, proposedEventId, payload) {
    const entries = durableAliasEntries(eventName, proposedEventId, payload);
    if (entries.length === 0) return proposedEventId;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const lockKeys = entries
            .map(entry => `${shopId}:${eventName}:${entry.type}:${entry.value}`)
            .sort();
        for (const lockKey of lockKeys) {
            await client.query(
                'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                [lockKey],
            );
        }

        const aliasTypes = entries.map(entry => entry.type);
        const aliasValues = entries.map(entry => entry.value);
        const existing = await client.query(
            `SELECT a.canonical_event_id, a.created_at, a.id
             FROM event_id_aliases a
             JOIN UNNEST($3::text[], $4::text[]) requested(alias_type, alias_value)
               ON requested.alias_type = a.alias_type
              AND requested.alias_value = a.alias_value
             WHERE a.shop_id = $1
               AND a.event_name = $2
             ORDER BY a.created_at ASC, a.id ASC`,
            [shopId, eventName, aliasTypes, aliasValues],
        );
        const canonicalEventId = existing.rows[0]?.canonical_event_id || proposedEventId;

        await client.query(
            `INSERT INTO event_id_aliases
                (shop_id, event_name, alias_type, alias_value, canonical_event_id)
             SELECT $1, $2, requested.alias_type, requested.alias_value, $5
             FROM UNNEST($3::text[], $4::text[]) requested(alias_type, alias_value)
             ON CONFLICT (shop_id, event_name, alias_type, alias_value)
             DO UPDATE SET
                 canonical_event_id = EXCLUDED.canonical_event_id,
                 updated_at = NOW()`,
            [shopId, eventName, aliasTypes, aliasValues, canonicalEventId],
        );
        await client.query('COMMIT');
        return canonicalEventId;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

function attributionKeyEntries(shopId, payload) {
    const candidates = [
        ['client', browserAttributionIdentity(payload)],
        ['checkout', payload.checkout_token],
        ['cart', payload.cart_token],
        ['order', payload.order_id],
        ['session', payload.shopify_s],
    ];
    const keys = [];
    const seen = new Set();
    for (const [type, rawValue] of candidates) {
        const value = cleanKeyPart(rawValue);
        if (!value) continue;
        const key = `attr:${shopId}:${type}:${value}`;
        if (!seen.has(key)) {
            seen.add(key);
            keys.push({ type, key });
        }
    }
    return keys;
}

async function loadAttributionSnapshot(shopId, payload) {
    const entries = attributionKeyEntries(shopId, payload);
    if (entries.length === 0) return {};

    const values = await redis.mget(entries.map(entry => entry.key));
    const snapshots = values
        .map((value, index) => {
            try {
                return value
                    ? sanitizeStoredAttribution(JSON.parse(value), entries[index].type)
                    : {};
            } catch (error) {
                return {};
            }
        })
        .filter(snapshot => Object.keys(snapshot).length > 0)
        .sort((left, right) => Number(left.updated_at || 0) - Number(right.updated_at || 0));

    return Object.assign({}, ...snapshots);
}

async function saveAttributionSnapshot(shopId, payload) {
    const entries = attributionKeyEntries(shopId, payload);
    if (entries.length === 0) return;

    const pipeline = redis.pipeline();
    for (const entry of entries) {
        const snapshot = snapshotForAttributionKey(payload, entry.type);
        if (Object.keys(snapshot).length > 0) {
            pipeline.set(entry.key, JSON.stringify(snapshot), 'EX', ATTRIBUTION_TTL_SECONDS);
        }
    }
    const results = await pipeline.exec();
    const failed = results.find(([error]) => error);
    if (failed) throw failed[0];
}

async function deleteKeysByPattern(pattern) {
    let cursor = '0';
    do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = nextCursor;
        if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
}

async function deleteRuntimeQueueKeysForShop(shopId) {
    await redis.del(
        `pending:events:${shopId}`,
        `processing:events:${shopId}`,
        `heartbeat:processing:${shopId}`,
    );
}

async function allShopIds() {
    const { rows } = await pool.query('SELECT id FROM shops ORDER BY id ASC');
    return rows.map(row => row.id);
}

async function releaseRedisLock(key, token) {
    const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        end
        return 0
    `;
    await redis.eval(script, 1, key, token);
}

function startRedisLockHeartbeat(key, token, ttlSeconds) {
    const renewScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("expire", KEYS[1], ARGV[2])
        end
        return 0
    `;
    const intervalMs = Math.max(1000, Math.floor((ttlSeconds * 1000) / 3));
    let stopped = false;
    let inFlight = Promise.resolve();
    const timer = setInterval(() => {
        inFlight = inFlight.then(async () => {
            if (stopped) return;
            const renewed = Number(await redis.eval(renewScript, 1, key, token, ttlSeconds));
            if (renewed !== 1) console.warn(`[Lock] lost ${key}; idempotency fencing remains active`);
        }).catch(error => console.error(`[Lock] heartbeat failed for ${key}:`, error.message));
    }, intervalMs);
    timer.unref?.();
    return async () => {
        stopped = true;
        clearInterval(timer);
        await inFlight;
    };
}

async function removeQueuedSendJobsForShop(shopId = null) {
    const jobs = await capiQueue.getJobs(['waiting', 'delayed', 'paused'], 0, -1);
    let removed = 0;
    for (const job of jobs) {
        if (job.name !== 'send-fb-batch') continue;
        if (shopId && Number(job.data?.shopId) !== Number(shopId)) continue;
        try {
            await job.remove();
            removed += 1;
        } catch (error) {
            // Active jobs cannot be removed here; the worker re-checks event_store before sending.
        }
    }
    return removed;
}

function scoreFromValue(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const match = value.match(/\d+(?:\.\d+)?/);
        if (match) return Number(match[0]);
    }
    if (typeof value === 'object') {
        return scoreFromValue(firstPresent(
            value.score,
            value.value,
            value.rating,
            value.event_match_quality_score,
            value.match_quality_score,
            value.event_match_quality,
        ));
    }
    return null;
}

function eventNameFromObject(value) {
    return firstPresent(
        value.event_name,
        value.event,
        value.standard_event,
        value.event_type,
        value.name,
    );
}

function extractOfficialEmqEvents(rawPayload) {
    const events = [];
    const seen = new Set();

    function visit(value) {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }

        const eventName = eventNameFromObject(value);
        const score = scoreFromValue(firstPresent(
            value.event_match_quality_score,
            value.match_quality_score,
            value.event_match_quality,
            value.emq_score,
            value.score,
        ));
        if (eventName && score !== null) {
            const key = `${eventName}:${score}`;
            if (!seen.has(key)) {
                seen.add(key);
                events.push({
                    event_name: String(eventName),
                    score: Number(score.toFixed(1)),
                });
            }
        }

        Object.values(value).forEach(visit);
    }

    visit(rawPayload);
    return events;
}

function summarizeMetaQuality(rawPayload) {
    const events = extractOfficialEmqEvents(rawPayload);
    const average = events.length
        ? Number((events.reduce((sum, item) => sum + Number(item.score || 0), 0) / events.length).toFixed(1))
        : null;
    return {
        metric_type: META_QUALITY_METRIC_TYPE,
        average_score: average,
        events,
    };
}

async function insertMetaQualitySnapshot(pixel, shopId, status, rawPayload, errorMessage = null) {
    const summary = status === 'SUCCESS' ? summarizeMetaQuality(rawPayload) : null;
    await pool.query(
        `INSERT INTO meta_quality_snapshots
            (pixel_route_id, shop_id, dataset_id, status, metric_type, summary_payload, raw_payload, error_message)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
        [
            pixel.id,
            shopId,
            pixel.pixel_id,
            status,
            META_QUALITY_METRIC_TYPE,
            summary ? JSON.stringify(summary) : null,
            rawPayload ? JSON.stringify(rawPayload) : null,
            errorMessage,
        ],
    );
    return summary;
}

async function fetchMetaQualityForPixel(pixel) {
    const token = decryptTokenIfPossible(firstPresent(pixel.quality_access_token, pixel.access_token));
    if (!token) throw new Error('Missing Meta quality token');

    const url = `https://graph.facebook.com/${config.fbApiVersion}/dataset_quality`;
    const response = await axios.get(url, {
        timeout: config.fbRequestTimeoutMs,
        headers: {
            Authorization: `Bearer ${token}`,
        },
        params: {
            dataset_id: pixel.pixel_id,
            web_metric_type: META_QUALITY_METRIC_TYPE,
        },
    });
    return response;
}

async function refreshMetaQualityForPixel(pixel) {
    if (pixel.platform !== 'facebook') return null;
    const shopIds = Array.isArray(pixel.shop_ids) ? pixel.shop_ids : [pixel.shop_id].filter(Boolean);
    const rateLimitUntil = Date.parse(pixel.rate_limit_until);
    if (Number.isFinite(rateLimitUntil) && rateLimitUntil > Date.now()) {
        return {
            pixel_id: pixel.pixel_id,
            status: 'DEFERRED',
            retry_after_seconds: Math.ceil((rateLimitUntil - Date.now()) / 1000),
        };
    }

    try {
        const response = await fetchMetaQualityForPixel(pixel);
        const rawPayload = response.data;
        const rateControl = metaRateControlFromHeaders(response.headers);
        await pool.query(
            `UPDATE pixels
             SET last_usage_pct = COALESCE($2, last_usage_pct),
                 rate_limit_until = CASE
                     WHEN $3::int > 0
                     THEN GREATEST(
                         COALESCE(rate_limit_until, NOW()),
                         NOW() + ($3::int * INTERVAL '1 second')
                     )
                     ELSE rate_limit_until
                 END,
                 last_rate_limit_at = CASE WHEN $3::int > 0 THEN NOW() ELSE last_rate_limit_at END
             WHERE id = $1`,
            [
                pixel.id,
                rateControl.maxUsagePercent === undefined ? null : Number(rateControl.maxUsagePercent),
                Math.ceil(Number(rateControl.cooldownSeconds || 0)),
            ],
        );
        let summary;
        for (const shopId of shopIds) {
            summary = await insertMetaQualitySnapshot(pixel, shopId, 'SUCCESS', rawPayload);
        }
        return { pixel_id: pixel.pixel_id, status: 'SUCCESS', summary };
    } catch (error) {
        const responsePayload = error.response?.data || null;
        const classification = classifyFacebookError(error);
        const message = classification.message;
        if (classification.retryable) {
            const cooldownSeconds = Math.max(
                Number(classification.retryAfterSeconds || 0),
                Number(classification.rateControl?.cooldownSeconds || 0),
                60,
            );
            await pool.query(
                `UPDATE pixels
                 SET rate_limit_until = GREATEST(
                         COALESCE(rate_limit_until, NOW()),
                         NOW() + ($2::int * INTERVAL '1 second')
                     ),
                     last_rate_limit_at = NOW(),
                     last_usage_pct = COALESCE($3, last_usage_pct)
                 WHERE id = $1`,
                [
                    pixel.id,
                    Math.ceil(cooldownSeconds),
                    classification.rateControl?.maxUsagePercent === undefined
                        ? null
                        : Number(classification.rateControl.maxUsagePercent),
                ],
            );
        }
        for (const shopId of shopIds) {
            await insertMetaQualitySnapshot(pixel, shopId, 'FAILED', responsePayload, message);
        }
        return { pixel_id: pixel.pixel_id, status: 'FAILED', error: message };
    }
}

async function refreshMetaQualitySnapshots(shopId = null) {
    const params = shopId ? [shopId] : [];
    const shopFilter = shopId ? 'AND r.shop_id = $1' : '';
    const { rows: pixels } = await pool.query(
        `SELECT p.id,
                ARRAY_AGG(DISTINCT r.shop_id ORDER BY r.shop_id) AS shop_ids,
                p.platform,
                p.name,
                p.pixel_id,
                p.access_token,
                p.quality_access_token,
                p.rate_limit_until
         FROM shop_pixel_routes r
         JOIN pixels p ON p.id = r.pixel_id
         JOIN shops s ON s.id = r.shop_id
         WHERE p.platform = 'facebook'
           AND r.status = 'active'
           AND s.status = 'active'
           ${shopFilter}
         GROUP BY p.id
         ORDER BY p.id ASC`,
        params,
    );

    const results = [];
    for (const pixel of pixels) {
        const lockKey = `lock:delivery-credential:${pixel.id}`;
        const lockToken = crypto.randomUUID();
        const ttlSeconds = Math.max(30, Math.ceil(config.credentialLeaseMs / 1000));
        const lock = await redis.set(lockKey, lockToken, 'EX', ttlSeconds, 'NX');
        if (!lock) {
            results.push({
                pixel_id: pixel.pixel_id,
                status: 'SKIPPED',
                reason: 'credential_busy',
            });
            continue;
        }
        const stopLockHeartbeat = startRedisLockHeartbeat(lockKey, lockToken, ttlSeconds);
        try {
            results.push(await refreshMetaQualityForPixel(pixel));
        } finally {
            await stopLockHeartbeat().catch(() => {});
            await releaseRedisLock(lockKey, lockToken).catch(() => {});
        }
    }
    return results;
}

function buildUserData(req, payload, options = {}) {
    const email = firstPresent(payload.email, payload.customer_email);
    const phone = firstPresent(payload.phone, payload.customer_phone);
    const firstName = firstPresent(payload.firstName, payload.first_name, payload.customer_first_name);
    const lastName = firstPresent(payload.lastName, payload.last_name, payload.customer_last_name);
    const city = firstPresent(payload.city, payload.customer_city);
    const state = firstPresent(payload.state, payload.province, payload.province_code, payload.customer_state);
    const zip = firstPresent(payload.zip, payload.postal_code, payload.postalCode, payload.customer_zip);
    const country = firstPresent(payload.country, payload.country_code, payload.customer_country);
    const externalId = primaryExternalId(payload);
    const tenantId = normalizeShopDomain(firstPresent(payload.tenant_id, payload.shop_domain));
    const scopedExternalId = tenantScopedExternalId(
        tenantId,
        firstPresent(externalId, firstScalar(payload.external_id_hash)),
    );

    const hashed = {
        em: collectHashedUserData(
            [payload.email_hash, payload.email_sha256],
            [payload.em, email],
            'email',
        ),
        ph: collectHashedUserData(
            [payload.phone_hash, payload.phone_sha256],
            [payload.ph, phone],
            'phone',
            { country },
        ),
        fn: collectHashedUserData([payload.first_name_hash], [payload.fn, firstName], 'name'),
        ln: collectHashedUserData([payload.last_name_hash], [payload.ln, lastName], 'name'),
        ct: collectHashedUserData([payload.city_hash], [payload.ct, city], 'city'),
        st: collectHashedUserData([payload.state_hash], [payload.st, state], 'state', { country }),
        zp: collectHashedUserData([payload.zip_hash], [payload.zp, zip], 'zip', { country }),
        country: collectHashedUserData(
            [payload.country_hash, payload.country_sha256],
            [payload.country_hashed, country],
            'country',
        ),
        external_id: scopedExternalId ? [scopedExternalId] : undefined,
    };

    return compactObject({
        // Shopify webhook requests originate from Shopify infrastructure. Never
        // mistake Shopify's IP or user agent for the shopper's match signals.
        client_ip_address: firstPresent(
            payload.client_ip,
            options.allowRequestIdentifiers ? firstForwardedIp(req) : undefined,
        ),
        client_user_agent: firstPresent(
            payload.user_agent,
            options.allowRequestIdentifiers ? req.headers['user-agent'] : undefined,
        ),
        fbc: normalizeMetaCookie(firstPresent(payload.fbc, payload._fbc)),
        fbp: normalizeMetaCookie(firstPresent(payload.fbp, payload._fbp)),
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
    const routeHints = payload.route_hints || {};
    const pixelIds = Array.isArray(payload.pixel_ids)
        ? payload.pixel_ids.map(String).filter(Boolean)
        : (payload.pixel_id ? [String(payload.pixel_id)] : []);
    const datasetIds = Array.isArray(payload.dataset_ids)
        ? payload.dataset_ids.map(String).filter(Boolean)
        : (payload.dataset_id ? [String(payload.dataset_id)] : []);
    const facebookPixelIds = Array.isArray(routeHints.facebook_pixel_ids)
        ? routeHints.facebook_pixel_ids.map(String).filter(Boolean)
        : pixelIds;
    const tiktokPixelIds = Array.isArray(routeHints.tiktok_pixel_ids)
        ? routeHints.tiktok_pixel_ids.map(String).filter(Boolean)
        : undefined;

    return compactObject({
        tenant_id: payload.tenant_id,
        shop_domain: payload.shop_domain,
        schema_version: payload.schema_version,
        source_version: payload.source_version,
        trace_id: payload.trace_id,
        pixel_ids: pixelIds.length ? pixelIds : undefined,
        dataset_ids: datasetIds.length ? datasetIds : undefined,
        pixel_id: payload.pixel_id,
        dataset_id: payload.dataset_id,
        route_hints: compactObject({
            facebook_pixel_ids: facebookPixelIds?.length ? facebookPixelIds : undefined,
            tiktok_pixel_ids: tiktokPixelIds?.length ? tiktokPixelIds : undefined,
        }),
        tiktok: compactObject({
            ttp: payload.ttp,
            ttclid: payload.ttclid,
        }),
    });
}

function buildCustomData(payload) {
    if (Array.isArray(payload.contents) && payload.contents.length > 200) {
        const error = new Error('contents must contain 200 items or fewer');
        error.statusCode = 422;
        throw error;
    }
    if (Array.isArray(payload.content_ids) && payload.content_ids.length > 200) {
        const error = new Error('content_ids must contain 200 items or fewer');
        error.statusCode = 422;
        throw error;
    }
    const contents = Array.isArray(payload.contents)
        ? payload.contents
            .filter(Boolean)
            .map(item => compactObject({
                id: firstPresent(item.id, item.content_id) ? String(firstPresent(item.id, item.content_id)) : undefined,
                quantity: Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0
                    ? Number(item.quantity)
                    : undefined,
                item_price: Number.isFinite(Number(firstPresent(item.item_price, item.price)))
                    && Number(firstPresent(item.item_price, item.price)) >= 0
                    ? Number(firstPresent(item.item_price, item.price))
                    : undefined,
            }))
            .filter(item => item.id)
        : undefined;
    // Item-level contents are the authoritative cart snapshot. Deriving IDs
    // from them prevents a stale caller-supplied content_ids list from
    // referring to products that are not present in the event contents.
    const contentIds = contents?.length
        ? contents.map(item => String(item.id))
        : (Array.isArray(payload.content_ids)
            ? payload.content_ids.filter(Boolean).map(String)
            : undefined);
    const numItems = Number.isFinite(Number(payload.num_items))
        ? Number(payload.num_items)
        : contents?.reduce((sum, item) => sum + Number(item.quantity || 0), 0);

    return compactObject({
        value: payload.value !== undefined && Number.isFinite(Number(payload.value)) && Number(payload.value) >= 0
            ? Number(payload.value)
            : undefined,
        currency: payload.currency ? String(payload.currency).trim().toUpperCase() : undefined,
        content_ids: contentIds?.length ? contentIds : undefined,
        contents: contents?.length ? contents : undefined,
        content_type: payload.content_type,
        content_name: payload.content_name,
        content_category: payload.content_category,
        num_items: numItems > 0 ? numItems : undefined,
        order_id: tenantScopedIdentifier(
            firstPresent(payload.tenant_id, payload.shop_domain),
            payload.order_id,
        ),
        search_string: payload.search_string,
    });
}

function mergeQueuedEvent(left, right) {
    const mergedUserData = mergeUserData(left.user_data, right.user_data);
    const merged = {
        ...left,
        ...right,
        event_time: Math.min(Number(left.event_time || right.event_time), Number(right.event_time || left.event_time)),
        event_source_url: firstPresent(right.event_source_url, left.event_source_url),
        user_data: mergedUserData,
        custom_data: mergeCustomData(left.custom_data, right.custom_data),
        _platform_data: mergePlatformData(left._platform_data, right._platform_data),
        _duplicate_candidate: Boolean(left._duplicate_candidate || right._duplicate_candidate),
        _attribution_enriched: Boolean(left._attribution_enriched || right._attribution_enriched),
        _received_at: Math.min(Number(left._received_at || right._received_at), Number(right._received_at || left._received_at)),
    };
    merged._emq_estimate = Math.max(Number(left._emq_estimate || 0), Number(right._emq_estimate || 0), calculateEMQ(mergedUserData));
    merged._quality = {
        missing_match_signals: missingMatchSignals(mergedUserData),
        missing_event_parameters: missingCommerceSignals(merged.event_name, merged.custom_data),
    };
    return compactObject(merged);
}

function mergeReadyEvents(events) {
    const byKey = new Map();
    for (const event of events) {
        const key = `${event.event_name}:${event.event_id}`;
        const existing = byKey.get(key);
        byKey.set(key, existing ? mergeQueuedEvent(existing, event) : event);
    }
    return [...byKey.values()];
}

function resolveEventTime(payload) {
    const now = Math.floor(Date.now() / 1000);
    const raw = firstPresent(payload.timestamp, payload.event_time);
    const numeric = Number(raw);
    const seconds = Number.isFinite(numeric) && String(raw).trim() !== ''
        ? Math.floor(numeric > 10_000_000_000 ? numeric / 1000 : numeric)
        : Math.floor(Date.parse(raw) / 1000);
    if (!Number.isInteger(seconds) || seconds <= 0) return now;
    if (seconds > now + 300) return now;
    return seconds;
}

async function queueStalePendingEvents() {
    const cursorKey = 'scheduler:stale_pending_shop_cursor';
    const cursor = Number(await optionalRedis(
        () => redis.get(cursorKey),
        0,
        'backlog rescue cursor',
    ) || 0);
    const loadShopsAfter = afterShopId => pool.query(
        `SELECT e.shop_id, MIN(e.timestamp) AS oldest_pending_at
         FROM event_store e
         JOIN shops s ON s.id = e.shop_id
         WHERE e.status = 'PENDING'
           AND s.status = 'active'
           AND e.shop_id > $2
           AND e.timestamp < NOW() - ($1::int * INTERVAL '1 minute')
           AND EXISTS (
                   SELECT 1
                   FROM shop_pixel_routes active_route
                   LEFT JOIN event_deliveries ready
                     ON ready.event_store_id = e.id
                    AND ready.route_id = active_route.id
                   WHERE active_route.shop_id = e.shop_id
                     AND active_route.status = 'active'
                     AND (
                         ready.id IS NULL
                         OR (
                             ready.next_attempt_at <= NOW()
                             AND (
                                 ready.status IN ('PENDING', 'RETRYABLE_FAILED')
                                 OR (ready.status = 'IN_PROGRESS' AND ready.lease_expires_at < NOW())
                             )
                         )
                     )
           )
         GROUP BY e.shop_id
         ORDER BY e.shop_id ASC
         LIMIT $3`,
        [config.deliveryRescueMinutes, afterShopId, config.deliveryRescueShopLimit],
    );
    let { rows } = await loadShopsAfter(cursor);
    if (rows.length === 0 && cursor > 0) ({ rows } = await loadShopsAfter(0));
    if (rows.length === 0) return 0;

    let queued = 0;
    const rescueMinute = Math.floor(Date.now() / 60000);
    for (const row of rows) {
        const shopId = Number(row.shop_id);
        await capiQueue.add(
            'send-fb-batch',
            { shopId },
            { jobId: `rescue-${shopId}-${rescueMinute}` },
        );
        queued += 1;
    }
    void optionalRedis(
        () => redis.set(cursorKey, String(rows[rows.length - 1].shop_id)),
        undefined,
        'backlog rescue cursor save',
    );
    return queued;
}

async function reconcileEventAggregateStatuses() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [lock] } = await client.query(
            "SELECT pg_try_advisory_xact_lock(hashtext('capi-saas-pro:aggregate-reconcile')) AS acquired",
        );
        if (lock?.acquired !== true) {
            await client.query('ROLLBACK');
            return 0;
        }

        const { rowCount } = await client.query(
            `WITH candidates AS (
                 SELECT event.id
                 FROM event_store event
                 WHERE event.status = 'PENDING'
                   AND EXISTS (
                       SELECT 1 FROM event_deliveries delivery
                       WHERE delivery.event_store_id = event.id
                   )
                   AND NOT EXISTS (
                       SELECT 1
                       FROM event_deliveries outstanding
                       WHERE outstanding.event_store_id = event.id
                         AND outstanding.status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')
                   )
                   AND NOT EXISTS (
                       SELECT 1
                       FROM shop_pixel_routes route
                       WHERE route.shop_id = event.shop_id
                         AND route.status = 'active'
                         AND NOT EXISTS (
                             SELECT 1
                             FROM event_deliveries missing
                             WHERE missing.event_store_id = event.id
                               AND missing.route_id = route.id
                         )
                   )
                 ORDER BY event.id ASC
                 FOR UPDATE OF event SKIP LOCKED
                 LIMIT $1
             ),
             delivery_summary AS (
                 SELECT delivery.event_store_id,
                        COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE delivery.status = 'SUCCESS') AS succeeded,
                        COUNT(*) FILTER (WHERE delivery.status = 'FAILED_PERMANENT') AS permanent_failed,
                        COUNT(*) FILTER (
                            WHERE delivery.status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')
                        ) AS outstanding
                 FROM event_deliveries delivery
                 JOIN candidates candidate ON candidate.id = delivery.event_store_id
                 GROUP BY delivery.event_store_id
             ),
             expected AS (
                 SELECT event_store_id,
                        CASE
                            WHEN total > 0 AND succeeded = total THEN 'SUCCESS'
                            WHEN outstanding > 0 THEN 'PENDING'
                            WHEN succeeded > 0 AND permanent_failed > 0 THEN 'PARTIAL_FAILED'
                            WHEN permanent_failed = total THEN 'FAILED'
                        END AS status
                 FROM delivery_summary
             )
             UPDATE event_store event
             SET status = expected.status
             FROM expected
             WHERE event.id = expected.event_store_id
               AND expected.status IS NOT NULL
               AND event.status IS DISTINCT FROM expected.status`,
            [config.aggregateReconcileBatchSize],
        );
        await client.query('COMMIT');
        return rowCount;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function deleteRetentionBatches(query, retentionDays) {
    let deleted = 0;
    for (let batch = 0; batch < config.cleanupMaxBatches; batch += 1) {
        const result = await pool.query(query, [retentionDays, config.cleanupBatchSize]);
        deleted += result.rowCount;
        if (result.rowCount < config.cleanupBatchSize) break;
    }
    return deleted;
}

async function cleanupExpiredOperationalData() {
    const eventStore = await deleteRetentionBatches(
        `WITH expired AS (
             SELECT id
             FROM event_store
             WHERE status IN ('SUCCESS', 'FAILED', 'PARTIAL_FAILED', 'AWAITING_PAYMENT')
               AND timestamp < NOW() - ($1::int * INTERVAL '1 day')
             ORDER BY timestamp ASC, id ASC
             FOR UPDATE SKIP LOCKED
             LIMIT $2
         )
         DELETE FROM event_store target
         USING expired
         WHERE target.id = expired.id`,
        config.eventRetentionDays,
    );
    const aliases = await deleteRetentionBatches(
        `WITH expired AS (
             SELECT alias.id
             FROM event_id_aliases alias
             WHERE alias.updated_at < NOW() - ($1::int * INTERVAL '1 day')
               AND NOT EXISTS (
                   SELECT 1
                   FROM event_store event
                   WHERE event.shop_id = alias.shop_id
                     AND event.event_name = alias.event_name
                     AND event.event_id = alias.canonical_event_id
                     AND event.status IN ('PENDING', 'AWAITING_PAYMENT')
               )
             ORDER BY alias.updated_at ASC, alias.id ASC
             FOR UPDATE SKIP LOCKED
             LIMIT $2
         )
         DELETE FROM event_id_aliases target
         USING expired
         WHERE target.id = expired.id`,
        config.aliasRetentionDays,
    );
    const webhookInbox = await deleteRetentionBatches(
        `WITH expired AS (
             SELECT id
             FROM shopify_webhook_inbox
             WHERE status IN ('SUCCESS', 'FAILED_PERMANENT')
               AND COALESCE(processed_at, created_at) < NOW() - ($1::int * INTERVAL '1 day')
             ORDER BY COALESCE(processed_at, created_at), id
             FOR UPDATE SKIP LOCKED
             LIMIT $2
         )
         DELETE FROM shopify_webhook_inbox target
         USING expired
         WHERE target.id = expired.id`,
        config.eventRetentionDays,
    );
    const deadLetters = await deleteRetentionBatches(
        `WITH expired AS (
             SELECT id
             FROM dead_letters
             WHERE failed_at < NOW() - ($1::int * INTERVAL '1 day')
             ORDER BY failed_at ASC, id ASC
             FOR UPDATE SKIP LOCKED
             LIMIT $2
         )
         DELETE FROM dead_letters target
         USING expired
         WHERE target.id = expired.id`,
        config.deadLetterRetentionDays,
    );
    const qualitySnapshots = await deleteRetentionBatches(
        `WITH expired AS (
             SELECT id
             FROM meta_quality_snapshots
             WHERE fetched_at < NOW() - ($1::int * INTERVAL '1 day')
             ORDER BY fetched_at ASC, id ASC
             FOR UPDATE SKIP LOCKED
             LIMIT $2
         )
         DELETE FROM meta_quality_snapshots target
         USING expired
         WHERE target.id = expired.id`,
        config.qualityRetentionDays,
    );
    return { eventStore, aliases, webhookInbox, deadLetters, qualitySnapshots };
}

async function insertMalformedQueuedEvent(shopId, rawPayload, reason) {
    await pool.query(
        `INSERT INTO dead_letters (shop_id, payload, error_reason)
         VALUES ($1, $2, $3)`,
        [shopId, JSON.stringify([{ raw_payload: rawPayload }]), reason],
    );
}

async function completeProcessingBatch(processingKey, pendingKey, deferredEvents) {
    const deferredPayloads = deferredEvents.map(event => JSON.stringify(event));
    await redis.completeProcessing(processingKey, pendingKey, ...deferredPayloads);
}

async function restoreReplayableEvents(shopId, dbEvents) {
    const restored = [];
    for (const event of dbEvents) {
        const payload = event.request_payload || event;
        const eventName = payload.event_name;
        const eventId = payload.event_id;
        if (!eventName || !eventId) continue;

        const emqEstimate = event.emq_estimate || payload._emq_estimate || null;
        const persisted = await persistOutboxEvent(shopId, {
            ...payload,
            _emq_estimate: emqEstimate,
        });
        if (persisted) {
            const mergedPayload = persisted.request_payload || payload;
            const isAwaitingPayment = mergedPayload._requires_payment_confirmation === true
                && mergedPayload._payment_confirmed !== true;
            if (isAwaitingPayment) {
                await pool.query(
                    `UPDATE event_store
                     SET status = 'AWAITING_PAYMENT', fb_response = NULL
                     WHERE id = $1 AND status <> 'SUCCESS'`,
                    [persisted.id],
                );
                continue;
            }

            const { rows } = await pool.query(
                `UPDATE event_store
                 SET status = 'PENDING', timestamp = NOW(), fb_response = NULL
                 WHERE id = $1 AND status <> 'SUCCESS'
                 RETURNING id, request_payload, status, fb_response`,
                [persisted.id],
            );
            if (rows.length === 0) continue;
            const restoredIds = rows.map(row => row.id);
            // Manual DLQ replay is an explicit retry decision. Reset only
            // permanently failed deliveries on routes that are still active;
            // successful routes remain immutable and inactive routes stay off.
            await pool.query(
                `UPDATE event_deliveries delivery
                 SET status = 'PENDING',
                     attempt_count = 0,
                     next_attempt_at = NOW(),
                     lease_expires_at = NULL,
                     last_attempt_at = NULL,
                     error_code = NULL,
                     error_message = NULL,
                     updated_at = NOW()
                 FROM shop_pixel_routes route
                 WHERE delivery.route_id = route.id
                   AND route.shop_id = $1
                   AND route.status = 'active'
                   AND delivery.event_store_id = ANY($2::bigint[])
                   AND delivery.status = 'FAILED_PERMANENT'`,
                [shopId, restoredIds],
            );
            restored.push(...rows);
        }
    }
    return restored;
}

function withTimeout(promise, timeoutMs, label) {
    let timeoutId;
    const timeout = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        timeoutId.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function optionalRedis(operation, fallback, label) {
    if (redis.status !== 'ready') return fallback;
    try {
        return await withTimeout(Promise.resolve().then(operation), 1500, label);
    } catch (error) {
        console.warn(`[Ingest] ${label} unavailable; durable PostgreSQL path continues`);
        return fallback;
    }
}

async function persistOutboxEvent(shopId, payload) {
    const purePayload = { ...payload };
    const emqEstimate = purePayload._emq_estimate;
    delete purePayload._emq_estimate;
    const initialStatus = purePayload._requires_payment_confirmation
        && !purePayload._payment_confirmed
        ? 'AWAITING_PAYMENT'
        : 'PENDING';
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const inserted = await client.query(
            `INSERT INTO event_store
                (shop_id, event_name, event_id, status, emq_estimate, request_payload)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT (shop_id, event_name, event_id) DO NOTHING
             RETURNING id, shop_id, event_name, event_id, request_payload, emq_estimate, status, fb_response`,
            [
                shopId,
                purePayload.event_name,
                purePayload.event_id,
                initialStatus,
                emqEstimate,
                JSON.stringify(purePayload),
            ],
        );
        if (inserted.rowCount > 0) {
            await client.query('COMMIT');
            return inserted.rows[0];
        }

        const existingResult = await client.query(
            `SELECT id, shop_id, event_name, event_id, request_payload,
                    emq_estimate, status, fb_response
             FROM event_store
             WHERE shop_id = $1 AND event_name = $2 AND event_id = $3
             FOR UPDATE`,
            [shopId, purePayload.event_name, purePayload.event_id],
        );
        const existing = existingResult.rows[0];
        if (!existing) {
            throw new Error('Conflicting event disappeared before durable merge');
        }
        if (existing.status === 'SUCCESS') {
            await client.query('COMMIT');
            return null;
        }

        const paymentUnlocked = existing.status === 'AWAITING_PAYMENT'
            && purePayload._payment_confirmed === true;
        const recoverableValidationFailure = existing.status !== 'AWAITING_PAYMENT'
            && ['FAILED', 'PARTIAL_FAILED'].includes(existing.status)
            && (await client.query(
                `SELECT 1
                 FROM event_deliveries
                 WHERE event_store_id = $1
                   AND status = 'FAILED_PERMANENT'
                   AND error_code = 'LOCAL_VALIDATION'
                 LIMIT 1`,
                [existing.id],
            )).rowCount > 0;
        const reopenForDelivery = paymentUnlocked || recoverableValidationFailure;
        const mergedPayload = mergePersistedEventPayload(existing.request_payload, purePayload);
        const emqCandidates = [
            existing.emq_estimate,
            emqEstimate,
            calculateEMQ(mergedPayload.user_data || {}),
        ]
            .map(Number)
            .filter(Number.isFinite);
        const mergedEmq = emqCandidates.length ? Math.max(...emqCandidates) : null;
        const updated = await client.query(
            `UPDATE event_store
             SET status = CASE WHEN $2::boolean THEN 'PENDING' ELSE status END,
                 timestamp = CASE WHEN $2::boolean THEN NOW() ELSE timestamp END,
                 emq_estimate = $3,
                 request_payload = $4::jsonb
             WHERE id = $1
             RETURNING id, shop_id, event_name, event_id, request_payload,
                       emq_estimate, status, fb_response`,
            [existing.id, reopenForDelivery, mergedEmq, JSON.stringify(mergedPayload)],
        );
        if (recoverableValidationFailure) {
            await client.query(
                `UPDATE event_deliveries
                 SET status = 'PENDING',
                     attempt_count = 0,
                     next_attempt_at = NOW(),
                     lease_expires_at = NULL,
                     error_code = NULL,
                     error_message = NULL,
                     updated_at = NOW()
                 WHERE event_store_id = $1
                   AND status = 'FAILED_PERMANENT'
                   AND error_code = 'LOCAL_VALIDATION'`,
                [existing.id],
            );
        }
        await client.query('COMMIT');
        return updated.rows[0];
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function scheduleDurableDispatch(shopId, eventName) {
    if (redis.status !== 'ready') throw new Error('Redis is not ready');
    const isPurchase = eventName === 'Purchase';
    const queueClass = isPurchase ? 'purchase' : 'realtime';
    const timeBucket = Math.floor(Date.now() / 1000);
    const delay = isPurchase ? config.purchaseSettleMs : 0;
    return withTimeout(
        (async () => {
            const jobId = `dispatch-${shopId}-${queueClass}-${timeBucket}`;
            const job = await capiQueue.add('send-fb-batch', { shopId }, { delay, jobId });
            const state = await job.getState();
            // BullMQ retains completed jobs for diagnostics. If a same-second
            // event reuses an already completed/failed coalescing ID, adding it
            // alone does not create new work and the event would wait for the
            // rescue scan. A unique follow-up closes that high-traffic gap.
            if (state === 'completed' || state === 'failed') {
                return capiQueue.add(
                    'send-fb-batch',
                    { shopId },
                    {
                        delay,
                        jobId: `${jobId}-${crypto.randomUUID()}`,
                    },
                );
            }
            return job;
        })(),
        1500,
        'BullMQ dispatch',
    );
}

async function wakeShopOutboxes(shopIds) {
    const uniqueShopIds = [...new Set(shopIds.map(Number).filter(Number.isInteger))];
    const results = await Promise.allSettled(
        uniqueShopIds.map(shopId => scheduleDurableDispatch(shopId, 'RouteActivated')),
    );
    const failed = results.filter(result => result.status === 'rejected').length;
    if (failed > 0) {
        console.warn(`[Routing] ${failed} shop outbox wakeups deferred to the PostgreSQL rescue scan`);
    }
}

async function queueEventForOutbox(req, payload, shopId, options = {}) {
    const trustedPayload = options.allowRequestIdentifiers
        ? {
            ...payload,
            // For browser ingestion, the network request is authoritative.
            // Never let JSON override the actual request IP/UA and then cache
            // the spoofed values into a later paid Purchase.
            client_ip: firstForwardedIp(req),
            user_agent: firstPresent(req.headers['user-agent'], payload.user_agent),
        }
        : payload;
    const eventName = requireBoundedString(trustedPayload.event_name, 'event_name', 50);
    const rawEventId = requireBoundedString(trustedPayload.event_id, 'event_id', 4096);
    const proposedEventId = normalizeEventId(rawEventId);
    const attribution = await optionalRedis(
        () => loadAttributionSnapshot(shopId, trustedPayload),
        {},
        'attribution lookup',
    );
    const enrichedPayload = { ...attribution, ...trustedPayload };
    const eventId = await resolveCanonicalEventIdDurably(
        shopId,
        eventName,
        proposedEventId,
        enrichedPayload,
    );
    optionalRedis(
        () => saveAttributionSnapshot(shopId, enrichedPayload),
        undefined,
        'attribution save',
    );
    const userData = buildUserData(req, enrichedPayload, options);
    const customData = buildCustomData(enrichedPayload);
    const requiresPaymentConfirmation = eventName === 'Purchase'
        && options.requirePaymentConfirmation === true;
    const paymentConfirmed = eventName === 'Purchase'
        && options.paymentConfirmed === true;
    const fbEventData = {
        event_name: eventName,
        event_time: resolveEventTime(enrichedPayload),
        action_source: normalizeActionSource(enrichedPayload.action_source),
        event_id: eventId,
        event_source_url: eventSourceUrlForPayload(req, enrichedPayload),
        referrer_url: normalizeUrl(enrichedPayload.referrer),
        customer_segmentation: normalizeCustomerSegmentation(enrichedPayload.customer_segmentation),
        opt_out: typeof enrichedPayload.opt_out === 'boolean' ? enrichedPayload.opt_out : undefined,
        user_data: userData,
        custom_data: customData,
        _emq_estimate: calculateEMQ(userData),
        _quality: {
            missing_match_signals: missingMatchSignals(userData),
            missing_event_parameters: missingCommerceSignals(eventName, customData),
        },
        _platform_data: buildPlatformData(enrichedPayload),
        _requires_payment_confirmation: requiresPaymentConfirmation,
        _payment_confirmed: paymentConfirmed,
        _attribution_enriched: Object.keys(attribution).length > 0,
        _received_at: Date.now(),
    };

    const validationErrors = validateMetaEvent(
        prepareMetaEvent(stripPrivateFields({ ...fbEventData })),
    );
    if (validationErrors.length > 0) {
        const error = new Error(`Event validation failed: ${validationErrors.join('; ')}`);
        error.statusCode = 422;
        throw error;
    }

    const dbEvent = await persistOutboxEvent(shopId, fbEventData);
    if (!dbEvent) {
        return {
            statusCode: 200,
            body: {
                success: true,
                deduplicated: true,
                durable: true,
                event_id: eventId,
            },
        };
    }
    if (dbEvent.status === 'AWAITING_PAYMENT') {
        return {
            statusCode: 202,
            body: {
                success: true,
                queued: true,
                durable: true,
                dispatch_scheduled: false,
                awaiting_payment_confirmation: true,
                event_id: eventId,
            },
        };
    }
    if (dbEvent.status !== 'PENDING') {
        return {
            statusCode: 200,
            body: {
                success: true,
                deduplicated: true,
                durable: true,
                terminal_status: dbEvent.status,
                event_id: eventId,
            },
        };
    }

    let dispatchScheduled = true;
    try {
        await scheduleDurableDispatch(shopId, eventName);
    } catch (error) {
        // The PostgreSQL outbox is authoritative. The watchdog will dispatch
        // this row when Redis/BullMQ recovers.
        dispatchScheduled = false;
        console.warn(`[Ingest] event ${dbEvent.id} persisted; immediate dispatch unavailable`);
    }

    return {
        statusCode: 202,
        body: {
            success: true,
            queued: true,
            durable: true,
            dispatch_scheduled: dispatchScheduled,
            event_id: eventId,
        },
    };
}

async function queueForOutbox(req, res, payload, shopId, options = {}) {
    const result = await queueEventForOutbox(req, payload, shopId, options);
    return res.status(result.statusCode).json(result.body);
}

app.post('/api/pixel-event', pixelLimiter, asyncHandler(async (req, res) => {
    const payloads = pixelPayloadsFromBody(req.body);
    if (payloads.length === 0) return res.status(400).json({ error: 'Missing event payload' });
    if (payloads.length > MAX_PIXEL_BATCH_SIZE) {
        return res.status(413).json({ error: `Too many events. Max batch size is ${MAX_PIXEL_BATCH_SIZE}` });
    }

    const shopDomain = normalizeShopDomain(shopDomainFromPixelBody(req.body));
    if (!shopDomain) return res.status(400).json({ error: 'Missing shop_domain' });
    const suppliedIngestToken = String(
        req.headers['x-capi-ingest-token']
        || req.body?.ingest_token
        || req.body?.events?.[0]?.ingest_token
        || '',
    ).trim();
    if (config.requireIngestToken && !validShopIngestToken(shopDomain, suppliedIngestToken)) {
        return res.status(401).json({ error: 'Invalid shop ingest token' });
    }

    const normalizedPayloads = payloads.map(payload => ({
        ...payload,
        shop_domain: normalizeShopDomain(payload.shop_domain) || shopDomain,
        // Tenant metadata is server-authoritative. Client route hints are
        // diagnostic only and can never change shop ownership or routing.
        tenant_id: shopDomain,
    }));
    if (normalizedPayloads.some(payload => payload.shop_domain !== shopDomain)) {
        return res.status(400).json({ error: 'Batch events must belong to one shop_domain' });
    }

    const { rows } = await pool.query(
        'SELECT id FROM shops WHERE shop_domain = $1 AND status = $2',
        [shopDomain, 'active'],
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Shop inactive' });

    if (normalizedPayloads.length === 1) {
        return queueForOutbox(
            req,
            res,
            { ...normalizedPayloads[0], shop_domain: shopDomain, tenant_id: shopDomain },
            rows[0].id,
            { allowRequestIdentifiers: true, requirePaymentConfirmation: true },
        );
    }

    const results = [];
    for (const payload of normalizedPayloads) {
        try {
            const result = await queueEventForOutbox(
                req,
                { ...payload, shop_domain: shopDomain, tenant_id: shopDomain },
                rows[0].id,
                { allowRequestIdentifiers: true, requirePaymentConfirmation: true },
            );
            results.push(result.body);
        } catch (error) {
            const statusCode = Number(error.statusCode || 500);
            // Continue past malformed individual events so one bad payload
            // cannot prevent later valid events in the batch from becoming
            // durable. Infrastructure failures abort the request; the browser
            // then retries the whole batch with stable IDs.
            if (statusCode >= 500) throw error;
            results.push({
                success: false,
                rejected: true,
                status: statusCode,
                error: error.message,
            });
        }
    }

    const queued = results.filter(result => result.queued).length;
    const deduplicated = results.filter(result => result.deduplicated).length;
    const rejected = results.filter(result => result.rejected).length;
    return res.status(queued > 0 ? 202 : 200).json({
        success: true,
        batch: true,
        received: normalizedPayloads.length,
        queued,
        deduplicated,
        rejected,
        results,
    });
}));

async function processShopifyWebhookInboxRow(row) {
    const order = row.payload || {};
    const ignoreReason = paidOrderIgnoreReason(order, config.shopifyWebOrderSources);
    if (ignoreReason) {
        return { ignored: true, reason: ignoreReason };
    }
    const financialStatus = String(order.financial_status || '').trim().toLowerCase();
    if (financialStatus && financialStatus !== 'paid') {
        const error = new Error(`orders/paid payload has unexpected financial_status: ${financialStatus}`);
        error.statusCode = 422;
        throw error;
    }
    const hasStableOrderIdentity = firstPresent(
        order.checkout_token,
        order.cart_token,
        order.token,
        normalizeShopifyId(order.id),
        order.name,
        order.order_number,
    );
    if (!hasStableOrderIdentity) {
        const error = new Error('Missing stable order identity');
        error.statusCode = 422;
        throw error;
    }
    const payload = buildShopifyOrderPurchasePayload(order, row.shop_domain, {
        eventTimestamp: row.triggered_at || undefined,
    });
    const purchaseValue = Number(payload.value);
    if (!Number.isFinite(purchaseValue) || purchaseValue < 0 || !/^[A-Z]{3}$/.test(String(payload.currency || '').toUpperCase())) {
        const error = new Error('Invalid paid order value or currency');
        error.statusCode = 422;
        throw error;
    }
    const backgroundRequest = { headers: {}, socket: {} };
    return queueEventForOutbox(backgroundRequest, {
        ...payload,
        shop_domain: row.shop_domain,
        tenant_id: row.shop_domain,
    }, Number(row.shop_id), {
        allowRequestIdentifiers: false,
        paymentConfirmed: true,
    });
}

async function claimShopifyWebhookInboxRow() {
    const { rows } = await pool.query(
        `WITH candidate AS (
             SELECT id
             FROM shopify_webhook_inbox
             WHERE next_attempt_at <= NOW()
               AND (
                   status IN ('PENDING', 'RETRYABLE_FAILED')
                   OR (status = 'PROCESSING' AND lease_expires_at < NOW())
               )
             ORDER BY next_attempt_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
         )
         UPDATE shopify_webhook_inbox inbox
         SET status = 'PROCESSING',
             attempt_count = attempt_count + 1,
             lease_expires_at = NOW() + ($1::int * INTERVAL '1 second'),
             error_message = NULL
         FROM candidate
         WHERE inbox.id = candidate.id
         RETURNING inbox.*,
                   (SELECT shop_domain FROM shops WHERE id = inbox.shop_id) AS shop_domain`,
        [config.shopifyWebhookInboxLeaseSeconds],
    );
    return rows[0] || null;
}

let drainingShopifyInbox = false;
async function drainShopifyWebhookInbox(limit = config.shopifyWebhookInboxBatchSize) {
    if (drainingShopifyInbox || fs.existsSync(config.maintenanceFile)) return 0;
    drainingShopifyInbox = true;
    let processed = 0;
    try {
        while (processed < limit) {
            const row = await claimShopifyWebhookInboxRow();
            if (!row) break;
            try {
                await processShopifyWebhookInboxRow(row);
                await pool.query(
                    `UPDATE shopify_webhook_inbox
                     SET status = 'SUCCESS', processed_at = NOW(), lease_expires_at = NULL, error_message = NULL
                     WHERE id = $1 AND status = 'PROCESSING' AND attempt_count = $2`,
                    [row.id, row.attempt_count],
                );
            } catch (error) {
                const statusCode = Number(error.statusCode || 500);
                const permanent = (statusCode >= 400 && statusCode < 500)
                    || Number(row.attempt_count) >= config.shopifyWebhookInboxMaxAttempts;
                const delaySeconds = Math.min(900, 2 ** Math.min(9, Number(row.attempt_count)));
                await pool.query(
                    `UPDATE shopify_webhook_inbox
                     SET status = $2,
                         next_attempt_at = NOW() + ($3::int * INTERVAL '1 second'),
                         lease_expires_at = NULL,
                         processed_at = CASE WHEN $2 = 'FAILED_PERMANENT' THEN NOW() ELSE NULL END,
                         error_message = $4
                     WHERE id = $1 AND status = 'PROCESSING' AND attempt_count = $5`,
                    [row.id, permanent ? 'FAILED_PERMANENT' : 'RETRYABLE_FAILED', delaySeconds, String(error.message).slice(0, 4000), row.attempt_count],
                );
                console.error(`[ShopifyInbox] webhook ${row.id} ${permanent ? 'failed permanently' : 'deferred'}:`, error.message);
            }
            processed += 1;
        }
    } finally {
        drainingShopifyInbox = false;
    }
    return processed;
}

const SHOPIFY_RECONCILE_QUERY = `
    query ReconcilePaidOrders($first: Int!, $after: String, $query: String!) {
        orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
            edges {
                cursor
                node {
                    id name createdAt processedAt updatedAt sourceName test
                    currentSubtotalLineItemsQuantity
                    displayFinancialStatus
                    currentTotalPriceSet { shopMoney { amount currencyCode } }
                    lineItems(first: 200) {
                        nodes {
                            id quantity sku
                            product { id }
                            variant { id }
                            discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
                        }
                    }
                }
            }
            pageInfo { hasNextPage endCursor }
        }
    }
`;

function reconciledGraphqlOrder(node) {
    return {
        _reconciled: true,
        id: node.id,
        name: node.name,
        created_at: node.createdAt,
        processed_at: node.processedAt,
        updated_at: node.updatedAt,
        source_name: node.sourceName,
        test: node.test,
        current_subtotal_line_items_quantity: node.currentSubtotalLineItemsQuantity,
        financial_status: String(node.displayFinancialStatus || '').toLowerCase(),
        current_total_price: node.currentTotalPriceSet?.shopMoney?.amount,
        currency: node.currentTotalPriceSet?.shopMoney?.currencyCode,
        line_items: (node.lineItems?.nodes || []).map(item => ({
            id: item.id,
            product_id: item.product?.id,
            variant_id: item.variant?.id,
            sku: item.sku,
            quantity: item.quantity,
            discountedUnitPriceAfterAllDiscountsSet: item.discountedUnitPriceAfterAllDiscountsSet,
        })),
    };
}

async function reconcilePaidOrdersForShop(shop, db = pool) {
    const state = await db.query(
        `SELECT COALESCE(
                    state.scan_since,
                    state.last_successful_at,
                    NOW() - ($2::int * INTERVAL '1 hour')
                ) AS since,
                state.scan_cutoff,
                state.after_cursor
         FROM shops
         LEFT JOIN shopify_reconcile_state state ON state.shop_id = shops.id
         WHERE shops.id = $1`,
        [shop.id, config.shopifyReconcileLookbackHours],
    );
    const since = new Date(state.rows[0].since).toISOString();
    const scanCutoff = state.rows[0].scan_cutoff
        ? new Date(state.rows[0].scan_cutoff)
        : new Date(Date.now() - (5 * 60 * 1000));
    const cutoff = scanCutoff.toISOString();
    const token = decryptTokenIfPossible(shop.admin_access_token);
    const url = `https://${shop.shop_domain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
    let after = state.rows[0].after_cursor || null;
    let received = 0;
    do {
        const first = Math.min(100, config.shopifyReconcileMaxOrders - received);
        if (first <= 0) break;
        const response = await axios.post(url, {
            query: SHOPIFY_RECONCILE_QUERY,
            variables: {
                first,
                after,
                // Freeze both ends of the scan window. Without the upper
                // bound, orders updated while pagination is in progress can
                // move between pages and invalidate Shopify cursors.
                query: `updated_at:>'${since}' updated_at:<='${cutoff}' financial_status:paid`,
            },
        }, {
            timeout: config.fbRequestTimeoutMs,
            headers: {
                'X-Shopify-Access-Token': token,
                'Content-Type': 'application/json',
            },
        });
        if (Array.isArray(response.data?.errors) && response.data.errors.length > 0) {
            throw new Error(`Shopify GraphQL: ${response.data.errors.map(item => item.message).join('; ')}`);
        }
        const cost = response.data?.extensions?.cost;
        const available = Number(cost?.throttleStatus?.currentlyAvailable);
        const restoreRate = Number(cost?.throttleStatus?.restoreRate);
        const queryCost = Number(cost?.actualQueryCost || cost?.requestedQueryCost);
        if (Number.isFinite(available) && Number.isFinite(restoreRate) && restoreRate > 0
            && Number.isFinite(queryCost) && available < queryCost) {
            const delayMs = Math.min(5000, Math.ceil(((queryCost - available) / restoreRate) * 1000));
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        const connection = response.data?.data?.orders;
        if (!connection) throw new Error('Shopify GraphQL response is missing orders');
        for (const edge of connection.edges || []) {
            const node = edge.node;
            if (!node?.id || String(node.displayFinancialStatus).toUpperCase() !== 'PAID') continue;
            const payload = reconciledGraphqlOrder(node);
            const identity = crypto.createHash('sha256')
                .update(`${node.id}\0${node.updatedAt || ''}`)
                .digest('hex');
            await db.query(
                `INSERT INTO shopify_webhook_inbox
                    (shop_id, webhook_id, topic, triggered_at, payload)
                 VALUES ($1, $2, 'orders/paid', $3, $4::jsonb)
                 ON CONFLICT (shop_id, webhook_id) DO NOTHING`,
                [shop.id, `reconcile:${identity}`, node.updatedAt || scanCutoff, JSON.stringify(payload)],
            );
            received += 1;
        }
        after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
        if (after) {
            await db.query(
                `INSERT INTO shopify_reconcile_state
                    (shop_id, scan_since, scan_cutoff, after_cursor, last_error, updated_at)
                 VALUES ($1, $2, $3, $4, NULL, NOW())
                 ON CONFLICT (shop_id) DO UPDATE
                 SET scan_since = EXCLUDED.scan_since,
                     scan_cutoff = EXCLUDED.scan_cutoff,
                     after_cursor = EXCLUDED.after_cursor,
                     last_error = NULL,
                     updated_at = NOW()`,
                [shop.id, since, scanCutoff, after],
            );
        }
    } while (after && received < config.shopifyReconcileMaxOrders);

    if (!after) await db.query(
        `INSERT INTO shopify_reconcile_state (shop_id, last_successful_at, last_error, updated_at)
         VALUES ($1, $2, NULL, NOW())
         ON CONFLICT (shop_id) DO UPDATE
         SET last_successful_at = EXCLUDED.last_successful_at,
             scan_since = NULL,
             scan_cutoff = NULL,
             after_cursor = NULL,
             last_error = NULL,
             updated_at = NOW()`,
        [shop.id, scanCutoff],
    );
    return received;
}

async function reconcilePaidOrders() {
    if (fs.existsSync(config.maintenanceFile)) return 0;
    const { rows: shops } = await pool.query(
        `SELECT id, shop_domain, admin_access_token
         FROM shops
         WHERE status = 'active'
           AND admin_access_token IS NOT NULL
           AND admin_access_token <> ''
         ORDER BY id`,
    );
    let total = 0;
    for (const shop of shops) {
        const client = await pool.connect();
        let acquired = false;
        try {
            const lock = await client.query(
                "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
                [`capi-saas-pro:shopify-reconcile:${shop.id}`],
            );
            acquired = lock.rows[0]?.acquired === true;
            if (!acquired) continue;
            total += await reconcilePaidOrdersForShop(shop, client);
        } catch (error) {
            await client.query(
                `INSERT INTO shopify_reconcile_state (shop_id, last_error, updated_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (shop_id) DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = NOW()`,
                [shop.id, String(error.message).slice(0, 4000)],
            ).catch(() => {});
            console.error(`[ShopifyReconcile] ${shop.shop_domain}:`, error.message);
        } finally {
            if (acquired) {
                await client.query(
                    "SELECT pg_advisory_unlock(hashtext($1))",
                    [`capi-saas-pro:shopify-reconcile:${shop.id}`],
                ).catch(() => {});
            }
            client.release();
        }
    }
    if (total > 0) await drainShopifyWebhookInbox();
    return total;
}

async function handleShopifyPurchaseWebhook(req, res) {
    const shopDomain = normalizeShopDomain(req.headers['x-shopify-shop-domain']);
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const webhookTopic = String(req.headers['x-shopify-topic'] || '').trim().toLowerCase();
    const triggeredAtHeader = String(req.headers['x-shopify-triggered-at'] || '');
    if (!shopDomain || !hmacHeader) return res.status(400).send('Missing Headers');
    if (webhookTopic !== 'orders/paid') return res.status(400).send('Unexpected webhook topic');

    const { rows } = await pool.query(
        'SELECT id, app_secret FROM shops WHERE shop_domain = $1 AND status = $2',
        [shopDomain, 'active'],
    );
    if (rows.length === 0) return res.status(401).send('Unauthorized');

    const appSecret = decryptTokenIfPossible(rows[0].app_secret);
    const generatedHash = crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('base64');
    if (!timingSafeCompare(generatedHash, hmacHeader)) return res.status(401).send('HMAC Failed');

    let precisePayload;
    try {
        precisePayload = parseJsonPreservingLargeIntegers(req.rawBody.toString('utf8'));
    } catch (error) {
        return res.status(400).send('Invalid JSON payload');
    }

    const suppliedWebhookId = String(req.headers['x-shopify-webhook-id'] || '').trim();
    const webhookId = (suppliedWebhookId || crypto.createHash('sha256').update(req.rawBody).digest('hex')).slice(0, 255);
    const triggeredAt = Number.isFinite(Date.parse(triggeredAtHeader)) ? triggeredAtHeader : null;
    const insert = await pool.query(
        `INSERT INTO shopify_webhook_inbox (shop_id, webhook_id, topic, triggered_at, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (shop_id, webhook_id) DO NOTHING
         RETURNING id`,
        [rows[0].id, webhookId, webhookTopic, triggeredAt, JSON.stringify(precisePayload || {})],
    );
    res.status(200).json({ success: true, accepted: true, durable: true, duplicate: insert.rowCount === 0 });
    setImmediate(() => void drainShopifyWebhookInbox().catch(error => {
        console.error('[ShopifyInbox] immediate drain failed:', error.message);
    }));
}

app.post('/api/webhook/purchase', asyncHandler(handleShopifyPurchaseWebhook));
app.post('/api/webhook/orders/paid', asyncHandler(handleShopifyPurchaseWebhook));

app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/readyz', asyncHandler(async (req, res) => {
    await pool.query('SELECT 1');
    let redisState = 'degraded';
    if (redis.status === 'ready') {
        try {
            redisState = await withTimeout(redis.ping(), 1000, 'Redis readiness') === 'PONG'
                ? 'ready'
                : 'degraded';
        } catch (error) {
            redisState = 'degraded';
        }
    }
    res.json({
        status: redisState === 'ready' ? 'ready' : 'degraded',
        postgres: 'ready',
        redis: redisState,
        durable_ingestion: true,
    });
}));

cron.schedule(config.shopifyWebhookInboxCron, async () => {
    try {
        await drainShopifyWebhookInbox();
    } catch (error) {
        console.error('[ShopifyInbox] scheduled drain failed:', error);
    }
});

cron.schedule(config.shopifyReconcileCron, async () => {
    try {
        const reconciled = await reconcilePaidOrders();
        if (reconciled > 0) console.warn(`[ShopifyReconcile] queued ${reconciled} paid orders`);
    } catch (error) {
        console.error('[ShopifyReconcile] scheduled run failed:', error);
    }
});

cron.schedule(config.batchCron, async () => {
    if (!config.legacyRedisDrainEnabled) return;
    try {
        const { rows: shops } = await pool.query("SELECT id FROM shops WHERE status = 'active'");
        for (const shop of shops) {
            const lockKey = `lock:batch_packing:${shop.id}`;
            const lockToken = crypto.randomUUID();
            const lock = await redis.set(lockKey, lockToken, 'EX', 55, 'NX');
            if (!lock) continue;
            const stopLockHeartbeat = startRedisLockHeartbeat(lockKey, lockToken, 55);

            const pendingKey = `pending:events:${shop.id}`;
            const processingKey = `processing:events:${shop.id}`;
            const heartbeatKey = `heartbeat:processing:${shop.id}`;
            try {
                const len = await redis.llen(pendingKey);
                if (len === 0) continue;

                const itemsToProcess = await redis.safePopAndTransfer(
                    pendingKey,
                    processingKey,
                    Math.min(len, config.batchSize),
                );
                if (!itemsToProcess?.length) continue;

                await redis.set(heartbeatKey, '1', 'EX', 30);
                const parsedEvents = [];
                for (const item of itemsToProcess) {
                    try {
                        parsedEvents.push(JSON.parse(item));
                    } catch (error) {
                        await insertMalformedQueuedEvent(shop.id, item, `Invalid queued event JSON: ${error.message}`);
                    }
                }
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

                if (readyEvents.length === 0) {
                    await completeProcessingBatch(processingKey, pendingKey, deferredEvents);
                    await redis.del(heartbeatKey);
                    continue;
                }

                const mergedReadyEvents = mergeReadyEvents(readyEvents);
                const validDbEvents = [];
                for (const event of mergedReadyEvents) {
                    const persisted = await persistOutboxEvent(shop.id, event);
                    if (persisted) validDbEvents.push(persisted);
                }

                const eventsToSend = validDbEvents.filter(event => event.status === 'PENDING');
                if (eventsToSend.length > 0) {
                    await capiQueue.add(
                        'send-fb-batch',
                        { shopId: shop.id },
                        { jobId: `legacy-pack-${shop.id}-${Date.now()}` },
                    );
                }

                await completeProcessingBatch(processingKey, pendingKey, deferredEvents);
                await redis.del(heartbeatKey);
            } finally {
                await stopLockHeartbeat().catch(() => {});
                await releaseRedisLock(lockKey, lockToken);
            }
        }
    } catch (error) {
        console.error('Outbox pack error:', error);
    }
});

cron.schedule(config.watchdogCron, async () => {
    if (!config.legacyRedisDrainEnabled) return;
    try {
        const { rows: shops } = await pool.query('SELECT id FROM shops');
        for (const shop of shops) {
            const lockKey = `lock:watchdog:${shop.id}`;
            const lockToken = crypto.randomUUID();
            const lock = await redis.set(lockKey, lockToken, 'EX', 50, 'NX');
            if (!lock) continue;
            const stopLockHeartbeat = startRedisLockHeartbeat(lockKey, lockToken, 50);

            const processingKey = `processing:events:${shop.id}`;
            const pendingKey = `pending:events:${shop.id}`;
            const heartbeatKey = `heartbeat:processing:${shop.id}`;
            try {
                const [isAlive, processingLen] = await Promise.all([
                    redis.exists(heartbeatKey),
                    redis.llen(processingKey),
                ]);

                if (processingLen > 0 && !isAlive) {
                    const restored = await redis.rollbackProcessing(processingKey, pendingKey);
                    console.warn(`[Watchdog] restored ${restored} processing events for shop ${shop.id}`);
                }
            } finally {
                await stopLockHeartbeat().catch(() => {});
                await releaseRedisLock(lockKey, lockToken);
            }
        }
    } catch (error) {
        console.error('Watchdog error:', error);
    }
});

cron.schedule(config.watchdogCron, async () => {
    try {
        const reconciled = await reconcileEventAggregateStatuses();
        if (reconciled > 0) {
            console.warn(`[Watchdog] reconciled ${reconciled} event aggregate statuses from the delivery ledger`);
        }
    } catch (error) {
        console.error('Event aggregate reconciliation error:', error);
    }
});

cron.schedule(config.watchdogCron, async () => {
    const lockKey = 'lock:stale_pending_rescue';
    const lockToken = crypto.randomUUID();
    let stopLockHeartbeat;
    try {
        const lock = await redis.set(lockKey, lockToken, 'EX', 50, 'NX');
        if (!lock) return;
        stopLockHeartbeat = startRedisLockHeartbeat(lockKey, lockToken, 50);

        const queued = await queueStalePendingEvents();
        if (queued > 0) console.warn(`[Watchdog] scheduled fair backlog rescue for ${queued} shops`);
    } catch (error) {
        console.error('Stale pending rescue error:', error);
    } finally {
        if (stopLockHeartbeat) await stopLockHeartbeat().catch(() => {});
        await releaseRedisLock(lockKey, lockToken).catch(() => {});
    }
});

cron.schedule(config.metaQualityCron, async () => {
    const lockKey = 'lock:meta_quality_refresh';
    const lockToken = crypto.randomUUID();
    let stopLockHeartbeat;
    try {
        const lock = await redis.set(lockKey, lockToken, 'EX', 300, 'NX');
        if (!lock) return;
        stopLockHeartbeat = startRedisLockHeartbeat(lockKey, lockToken, 300);

        const results = await refreshMetaQualitySnapshots();
        const failed = results.filter(result => result?.status === 'FAILED').length;
        if (results.length > 0) {
            console.warn(`[MetaQuality] refreshed ${results.length} dataset quality snapshots${failed ? `, ${failed} failed` : ''}`);
        }
    } catch (error) {
        console.error('Meta quality refresh error:', error);
    } finally {
        if (stopLockHeartbeat) await stopLockHeartbeat().catch(() => {});
        await releaseRedisLock(lockKey, lockToken).catch(() => {});
    }
});

cron.schedule(config.cleanupCron, async () => {
    const lockKey = 'lock:operational_data_cleanup';
    const lockToken = crypto.randomUUID();
    let stopLockHeartbeat;
    try {
        const lock = await redis.set(lockKey, lockToken, 'EX', 55 * 60, 'NX');
        if (!lock) return;
        stopLockHeartbeat = startRedisLockHeartbeat(lockKey, lockToken, 55 * 60);
        const removed = await cleanupExpiredOperationalData();
        const total = Object.values(removed).reduce((sum, value) => sum + Number(value || 0), 0);
        if (total > 0) console.warn(`[Cleanup] removed ${total} expired rows`, removed);
    } catch (error) {
        console.error('Operational data cleanup error:', error);
    } finally {
        if (stopLockHeartbeat) await stopLockHeartbeat().catch(() => {});
        await releaseRedisLock(lockKey, lockToken).catch(() => {});
    }
});

const authMw = basicAuth({
    users: { [config.adminUsername]: config.adminPassword },
    challenge: true,
});

app.use('/admin', adminLimiter, authMw);
app.use('/api/admin', adminLimiter, authMw);

app.get('/admin/assets/admin.css', (req, res) => {
    res.set('Cache-Control', 'private, no-cache');
    res.sendFile(path.join(__dirname, 'public', 'admin.css'));
});

app.get('/admin/assets/vue.global.prod.js', (req, res) => {
    res.set('Cache-Control', 'private, no-cache');
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'public', 'vue.global.prod.js'));
});

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queue');
createBullBoard({ queues: [new BullMQAdapter(capiQueue)], serverAdapter });
app.use('/admin/queue', serverAdapter.getRouter());

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/admin/shops', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
        `SELECT id, shop_domain, status, created_at,
                (admin_access_token IS NOT NULL AND admin_access_token <> '') AS has_admin_access_token
         FROM shops
         ORDER BY id DESC`,
    );
    res.json(rows.map(row => ({ ...row, ingest_token: shopIngestToken(row.shop_domain) })));
}));

app.post('/api/admin/shops', asyncHandler(async (req, res) => {
    const shopDomain = requireMyshopifyDomain(req.body.shop_domain);
    const appSecret = requireBoundedString(req.body.app_secret, 'app_secret', 2048);
    const adminAccessToken = optionalBoundedString(req.body.admin_access_token, 'admin_access_token', 10000);

    await pool.query(
        `INSERT INTO shops (shop_domain, app_secret, admin_access_token)
         VALUES ($1, $2, $3)
         ON CONFLICT (shop_domain) DO UPDATE
         SET app_secret = EXCLUDED.app_secret,
             admin_access_token = COALESCE(EXCLUDED.admin_access_token, shops.admin_access_token),
             status = 'active'`,
        [shopDomain, encryptToken(appSecret), adminAccessToken ? encryptToken(adminAccessToken) : null],
    );
    res.status(201).json({ success: true });
}));

app.delete('/api/admin/shops/:id', asyncHandler(async (req, res) => {
    const shopId = readPositiveId(req.params.id, 'shop_id');

    const client = await pool.connect();
    let rowCount = 0;
    let shopDomain;
    try {
        await client.query('BEGIN');
        const shopResult = await client.query('SELECT shop_domain FROM shops WHERE id = $1 FOR UPDATE', [shopId]);
        shopDomain = shopResult.rows[0]?.shop_domain;
        await client.query('DELETE FROM dead_letters WHERE shop_id = $1', [shopId]);
        const result = await client.query('DELETE FROM shops WHERE id = $1', [shopId]);
        rowCount = result.rowCount;
        await client.query(
            `DELETE FROM pixels p
             WHERE NOT EXISTS (
                 SELECT 1 FROM shop_pixel_routes r WHERE r.pixel_id = p.id
             )`,
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }

    if (rowCount === 0) return res.status(404).json({ error: 'Shop not found' });

    await Promise.all([
        deleteRuntimeQueueKeysForShop(shopId),
        redis.del(`lock:batch_packing:${shopId}`),
        redis.del(`lock:watchdog:${shopId}`),
        deleteKeysByPattern(`attr:${shopId}:*`),
        deleteKeysByPattern(`dedup:${shopId}:*`),
        deleteKeysByPattern(`dedup-alias:${shopId}:*`),
        shopDomain ? deleteKeysByPattern(`shopify:webhook:${shopDomain}:*`) : Promise.resolve(),
    ]);

    res.json({ success: true });
}));

app.get('/api/admin/pixels', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`
        SELECT p.id, p.shop_id, owner.shop_domain, p.platform, p.name, p.pixel_id, p.test_event_code,
               p.rate_limit_group,
               p.rate_limit_until, p.last_usage_pct, p.consecutive_failures, p.last_delivery_at,
               (p.quality_access_token IS NOT NULL AND p.quality_access_token <> '') AS has_quality_token,
               COALESCE(
                   jsonb_agg(
                       jsonb_build_object(
                           'route_id', r.id,
                           'shop_id', s.id,
                           'shop_domain', s.shop_domain,
                           'status', r.status
                       )
                       ORDER BY s.shop_domain
                   ) FILTER (WHERE r.id IS NOT NULL),
                   '[]'::jsonb
               ) AS routes
        FROM pixels p
        LEFT JOIN shops owner ON p.shop_id = owner.id
        LEFT JOIN shop_pixel_routes r
          ON r.pixel_id = p.id
         AND r.status = 'active'
        LEFT JOIN shops s ON s.id = r.shop_id
        GROUP BY p.id, owner.shop_domain
        ORDER BY p.id DESC
    `);
    res.json(rows);
}));

app.post('/api/admin/pixels', asyncHandler(async (req, res) => {
    const shopId = Number(req.body.shop_id);
    const requestedShopIds = Array.isArray(req.body.shop_ids)
        ? req.body.shop_ids.map(Number)
        : [shopId];
    const shopIds = [...new Set(requestedShopIds.filter(id => Number.isInteger(id) && id > 0))];
    const platform = String(req.body.platform || 'facebook').trim().toLowerCase();
    const pixelId = requireBoundedString(req.body.pixel_id, 'pixel_id', 64);
    const name = optionalBoundedString(req.body.name, 'name', 100) || `${platform}-${pixelId.slice(-6)}`;
    const accessToken = requireBoundedString(req.body.access_token, 'access_token', 10000);
    const qualityAccessToken = optionalBoundedString(req.body.quality_access_token, 'quality_access_token', 10000);
    const testEventCode = optionalBoundedString(req.body.test_event_code, 'test_event_code', 100);
    const rateLimitGroup = optionalBoundedString(req.body.rate_limit_group, 'rate_limit_group', 100);
    if (!Number.isInteger(shopId) || shopId <= 0) return res.status(400).json({ error: 'Invalid shop_id' });
    if (!['facebook', 'tiktok'].includes(platform)) return res.status(400).json({ error: 'Unsupported platform' });

    if (!shopIds.includes(shopId)) shopIds.unshift(shopId);
    const shopResult = await pool.query(
        'SELECT id FROM shops WHERE id = ANY($1::int[]) AND status = $2',
        [shopIds, 'active'],
    );
    if (shopResult.rowCount !== shopIds.length) {
        return res.status(400).json({ error: 'One or more shops are missing or inactive.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${platform}:${pixelId}`]);
        const existing = await client.query(
            `SELECT id, rate_limit_group
             FROM pixels
             WHERE platform = $1 AND pixel_id = $2
             ORDER BY id ASC
             LIMIT 1
             FOR UPDATE`,
            [platform, pixelId],
        );
        let credentialId;
        let reused = false;
        if (existing.rowCount > 0) {
            credentialId = existing.rows[0].id;
            reused = true;
            const effectiveRateLimitGroup = rateLimitGroup || existing.rows[0].rate_limit_group || null;
            await client.query(
                `UPDATE pixels
                 SET shop_id = COALESCE(shop_id, $2),
                     name = $3,
                     access_token = $4,
                     quality_access_token = COALESCE($5, quality_access_token),
                     test_event_code = $6,
                     credential_scope = $7,
                     rate_limit_group = $8
                 WHERE id = $1`,
                [
                    credentialId,
                    shopId,
                    name,
                    encryptToken(accessToken),
                    qualityAccessToken ? encryptToken(qualityAccessToken) : null,
                    testEventCode,
                    credentialFingerprint(platform, accessToken, effectiveRateLimitGroup),
                    effectiveRateLimitGroup,
                ],
            );
        } else {
            const inserted = await client.query(
                `INSERT INTO pixels
                    (shop_id, platform, name, pixel_id, access_token, quality_access_token, test_event_code, credential_scope, rate_limit_group)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING id`,
                [
                    shopId,
                    platform,
                    name,
                    pixelId,
                    encryptToken(accessToken),
                    qualityAccessToken ? encryptToken(qualityAccessToken) : null,
                    testEventCode,
                    credentialFingerprint(platform, accessToken, rateLimitGroup),
                    rateLimitGroup,
                ],
            );
            credentialId = inserted.rows[0].id;
        }
        await client.query(
            `INSERT INTO shop_pixel_routes (shop_id, pixel_id)
             SELECT shop_id, $2
             FROM UNNEST($1::int[]) AS requested(shop_id)
             ON CONFLICT (shop_id, pixel_id) DO UPDATE SET status = 'active'`,
            [shopIds, credentialId],
        );
        await client.query('COMMIT');
        await wakeShopOutboxes(shopIds);
        res.status(reused ? 200 : 201).json({ success: true, id: credentialId, reused, shop_ids: shopIds });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}));

app.put('/api/admin/pixels/:id/routes', asyncHandler(async (req, res) => {
    const pixelId = readPositiveId(req.params.id, 'pixel_id');
    const shopIds = [...new Set((req.body.shop_ids || []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
    if (shopIds.length === 0) return res.status(400).json({ error: 'shop_ids must contain at least one shop' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const pixelResult = await client.query('SELECT id FROM pixels WHERE id = $1 FOR UPDATE', [pixelId]);
        if (pixelResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Pixel not found' });
        }
        const shopsResult = await client.query(
            "SELECT id FROM shops WHERE id = ANY($1::int[]) AND status = 'active'",
            [shopIds],
        );
        if (shopsResult.rowCount !== shopIds.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'One or more shops are missing or inactive' });
        }
        // Preserve historical event_deliveries when a shop is unbound. Deleting
        // the route would cascade-delete its audit ledger. Outstanding attempts
        // become terminal first so an inactive route cannot leave an event
        // permanently PENDING or be reclaimed by an in-flight stale worker.
        const deactivatedDeliveries = await client.query(
            `UPDATE event_deliveries delivery
             SET status = 'FAILED_PERMANENT',
                 lease_expires_at = NULL,
                 error_code = 'ROUTE_INACTIVE',
                 error_message = 'Route was disabled by an administrator before delivery completed',
                 updated_at = NOW()
             FROM shop_pixel_routes route
             WHERE delivery.route_id = route.id
               AND route.pixel_id = $1
               AND NOT (route.shop_id = ANY($2::int[]))
               AND delivery.status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')
             RETURNING delivery.event_store_id`,
            [pixelId, shopIds],
        );
        await client.query(
            `UPDATE shop_pixel_routes
             SET status = 'inactive'
             WHERE pixel_id = $1
               AND NOT (shop_id = ANY($2::int[]))
               AND status <> 'inactive'`,
            [pixelId, shopIds],
        );
        const affectedEventIds = [...new Set(
            deactivatedDeliveries.rows.map(row => String(row.event_store_id)),
        )];
        if (affectedEventIds.length > 0) {
            await client.query(
                `WITH delivery_summary AS (
                     SELECT event_store_id,
                            COUNT(*) AS total,
                            COUNT(*) FILTER (WHERE status = 'SUCCESS') AS succeeded,
                            COUNT(*) FILTER (WHERE status = 'FAILED_PERMANENT') AS permanent_failed,
                            COUNT(*) FILTER (
                                WHERE status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')
                            ) AS outstanding
                     FROM event_deliveries
                     WHERE event_store_id = ANY($1::bigint[])
                     GROUP BY event_store_id
                 )
                 UPDATE event_store event
                 SET status = CASE
                     WHEN summary.total > 0 AND summary.succeeded = summary.total THEN 'SUCCESS'
                     WHEN summary.outstanding > 0 THEN 'PENDING'
                     WHEN summary.succeeded > 0 AND summary.permanent_failed > 0 THEN 'PARTIAL_FAILED'
                     WHEN summary.permanent_failed = summary.total THEN 'FAILED'
                     ELSE event.status
                 END
                 FROM delivery_summary summary
                 WHERE event.id = summary.event_store_id`,
                [affectedEventIds],
            );
        }
        await client.query(
            `INSERT INTO shop_pixel_routes (shop_id, pixel_id)
             SELECT shop_id, $2 FROM UNNEST($1::int[]) AS requested(shop_id)
             ON CONFLICT (shop_id, pixel_id) DO UPDATE SET status = 'active'`,
            [shopIds, pixelId],
        );
        await client.query('COMMIT');
        await wakeShopOutboxes(shopIds);
        res.json({ success: true, pixel_id: pixelId, shop_ids: shopIds });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}));

app.delete('/api/admin/pixels/:id', asyncHandler(async (req, res) => {
    const pixelId = readPositiveId(req.params.id, 'pixel_id');
    const { rowCount } = await pool.query('DELETE FROM pixels WHERE id = $1', [pixelId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Pixel route not found' });
    res.json({ success: true });
}));

app.get('/api/admin/logs', asyncHandler(async (req, res) => {
    const shopId = readOptionalShopId(req);
    const params = shopId ? [shopId] : [];
    const shopFilter = shopId ? 'WHERE e.shop_id = $1' : '';
    const { rows } = await pool.query(`
        SELECT e.id, s.shop_domain, e.event_name, e.event_id, e.status, e.emq_estimate,
               e.request_payload->'_quality' AS quality, e.fb_response, e.timestamp,
               COALESCE(d.deliveries, '[]'::jsonb) AS route_deliveries
        FROM event_store e
        JOIN shops s ON e.shop_id = s.id
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'route_id', ed.route_id,
                    'platform', p.platform,
                    'pixel_id', p.pixel_id,
                    'status', ed.status,
                    'attempt_count', ed.attempt_count,
                    'next_attempt_at', ed.next_attempt_at,
                    'delivered_at', ed.delivered_at,
                    'error_code', ed.error_code,
                    'error_message', ed.error_message
                )
                ORDER BY ed.route_id
            ) AS deliveries
            FROM event_deliveries ed
            JOIN shop_pixel_routes r ON r.id = ed.route_id
            JOIN pixels p ON p.id = r.pixel_id
            WHERE ed.event_store_id = e.id
        ) d ON TRUE
        ${shopFilter}
        ORDER BY e.id DESC
        LIMIT 100
    `, params);
    res.json(rows);
}));

app.delete('/api/admin/logs', asyncHandler(async (req, res) => {
    const shopId = readOptionalShopId(req);
    const shopIdsToClear = shopId ? [shopId] : await allShopIds();
    if (shopId) {
        const shopResult = await pool.query('SELECT id FROM shops WHERE id = $1', [shopId]);
        if (shopResult.rowCount === 0) return res.status(404).json({ error: 'Shop not found' });
    }

    const { rowCount } = shopId
        ? await pool.query('DELETE FROM event_store WHERE shop_id = $1', [shopId])
        : await pool.query('DELETE FROM event_store');

    await Promise.all([
        deleteKeysByPattern(shopId ? `dedup:${shopId}:*` : 'dedup:*'),
        deleteKeysByPattern(shopId ? `dedup-alias:${shopId}:*` : 'dedup-alias:*'),
        ...shopIdsToClear.map(id => deleteRuntimeQueueKeysForShop(id)),
    ]);
    const queuedJobsRemoved = await removeQueuedSendJobsForShop(shopId);

    res.json({
        success: true,
        deleted: rowCount,
        scope: shopId ? 'shop' : 'all',
        dedupe_cache_cleared: true,
        redis_queues_cleared: true,
        queued_jobs_removed: queuedJobsRemoved,
    });
}));

app.get('/api/admin/summary', asyncHandler(async (req, res) => {
    const shopId = readOptionalShopId(req);
    const params = shopId ? [shopId] : [];
    const eventShopFilter = shopId ? ' AND shop_id = $1' : '';
    const shopFilter = shopId ? ' AND id = $1' : '';
    const dlqShopFilter = shopId ? ' AND shop_id = $1' : '';
    const [
        statusResult,
        emqResult,
        signalResult,
        officialQualityResult,
        dlqResult,
        shopsResult,
        pixelsResult,
        integrityResult,
        backlogResult,
        queueCounts,
    ] = await Promise.all([
        pool.query(`
            SELECT status, COUNT(*)::int AS count
            FROM event_store
            WHERE timestamp >= NOW() - INTERVAL '24 hours'${eventShopFilter}
            GROUP BY status
        `, params),
        pool.query(`
            SELECT COUNT(*)::int AS total_events,
                   ROUND(AVG(emq_estimate)::numeric, 2) AS avg_emq
            FROM event_store
            WHERE timestamp >= NOW() - INTERVAL '24 hours'${eventShopFilter}
        `, params),
        pool.query(`
            SELECT COUNT(*)::int AS total_events,
                   COUNT(*) FILTER (WHERE COALESCE((request_payload->'user_data') ? 'em', false))::int AS email,
                   COUNT(*) FILTER (WHERE COALESCE((request_payload->'user_data') ? 'ph', false))::int AS phone,
                   COUNT(*) FILTER (WHERE COALESCE((request_payload->'user_data') ? 'external_id', false))::int AS external_id,
                   COUNT(*) FILTER (WHERE COALESCE((request_payload->'user_data') ? 'fbp', false))::int AS fbp,
                   COUNT(*) FILTER (WHERE COALESCE((request_payload->'user_data') ? 'fbc', false))::int AS fbc,
                   COUNT(*) FILTER (WHERE COALESCE((request_payload->'user_data') ? 'client_ip_address', false))::int AS client_ip_address,
                   COUNT(*) FILTER (WHERE COALESCE((request_payload->'user_data') ? 'client_user_agent', false))::int AS client_user_agent
            FROM event_store
            WHERE timestamp >= NOW() - INTERVAL '24 hours'${eventShopFilter}
        `, params),
        pool.query(`
            SELECT DISTINCT ON (m.pixel_route_id, m.shop_id)
                   m.pixel_route_id,
                   m.shop_id,
                   s.shop_domain,
                   p.name,
                   p.pixel_id,
                   m.fetched_at,
                   m.status,
                   m.metric_type,
                   m.summary_payload,
                   m.error_message
            FROM meta_quality_snapshots m
            JOIN pixels p ON p.id = m.pixel_route_id
            JOIN shops s ON s.id = m.shop_id
            WHERE p.platform = 'facebook'${shopId ? ' AND m.shop_id = $1' : ''}
            ORDER BY m.pixel_route_id, m.shop_id, m.fetched_at DESC
        `, params),
        pool.query(`SELECT COUNT(*)::int AS count FROM dead_letters WHERE status = 'FAILED_PERMANENT'${dlqShopFilter}`, params),
        pool.query(`SELECT COUNT(*)::int AS count FROM shops WHERE status = 'active'${shopFilter}`, params),
        pool.query(
            `SELECT p.platform, COUNT(*)::int AS count
             FROM shop_pixel_routes r
             JOIN pixels p ON p.id = r.pixel_id
             WHERE r.status = 'active'
             ${shopId ? 'AND r.shop_id = $1' : ''}
             GROUP BY p.platform`,
            params,
        ),
        pool.query(`
            WITH scoped_deliveries AS (
                SELECT ed.*, e.shop_id AS event_shop_id, r.shop_id AS route_shop_id
                FROM event_deliveries ed
                JOIN event_store e ON e.id = ed.event_store_id
                JOIN shop_pixel_routes r ON r.id = ed.route_id
                WHERE ed.status IN ('IN_PROGRESS', 'RETRYABLE_FAILED')
                  ${shopId ? 'AND e.shop_id = $1' : ''}
            ),
            scoped_pixels AS (
                SELECT DISTINCT p.id, p.rate_limit_until, p.last_usage_pct, p.consecutive_failures
                FROM pixels p
                JOIN shop_pixel_routes r ON r.pixel_id = p.id
                WHERE r.status = 'active'${shopId ? ' AND r.shop_id = $1' : ''}
            ),
            missing_ledger AS (
                SELECT COUNT(*)::int AS count
                FROM event_store e
                WHERE e.timestamp < NOW() - INTERVAL '5 minutes'
                  AND e.status = 'PENDING'
                  ${shopId ? 'AND e.shop_id = $1' : ''}
                  AND EXISTS (
                      SELECT 1
                      FROM shop_pixel_routes r
                      WHERE r.shop_id = e.shop_id
                        AND r.status = 'active'
                        AND NOT EXISTS (
                            SELECT 1
                            FROM event_deliveries ed
                            WHERE ed.event_store_id = e.id
                              AND ed.route_id = r.id
                        )
                  )
            ),
            unrouted_pending AS (
                SELECT COUNT(*)::int AS count
                FROM event_store e
                WHERE e.status = 'PENDING'
                  ${shopId ? 'AND e.shop_id = $1' : ''}
                  AND NOT EXISTS (
                      SELECT 1
                      FROM shop_pixel_routes r
                      WHERE r.shop_id = e.shop_id
                        AND r.status = 'active'
                  )
            ),
            aggregate_mismatch AS (
                SELECT COUNT(*)::int AS count
                FROM event_store e
                WHERE e.status = 'PENDING'
                  ${shopId ? 'AND e.shop_id = $1' : ''}
                  AND EXISTS (
                      SELECT 1
                      FROM event_deliveries delivery
                      WHERE delivery.event_store_id = e.id
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM event_deliveries outstanding
                      WHERE outstanding.event_store_id = e.id
                        AND outstanding.status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM shop_pixel_routes route
                      WHERE route.shop_id = e.shop_id
                        AND route.status = 'active'
                        AND NOT EXISTS (
                            SELECT 1
                            FROM event_deliveries missing
                            WHERE missing.event_store_id = e.id
                              AND missing.route_id = route.id
                        )
                  )
            ),
            awaiting_payment AS (
                SELECT COUNT(*)::int AS count,
                       COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(timestamp)))::bigint, 0) AS oldest_seconds
                FROM event_store
                WHERE status = 'AWAITING_PAYMENT'
                  ${shopId ? 'AND shop_id = $1' : ''}
            ),
            pending_backlog AS (
                SELECT COUNT(*)::int AS count,
                       COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(timestamp)))::bigint, 0) AS oldest_seconds
                FROM event_store
                WHERE status = 'PENDING'
                  ${shopId ? 'AND shop_id = $1' : ''}
            ),
            webhook_inbox AS (
                SELECT
                    COUNT(*) FILTER (
                        WHERE status IN ('PENDING', 'RETRYABLE_FAILED', 'PROCESSING')
                    )::int AS outstanding,
                    COUNT(*) FILTER (WHERE status = 'FAILED_PERMANENT')::int AS permanent_failed
                FROM shopify_webhook_inbox
                WHERE TRUE ${shopId ? 'AND shop_id = $1' : ''}
            )
            SELECT
                COUNT(*) FILTER (
                    WHERE d.status = 'IN_PROGRESS' AND d.lease_expires_at < NOW()
                )::int AS stale_leases,
                COUNT(*) FILTER (
                    WHERE d.status = 'RETRYABLE_FAILED' AND d.next_attempt_at <= NOW()
                )::int AS due_retries,
                COALESCE(
                    EXTRACT(EPOCH FROM (
                        NOW() - MIN(d.next_attempt_at) FILTER (
                            WHERE d.status = 'RETRYABLE_FAILED' AND d.next_attempt_at <= NOW()
                        )
                    ))::bigint,
                    0
                ) AS oldest_due_seconds,
                COUNT(*) FILTER (WHERE d.event_shop_id <> d.route_shop_id)::int AS isolation_violations,
                (SELECT count FROM missing_ledger)::int AS events_without_ledger,
                (SELECT count FROM unrouted_pending)::int AS unrouted_pending,
                (SELECT count FROM aggregate_mismatch)::int AS aggregate_mismatches,
                (SELECT count FROM awaiting_payment)::int AS awaiting_payment,
                (SELECT oldest_seconds FROM awaiting_payment)::bigint AS oldest_awaiting_payment_seconds,
                (SELECT count FROM pending_backlog)::int AS pending_backlog,
                (SELECT oldest_seconds FROM pending_backlog)::bigint AS oldest_pending_seconds,
                (SELECT outstanding FROM webhook_inbox)::int AS webhook_inbox_outstanding,
                (SELECT permanent_failed FROM webhook_inbox)::int AS webhook_inbox_permanent_failed,
                (SELECT COUNT(*) FROM scoped_pixels WHERE rate_limit_until > NOW())::int AS active_cooldowns,
                (SELECT MAX(last_usage_pct) FROM scoped_pixels) AS max_usage_pct,
                (SELECT COALESCE(SUM(consecutive_failures), 0) FROM scoped_pixels)::int AS consecutive_failures
            FROM scoped_deliveries d
        `, params),
        pool.query(`
            SELECT e.shop_id,
                   s.shop_domain,
                   COUNT(*) FILTER (WHERE e.status = 'PENDING')::int AS pending,
                   COUNT(*) FILTER (WHERE e.status = 'AWAITING_PAYMENT')::int AS awaiting_payment,
                   COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(e.timestamp) FILTER (WHERE e.status = 'PENDING')))::bigint, 0) AS oldest_pending_seconds
            FROM event_store e
            JOIN shops s ON s.id = e.shop_id
            WHERE e.status IN ('PENDING', 'AWAITING_PAYMENT')
              ${shopId ? 'AND e.shop_id = $1' : ''}
            GROUP BY e.shop_id, s.shop_domain
            ORDER BY oldest_pending_seconds DESC, e.shop_id ASC
            LIMIT 100
        `, params),
        optionalRedis(
            () => capiQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
            { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
            'BullMQ summary',
        ),
    ]);

    const signalLabels = [
        ['email', 'Email'],
        ['phone', 'Phone'],
        ['external_id', 'External ID'],
        ['fbp', 'FBP'],
        ['fbc', 'FBC'],
        ['client_ip_address', 'IP'],
        ['client_user_agent', 'User Agent'],
    ];
    const signalRow = signalResult.rows[0] || {};
    const signalTotal = Number(signalRow.total_events || 0);
    const emqSignals = signalLabels.map(([key, label]) => {
        const matched = Number(signalRow[key] || 0);
        return {
            key,
            label,
            matched,
            total: signalTotal,
            coverage: signalTotal ? Number(((matched / signalTotal) * 100).toFixed(1)) : null,
        };
    });

    res.json({
        last24h: {
            total_events: emqResult.rows[0]?.total_events || 0,
            avg_emq: emqResult.rows[0]?.avg_emq || null,
            by_status: statusResult.rows,
            emq_signals: emqSignals,
        },
        official_meta_quality: officialQualityResult.rows.map(row => ({
            shop_domain: row.shop_domain,
            pixel_route_id: row.pixel_route_id,
            pixel_id: row.pixel_id,
            name: row.name,
            fetched_at: row.fetched_at,
            status: row.status,
            metric_type: row.metric_type,
            summary: row.summary_payload,
            error_message: row.error_message,
        })),
        active_shops: Number(shopsResult.rows[0]?.count || 0),
        pixels_by_platform: pixelsResult.rows,
        dead_letters: dlqResult.rows[0]?.count || 0,
        delivery_health: integrityResult.rows[0] || {},
        queue: queueCounts,
        db_backlog_by_shop: backlogResult.rows,
        // Kept for response compatibility. The legacy Redis-list transport is
        // disabled by default; PostgreSQL backlog is authoritative.
        redis_pending: [],
    });
}));

app.post('/api/admin/meta-quality/refresh', asyncHandler(async (req, res) => {
    const shopId = readOptionalShopId(req);
    if (shopId) {
        const shopResult = await pool.query('SELECT id FROM shops WHERE id = $1 AND status = $2', [shopId, 'active']);
        if (shopResult.rowCount === 0) return res.status(404).json({ error: 'Shop not found' });
    }

    const results = await refreshMetaQualitySnapshots(shopId);
    res.json({
        success: true,
        refreshed: results.length,
        failed: results.filter(result => result?.status === 'FAILED').length,
        results,
    });
}));

app.get('/api/admin/dlq', asyncHandler(async (req, res) => {
    const shopId = readOptionalShopId(req);
    const params = shopId ? [shopId] : [];
    const shopFilter = shopId ? 'AND d.shop_id = $1' : '';
    const { rows } = await pool.query(`
        SELECT d.*, s.shop_domain
        FROM dead_letters d
        LEFT JOIN shops s ON d.shop_id = s.id
        WHERE d.status = 'FAILED_PERMANENT'
        ${shopFilter}
        ORDER BY d.id DESC
        LIMIT 50
    `, params);
    res.json(rows);
}));

app.post('/api/admin/dlq/replay', asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids)
        ? [...new Set(req.body.ids.map(Number).filter(id => Number.isInteger(id) && id > 0))]
        : [];
    if (ids.length === 0) return res.status(400).json({ error: 'ids must contain at least one dead-letter ID' });
    if (ids.length > 100) return res.status(413).json({ error: 'At most 100 dead letters can be replayed per request' });
    const { rows } = await pool.query(
        "SELECT id, shop_id, payload FROM dead_letters WHERE status = 'FAILED_PERMANENT' AND id = ANY($1::bigint[])",
        [ids],
    );

    let replayed = 0;
    let skipped = 0;
    for (const row of rows) {
        let parsedPayload;
        try {
            parsedPayload = JSON.parse(row.payload);
        } catch (error) {
            await pool.query(
                "UPDATE dead_letters SET status = 'SKIPPED_UNREPLAYABLE', error_reason = $2 WHERE id = $1",
                [row.id, `Invalid dead letter payload JSON: ${error.message}`],
            );
            skipped += 1;
            continue;
        }

        const dbEvents = Array.isArray(parsedPayload) ? parsedPayload : [parsedPayload];
        const replayEvents = await restoreReplayableEvents(row.shop_id, dbEvents);
        if (replayEvents.length > 0) {
            await capiQueue.add(
                'send-fb-batch',
                { shopId: row.shop_id },
                { jobId: `replay-${row.shop_id}-${row.id}-${Date.now()}` },
            );
            await pool.query("UPDATE dead_letters SET status = 'REPLAYED' WHERE id = $1", [row.id]);
            replayed += 1;
        } else {
            await pool.query(
                "UPDATE dead_letters SET status = 'SKIPPED_UNREPLAYABLE', error_reason = COALESCE(error_reason, 'No replayable events found') WHERE id = $1",
                [row.id],
            );
            skipped += 1;
        }
    }

    res.json({ success: true, replayed, skipped });
}));

app.use((err, req, res, next) => {
    const proposedStatus = Number(err.statusCode || err.status || 500);
    const statusCode = proposedStatus >= 400 && proposedStatus <= 599 ? proposedStatus : 500;
    if (err.code === '42501') {
        console.error(err);
        return res.status(500).json({
            error: 'Database permission denied. Grant the app database user privileges on shops, pixels, shop_pixel_routes, event_store, shopify_webhook_inbox, event_deliveries, dead_letters, and their sequences.',
            code: err.code,
        });
    }
    if (statusCode >= 500) console.error(err);
    res.status(statusCode).json({ error: statusCode >= 500 ? 'Internal Server Error' : err.message });
});

const server = app.listen(config.port, () => {
    console.log(`CAPI SaaS API listening on port ${config.port}`);
});
server.requestTimeout = config.httpRequestTimeoutMs;
server.headersTimeout = config.httpHeadersTimeoutMs;
server.keepAliveTimeout = config.httpKeepAliveTimeoutMs;
server.maxRequestsPerSocket = 1000;

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down API server`);
    const forceTimer = setTimeout(() => {
        console.error('API shutdown deadline exceeded; closing remaining sockets');
        server.closeAllConnections?.();
        process.exit(1);
    }, config.shutdownTimeoutMs);
    forceTimer.unref?.();
    server.closeIdleConnections?.();
    server.close(async () => {
        try {
            await capiQueue.close();
            await pool.end();
            await redis.quit();
            clearTimeout(forceTimer);
            process.exit(0);
        } catch (error) {
            clearTimeout(forceTimer);
            console.error('Shutdown error:', error);
            process.exit(1);
        }
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
