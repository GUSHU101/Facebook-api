require('dotenv').config();

const crypto = require('crypto');
const { Queue, Worker } = require('bullmq');
const axios = require('axios');

const config = require('./config');
const pool = require('./utils/db');
const redis = require('./utils/redis');
const workerRedis = redis.createBullMqWorkerConnection();
const { decryptTokenIfPossible } = require('./utils/crypto');
const { stripPrivateFields } = require('./events/common');
const { prepareMetaEvent, validateMetaEvent } = require('./platforms/meta');
const {
    classifyFacebookError,
    classifyTikTokError,
    metaRateControlFromHeaders,
    retryDelayWithJitterSeconds,
} = require('./platforms/rate-control');
const { buildTikTokPayload } = require('./platforms/tiktok');

const capiQueue = new Queue('capi-events', {
    connection: redis,
    defaultJobOptions: {
        attempts: config.queueAttempts,
        backoff: { type: 'exponential', delay: config.queueBackoffMs },
        removeOnComplete: 100,
        removeOnFail: 1000,
    },
});

class RetryableError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'RetryableError';
        this.retryable = true;
        this.code = options.code;
        this.retryAfterSeconds = options.retryAfterSeconds;
    }
}

async function updateEvents(shopId, ids, status, fbResponse) {
    await pool.query(
        `UPDATE event_store
         SET status = $1, fb_response = $2
         WHERE shop_id = $3
           AND id = ANY($4::bigint[])`,
        [status, JSON.stringify(fbResponse), shopId, ids],
    );
}

const DELIVERY_LEASE_SECONDS = Math.max(
    30,
    Math.ceil(config.credentialLeaseMs / 1000),
    Math.ceil(config.fbRequestTimeoutMs / 1000) * 2,
);

async function ensureDeliveryLedger(shopId, eventIds) {
    await pool.query(
        `INSERT INTO event_deliveries (event_store_id, route_id)
         SELECT e.id, r.id
         FROM event_store e
         JOIN shop_pixel_routes r
           ON r.shop_id = e.shop_id
          AND r.status = 'active'
         WHERE e.shop_id = $1
           AND e.id = ANY($2::bigint[])
         ON CONFLICT (event_store_id, route_id) DO NOTHING`,
        [shopId, eventIds],
    );
}

async function claimRouteEvents(routeId, eventIds) {
    const { rows } = await pool.query(
        `UPDATE event_deliveries
         SET status = 'IN_PROGRESS',
             attempt_count = attempt_count + 1,
             last_attempt_at = NOW(),
             lease_expires_at = NOW() + ($3::int * INTERVAL '1 second'),
             updated_at = NOW()
         WHERE route_id = $1
           AND event_store_id = ANY($2::bigint[])
           AND (
                status IN ('PENDING', 'RETRYABLE_FAILED')
                OR (status = 'IN_PROGRESS' AND lease_expires_at < NOW())
           )
           AND next_attempt_at <= NOW()
         RETURNING event_store_id, attempt_count`,
        [routeId, eventIds, DELIVERY_LEASE_SECONDS],
    );
    return new Map(rows.map(row => [String(row.event_store_id), Number(row.attempt_count)]));
}

async function hasClaimableRouteEvents(routeId, eventIds) {
    if (eventIds.length === 0) return false;
    const { rowCount } = await pool.query(
        `SELECT 1
         FROM event_deliveries
         WHERE route_id = $1
           AND event_store_id = ANY($2::bigint[])
           AND next_attempt_at <= NOW()
           AND (
               status IN ('PENDING', 'RETRYABLE_FAILED')
               OR (status = 'IN_PROGRESS' AND lease_expires_at < NOW())
           )
         LIMIT 1`,
        [routeId, eventIds],
    );
    return rowCount > 0;
}

function claimsForEvents(dbEvents, claimedEvents) {
    return dbEvents.map(event => ({
        eventStoreId: event.id,
        attemptCount: claimedEvents.get(String(event.id)),
    })).filter(item => Number.isInteger(item.attemptCount));
}

function claimArrays(claims) {
    return {
        eventStoreIds: claims.map(item => item.eventStoreId),
        attemptCounts: claims.map(item => item.attemptCount),
    };
}

async function extendDeliveryLeases(routeId, claims) {
    if (claims.length === 0) return 0;
    const { eventStoreIds, attemptCounts } = claimArrays(claims);
    const { rowCount } = await pool.query(
        `WITH claimed(event_store_id, attempt_count) AS (
             SELECT * FROM UNNEST($2::bigint[], $3::int[])
         )
         UPDATE event_deliveries ed
         SET lease_expires_at = NOW() + ($4::int * INTERVAL '1 second'),
             updated_at = NOW()
         FROM claimed c
         WHERE ed.route_id = $1
           AND ed.event_store_id = c.event_store_id
           AND ed.attempt_count = c.attempt_count
           AND ed.status = 'IN_PROGRESS'`,
        [routeId, eventStoreIds, attemptCounts, DELIVERY_LEASE_SECONDS],
    );
    return rowCount;
}

async function markDeliverySuccess(routeId, claims, response) {
    if (claims.length === 0) return [];
    const { eventStoreIds, attemptCounts } = claimArrays(claims);
    const { rows } = await pool.query(
        `WITH claimed(event_store_id, attempt_count) AS (
             SELECT * FROM UNNEST($2::bigint[], $3::int[])
         )
         UPDATE event_deliveries ed
         SET status = 'SUCCESS',
             delivered_at = NOW(),
             lease_expires_at = NULL,
             platform_response = $4::jsonb,
             error_code = NULL,
             error_message = NULL,
             updated_at = NOW()
         FROM claimed c
         WHERE ed.route_id = $1
           AND ed.event_store_id = c.event_store_id
           AND ed.attempt_count = c.attempt_count
           AND ed.status = 'IN_PROGRESS'
         RETURNING ed.event_store_id`,
        [routeId, eventStoreIds, attemptCounts, JSON.stringify(response)],
    );
    return rows.map(row => String(row.event_store_id));
}

async function markDeliveryFailure(routeId, claims, classification) {
    if (claims.length === 0) return [];
    const retryDelay = retryDelayWithJitterSeconds(
        classification.attempt,
        config.deliveryRetryBaseSeconds,
        config.deliveryRetryMaxSeconds,
        classification.retryAfterSeconds,
        config.deliveryRetryAfterMaxSeconds,
    );
    const { eventStoreIds, attemptCounts } = claimArrays(claims);
    const { rows } = await pool.query(
        `WITH claimed(event_store_id, attempt_count) AS (
             SELECT * FROM UNNEST($2::bigint[], $3::int[])
         )
         UPDATE event_deliveries ed
         SET status = $4,
             next_attempt_at = CASE
                 WHEN $4 = 'RETRYABLE_FAILED'
                 THEN NOW() + ($5::int * INTERVAL '1 second')
                 ELSE ed.next_attempt_at
             END,
             lease_expires_at = NULL,
             error_code = $6,
             error_message = $7,
             updated_at = NOW()
         FROM claimed c
         WHERE ed.route_id = $1
           AND ed.event_store_id = c.event_store_id
           AND ed.attempt_count = c.attempt_count
           AND ed.status = 'IN_PROGRESS'
         RETURNING ed.event_store_id`,
        [
            routeId,
            eventStoreIds,
            attemptCounts,
            classification.retryable ? 'RETRYABLE_FAILED' : 'FAILED_PERMANENT',
            retryDelay,
            classification.code === undefined ? null : String(classification.code),
            classification.message,
        ],
    );
    return rows.map(row => String(row.event_store_id));
}

async function deferRouteEvents(routeId, eventIds, delaySeconds, code, message) {
    if (eventIds.length === 0) return 0;
    const { rowCount } = await pool.query(
        `UPDATE event_deliveries
         SET status = 'RETRYABLE_FAILED',
             next_attempt_at = GREATEST(
                 next_attempt_at,
                 NOW() + ($3::int * INTERVAL '1 second')
             ),
             error_code = $4,
             error_message = $5,
             updated_at = NOW()
         WHERE route_id = $1
           AND event_store_id = ANY($2::bigint[])
           AND status IN ('PENDING', 'RETRYABLE_FAILED')
           AND next_attempt_at <= NOW()`,
        [routeId, eventIds, Math.max(1, Math.ceil(delaySeconds)), code, message],
    );
    return rowCount;
}

async function syncEventStatuses(shopId, eventIds) {
    if (eventIds.length === 0) return;
    await pool.query(
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
         UPDATE event_store e
         SET status = CASE
             WHEN d.total > 0 AND d.succeeded = d.total THEN 'SUCCESS'
             WHEN d.outstanding > 0 THEN 'PENDING'
             WHEN d.succeeded > 0 AND d.permanent_failed > 0 THEN 'PARTIAL_FAILED'
             WHEN d.permanent_failed = d.total THEN 'FAILED'
             ELSE e.status
         END
         FROM delivery_summary d
         WHERE e.id = d.event_store_id
           AND e.shop_id = $2`,
        [eventIds, shopId],
    );
}

async function syncEventResponses(shopId, eventIds) {
    if (eventIds.length === 0) return;
    await pool.query(
        `WITH route_state AS (
             SELECT ed.event_store_id,
                    jsonb_agg(
                        jsonb_strip_nulls(jsonb_build_object(
                            'route_id', ed.route_id,
                            'platform', p.platform,
                            'pixel_id', p.pixel_id,
                            'status', CASE
                                WHEN ed.status = 'FAILED_PERMANENT' THEN 'FAILED'
                                ELSE ed.status
                            END,
                            'attempt_count', ed.attempt_count,
                            'next_attempt_at', ed.next_attempt_at,
                            'delivered_at', ed.delivered_at,
                            'code', ed.error_code,
                            'message', ed.error_message,
                            'response', ed.platform_response
                        ))
                        ORDER BY ed.route_id
                    ) AS deliveries
             FROM event_deliveries ed
             JOIN shop_pixel_routes r ON r.id = ed.route_id
             JOIN pixels p ON p.id = r.pixel_id
             WHERE ed.event_store_id = ANY($1::bigint[])
             GROUP BY ed.event_store_id
         )
         UPDATE event_store e
         SET fb_response = jsonb_build_object('deliveries', route_state.deliveries)
         FROM route_state
         WHERE e.id = route_state.event_store_id
           AND e.shop_id = $2`,
        [eventIds, shopId],
    );
}

async function refreshDbEvents(shopId, dbEvents) {
    const ids = dbEvents
        .map(event => event.id)
        .filter(Boolean)
        .slice(0, config.workerEventBatchSize);
    if (ids.length === 0) return [];
    const { rows } = await pool.query(
        `SELECT id, shop_id, event_name, event_id, request_payload, emq_estimate, status, fb_response
         FROM event_store
         WHERE shop_id = $1
           AND id = ANY($2::bigint[])`,
        [shopId, ids],
    );
    const latestById = new Map(rows.map(row => [String(row.id), row]));
    return dbEvents.map(event => {
        const latest = latestById.get(String(event.id));
        return latest ? { ...event, ...latest } : null;
    }).filter(Boolean);
}

async function loadReadyShopEvents(shopId) {
    const { rows } = await pool.query(
        `SELECT id, shop_id, event_name, event_id, request_payload, emq_estimate, status, fb_response
         FROM event_store
         WHERE shop_id = $1
           AND status = 'PENDING'
           AND (
               event_name <> 'Purchase'
               OR timestamp <= NOW() - ($2::int * INTERVAL '1 millisecond')
           )
           AND EXISTS (
                   SELECT 1
                   FROM shop_pixel_routes active_route
                   LEFT JOIN event_deliveries delivery
                     ON delivery.event_store_id = event_store.id
                    AND delivery.route_id = active_route.id
                   WHERE active_route.shop_id = $1
                     AND active_route.status = 'active'
                     AND (
                         delivery.id IS NULL
                         OR (
                             delivery.next_attempt_at <= NOW()
                             AND (
                                 delivery.status IN ('PENDING', 'RETRYABLE_FAILED')
                                 OR (
                                     delivery.status = 'IN_PROGRESS'
                                     AND delivery.lease_expires_at < NOW()
                                 )
                             )
                         )
                     )
           )
         ORDER BY id ASC
         LIMIT $3`,
        [shopId, config.purchaseSettleMs, config.workerEventBatchSize],
    );
    return rows;
}

async function hasReadyShopEvents(shopId) {
    const { rowCount } = await pool.query(
        `SELECT 1
         FROM event_store
         WHERE shop_id = $1
           AND status = 'PENDING'
           AND (
               event_name <> 'Purchase'
               OR timestamp <= NOW() - ($2::int * INTERVAL '1 millisecond')
           )
           AND EXISTS (
                   SELECT 1
                   FROM shop_pixel_routes active_route
                   LEFT JOIN event_deliveries delivery
                     ON delivery.event_store_id = event_store.id
                    AND delivery.route_id = active_route.id
                   WHERE active_route.shop_id = $1
                     AND active_route.status = 'active'
                     AND (
                         delivery.id IS NULL
                         OR (
                             delivery.next_attempt_at <= NOW()
                             AND (
                                 delivery.status IN ('PENDING', 'RETRYABLE_FAILED')
                                 OR (
                                     delivery.status = 'IN_PROGRESS'
                                     AND delivery.lease_expires_at < NOW()
                                 )
                             )
                         )
                     )
           )
         LIMIT 1`,
        [shopId, config.purchaseSettleMs],
    );
    return rowCount > 0;
}

async function scheduleShopContinuation(shopId) {
    if (!await hasReadyShopEvents(shopId)) return false;
    await capiQueue.add(
        'send-fb-batch',
        { shopId },
        { jobId: `drain-${shopId}-${crypto.randomUUID()}` },
    );
    return true;
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

function chunkItems(items, size) {
    const chunks = [];
    const chunkSize = Math.max(1, Number(size || 1));
    for (let index = 0; index < items.length; index += chunkSize) {
        chunks.push(items.slice(index, index + chunkSize));
    }
    return chunks;
}

function platformFailureResult(pixel, dbEvents, classification) {
    return {
        platform: pixel.platform || 'facebook',
        pixel_id: pixel.pixel_id,
        name: pixel.name,
        status: 'FAILED',
        code: classification.code,
        message: classification.message,
        event_ids: eventIds(dbEvents),
    };
}

function buildFacebookResult(pixel, successes, failures) {
    const rateControls = successes.map(item => item.rate_control || {});
    const maxUsagePercent = Math.max(0, ...rateControls.map(item => Number(item.maxUsagePercent || 0)));
    const cooldownSeconds = Math.max(0, ...rateControls.map(item => Number(item.cooldownSeconds || 0)));
    return {
        platform: 'facebook',
        pixel_id: pixel.pixel_id,
        name: pixel.name,
        events_received: successes.reduce((sum, item) => sum + Number(item.events_received || 0), 0),
        results: successes,
        successful_event_ids: successes.flatMap(item => item.event_ids || []),
        permanent_failures: failures,
        rate_control: {
            maxUsagePercent: maxUsagePercent || undefined,
            cooldownSeconds: cooldownSeconds || undefined,
        },
    };
}

function shouldIsolateFacebookError(classification) {
    const pixelLevelCodes = new Set([102, 190, 463, 467]);
    return !pixelLevelCodes.has(classification.code);
}

async function postFacebookBatch(pixel, token, dbEvents) {
    const finalEvents = dbEvents.map(event => (
        prepareMetaEvent(stripPrivateFields({ ...event.request_payload }))
    ));
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
        fbtrace_id: response.data.fbtrace_id,
        events_received: Number(response.data.events_received || 0),
        event_ids: eventIds(dbEvents),
        rate_control: metaRateControlFromHeaders(response.headers),
    };
}

async function sendFacebookBatchWithIsolation(pixel, token, dbEvents, budget) {
    if (budget.remaining <= 0) {
        throw new RetryableError(
            'Meta error-isolation request budget reached; remaining events were deferred',
            { code: 'LOCAL_ISOLATION_BUDGET', retryAfterSeconds: config.deliveryRetryBaseSeconds },
        );
    }
    budget.remaining -= 1;

    try {
        const result = await postFacebookBatch(pixel, token, dbEvents);
        return {
            successes: [result],
            failures: [],
        };
    } catch (error) {
        const classification = classifyFacebookError(error);
        if (classification.retryable) throw error;

        if (dbEvents.length === 1 || !shouldIsolateFacebookError(classification)) {
            return {
                successes: [],
                failures: [platformFailureResult(pixel, dbEvents, classification)],
            };
        }

        const midpoint = Math.ceil(dbEvents.length / 2);
        const left = await sendFacebookBatchWithIsolation(pixel, token, dbEvents.slice(0, midpoint), budget);
        const right = await sendFacebookBatchWithIsolation(pixel, token, dbEvents.slice(midpoint), budget);
        return {
            successes: [...left.successes, ...right.successes],
            failures: [...left.failures, ...right.failures],
        };
    }
}

async function sendToFacebookPixel(pixel, dbEvents) {
    const token = decryptTokenIfPossible(pixel.access_token);
    const successes = [];
    const failures = [];
    const budget = { remaining: config.facebookIsolationMaxRequests };
    const validDbEvents = [];
    for (const event of dbEvents) {
        const validationErrors = validateMetaEvent(
            prepareMetaEvent(stripPrivateFields({ ...event.request_payload })),
        );
        if (validationErrors.length > 0) {
            failures.push(platformFailureResult(pixel, [event], {
                code: 'LOCAL_VALIDATION',
                message: validationErrors.join('; '),
            }));
        } else {
            validDbEvents.push(event);
        }
    }

    const batches = chunkItems(validDbEvents, config.facebookBatchSize);
    for (let index = 0; index < batches.length; index += 1) {
        try {
            const result = await sendFacebookBatchWithIsolation(pixel, token, batches[index], budget);
            successes.push(...result.successes);
            failures.push(...result.failures);
        } catch (error) {
            // Preserve completed chunks. Without this, a transient error in a
            // later chunk causes already accepted events to be retried as if
            // the whole route request had failed.
            error.partialDelivery = {
                result: buildFacebookResult(pixel, successes, failures),
                retryable_event_ids: eventIds(batches.slice(index).flat()),
            };
            throw error;
        }
    }

    return buildFacebookResult(pixel, successes, failures);
}

async function sendToTikTokPixel(pixel, dbEvents) {
    const token = decryptTokenIfPossible(pixel.access_token);
    const url = 'https://business-api.tiktok.com/open_api/v1.3/pixel/track/';
    const results = [];
    const failures = [];

    for (let index = 0; index < dbEvents.length; index += 1) {
        const event = dbEvents[index];
        const payload = buildTikTokPayload(pixel, event);
        try {
            const response = await axios.post(url, payload, {
                timeout: config.fbRequestTimeoutMs,
                headers: {
                    'Access-Token': token,
                    'Content-Type': 'application/json',
                },
            });
            const responseCode = Number(response.data?.code ?? 0);
            if (!Number.isFinite(responseCode) || responseCode !== 0) {
                const error = new Error(response.data.message || 'TikTok API error');
                error.response = {
                    status: response.status || 400,
                    data: response.data,
                    headers: response.headers,
                };
                throw error;
            }
            results.push({
                event_id: event.request_payload.event_id,
                event: payload.event,
                code: responseCode,
                message: response.data.message,
                request_id: response.data.request_id,
            });
        } catch (error) {
            const classification = classifyTikTokError(error);
            if (classification.retryable) {
                error.partialDelivery = {
                    result: {
                        platform: 'tiktok',
                        pixel_id: pixel.pixel_id,
                        name: pixel.name,
                        events_received: results.length,
                        results,
                        successful_event_ids: results.map(item => item.event_id),
                        permanent_failures: failures,
                    },
                    // The current event and all later events were not confirmed.
                    retryable_event_ids: eventIds(dbEvents.slice(index)),
                };
                throw error;
            }
            failures.push(platformFailureResult(pixel, [event], classification));
        }
    }

    return {
        platform: 'tiktok',
        pixel_id: pixel.pixel_id,
        name: pixel.name,
        events_received: results.length,
        results,
        successful_event_ids: results.map(item => item.event_id),
        permanent_failures: failures,
    };
}

async function sendToPlatform(pixel, dbEvents) {
    if (pixel.platform === 'tiktok') return sendToTikTokPixel(pixel, dbEvents);
    return sendToFacebookPixel(pixel, dbEvents);
}

async function credentialCooldownSeconds(credentialId) {
    const { rows } = await pool.query(
        `SELECT GREATEST(
                    0,
                    CEIL(EXTRACT(EPOCH FROM (rate_limit_until - NOW())))
                )::int AS seconds
         FROM pixels
         WHERE id = $1`,
        [credentialId],
    );
    return Number(rows[0]?.seconds || 0);
}

async function recordCredentialSuccess(credentialId, rateControl = {}) {
    const cooldownSeconds = Math.max(0, Math.ceil(Number(rateControl.cooldownSeconds || 0)));
    await pool.query(
        `UPDATE pixels
         SET consecutive_failures = 0,
             last_delivery_at = NOW(),
             last_usage_pct = COALESCE($2, last_usage_pct),
             rate_limit_until = CASE
                 WHEN $3::int > 0
                 THEN GREATEST(
                     COALESCE(rate_limit_until, NOW()),
                     NOW() + ($3::int * INTERVAL '1 second')
                 )
                 ELSE NULL
             END,
             last_rate_limit_at = CASE WHEN $3::int > 0 THEN NOW() ELSE last_rate_limit_at END
         WHERE id = $1`,
        [
            credentialId,
            rateControl.maxUsagePercent === undefined ? null : Number(rateControl.maxUsagePercent),
            cooldownSeconds,
        ],
    );
}

async function recordCredentialFailure(credentialId, classification) {
    const isRateLimit = Number(classification.code) === 429
        || [4, 17, 32, 613, 80004].includes(Number(classification.code));
    const cooldownSeconds = classification.retryable
        ? Math.max(
            Number(classification.retryAfterSeconds || 0),
            Number(classification.rateControl?.cooldownSeconds || 0),
            isRateLimit ? 60 : config.deliveryRetryBaseSeconds,
        )
        : 0;
    await pool.query(
        `UPDATE pixels
         SET consecutive_failures = consecutive_failures + 1,
             last_usage_pct = COALESCE($2, last_usage_pct),
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
            credentialId,
            classification.rateControl?.maxUsagePercent === undefined
                ? null
                : Number(classification.rateControl.maxUsagePercent),
            Math.ceil(cooldownSeconds),
        ],
    );
    return Math.ceil(cooldownSeconds);
}

async function acquireRedisLease(key, minimumTtlMs = config.credentialLeaseMs) {
    const token = `${process.pid}:${crypto.randomUUID()}`;
    const ttlMs = Math.max(minimumTtlMs, config.fbRequestTimeoutMs * 3);
    const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
    if (!acquired) return null;

    const renewScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("pexpire", KEYS[1], ARGV[2])
        end
        return 0
    `;
    const releaseScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        end
        return 0
    `;
    return {
        ttlMs,
        async renew() {
            return Number(await redis.eval(renewScript, 1, key, token, ttlMs)) === 1;
        },
        async release() {
            return Number(await redis.eval(releaseScript, 1, key, token)) === 1;
        },
    };
}

async function acquireCredentialLease(credentialId) {
    return acquireRedisLease(`lock:delivery-credential:${credentialId}`);
}

function startRedisLeaseHeartbeat(lease, label) {
    const intervalMs = Math.max(1000, Math.floor(lease.ttlMs / 3));
    let stopped = false;
    let inFlight = Promise.resolve();
    const timer = setInterval(() => {
        inFlight = inFlight.then(async () => {
            if (!stopped && !await lease.renew()) {
                console.warn(`${label} lease was lost; route fencing remains authoritative`);
            }
        }).catch(error => console.error(`${label} lease heartbeat failed:`, error.message));
    }, intervalMs);
    timer.unref?.();
    return {
        async stop() {
            stopped = true;
            clearInterval(timer);
            await inFlight;
        },
    };
}

function startLeaseHeartbeat(credentialLease, routeId, claims) {
    const intervalMs = Math.max(1000, Math.floor(credentialLease.ttlMs / 3));
    let stopped = false;
    let lost = false;
    let inFlight = Promise.resolve();
    const timer = setInterval(() => {
        inFlight = inFlight.then(async () => {
            if (stopped) return;
            const [credentialRenewed, routeRowsRenewed] = await Promise.all([
                credentialLease.renew(),
                extendDeliveryLeases(routeId, claims),
            ]);
            if (!credentialRenewed || routeRowsRenewed !== claims.length) lost = true;
        }).catch(error => {
            lost = true;
            console.error(`Lease heartbeat failed for route ${routeId}:`, error.message);
        });
    }, intervalMs);
    timer.unref?.();

    return {
        isLost: () => lost,
        async stop() {
            stopped = true;
            clearInterval(timer);
            await inFlight;
        },
    };
}

async function applyPlatformResult(pixel, dbEvents, claimedEvents, result, deliveries) {
    const {
        successful_event_ids: successfulEventIds = [],
        permanent_failures: resultFailures = [],
        rate_control: rateControl,
        ...deliveryResult
    } = result;

    const successIds = successfulEventIds.map(String);
    const successDbEvents = dbEvents.filter(event => (
        successIds.includes(String(event.request_payload?.event_id))
    ));
    if (successDbEvents.length > 0) {
        const successDelivery = {
            ...deliveryResult,
            route_id: pixel.route_id,
            status: 'SUCCESS',
            event_ids: successfulEventIds,
            rate_control: rateControl,
        };
        const updatedIds = await markDeliverySuccess(
            pixel.route_id,
            claimsForEvents(successDbEvents, claimedEvents),
            successDelivery,
        );
        if (updatedIds.length > 0) deliveries.push(successDelivery);
    }

    for (const failure of resultFailures) {
        const failedIds = (failure.event_ids || []).map(String);
        const failedDbEvents = dbEvents.filter(event => (
            failedIds.includes(String(event.request_payload?.event_id))
        ));
        const failureClaims = claimsForEvents(failedDbEvents, claimedEvents);
        const maxAttempt = Math.max(1, ...failureClaims.map(item => item.attemptCount));
        const normalizedFailure = { ...failure, route_id: pixel.route_id, status: 'FAILED' };
        const updatedIds = await markDeliveryFailure(pixel.route_id, failureClaims, {
            retryable: false,
            code: failure.code,
            message: failure.message,
            attempt: maxAttempt,
        });
        if (updatedIds.length > 0) deliveries.push(normalizedFailure);
    }
}

const worker = new Worker('capi-events', async job => {
    const { shopId, dbEvents } = job.data || {};
    if (!Number.isInteger(Number(shopId)) || Number(shopId) <= 0 || (dbEvents !== undefined && !Array.isArray(dbEvents))) {
        throw new Error('Invalid job payload');
    }
    const normalizedShopId = Number(shopId);
    const shopLease = await acquireRedisLease(`lock:delivery-shop:${normalizedShopId}`);
    if (!shopLease) return;
    const shopLeaseHeartbeat = startRedisLeaseHeartbeat(shopLease, `Shop ${normalizedShopId}`);

    try {
    const freshDbEvents = Array.isArray(dbEvents) && dbEvents.length > 0
        ? await refreshDbEvents(normalizedShopId, dbEvents)
        : await loadReadyShopEvents(normalizedShopId);
    const sendableDbEvents = freshDbEvents.filter(event => (
        event.status === 'PENDING' && Number(event.shop_id) === normalizedShopId
    ));
    if (sendableDbEvents.length === 0) {
        if (Array.isArray(dbEvents)) await scheduleShopContinuation(normalizedShopId);
        return;
    }

    const idsToUpdate = sendableDbEvents.map(event => event.id);
    await ensureDeliveryLedger(normalizedShopId, idsToUpdate);
    const { rows: pixels } = await pool.query(
        `SELECT r.id AS route_id,
                p.id AS credential_id,
                p.platform,
                p.name,
                p.pixel_id,
                p.access_token,
                p.test_event_code
         FROM shop_pixel_routes r
         JOIN pixels p ON p.id = r.pixel_id
         WHERE r.shop_id = $1
           AND r.status = 'active'
         ORDER BY r.id ASC`,
        [normalizedShopId],
    );

    if (pixels.length === 0) {
        // Keep the PostgreSQL outbox pending. A route may be configured moments
        // later; permanently failing here would turn setup order into data loss.
        return;
    }

    const deliveries = [];
    let retryNeeded = false;
    let retryAfterSeconds = 0;
    for (const pixel of pixels) {
        // loadReadyShopEvents selects an event when any route is due. Skip
        // credentials whose own rows are already successful, terminal, leased,
        // or scheduled for the future before contending on a shared lock.
        if (!await hasClaimableRouteEvents(pixel.route_id, idsToUpdate)) continue;

        const credentialLease = await acquireCredentialLease(pixel.credential_id);
        if (!credentialLease) {
            const delaySeconds = config.credentialBusyDelaySeconds;
            const deferred = await deferRouteEvents(
                pixel.route_id,
                idsToUpdate,
                delaySeconds,
                'LOCAL_ROUTE_BUSY',
                'Another worker is delivering to this shared pixel credential',
            );
            if (deferred === 0) continue;
            deliveries.push({
                route_id: pixel.route_id,
                platform: pixel.platform,
                pixel_id: pixel.pixel_id,
                status: 'RETRYABLE_FAILED',
                code: 'LOCAL_ROUTE_BUSY',
                message: 'Shared credential busy; delivery was deferred without consuming an attempt',
            });
            retryNeeded = true;
            retryAfterSeconds = Math.max(retryAfterSeconds, delaySeconds);
            continue;
        }

        let leaseHeartbeat;
        let pixelDbEvents = [];
        let claimedEvents = new Map();
        let claims = [];
        try {
            const cooldownSeconds = await credentialCooldownSeconds(pixel.credential_id);
            if (cooldownSeconds > 0) {
                const deferred = await deferRouteEvents(
                    pixel.route_id,
                    idsToUpdate,
                    cooldownSeconds,
                    'PLATFORM_COOLDOWN',
                    'Platform usage or Retry-After cooldown is active for this credential',
                );
                if (deferred === 0) continue;
                deliveries.push({
                    route_id: pixel.route_id,
                    platform: pixel.platform,
                    pixel_id: pixel.pixel_id,
                    status: 'RETRYABLE_FAILED',
                    code: 'PLATFORM_COOLDOWN',
                    message: `Credential cooldown active for ${cooldownSeconds}s`,
                });
                retryNeeded = true;
                retryAfterSeconds = Math.max(retryAfterSeconds, cooldownSeconds);
                continue;
            }

            claimedEvents = await claimRouteEvents(pixel.route_id, idsToUpdate);
            pixelDbEvents = sendableDbEvents.filter(event => claimedEvents.has(String(event.id)));
            if (pixelDbEvents.length === 0) continue;

            claims = claimsForEvents(pixelDbEvents, claimedEvents);
            leaseHeartbeat = startLeaseHeartbeat(credentialLease, pixel.route_id, claims);
            const result = await sendToPlatform(pixel, pixelDbEvents);
            if (leaseHeartbeat.isLost()) {
                throw new RetryableError(
                    'Delivery lease was lost while the platform request was in flight',
                    { code: 'LOCAL_LEASE_LOST', retryAfterSeconds: config.credentialBusyDelaySeconds },
                );
            }

            await applyPlatformResult(pixel, pixelDbEvents, claimedEvents, result, deliveries);
            await recordCredentialSuccess(pixel.credential_id, result.rate_control);
        } catch (error) {
            if (error.partialDelivery) {
                await applyPlatformResult(
                    pixel,
                    pixelDbEvents,
                    claimedEvents,
                    error.partialDelivery.result,
                    deliveries,
                );
                const retryableIds = new Set(
                    (error.partialDelivery.retryable_event_ids || []).map(String),
                );
                pixelDbEvents = pixelDbEvents.filter(event => (
                    retryableIds.has(String(event.request_payload?.event_id))
                ));
                claims = claimsForEvents(pixelDbEvents, claimedEvents);
                if (claims.length === 0) continue;
            }

            const classification = pixel.platform === 'tiktok'
                ? classifyTikTokError(error)
                : classifyFacebookError(error);
            const maxAttempt = Math.max(1, ...claims.map(item => item.attemptCount));
            if (leaseHeartbeat?.isLost()) {
                classification.retryable = true;
                classification.code = 'LOCAL_LEASE_LOST';
                classification.message = 'Delivery lease was lost; stable event IDs make the retry deduplicatable';
            }
            if (
                classification.retryable
                && config.deliveryMaxAttempts > 0
                && maxAttempt >= config.deliveryMaxAttempts
            ) {
                classification.retryable = false;
                classification.message = `Retry limit reached: ${classification.message}`;
            }
            classification.attempt = maxAttempt;
            const credentialDelay = await recordCredentialFailure(pixel.credential_id, classification);
            classification.retryAfterSeconds = Math.max(
                Number(classification.retryAfterSeconds || 0),
                credentialDelay,
            );
            const failure = {
                route_id: pixel.route_id,
                platform: pixel.platform,
                pixel_id: pixel.pixel_id,
                name: pixel.name,
                status: classification.retryable ? 'RETRYABLE_FAILED' : 'FAILED',
                code: classification.code,
                message: classification.message,
                event_ids: eventIds(pixelDbEvents),
            };

            const updatedIds = await markDeliveryFailure(pixel.route_id, claims, classification);
            if (updatedIds.length > 0) deliveries.push(failure);
            if (classification.retryable) {
                retryNeeded = true;
                retryAfterSeconds = Math.max(
                    retryAfterSeconds,
                    Number(classification.retryAfterSeconds || config.deliveryRetryBaseSeconds),
                );
            }
        } finally {
            if (leaseHeartbeat) await leaseHeartbeat.stop();
            await credentialLease.release().catch(error => {
                console.error(`Failed to release credential lease ${pixel.credential_id}:`, error.message);
            });
        }
    }

    const fbResponse = { deliveries };
    await syncEventResponses(normalizedShopId, idsToUpdate);
    await syncEventStatuses(normalizedShopId, idsToUpdate);

    const permanentFailures = deliveries.filter(delivery => delivery.status === 'FAILED');
    if (permanentFailures.length > 0) {
        await insertDeadLetter(
            normalizedShopId,
            sendableDbEvents.map(event => ({ ...event, fb_response: fbResponse })),
            `Permanent route failures: ${permanentFailures.map(item => item.route_id).join(', ')}`,
        );
    }
    if (retryNeeded) {
        throw new RetryableError(
            'One or more routes were safely deferred for retry',
            { code: 'ROUTE_RETRY_SCHEDULED', retryAfterSeconds },
        );
    }
    await scheduleShopContinuation(normalizedShopId);
    } finally {
        await shopLeaseHeartbeat.stop();
        await shopLease.release().catch(error => {
            console.error(`Failed to release shop lease ${normalizedShopId}:`, error.message);
        });
    }
}, {
    connection: workerRedis,
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
            console.error(`Job ${job.id} exhausted queue attempts; durable route retry remains scheduled: ${err.message}`);
            const freshDbEvents = Array.isArray(job.data.dbEvents) && job.data.dbEvents.length > 0
                ? await refreshDbEvents(Number(job.data.shopId), job.data.dbEvents)
                : await loadReadyShopEvents(job.data.shopId);
            const failedEvents = freshDbEvents.filter(event => (
                event.status === 'PENDING' && Number(event.shop_id) === Number(job.data.shopId)
            ));
            if (failedEvents.length === 0) return;
            await syncEventStatuses(Number(job.data.shopId), failedEvents.map(event => event.id));
        } catch (error) {
            console.error(`Failed to preserve durable retry state for job ${job.id}:`, error);
        }
    }
});

worker.on('error', error => {
    console.error('Worker runtime error:', error);
});

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down worker`);
    const forceTimer = setTimeout(() => {
        console.error('Worker shutdown deadline exceeded; durable leases will make interrupted events retryable');
        process.exit(1);
    }, config.shutdownTimeoutMs);
    forceTimer.unref?.();
    try {
        await worker.close();
        await capiQueue.close();
        await pool.end();
        await workerRedis.quit();
        await redis.quit();
        clearTimeout(forceTimer);
        process.exit(0);
    } catch (error) {
        clearTimeout(forceTimer);
        console.error('Worker shutdown error:', error);
        process.exit(1);
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('CAPI worker started');
