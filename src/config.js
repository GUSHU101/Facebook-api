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

function readCorsOrigin() {
    const raw = process.env.CORS_ORIGIN;
    if (!raw || raw.trim() === '*') return true;
    return raw.split(',').map(origin => origin.trim()).filter(Boolean);
}

module.exports = {
    port: readInt('PORT', 3000),
    databaseUrl: readRequired('DATABASE_URL'),
    redisUrl: readRequired('REDIS_URL'),
    aesSecretKey: readRequired('AES_SECRET_KEY'),
    adminUsername: readRequired('ADMIN_USERNAME'),
    adminPassword: readRequired('ADMIN_PASSWORD'),
    fbApiVersion: process.env.FB_API_VERSION || 'v24.0',
    corsOrigin: readCorsOrigin(),
    jsonLimit: process.env.JSON_LIMIT || '1mb',
    trustProxy: readInt('TRUST_PROXY_HOPS', 1),
    batchSize: readInt('BATCH_SIZE', 1000),
    queueAttempts: readInt('QUEUE_ATTEMPTS', 5),
    queueBackoffMs: readInt('QUEUE_BACKOFF_MS', 5000),
    pixelRateLimitPerMinute: readInt('PIXEL_RATE_LIMIT_PER_MINUTE', 200),
    adminRateLimitPerWindow: readInt('ADMIN_RATE_LIMIT_PER_WINDOW', 100),
    batchCron: process.env.BATCH_CRON || '*/5 * * * * *',
    watchdogCron: process.env.WATCHDOG_CRON || '* * * * *',
    fbRequestTimeoutMs: readInt('FB_REQUEST_TIMEOUT_MS', 15000),
    workerConcurrency: readInt('WORKER_CONCURRENCY', 20),
    workerRateLimitMax: readInt('WORKER_RATE_LIMIT_MAX', 100),
    workerRateLimitDurationMs: readInt('WORKER_RATE_LIMIT_DURATION_MS', 1000),
    purchaseSettleMs: readInt('PURCHASE_SETTLE_MS', 8000),
    stalePendingMinutes: readInt('STALE_PENDING_MINUTES', 10),
};
