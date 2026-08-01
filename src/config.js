require('dotenv').config();

const path = require('path');

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

function readJsonLimit() {
    const raw = String(process.env.JSON_LIMIT || '1mb').trim().toLowerCase();
    const match = raw.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/);
    if (!match) throw new Error('JSON_LIMIT must be a byte size such as 512kb or 1mb');
    const multiplier = { b: 1, kb: 1024, mb: 1024 * 1024 }[match[2] || 'b'];
    const bytes = Number(match[1]) * multiplier;
    if (!Number.isFinite(bytes) || bytes < 1024 || bytes > 16 * 1024 * 1024) {
        throw new Error('JSON_LIMIT must be between 1kb and 16mb');
    }
    return raw;
}

function readFacebookApiVersion() {
    const value = String(process.env.FB_API_VERSION || 'v26.0').trim();
    if (!/^v\d+\.\d+$/.test(value)) {
        throw new Error('FB_API_VERSION must look like v26.0');
    }
    return value;
}

function readFacebookGraphBaseUrl(isProduction) {
    const raw = String(process.env.FB_GRAPH_BASE_URL || 'https://graph.facebook.com').trim();
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (error) {
        throw new Error('FB_GRAPH_BASE_URL must be a valid URL');
    }
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
    const officialProductionEndpoint = parsed.protocol === 'https:'
        && parsed.hostname === 'graph.facebook.com'
        && (!parsed.port || parsed.port === '443');
    if (parsed.username || parsed.password || parsed.search || parsed.hash
        || (isProduction && !officialProductionEndpoint)
        || (!isProduction && parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))) {
        throw new Error('FB_GRAPH_BASE_URL must use the official HTTPS endpoint in production; tests may use HTTP loopback');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
}

function readShopifyApiVersion() {
    const value = String(process.env.SHOPIFY_API_VERSION || '2026-07').trim();
    if (!/^\d{4}-(01|04|07|10)$/.test(value)) {
        throw new Error('SHOPIFY_API_VERSION must look like 2026-07');
    }
    return value;
}

function readOptionalPublicBaseUrl() {
    const raw = String(process.env.PUBLIC_BASE_URL || '').trim();
    if (!raw) return '';
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (error) {
        throw new Error('PUBLIC_BASE_URL must be a valid URL');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('PUBLIC_BASE_URL must be a credential-free HTTPS URL');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
}

const aesSecretKey = readRequired('AES_SECRET_KEY');
if (aesSecretKey.length < 32) {
    throw new Error('AES_SECRET_KEY must be at least 32 characters');
}

const production = process.env.NODE_ENV === 'production';
const configuredIngestTokenSecret = String(process.env.INGEST_TOKEN_SECRET || '').trim();
if (production && !configuredIngestTokenSecret) {
    throw new Error('INGEST_TOKEN_SECRET must be set separately from AES_SECRET_KEY in production');
}
const ingestTokenSecret = configuredIngestTokenSecret || aesSecretKey;
if (ingestTokenSecret.length < 32) {
    throw new Error('INGEST_TOKEN_SECRET must be at least 32 characters');
}
if (production && ingestTokenSecret === aesSecretKey) {
    throw new Error('INGEST_TOKEN_SECRET must differ from AES_SECRET_KEY in production');
}
const ingestTokenPreviousSecret = String(process.env.INGEST_TOKEN_PREVIOUS_SECRET || '').trim();
if (ingestTokenPreviousSecret && ingestTokenPreviousSecret.length < 32) {
    throw new Error('INGEST_TOKEN_PREVIOUS_SECRET must be empty or at least 32 characters');
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

const adminUsername = readRequired('ADMIN_USERNAME');
const adminPassword = readRequired('ADMIN_PASSWORD');
const requireIngestToken = readBool('REQUIRE_INGEST_TOKEN', true);
if (production && adminPassword.length < 16) {
    throw new Error('ADMIN_PASSWORD must be at least 16 characters in production');
}
if (production && adminPassword === adminUsername) {
    throw new Error('ADMIN_PASSWORD must differ from ADMIN_USERNAME in production');
}
if (production && !requireIngestToken) {
    throw new Error('REQUIRE_INGEST_TOKEN must remain enabled in production');
}

module.exports = {
    port: readBoundedInt('PORT', 3000, 65535),
    databaseUrl: readRequired('DATABASE_URL'),
    redisUrl: readRequired('REDIS_URL'),
    aesSecretKey,
    ingestTokenSecret,
    ingestTokenPreviousSecret,
    maintenanceFile: process.env.MAINTENANCE_FILE || path.join(process.cwd(), '.maintenance'),
    adminUsername,
    adminPassword,
    requireIngestToken,
    publicBaseUrl: readOptionalPublicBaseUrl(),
    allowSharedFacebookDatasetRoutes: readBool('ALLOW_SHARED_FACEBOOK_DATASET_ROUTES', true),
    testEventCodeTtlMinutes: readBoundedInt('TEST_EVENT_CODE_TTL_MINUTES', 30, 24 * 60),
    shopifyWebOrderSources: readCsv('SHOPIFY_WEB_ORDER_SOURCES', 'web'),
    shopifyAppSecret: String(process.env.SHOPIFY_APP_SECRET || '').trim(),
    shopifyApiVersion: readShopifyApiVersion(),
    shopifyReconcileCron: process.env.SHOPIFY_RECONCILE_CRON || '23 */15 * * * *',
    shopifyWebhookAuditCron: process.env.SHOPIFY_WEBHOOK_AUDIT_CRON || '41 7 * * * *',
    shopifyReconcileLookbackHours: readBoundedInt('SHOPIFY_RECONCILE_LOOKBACK_HOURS', 144, 24 * 30),
    shopifyReconcileMaxOrders: readBoundedInt('SHOPIFY_RECONCILE_MAX_ORDERS', 1000, 10000),
    shopifyReconcileMaxLineItemPages: readBoundedInt('SHOPIFY_RECONCILE_MAX_LINE_ITEM_PAGES', 100, 1000),
    fbApiVersion: readFacebookApiVersion(),
    facebookGraphBaseUrl: readFacebookGraphBaseUrl(production),
    corsOrigin: readCorsOrigin(),
    jsonLimit: readJsonLimit(),
    commerceItemLimit: readBoundedInt('COMMERCE_ITEM_LIMIT', 1000, 5000),
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
    // The browser token identifies a shop configuration but is intentionally
    // public. Keep a generous abuse ceiling enabled unless an upstream WAF
    // already enforces a stricter distributed policy.
    pixelRateLimitPerMinute: readNonNegativeInt('PIXEL_RATE_LIMIT_PER_MINUTE', 600),
    adminRateLimitPerWindow: readInt('ADMIN_RATE_LIMIT_PER_WINDOW', 100),
    batchCron: process.env.BATCH_CRON || '*/5 * * * * *',
    watchdogCron: process.env.WATCHDOG_CRON || '* * * * *',
    shopifyWebhookInboxCron: process.env.SHOPIFY_WEBHOOK_INBOX_CRON || '*/5 * * * * *',
    shopifyWebhookInboxBatchSize: readBoundedInt('SHOPIFY_WEBHOOK_INBOX_BATCH_SIZE', 200, 1000),
    shopifyWebhookInboxMaxAttempts: readBoundedInt('SHOPIFY_WEBHOOK_INBOX_MAX_ATTEMPTS', 20, 100),
    shopifyWebhookInboxLeaseSeconds: readBoundedInt('SHOPIFY_WEBHOOK_INBOX_LEASE_SECONDS', 60, 600),
    shopifyWebhookProcessTimeoutMs: readBoundedInt('SHOPIFY_WEBHOOK_PROCESS_TIMEOUT_MS', 45000, 590000),
    shopifyPrivacyCron: process.env.SHOPIFY_PRIVACY_CRON || '11 */1 * * * *',
    shopifyPrivacyBatchSize: readBoundedInt('SHOPIFY_PRIVACY_BATCH_SIZE', 50, 500),
    shopifyPrivacyMaxAttempts: readBoundedInt('SHOPIFY_PRIVACY_MAX_ATTEMPTS', 20, 100),
    shopifyPrivacyLeaseSeconds: readBoundedInt('SHOPIFY_PRIVACY_LEASE_SECONDS', 120, 900),
    shopifyPrivacyRetentionDays: readBoundedInt('SHOPIFY_PRIVACY_RETENTION_DAYS', 30, 365),
    metaQualityCron: process.env.META_QUALITY_CRON || '0 */6 * * *',
    fbRequestTimeoutMs: readInt('FB_REQUEST_TIMEOUT_MS', 15000),
    facebookBatchSize: readBoundedInt('FACEBOOK_BATCH_SIZE', 100, 1000),
    workerConcurrency: readBoundedInt('WORKER_CONCURRENCY', 20, 200),
    requireWorkerHeartbeat: readBool('REQUIRE_WORKER_HEARTBEAT', production),
    workerHeartbeatTtlSeconds: readBoundedInt('WORKER_HEARTBEAT_TTL_SECONDS', 45, 300),
    workerRateLimitMax: readInt('WORKER_RATE_LIMIT_MAX', 100),
    workerRateLimitDurationMs: readInt('WORKER_RATE_LIMIT_DURATION_MS', 1000),
    platformRequestsPerSecondPerCredential: readBoundedInt('PLATFORM_REQUESTS_PER_SECOND_PER_CREDENTIAL', 20, 100),
    deliveryRetryBaseSeconds: readInt('DELIVERY_RETRY_BASE_SECONDS', 5),
    deliveryRetryMaxSeconds: readInt('DELIVERY_RETRY_MAX_SECONDS', 900),
    deliveryRetryAfterMaxSeconds: readInt('DELIVERY_RETRY_AFTER_MAX_SECONDS', 86400),
    // 0 retries transient platform failures until the event itself expires.
    // A positive value is an operator-selected early-abandonment policy.
    deliveryMaxAttempts: readNonNegativeInt('DELIVERY_MAX_ATTEMPTS', 0),
    credentialLeaseMs: readInt('CREDENTIAL_LEASE_MS', 60000),
    credentialBusyDelaySeconds: readInt('CREDENTIAL_BUSY_DELAY_SECONDS', 2),
    shopContinuationDelayMs: readInt('SHOP_CONTINUATION_DELAY_MS', 500),
    facebookIsolationMaxRequests: readInt('FACEBOOK_ISOLATION_MAX_REQUESTS', 16),
    tiktokMaxEventAgeSeconds: readInt('TIKTOK_MAX_EVENT_AGE_SECONDS', 7 * 24 * 60 * 60),
    deliveryRescueMinutes: readInt('DELIVERY_RESCUE_MINUTES', 1),
    deliveryRescueShopLimit: readBoundedInt('DELIVERY_RESCUE_SHOP_LIMIT', 500, 5000),
    aggregateReconcileBatchSize: readBoundedInt('AGGREGATE_RECONCILE_BATCH_SIZE', 5000, 50000),
    purchaseSettleMs: readInt('PURCHASE_SETTLE_MS', 8000),
    cleanupCron: process.env.CLEANUP_CRON || '17 * * * *',
    cleanupBatchSize: readBoundedInt('CLEANUP_BATCH_SIZE', 10000, 50000),
    cleanupMaxBatches: readBoundedInt('CLEANUP_MAX_BATCHES', 2, 20),
    eventRetentionDays: readInt('EVENT_RETENTION_DAYS', 90),
    deadLetterRetentionDays: readInt('DEAD_LETTER_RETENTION_DAYS', 90),
    browserDiagnosticRetentionDays: readInt('BROWSER_DIAGNOSTIC_RETENTION_DAYS', 30),
    aliasRetentionDays: readInt('ALIAS_RETENTION_DAYS', 120),
    qualityRetentionDays: readInt('QUALITY_RETENTION_DAYS', 30),
};
