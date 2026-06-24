require('dotenv').config();

const { Worker } = require('bullmq');
const axios = require('axios');

const config = require('./config');
const pool = require('./utils/db');
const redis = require('./utils/redis');
const { decryptTokenIfPossible } = require('./utils/crypto');
const { stripPrivateFields } = require('./events/common');
const { eventHasSuccessfulDelivery } = require('./platforms/delivery');
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

async function refreshDbEvents(dbEvents) {
    const ids = dbEvents.map(event => event.id);
    const { rows } = await pool.query(
        'SELECT id, status, fb_response FROM event_store WHERE id = ANY($1::bigint[])',
        [ids],
    );
    const latestById = new Map(rows.map(row => [String(row.id), row]));
    return dbEvents.map(event => {
        const latest = latestById.get(String(event.id));
        return latest ? { ...event, status: latest.status, fb_response: latest.fb_response } : null;
    }).filter(Boolean);
}

async function insertDeadLetter(shopId, dbEvents, reason) {
    await pool.query(
        `INSERT INTO dead_letters (shop_id, payload, error_reason)
         VALUES ($1, $2, $3)`,
        [shopId, JSON.stringify(dbEvents), reason],
    );
}

function eventIds(dbEvents) {
    return dbEvents.map(event => event.request_payload?.event_id).filter(Boolean);
}

function mergeDeliveriesFromEvents(dbEvents) {
    const merged = [];
    const seen = new Set();
    for (const event of dbEvents) {
        const deliveries = event.fb_response?.deliveries || [];
        for (const delivery of deliveries) {
            const key = JSON.stringify([
                delivery.platform,
                delivery.pixel_id,
                delivery.status,
                delivery.reason,
                delivery.code,
                delivery.message,
                delivery.event_ids,
            ]);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(delivery);
        }
    }
    return merged;
}

function finalStatusForDeliveries(deliveries) {
    return deliveries.some(delivery => delivery.status === 'SUCCESS') ? 'PARTIAL_FAILED' : 'FAILED';
}

async function sendToFacebookPixel(pixel, dbEvents) {
    const token = decryptTokenIfPossible(pixel.access_token);
    const finalEvents = dbEvents.map(event => stripPrivateFields({ ...event.request_payload }));
    const requestBody = { data: finalEvents };
    if (pixel.test_event_code) requestBody.test_event_code = pixel.test_event_code;

    const url = `https://graph.facebook.com/${config.fbApiVersion}/${pixel.pixel_id}/events`;
    const response = await axios.post(
        url,
        requestBody,
        {
            timeout: config.fbRequestTimeoutMs,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        },
    );

    if (Number(response.data.events_received || 0) < finalEvents.length) {
        throw new RetryableError(`Meta accepted ${response.data.events_received || 0}/${finalEvents.length} events`);
    }

    return {
        platform: 'facebook',
        pixel_id: pixel.pixel_id,
        name: pixel.name,
        fbtrace_id: response.data.fbtrace_id,
        events_received: response.data.events_received,
    };
}

async function sendToTikTokPixel(pixel, dbEvents) {
    const token = decryptTokenIfPossible(pixel.access_token);
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

    const freshDbEvents = await refreshDbEvents(dbEvents);
    const sendableDbEvents = freshDbEvents.filter(event => event.status !== 'SUCCESS');
    if (sendableDbEvents.length === 0) return;

    const idsToUpdate = sendableDbEvents.map(event => event.id);
    const { rows: pixels } = await pool.query(
        'SELECT id, platform, name, pixel_id, access_token, test_event_code FROM pixels WHERE shop_id = $1 ORDER BY id ASC',
        [shopId],
    );

    if (pixels.length === 0) {
        const reason = 'No pixels configured for shop';
        await updateEvents(idsToUpdate, 'FAILED', { error: reason });
        await insertDeadLetter(shopId, sendableDbEvents, reason);
        return;
    }

    const deliveries = [];
    const permanentFailures = [];
    for (const pixel of pixels) {
        const alreadySuccessfulEvents = sendableDbEvents.filter(event => eventHasSuccessfulDelivery(event, pixel));
        const pixelDbEvents = sendableDbEvents.filter(event => !eventHasSuccessfulDelivery(event, pixel));
        if (alreadySuccessfulEvents.length > 0) {
            deliveries.push({
                platform: pixel.platform,
                pixel_id: pixel.pixel_id,
                name: pixel.name,
                status: 'SUCCESS',
                skipped: true,
                reason: 'SKIPPED_ALREADY_SUCCESS',
                event_ids: eventIds(alreadySuccessfulEvents),
            });
        }
        if (pixelDbEvents.length === 0) {
            continue;
        }

        try {
            const result = await sendToPlatform(pixel, pixelDbEvents);
            deliveries.push({
                ...result,
                status: 'SUCCESS',
                event_ids: eventIds(pixelDbEvents),
            });
        } catch (error) {
            const classification = pixel.platform === 'tiktok' ? classifyTikTokError(error) : classifyFacebookError(error);
            const failure = {
                platform: pixel.platform,
                pixel_id: pixel.pixel_id,
                name: pixel.name,
                status: classification.retryable ? 'RETRYABLE_FAILED' : 'FAILED',
                code: classification.code,
                message: classification.message,
                event_ids: eventIds(pixelDbEvents),
            };

            if (classification.retryable) {
                deliveries.push(failure);
                await updateEvents(idsToUpdate, 'PENDING', { deliveries });
                throw new RetryableError(`${pixel.platform} retryable error (${classification.code || 'network'}): ${classification.message}`);
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
        sendableDbEvents.map(event => ({ ...event, fb_response: fbResponse })),
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
        try {
            console.error(`Job ${job.id} moved to DLQ: ${err.message}`);
            const freshDbEvents = await refreshDbEvents(job.data.dbEvents || []);
            const failedEvents = freshDbEvents.filter(event => event.status !== 'SUCCESS');
            if (failedEvents.length === 0) return;

            const deliveries = mergeDeliveriesFromEvents(failedEvents);
            const fbResponse = {
                deliveries,
                error: err.message,
                attempts_exhausted: true,
            };
            const status = finalStatusForDeliveries(deliveries);
            await updateEvents(failedEvents.map(event => event.id), status, fbResponse);
            await insertDeadLetter(
                job.data.shopId,
                failedEvents.map(event => ({ ...event, fb_response: fbResponse })),
                err.message,
            );
        } catch (error) {
            console.error(`Failed to persist DLQ state for job ${job.id}:`, error);
        }
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
