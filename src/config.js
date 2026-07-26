require('dotenv').config();

function readRequired(name) {
    const value = process.env[name];
    if (!value || !String(value).trim()) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function readInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid positive integer environment variable: ${name}`);
    }
    return value;
}

function readNonNegativeInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid non-negative integer environment variable: ${name}`);
    }
    return value;
}

function readBoundedInt(name, fallback, maximum) {
    const value = readInt(name, fallback);
    if (value > maximum) {
        throw new Error(`${name} must not exceed ${maximum}`);
    }
    return value;
}

function readBool(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    if (['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase())) return true;
    if (['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase())) return false;
    throw new Error(`Invalid boolean environment variable: ${name}`);
}

function readCorsOrigin() {
    const raw = process.env.CORS_ORIGIN;
    if (!raw || raw.trim() === '*') return true;
    const origins = raw.split(',').map(origin => origin.trim()).filter(Boolean);
    for (const origin of origins) {
        let parsed;
        try {
            parsed = new URL(origin);
        } catch (error) {
            throw new Error(`Invalid CORS_ORIGIN entry: ${origin}`);
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
            throw new Error(`CORS_ORIGIN entries must be exact http(s) origins: ${origin}`);
        }
    }
    return origins;
}

function readCsv(name, fallback) {
    const values = String(process.env[name] || fallback)
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);
    if (values.length === 0) throw new Error(`${name} must contain at least one value`);
    return [...new Set(values)];
}

const aesSecretKey = readRequired('AES_SECRET_KEY');
if (aesSecretKey.length < 32) {
    throw new Error('AES_SECRET_KEY must be at least 32 characters');
}

const httpRequestTimeoutMs = readInt('HTTP_REQUEST_TIMEOUT_MS', 30000);
const httpHeadersTimeoutMs = readInt('HTTP_HEADERS_TIMEOUT_MS', 15000);
const httpKeepAliveTimeoutMs = readInt('HTTP_KEEP_ALIVE_TIMEOUT_MS', 5000);
const shutdownTimeoutMs = readInt('SHUTDOWN_TIMEOUT_MS', 120000);
if (httpHeadersTimeoutMs <= httpKeepAliveTimeoutMs) {
    throw new Error('HTTP_HEADERS_TIMEOUT_MS must exceed HTTP_KEEP_ALIVE_TIMEOUT_MS');
}
if (httpRequestTimeoutMs < httpHeadersTimeoutMs) {
    throw new Error('HTTP_REQUEST_TIMEOUT_MS must be at least HTTP_HEADERS_TIMEOUT_MS');
}
if (shutdownTimeoutMs <= httpRequestTimeoutMs) {
    throw new Error('SHUTDOWN_TIMEOUT_MS must exceed HTTP_REQUEST_TIMEOUT_MS');
}

module.exports = {
    port: readInt('PORT', 3000),
    databaseUrl: readRequired('DATABASE_URL'),
    redisUrl: readRequired('REDIS_URL'),
    aesSecretKey,
    adminUsername: readRequired('ADMIN_USERNAME'),
    adminPassword: readRequired('ADMIN_PASSWORD'),
    requireIngestToken: readBool('REQUIRE_INGEST_TOKEN', true),
    shopifyWebOrderSources: readCsv('SHOPIFY_WEB_ORDER_SOURCES', 'web'),
    fbApiVersion: process.env.FB_API_VERSION || 'v25.0',
    corsOrigin: readCorsOrigin(),
    jsonLimit: process.env.JSON_LIMIT || '1mb',
    trustProxy: readNonNegativeInt('TRUST_PROXY_HOPS', 1),
    httpRequestTimeoutMs,
    httpHeadersTimeoutMs,
    httpKeepAliveTimeoutMs,
    shutdownTimeoutMs,
    dbPoolMax: readBoundedInt('DB_POOL_MAX', 20, 200),
    dbIdleTimeoutMs: readInt('DB_IDLE_TIMEOUT_MS', 30000),
    dbConnectionTimeoutMs: readInt('DB_CONNECTION_TIMEOUT_MS', 10000),
    dbStatementTimeoutMs: readInt('DB_STATEMENT_TIMEOUT_MS', 30000),
    dbPoolMaxUses: readInt('DB_POOL_MAX_USES', 7500),
    batchSize: readBoundedInt('BATCH_SIZE', 1000, 5000),
    // Only enable temporarily when upgrading an installation that still has
    // pre-outbox Redis list entries to drain.
    legacyRedisDrainEnabled: readBool('LEGACY_REDIS_DRAIN_ENABLED', false),
    workerEventBatchSize: readBoundedInt('WORKER_EVENT_BATCH_SIZE', 100, 1000),
    queueAttempts: readBoundedInt('QUEUE_ATTEMPTS', 5, 100),
    queueBackoffMs: readInt('QUEUE_BACKOFF_MS', 5000),
    // Authenticated ingestion is loss-sensitive. Disabled by default so a
    // legitimate traffic spike is buffered instead of being answered with 429.
    pixelRateLimitPerMinute: readNonNegativeInt('PIXEL_RATE_LIMIT_PER_MINUTE', 0),
    adminRateLimitPerWindow: readInt('ADMIN_RATE_LIMIT_PER_WINDOW', 100),
    batchCron: process.env.BATCH_CRON || '*/5 * * * * *',
    watchdogCron: process.env.WATCHDOG_CRON || '* * * * *',
    metaQualityCron: process.env.META_QUALITY_CRON || '0 */6 * * *',
    fbRequestTimeoutMs: readInt('FB_REQUEST_TIMEOUT_MS', 15000),
    facebookBatchSize: readBoundedInt('FACEBOOK_BATCH_SIZE', 100, 1000),
    workerConcurrency: readBoundedInt('WORKER_CONCURRENCY', 20, 200),
    workerRateLimitMax: readInt('WORKER_RATE_LIMIT_MAX', 100),
    workerRateLimitDurationMs: readInt('WORKER_RATE_LIMIT_DURATION_MS', 1000),
    deliveryRetryBaseSeconds: readInt('DELIVERY_RETRY_BASE_SECONDS', 5),
    deliveryRetryMaxSeconds: readInt('DELIVERY_RETRY_MAX_SECONDS', 900),
    deliveryRetryAfterMaxSeconds: readInt('DELIVERY_RETRY_AFTER_MAX_SECONDS', 86400),
    // 0 retries transient platform failures until the event itself expires.
    // A positive value is an operator-selected early-abandonment policy.
    deliveryMaxAttempts: readNonNegativeInt('DELIVERY_MAX_ATTEMPTS', 0),
    credentialLeaseMs: readInt('CREDENTIAL_LEASE_MS', 60000),
    credentialBusyDelaySeconds: readInt('CREDENTIAL_BUSY_DELAY_SECONDS', 2),
    facebookIsolationMaxRequests: readInt('FACEBOOK_ISOLATION_MAX_REQUESTS', 16),
    deliveryRescueMinutes: readInt('DELIVERY_RESCUE_MINUTES', 1),
    deliveryRescueShopLimit: readBoundedInt('DELIVERY_RESCUE_SHOP_LIMIT', 500, 5000),
    aggregateReconcileBatchSize: readBoundedInt('AGGREGATE_RECONCILE_BATCH_SIZE', 5000, 50000),
    purchaseSettleMs: readInt('PURCHASE_SETTLE_MS', 8000),
    cleanupCron: process.env.CLEANUP_CRON || '17 * * * *',
    cleanupBatchSize: readBoundedInt('CLEANUP_BATCH_SIZE', 10000, 50000),
    cleanupMaxBatches: readBoundedInt('CLEANUP_MAX_BATCHES', 2, 20),
    eventRetentionDays: readInt('EVENT_RETENTION_DAYS', 90),
    deadLetterRetentionDays: readInt('DEAD_LETTER_RETENTION_DAYS', 90),
    aliasRetentionDays: readInt('ALIAS_RETENTION_DAYS', 120),
    qualityRetentionDays: readInt('QUALITY_RETENTION_DAYS', 30),
};
