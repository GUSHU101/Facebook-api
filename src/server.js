require('dotenv').config();

const crypto = require('crypto');
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
const { hashUserData, encryptToken, decryptTokenIfPossible, timingSafeCompare } = require('./utils/crypto');
const { calculateEMQ, missingMatchSignals } = require('./utils/emq');
const { compactObject, firstPresent, normalizeShopifyId } = require('./events/common');
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
    keyGenerator: req => `${normalizeShopDomain(shopDomainFromPixelBody(req.body)) || 'unknown'}:${firstForwardedIp(req)}`,
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
const ATTRIBUTION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PURCHASE_DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_PIXEL_BATCH_SIZE = 50;
const META_QUALITY_METRIC_TYPE = 'EVENT_MATCH_QUALITY';

function normalizeShopDomain(domain) {
    return String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
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

function isSha256Hex(value) {
    return /^[a-f0-9]{64}$/.test(String(value || '').trim().toLowerCase());
}

function hashOrKeepMany(values, type = 'default') {
    const hashes = [];
    const seen = new Set();
    for (const value of values.flat()) {
        const normalized = String(value || '').trim().toLowerCase();
        const hash = isSha256Hex(normalized) ? normalized : hashUserData(value, type);
        if (hash && !seen.has(hash)) {
            seen.add(hash);
            hashes.push(hash);
        }
    }
    return hashes.length ? hashes : undefined;
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

function normalizeEventId(value) {
    const normalized = normalizeShopifyId(value);
    return normalized ? String(normalized).trim().slice(0, 255) : undefined;
}

function dedupeAliasKeys(shopId, eventName, eventId, payload) {
    const candidates = [['id', eventId]];
    if (eventName === 'Purchase') {
        candidates.push(
            ['checkout', payload.checkout_token],
            ['order', payload.order_id],
            ['cart', payload.cart_token],
        );
    }

    const keys = [];
    const seen = new Set();
    for (const [type, rawValue] of candidates) {
        const value = cleanKeyPart(normalizeEventId(rawValue) || rawValue);
        if (!value) continue;
        const key = `dedup-alias:${shopId}:${eventName}:${type}:${value}`;
        if (!seen.has(key)) {
            seen.add(key);
            keys.push(key);
        }
    }
    return keys;
}

async function resolveCanonicalEventId(shopId, eventName, proposedEventId, payload, ttlSeconds) {
    const aliasKeys = dedupeAliasKeys(shopId, eventName, proposedEventId, payload);
    if (aliasKeys.length === 0) return proposedEventId;

    const existing = (await redis.mget(aliasKeys)).find(Boolean);
    const canonicalEventId = existing || proposedEventId;
    await Promise.all(aliasKeys.map(key => redis.set(key, canonicalEventId, 'EX', ttlSeconds, 'NX')));
    return canonicalEventId;
}

function attributionKeys(shopId, payload) {
    const candidates = [
        ['client', firstPresent(payload.client_id, payload.shopify_y, firstScalar(payload.external_id))],
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
            keys.push(key);
        }
    }
    return keys;
}

function attributionSnapshot(payload) {
    return compactObject({
        fbp: firstPresent(payload.fbp, payload._fbp),
        fbc: firstPresent(payload.fbc, payload._fbc),
        ttp: payload.ttp,
        ttclid: payload.ttclid,
        source_url: firstPresent(payload.source_url, payload.url),
        referrer: payload.referrer,
        client_ip: payload.client_ip,
        user_agent: payload.user_agent,
        email_hash: firstPresent(payload.email_hash, payload.email_sha256, payload.em, hashUserData(firstPresent(payload.email, payload.customer_email), 'email')),
        phone_hash: firstPresent(payload.phone_hash, payload.phone_sha256, payload.ph, hashUserData(firstPresent(payload.phone, payload.customer_phone), 'phone')),
        first_name_hash: firstPresent(payload.first_name_hash, payload.fn, hashUserData(firstPresent(payload.firstName, payload.first_name, payload.customer_first_name), 'name')),
        last_name_hash: firstPresent(payload.last_name_hash, payload.ln, hashUserData(firstPresent(payload.lastName, payload.last_name, payload.customer_last_name), 'name')),
        city_hash: firstPresent(payload.city_hash, payload.ct, hashUserData(firstPresent(payload.city, payload.customer_city), 'city')),
        state_hash: firstPresent(payload.state_hash, payload.st, hashUserData(firstPresent(payload.state, payload.province, payload.province_code, payload.customer_state), 'state')),
        zip_hash: firstPresent(payload.zip_hash, payload.zp, hashUserData(firstPresent(payload.zip, payload.postal_code, payload.postalCode, payload.customer_zip), 'zip')),
        country_hash: firstPresent(payload.country_hash, payload.country_sha256, hashUserData(firstPresent(payload.country, payload.country_code, payload.customer_country), 'country')),
        client_id: firstPresent(payload.client_id, payload.shopify_y),
        external_id: payload.external_id,
        checkout_token: payload.checkout_token,
        cart_token: payload.cart_token,
        shopify_y: payload.shopify_y,
        shopify_s: payload.shopify_s,
        updated_at: Date.now(),
    });
}

async function loadAttributionSnapshot(shopId, payload) {
    const keys = attributionKeys(shopId, payload);
    if (keys.length === 0) return {};

    const values = await redis.mget(keys);
    const snapshots = values
        .filter(Boolean)
        .map(value => {
            try {
                return JSON.parse(value);
            } catch (error) {
                return {};
            }
        })
        .sort((left, right) => Number(left.updated_at || 0) - Number(right.updated_at || 0));

    return Object.assign({}, ...snapshots);
}

async function saveAttributionSnapshot(shopId, payload) {
    const keys = attributionKeys(shopId, payload);
    if (keys.length === 0) return;

    const snapshot = attributionSnapshot(payload);
    if (Object.keys(snapshot).length === 0) return;

    await Promise.all(keys.map(key => redis.set(key, JSON.stringify(snapshot), 'EX', ATTRIBUTION_TTL_SECONDS)));
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

async function insertMetaQualitySnapshot(pixel, status, rawPayload, errorMessage = null) {
    const summary = status === 'SUCCESS' ? summarizeMetaQuality(rawPayload) : null;
    await pool.query(
        `INSERT INTO meta_quality_snapshots
            (pixel_route_id, shop_id, dataset_id, status, metric_type, summary_payload, raw_payload, error_message)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
        [
            pixel.id,
            pixel.shop_id,
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
        params: {
            dataset_id: pixel.pixel_id,
            web_metric_type: META_QUALITY_METRIC_TYPE,
            access_token: token,
        },
    });
    return response.data;
}

async function refreshMetaQualityForPixel(pixel) {
    if (pixel.platform !== 'facebook') return null;

    try {
        const rawPayload = await fetchMetaQualityForPixel(pixel);
        const summary = await insertMetaQualitySnapshot(pixel, 'SUCCESS', rawPayload);
        return { pixel_id: pixel.pixel_id, status: 'SUCCESS', summary };
    } catch (error) {
        const responsePayload = error.response?.data || null;
        const message = responsePayload?.error?.message || error.message;
        await insertMetaQualitySnapshot(pixel, 'FAILED', responsePayload, message);
        return { pixel_id: pixel.pixel_id, status: 'FAILED', error: message };
    }
}

async function refreshMetaQualitySnapshots(shopId = null) {
    const params = shopId ? [shopId] : [];
    const shopFilter = shopId ? 'AND p.shop_id = $1' : '';
    const { rows: pixels } = await pool.query(
        `SELECT p.id, p.shop_id, p.platform, p.name, p.pixel_id, p.access_token, p.quality_access_token
         FROM pixels p
         JOIN shops s ON s.id = p.shop_id
         WHERE p.platform = 'facebook'
           AND s.status = 'active'
           ${shopFilter}
         ORDER BY p.id ASC`,
        params,
    );

    const results = [];
    for (const pixel of pixels) {
        results.push(await refreshMetaQualityForPixel(pixel));
    }
    return results;
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
    const externalId = primaryExternalId(payload);

    const hashed = {
        em: hashOrKeepMany([payload.email_hash, payload.email_sha256, payload.em, email], 'email'),
        ph: hashOrKeepMany([payload.phone_hash, payload.phone_sha256, payload.ph, phone], 'phone'),
        fn: hashOrKeepMany([payload.first_name_hash, payload.fn, firstName], 'name'),
        ln: hashOrKeepMany([payload.last_name_hash, payload.ln, lastName], 'name'),
        ct: hashOrKeepMany([payload.city_hash, payload.ct, city], 'city'),
        st: hashOrKeepMany([payload.state_hash, payload.st, state], 'state'),
        zp: hashOrKeepMany([payload.zip_hash, payload.zp, zip], 'zip'),
        country: hashOrKeepMany([payload.country_hash, payload.country_sha256, payload.country_hashed, country], 'country'),
        external_id: hashOrKeepMany([payload.external_id_hash, externalId], 'default'),
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
    const contents = Array.isArray(payload.contents)
        ? payload.contents
            .filter(Boolean)
            .map(item => compactObject({
                id: firstPresent(item.id, item.content_id) ? String(firstPresent(item.id, item.content_id)) : undefined,
                quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : undefined,
                item_price: Number.isFinite(Number(firstPresent(item.item_price, item.price))) ? Number(firstPresent(item.item_price, item.price)) : undefined,
            }))
            .filter(item => item.id)
        : undefined;
    const contentIds = Array.isArray(payload.content_ids)
        ? payload.content_ids.filter(Boolean).map(String)
        : contents?.map(item => String(item.id));
    const numItems = Number.isFinite(Number(payload.num_items))
        ? Number(payload.num_items)
        : contents?.reduce((sum, item) => sum + Number(item.quantity || 0), 0);

    return compactObject({
        value: payload.value !== undefined && Number.isFinite(Number(payload.value)) ? Number(payload.value) : undefined,
        currency: payload.currency ? String(payload.currency).trim().toUpperCase() : undefined,
        content_ids: contentIds?.length ? contentIds : undefined,
        contents: contents?.length ? contents : undefined,
        content_type: payload.content_type,
        content_name: payload.content_name,
        content_category: payload.content_category,
        num_items: numItems || undefined,
        order_id: payload.order_id,
        search_string: payload.search_string,
    });
}

function mergeUniqueArrays(left, right) {
    const output = [];
    const seen = new Set();
    for (const value of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
        const key = JSON.stringify(value);
        if (!seen.has(key)) {
            seen.add(key);
            output.push(value);
        }
    }
    return output.length ? output : undefined;
}

function mergeUserData(left = {}, right = {}) {
    const arrayFields = ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'external_id'];
    const merged = { ...left, ...right };
    for (const field of arrayFields) {
        merged[field] = mergeUniqueArrays(left[field], right[field]);
    }
    return compactObject({
        ...merged,
        client_ip_address: firstPresent(right.client_ip_address, left.client_ip_address),
        client_user_agent: firstPresent(right.client_user_agent, left.client_user_agent),
        fbc: firstPresent(right.fbc, left.fbc),
        fbp: firstPresent(right.fbp, left.fbp),
    });
}

function mergeCustomData(left = {}, right = {}) {
    return compactObject({
        ...left,
        ...right,
        content_ids: mergeUniqueArrays(left.content_ids, right.content_ids),
        contents: Array.isArray(right.contents) && right.contents.length ? right.contents : left.contents,
        value: firstPresent(right.value, left.value),
        currency: firstPresent(right.currency, left.currency),
        order_id: firstPresent(right.order_id, left.order_id),
        num_items: firstPresent(right.num_items, left.num_items),
    });
}

function mergePlatformData(left = {}, right = {}) {
    return compactObject({
        ...left,
        ...right,
        tiktok: compactObject({
            ...(left.tiktok || {}),
            ...(right.tiktok || {}),
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
    merged._quality = { missing_match_signals: missingMatchSignals(mergedUserData) };
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
    const fromPayload = Date.parse(payload.timestamp);
    if (!Number.isFinite(fromPayload)) return now;

    const seconds = Math.floor(fromPayload / 1000);
    const sevenDays = 7 * 24 * 60 * 60;
    if (seconds > now + 300) return now;
    if (seconds < now - sevenDays) return now;
    return seconds;
}

function buildQueueJobId(shopId, dbEvents) {
    const ids = dbEvents.map(event => String(event.id)).sort().join('|');
    const digest = crypto.createHash('sha256').update(`${shopId}|${ids}`).digest('hex').slice(0, 32);
    return `send-${shopId}-${digest}`;
}

async function queueStalePendingEvents() {
    const { rows } = await pool.query(
        `SELECT e.id, e.shop_id, e.request_payload, e.status, e.fb_response
         FROM event_store e
         JOIN shops s ON s.id = e.shop_id
         WHERE e.status = 'PENDING'
           AND s.status = 'active'
           AND e.timestamp < NOW() - ($1::int * INTERVAL '1 minute')
         ORDER BY e.shop_id ASC, e.id ASC
         LIMIT $2`,
        [config.stalePendingMinutes, config.batchSize],
    );
    if (rows.length === 0) return 0;

    const byShop = new Map();
    for (const row of rows) {
        const events = byShop.get(row.shop_id) || [];
        events.push(row);
        byShop.set(row.shop_id, events);
    }

    let queued = 0;
    for (const [shopId, dbEvents] of byShop.entries()) {
        await capiQueue.add(
            'send-fb-batch',
            { shopId, dbEvents },
            { jobId: buildQueueJobId(shopId, dbEvents) },
        );
        queued += dbEvents.length;
    }
    return queued;
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
        const { rows } = await pool.query(
            `INSERT INTO event_store (shop_id, event_name, event_id, status, emq_estimate, request_payload, fb_response)
             VALUES ($1, $2, $3, 'PENDING', $4, $5::jsonb, NULL)
             ON CONFLICT (shop_id, event_name, md5(event_id)) DO UPDATE SET
                 status = 'PENDING',
                 request_payload = EXCLUDED.request_payload,
                 emq_estimate = COALESCE(event_store.emq_estimate, EXCLUDED.emq_estimate),
                 fb_response = NULL
             WHERE event_store.status <> 'SUCCESS'
             RETURNING id, request_payload, status, fb_response`,
            [shopId, eventName, eventId, emqEstimate, JSON.stringify(payload)],
        );
        restored.push(...rows);
    }
    return restored;
}

async function queueEventForOutbox(req, payload, shopId) {
    const eventName = requireBoundedString(payload.event_name, 'event_name', 50);
    const proposedEventId = normalizeEventId(payload.event_id) || `${eventName}_${crypto.randomUUID()}`;
    const attribution = await loadAttributionSnapshot(shopId, payload);
    const enrichedPayload = { ...attribution, ...payload };
    const ttlSeconds = eventName === 'Purchase' ? PURCHASE_DEDUPE_TTL_SECONDS : DEDUPE_TTL_SECONDS;
    const eventId = await resolveCanonicalEventId(shopId, eventName, proposedEventId, enrichedPayload, ttlSeconds);
    const dedupKey = `dedup:${shopId}:${eventName}:${eventId}`;

    await saveAttributionSnapshot(shopId, enrichedPayload);
    const isNew = await redis.set(dedupKey, '1', 'EX', ttlSeconds, 'NX');
    if (!isNew && eventName !== 'Purchase') {
        return { statusCode: 200, body: { success: true, deduplicated: true, event_id: eventId } };
    }

    const userData = buildUserData(req, enrichedPayload);
    const fbEventData = {
        event_name: eventName,
        event_time: resolveEventTime(enrichedPayload),
        action_source: normalizeActionSource(enrichedPayload.action_source),
        event_id: eventId,
        event_source_url: eventSourceUrlForPayload(req, enrichedPayload),
        user_data: userData,
        custom_data: buildCustomData(enrichedPayload),
        _emq_estimate: calculateEMQ(userData),
        _quality: { missing_match_signals: missingMatchSignals(userData) },
        _platform_data: buildPlatformData(enrichedPayload),
        _duplicate_candidate: !isNew,
        _attribution_enriched: Object.keys(attribution).length > 0,
        _received_at: Date.now(),
    };

    try {
        await redis.rpush(`pending:events:${shopId}`, JSON.stringify(fbEventData));
    } catch (error) {
        if (isNew) await redis.del(dedupKey).catch(() => {});
        throw error;
    }

    return { statusCode: 202, body: { success: true, queued: true, event_id: eventId, duplicate_candidate: !isNew } };
}

async function queueForOutbox(req, res, payload, shopId) {
    const result = await queueEventForOutbox(req, payload, shopId);
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

    const normalizedPayloads = payloads.map(payload => ({
        ...payload,
        shop_domain: normalizeShopDomain(payload.shop_domain) || shopDomain,
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
        return queueForOutbox(req, res, { ...normalizedPayloads[0], shop_domain: shopDomain }, rows[0].id);
    }

    const results = [];
    for (const payload of normalizedPayloads) {
        const result = await queueEventForOutbox(req, { ...payload, shop_domain: shopDomain }, rows[0].id);
        results.push(result.body);
    }

    const queued = results.filter(result => result.queued).length;
    const deduplicated = results.filter(result => result.deduplicated).length;
    return res.status(queued > 0 ? 202 : 200).json({
        success: true,
        batch: true,
        received: normalizedPayloads.length,
        queued,
        deduplicated,
        results,
    });
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

    const appSecret = decryptTokenIfPossible(rows[0].app_secret);
    const generatedHash = crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('base64');
    if (!timingSafeCompare(generatedHash, hmacHeader)) return res.status(401).send('HMAC Failed');

    let deliveryKey;
    if (webhookId) {
        deliveryKey = `shopify:webhook:${shopDomain}:${webhookId}`;
        const isNewDelivery = await redis.set(deliveryKey, '1', 'EX', 7 * 24 * 60 * 60, 'NX');
        if (!isNewDelivery) return res.status(200).json({ success: true, duplicate_webhook: true });
    }

    const order = req.body || {};
    const payload = buildShopifyOrderPurchasePayload(order, shopDomain);

    try {
        return await queueForOutbox(req, res, payload, rows[0].id);
    } catch (error) {
        if (deliveryKey) await redis.del(deliveryKey).catch(() => {});
        throw error;
    }
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
    try {
        const { rows: shops } = await pool.query("SELECT id FROM shops WHERE status = 'active'");
        for (const shop of shops) {
            const lockKey = `lock:batch_packing:${shop.id}`;
            const lockToken = crypto.randomUUID();
            const lock = await redis.set(lockKey, lockToken, 'EX', 55, 'NX');
            if (!lock) continue;

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
                const shopIds = [];
                const eventNames = [];
                const eventIds = [];
                const statuses = [];
                const emqs = [];
                const payloads = [];

                mergedReadyEvents.forEach(event => {
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
                    const jobId = buildQueueJobId(shop.id, eventsToSend);
                    await capiQueue.add('send-fb-batch', { shopId: shop.id, dbEvents: eventsToSend }, { jobId });
                }

                await completeProcessingBatch(processingKey, pendingKey, deferredEvents);
                await redis.del(heartbeatKey);
            } finally {
                await releaseRedisLock(lockKey, lockToken);
            }
        }
    } catch (error) {
        console.error('Outbox pack error:', error);
    }
});

cron.schedule(config.watchdogCron, async () => {
    try {
        const { rows: shops } = await pool.query('SELECT id FROM shops');
        for (const shop of shops) {
            const lockKey = `lock:watchdog:${shop.id}`;
            const lockToken = crypto.randomUUID();
            const lock = await redis.set(lockKey, lockToken, 'EX', 50, 'NX');
            if (!lock) continue;

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
                await releaseRedisLock(lockKey, lockToken);
            }
        }
    } catch (error) {
        console.error('Watchdog error:', error);
    }
});

cron.schedule(config.watchdogCron, async () => {
    const lockKey = 'lock:stale_pending_rescue';
    const lockToken = crypto.randomUUID();
    try {
        const lock = await redis.set(lockKey, lockToken, 'EX', 50, 'NX');
        if (!lock) return;

        const queued = await queueStalePendingEvents();
        if (queued > 0) console.warn(`[Watchdog] re-queued ${queued} stale pending events`);
    } catch (error) {
        console.error('Stale pending rescue error:', error);
    } finally {
        await releaseRedisLock(lockKey, lockToken).catch(() => {});
    }
});

cron.schedule(config.metaQualityCron, async () => {
    const lockKey = 'lock:meta_quality_refresh';
    const lockToken = crypto.randomUUID();
    try {
        const lock = await redis.set(lockKey, lockToken, 'EX', 300, 'NX');
        if (!lock) return;

        const results = await refreshMetaQualitySnapshots();
        const failed = results.filter(result => result?.status === 'FAILED').length;
        if (results.length > 0) {
            console.warn(`[MetaQuality] refreshed ${results.length} dataset quality snapshots${failed ? `, ${failed} failed` : ''}`);
        }
    } catch (error) {
        console.error('Meta quality refresh error:', error);
    } finally {
        await releaseRedisLock(lockKey, lockToken).catch(() => {});
    }
});

const authMw = basicAuth({
    users: { [config.adminUsername]: config.adminPassword },
    challenge: true,
});

app.use('/admin', adminLimiter, authMw);
app.use('/api/admin', adminLimiter, authMw);

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
    const shopDomain = requireMyshopifyDomain(req.body.shop_domain);
    const appSecret = requireBoundedString(req.body.app_secret, 'app_secret', 2048);

    await pool.query(
        `INSERT INTO shops (shop_domain, app_secret)
         VALUES ($1, $2)
         ON CONFLICT (shop_domain) DO UPDATE SET app_secret = EXCLUDED.app_secret, status = 'active'`,
        [shopDomain, encryptToken(appSecret)],
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
        SELECT p.id, p.shop_id, s.shop_domain, p.platform, p.name, p.pixel_id, p.test_event_code,
               (p.quality_access_token IS NOT NULL AND p.quality_access_token <> '') AS has_quality_token
        FROM pixels p
        JOIN shops s ON p.shop_id = s.id
        ORDER BY p.id DESC
    `);
    res.json(rows);
}));

app.post('/api/admin/pixels', asyncHandler(async (req, res) => {
    const shopId = Number(req.body.shop_id);
    const platform = String(req.body.platform || 'facebook').trim().toLowerCase();
    const pixelId = requireBoundedString(req.body.pixel_id, 'pixel_id', 64);
    const name = optionalBoundedString(req.body.name, 'name', 100) || `${platform}-${pixelId.slice(-6)}`;
    const accessToken = requireBoundedString(req.body.access_token, 'access_token', 10000);
    const qualityAccessToken = optionalBoundedString(req.body.quality_access_token, 'quality_access_token', 10000);
    const testEventCode = optionalBoundedString(req.body.test_event_code, 'test_event_code', 100);
    if (!Number.isInteger(shopId) || shopId <= 0) return res.status(400).json({ error: 'Invalid shop_id' });
    if (!['facebook', 'tiktok'].includes(platform)) return res.status(400).json({ error: 'Unsupported platform' });

    const shopResult = await pool.query(
        'SELECT id FROM shops WHERE id = $1 AND status = $2',
        [shopId, 'active'],
    );
    if (shopResult.rowCount === 0) {
        return res.status(400).json({ error: 'Shop not found or inactive. Save an active shop before adding a Pixel route.' });
    }

    const { rows } = await pool.query(
        `INSERT INTO pixels (shop_id, platform, name, pixel_id, access_token, quality_access_token, test_event_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [shopId, platform, name, pixelId, encryptToken(accessToken), qualityAccessToken ? encryptToken(qualityAccessToken) : null, testEventCode],
    );
    res.status(201).json({ success: true, id: rows[0].id });
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
               e.request_payload->'_quality' AS quality, e.fb_response, e.timestamp
        FROM event_store e
        JOIN shops s ON e.shop_id = s.id
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
    const pixelFilter = shopId ? 'WHERE shop_id = $1' : '';
    const dlqShopFilter = shopId ? ' AND shop_id = $1' : '';
    const [
        statusResult,
        emqResult,
        signalResult,
        officialQualityResult,
        dlqResult,
        shopsResult,
        pixelsResult,
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
            SELECT DISTINCT ON (m.pixel_route_id)
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
            ORDER BY m.pixel_route_id, m.fetched_at DESC
        `, params),
        pool.query(`SELECT COUNT(*)::int AS count FROM dead_letters WHERE status = 'FAILED_PERMANENT'${dlqShopFilter}`, params),
        pool.query(`SELECT COUNT(*)::int AS count FROM shops WHERE status = 'active'${shopFilter}`, params),
        pool.query(`SELECT platform, COUNT(*)::int AS count FROM pixels ${pixelFilter} GROUP BY platform`, params),
        capiQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
    ]);

    const { rows: shops } = await pool.query(`SELECT id FROM shops WHERE status = 'active'${shopFilter}`, params);
    const pendingByShop = [];
    for (const shop of shops) {
        const pending = await redis.llen(`pending:events:${shop.id}`);
        const processing = await redis.llen(`processing:events:${shop.id}`);
        if (pending || processing) pendingByShop.push({ shop_id: shop.id, pending, processing });
    }

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
        active_shops: shopsResult.rows[0]?.count || 0,
        pixels_by_platform: pixelsResult.rows,
        dead_letters: dlqResult.rows[0]?.count || 0,
        queue: queueCounts,
        redis_pending: pendingByShop,
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
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    const params = ids.length ? [ids] : [];
    const query = ids.length
        ? "SELECT id, shop_id, payload FROM dead_letters WHERE status = 'FAILED_PERMANENT' AND id = ANY($1::bigint[])"
        : "SELECT id, shop_id, payload FROM dead_letters WHERE status = 'FAILED_PERMANENT'";
    const { rows } = await pool.query(query, params);

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
                { shopId: row.shop_id, dbEvents: replayEvents },
                { jobId: buildQueueJobId(row.shop_id, replayEvents) },
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
    const statusCode = err.statusCode || 500;
    if (err.code === '42501') {
        console.error(err);
        return res.status(500).json({
            error: 'Database permission denied. Grant the app database user privileges on shops, pixels, event_store, dead_letters, and their sequences.',
            code: err.code,
        });
    }
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
