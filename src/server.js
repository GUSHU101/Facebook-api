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
    hashUserData,
    timingSafeCompare,
    timingSafeStringCompare,
} = require('./utils/crypto');
const { calculateEMQ, missingMatchSignals } = require('./utils/emq');
const {
    buildCustomData,
    compactObject,
    firstPresent,
    missingCommerceSignals,
    normalizeEventId,
    normalizeShopifyId,
    stripPrivateFields,
    tenantScopedExternalId,
    tenantScopedIdentifier,
} = require('./events/common');
const {
    buildShopifyOrderPurchasePayload,
    paidOrderIgnoreReason,
    shopifyPaymentTimestamp,
} = require('./events/shopify');
const { FUNNEL_EVENT_NAMES, decorateFunnelSummary } = require('./events/funnel');
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
const {
    META_QUALITY_METRIC_TYPE,
    buildMetaQualityRequestParams,
    summarizeMetaQuality,
} = require('./platforms/meta-quality');
const { parseJsonPreservingLargeIntegers } = require('./utils/json');
const { enqueueReschedulableJob } = require('./utils/queue');
const { createTrackedCronScheduler } = require('./utils/scheduler');
const { consumeWeightedWindow } = require('./utils/weighted-rate-limit');

const app = express();
let shuttingDown = false;
const backgroundScheduler = createTrackedCronScheduler(cron, {
    onError: (error, label) => console.error(`[Background:${label}] unhandled task failure:`, error),
});

function scheduleCron(expression, handler, label) {
    return backgroundScheduler.schedule(expression, handler, label);
}

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

// Authenticate and rate-limit the administration surface before parsing JSON.
// This prevents unauthenticated callers from repeatedly consuming the full
// request-body allowance on credential and replay endpoints.
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.adminRateLimitPerWindow,
    standardHeaders: true,
    legacyHeaders: false,
});
const authMw = basicAuth({
    users: { [config.adminUsername]: config.adminPassword },
    challenge: true,
});
app.use('/admin', adminLimiter, authMw, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
});
app.use('/api/admin', adminLimiter, authMw, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // HTTP Basic credentials are attached by browsers before application
    // JavaScript runs, so Basic Auth alone does not prevent a cross-site form
    // from triggering a state change. Every admin mutation must carry a
    // non-simple header set by our same-origin admin client. Cross-origin forms
    // cannot add this header, and cross-origin fetches require a CORS preflight
    // which is intentionally not enabled for /api/admin.
    if (req.get('X-CAPI-Admin-Request') !== '1') {
        return res.status(403).json({ error: 'Missing admin request verification header' });
    }
    next();
});
// Only storefront pixel endpoints need browser CORS. Keeping CORS off
// admin routes prevents an unrelated website from reading authenticated admin
// responses through a browser session that already has Basic Auth credentials.
app.use(['/api/pixel-event', '/api/pixel-config', '/api/pixel-diagnostic'], cors({ origin: config.corsOrigin, credentials: false }));
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

function pixelRateLimitIdentity(req) {
    const shopDomain = normalizeShopDomain(shopDomainFromPixelBody(req.body));
    const suppliedToken = String(
        req.headers['x-capi-ingest-token']
        || req.body?.ingest_token
        || req.body?.events?.[0]?.ingest_token
        || '',
    ).trim();
    const tenantKey = config.requireIngestToken && validShopIngestToken(shopDomain, suppliedToken)
        ? shopDomain
        : 'untrusted';
    return `${tenantKey}:${firstForwardedIp(req)}`;
}

const localPixelRateWindows = new Map();
const DISTRIBUTED_RATE_LIMIT_SCRIPT = `
    local count = redis.call('INCRBY', KEYS[1], ARGV[2])
    if count == tonumber(ARGV[2]) then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    return {count, redis.call('TTL', KEYS[1])}
`;

async function pixelLimiter(req, res, next) {
    if (config.pixelRateLimitPerMinute <= 0) return next();
    // Do not let an unauthenticated caller evade limits or create unbounded
    // Redis keys merely by rotating a forged shop_domain value.
    const identity = pixelRateLimitIdentity(req);
    const digest = crypto.createHash('sha256').update(identity).digest('hex');
    // Charge both event count and payload volume. One oversized event must not
    // cost the same as one small PageView during abuse or a client bug.
    const payloadWeight = Math.ceil(Number(req.rawBody?.length || 0) / 16_384);
    const eventWeight = Math.max(1, pixelPayloadsFromBody(req.body).length, payloadWeight);
    try {
        const [count, ttl] = await redis.eval(
            DISTRIBUTED_RATE_LIMIT_SCRIPT,
            1,
            `rate:pixel:${digest}`,
            60,
            eventWeight,
        );
        const remaining = Math.max(0, config.pixelRateLimitPerMinute - Number(count));
        res.set('RateLimit-Limit', String(config.pixelRateLimitPerMinute));
        res.set('RateLimit-Remaining', String(remaining));
        res.set('RateLimit-Reset', String(Math.max(1, Number(ttl) || 60)));
        if (Number(count) > config.pixelRateLimitPerMinute) {
            res.set('Retry-After', String(Math.max(1, Number(ttl) || 60)));
            return res.status(429).json({ error: 'Too many pixel events', retryable: true });
        }
        return next();
    } catch (error) {
        // PostgreSQL ingestion remains available during a Redis incident. The
        // emergency process-local limiter uses the same event weight as Redis,
        // so a 50-event request consumes 50 units rather than one request.
        const local = consumeWeightedWindow(
            localPixelRateWindows,
            digest,
            eventWeight,
            config.pixelRateLimitPerMinute,
        );
        res.set('RateLimit-Limit', String(config.pixelRateLimitPerMinute));
        res.set('RateLimit-Remaining', String(local.remaining));
        res.set('RateLimit-Reset', String(local.retryAfterSeconds));
        res.set('X-RateLimit-Mode', 'local-weighted-degraded');
        if (!local.allowed) {
            res.set('Retry-After', String(local.retryAfterSeconds));
            return res.status(429).json({ error: 'Too many pixel events', retryable: true });
        }
        return next();
    }
}

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ATTRIBUTION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_PIXEL_BATCH_SIZE = 50;
const SUPPORTED_PIXEL_SCHEMA_VERSION = '2.0';
const SUPPORTED_PIXEL_SOURCE_VERSIONS = new Set([
    'shopify-pixel-v14',
    'shopify-pixel-v15',
    'shopify-pixel-v16',
    'shopify-pixel-v17',
    'shopify-pixel-v18',
    'shopify-pixel-v19',
    'shopify-pixel-v20',
]);
const SHOPIFY_BROWSER_EVENT_SOURCES = new Map([
    ['PageView', 'page_viewed'],
    ['Search', 'search_submitted'],
    ['CartView', 'cart_viewed'],
    ['CollectionView', 'collection_viewed'],
    ['ViewContent', 'product_viewed'],
    ['AddToCart', 'product_added_to_cart'],
    ['RemoveFromCart', 'product_removed_from_cart'],
    ['InitiateCheckout', 'checkout_started'],
    ['CheckoutContactInfoSubmitted', 'checkout_contact_info_submitted'],
    ['CheckoutAddressInfoSubmitted', 'checkout_address_info_submitted'],
    ['CheckoutShippingInfoSubmitted', 'checkout_shipping_info_submitted'],
    ['AddPaymentInfo', 'payment_info_submitted'],
    ['Purchase', 'checkout_completed'],
]);
const BROWSER_DIAGNOSTIC_CODES = new Set([
    'QUEUE_OVERFLOW',
    'RETRY_EXHAUSTED',
    'RETRY_AGE_EXPIRED',
    'STORAGE_READ_FAILED',
    'STORAGE_WRITE_FAILED',
    'SERVER_BATCH_REJECTED',
    'SERVER_REQUEST_REJECTED',
    'META_BROWSER_QUEUE_OVERFLOW',
]);
const PIXEL_CONFIG_CACHE_TTL_MS = 5000;
const MAX_PIXEL_CONFIG_CACHE_ENTRIES = 5000;
const pixelConfigCache = new Map();
const RECOVERABLE_META_CREDENTIAL_CODES = [
    '10', '102', '190', '200', '401', '403', '463', '467', '803', '2500',
];

function invalidatePixelConfigCache(shopIdsOrDomains) {
    for (const value of shopIdsOrDomains || []) {
        if (typeof value === 'string' && value.includes('.')) {
            pixelConfigCache.delete(normalizeShopDomain(value));
            continue;
        }
        const numericId = Number(value);
        if (!Number.isInteger(numericId)) continue;
        for (const [shopDomain, cached] of pixelConfigCache) {
            if (Number(cached.shopId) === numericId) pixelConfigCache.delete(shopDomain);
        }
    }
}
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

function requireIanaTimezone(value) {
    const timezone = requireBoundedString(value || 'UTC', 'reporting_timezone', 64);
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    } catch (error) {
        const validationError = new Error('reporting_timezone must be a valid IANA timezone such as America/Los_Angeles');
        validationError.statusCode = 400;
        throw validationError;
    }
    return timezone;
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

function normalizeUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
        parsed.username = '';
        parsed.password = '';
        parsed.hash = '';
        // Checkout URLs and arbitrary query strings can contain customer data,
        // session secrets or access tokens. Attribution identifiers such as
        // fbclid/UTM parameters remain intact; known sensitive keys do not.
        parsed.pathname = parsed.pathname.replace(/\/checkouts\/[^/]+/i, '/checkouts/redacted');
        for (const key of [...parsed.searchParams.keys()]) {
            if (/(?:^|_)(?:access_?token|auth|email|phone|password|secret|session|customer|first_?name|last_?name|address)(?:$|_)/i.test(key)) {
                parsed.searchParams.delete(key);
            }
        }
        return parsed.toString();
    } catch (error) {
        return undefined;
    }
}

function validateShopifyBrowserPayload(payload) {
    const eventName = requireBoundedString(payload?.event_name, 'event_name', 50);
    const expectedSourceEvent = SHOPIFY_BROWSER_EVENT_SOURCES.get(eventName);
    if (!expectedSourceEvent) {
        const error = new Error(`Unsupported storefront event_name: ${eventName}`);
        error.statusCode = 422;
        throw error;
    }
    if (payload?.source_provider !== 'shopify_web_pixels') {
        const error = new Error('source_provider must be shopify_web_pixels');
        error.statusCode = 422;
        throw error;
    }
    if (String(payload?.source_event_name || '').trim() !== expectedSourceEvent) {
        const error = new Error(`source_event_name must be ${expectedSourceEvent} for ${eventName}`);
        error.statusCode = 422;
        throw error;
    }
    const sourceVersion = String(payload?.source_version || '').trim();
    const schemaVersion = String(payload?.schema_version || '').trim();
    if (!SUPPORTED_PIXEL_SOURCE_VERSIONS.has(sourceVersion)
        || schemaVersion !== SUPPORTED_PIXEL_SCHEMA_VERSION) {
        const error = new Error('Unsupported storefront pixel source/schema version');
        error.statusCode = 426;
        throw error;
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

function boundedDiagnosticEventCounts(value) {
    if (!isPayloadObject(value)) return {};
    const result = {};
    for (const [rawName, rawCount] of Object.entries(value).slice(0, 20)) {
        const name = String(rawName || '').trim();
        const count = Number(rawCount);
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) continue;
        if (!Number.isInteger(count) || count <= 0 || count > 10000) continue;
        result[name] = count;
    }
    return result;
}

function boundedClientTimestamp(value) {
    if (!value) return null;
    const timestamp = new Date(value);
    const milliseconds = timestamp.getTime();
    if (!Number.isFinite(milliseconds)) return null;
    const now = Date.now();
    if (milliseconds < now - (7 * 24 * 60 * 60 * 1000) || milliseconds > now + (5 * 60 * 1000)) return null;
    return timestamp;
}

function durableAliasEntries(eventName, eventId, payload) {
    if (eventName !== 'Purchase') return [];
    const candidates = [
        ['id', eventId],
        ['checkout', payload.checkout_token],
        ['order', payload.order_id],
        // The browser can know the immutable Shopify Order ID while its
        // checkout token is absent. Store that ID under the same semantic
        // alias type as order_id so a later paid webhook can bridge them.
        ['order', payload._shopify_order_id],
        ['shopify_order', payload._shopify_order_id],
        ['cart', payload.cart_token],
    ];
    const tenantPrefix = `${normalizeShopDomain(firstPresent(payload.tenant_id, payload.shop_domain))}:`;
    const entries = candidates.flatMap(([type, rawValue]) => {
        const normalized = cleanKeyPart(normalizeEventId(rawValue) || rawValue);
        if (!normalized) return [];
        const unscoped = tenantPrefix !== ':' && normalized.toLowerCase().startsWith(tenantPrefix)
            ? normalized.slice(tenantPrefix.length)
            : normalized;
        // Keep the old scoped form as a compatibility alias so purchases
        // already waiting in a pre-v16 deployment still merge after upgrade.
        return [...new Set([unscoped, normalized])].map(value => ({ type, value }));
    });

    const seen = new Set();
    return entries.filter(entry => {
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

async function clearShopRuntimeData(shopId, shopDomain) {
    const operations = [
        deleteRuntimeQueueKeysForShop(shopId),
        redis.del(`lock:batch_packing:${shopId}`),
        redis.del(`lock:watchdog:${shopId}`),
        deleteKeysByPattern(`attr:${shopId}:*`),
        deleteKeysByPattern(`dedup:${shopId}:*`),
        deleteKeysByPattern(`dedup-alias:${shopId}:*`),
        removeQueuedSendJobsForShop(shopId),
    ];
    if (shopDomain) operations.push(deleteKeysByPattern(`shopify:webhook:${shopDomain}:*`));
    const results = await Promise.allSettled(operations);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length > 0) {
        console.warn(`[Privacy] ${failures.length} runtime cache cleanup operations failed for shop ${shopId}; database deletion remains authoritative`);
    }
}

async function deleteShopDataById(shopId) {
    const client = await pool.connect();
    let shopDomain;
    let deleted = false;
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shop-delete:${shopId}`]);
        const shopResult = await client.query(
            'SELECT shop_domain FROM shops WHERE id = $1 FOR UPDATE',
            [shopId],
        );
        shopDomain = shopResult.rows[0]?.shop_domain;
        if (shopDomain) {
            await client.query('DELETE FROM dead_letters WHERE shop_id = $1', [shopId]);
            // Remove tenant events first so their delivery rows are gone before
            // the shop cascade removes routes protected by ON DELETE RESTRICT.
            await client.query('DELETE FROM event_store WHERE shop_id = $1', [shopId]);
            const result = await client.query('DELETE FROM shops WHERE id = $1', [shopId]);
            deleted = result.rowCount > 0;
            await client.query(
                `UPDATE pixels pixel
                 SET status = 'archived',
                     archived_at = COALESCE(archived_at, NOW()),
                     access_token = '',
                     quality_access_token = NULL,
                     test_event_code = NULL,
                     credential_scope = NULL,
                     rate_limit_group = NULL,
                     rate_limit_until = NULL
                 WHERE status = 'active'
                   AND NOT EXISTS (
                       SELECT 1 FROM shop_pixel_routes route WHERE route.pixel_id = pixel.id
                   )`,
            );
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
    if (deleted) {
        invalidatePixelConfigCache([shopDomain]);
        await clearShopRuntimeData(shopId, shopDomain);
    }
    return { deleted, shopDomain };
}

async function insertMetaQualitySnapshot(
    pixel,
    shopId,
    status,
    rawPayload,
    errorMessage = null,
    precomputedSummary = null,
) {
    const summary = precomputedSummary || (status === 'SUCCESS' || status === 'EMPTY'
        ? summarizeMetaQuality(rawPayload)
        : null);
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
        params: buildMetaQualityRequestParams(pixel.pixel_id, config.metaQualityAgentName),
    });
    return response;
}

async function sharedCredentialCooldownSeconds(credentialScope) {
    if (!credentialScope) return 0;
    const [{ rows }, redisTtlMs] = await Promise.all([
        pool.query(
            `SELECT GREATEST(
                        0,
                        CEIL(EXTRACT(EPOCH FROM (rate_limit_until - NOW())))
                    )::int AS seconds
             FROM pixels
             WHERE credential_scope = $1
             ORDER BY seconds DESC
             LIMIT 1`,
            [credentialScope],
        ),
        redis.pttl(`cooldown:delivery-credential:${credentialScope}`).catch(() => -1),
    ]);
    return Math.max(
        Number(rows[0]?.seconds || 0),
        Math.ceil(Math.max(0, Number(redisTtlMs || 0)) / 1000),
    );
}

async function refreshMetaQualityForPixel(pixel) {
    if (pixel.platform !== 'facebook') return null;
    const shopIds = Array.isArray(pixel.shop_ids) ? pixel.shop_ids : [pixel.shop_id].filter(Boolean);
    const cooldownSeconds = await sharedCredentialCooldownSeconds(pixel.credential_scope);
    if (cooldownSeconds > 0) {
        return {
            pixel_id: pixel.pixel_id,
            status: 'DEFERRED',
            retry_after_seconds: cooldownSeconds,
        };
    }

    try {
        const response = await fetchMetaQualityForPixel(pixel);
        const rawPayload = response.data;
        const rateControl = metaRateControlFromHeaders(response.headers);
        await pool.query(
            `UPDATE pixels
             SET last_usage_pct = COALESCE($1, last_usage_pct),
                 rate_limit_until = CASE
                     WHEN $2::int > 0
                     THEN GREATEST(
                         COALESCE(rate_limit_until, NOW()),
                         NOW() + ($2::int * INTERVAL '1 second')
                     )
                     ELSE rate_limit_until
                 END,
                 last_rate_limit_at = CASE WHEN $2::int > 0 THEN NOW() ELSE last_rate_limit_at END
             WHERE credential_scope = $3`,
            [
                rateControl.maxUsagePercent === undefined ? null : Number(rateControl.maxUsagePercent),
                Math.ceil(Number(rateControl.cooldownSeconds || 0)),
                pixel.credential_scope,
            ],
        );
        const summary = summarizeMetaQuality(rawPayload);
        const snapshotStatus = summary.events.length ? 'SUCCESS' : 'EMPTY';
        const emptyMessage = snapshotStatus === 'EMPTY'
            ? 'Meta Dataset Quality returned no event-level metrics; use local signal coverage while permissions and data availability are verified'
            : null;
        for (const shopId of shopIds) {
            await insertMetaQualitySnapshot(
                pixel,
                shopId,
                snapshotStatus,
                rawPayload,
                emptyMessage,
                summary,
            );
        }
        return { pixel_id: pixel.pixel_id, status: snapshotStatus, summary };
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
                         NOW() + ($1::int * INTERVAL '1 second')
                     ),
                     last_rate_limit_at = NOW(),
                     last_usage_pct = COALESCE($2, last_usage_pct)
                 WHERE credential_scope = $3`,
                [
                    Math.ceil(cooldownSeconds),
                    classification.rateControl?.maxUsagePercent === undefined
                        ? null
                        : Number(classification.rateControl.maxUsagePercent),
                    pixel.credential_scope,
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
                p.credential_scope,
                p.rate_limit_until
         FROM shop_pixel_routes r
         JOIN pixels p ON p.id = r.pixel_id
         JOIN shops s ON s.id = r.shop_id
         WHERE p.platform = 'facebook'
           AND p.status = 'active'
           AND r.status = 'active'
           AND s.status = 'active'
           ${shopFilter}
         GROUP BY p.id
         ORDER BY p.id ASC`,
        params,
    );

    const results = [];
    for (const pixel of pixels) {
        const lockKey = `lock:delivery-credential:${pixel.credential_scope || pixel.id}`;
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
                   AND CARDINALITY(event.delivery_route_snapshot) > 0
                   AND CARDINALITY(event.delivery_route_snapshot) = (
                       SELECT COUNT(*)
                       FROM event_deliveries delivery
                       WHERE delivery.event_store_id = event.id
                         AND delivery.route_id = ANY(event.delivery_route_snapshot)
                   )
                   AND NOT EXISTS (
                       SELECT 1
                       FROM event_deliveries outstanding
                       WHERE outstanding.event_store_id = event.id
                         AND outstanding.route_id = ANY(event.delivery_route_snapshot)
                         AND outstanding.status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')
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
                 JOIN event_store event ON event.id = candidate.id
                 WHERE delivery.route_id = ANY(event.delivery_route_snapshot)
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
    const privacyInbox = await deleteRetentionBatches(
        `WITH expired AS (
             SELECT id
             FROM shopify_privacy_inbox
             WHERE status IN ('SUCCESS', 'FAILED_PERMANENT')
               AND COALESCE(completed_at, processed_at, created_at) < NOW() - ($1::int * INTERVAL '1 day')
             ORDER BY COALESCE(completed_at, processed_at, created_at), id
             FOR UPDATE SKIP LOCKED
             LIMIT $2
         )
         DELETE FROM shopify_privacy_inbox target
         USING expired
         WHERE target.id = expired.id`,
        config.shopifyPrivacyRetentionDays,
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
    const browserDiagnostics = await deleteRetentionBatches(
        `WITH expired AS (
             SELECT id
             FROM browser_delivery_diagnostics
             WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
             ORDER BY created_at ASC, id ASC
             FOR UPDATE SKIP LOCKED
             LIMIT $2
         )
         DELETE FROM browser_delivery_diagnostics target
         USING expired
         WHERE target.id = expired.id`,
        config.browserDiagnosticRetentionDays,
    );
    const expiredTestCodes = await pool.query(
        `UPDATE shop_pixel_routes
         SET test_event_code = NULL,
             test_event_code_expires_at = NULL
         WHERE test_event_code IS NOT NULL
           AND (test_event_code_expires_at IS NULL OR test_event_code_expires_at <= NOW())`,
    );
    return {
        eventStore,
        aliases,
        webhookInbox,
        privacyInbox,
        deadLetters,
        qualitySnapshots,
        browserDiagnostics,
        expiredTestCodes: expiredTestCodes.rowCount,
    };
}

async function insertMalformedQueuedEvent(shopId, rawPayload, reason) {
    await pool.query(
        `INSERT INTO dead_letters (shop_id, payload, error_reason)
         VALUES ($1, $2, $3)`,
        [shopId, JSON.stringify([{ raw_payload: rawPayload }]), reason],
    );
}

async function insertBrowserIngestionRejection(shopId, payload, error) {
    const diagnostic = compactObject({
        event_name: payload?.event_name,
        event_id: payload?.event_id,
        source_provider: payload?.source_provider,
        source_event_name: payload?.source_event_name,
        source_event_id: payload?.source_event_id,
        source_version: payload?.source_version,
        schema_version: payload?.schema_version,
        trace_id: payload?.trace_id,
        supplied_fields: payload && typeof payload === 'object'
            ? Object.keys(payload).filter(key => !['ingest_token', 'email', 'phone'].includes(key)).sort()
            : [],
    });
    await pool.query(
        `INSERT INTO dead_letters (shop_id, payload, error_reason)
         VALUES ($1, $2, $3)`,
        [
            shopId,
            JSON.stringify([{ ingestion_rejection: diagnostic }]),
            `Browser ingestion rejected: ${String(error?.message || error).slice(0, 3900)}`,
        ],
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
        const mergedPayload = mergePersistedEventPayload(existing.request_payload, purePayload);
        const mergedValidationErrors = validateMetaEvent(
            prepareMetaEvent(stripPrivateFields({ ...mergedPayload })),
        );
        mergedPayload._quality = {
            ...(mergedPayload._quality || {}),
            local_validation_errors: mergedValidationErrors,
        };
        // A duplicate only reopens a locally-invalid delivery when the merged
        // payload actually repairs every validation error. Otherwise repeated
        // browser retries would create an endless fail/reopen loop.
        const validationRepaired = recoverableValidationFailure
            && mergedValidationErrors.length === 0;
        const reopenForDelivery = paymentUnlocked || validationRepaired;
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
        if (validationRepaired) {
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
            return enqueueReschedulableJob(
                capiQueue,
                'send-fb-batch',
                { shopId },
                { delay, jobId },
            );
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
    const customData = buildCustomData(enrichedPayload, config.commerceItemLimit);
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
        opt_out: typeof enrichedPayload.opt_out === 'boolean' ? enrichedPayload.opt_out : undefined,
        user_data: userData,
        custom_data: customData,
        _emq_estimate: calculateEMQ(userData),
        _quality: {
            missing_match_signals: missingMatchSignals(userData),
            missing_event_parameters: missingCommerceSignals(eventName, customData),
            commerce_items_truncated: (Array.isArray(enrichedPayload.contents)
                && enrichedPayload.contents.length > config.commerceItemLimit)
                || (Array.isArray(enrichedPayload.content_ids)
                    && enrichedPayload.content_ids.length > config.commerceItemLimit),
        },
        _platform_data: buildPlatformData(enrichedPayload),
        _source: compactObject({
            provider: enrichedPayload.source_provider || 'shopify_web_pixels',
            event_name: enrichedPayload.source_event_name,
            event_id: enrichedPayload.source_event_id,
            sequence: enrichedPayload.source_event_seq,
            source_version: enrichedPayload.source_version,
            api_version: enrichedPayload.source_api_version,
            customer_lifecycle: enrichedPayload.customer_lifecycle,
            // Private, shop-scoped audit key. This never leaves the service,
            // but lets the dashboard reconcile each paid Shopify order to its
            // durable Purchase and Meta delivery without comparing display
            // names or collapsing identical IDs from different shops.
            order_identity: eventName === 'Purchase' ? firstPresent(
                enrichedPayload.checkout_token,
                enrichedPayload.cart_token,
                enrichedPayload._shopify_order_id,
                enrichedPayload.order_id,
            ) : undefined,
        }),
        _requires_payment_confirmation: requiresPaymentConfirmation,
        _payment_confirmed: paymentConfirmed,
        _attribution_enriched: Object.keys(attribution).length > 0,
        _received_at: Date.now(),
    };

    const validationErrors = validateMetaEvent(
        prepareMetaEvent(stripPrivateFields({ ...fbEventData })),
    );
    // Persist first so a complementary browser/webhook duplicate can merge
    // missing UA, identifiers or commerce parameters before the worker's
    // authoritative pre-send validation. If no duplicate repairs the event,
    // the worker records LOCAL_VALIDATION in the delivery ledger and DLQ;
    // the conversion is observable instead of disappearing at ingestion.
    fbEventData._quality.local_validation_errors = validationErrors;

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

    // The per-shop token identifies the configured tenant but is embedded in
    // public storefront code. Validate the expected Shopify event mapping as
    // an additional integrity boundary so typos, stale snippets and generic
    // clients cannot silently create arbitrary Meta funnel events.
    for (const payload of normalizedPayloads) validateShopifyBrowserPayload(payload);

    const { rows } = await pool.query(
        'SELECT id FROM shops WHERE shop_domain = $1 AND status = $2',
        [shopDomain, 'active'],
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Shop inactive' });

    const observedSourceVersion = String(normalizedPayloads[0].source_version).trim();
    const observedSchemaVersion = String(normalizedPayloads[0].schema_version).trim();
    await pool.query(
            `INSERT INTO shopify_pixel_runtime_status
                (shop_id, source_version, schema_version, first_seen_at, last_seen_at, updated_at)
             VALUES ($1, $2, NULLIF($3, ''), NOW(), NOW(), NOW())
             ON CONFLICT (shop_id) DO UPDATE
             SET source_version = EXCLUDED.source_version,
                 schema_version = EXCLUDED.schema_version,
                 last_seen_at = NOW(),
                 updated_at = NOW()
             WHERE shopify_pixel_runtime_status.source_version IS DISTINCT FROM EXCLUDED.source_version
                OR shopify_pixel_runtime_status.schema_version IS DISTINCT FROM EXCLUDED.schema_version
                OR shopify_pixel_runtime_status.last_seen_at < NOW() - INTERVAL '15 minutes'`,
        [rows[0].id, observedSourceVersion, observedSchemaVersion],
    );

    if (normalizedPayloads.length === 1) {
        try {
            return await queueForOutbox(
                req,
                res,
                { ...normalizedPayloads[0], shop_domain: shopDomain, tenant_id: shopDomain },
                rows[0].id,
                { allowRequestIdentifiers: true, requirePaymentConfirmation: true },
            );
        } catch (error) {
            const statusCode = Number(error.statusCode || 500);
            if (statusCode >= 400 && statusCode < 500) {
                await insertBrowserIngestionRejection(rows[0].id, normalizedPayloads[0], error);
            }
            throw error;
        }
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
            await insertBrowserIngestionRejection(rows[0].id, payload, error);
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
        success: rejected === 0,
        batch: true,
        received: normalizedPayloads.length,
        queued,
        deduplicated,
        rejected,
        results,
    });
}));

app.post('/api/pixel-diagnostic', pixelLimiter, asyncHandler(async (req, res) => {
    const shopDomain = requireMyshopifyDomain(req.body?.shop_domain);
    const suppliedIngestToken = String(
        req.headers['x-capi-ingest-token'] || req.body?.ingest_token || '',
    ).trim();
    if (!validShopIngestToken(shopDomain, suppliedIngestToken)) {
        return res.status(401).json({ error: 'Invalid shop ingest token' });
    }

    const sourceVersion = requireBoundedString(req.body?.source_version, 'source_version', 64);
    const schemaVersion = optionalBoundedString(req.body?.schema_version, 'schema_version', 32);
    if (!SUPPORTED_PIXEL_SOURCE_VERSIONS.has(sourceVersion)
        || schemaVersion !== SUPPORTED_PIXEL_SCHEMA_VERSION) {
        return res.status(426).json({ error: 'Unsupported storefront pixel source/schema version' });
    }
    const diagnosticType = String(req.body?.type || 'heartbeat').trim().toLowerCase();
    if (!['heartbeat', 'delivery_loss'].includes(diagnosticType)) {
        return res.status(400).json({ error: 'Unsupported diagnostic type' });
    }

    const { rows } = await pool.query(
        `SELECT id FROM shops WHERE shop_domain = $1 AND status = 'active'`,
        [shopDomain],
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Shop inactive' });
    const shopId = Number(rows[0].id);

    if (diagnosticType === 'heartbeat') {
        await pool.query(
            `INSERT INTO shopify_pixel_runtime_status
                (shop_id, source_version, schema_version, first_seen_at, last_seen_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW(), NOW())
             ON CONFLICT (shop_id) DO UPDATE
             SET source_version = EXCLUDED.source_version,
                 schema_version = EXCLUDED.schema_version,
                 last_seen_at = NOW(),
                 updated_at = NOW()`,
            [shopId, sourceVersion, schemaVersion],
        );
        return res.status(202).json({ success: true, recorded: 'heartbeat' });
    }

    const code = requireBoundedString(req.body?.code, 'code', 64).toUpperCase();
    if (!BROWSER_DIAGNOSTIC_CODES.has(code)) {
        return res.status(400).json({ error: 'Unsupported diagnostic code' });
    }
    const droppedCount = Number(req.body?.dropped_count || 0);
    if (!Number.isInteger(droppedCount) || droppedCount <= 0 || droppedCount > 10000) {
        return res.status(400).json({ error: 'dropped_count must be an integer from 1 to 10000' });
    }
    const eventCounts = boundedDiagnosticEventCounts(req.body?.event_counts);
    const clientFirstAt = boundedClientTimestamp(req.body?.client_first_at);
    const clientLastAt = boundedClientTimestamp(req.body?.client_last_at);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO browser_delivery_diagnostics
                (shop_id, code, dropped_count, event_counts, source_version, schema_version,
                 client_first_at, client_last_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
            [
                shopId,
                code,
                droppedCount,
                JSON.stringify(eventCounts),
                sourceVersion,
                schemaVersion,
                clientFirstAt,
                clientLastAt,
            ],
        );
        await client.query(
            `INSERT INTO shopify_pixel_runtime_status
                (shop_id, source_version, schema_version, first_seen_at, last_seen_at,
                 last_diagnostic_at, diagnostic_count, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW(), NOW(), 1, NOW())
             ON CONFLICT (shop_id) DO UPDATE
             SET source_version = EXCLUDED.source_version,
                 schema_version = EXCLUDED.schema_version,
                 last_seen_at = NOW(),
                 last_diagnostic_at = NOW(),
                 diagnostic_count = shopify_pixel_runtime_status.diagnostic_count + 1,
                 updated_at = NOW()`,
            [shopId, sourceVersion, schemaVersion],
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
    return res.status(202).json({ success: true, recorded: 'delivery_loss' });
}));

app.post('/api/pixel-config', asyncHandler(async (req, res) => {
    const shopDomain = requireMyshopifyDomain(req.body?.shop_domain);
    const suppliedIngestToken = String(
        req.headers['x-capi-ingest-token']
        || req.body?.ingest_token
        || '',
    ).trim();
    // Route topology is not accepted from the storefront. Even when event
    // ingestion token enforcement is disabled for a legacy deployment, this
    // read endpoint always requires the per-shop token.
    if (!validShopIngestToken(shopDomain, suppliedIngestToken)) {
        return res.status(401).json({ error: 'Invalid shop ingest token' });
    }

    let pixelIds;
    const cached = pixelConfigCache.get(shopDomain);
    if (cached && cached.expiresAt > Date.now()) {
        pixelIds = cached.pixelIds;
    } else {
        const { rows } = await pool.query(
            `SELECT shop.id AS shop_id, pixel.pixel_id
             FROM shops shop
             JOIN shop_pixel_routes route
               ON route.shop_id = shop.id
              AND route.status = 'active'
             JOIN pixels pixel
               ON pixel.id = route.pixel_id
              AND pixel.status = 'active'
              AND pixel.platform = 'facebook'
             WHERE shop.shop_domain = $1
               AND shop.status = 'active'
             ORDER BY pixel.id`,
            [shopDomain],
        );
        pixelIds = [...new Set(rows.map(row => String(row.pixel_id || '').trim()).filter(Boolean))];
        if (pixelConfigCache.size >= MAX_PIXEL_CONFIG_CACHE_ENTRIES) {
            pixelConfigCache.delete(pixelConfigCache.keys().next().value);
        }
        pixelConfigCache.set(shopDomain, {
            pixelIds,
            shopId: rows[0]?.shop_id,
            expiresAt: Date.now() + PIXEL_CONFIG_CACHE_TTL_MS,
        });
    }

    res.set('Cache-Control', 'private, no-store');
    return res.json({
        shop_domain: shopDomain,
        pixel_ids: pixelIds,
        fetched_at: new Date().toISOString(),
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
        source_provider: row.webhook_id?.startsWith('reconcile:')
            ? 'shopify_admin_graphql'
            : 'shopify_webhook',
        source_event_name: row.topic,
        source_event_id: row.webhook_id,
        source_api_version: row.shopify_api_version,
    }, Number(row.shop_id), {
        allowRequestIdentifiers: false,
        paymentConfirmed: true,
    });
}

async function failExhaustedShopifyWebhookInboxRows() {
    const { rowCount } = await pool.query(
        `UPDATE shopify_webhook_inbox
         SET status = 'FAILED_PERMANENT',
             lease_expires_at = NULL,
             processed_at = COALESCE(processed_at, NOW()),
             error_message = COALESCE(
                 NULLIF(error_message, ''),
                 'Processing lease expired after the maximum attempt count'
             )
         WHERE status = 'PROCESSING'
           AND lease_expires_at < NOW()
           AND attempt_count >= $1`,
        [config.shopifyWebhookInboxMaxAttempts],
    );
    return rowCount;
}

async function claimShopifyWebhookInboxRow() {
    const { rows } = await pool.query(
        `WITH candidate AS (
             SELECT id
             FROM shopify_webhook_inbox
             WHERE next_attempt_at <= NOW()
               AND attempt_count < $2
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
             error_message = CASE
                 WHEN inbox.status = 'PROCESSING'
                     THEN 'Previous processing lease expired; retrying'
                 ELSE NULL
             END
         FROM candidate
         WHERE inbox.id = candidate.id
         RETURNING inbox.*,
                   (SELECT shop_domain FROM shops WHERE id = inbox.shop_id) AS shop_domain`,
        [config.shopifyWebhookInboxLeaseSeconds, config.shopifyWebhookInboxMaxAttempts],
    );
    return rows[0] || null;
}

let drainingShopifyInbox = false;
async function drainShopifyWebhookInbox(limit = config.shopifyWebhookInboxBatchSize) {
    if (shuttingDown || drainingShopifyInbox || fs.existsSync(config.maintenanceFile)) return 0;
    drainingShopifyInbox = true;
    let processed = 0;
    try {
        const exhausted = await failExhaustedShopifyWebhookInboxRows();
        if (exhausted > 0) {
            console.error(`[ShopifyInbox] marked ${exhausted} expired paid-order rows permanently failed`);
        }
        while (processed < limit) {
            const row = await claimShopifyWebhookInboxRow();
            if (!row) break;
            try {
                const processTimeoutMs = Math.min(
                    config.shopifyWebhookProcessTimeoutMs,
                    Math.max(1000, (config.shopifyWebhookInboxLeaseSeconds * 1000) - 5000),
                );
                await withTimeout(
                    processShopifyWebhookInboxRow(row),
                    processTimeoutMs,
                    `Shopify paid-order webhook ${row.id}`,
                );
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
                     SET status = $2::varchar(30),
                         next_attempt_at = NOW() + ($3::int * INTERVAL '1 second'),
                         lease_expires_at = NULL,
                         processed_at = CASE WHEN $2::varchar(30) = 'FAILED_PERMANENT' THEN NOW() ELSE NULL END,
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
    query ReconcilePaidOrders($first: Int!, $after: String, $query: String!, $includeCustomer: Boolean!) {
        orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
            edges {
                cursor
                node {
                    id legacyResourceId name createdAt processedAt updatedAt sourceName test
                    email phone cartToken checkoutToken clientIp
                    currentSubtotalLineItemsQuantity
                    displayFinancialStatus
                    currentTotalPriceSet { shopMoney { amount currencyCode } }
                    transactions(first: 100) {
                        id kind status createdAt processedAt test
                    }
                    billingAddress {
                        firstName lastName phone city province provinceCode zip country countryCodeV2
                    }
                    shippingAddress {
                        firstName lastName phone city province provinceCode zip country countryCodeV2
                    }
                    customer @include(if: $includeCustomer) {
                        id firstName lastName numberOfOrders
                    }
                    customerJourneySummary {
                        customerOrderIndex
                        lastVisit { landingPage referrerUrl }
                    }
                    lineItems(first: 250) {
                        nodes {
                            id quantity sku
                            product { id }
                            variant { id }
                            discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
                        }
                        pageInfo { hasNextPage endCursor }
                    }
                }
            }
            pageInfo { hasNextPage endCursor }
        }
    }
`;

const SHOPIFY_ORDER_LINE_ITEMS_QUERY = `
    query ReconcileOrderLineItems($id: ID!, $after: String) {
        order(id: $id) {
            lineItems(first: 250, after: $after) {
                nodes {
                    id quantity sku
                    product { id }
                    variant { id }
                    discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
                }
                pageInfo { hasNextPage endCursor }
            }
        }
    }
`;

const SHOPIFY_ACCESS_SCOPES_QUERY = `
    query ReconcileAccessScopes {
        currentAppInstallation { accessScopes { handle } }
    }
`;

const SHOPIFY_PAID_WEBHOOK_SUBSCRIPTIONS_QUERY = `
    query AuditOrdersPaidSubscriptions {
        webhookSubscriptions(first: 100, topics: [ORDERS_PAID]) {
            nodes { id topic uri }
        }
    }
`;

const SHOPIFY_PAID_WEBHOOK_SUBSCRIPTION_CREATE = `
    mutation EnsureOrdersPaidSubscription(
        $topic: WebhookSubscriptionTopic!,
        $webhookSubscription: WebhookSubscriptionInput!
    ) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
            webhookSubscription { id topic uri }
            userErrors { field message }
        }
    }
`;

function expectedPaidWebhookUri() {
    return config.publicBaseUrl ? `${config.publicBaseUrl}/api/webhook/orders/paid` : '';
}

async function writePaidWebhookAuditState(shopId, state, db = pool) {
    await db.query(
        `INSERT INTO shopify_webhook_subscription_state
            (shop_id, status, expected_uri, observed_uris, managed_subscription_id,
             shopify_api_version, last_checked_at, last_repaired_at, last_error, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW(), $7, $8, NOW())
         ON CONFLICT (shop_id) DO UPDATE
         SET status = EXCLUDED.status,
             expected_uri = EXCLUDED.expected_uri,
             observed_uris = EXCLUDED.observed_uris,
             managed_subscription_id = EXCLUDED.managed_subscription_id,
             shopify_api_version = EXCLUDED.shopify_api_version,
             last_checked_at = NOW(),
             last_repaired_at = COALESCE(EXCLUDED.last_repaired_at,
                                         shopify_webhook_subscription_state.last_repaired_at),
             last_error = EXCLUDED.last_error,
             updated_at = NOW()`,
        [
            shopId,
            state.status,
            state.expectedUri || null,
            JSON.stringify(state.observedUris || []),
            state.managedSubscriptionId || null,
            state.shopifyApiVersion || config.shopifyApiVersion,
            state.repaired ? new Date() : null,
            state.error ? String(state.error).slice(0, 4000) : null,
        ],
    );
}

async function auditPaidWebhookSubscriptionForShop(shop, options = {}) {
    const expectedUri = expectedPaidWebhookUri();
    if (!expectedUri) {
        const state = {
            status: 'CONFIG_ERROR',
            expectedUri: '',
            observedUris: [],
            error: 'PUBLIC_BASE_URL is required to audit the ORDERS_PAID webhook URI',
        };
        await writePaidWebhookAuditState(shop.id, state);
        return state;
    }
    if (!shop.admin_access_token) {
        const state = {
            status: 'NO_ADMIN_TOKEN',
            expectedUri,
            observedUris: [],
            error: 'Shopify Admin API token is not configured',
        };
        await writePaidWebhookAuditState(shop.id, state);
        return state;
    }

    const token = decryptTokenIfPossible(shop.admin_access_token);
    const url = `https://${shop.shop_domain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
    try {
        const queryResponse = await axios.post(url, { query: SHOPIFY_PAID_WEBHOOK_SUBSCRIPTIONS_QUERY }, {
            timeout: config.fbRequestTimeoutMs,
            headers: {
                'X-Shopify-Access-Token': token,
                'Content-Type': 'application/json',
            },
        });
        const servedApiVersion = auditShopifyApiVersion(
            queryResponse,
            `ORDERS_PAID webhook audit for ${shop.shop_domain}`,
        );
        if (Array.isArray(queryResponse.data?.errors) && queryResponse.data.errors.length > 0) {
            throw new Error(`Shopify GraphQL: ${queryResponse.data.errors.map(item => item.message).join('; ')}`);
        }
        await waitForShopifyGraphqlThrottle(queryResponse.data);
        const subscriptions = queryResponse.data?.data?.webhookSubscriptions?.nodes || [];
        const observedUris = [...new Set(subscriptions.map(item => String(item?.uri || '').trim()).filter(Boolean))];
        const matching = subscriptions.filter(item => String(item?.uri || '').trim() === expectedUri);

        if (matching.length === 0 && options.repair === true) {
            const createResponse = await axios.post(url, {
                query: SHOPIFY_PAID_WEBHOOK_SUBSCRIPTION_CREATE,
                variables: {
                    topic: 'ORDERS_PAID',
                    webhookSubscription: { uri: expectedUri, format: 'JSON' },
                },
            }, {
                timeout: config.fbRequestTimeoutMs,
                headers: {
                    'X-Shopify-Access-Token': token,
                    'Content-Type': 'application/json',
                },
            });
            auditShopifyApiVersion(createResponse, `ORDERS_PAID webhook repair for ${shop.shop_domain}`);
            if (Array.isArray(createResponse.data?.errors) && createResponse.data.errors.length > 0) {
                throw new Error(`Shopify GraphQL: ${createResponse.data.errors.map(item => item.message).join('; ')}`);
            }
            await waitForShopifyGraphqlThrottle(createResponse.data);
            const mutation = createResponse.data?.data?.webhookSubscriptionCreate;
            const userErrors = mutation?.userErrors || [];
            if (userErrors.length > 0) {
                throw new Error(`Shopify webhook create: ${userErrors.map(item => item.message).join('; ')}`);
            }
            const created = mutation?.webhookSubscription;
            if (!created?.id || String(created.uri || '').trim() !== expectedUri) {
                throw new Error('Shopify did not return the expected ORDERS_PAID webhook subscription');
            }
            const repairedState = {
                status: observedUris.length > 0 ? 'HEALTHY_WITH_ALTERNATES' : 'HEALTHY',
                expectedUri,
                observedUris: [...new Set(observedUris.concat([expectedUri]))],
                managedSubscriptionId: created.id,
                shopifyApiVersion: servedApiVersion,
                repaired: true,
            };
            await writePaidWebhookAuditState(shop.id, repairedState);
            return repairedState;
        }

        const status = matching.length > 0
            ? (observedUris.some(uri => uri !== expectedUri) || matching.length > 1
                ? 'HEALTHY_WITH_ALTERNATES'
                : 'HEALTHY')
            : (observedUris.length > 0 ? 'URI_MISMATCH' : 'MISSING');
        const state = {
            status,
            expectedUri,
            observedUris,
            managedSubscriptionId: matching[0]?.id,
            shopifyApiVersion: servedApiVersion,
        };
        await writePaidWebhookAuditState(shop.id, state);
        return state;
    } catch (error) {
        const state = {
            status: 'ERROR',
            expectedUri,
            observedUris: [],
            error: error.message,
        };
        await writePaidWebhookAuditState(shop.id, state).catch(() => {});
        throw error;
    }
}

async function auditPaidWebhookSubscriptions() {
    if (shuttingDown || fs.existsSync(config.maintenanceFile)) return [];
    const { rows: shops } = await pool.query(
        `SELECT id, shop_domain, admin_access_token
         FROM shops
         WHERE status = 'active'
         ORDER BY id`,
    );
    const results = [];
    for (const shop of shops) {
        try {
            results.push({ shop_id: shop.id, ...(await auditPaidWebhookSubscriptionForShop(shop)) });
        } catch (error) {
            console.error(`[ShopifyWebhookAudit] ${shop.shop_domain}:`, error.message);
            results.push({ shop_id: shop.id, status: 'ERROR', error: error.message });
        }
    }
    return results;
}

function graphqlAddress(address) {
    if (!address) return undefined;
    return compactObject({
        first_name: address.firstName,
        last_name: address.lastName,
        phone: address.phone,
        city: address.city,
        province: address.province,
        province_code: address.provinceCode,
        zip: address.zip,
        country: address.country,
        country_code: address.countryCodeV2,
    });
}

async function waitForShopifyGraphqlThrottle(responseData) {
    const cost = responseData?.extensions?.cost;
    const available = Number(cost?.throttleStatus?.currentlyAvailable);
    const restoreRate = Number(cost?.throttleStatus?.restoreRate);
    const queryCost = Number(cost?.actualQueryCost || cost?.requestedQueryCost);
    if (Number.isFinite(available) && Number.isFinite(restoreRate) && restoreRate > 0
        && Number.isFinite(queryCost) && available < queryCost) {
        const delayMs = Math.min(5000, Math.ceil(((queryCost - available) / restoreRate) * 1000));
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
}

function observedShopifyApiVersion(response) {
    const value = String(response?.headers?.['x-shopify-api-version'] || '').trim();
    return /^\d{4}-\d{2}$/.test(value) ? value : null;
}

function auditShopifyApiVersion(response, context) {
    const observed = observedShopifyApiVersion(response);
    if (observed && observed !== config.shopifyApiVersion) {
        console.warn(
            `[ShopifyAPI] ${context} requested ${config.shopifyApiVersion} but Shopify served ${observed}`,
        );
    }
    return observed || config.shopifyApiVersion;
}

async function shopifyAccessScopes(url, token) {
    try {
        const response = await axios.post(url, { query: SHOPIFY_ACCESS_SCOPES_QUERY }, {
            timeout: config.fbRequestTimeoutMs,
            headers: {
                'X-Shopify-Access-Token': token,
                'Content-Type': 'application/json',
            },
        });
        auditShopifyApiVersion(response, 'access scopes');
        if (Array.isArray(response.data?.errors) && response.data.errors.length > 0) return new Set();
        await waitForShopifyGraphqlThrottle(response.data);
        return new Set(
            (response.data?.data?.currentAppInstallation?.accessScopes || [])
                .map(scope => String(scope?.handle || '').trim())
                .filter(Boolean),
        );
    } catch (error) {
        // Scope discovery enriches optional customer fields only. The required
        // read_orders reconciliation request remains the authoritative check.
        return new Set();
    }
}

async function hydrateAllShopifyLineItems(node, url, token) {
    const lineItems = [...(node.lineItems?.nodes || [])];
    let pageInfo = node.lineItems?.pageInfo;
    let pageCount = 1;
    while (pageInfo?.hasNextPage) {
        if (!pageInfo.endCursor) throw new Error(`Shopify order ${node.id} line item cursor is missing`);
        if (pageCount >= config.shopifyReconcileMaxLineItemPages) {
            throw new Error(`Shopify order ${node.id} exceeds the configured line item pagination safety limit`);
        }
        const response = await axios.post(url, {
            query: SHOPIFY_ORDER_LINE_ITEMS_QUERY,
            variables: { id: node.id, after: pageInfo.endCursor },
        }, {
            timeout: config.fbRequestTimeoutMs,
            headers: {
                'X-Shopify-Access-Token': token,
                'Content-Type': 'application/json',
            },
        });
        auditShopifyApiVersion(response, 'line item pagination');
        if (Array.isArray(response.data?.errors) && response.data.errors.length > 0) {
            throw new Error(`Shopify GraphQL: ${response.data.errors.map(item => item.message).join('; ')}`);
        }
        const connection = response.data?.data?.order?.lineItems;
        if (!connection) throw new Error(`Shopify order ${node.id} line item response is missing`);
        lineItems.push(...(connection.nodes || []));
        pageInfo = connection.pageInfo;
        pageCount += 1;
        await waitForShopifyGraphqlThrottle(response.data);
    }
    node.lineItems = { nodes: lineItems, pageInfo };
}

function reconciledGraphqlOrder(node) {
    const customerOrderIndex = Number(node.customerJourneySummary?.customerOrderIndex);
    return {
        _reconciled: true,
        id: node.legacyResourceId || node.id,
        admin_graphql_api_id: node.id,
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
        email: node.email,
        phone: node.phone,
        checkout_token: node.checkoutToken,
        cart_token: node.cartToken,
        browser_ip: node.clientIp,
        billing_address: graphqlAddress(node.billingAddress),
        shipping_address: graphqlAddress(node.shippingAddress),
        landing_site: node.customerJourneySummary?.lastVisit?.landingPage,
        referring_site: node.customerJourneySummary?.lastVisit?.referrerUrl,
        customer: (node.customer || Number.isInteger(customerOrderIndex)) ? compactObject({
            id: node.customer?.id,
            first_name: node.customer?.firstName,
            last_name: node.customer?.lastName,
            orders_count: node.customer?.numberOfOrders,
            is_first_order: Number.isInteger(customerOrderIndex)
                ? customerOrderIndex === 1
                : undefined,
        }) : undefined,
        line_items: (node.lineItems?.nodes || []).map(item => ({
            id: item.id,
            product_id: item.product?.id,
            variant_id: item.variant?.id,
            sku: item.sku,
            quantity: item.quantity,
            discountedUnitPriceAfterAllDiscountsSet: item.discountedUnitPriceAfterAllDiscountsSet,
        })),
        transactions: node.transactions || [],
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
    const accessScopes = await shopifyAccessScopes(url, token);
    const includeCustomer = accessScopes.has('read_customers');
    let after = state.rows[0].after_cursor || null;
    let received = 0;
    let cursorRestarted = false;
    let servedApiVersion = config.shopifyApiVersion;
    while (true) {
        const first = Math.min(100, config.shopifyReconcileMaxOrders - received);
        if (first <= 0) break;
        const response = await axios.post(url, {
            query: SHOPIFY_RECONCILE_QUERY,
            variables: {
                first,
                after,
                includeCustomer,
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
        servedApiVersion = auditShopifyApiVersion(
            response,
            `paid order reconciliation for ${shop.shop_domain}`,
        );
        if (Array.isArray(response.data?.errors) && response.data.errors.length > 0) {
            const errorMessage = response.data.errors.map(item => item.message).join('; ');
            // Shopify cursors can become invalid after retention or index
            // changes. Restart the same frozen window once instead of leaving
            // this shop permanently stuck on a bad durable cursor.
            if (after && !cursorRestarted && /cursor|after/i.test(errorMessage)) {
                cursorRestarted = true;
                after = null;
                await db.query(
                    `UPDATE shopify_reconcile_state
                     SET after_cursor = NULL,
                         last_error = $2,
                         updated_at = NOW()
                     WHERE shop_id = $1`,
                    [shop.id, `Recovered invalid cursor: ${errorMessage}`.slice(0, 4000)],
                );
                continue;
            }
            throw new Error(`Shopify GraphQL: ${errorMessage}`);
        }
        await waitForShopifyGraphqlThrottle(response.data);
        const connection = response.data?.data?.orders;
        if (!connection) throw new Error('Shopify GraphQL response is missing orders');
        for (const edge of connection.edges || []) {
            const node = edge.node;
            if (!node?.id || String(node.displayFinancialStatus).toUpperCase() !== 'PAID') continue;
            await hydrateAllShopifyLineItems(node, url, token);
            const payload = reconciledGraphqlOrder(node);
            const identity = crypto.createHash('sha256')
                .update(`${node.id}\0${node.processedAt || node.createdAt || ''}`)
                .digest('hex');
            await db.query(
                `INSERT INTO shopify_webhook_inbox
                    (shop_id, webhook_id, topic, shopify_api_version, triggered_at, payload)
                 VALUES ($1, $2, 'orders/paid', $3, $4, $5::jsonb)
                 ON CONFLICT (shop_id, webhook_id) DO NOTHING`,
                [
                    shop.id,
                    `reconcile:${identity}`,
                    servedApiVersion,
                    shopifyPaymentTimestamp(node) || scanCutoff,
                    JSON.stringify(payload),
                ],
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
        if (!after || received >= config.shopifyReconcileMaxOrders) break;
    }

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
    if (shuttingDown || fs.existsSync(config.maintenanceFile)) return 0;
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

const SHOPIFY_PRIVACY_TOPICS = new Set([
    'customers/data_request',
    'customers/redact',
    'shop/redact',
]);

function privacyOrderIds(payload = {}) {
    const values = [
        ...(Array.isArray(payload.orders_requested) ? payload.orders_requested : []),
        ...(Array.isArray(payload.orders_to_redact) ? payload.orders_to_redact : []),
    ];
    return [...new Set(values.map(normalizeShopifyId).filter(Boolean).map(String))].slice(0, 10000);
}

function privacyCustomer(payload = {}) {
    const customer = payload.customer && typeof payload.customer === 'object' ? payload.customer : {};
    return {
        id: normalizeShopifyId(customer.id),
        email: String(customer.email || '').trim().toLowerCase() || undefined,
        phone: String(customer.phone || '').trim() || undefined,
    };
}

async function shopifyWebhookSecrets(shopDomain) {
    const secrets = [];
    if (config.shopifyAppSecret) secrets.push(config.shopifyAppSecret);
    const { rows } = await pool.query(
        'SELECT id, app_secret FROM shops WHERE shop_domain = $1 LIMIT 1',
        [shopDomain],
    );
    if (rows[0]?.app_secret) {
        try {
            const storedSecret = decryptTokenIfPossible(rows[0].app_secret);
            if (storedSecret && !secrets.includes(storedSecret)) secrets.push(storedSecret);
        } catch (error) {
            if (!config.shopifyAppSecret) throw error;
            console.error(`[ShopifyWebhook] stored secret for ${shopDomain} could not be decrypted; using configured app secret`);
        }
    }
    return { shopId: rows[0]?.id, secrets };
}

function validShopifyWebhookHmac(rawBody, suppliedHmac, secrets) {
    return secrets.some(secret => timingSafeCompare(
        crypto.createHmac('sha256', secret).update(rawBody).digest('base64'),
        suppliedHmac,
    ));
}

function privacyMatchIdentity(shopDomain, payload) {
    const customer = privacyCustomer(payload);
    return {
        customer,
        orderIds: privacyOrderIds(payload),
        externalIdHash: customer.id ? tenantScopedExternalId(shopDomain, customer.id) : '',
        emailHash: customer.email ? hashUserData(customer.email, 'email') : '',
        phoneHash: customer.phone ? hashUserData(customer.phone, 'phone') : '',
    };
}

const PRIVACY_MATCH_SQL = `
    event.shop_id = $1
    AND (
        (COALESCE(event.request_payload->'user_data'->'external_id', '[]'::jsonb) ? $2)
        OR (COALESCE(event.request_payload->'user_data'->'em', '[]'::jsonb) ? $3)
        OR (COALESCE(event.request_payload->'user_data'->'ph', '[]'::jsonb) ? $4)
        OR EXISTS (
            SELECT 1
            FROM event_id_aliases alias
            WHERE alias.shop_id = event.shop_id
              AND alias.event_name = event.event_name
              AND alias.canonical_event_id = event.event_id
              AND alias.alias_type IN ('order', 'shopify_order')
              AND alias.alias_value = ANY($5::text[])
        )
    )`;

const PRIVACY_REPORT_PAGE_SIZE = 500;

async function loadPrivacyEventPage(shop, payload, { afterId = 0, limit = PRIVACY_REPORT_PAGE_SIZE } = {}) {
    const identity = privacyMatchIdentity(shop.shop_domain, payload);
    const boundedAfterId = Number.isInteger(Number(afterId)) && Number(afterId) >= 0 ? Number(afterId) : 0;
    const boundedLimit = Math.min(1000, Math.max(1, Number(limit) || PRIVACY_REPORT_PAGE_SIZE));
    const { rows } = await pool.query(
        `SELECT event.id, event.event_name, event.event_id, event.status,
                event.timestamp, event.emq_estimate,
                event.request_payload->'custom_data'->>'order_id' AS order_id
         FROM event_store event
         WHERE ${PRIVACY_MATCH_SQL}
           AND event.id > $6
         ORDER BY event.id
         LIMIT $7`,
        [
            shop.id,
            identity.externalIdHash,
            identity.emailHash,
            identity.phoneHash,
            identity.orderIds,
            boundedAfterId,
            boundedLimit + 1,
        ],
    );
    const hasMore = rows.length > boundedLimit;
    const events = rows.slice(0, boundedLimit);
    return {
        events,
        has_more: hasMore,
        next_after_id: hasMore ? Number(events[events.length - 1].id) : null,
    };
}

async function buildPrivacyDataReport(shop, payload) {
    const identity = privacyMatchIdentity(shop.shop_domain, payload);
    const { rows: [countRow] } = await pool.query(
        `SELECT COUNT(*)::bigint AS stored_event_count
         FROM event_store event
         WHERE ${PRIVACY_MATCH_SQL}`,
        [shop.id, identity.externalIdHash, identity.emailHash, identity.phoneHash, identity.orderIds],
    );
    const page = await loadPrivacyEventPage(shop, payload);
    return {
        generated_at: new Date().toISOString(),
        shop_domain: shop.shop_domain,
        customer_id: identity.customer.id,
        orders_requested: identity.orderIds,
        stored_event_count: Number(countRow.stored_event_count || 0),
        page_size: PRIVACY_REPORT_PAGE_SIZE,
        next_after_id: page.next_after_id,
        truncated: page.has_more,
        events: page.events,
        note: 'Customer matching values are stored as one-way hashes. This first page contains retained event metadata; follow next_after_id through the authenticated privacy events endpoint until has_more is false.',
    };
}

async function redactCustomerData(shop, payload) {
    const identity = privacyMatchIdentity(shop.shop_domain, payload);
    const client = await pool.connect();
    let deletedEvents = [];
    let deletedInboxRows = 0;
    let deletedDeadLetters = 0;
    let deletedAliases = 0;
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`privacy-customer:${shop.id}`]);
        const matched = await client.query(
            `SELECT event.id, event.event_name, event.event_id
             FROM event_store event
             WHERE ${PRIVACY_MATCH_SQL}
             FOR UPDATE OF event`,
            [shop.id, identity.externalIdHash, identity.emailHash, identity.phoneHash, identity.orderIds],
        );
        deletedEvents = matched.rows;
        if (deletedEvents.length > 0) {
            await client.query(
                'DELETE FROM event_store WHERE id = ANY($1::bigint[])',
                [deletedEvents.map(event => event.id)],
            );
            const aliases = await client.query(
                `DELETE FROM event_id_aliases alias
                 USING UNNEST($2::text[], $3::text[]) deleted(event_name, event_id)
                 WHERE alias.shop_id = $1
                   AND alias.event_name = deleted.event_name
                   AND alias.canonical_event_id = deleted.event_id`,
                [
                    shop.id,
                    deletedEvents.map(event => event.event_name),
                    deletedEvents.map(event => event.event_id),
                ],
            );
            deletedAliases += aliases.rowCount;
        }
        if (identity.orderIds.length > 0) {
            const aliases = await client.query(
                `DELETE FROM event_id_aliases
                 WHERE shop_id = $1
                   AND alias_type IN ('order', 'shopify_order')
                   AND alias_value = ANY($2::text[])`,
                [shop.id, identity.orderIds],
            );
            deletedAliases += aliases.rowCount;
        }
        const inbox = await client.query(
            `DELETE FROM shopify_webhook_inbox
             WHERE shop_id = $1
               AND (
                   ($2 <> '' AND (
                       COALESCE(payload->'customer'->>'id', '') = $2
                       OR COALESCE(payload->>'customer_id', '') = $2
                   ))
                   OR ($3 <> '' AND (
                       LOWER(COALESCE(payload->>'email', payload->>'contact_email', '')) = $3
                       OR LOWER(COALESCE(payload->'customer'->>'email', '')) = $3
                   ))
                   OR (CARDINALITY($4::text[]) > 0 AND COALESCE(payload->>'id', '') = ANY($4::text[]))
               )`,
            [shop.id, identity.customer.id || '', identity.customer.email || '', identity.orderIds],
        );
        deletedInboxRows = inbox.rowCount;
        // Dead letters can contain malformed raw payloads with customer data,
        // so conservative shop-scoped removal is safer than unreliable JSON matching.
        const deadLetters = await client.query('DELETE FROM dead_letters WHERE shop_id = $1', [shop.id]);
        deletedDeadLetters = deadLetters.rowCount;
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
    await deleteKeysByPattern(`attr:${shop.id}:*`).catch(() => {});
    await deleteKeysByPattern(`dedup:${shop.id}:*`).catch(() => {});
    await deleteKeysByPattern(`dedup-alias:${shop.id}:*`).catch(() => {});
    return {
        deleted_events: deletedEvents.length,
        deleted_aliases: deletedAliases,
        deleted_webhook_rows: deletedInboxRows,
        deleted_dead_letters: deletedDeadLetters,
    };
}

async function processShopifyPrivacyRow(row) {
    const payload = row.payload || {};
    const { rows } = await pool.query(
        'SELECT id, shop_domain FROM shops WHERE shop_domain = $1 LIMIT 1',
        [row.shop_domain],
    );
    const shop = rows[0];
    if (row.topic === 'customers/data_request') {
        return {
            status: 'ACTION_REQUIRED',
            result: shop
                ? await buildPrivacyDataReport(shop, payload)
                : {
                    generated_at: new Date().toISOString(),
                    shop_domain: row.shop_domain,
                    stored_event_count: 0,
                    events: [],
                    note: 'No retained shop data was found.',
                },
        };
    }
    if (row.topic === 'customers/redact') {
        const result = shop
            ? await redactCustomerData(shop, payload)
            : { deleted_events: 0, deleted_webhook_rows: 0, deleted_dead_letters: 0 };
        return { status: 'SUCCESS', result };
    }
    if (row.topic === 'shop/redact') {
        const result = shop ? await deleteShopDataById(shop.id) : { deleted: false };
        return { status: 'SUCCESS', result: { deleted_shop: result.deleted === true } };
    }
    const error = new Error(`Unsupported privacy topic: ${row.topic}`);
    error.statusCode = 422;
    throw error;
}

async function claimShopifyPrivacyRow() {
    const { rows } = await pool.query(
        `WITH candidate AS (
             SELECT id
             FROM shopify_privacy_inbox
             WHERE next_attempt_at <= NOW()
               AND (
                   status IN ('PENDING', 'RETRYABLE_FAILED')
                   OR (status = 'PROCESSING' AND lease_expires_at < NOW())
               )
             ORDER BY next_attempt_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
         )
         UPDATE shopify_privacy_inbox inbox
         SET status = 'PROCESSING',
             attempt_count = attempt_count + 1,
             lease_expires_at = NOW() + ($1::int * INTERVAL '1 second'),
             error_message = NULL
         FROM candidate
         WHERE inbox.id = candidate.id
         RETURNING inbox.*`,
        [config.shopifyPrivacyLeaseSeconds],
    );
    return rows[0] || null;
}

let drainingShopifyPrivacy = false;
async function drainShopifyPrivacyInbox(limit = config.shopifyPrivacyBatchSize) {
    if (shuttingDown || drainingShopifyPrivacy || fs.existsSync(config.maintenanceFile)) return 0;
    drainingShopifyPrivacy = true;
    let processed = 0;
    try {
        while (processed < limit) {
            const row = await claimShopifyPrivacyRow();
            if (!row) break;
            try {
                const outcome = await processShopifyPrivacyRow(row);
                const scrubPayload = outcome.status === 'SUCCESS';
                await pool.query(
                    `UPDATE shopify_privacy_inbox
                     SET status = $3::varchar(30),
                         payload = CASE WHEN $4::boolean THEN NULL ELSE payload END,
                         shop_domain = CASE WHEN $4::boolean THEN NULL ELSE shop_domain END,
                         result = $5::jsonb,
                         processed_at = NOW(),
                         completed_at = CASE WHEN $3::varchar(30) = 'SUCCESS' THEN NOW() ELSE NULL END,
                         lease_expires_at = NULL,
                         error_message = NULL
                     WHERE id = $1 AND status = 'PROCESSING' AND attempt_count = $2`,
                    [row.id, row.attempt_count, outcome.status, scrubPayload, JSON.stringify(outcome.result || {})],
                );
            } catch (error) {
                const permanent = Number(row.attempt_count) >= config.shopifyPrivacyMaxAttempts;
                const delaySeconds = Math.min(3600, 2 ** Math.min(12, Number(row.attempt_count)));
                await pool.query(
                    `UPDATE shopify_privacy_inbox
                     SET status = $3::varchar(30),
                         next_attempt_at = NOW() + ($4::int * INTERVAL '1 second'),
                         lease_expires_at = NULL,
                         processed_at = CASE WHEN $3::varchar(30) = 'FAILED_PERMANENT' THEN NOW() ELSE NULL END,
                         error_message = $5
                     WHERE id = $1 AND status = 'PROCESSING' AND attempt_count = $2`,
                    [
                        row.id,
                        row.attempt_count,
                        permanent ? 'FAILED_PERMANENT' : 'RETRYABLE_FAILED',
                        delaySeconds,
                        String(error.message).slice(0, 4000),
                    ],
                );
                console.error(`[ShopifyPrivacy] request ${row.id} ${permanent ? 'failed permanently' : 'deferred'}:`, error.message);
            }
            processed += 1;
        }
    } finally {
        drainingShopifyPrivacy = false;
    }
    return processed;
}

function shopifyPrivacyHandler(expectedTopic) {
    return asyncHandler(async (req, res) => {
        const shopDomain = requireMyshopifyDomain(req.headers['x-shopify-shop-domain']);
        const suppliedHmac = String(req.headers['x-shopify-hmac-sha256'] || '').trim();
        const topic = String(req.headers['x-shopify-topic'] || '').trim().toLowerCase();
        if (topic !== expectedTopic || !SHOPIFY_PRIVACY_TOPICS.has(topic)) {
            return res.status(400).send('Unexpected webhook topic');
        }
        const { secrets } = await shopifyWebhookSecrets(shopDomain);
        if (!suppliedHmac || secrets.length === 0
            || !validShopifyWebhookHmac(req.rawBody, suppliedHmac, secrets)) {
            return res.status(401).send('HMAC Failed');
        }
        let payload;
        try {
            payload = parseJsonPreservingLargeIntegers(req.rawBody.toString('utf8'));
        } catch (error) {
            return res.status(400).send('Invalid JSON payload');
        }
        const payloadDigest = crypto.createHash('sha256').update(req.rawBody).digest('hex');
        const suppliedWebhookId = String(req.headers['x-shopify-webhook-id'] || '').trim();
        const webhookId = (suppliedWebhookId || payloadDigest).slice(0, 255);
        const shopDomainHash = crypto.createHash('sha256').update(shopDomain).digest('hex');
        const insert = await pool.query(
            `INSERT INTO shopify_privacy_inbox
                (shop_domain, shop_domain_hash, webhook_id, topic, payload, payload_digest)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)
             ON CONFLICT (shop_domain_hash, webhook_id) DO NOTHING
             RETURNING id`,
            [shopDomain, shopDomainHash, webhookId, topic, JSON.stringify(payload || {}), payloadDigest],
        );
        res.status(200).json({ success: true, accepted: true, duplicate: insert.rowCount === 0 });
        setImmediate(() => backgroundScheduler.run(
            drainShopifyPrivacyInbox,
            'shopify-privacy-immediate-drain',
        ));
    });
}

app.post('/api/webhook/customers/data_request', shopifyPrivacyHandler('customers/data_request'));
app.post('/api/webhook/customers/redact', shopifyPrivacyHandler('customers/redact'));
app.post('/api/webhook/shop/redact', shopifyPrivacyHandler('shop/redact'));

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

    const secrets = [config.shopifyAppSecret, decryptTokenIfPossible(rows[0].app_secret)]
        .filter(Boolean);
    if (!validShopifyWebhookHmac(req.rawBody, hmacHeader, [...new Set(secrets)])) {
        return res.status(401).send('HMAC Failed');
    }

    let precisePayload;
    try {
        precisePayload = parseJsonPreservingLargeIntegers(req.rawBody.toString('utf8'));
    } catch (error) {
        return res.status(400).send('Invalid JSON payload');
    }

    const suppliedWebhookId = String(req.headers['x-shopify-webhook-id'] || '').trim();
    const webhookId = (suppliedWebhookId || crypto.createHash('sha256').update(req.rawBody).digest('hex')).slice(0, 255);
    const triggeredAt = Number.isFinite(Date.parse(triggeredAtHeader)) ? triggeredAtHeader : null;
    const suppliedApiVersion = String(req.headers['x-shopify-api-version'] || '').trim();
    const shopifyApiVersion = /^\d{4}-\d{2}$/.test(suppliedApiVersion) ? suppliedApiVersion : null;
    const insert = await pool.query(
        `INSERT INTO shopify_webhook_inbox
            (shop_id, webhook_id, topic, shopify_api_version, triggered_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (shop_id, webhook_id) DO NOTHING
         RETURNING id`,
        [
            rows[0].id,
            webhookId,
            webhookTopic,
            shopifyApiVersion,
            triggeredAt,
            JSON.stringify(precisePayload || {}),
        ],
    );
    res.status(200).json({ success: true, accepted: true, durable: true, duplicate: insert.rowCount === 0 });
    setImmediate(() => backgroundScheduler.run(
        drainShopifyWebhookInbox,
        'shopify-webhook-immediate-drain',
    ));
}

app.post('/api/webhook/purchase', asyncHandler(handleShopifyPurchaseWebhook));
app.post('/api/webhook/orders/paid', asyncHandler(handleShopifyPurchaseWebhook));

app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/readyz', asyncHandler(async (req, res) => {
    await pool.query('SELECT 1');
    let redisState = 'degraded';
    let workerState = config.requireWorkerHeartbeat ? 'missing' : 'not_required';
    if (redis.status === 'ready') {
        try {
            redisState = await withTimeout(redis.ping(), 1000, 'Redis readiness') === 'PONG'
                ? 'ready'
                : 'degraded';
            if (redisState === 'ready' && config.requireWorkerHeartbeat) {
                const heartbeat = Number(await withTimeout(
                    redis.get('health:capi-worker'),
                    1000,
                    'Worker heartbeat readiness',
                ));
                const maxAgeMs = config.workerHeartbeatTtlSeconds * 1000;
                workerState = Number.isFinite(heartbeat) && heartbeat > 0 && Date.now() - heartbeat <= maxAgeMs
                    ? 'ready'
                    : 'missing';
            }
        } catch (error) {
            redisState = 'degraded';
            workerState = config.requireWorkerHeartbeat ? 'missing' : 'not_required';
        }
    }
    const ready = redisState === 'ready' && ['ready', 'not_required'].includes(workerState);
    res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'degraded',
        postgres: 'ready',
        redis: redisState,
        worker: workerState,
        durable_ingestion: true,
        immediate_dispatch: ready,
    });
}));

scheduleCron(config.shopifyWebhookInboxCron, async () => {
    try {
        await drainShopifyWebhookInbox();
    } catch (error) {
        console.error('[ShopifyInbox] scheduled drain failed:', error);
    }
}, 'shopify-webhook-inbox');

scheduleCron(config.shopifyPrivacyCron, async () => {
    try {
        const processed = await drainShopifyPrivacyInbox();
        if (processed > 0) console.warn(`[ShopifyPrivacy] processed ${processed} compliance requests`);
    } catch (error) {
        console.error('[ShopifyPrivacy] scheduled drain failed:', error);
    }
}, 'shopify-privacy-inbox');

scheduleCron(config.shopifyReconcileCron, async () => {
    try {
        const reconciled = await reconcilePaidOrders();
        if (reconciled > 0) console.warn(`[ShopifyReconcile] queued ${reconciled} paid orders`);
    } catch (error) {
        console.error('[ShopifyReconcile] scheduled run failed:', error);
    }
}, 'shopify-paid-order-reconcile');

scheduleCron(config.shopifyWebhookAuditCron, async () => {
    const lockKey = 'lock:shopify_webhook_audit';
    const lockToken = crypto.randomUUID();
    let stopLockHeartbeat;
    try {
        const lock = await redis.set(lockKey, lockToken, 'EX', 30 * 60, 'NX');
        if (!lock) return;
        stopLockHeartbeat = startRedisLockHeartbeat(lockKey, lockToken, 30 * 60);
        const results = await auditPaidWebhookSubscriptions();
        const unhealthy = results.filter(item => !['HEALTHY', 'HEALTHY_WITH_ALTERNATES'].includes(item.status));
        if (unhealthy.length > 0) {
            console.warn(`[ShopifyWebhookAudit] ${unhealthy.length} shop(s) need ORDERS_PAID webhook attention`);
        }
    } catch (error) {
        console.error('[ShopifyWebhookAudit] scheduled run failed:', error);
    } finally {
        if (stopLockHeartbeat) await stopLockHeartbeat().catch(() => {});
        await releaseRedisLock(lockKey, lockToken).catch(() => {});
    }
}, 'shopify-webhook-audit');

scheduleCron(config.batchCron, async () => {
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
}, 'legacy-outbox-pack');

scheduleCron(config.watchdogCron, async () => {
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
}, 'legacy-redis-watchdog');

scheduleCron(config.watchdogCron, async () => {
    try {
        const reconciled = await reconcileEventAggregateStatuses();
        if (reconciled > 0) {
            console.warn(`[Watchdog] reconciled ${reconciled} event aggregate statuses from the delivery ledger`);
        }
    } catch (error) {
        console.error('Event aggregate reconciliation error:', error);
    }
}, 'event-aggregate-reconcile');

scheduleCron(config.watchdogCron, async () => {
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
}, 'stale-pending-rescue');

scheduleCron(config.metaQualityCron, async () => {
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
}, 'meta-quality-refresh');

scheduleCron(config.cleanupCron, async () => {
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
}, 'operational-data-cleanup');

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
        `SELECT shop.id, shop.shop_domain, shop.reporting_timezone, shop.status, shop.created_at,
                (shop.admin_access_token IS NOT NULL AND shop.admin_access_token <> '') AS has_admin_access_token,
                subscription.status AS paid_webhook_subscription_status,
                subscription.expected_uri AS paid_webhook_expected_uri,
                subscription.observed_uris AS paid_webhook_observed_uris,
                subscription.last_checked_at AS paid_webhook_last_checked_at,
                subscription.last_repaired_at AS paid_webhook_last_repaired_at,
                subscription.last_error AS paid_webhook_last_error,
                runtime.source_version AS pixel_source_version,
                runtime.schema_version AS pixel_schema_version,
                runtime.last_seen_at AS pixel_last_seen_at,
                runtime.last_diagnostic_at AS pixel_last_diagnostic_at,
                runtime.diagnostic_count AS pixel_diagnostic_count
         FROM shops shop
         LEFT JOIN shopify_webhook_subscription_state subscription ON subscription.shop_id = shop.id
         LEFT JOIN shopify_pixel_runtime_status runtime ON runtime.shop_id = shop.id
         ORDER BY shop.id DESC`,
    );
    res.json(rows.map(row => ({ ...row, ingest_token: shopIngestToken(row.shop_domain) })));
}));

app.post('/api/admin/shops', asyncHandler(async (req, res) => {
    const shopDomain = requireMyshopifyDomain(req.body.shop_domain);
    const appSecret = requireBoundedString(req.body.app_secret, 'app_secret', 2048);
    const adminAccessToken = optionalBoundedString(req.body.admin_access_token, 'admin_access_token', 10000);
    const reportingTimezone = req.body.reporting_timezone === undefined
        ? null
        : requireIanaTimezone(req.body.reporting_timezone);

    await pool.query(
        `INSERT INTO shops (shop_domain, app_secret, admin_access_token, reporting_timezone)
         VALUES ($1, $2, $3, COALESCE($4, 'UTC'))
         ON CONFLICT (shop_domain) DO UPDATE
         SET app_secret = EXCLUDED.app_secret,
             admin_access_token = COALESCE(EXCLUDED.admin_access_token, shops.admin_access_token),
             reporting_timezone = COALESCE($4, shops.reporting_timezone),
             status = 'active'`,
        [shopDomain, encryptToken(appSecret), adminAccessToken ? encryptToken(adminAccessToken) : null, reportingTimezone],
    );
    res.status(201).json({ success: true });
}));

app.patch('/api/admin/shops/:id/reporting-timezone', asyncHandler(async (req, res) => {
    const shopId = readPositiveId(req.params.id, 'shop_id');
    const reportingTimezone = requireIanaTimezone(req.body?.reporting_timezone);
    const { rows } = await pool.query(
        `UPDATE shops
         SET reporting_timezone = $2
         WHERE id = $1 AND status = 'active'
         RETURNING id, shop_domain, reporting_timezone`,
        [shopId, reportingTimezone],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Shop not found' });
    return res.json({ success: true, shop: rows[0] });
}));

app.post('/api/admin/shops/:id/audit-paid-webhook', asyncHandler(async (req, res) => {
    const shopId = readPositiveId(req.params.id, 'shop_id');
    const { rows } = await pool.query(
        `SELECT id, shop_domain, admin_access_token
         FROM shops
         WHERE id = $1 AND status = 'active'`,
        [shopId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Shop not found' });
    const state = await auditPaidWebhookSubscriptionForShop(rows[0]);
    return res.json({ success: true, shop_id: shopId, ...state });
}));

app.post('/api/admin/shops/:id/ensure-paid-webhook', asyncHandler(async (req, res) => {
    const shopId = readPositiveId(req.params.id, 'shop_id');
    const { rows } = await pool.query(
        `SELECT id, shop_domain, admin_access_token
         FROM shops
         WHERE id = $1 AND status = 'active'`,
        [shopId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Shop not found' });
    if (!rows[0].admin_access_token) {
        return res.status(409).json({ error: 'Shopify Admin API token is required to repair the ORDERS_PAID webhook' });
    }
    const client = await pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [`capi-saas-pro:paid-webhook-repair:${shopId}`]);
        const state = await auditPaidWebhookSubscriptionForShop(rows[0], { repair: true });
        return res.json({ success: true, shop_id: shopId, ...state });
    } finally {
        await client.query(
            'SELECT pg_advisory_unlock(hashtext($1))',
            [`capi-saas-pro:paid-webhook-repair:${shopId}`],
        ).catch(() => {});
        client.release();
    }
}));

app.delete('/api/admin/shops/:id', asyncHandler(async (req, res) => {
    const shopId = readPositiveId(req.params.id, 'shop_id');
    const { deleted } = await deleteShopDataById(shopId);
    if (!deleted) return res.status(404).json({ error: 'Shop not found' });
    res.json({ success: true });
}));

app.get('/api/admin/pixels', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`
        SELECT p.id, p.shop_id, owner.shop_domain, p.platform, p.name, p.pixel_id, p.test_event_code,
               p.credential_version,
               p.rate_limit_group,
               p.rate_limit_until, p.last_usage_pct, p.consecutive_failures, p.last_delivery_at,
               (p.quality_access_token IS NOT NULL AND p.quality_access_token <> '') AS has_quality_token,
               COALESCE(
                   jsonb_agg(
                       jsonb_build_object(
                           'route_id', r.id,
                           'shop_id', s.id,
                           'shop_domain', s.shop_domain,
                           'test_event_code', CASE
                               WHEN r.test_event_code_expires_at > NOW() THEN r.test_event_code
                               ELSE NULL
                           END,
                           'test_event_code_expires_at', r.test_event_code_expires_at,
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
        WHERE p.status = 'active'
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
    if (platform === 'facebook' && !config.allowSharedFacebookDatasetRoutes && shopIds.length > 1) {
        return res.status(409).json({
            error: 'A Meta Dataset can be bound to only one shop. Create a separate Dataset for each Shopify shop.',
            code: 'SHARED_FACEBOOK_DATASET_BLOCKED',
        });
    }

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
            `SELECT id, access_token, rate_limit_group, credential_version
             FROM pixels
             WHERE platform = $1 AND pixel_id = $2
             ORDER BY (status = 'active') DESC, id ASC
             LIMIT 1
             FOR UPDATE`,
            [platform, pixelId],
        );
        let credentialId;
        let reused = false;
        let credentialMaterialChanged = false;
        let tokenChanged = false;
        let recoveredCredentialFailures = 0;
        if (existing.rowCount > 0) {
            credentialId = existing.rows[0].id;
            reused = true;
            const effectiveRateLimitGroup = rateLimitGroup || existing.rows[0].rate_limit_group || null;
            const previousToken = decryptTokenIfPossible(existing.rows[0].access_token);
            tokenChanged = previousToken !== accessToken;
            credentialMaterialChanged = tokenChanged
                || String(existing.rows[0].rate_limit_group || '').trim().toLowerCase()
                    !== String(effectiveRateLimitGroup || '').trim().toLowerCase();
            await client.query(
                `UPDATE pixels
                 SET shop_id = COALESCE(shop_id, $2),
                     name = $3,
                     access_token = $4,
                     quality_access_token = COALESCE($5, quality_access_token),
                     test_event_code = NULL,
                     credential_scope = $6,
                     rate_limit_group = $7,
                     credential_version = credential_version + CASE WHEN $8::boolean THEN 1 ELSE 0 END,
                     consecutive_failures = CASE WHEN $8::boolean THEN 0 ELSE consecutive_failures END,
                     rate_limit_until = CASE WHEN $8::boolean THEN NULL ELSE rate_limit_until END,
                     last_rate_limit_at = CASE WHEN $8::boolean THEN NULL ELSE last_rate_limit_at END,
                     last_usage_pct = CASE WHEN $8::boolean THEN NULL ELSE last_usage_pct END,
                     status = 'active',
                     archived_at = NULL
                 WHERE id = $1`,
                [
                    credentialId,
                    shopId,
                    name,
                    encryptToken(accessToken),
                    qualityAccessToken ? encryptToken(qualityAccessToken) : null,
                    credentialFingerprint(platform, accessToken, effectiveRateLimitGroup),
                    effectiveRateLimitGroup,
                    credentialMaterialChanged,
                ],
            );
        } else {
            const inserted = await client.query(
                `INSERT INTO pixels
                    (shop_id, platform, name, pixel_id, access_token, quality_access_token, credential_scope, rate_limit_group)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING id`,
                [
                    shopId,
                    platform,
                    name,
                    pixelId,
                    encryptToken(accessToken),
                    qualityAccessToken ? encryptToken(qualityAccessToken) : null,
                    credentialFingerprint(platform, accessToken, rateLimitGroup),
                    rateLimitGroup,
                ],
            );
            credentialId = inserted.rows[0].id;
        }
        if (platform === 'facebook' && !config.allowSharedFacebookDatasetRoutes) {
            const activeRouteShops = await client.query(
                `SELECT shop_id
                 FROM shop_pixel_routes
                 WHERE pixel_id = $1 AND status = 'active'
                 FOR UPDATE`,
                [credentialId],
            );
            const effectiveShopIds = new Set([
                ...activeRouteShops.rows.map(row => Number(row.shop_id)),
                ...shopIds,
            ]);
            if (effectiveShopIds.size > 1) {
                const conflict = new Error('This Meta Dataset is already active for another shop. Use a separate Dataset ID and token.');
                conflict.statusCode = 409;
                conflict.code = 'SHARED_FACEBOOK_DATASET_BLOCKED';
                throw conflict;
            }
        }
        for (const routedShopId of [...shopIds].sort((left, right) => left - right)) {
            await client.query(
                'SELECT pg_advisory_xact_lock(hashtext($1))',
                [`delivery-routes:${routedShopId}`],
            );
        }
        await client.query(
            `INSERT INTO shop_pixel_routes (
                 shop_id, pixel_id, test_event_code, test_event_code_expires_at
             )
             SELECT shop_id,
                    $2,
                    $3::varchar(100),
                    CASE
                        WHEN $3::varchar(100) IS NOT NULL
                            THEN NOW() + ($4::int * INTERVAL '1 minute')
                        ELSE NULL
                    END
             FROM UNNEST($1::int[]) AS requested(shop_id)
             ON CONFLICT (shop_id, pixel_id) DO UPDATE
             SET status = 'active',
                 test_event_code = EXCLUDED.test_event_code,
                 test_event_code_expires_at = EXCLUDED.test_event_code_expires_at`,
            [shopIds, credentialId, testEventCode || null, config.testEventCodeTtlMinutes],
        );
        if (tokenChanged) {
            const reopened = await client.query(
                `UPDATE event_deliveries delivery
                 SET status = 'PENDING',
                     attempt_count = 0,
                     next_attempt_at = NOW(),
                     lease_expires_at = NULL,
                     error_code = NULL,
                     error_message = NULL,
                     updated_at = NOW()
                 FROM shop_pixel_routes route
                 WHERE delivery.route_id = route.id
                   AND route.pixel_id = $1
                   AND route.status = 'active'
                   AND delivery.status = 'FAILED_PERMANENT'
                   AND delivery.error_code = ANY($2::text[])
                 RETURNING delivery.event_store_id`,
                [credentialId, RECOVERABLE_META_CREDENTIAL_CODES],
            );
            recoveredCredentialFailures = reopened.rowCount;
            const reopenedEventIds = [...new Set(
                reopened.rows.map(row => String(row.event_store_id)),
            )];
            if (reopenedEventIds.length > 0) {
                await client.query(
                    `UPDATE event_store
                     SET status = 'PENDING'
                     WHERE id = ANY($1::bigint[])
                       AND status IN ('FAILED', 'PARTIAL_FAILED')`,
                    [reopenedEventIds],
                );
            }
        }
        const activeRoutes = await client.query(
            `SELECT DISTINCT shop.id, shop.shop_domain
             FROM shop_pixel_routes route
             JOIN shops shop ON shop.id = route.shop_id
             WHERE route.pixel_id = $1
               AND route.status = 'active'
               AND shop.status = 'active'`,
            [credentialId],
        );
        await client.query('COMMIT');
        const affectedShopIds = activeRoutes.rows.map(row => Number(row.id));
        invalidatePixelConfigCache(activeRoutes.rows.map(row => row.shop_domain));
        await wakeShopOutboxes(affectedShopIds);
        res.status(reused ? 200 : 201).json({
            success: true,
            id: credentialId,
            reused,
            credential_updated: credentialMaterialChanged,
            recovered_credential_failures: recoveredCredentialFailures,
            shop_ids: shopIds,
        });
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
        const pixelResult = await client.query(
            "SELECT id, platform FROM pixels WHERE id = $1 AND status = 'active' FOR UPDATE",
            [pixelId],
        );
        if (pixelResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Pixel not found' });
        }
        if (pixelResult.rows[0].platform === 'facebook'
            && !config.allowSharedFacebookDatasetRoutes
            && shopIds.length > 1) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                error: 'A Meta Dataset can be bound to only one shop. Create a separate Dataset for each Shopify shop.',
                code: 'SHARED_FACEBOOK_DATASET_BLOCKED',
            });
        }
        const routeShopResult = await client.query(
            `SELECT route.shop_id, shop.shop_domain
             FROM shop_pixel_routes route
             JOIN shops shop ON shop.id = route.shop_id
             WHERE route.pixel_id = $1`,
            [pixelId],
        );
        const lockedShopIds = [...new Set([
            ...shopIds,
            ...routeShopResult.rows.map(row => Number(row.shop_id)),
        ])].sort((left, right) => left - right);
        for (const routedShopId of lockedShopIds) {
            await client.query(
                'SELECT pg_advisory_xact_lock(hashtext($1))',
                [`delivery-routes:${routedShopId}`],
            );
        }
        const shopsResult = await client.query(
            "SELECT id, shop_domain FROM shops WHERE id = ANY($1::int[]) AND status = 'active'",
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
             SET status = 'inactive',
                  test_event_code = NULL,
                  test_event_code_expires_at = NULL
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
                `WITH snapshot_events AS (
                     SELECT id, delivery_route_snapshot,
                            CARDINALITY(delivery_route_snapshot) AS expected
                     FROM event_store
                     WHERE id = ANY($1::bigint[])
                 ),
                 delivery_summary AS (
                     SELECT snapshot_event.id AS event_store_id,
                            snapshot_event.expected,
                            COUNT(delivery.id) AS total,
                            COUNT(delivery.id) FILTER (WHERE delivery.status = 'SUCCESS') AS succeeded,
                            COUNT(delivery.id) FILTER (WHERE delivery.status = 'FAILED_PERMANENT') AS permanent_failed,
                            COUNT(*) FILTER (
                                WHERE delivery.status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')
                            ) AS outstanding
                     FROM snapshot_events snapshot_event
                     LEFT JOIN LATERAL UNNEST(snapshot_event.delivery_route_snapshot)
                         AS snapshot(route_id) ON TRUE
                     LEFT JOIN event_deliveries delivery
                       ON delivery.event_store_id = snapshot_event.id
                      AND delivery.route_id = snapshot.route_id
                     GROUP BY snapshot_event.id, snapshot_event.expected
                 )
                 UPDATE event_store event
                 SET status = CASE
                     WHEN summary.expected IS NULL OR summary.expected = 0
                          OR summary.total < summary.expected THEN 'PENDING'
                     WHEN summary.succeeded = summary.expected THEN 'SUCCESS'
                     WHEN summary.outstanding > 0 THEN 'PENDING'
                     WHEN summary.succeeded > 0 AND summary.permanent_failed > 0 THEN 'PARTIAL_FAILED'
                     WHEN summary.permanent_failed = summary.expected THEN 'FAILED'
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
        invalidatePixelConfigCache([
            ...routeShopResult.rows.map(row => row.shop_domain),
            ...shopsResult.rows.map(row => row.shop_domain),
        ]);
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
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const pixelResult = await client.query(
            "SELECT id FROM pixels WHERE id = $1 AND status = 'active' FOR UPDATE",
            [pixelId],
        );
        if (pixelResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Pixel route not found' });
        }
        const routeShopResult = await client.query(
            `SELECT route.shop_id, shop.shop_domain
             FROM shop_pixel_routes route
             JOIN shops shop ON shop.id = route.shop_id
             WHERE route.pixel_id = $1
             ORDER BY route.shop_id`,
            [pixelId],
        );
        for (const row of routeShopResult.rows) {
            await client.query(
                'SELECT pg_advisory_xact_lock(hashtext($1))',
                [`delivery-routes:${row.shop_id}`],
            );
        }
        const terminated = await client.query(
            `UPDATE event_deliveries delivery
             SET status = 'FAILED_PERMANENT',
                 lease_expires_at = NULL,
                 error_code = 'ROUTE_ARCHIVED',
                 error_message = 'Pixel credential was archived before delivery completed',
                 updated_at = NOW()
             FROM shop_pixel_routes route
             WHERE delivery.route_id = route.id
               AND route.pixel_id = $1
               AND delivery.status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')
             RETURNING delivery.event_store_id`,
            [pixelId],
        );
        await client.query(
            `UPDATE shop_pixel_routes
             SET status = 'inactive',
                 test_event_code = NULL,
                 test_event_code_expires_at = NULL
             WHERE pixel_id = $1
               AND status <> 'inactive'`,
            [pixelId],
        );
        await client.query(
            `UPDATE pixels
             SET status = 'archived',
                 archived_at = NOW(),
                 access_token = '',
                 quality_access_token = NULL,
                 test_event_code = NULL,
                 credential_scope = NULL,
                 rate_limit_group = NULL,
                 rate_limit_until = NULL
             WHERE id = $1`,
            [pixelId],
        );
        const affectedEventIds = [...new Set(
            terminated.rows.map(row => String(row.event_store_id)),
        )];
        if (affectedEventIds.length > 0) {
            await client.query(
                `WITH snapshot_events AS (
                     SELECT id, delivery_route_snapshot,
                            CARDINALITY(delivery_route_snapshot) AS expected
                     FROM event_store
                     WHERE id = ANY($1::bigint[])
                 ),
                 delivery_summary AS (
                     SELECT snapshot_event.id AS event_store_id,
                            snapshot_event.expected,
                            COUNT(delivery.id) AS total,
                            COUNT(delivery.id) FILTER (WHERE delivery.status = 'SUCCESS') AS succeeded,
                            COUNT(delivery.id) FILTER (WHERE delivery.status = 'FAILED_PERMANENT') AS permanent_failed,
                            COUNT(*) FILTER (
                                WHERE delivery.status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')
                            ) AS outstanding
                     FROM snapshot_events snapshot_event
                     LEFT JOIN LATERAL UNNEST(snapshot_event.delivery_route_snapshot)
                         AS snapshot(route_id) ON TRUE
                     LEFT JOIN event_deliveries delivery
                       ON delivery.event_store_id = snapshot_event.id
                      AND delivery.route_id = snapshot.route_id
                     GROUP BY snapshot_event.id, snapshot_event.expected
                 )
                 UPDATE event_store event
                 SET status = CASE
                     WHEN summary.expected IS NULL OR summary.expected = 0
                          OR summary.total < summary.expected THEN 'PENDING'
                     WHEN summary.succeeded = summary.expected THEN 'SUCCESS'
                     WHEN summary.outstanding > 0 THEN 'PENDING'
                     WHEN summary.succeeded > 0 AND summary.permanent_failed > 0 THEN 'PARTIAL_FAILED'
                     WHEN summary.permanent_failed = summary.expected THEN 'FAILED'
                     ELSE event.status
                 END
                 FROM delivery_summary summary
                 WHERE event.id = summary.event_store_id`,
                [affectedEventIds],
            );
        }
        await client.query('COMMIT');
        invalidatePixelConfigCache(routeShopResult.rows.map(row => row.shop_domain));
        res.json({ success: true, archived: true, affected_events: affectedEventIds.length });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}));

app.get('/api/admin/logs', asyncHandler(async (req, res) => {
    const shopId = readOptionalShopId(req);
    const params = shopId ? [shopId] : [];
    const shopFilter = shopId ? 'WHERE e.shop_id = $1' : '';
    const { rows } = await pool.query(`
        SELECT e.id, s.shop_domain, e.event_name, e.event_id, e.status, e.emq_estimate,
               e.delivery_route_snapshot,
               e.request_payload->'_quality' AS quality,
               e.request_payload->'_source' AS source,
               e.request_payload->'custom_data' AS custom_data,
               e.fb_response, e.timestamp,
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
                    'accepted_event', CASE
                        WHEN ed.platform_response->>'accepted_event' IN ('true', 'false')
                            THEN (ed.platform_response->>'accepted_event')::boolean
                        ELSE ed.status = 'SUCCESS'
                    END,
                    'fbtrace_id', COALESCE(
                        ed.platform_response->>'fbtrace_id',
                        ed.platform_response #>> '{results,0,fbtrace_id}'
                    ),
                    'platform_response', ed.platform_response,
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

app.get('/api/admin/privacy', asyncHandler(async (req, res) => {
    const shopId = readOptionalShopId(req);
    const params = shopId ? [shopId] : [];
    const { rows } = await pool.query(
        `SELECT inbox.id,
                inbox.shop_domain,
                inbox.topic,
                inbox.status,
                inbox.attempt_count,
                inbox.error_message,
                inbox.created_at,
                inbox.processed_at,
                inbox.completed_at,
                CASE
                    WHEN inbox.status = 'ACTION_REQUIRED'
                    THEN COALESCE((inbox.result->>'stored_event_count')::int, 0)
                    ELSE NULL
                END AS stored_event_count
         FROM shopify_privacy_inbox inbox
         LEFT JOIN shops shop ON shop.shop_domain = inbox.shop_domain
         ${shopId ? 'WHERE shop.id = $1' : ''}
         ORDER BY
             CASE inbox.status
                 WHEN 'ACTION_REQUIRED' THEN 0
                 WHEN 'FAILED_PERMANENT' THEN 1
                 WHEN 'RETRYABLE_FAILED' THEN 2
                 WHEN 'PROCESSING' THEN 3
                 WHEN 'PENDING' THEN 4
                 ELSE 5
             END,
             inbox.id DESC
         LIMIT 100`,
        params,
    );
    res.set('Cache-Control', 'private, no-store');
    res.json(rows);
}));

app.get('/api/admin/privacy/:id/report', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid privacy request ID' });
    const { rows } = await pool.query(
        `SELECT id, topic, status, created_at, processed_at, result
         FROM shopify_privacy_inbox
         WHERE id = $1`,
        [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Privacy request not found' });
    if (rows[0].status !== 'ACTION_REQUIRED') {
        return res.status(409).json({ error: 'This privacy request has no pending customer data report' });
    }
    res.set('Cache-Control', 'private, no-store');
    return res.json(rows[0]);
}));

app.get('/api/admin/privacy/:id/events', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const afterId = Number(req.query.after_id || 0);
    const limit = Number(req.query.limit || PRIVACY_REPORT_PAGE_SIZE);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid privacy request ID' });
    if (!Number.isInteger(afterId) || afterId < 0) return res.status(400).json({ error: 'after_id must be a non-negative integer' });
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return res.status(400).json({ error: 'limit must be an integer from 1 to 1000' });
    }
    const { rows } = await pool.query(
        `SELECT inbox.status, inbox.payload, shop.id AS shop_id, shop.shop_domain
         FROM shopify_privacy_inbox inbox
         JOIN shops shop ON shop.shop_domain = inbox.shop_domain
         WHERE inbox.id = $1`,
        [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Privacy request not found' });
    if (rows[0].status !== 'ACTION_REQUIRED' || !rows[0].payload) {
        return res.status(409).json({ error: 'This privacy request has no retained customer data report' });
    }
    const page = await loadPrivacyEventPage(
        { id: rows[0].shop_id, shop_domain: rows[0].shop_domain },
        rows[0].payload,
        { afterId, limit },
    );
    res.set('Cache-Control', 'private, no-store');
    return res.json({
        privacy_request_id: id,
        shop_domain: rows[0].shop_domain,
        after_id: afterId,
        limit,
        ...page,
    });
}));

app.post('/api/admin/privacy/:id/complete', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid privacy request ID' });
    if (req.body?.confirm !== 'COMPLETE_DATA_REQUEST') {
        return res.status(400).json({ error: 'confirm must equal COMPLETE_DATA_REQUEST' });
    }
    const { rowCount } = await pool.query(
        `UPDATE shopify_privacy_inbox
         SET status = 'SUCCESS',
             payload = NULL,
             result = NULL,
             shop_domain = NULL,
             completed_at = NOW(),
             processed_at = COALESCE(processed_at, NOW()),
             lease_expires_at = NULL,
             error_message = NULL
         WHERE id = $1 AND status = 'ACTION_REQUIRED'`,
        [id],
    );
    if (rowCount === 0) return res.status(409).json({ error: 'Privacy request is not awaiting completion' });
    return res.json({ success: true, id, scrubbed: true });
}));

app.post('/api/admin/privacy/:id/retry', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid privacy request ID' });
    const { rowCount } = await pool.query(
        `UPDATE shopify_privacy_inbox
         SET status = 'PENDING',
             attempt_count = 0,
             next_attempt_at = NOW(),
             lease_expires_at = NULL,
             processed_at = NULL,
             error_message = NULL
         WHERE id = $1 AND status = 'FAILED_PERMANENT'`,
        [id],
    );
    if (rowCount === 0) return res.status(409).json({ error: 'Privacy request is not permanently failed' });
    setImmediate(() => backgroundScheduler.run(
        drainShopifyPrivacyInbox,
        'shopify-privacy-manual-retry',
    ));
    return res.json({ success: true, id, queued: true });
}));

app.get('/api/admin/summary', asyncHandler(async (req, res) => {
    const shopId = readOptionalShopId(req);
    const params = shopId ? [shopId] : [];
    const funnelParams = shopId ? [shopId, FUNNEL_EVENT_NAMES] : [FUNNEL_EVENT_NAMES];
    const funnelNamesParam = shopId ? '$2' : '$1';
    const storeTodayParams = shopId ? [shopId, FUNNEL_EVENT_NAMES] : [FUNNEL_EVENT_NAMES];
    const storeTodayNamesParam = shopId ? '$2' : '$1';
    const orderReconciliationParams = shopId
        ? [shopId, config.shopifyWebOrderSources]
        : [config.shopifyWebOrderSources];
    const shopifyVersionParams = shopId
        ? [config.shopifyApiVersion, shopId]
        : [config.shopifyApiVersion];
    const allowedOrderSourcesParam = shopId ? '$2' : '$1';
    const eventShopFilter = shopId ? ' AND shop_id = $1' : '';
    const shopFilter = shopId ? ' AND id = $1' : '';
    const dlqShopFilter = shopId ? ' AND shop_id = $1' : '';
    const occurredInLast24Hours = `
        CASE
            WHEN COALESCE(request_payload->>'event_time', '') ~ '^\\d+$'
                THEN (request_payload->>'event_time')::bigint
            ELSE EXTRACT(EPOCH FROM timestamp)::bigint
        END >= EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours')::bigint`;
    const [
        statusResult,
        emqResult,
        signalResult,
        funnelResult,
        metaReceiptReconciliationResult,
        storeTodayFunnelResult,
        storeTodayWebhookResult,
        sharedFacebookResult,
        shopifyApiVersionResult,
        orderReconciliationResult,
        officialQualityResult,
        dlqResult,
        shopsResult,
        pixelsResult,
        testModeResult,
        integrityResult,
        backlogResult,
        privacyResult,
        storageResult,
        queueCounts,
    ] = await Promise.all([
        pool.query(`
            SELECT status, COUNT(*)::int AS count
            FROM event_store
            WHERE ${occurredInLast24Hours}${eventShopFilter}
            GROUP BY status
        `, params),
        pool.query(`
            SELECT COUNT(*)::int AS total_events,
                   ROUND(AVG(emq_estimate)::numeric, 2) AS avg_emq
            FROM event_store
            WHERE ${occurredInLast24Hours}${eventShopFilter}
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
            WHERE ${occurredInLast24Hours}${eventShopFilter}
        `, params),
        pool.query(`
            WITH recent_funnel AS (
                SELECT event_name, event_id, status, emq_estimate, request_payload
                FROM event_store
                WHERE ${occurredInLast24Hours}
                  AND event_name = ANY(${funnelNamesParam}::text[])${eventShopFilter}
            ), event_stats AS (
                SELECT event_name,
                       COUNT(*)::int AS total_events,
                       COUNT(DISTINCT event_id)::int AS unique_events,
                       COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS successful_events,
                       COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_events,
                       COUNT(*) FILTER (WHERE status = 'AWAITING_PAYMENT')::int AS awaiting_payment_events,
                       COUNT(*) FILTER (WHERE status IN ('FAILED', 'PARTIAL_FAILED'))::int AS failed_events,
                       COUNT(*) FILTER (
                           WHERE COALESCE(
                               jsonb_array_length(request_payload->'_quality'->'missing_event_parameters'),
                               0
                           ) > 0
                       )::int AS missing_parameter_events,
                       COUNT(*) FILTER (
                           WHERE COALESCE(
                               jsonb_array_length(request_payload->'_quality'->'local_validation_errors'),
                               0
                           ) > 0
                       )::int AS locally_invalid_events,
                       ROUND(AVG(emq_estimate)::numeric, 2) AS avg_emq
                FROM recent_funnel
                GROUP BY event_name
            ), currency_totals AS (
                SELECT event_name,
                       UPPER(request_payload->'custom_data'->>'currency') AS currency,
                       ROUND(SUM((request_payload->'custom_data'->>'value')::numeric), 2) AS total_value
                FROM recent_funnel
                WHERE jsonb_typeof(request_payload->'custom_data'->'value') = 'number'
                  AND UPPER(COALESCE(request_payload->'custom_data'->>'currency', '')) ~ '^[A-Z]{3}$'
                GROUP BY event_name, UPPER(request_payload->'custom_data'->>'currency')
            ), currency_breakdowns AS (
                SELECT event_name, jsonb_object_agg(currency, total_value) AS value_by_currency
                FROM currency_totals
                GROUP BY event_name
            )
            SELECT event_stats.*,
                   COALESCE(currency_breakdowns.value_by_currency, '{}'::jsonb) AS value_by_currency
            FROM event_stats
            LEFT JOIN currency_breakdowns USING (event_name)
        `, funnelParams),
        pool.query(`
            SELECT event.shop_id,
                   shop.shop_domain,
                   event.event_name,
                   pixel.pixel_id,
                   pixel.name AS pixel_name,
                   COUNT(*)::int AS expected_deliveries,
                   COUNT(*) FILTER (WHERE delivery.status = 'SUCCESS')::int AS receipt_acknowledged,
                   COUNT(*) FILTER (
                       WHERE delivery.status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')
                   )::int AS pending_deliveries,
                   COUNT(*) FILTER (WHERE delivery.id IS NULL)::int AS missing_delivery_ledger,
                   COUNT(*) FILTER (WHERE delivery.status = 'FAILED_PERMANENT')::int AS failed_deliveries,
                   COUNT(*) FILTER (
                       WHERE delivery.status = 'FAILED_PERMANENT'
                         AND delivery.error_code = 'LOCAL_VALIDATION'
                   )::int AS locally_invalid_deliveries,
                   GREATEST(
                       0,
                       COUNT(*) - COUNT(*) FILTER (WHERE delivery.status = 'SUCCESS')
                   )::int AS receipt_gap,
                   ROUND(
                       100.0 * COUNT(*) FILTER (WHERE delivery.status = 'SUCCESS')
                       / NULLIF(COUNT(*), 0),
                       1
                   ) AS receipt_rate
            FROM event_store event
            JOIN shops shop ON shop.id = event.shop_id
            JOIN LATERAL UNNEST(event.delivery_route_snapshot)
                AS expected_route(route_id) ON TRUE
            JOIN shop_pixel_routes route ON route.id = expected_route.route_id
            JOIN pixels pixel ON pixel.id = route.pixel_id
            LEFT JOIN event_deliveries delivery
              ON delivery.event_store_id = event.id
             AND delivery.route_id = expected_route.route_id
            WHERE ${occurredInLast24Hours}
              AND event.event_name = ANY(${funnelNamesParam}::text[])
              AND pixel.platform = 'facebook'
              ${shopId ? 'AND event.shop_id = $1' : ''}
            GROUP BY event.shop_id, shop.shop_domain, event.event_name,
                     pixel.pixel_id, pixel.name
            ORDER BY shop.shop_domain, pixel.pixel_id,
                     ARRAY_POSITION(${funnelNamesParam}::text[], event.event_name)
        `, funnelParams),
        pool.query(`
            WITH scoped_shops AS (
                SELECT id, shop_domain, reporting_timezone,
                       date_trunc('day', NOW() AT TIME ZONE reporting_timezone)
                           AT TIME ZONE reporting_timezone AS day_start_utc,
                       (date_trunc('day', NOW() AT TIME ZONE reporting_timezone) + INTERVAL '1 day')
                           AT TIME ZONE reporting_timezone AS day_end_utc
                FROM shops
                WHERE status = 'active'${shopId ? ' AND id = $1' : ''}
            )
            SELECT shop.id AS shop_id,
                   shop.shop_domain,
                   shop.reporting_timezone,
                   shop.day_start_utc,
                   shop.day_end_utc,
                   event.event_name,
                   COUNT(event.id)::int AS total_events,
                   COUNT(DISTINCT event.event_id)::int AS unique_events,
                   COUNT(event.id) FILTER (WHERE event.status = 'SUCCESS')::int AS successful_events,
                   COUNT(event.id) FILTER (WHERE event.status = 'PENDING')::int AS pending_events,
                   COUNT(event.id) FILTER (WHERE event.status = 'AWAITING_PAYMENT')::int AS awaiting_payment_events,
                   COUNT(event.id) FILTER (WHERE event.status IN ('FAILED', 'PARTIAL_FAILED'))::int AS failed_events,
                   ROUND(AVG(event.emq_estimate)::numeric, 2) AS avg_emq
            FROM scoped_shops shop
            LEFT JOIN event_store event
              ON event.shop_id = shop.id
             AND event.event_name = ANY(${storeTodayNamesParam}::text[])
             AND COALESCE(
                    CASE
                        WHEN COALESCE(event.request_payload->>'event_time', '') ~ '^\\d+$'
                            THEN to_timestamp((event.request_payload->>'event_time')::double precision)
                    END,
                    event.timestamp AT TIME ZONE 'UTC'
                 ) >= shop.day_start_utc
             AND COALESCE(
                    CASE
                        WHEN COALESCE(event.request_payload->>'event_time', '') ~ '^\\d+$'
                            THEN to_timestamp((event.request_payload->>'event_time')::double precision)
                    END,
                    event.timestamp AT TIME ZONE 'UTC'
                 ) < shop.day_end_utc
            GROUP BY shop.id, shop.shop_domain, shop.reporting_timezone,
                     shop.day_start_utc, shop.day_end_utc, event.event_name
            ORDER BY shop.id, event.event_name
        `, storeTodayParams),
        pool.query(`
            WITH scoped_shops AS (
                SELECT id, reporting_timezone,
                       date_trunc('day', NOW() AT TIME ZONE reporting_timezone)
                           AT TIME ZONE reporting_timezone AS day_start_utc,
                       (date_trunc('day', NOW() AT TIME ZONE reporting_timezone) + INTERVAL '1 day')
                           AT TIME ZONE reporting_timezone AS day_end_utc
                FROM shops
                WHERE status = 'active'${shopId ? ' AND id = $1' : ''}
            )
            SELECT shop.id AS shop_id,
                   COUNT(inbox.id)::int AS paid_webhooks,
                   COUNT(inbox.id) FILTER (WHERE inbox.status = 'SUCCESS')::int AS successful_paid_webhooks,
                   COUNT(inbox.id) FILTER (
                       WHERE inbox.status IN ('PENDING', 'RETRYABLE_FAILED', 'PROCESSING')
                   )::int AS outstanding_paid_webhooks,
                   COUNT(inbox.id) FILTER (WHERE inbox.status = 'FAILED_PERMANENT')::int AS permanently_failed_paid_webhooks
            FROM scoped_shops shop
            LEFT JOIN shopify_webhook_inbox inbox
              ON inbox.shop_id = shop.id
             AND inbox.topic = 'orders/paid'
             AND COALESCE(inbox.triggered_at, inbox.created_at) >= shop.day_start_utc
             AND COALESCE(inbox.triggered_at, inbox.created_at) < shop.day_end_utc
            GROUP BY shop.id
            ORDER BY shop.id
        `, shopId ? [shopId] : []),
        pool.query(`
            SELECT pixel.id, pixel.name, pixel.pixel_id,
                   COUNT(DISTINCT route.shop_id)::int AS shop_count,
                   ARRAY_AGG(DISTINCT shop.shop_domain ORDER BY shop.shop_domain) AS shop_domains
            FROM pixels pixel
            JOIN shop_pixel_routes route
              ON route.pixel_id = pixel.id AND route.status = 'active'
            JOIN shops shop
              ON shop.id = route.shop_id AND shop.status = 'active'
            WHERE pixel.platform = 'facebook'
              AND pixel.status = 'active'
            GROUP BY pixel.id, pixel.name, pixel.pixel_id
            HAVING COUNT(DISTINCT route.shop_id) > 1
               ${shopId ? 'AND BOOL_OR(route.shop_id = $1)' : ''}
            ORDER BY shop_count DESC, pixel.id
        `, shopId ? [shopId] : []),
        pool.query(`
            SELECT COALESCE(shopify_api_version, 'unknown') AS version,
                   COUNT(*)::int AS deliveries,
                   COUNT(*) FILTER (
                       WHERE shopify_api_version IS NOT NULL
                         AND shopify_api_version <> $1
                   )::int AS mismatched
            FROM shopify_webhook_inbox
            WHERE created_at >= NOW() - INTERVAL '7 days'
              ${shopId ? 'AND shop_id = $2' : ''}
            GROUP BY COALESCE(shopify_api_version, 'unknown')
            ORDER BY deliveries DESC, version
        `, shopifyVersionParams),
        pool.query(`
            WITH paid_order_observations AS (
                SELECT shop_id,
                       webhook_id,
                       COALESCE(
                           NULLIF(payload->>'checkout_token', ''),
                           NULLIF(payload->>'cart_token', ''),
                           NULLIF(payload->>'token', ''),
                           NULLIF(payload->>'id', ''),
                           NULLIF(payload->>'name', ''),
                           webhook_id
                       ) AS order_identity,
                       LOWER(COALESCE(payload->>'source_name', payload->>'sourceName', '')) AS source_name,
                       COALESCE((payload->>'test')::boolean, false) AS is_test,
                       status
                FROM shopify_webhook_inbox
                WHERE topic = 'orders/paid'
                  AND COALESCE(triggered_at, created_at) >= NOW() - INTERVAL '24 hours'
                  ${shopId ? 'AND shop_id = $1' : ''}
            ), paid_orders AS (
                SELECT shop_id,
                       order_identity,
                       BOOL_OR(is_test) AS is_test,
                       BOOL_OR(source_name = ANY(${allowedOrderSourcesParam}::text[])) AS is_allowed_source,
                       BOOL_OR(source_name = '') AS has_missing_source,
                       BOOL_OR(status = 'FAILED_PERMANENT') AS has_permanent_failure,
                       BOOL_OR(status = 'SUCCESS') AS processed_successfully
                FROM paid_order_observations
                GROUP BY shop_id, order_identity
            ), purchase_ledger AS (
                SELECT event.shop_id,
                       event.request_payload #>> '{_source,order_identity}' AS order_identity,
                       BOOL_OR(delivery.status = 'SUCCESS') FILTER (
                           WHERE pixel.platform = 'facebook'
                       ) AS meta_delivered,
                       BOOL_OR(delivery.status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')) FILTER (
                           WHERE pixel.platform = 'facebook'
                       ) AS meta_pending,
                       BOOL_OR(delivery.status = 'FAILED_PERMANENT') FILTER (
                           WHERE pixel.platform = 'facebook'
                       ) AS meta_failed,
                       BOOL_OR(
                           pixel.platform = 'facebook'
                           AND delivery.status = 'FAILED_PERMANENT'
                           AND delivery.error_code = 'LOCAL_VALIDATION'
                       ) AS locally_invalid
                FROM event_store event
                LEFT JOIN event_deliveries delivery ON delivery.event_store_id = event.id
                LEFT JOIN shop_pixel_routes route ON route.id = delivery.route_id
                LEFT JOIN pixels pixel ON pixel.id = route.pixel_id
                WHERE event.event_name = 'Purchase'
                  AND event.request_payload #>> '{_source,order_identity}' IS NOT NULL
                  AND ${occurredInLast24Hours}
                  ${shopId ? 'AND event.shop_id = $1' : ''}
                GROUP BY event.shop_id, event.request_payload #>> '{_source,order_identity}'
            )
            SELECT COUNT(*)::int AS observed_paid_orders,
                   COUNT(*) FILTER (WHERE NOT is_test AND is_allowed_source)::int AS eligible_web_paid_orders,
                   COUNT(*) FILTER (WHERE NOT is_test AND is_allowed_source AND processed_successfully)::int AS inbox_processed_orders,
                   COUNT(*) FILTER (WHERE NOT is_test AND is_allowed_source AND ledger.order_identity IS NOT NULL)::int AS purchase_ledger_orders,
                   COUNT(*) FILTER (WHERE NOT is_test AND is_allowed_source AND COALESCE(ledger.meta_delivered, false))::int AS meta_delivered_orders,
                   COUNT(*) FILTER (WHERE NOT is_test AND is_allowed_source AND COALESCE(ledger.meta_pending, false) AND NOT COALESCE(ledger.meta_delivered, false))::int AS meta_pending_orders,
                   COUNT(*) FILTER (WHERE NOT is_test AND is_allowed_source AND COALESCE(ledger.meta_failed, false) AND NOT COALESCE(ledger.meta_delivered, false))::int AS meta_failed_orders,
                   COUNT(*) FILTER (WHERE NOT is_test AND is_allowed_source AND COALESCE(ledger.locally_invalid, false))::int AS locally_invalid_orders,
                   COUNT(*) FILTER (WHERE NOT is_test AND is_allowed_source AND ledger.order_identity IS NULL)::int AS unledgered_eligible_orders,
                   COUNT(*) FILTER (WHERE is_test)::int AS ignored_test_orders,
                   COUNT(*) FILTER (WHERE NOT is_test AND NOT is_allowed_source AND NOT has_missing_source)::int AS ignored_non_web_orders,
                   COUNT(*) FILTER (WHERE NOT is_test AND NOT is_allowed_source AND has_missing_source)::int AS missing_source_orders,
                   COUNT(*) FILTER (WHERE has_permanent_failure AND NOT processed_successfully)::int AS permanently_failed_orders
            FROM paid_orders
            LEFT JOIN purchase_ledger ledger
              ON ledger.shop_id = paid_orders.shop_id
             AND ledger.order_identity = paid_orders.order_identity
        `, orderReconciliationParams),
        pool.query(`
            SELECT DISTINCT ON (m.pixel_route_id, m.shop_id)
                   m.pixel_route_id,
                   m.shop_id,
                   s.shop_domain,
                   p.name,
                   p.pixel_id,
                   m.fetched_at,
                   CASE
                       WHEN m.status = 'SUCCESS'
                        AND COALESCE(jsonb_array_length(m.summary_payload->'events'), 0) = 0
                       THEN 'EMPTY'
                       ELSE m.status
                   END AS status,
                   m.metric_type,
                   m.summary_payload,
                   CASE
                       WHEN m.status = 'SUCCESS'
                        AND COALESCE(jsonb_array_length(m.summary_payload->'events'), 0) = 0
                       THEN COALESCE(
                           m.error_message,
                           'Meta Dataset Quality returned no event-level metrics; use local signal coverage while permissions and data availability are verified'
                       )
                       ELSE m.error_message
                   END AS error_message
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
        pool.query(
            `SELECT
                 COUNT(*) FILTER (
                     WHERE r.test_event_code IS NOT NULL
                       AND r.test_event_code_expires_at > NOW()
                 )::int AS active_routes,
                 COUNT(*) FILTER (
                     WHERE r.test_event_code IS NOT NULL
                       AND (r.test_event_code_expires_at IS NULL OR r.test_event_code_expires_at <= NOW())
                 )::int AS expired_routes
             FROM shop_pixel_routes r
             WHERE r.status = 'active'
             ${shopId ? 'AND r.shop_id = $1' : ''}`,
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
        pool.query(
            `SELECT
                 COUNT(*) FILTER (WHERE inbox.status = 'ACTION_REQUIRED')::int AS action_required,
                 COUNT(*) FILTER (WHERE inbox.status = 'FAILED_PERMANENT')::int AS permanent_failed,
                 COUNT(*) FILTER (
                     WHERE inbox.status IN ('PENDING', 'RETRYABLE_FAILED', 'PROCESSING')
                 )::int AS outstanding,
                 COALESCE(EXTRACT(EPOCH FROM (
                     NOW() - MIN(inbox.created_at) FILTER (
                         WHERE inbox.status IN ('ACTION_REQUIRED', 'FAILED_PERMANENT')
                     )
                 ))::bigint, 0) AS oldest_attention_seconds
             FROM shopify_privacy_inbox inbox
             LEFT JOIN shops shop ON shop.shop_domain = inbox.shop_domain
             ${shopId ? 'WHERE shop.id = $1' : ''}`,
            params,
        ),
        pool.query(
            `SELECT
                 pg_database_size(current_database())::bigint AS database_bytes,
                 (
                     pg_total_relation_size('event_store'::regclass)
                     + pg_total_relation_size('event_deliveries'::regclass)
                     + pg_total_relation_size('event_id_aliases'::regclass)
                 )::bigint AS event_ledger_bytes,
                 (
                     pg_total_relation_size('shopify_webhook_inbox'::regclass)
                     + pg_total_relation_size('shopify_privacy_inbox'::regclass)
                 )::bigint AS webhook_inbox_bytes`,
        ),
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

    const storeTodayWebhooks = new Map(
        storeTodayWebhookResult.rows.map(row => [Number(row.shop_id), row]),
    );
    const storeTodayByShop = new Map();
    for (const row of storeTodayFunnelResult.rows) {
        const shopKey = Number(row.shop_id);
        if (!storeTodayByShop.has(shopKey)) {
            storeTodayByShop.set(shopKey, {
                shop_id: shopKey,
                shop_domain: row.shop_domain,
                reporting_timezone: row.reporting_timezone,
                day_start_utc: row.day_start_utc,
                day_end_utc: row.day_end_utc,
                event_rows: [],
            });
        }
        if (row.event_name) storeTodayByShop.get(shopKey).event_rows.push(row);
    }
    const storeToday = [...storeTodayByShop.values()].map(shop => {
        const webhook = storeTodayWebhooks.get(shop.shop_id) || {};
        return {
            shop_id: shop.shop_id,
            shop_domain: shop.shop_domain,
            reporting_timezone: shop.reporting_timezone,
            day_start_utc: shop.day_start_utc,
            day_end_utc: shop.day_end_utc,
            funnel_events: decorateFunnelSummary(shop.event_rows),
            paid_webhooks: Number(webhook.paid_webhooks || 0),
            successful_paid_webhooks: Number(webhook.successful_paid_webhooks || 0),
            outstanding_paid_webhooks: Number(webhook.outstanding_paid_webhooks || 0),
            permanently_failed_paid_webhooks: Number(webhook.permanently_failed_paid_webhooks || 0),
        };
    });

    res.json({
        last24h: {
            total_events: emqResult.rows[0]?.total_events || 0,
            avg_emq: emqResult.rows[0]?.avg_emq || null,
            by_status: statusResult.rows,
            emq_signals: emqSignals,
            funnel_events: decorateFunnelSummary(funnelResult.rows),
            meta_receipt_reconciliation: metaReceiptReconciliationResult.rows.map(row => ({
                ...row,
                expected_deliveries: Number(row.expected_deliveries || 0),
                receipt_acknowledged: Number(row.receipt_acknowledged || 0),
                pending_deliveries: Number(row.pending_deliveries || 0),
                missing_delivery_ledger: Number(row.missing_delivery_ledger || 0),
                failed_deliveries: Number(row.failed_deliveries || 0),
                locally_invalid_deliveries: Number(row.locally_invalid_deliveries || 0),
                receipt_gap: Number(row.receipt_gap || 0),
                receipt_rate: row.receipt_rate === null ? null : Number(row.receipt_rate),
            })),
            shopify_paid_orders: orderReconciliationResult.rows[0] || {},
        },
        store_today: {
            definition: 'Calendar day in each shop reporting_timezone using event occurrence time',
            generated_at_utc: new Date().toISOString(),
            shops: storeToday,
        },
        routing_health: {
            shared_facebook_datasets: sharedFacebookResult.rowCount,
            shared_facebook_details: sharedFacebookResult.rows,
            shared_facebook_routes_allowed: config.allowSharedFacebookDatasetRoutes,
            test_mode: {
                ttl_minutes: config.testEventCodeTtlMinutes,
                active_routes: Number(testModeResult.rows[0]?.active_routes || 0),
                expired_routes: Number(testModeResult.rows[0]?.expired_routes || 0),
            },
        },
        shopify_api_health: {
            configured_version: config.shopifyApiVersion,
            observation_window_days: 7,
            observed_versions: shopifyApiVersionResult.rows,
            mismatched_deliveries: shopifyApiVersionResult.rows.reduce(
                (sum, row) => sum + Number(row.mismatched || 0),
                0,
            ),
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
        privacy_health: privacyResult.rows[0] || {},
        storage_health: storageResult.rows[0] || {},
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

app.get('/api/admin/browser-diagnostics', asyncHandler(async (req, res) => {
    const shopId = readOptionalShopId(req);
    const params = shopId ? [shopId] : [];
    const filter = shopId ? 'WHERE diagnostic.shop_id = $1' : '';
    const { rows } = await pool.query(
        `SELECT diagnostic.id, diagnostic.shop_id, shop.shop_domain, diagnostic.code,
                diagnostic.dropped_count, diagnostic.event_counts,
                diagnostic.source_version, diagnostic.schema_version,
                diagnostic.client_first_at, diagnostic.client_last_at, diagnostic.created_at
         FROM browser_delivery_diagnostics diagnostic
         JOIN shops shop ON shop.id = diagnostic.shop_id
         ${filter}
         ORDER BY diagnostic.id DESC
         LIMIT 200`,
        params,
    );
    return res.json(rows);
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
            error: 'Database permission denied. The DATABASE_URL user must own the project tables and sequences. Run sudo bash scripts/repair-db-ownership.sh from the project directory, then npm run migrate and npm run doctor.',
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

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down API server`);
    // stopAndDrain() stops future invocations synchronously, then lets any
    // already-running maintenance transaction finish before its dependencies
    // are closed.
    const scheduledDrain = backgroundScheduler.stopAndDrain();
    const forceTimer = setTimeout(() => {
        console.error('API shutdown deadline exceeded; closing remaining sockets');
        server.closeAllConnections?.();
        process.exit(1);
    }, config.shutdownTimeoutMs);
    forceTimer.unref?.();
    server.closeIdleConnections?.();
    server.close(async () => {
        try {
            await scheduledDrain;
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
