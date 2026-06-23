require('dotenv').config();

const { Worker } = require('bullmq');
const axios = require('axios');

const config = require('./config');
const pool = require('./utils/db');
const redis = require('./utils/redis');
const { decryptToken } = require('./utils/crypto');
const { stripPrivateFields } = require('./events/common');
const { shouldSkipPixel, successfulDeliveryKeys } = require('./platforms/delivery');
const { buildTikTokPayload } = require('./platforms/tiktok');

class RetryableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RetryableError';
    }
}

function classifyFacebookError(error) {
    const fbError = error.response?.data?.error;
    const code = fbError?.code;
    const status = error.response?.status;
    const permanentCodes = new Set([102, 190, 463, 467, 2500]);
    const retryableCodes = new Set([1, 2, 4, 17, 32, 613, 80004]);

    if (permanentCodes.has(code)) return { retryable: false, code, message: fbError.message };
    if (retryableCodes.has(code) || status === 429 || status >= 500 || !error.response) {
        return { retryable: true, code, message: fbError?.message || error.message };
    }

    return { retryable: false, code, message: fbError?.message || error.message };
}

function classifyTikTokError(error) {
    if (!error.response || error.response.status >= 500 || error.response.status === 429) {
        return { retryable: true, code: error.response?.status, message: error.message };
    }

    const data = error.response.data || {};
    const code = data.code || data.error?.code;
    const message = data.message || data.error?.message || error.message;
    return { retryable: false, code, message };
}

async function updateEvents(ids, status, fbResponse) {
    await pool.query(
        `UPDATE event_store
         SET status = $1, fb_response = $2
         WHERE id = ANY($3::bigint[])`,
        [status, JSON.stringify(fbResponse), ids],
    );
}

async function insertDeadLetter(shopId, dbEvents, reason) {
    await pool.query(
        `INSERT INTO dead_letters (shop_id, payload, error_reason)
         VALUES ($1, $2, $3)`,
        [shopId, JSON.stringify(dbEvents), reason],
    );
}

async function sendToFacebookPixel(pixel, dbEvents) {
    const token = decryptToken(pixel.access_token);
    const finalEvents = dbEvents.map(event => {
        const payload = stripPrivateFields({ ...event.request_payload });
        if (pixel.test_event_code) payload.test_event_code = pixel.test_event_code;
        return payload;
    });

    const url = `https://graph.facebook.com/${config.fbApiVersion}/${pixel.pixel_id}/events`;
    const response = await axios.post(
        url,
        { data: finalEvents },
        {
            timeout: config.fbRequestTimeoutMs,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        },
    );

    return {
        platform: 'facebook',
        pixel_id: pixel.pixel_id,
        name: pixel.name,
        fbtrace_id: response.data.fbtrace_id,
        events_received: response.data.events_received,
    };
}

async function sendToTikTokPixel(pixel, dbEvents) {
    const token = decryptToken(pixel.access_token);
    const url = 'https://business-api.tiktok.com/open_api/v1.3/pixel/track/';
    const results = [];

    for (const event of dbEvents) {
        const payload = buildTikTokPayload(pixel, event);
        const response = await axios.post(url, payload, {
            timeout: config.fbRequestTimeoutMs,
            headers: {
                'Access-Token': token,
                'Content-Type': 'application/json',
            },
        });
        if (response.data?.code && response.data.code !== 0) {
            const error = new Error(response.data.message || 'TikTok API error');
            error.response = { status: 400, data: response.data };
            throw error;
        }
        results.push({
            event_id: event.request_payload.event_id,
            event: payload.event,
            code: response.data.code,
            message: response.data.message,
            request_id: response.data.request_id,
        });
    }

    return {
        platform: 'tiktok',
        pixel_id: pixel.pixel_id,
        name: pixel.name,
        events_received: results.length,
        results,
    };
}

async function sendToPlatform(pixel, dbEvents) {
    if (pixel.platform === 'tiktok') return sendToTikTokPixel(pixel, dbEvents);
    return sendToFacebookPixel(pixel, dbEvents);
}

const worker = new Worker('capi-events', async job => {
    const { shopId, dbEvents } = job.data || {};
    if (!shopId || !Array.isArray(dbEvents) || dbEvents.length === 0) {
        throw new Error('Invalid job payload');
    }

    const idsToUpdate = dbEvents.map(event => event.id);
    const { rows: pixels } = await pool.query(
        'SELECT id, platform, name, pixel_id, access_token, test_event_code FROM pixels WHERE shop_id = $1 ORDER BY id ASC',
        [shopId],
    );

    if (pixels.length === 0) {
        const reason = 'No pixels configured for shop';
        await updateEvents(idsToUpdate, 'FAILED', { error: reason });
        await insertDeadLetter(shopId, dbEvents, reason);
        return;
    }

    const deliveries = [];
    const permanentFailures = [];
    const successfulKeys = successfulDeliveryKeys(dbEvents);

    for (const pixel of pixels) {
        if (shouldSkipPixel(pixel, successfulKeys)) {
            deliveries.push({
                platform: pixel.platform,
                pixel_id: pixel.pixel_id,
                name: pixel.name,
                status: 'SKIPPED_ALREADY_SUCCESS',
            });
            continue;
        }

        try {
            const result = await sendToPlatform(pixel, dbEvents);
            deliveries.push({ ...result, status: 'SUCCESS' });
        } catch (error) {
            const classification = pixel.platform === 'tiktok' ? classifyTikTokError(error) : classifyFacebookError(error);
            const failure = {
                platform: pixel.platform,
                pixel_id: pixel.pixel_id,
                name: pixel.name,
                status: classification.retryable ? 'RETRYABLE_FAILED' : 'FAILED',
                code: classification.code,
                message: classification.message,
            };

            if (classification.retryable) {
                throw new RetryableError(`Facebook retryable error (${classification.code || 'network'}): ${classification.message}`);
            }

            deliveries.push(failure);
            permanentFailures.push(failure);
        }
    }

    const fbResponse = { deliveries };
    if (permanentFailures.length === 0) {
        await updateEvents(idsToUpdate, 'SUCCESS', fbResponse);
        return;
    }

    const status = deliveries.some(delivery => delivery.status === 'SUCCESS') ? 'PARTIAL_FAILED' : 'FAILED';
    await updateEvents(idsToUpdate, status, fbResponse);
    await insertDeadLetter(
        shopId,
        dbEvents.map(event => ({ ...event, fb_response: fbResponse })),
        `Permanent pixel failures: ${permanentFailures.map(item => item.pixel_id).join(', ')}`,
    );
}, {
    connection: redis,
    concurrency: config.workerConcurrency,
    limiter: {
        max: config.workerRateLimitMax,
        duration: config.workerRateLimitDurationMs,
    },
});

worker.on('failed', async (job, err) => {
    if (!job) return;

    const attemptsExhausted = job.attemptsMade >= (job.opts.attempts || 1);
    if (attemptsExhausted) {
        console.error(`Job ${job.id} moved to DLQ: ${err.message}`);
        await insertDeadLetter(job.data.shopId, job.data.dbEvents, err.message);
    }
});

worker.on('error', error => {
    console.error('Worker runtime error:', error);
});

async function shutdown(signal) {
    console.log(`Received ${signal}, shutting down worker`);
    try {
        await worker.close();
        await pool.end();
        await redis.quit();
        process.exit(0);
    } catch (error) {
        console.error('Worker shutdown error:', error);
        process.exit(1);
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('CAPI worker started');
