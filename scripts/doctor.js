require('dotenv').config();

const { Pool } = require('pg');
const Redis = require('ioredis');
const config = require('../src/config');

const checks = [];

async function check(name, fn) {
    try {
        const detail = await fn();
        checks.push({ name, ok: true, detail });
    } catch (error) {
        checks.push({ name, ok: false, detail: error.message });
    }
}

async function main() {
    const pool = new Pool({ connectionString: config.databaseUrl });
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
    redis.on('error', () => {});

    await check('environment', async () => {
        const required = [
            'DATABASE_URL',
            'REDIS_URL',
            'AES_SECRET_KEY',
            'ADMIN_USERNAME',
            'ADMIN_PASSWORD',
        ];
        const missing = required.filter(name => !process.env[name]);
        if (missing.length) throw new Error(`Missing ${missing.join(', ')}`);
        if (String(process.env.AES_SECRET_KEY).length < 32) {
            throw new Error('AES_SECRET_KEY should be at least 32 characters');
        }
        return 'required variables present';
    });

    await check('postgres connection', async () => {
        await pool.query('SELECT 1');
        return 'connected';
    });

    await check('postgres schema', async () => {
        const requiredColumns = [
            ['shops', 'shop_domain'],
            ['shops', 'app_secret'],
            ['pixels', 'platform'],
            ['pixels', 'access_token'],
            ['event_store', 'request_payload'],
            ['event_store', 'fb_response'],
            ['dead_letters', 'status'],
        ];

        for (const [table, column] of requiredColumns) {
            const { rowCount } = await pool.query(
                `SELECT 1
                 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = $1
                   AND column_name = $2`,
                [table, column],
            );
            if (rowCount === 0) throw new Error(`Missing column ${table}.${column}`);
        }

        const secretType = await pool.query(
            `SELECT data_type
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'shops'
               AND column_name = 'app_secret'`,
        );
        if (secretType.rows[0]?.data_type !== 'text') {
            throw new Error('shops.app_secret should be TEXT; run npm run migrate');
        }
        return 'required columns present';
    });

    await check('redis connection', async () => {
        const pong = await redis.ping();
        if (pong !== 'PONG') throw new Error(`Unexpected ping response: ${pong}`);
        return 'connected';
    });

    await check('queue config', async () => {
        if (config.workerConcurrency < 1) throw new Error('WORKER_CONCURRENCY must be positive');
        if (config.batchSize < 1) throw new Error('BATCH_SIZE must be positive');
        if (config.stalePendingMinutes < 1) throw new Error('STALE_PENDING_MINUTES must be positive');
        return `batch=${config.batchSize}, concurrency=${config.workerConcurrency}, stale_pending=${config.stalePendingMinutes}m`;
    });

    await redis.quit();
    await pool.end();

    for (const item of checks) {
        console.log(`${item.ok ? 'OK' : 'FAIL'} ${item.name}: ${item.detail}`);
    }

    if (checks.some(item => !item.ok)) process.exit(1);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
