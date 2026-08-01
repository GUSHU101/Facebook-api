const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

process.env.DATABASE_URL ||= 'postgres://user:pass@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.AES_SECRET_KEY ||= 'test-secret-key-with-at-least-32-chars';
process.env.ADMIN_USERNAME ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'password';

const {
    buildCustomData,
    metaCustomerSegmentation,
    missingCommerceSignals,
    normalizeEventId,
    stripPrivateFields,
    tenantScopedExternalId,
    tenantScopedIdentifier,
} = require('../src/events/common');
const {
    buildShopifyOrderPurchasePayload,
    discountedUnitPrice,
    paidOrderIgnoreReason,
    shopifyCustomerLifecycle,
    shopifyPaymentTimestamp,
} = require('../src/events/shopify');
const {
    browserAttributionIdentity,
    buildBrowserAttributionSnapshot,
    buildCommerceAttributionSnapshot,
    sanitizeStoredAttribution,
    snapshotForAttributionKey,
} = require('../src/events/attribution');
const { mergePersistedEventPayload } = require('../src/events/merge');
const { FUNNEL_EVENT_NAMES, decorateFunnelSummary } = require('../src/events/funnel');
const { eventHasSuccessfulDelivery, shouldSkipPixel, successfulDeliveryKeys } = require('../src/platforms/delivery');
const { aggregateDeliveryStatus, retryDelaySeconds } = require('../src/platforms/delivery-state');
const {
    isolateMetaBatch,
    normalizeMetaCookie,
    prepareMetaEvent,
    sanitizeMetaCustomData,
    sanitizeMetaUserData,
    validateMetaEvent,
} = require('../src/platforms/meta');
const {
    buildMetaQualityRequestParams,
    summarizeMetaQuality,
} = require('../src/platforms/meta-quality');
const {
    classifyFacebookError,
    metaRateControlFromHeaders,
    parseRetryAfterSeconds,
    retryDelayWithJitterSeconds,
    shouldIsolateFacebookError,
} = require('../src/platforms/rate-control');
const { buildTikTokPayload, tiktokEventName } = require('../src/platforms/tiktok');
const { missingMatchSignals } = require('../src/utils/emq');
const { parseJsonPreservingLargeIntegers } = require('../src/utils/json');
const { enqueueReschedulableJob } = require('../src/utils/queue');
const { createTrackedCronScheduler } = require('../src/utils/scheduler');
const { consumeWeightedWindow } = require('../src/utils/weighted-rate-limit');
const {
    boundedScalarValues,
    collectHashedUserData,
    credentialFingerprint,
    decryptTokenIfPossible,
    encryptToken,
    normalizeForHash,
    timingSafeStringCompare,
} = require('../src/utils/crypto');

function probeConfig(environment = {}) {
    return spawnSync(
        process.execPath,
        ['-e', "process.stdout.write(JSON.stringify(require('./src/config')))"],
        {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            env: {
                ...process.env,
                DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/test',
                REDIS_URL: 'redis://127.0.0.1:6379',
                AES_SECRET_KEY: 'test-secret-key-with-at-least-32-chars',
                ADMIN_USERNAME: 'admin',
                ADMIN_PASSWORD: 'password',
                ...environment,
            },
        },
    );
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function hashFor(value, type = 'default', context = {}) {
    const normalized = normalizeForHash(value, type, context);
    return normalized ? crypto.createHash('sha256').update(normalized).digest('hex') : undefined;
}

test('external IDs are stable within a shop and isolated across shops sharing a dataset', () => {
    const shopA = tenantScopedExternalId('alpha.myshopify.com', 'gid://shopify/Customer/123');
    const shopARepeat = tenantScopedExternalId('ALPHA.MYSHOPIFY.COM', '123');
    const shopB = tenantScopedExternalId('beta.myshopify.com', '123');

    assert.equal(shopA, shopARepeat);
    assert.notEqual(shopA, shopB);
    assert.match(shopA, /^[a-f0-9]{64}$/);
    assert.equal(tenantScopedExternalId('', '123'), undefined);
    assert.equal(tenantScopedIdentifier('alpha.myshopify.com', 'gid://shopify/Order/123'), 'alpha.myshopify.com:123');
    assert.equal(tenantScopedIdentifier('ALPHA.MYSHOPIFY.COM', 'alpha.myshopify.com:123'), 'alpha.myshopify.com:123');
    assert.equal(tenantScopedIdentifier('alpha.myshopify.com', 'ALPHA.MYSHOPIFY.COM:123'), 'alpha.myshopify.com:123');
    assert.notEqual(
        tenantScopedIdentifier('alpha.myshopify.com', 'same-event'),
        tenantScopedIdentifier('beta.myshopify.com', 'same-event'),
    );
});

test('Meta Dataset Quality requests and composite scores follow the current official contract', () => {
    assert.deepEqual(buildMetaQualityRequestParams('1234567890'), {
        dataset_id: '1234567890',
        fields: 'web{event_name,event_match_quality,event_coverage,dedup_key_feedback,data_freshness,acr}',
    });
    assert.deepEqual(buildMetaQualityRequestParams('1234567890', 'DataPartner'), {
        dataset_id: '1234567890',
        fields: 'web{event_name,event_match_quality,event_coverage,dedup_key_feedback,data_freshness,acr}',
        agent_name: 'datapartner',
    });

    const summary = summarizeMetaQuality({
        web: [{
            event_name: 'Purchase',
            event_match_quality: {
                composite_score: 8.7,
                match_key_feedback: [{ match_key: 'em', status: 'GOOD' }],
            },
            event_coverage: { coverage: 0.91 },
            dedup_key_feedback: { event_id: 'GOOD' },
            data_freshness: { delay_seconds: 4 },
            acr: { score: 0.8 },
        }],
    });
    assert.equal(summary.average_score, 8.7);
    assert.equal(summary.events[0].event_name, 'Purchase');
    assert.equal(summary.events[0].score, 8.7);
    assert.deepEqual(summary.events[0].match_key_feedback, [{ match_key: 'em', status: 'GOOD' }]);
    assert.deepEqual(summary.events[0].dedup_key_feedback, { event_id: 'GOOD' });
});

test('customer lifecycle is sent only as Meta custom_data customer_segmentation', () => {
    assert.equal(metaCustomerSegmentation('new_customer'), 'new_customer_to_business');
    assert.equal(metaCustomerSegmentation('existing_customer'), 'existing_customer_to_business');
    assert.equal(metaCustomerSegmentation('unknown'), undefined);
    assert.equal(buildCustomData({ customer_lifecycle: 'new_customer' }).customer_segmentation, 'new_customer_to_business');
    assert.equal(
        sanitizeMetaCustomData({ customer_segmentation: 'existing_customer_to_business' }, 'Purchase').customer_segmentation,
        'existing_customer_to_business',
    );
    assert.equal(sanitizeMetaCustomData({ customer_segmentation: 'invented' }, 'Purchase').customer_segmentation, undefined);
});

test('attribution cache cannot leak customer or checkout identity across browser sessions', () => {
    const payload = {
        fbp: 'fb.1.real-browser',
        fbc: 'fb.1.real-click',
        client_id: 'browser-client-1',
        shopify_s: 'session-1',
        email: 'buyer@example.com',
        phone: '+1 212 555 1212',
        external_id: 'customer-777',
        checkout_token: 'checkout-old',
        cart_token: 'cart-old',
        updated_at: 1234,
    };

    const browserSnapshot = buildBrowserAttributionSnapshot(payload);
    assert.equal(browserSnapshot.fbp, 'fb.1.real-browser');
    assert.equal(browserSnapshot.client_id, 'browser-client-1');
    assert.equal(browserSnapshot.email_hash, undefined);
    assert.equal(browserSnapshot.phone_hash, undefined);
    assert.equal(browserSnapshot.external_id, undefined);
    assert.equal(browserSnapshot.checkout_token, undefined);
    assert.equal(browserSnapshot.cart_token, undefined);
    assert.equal(browserAttributionIdentity({ external_id: 'customer-777' }), undefined);
    assert.equal(browserAttributionIdentity(payload), 'browser-client-1');

    const commerceSnapshot = buildCommerceAttributionSnapshot(payload);
    assert.match(commerceSnapshot.email_hash[0], /^[a-f0-9]{64}$/);
    assert.match(commerceSnapshot.phone_hash[0], /^[a-f0-9]{64}$/);
    assert.equal(commerceSnapshot.external_id, 'customer-777');
    assert.equal(commerceSnapshot.checkout_token, 'checkout-old');
    assert.equal(commerceSnapshot.cart_token, 'cart-old');

    // Old deployments may still have a full snapshot under a client/session
    // key. Reads must strip those unsafe fields immediately, before TTL expiry.
    const sanitizedLegacyClient = sanitizeStoredAttribution(commerceSnapshot, 'client');
    assert.equal(sanitizedLegacyClient.email_hash, undefined);
    assert.equal(sanitizedLegacyClient.external_id, undefined);
    assert.equal(sanitizedLegacyClient.checkout_token, undefined);
    assert.equal(sanitizedLegacyClient.cart_token, undefined);
    const sessionSnapshot = snapshotForAttributionKey(payload, 'session');
    const checkoutSnapshot = snapshotForAttributionKey(payload, 'checkout');
    assert.equal(sessionSnapshot.fbp, browserSnapshot.fbp);
    assert.equal(sessionSnapshot.external_id, undefined);
    assert.ok(sessionSnapshot.updated_at >= Date.now() - 1000);
    assert.equal(checkoutSnapshot.external_id, commerceSnapshot.external_id);
    assert.ok(checkoutSnapshot.updated_at >= Date.now() - 1000);
});

test('attribution cache rejects fake pre-hashes and applies country-aware normalization', () => {
    const snapshot = buildCommerceAttributionSnapshot({
        email_hash: 'not-a-sha256-hash',
        email: 'Buyer@Example.com',
        state: 'California',
        zip: '94035-1234',
        country: 'US',
    });
    assert.deepEqual(snapshot.email_hash, [hashFor('Buyer@Example.com', 'email')]);
    assert.equal(snapshot.state_hash, undefined);
    assert.deepEqual(snapshot.zip_hash, [hashFor('94035-1234', 'zip', { country: 'US' })]);
    assert.deepEqual(collectHashedUserData(['invalid'], ['buyer@example.com'], 'email'), [
        hashFor('buyer@example.com', 'email'),
    ]);
    assert.deepEqual(boundedScalarValues([['a'], { malicious: true }, ['b', ['c']]]), ['a', 'b', 'c']);
});

test('confirmed Purchase data cannot be downgraded by a later browser duplicate', () => {
    const confirmed = {
        event_name: 'Purchase',
        event_id: 'purchase-order-1001',
        event_time: 200,
        event_source_url: 'https://shop.example/checkouts/complete',
        user_data: {
            em: ['confirmed-email'],
            ph: ['confirmed-phone'],
            fbp: 'fb.1.confirmed-browser',
        },
        custom_data: {
            value: 100,
            currency: 'USD',
            order_id: '1001',
            content_ids: ['paid-item'],
            contents: [{ id: 'paid-item', quantity: 1, item_price: 100 }],
        },
        _received_at: 2000,
        _requires_payment_confirmation: true,
        _payment_confirmed: true,
    };
    const browserDuplicate = {
        event_name: 'Purchase',
        event_id: 'purchase-order-1001',
        event_time: 100,
        event_source_url: 'https://shop.example/checkouts/complete?utm_source=facebook',
        user_data: {
            em: ['browser-email'],
            fbp: 'fb.1.late-browser',
        },
        custom_data: {
            value: 80,
            currency: 'USD',
            content_ids: ['removed-item'],
            contents: [{ id: 'removed-item', quantity: 1, item_price: 80 }],
        },
        referrer_url: 'https://www.facebook.com/',
        opt_out: true,
        _received_at: 1000,
        _requires_payment_confirmation: true,
        _payment_confirmed: false,
    };

    const merged = mergePersistedEventPayload(confirmed, browserDuplicate);
    assert.equal(merged.event_time, 200);
    assert.equal(merged.custom_data.value, 100);
    assert.equal(merged.custom_data.order_id, '1001');
    assert.deepEqual(merged.custom_data.content_ids, ['paid-item']);
    assert.deepEqual(merged.custom_data.contents, [{ id: 'paid-item', quantity: 1, item_price: 100 }]);
    assert.equal(merged.user_data.fbp, 'fb.1.confirmed-browser');
    assert.deepEqual(merged.user_data.em, ['browser-email', 'confirmed-email']);
    assert.deepEqual(merged.user_data.ph, ['confirmed-phone']);
    assert.equal(merged._payment_confirmed, true);
    assert.equal(merged.referrer_url, 'https://www.facebook.com/');
    assert.equal(merged.opt_out, true);
    assert.equal(merged._received_at, 1000);
});

test('payment-confirmed duplicate upgrades an awaiting Purchase without losing browser identity', () => {
    const browser = {
        event_name: 'Purchase',
        event_time: 100,
        user_data: { em: ['browser-email'], fbp: 'fb.1.browser' },
        custom_data: { value: 80, currency: 'USD' },
        _payment_confirmed: false,
    };
    const paidWebhook = {
        event_name: 'Purchase',
        event_time: 200,
        user_data: { em: ['paid-email'], ph: ['paid-phone'] },
        custom_data: { value: 100, currency: 'USD', order_id: '1001' },
        _payment_confirmed: true,
    };

    const merged = mergePersistedEventPayload(browser, paidWebhook);
    assert.equal(merged.event_time, 200);
    assert.equal(merged.custom_data.value, 100);
    assert.equal(merged.custom_data.order_id, '1001');
    assert.equal(merged.user_data.fbp, 'fb.1.browser');
    assert.deepEqual(merged.user_data.em, ['browser-email', 'paid-email']);
    assert.equal(merged._payment_confirmed, true);
});

test('buildShopifyOrderPurchasePayload extracts purchase identifiers and product contents', () => {
    const payload = buildShopifyOrderPurchasePayload({
        id: 987,
        name: '#1001',
        checkout_token: 'checkout-token-1',
        email: 'Buyer@Example.com',
        phone: '+12125551212',
        current_total_price: '46.00',
        currency: 'USD',
        landing_site: '/products/socks?fbclid=fb-click-1&ttclid=tt-click-1',
        created_at: '2026-06-23T08:00:00Z',
        browser_ip: '203.0.113.10',
        client_details: { user_agent: 'Mozilla/5.0', fbp: 'fb.1.browser' },
        billing_address: {
            first_name: 'Ada',
            last_name: 'Lovelace',
            city: 'London',
            province_code: 'LND',
            zip: 'E1 1AA',
            country_code: 'GB',
        },
        note_attributes: [
            { name: '_ttp', value: 'ttp-cookie' },
            { name: '_shopify_y', value: 'shopify-y-cookie' },
        ],
        customer: { id: 12345, orders_count: 1 },
        line_items: [
            { variant_id: 111, quantity: 2, price: '8.00' },
            { product_id: 222, quantity: 1, price: '30.00' },
        ],
    }, 'demo.myshopify.com', {
        nowMs: 1234567890,
        eventTimestamp: '2026-06-23T08:05:00Z',
    });

    assert.equal(payload.event_name, 'Purchase');
    assert.equal(payload.action_source, 'website');
    assert.equal(payload.event_id, 'demo.myshopify.com:checkout-token-1');
    assert.equal(payload.source_url, 'https://demo.myshopify.com/products/socks?fbclid=fb-click-1&ttclid=tt-click-1');
    assert.equal(payload.fbp, 'fb.1.browser');
    assert.equal(payload.fbc, 'fb.1.1234567890000.fb-click-1');
    assert.equal(normalizeMetaCookie(payload.fbc), payload.fbc);
    assert.equal(payload.ttp, 'ttp-cookie');
    assert.equal(payload.ttclid, 'tt-click-1');
    assert.equal(payload.client_id, 'shopify-y-cookie');
    assert.equal(payload.checkout_token, 'checkout-token-1');
    assert.equal(payload._shopify_order_id, '987');
    assert.equal(payload.shopify_y, 'shopify-y-cookie');
    assert.equal(payload.external_id, '12345');
    assert.deepEqual(payload.content_ids, ['111', '222']);
    assert.deepEqual(payload.contents, [
        { id: '111', quantity: 2, item_price: 8 },
        { id: '222', quantity: 1, item_price: 30 },
    ]);
    assert.equal(payload.num_items, 3);
    assert.equal(payload.order_id, '#1001');
    assert.equal(payload.customer_lifecycle, 'new_customer');
    assert.equal(payload.timestamp, '2026-06-23T08:05:00Z');
});

test('Shopify customer lifecycle uses explicit first-order state before order count', () => {
    assert.equal(shopifyCustomerLifecycle({ isFirstOrder: true, orders_count: 5 }), 'new_customer');
    assert.equal(shopifyCustomerLifecycle({ isFirstOrder: false, orders_count: 1 }), 'existing_customer');
    assert.equal(shopifyCustomerLifecycle({ orders_count: 1 }), 'new_customer');
    assert.equal(shopifyCustomerLifecycle({ orders_count: 2 }), 'existing_customer');
    assert.equal(shopifyCustomerLifecycle({}), undefined);
});

test('Shopify reconciliation uses the latest successful sale or capture time', () => {
    assert.equal(shopifyPaymentTimestamp({
        createdAt: '2026-06-20T00:00:00Z',
        processedAt: '2026-06-20T00:05:00Z',
        updatedAt: '2026-06-23T09:00:00Z',
        transactions: [
            { kind: 'AUTHORIZATION', status: 'SUCCESS', processedAt: '2026-06-20T00:04:00Z' },
            { kind: 'CAPTURE', status: 'FAILURE', processedAt: '2026-06-22T08:00:00Z' },
            { kind: 'CAPTURE', status: 'SUCCESS', processedAt: '2026-06-22T10:00:00Z' },
            { kind: 'SALE', status: 'SUCCESS', createdAt: '2026-06-22T11:00:00Z' },
        ],
    }), '2026-06-22T11:00:00Z');
    assert.equal(shopifyPaymentTimestamp({
        processed_at: '2026-06-20T00:05:00Z',
        updated_at: '2026-06-23T09:00:00Z',
        transactions: [],
    }), '2026-06-23T09:00:00Z');
});

test('buildShopifyOrderPurchasePayload normalizes Shopify GIDs for Purchase dedupe fallback', () => {
    const payload = buildShopifyOrderPurchasePayload({
        id: 'gid://shopify/Order/987',
        email: 'buyer@example.com',
        current_total_price: '46.00',
        currency: 'USD',
        line_items: [],
    }, 'demo.myshopify.com');

    assert.equal(payload.event_id, 'demo.myshopify.com:987');
    assert.equal(payload.order_id, '987');
    assert.equal(payload.external_id, '987');
});

test('authenticated Shopify identifiers outrank storefront-controlled event attributes', () => {
    const payload = buildShopifyOrderPurchasePayload({
        id: 987,
        checkout_token: 'checkout-trusted',
        name: '#1001',
        note_attributes: [{ name: 'event_id', value: 'reused-by-many-orders' }],
        created_at: '2026-06-23T08:00:00Z',
        landing_site: '/?fbclid=actual-click',
        current_total_price: '10.00',
        currency: 'USD',
        line_items: [],
    }, 'demo.myshopify.com');
    assert.equal(payload.event_id, 'demo.myshopify.com:checkout-trusted');
    assert.equal(payload.fbc, `fb.1.${Date.parse('2026-06-23T08:00:00Z')}.actual-click`);
});

test('Shopify webhook source URL never leaks an external referrer or private status URL', () => {
    const payload = buildShopifyOrderPurchasePayload({
        id: 987,
        current_total_price: '10.00',
        currency: 'USD',
        referring_site: 'https://search.example/landing',
        order_status_url: 'https://demo.myshopify.com/orders/private/auth-token',
    }, 'demo.myshopify.com');
    assert.equal(payload.source_url, 'https://demo.myshopify.com');
});

test('Shopify paid-order rules exclude test and explicit non-web orders', () => {
    assert.equal(paidOrderIgnoreReason({ test: true, source_name: 'web' }), 'test_order');
    assert.equal(paidOrderIgnoreReason({ source_name: 'pos' }), 'non_web_order_source:pos');
    assert.equal(paidOrderIgnoreReason({ source_name: 'mobile_app' }), 'non_web_order_source:mobile_app');
    assert.equal(paidOrderIgnoreReason({ source_name: 'iphone' }), 'non_web_order_source:iphone');
    assert.equal(paidOrderIgnoreReason({ source_name: 'android' }), 'non_web_order_source:android');
    assert.equal(paidOrderIgnoreReason({ source_name: 'shopify_draft_order' }), 'non_web_order_source:shopify_draft_order');
    assert.equal(paidOrderIgnoreReason({ source_name: 'web' }), undefined);
    assert.equal(paidOrderIgnoreReason({}), 'missing_order_source');
    assert.equal(paidOrderIgnoreReason({ source_name: '1234567' }), 'non_web_order_source:1234567');
    assert.equal(paidOrderIgnoreReason({ source_name: '1234567' }, ['web', '1234567']), undefined);
});

test('Shopify order content unit price reflects allocated discounts', () => {
    assert.equal(discountedUnitPrice({ price: '20.00', total_discount: '10.00' }, 2), 15);
    assert.equal(discountedUnitPrice({ price: '20.00', discount_allocations: [{ amount: '6.00' }] }, 2), 17);
    assert.equal(discountedUnitPrice({ price: '20.00', total_discount: '2.00', discount_allocations: [{ amount: '6.00' }] }, 2), 17);
    assert.equal(discountedUnitPrice({ price: '20.00', discounted_price: '12.50', total_discount: '99.00' }, 2), 12.5);
});

test('Shopify Purchase never reports an order line ID as a catalog content ID', () => {
    const payload = buildShopifyOrderPurchasePayload({
        id: 987,
        current_total_price: '10.00',
        currency: 'USD',
        line_items: [{ id: 'gid://shopify/LineItem/ephemeral', quantity: 1, price: '10.00' }],
    }, 'demo.myshopify.com');
    assert.deepEqual(payload.content_ids, []);
    assert.deepEqual(payload.contents, []);
});

test('Shopify Purchase payload never invents a random dedupe identity', () => {
    const payload = buildShopifyOrderPurchasePayload({
        current_total_price: '10.00',
        currency: 'USD',
        line_items: [],
    }, 'demo.myshopify.com');
    assert.equal(payload.event_id, undefined);
});

test('Shopify webhook JSON preserves 64-bit commerce identifiers exactly', () => {
    const parsed = parseJsonPreservingLargeIntegers(
        '{"id":9007199254740993,"line_items":[{"product_id":9223372036854775807,"quantity":2}]}',
    );
    assert.equal(parsed.id, '9007199254740993');
    assert.equal(parsed.line_items[0].product_id, '9223372036854775807');
    assert.equal(parsed.line_items[0].quantity, 2);
    assert.throws(
        () => parseJsonPreservingLargeIntegers('{"id":1,"id":2}'),
        error => /Duplicate key/.test(String(error?.message)),
    );
});

test('Shopify reconciliation preserves website action source for recovered online orders', () => {
    const payload = buildShopifyOrderPurchasePayload({
        _reconciled: true,
        id: 'gid://shopify/Order/9007199254740993',
        name: '#9001',
        financial_status: 'paid',
        source_name: 'web',
        current_total_price: '25.00',
        currency: 'USD',
        processed_at: '2026-07-26T01:00:00Z',
        current_subtotal_line_items_quantity: 257,
        line_items: [],
    }, 'demo.myshopify.com');
    assert.equal(payload.action_source, 'website');
    assert.equal(payload.event_id, 'demo.myshopify.com:9007199254740993');
    assert.equal(payload.num_items, 257);
});

test('buildTikTokPayload uses the current Purchase event name and preserves dedupe event_id', () => {
    const event = {
        request_payload: {
            event_name: 'Purchase',
            event_id: 'checkout-token-1',
            event_time: 1782192000,
            event_source_url: 'https://demo.myshopify.com/checkout',
            user_data: {
                em: [sha256('buyer@example.com')],
                ph: [sha256('+12125551212')],
                external_id: [sha256('12345')],
                client_user_agent: 'Mozilla/5.0',
                client_ip_address: '203.0.113.10',
            },
            custom_data: {
                value: 46,
                currency: 'USD',
                order_id: '#1001',
                content_type: 'product',
                contents: [
                    { id: '111', quantity: 2, item_price: 8 },
                ],
            },
            _platform_data: {
                tiktok: {
                    ttp: 'ttp-cookie',
                    ttclid: 'tt-click-1',
                },
            },
        },
    };

    const payload = buildTikTokPayload({
        pixel_id: 'TIKTOK_PIXEL',
        test_event_code: 'TEST123',
    }, event);

    assert.equal(payload.pixel_code, 'TIKTOK_PIXEL');
    assert.equal(payload.event, 'Purchase');
    assert.equal(payload.event_id, 'checkout-token-1');
    assert.equal(payload.context.ad.callback, 'tt-click-1');
    assert.equal(payload.context.user.ttp, 'ttp-cookie');
    assert.equal(payload.properties.value, 46);
    assert.equal(payload.properties.currency, 'USD');
    assert.equal(payload.properties.order_id, '#1001');
    assert.deepEqual(payload.properties.content_ids, ['111']);
    assert.equal(payload.properties.content_type, 'product');
    assert.deepEqual(payload.properties.contents, [
        {
            content_id: '111',
            quantity: 2,
            price: 8,
            content_type: 'product',
        },
    ]);
    assert.equal(payload.test_event_code, 'TEST123');
});

test('private event fields are removed before Meta CAPI send', () => {
    assert.deepEqual(stripPrivateFields({
        event_name: 'Purchase',
        event_id: 'evt-1',
        _emq_estimate: '7.0',
        _platform_data: { tiktok: {} },
        _duplicate_candidate: true,
        _quality: { missing_match_signals: ['fbc'] },
        _received_at: 123,
        _shopify_order_id: '987',
    }), {
        event_name: 'Purchase',
        event_id: 'evt-1',
    });
});

test('customer information normalization matches platform hashing expectations', () => {
    assert.equal(normalizeForHash(' Buyer@Example.COM ', 'email'), 'buyer@example.com');
    assert.equal(normalizeForHash('buyer @example.com', 'email'), undefined);
    assert.equal(normalizeForHash('+1 (212) 555-1212', 'phone'), '12125551212');
    assert.equal(normalizeForHash('0044 20 7946 0958', 'phone'), '442079460958');
    assert.equal(normalizeForHash('(650) 555-1212', 'phone', { country: 'US' }), '16505551212');
    assert.equal(normalizeForHash('(650) 555-1212', 'phone'), undefined);
    assert.equal(normalizeForHash('020 7946 0958', 'phone', { country: 'GB' }), undefined);
    assert.equal(normalizeForHash(' Valéry ', 'name'), 'valéry');
    assert.equal(normalizeForHash('张 三', 'name'), '张三');
    assert.equal(normalizeForHash(' São Paulo ', 'city'), 'saopaulo');
    assert.equal(normalizeForHash('CA', 'state', { country: 'US' }), 'ca');
    assert.equal(normalizeForHash('California', 'state', { country: 'US' }), undefined);
    assert.equal(normalizeForHash(' E1 1AA ', 'zip'), 'e11aa');
    assert.equal(normalizeForHash('94035-1234', 'zip', { country: 'US' }), '94035');
    assert.equal(normalizeForHash('US', 'country'), 'us');
    assert.equal(normalizeForHash('United States', 'country'), undefined);
});

test('Meta match fields are sanitized without fabricating browser identifiers', () => {
    const hash = sha256('buyer@example.com');
    assert.equal(normalizeMetaCookie('fb.1.1596403881668.1116446470'), 'fb.1.1596403881668.1116446470');
    assert.equal(normalizeMetaCookie('fb.1.fake.cookie'), undefined);
    assert.deepEqual(sanitizeMetaUserData({
        em: [hash, hash, 'not-a-hash'],
        client_ip_address: '203.0.113.10',
        client_user_agent: ' Mozilla/5.0 ',
        fbp: 'fb.1.fake.cookie',
        fbc: 'fb.1.1554763741205.AbCdEfGhIjKlMnOp',
    }), {
        em: [hash],
        client_ip_address: '203.0.113.10',
        client_user_agent: 'Mozilla/5.0',
        fbc: 'fb.1.1554763741205.AbCdEfGhIjKlMnOp',
    });

    const preparedPurchase = prepareMetaEvent({
        event_name: 'Purchase',
        user_data: { em: [hash] },
        custom_data: { num_items: 2, search_string: 'shoes', value: 10, currency: 'USD' },
    });
    assert.equal(preparedPurchase.custom_data.num_items, undefined);
    assert.equal(preparedPurchase.custom_data.search_string, undefined);
    assert.equal(prepareMetaEvent({
        event_name: 'InitiateCheckout',
        user_data: { em: [hash] },
        custom_data: { num_items: 2 },
    }).custom_data.num_items, 2);
    assert.deepEqual(sanitizeMetaCustomData({
        content_ids: ['removed-item', 'paid-item'],
        contents: [{ id: 'paid-item', quantity: 1, item_price: 10 }],
    }, 'Purchase'), {
        content_ids: ['paid-item'],
        contents: [{ id: 'paid-item', quantity: 1, item_price: 10 }],
    });
});

test('encrypted secret helper remains backward compatible with plaintext values', () => {
    const encrypted = encryptToken('shopify-secret-1');
    assert.equal(decryptTokenIfPossible(encrypted), 'shopify-secret-1');
    assert.equal(decryptTokenIfPossible('legacy-plaintext-secret'), 'legacy-plaintext-secret');
    assert.throws(
        () => decryptTokenIfPossible(`${'00'.repeat(16)}:${'00'.repeat(16)}:00`),
        /verify AES_SECRET_KEY/,
    );
});

test('credential throttle scope is stable and platform isolated', () => {
    assert.equal(
        credentialFingerprint('facebook', 'shared-token'),
        credentialFingerprint('facebook', 'shared-token'),
    );
    assert.notEqual(
        credentialFingerprint('facebook', 'shared-token'),
        credentialFingerprint('tiktok', 'shared-token'),
    );
    assert.equal(
        credentialFingerprint('facebook', 'token-a', 'business-1'),
        credentialFingerprint('facebook', 'token-b', 'BUSINESS-1'),
    );
});

test('shop ingestion token comparison is exact and timing safe', () => {
    assert.equal(timingSafeStringCompare('abc123', 'abc123'), true);
    assert.equal(timingSafeStringCompare('abc123', 'abc124'), false);
    assert.equal(timingSafeStringCompare('abc123', 'abc123='), false);
});

test('missing match signal diagnostics identify EMQ gaps', () => {
    assert.deepEqual(missingMatchSignals({
        em: ['hash'],
        ph: ['hash'],
        client_ip_address: '203.0.113.10',
        client_user_agent: 'Mozilla/5.0',
    }), [
        'external_id',
        'fbp',
        'fbc',
        'first_name',
        'last_name',
        'city',
        'state',
        'zip',
        'country',
    ]);
});

test('TikTok standard event mapping is stable', () => {
    assert.equal(tiktokEventName('Purchase'), 'Purchase');
    assert.equal(tiktokEventName('AddToCart'), 'AddToCart');
    assert.equal(tiktokEventName('ShopifyAlertDisplayed'), 'ShopifyAlertDisplayed');
});

test('successful delivery keys prevent resending already successful pixels', () => {
    const keys = successfulDeliveryKeys([
        {
            fb_response: {
                deliveries: [
                    { platform: 'facebook', pixel_id: 'META1', status: 'SUCCESS' },
                    { platform: 'tiktok', pixel_id: 'TT1', status: 'FAILED' },
                    { platform: 'facebook', pixel_id: 'META2', status: 'SKIPPED_ALREADY_SUCCESS' },
                ],
            },
        },
    ]);

    assert.equal(shouldSkipPixel({ platform: 'facebook', pixel_id: 'META1' }, keys), true);
    assert.equal(shouldSkipPixel({ platform: 'tiktok', pixel_id: 'TT1' }, keys), false);
    assert.equal(shouldSkipPixel({ platform: 'facebook', pixel_id: 'META2' }, keys), false);
});

test('successful delivery keys only skip a pixel when every event already succeeded', () => {
    const keys = successfulDeliveryKeys([
        {
            request_payload: { event_id: 'evt-a' },
            fb_response: {
                deliveries: [
                    { platform: 'facebook', pixel_id: 'META1', status: 'SUCCESS', event_ids: ['evt-a'] },
                    { platform: 'tiktok', pixel_id: 'TT1', status: 'SUCCESS', event_ids: ['evt-a'] },
                ],
            },
        },
        {
            request_payload: { event_id: 'evt-b' },
            fb_response: {
                deliveries: [
                    { platform: 'facebook', pixel_id: 'META1', status: 'SUCCESS', event_ids: ['evt-b'] },
                    { platform: 'tiktok', pixel_id: 'TT1', status: 'SUCCESS', event_ids: ['evt-a'] },
                ],
            },
        },
    ]);

    assert.equal(shouldSkipPixel({ platform: 'facebook', pixel_id: 'META1' }, keys), true);
    assert.equal(shouldSkipPixel({ platform: 'tiktok', pixel_id: 'TT1' }, keys), false);
});

test('eventHasSuccessfulDelivery checks success per event and pixel', () => {
    const event = {
        request_payload: { event_id: 'evt-a' },
        fb_response: {
            deliveries: [
                { platform: 'facebook', pixel_id: 'META1', status: 'SUCCESS', event_ids: ['evt-a'] },
                { platform: 'facebook', pixel_id: 'META2', status: 'SUCCESS', event_ids: ['evt-b'] },
                { platform: 'tiktok', pixel_id: 'TT1', status: 'FAILED', event_ids: ['evt-a'] },
            ],
        },
    };

    assert.equal(eventHasSuccessfulDelivery(event, { platform: 'facebook', pixel_id: 'META1' }), true);
    assert.equal(eventHasSuccessfulDelivery(event, { platform: 'facebook', pixel_id: 'META2' }), false);
    assert.equal(eventHasSuccessfulDelivery(event, { platform: 'tiktok', pixel_id: 'TT1' }), false);
});

test('legacy successful deliveries without event ids still count as successful', () => {
    const event = {
        request_payload: { event_id: 'evt-a' },
        fb_response: {
            deliveries: [
                { platform: 'facebook', pixel_id: 'META1', status: 'SUCCESS' },
            ],
        },
    };

    assert.equal(eventHasSuccessfulDelivery(event, { platform: 'facebook', pixel_id: 'META1' }), true);
});

test('delivery status remains pending until every configured route is terminal', () => {
    assert.equal(aggregateDeliveryStatus(['SUCCESS', 'PENDING']), 'PENDING');
    assert.equal(aggregateDeliveryStatus(['SUCCESS', 'RETRYABLE_FAILED']), 'PENDING');
    assert.equal(aggregateDeliveryStatus(['SUCCESS', 'SUCCESS']), 'SUCCESS');
    assert.equal(aggregateDeliveryStatus(['SUCCESS', 'FAILED_PERMANENT']), 'PARTIAL_FAILED');
    assert.equal(aggregateDeliveryStatus(['FAILED_PERMANENT', 'FAILED_PERMANENT']), 'FAILED');
});

test('route retry backoff is exponential and capped', () => {
    assert.equal(retryDelaySeconds(1, 5, 900), 5);
    assert.equal(retryDelaySeconds(4, 5, 900), 40);
    assert.equal(retryDelaySeconds(20, 5, 900), 900);
});

test('coalesced queue jobs reuse live work but replace terminal or missing jobs', async () => {
    const liveCalls = [];
    const liveQueue = {
        async add(name, data, options) {
            liveCalls.push({ name, data, options });
            return { id: options.jobId, getState: async () => 'delayed' };
        },
    };
    const liveJob = await enqueueReschedulableJob(
        liveQueue,
        'send-fb-batch',
        { shopId: 7 },
        { delay: 1000, jobId: 'retry-7-100' },
        () => 'unused',
    );
    assert.equal(liveCalls.length, 1);
    assert.equal(liveJob.id, 'retry-7-100');

    const terminalCalls = [];
    const terminalQueue = {
        async add(name, data, options) {
            terminalCalls.push({ name, data, options });
            return {
                id: options.jobId,
                getState: async () => terminalCalls.length === 1 ? 'completed' : 'waiting',
            };
        },
    };
    const replacement = await enqueueReschedulableJob(
        terminalQueue,
        'send-fb-batch',
        { shopId: 7 },
        { delay: 1000, jobId: 'retry-7-100' },
        () => 'replacement',
    );
    assert.equal(terminalCalls.length, 2);
    assert.equal(terminalCalls[1].options.jobId, 'retry-7-100-replacement');
    assert.equal(replacement.id, 'retry-7-100-replacement');

    const missingCalls = [];
    const missingQueue = {
        async add(name, data, options) {
            missingCalls.push({ name, data, options });
            return {
                id: options.jobId,
                getState: async () => missingCalls.length === 1 ? 'unknown' : 'waiting',
            };
        },
    };
    const raceReplacement = await enqueueReschedulableJob(
        missingQueue,
        'send-fb-batch',
        { shopId: 8 },
        { jobId: 'dispatch-8-normal-100' },
        () => 'race-replacement',
    );
    assert.equal(missingCalls.length, 2);
    assert.equal(missingCalls[1].options.jobId, 'dispatch-8-normal-100-race-replacement');
    assert.equal(raceReplacement.id, 'dispatch-8-normal-100-race-replacement');
});

test('tracked cron tasks never overlap and graceful shutdown drains active work', async () => {
    const callbacks = [];
    const stoppedTasks = [];
    const reportedErrors = [];
    const fakeCron = {
        validate: expression => expression === '* * * * * *',
        schedule(expression, callback) {
            callbacks.push(callback);
            return { stop: () => stoppedTasks.push(expression) };
        },
    };
    const scheduler = createTrackedCronScheduler(fakeCron, {
        onError: (error, label) => reportedErrors.push({ error, label }),
    });

    let releaseExecution;
    let starts = 0;
    scheduler.schedule('* * * * * *', async () => {
        starts += 1;
        await new Promise(resolve => { releaseExecution = resolve; });
    }, 'slow-maintenance');

    const first = callbacks[0]();
    await Promise.resolve();
    assert.equal(starts, 1);
    assert.equal(scheduler.activeCount(), 1);
    assert.equal(callbacks[0](), undefined, 'overlapping invocation must be skipped');
    assert.equal(starts, 1);

    let drained = false;
    const drain = scheduler.stopAndDrain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(scheduler.isStopping(), true);
    assert.equal(drained, false, 'shutdown must wait for the active handler');
    assert.deepEqual(stoppedTasks, ['* * * * * *']);
    assert.equal(callbacks[0](), undefined, 'shutdown must reject future invocations');

    releaseExecution();
    await Promise.all([first, drain]);
    assert.equal(drained, true);
    assert.equal(scheduler.activeCount(), 0);
    assert.deepEqual(reportedErrors, []);
});

test('tracked immediate background work joins the same shutdown drain', async () => {
    const fakeCron = { validate: () => true, schedule: () => ({ stop() {} }) };
    const scheduler = createTrackedCronScheduler(fakeCron);
    let release;
    const execution = scheduler.run(
        () => new Promise(resolve => { release = resolve; }),
        'immediate-webhook-drain',
    );
    await Promise.resolve();
    assert.equal(scheduler.activeCount(), 1);

    let stopped = false;
    const drain = scheduler.stopAndDrain().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    assert.equal(scheduler.run(() => {}, 'late-work'), undefined);

    release();
    await Promise.all([execution, drain]);
    assert.equal(stopped, true);
    assert.equal(scheduler.activeCount(), 0);
});

test('tracked cron contains handler and error-reporter failures', async () => {
    let callback;
    const fakeCron = {
        validate: () => true,
        schedule(expression, handler) {
            callback = handler;
            return { stop() {} };
        },
    };
    const expected = new Error('scheduled failure');
    const scheduler = createTrackedCronScheduler(fakeCron, {
        onError() {
            throw new Error('reporter failure');
        },
    });
    scheduler.schedule('* * * * *', async () => { throw expected; }, 'failure-test');
    await callback();
    assert.equal(scheduler.activeCount(), 0);
    await scheduler.stopAndDrain();
});

test('platform retry control honors Retry-After and adds bounded jitter', () => {
    assert.equal(parseRetryAfterSeconds('120', 0), 120);
    assert.equal(parseRetryAfterSeconds('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120);
    assert.equal(retryDelayWithJitterSeconds(4, 5, 900, 120, 86400, 0.5), 120);
    assert.equal(retryDelayWithJitterSeconds(4, 5, 900, undefined, 86400, 0.5), 40);
});

test('Meta usage headers proactively open a credential cooldown', () => {
    const control = metaRateControlFromHeaders({
        'x-business-use-case-usage': JSON.stringify({
            dataset: [{ call_count: 96, total_time: 40, estimated_time_to_regain_access: 22 }],
        }),
    });
    assert.equal(control.maxUsagePercent, 96);
    assert.equal(control.estimatedRecoverySeconds, 1320);
    assert.equal(control.cooldownSeconds, 1320);
});

test('Meta transient errors are retryable even when the code is unfamiliar', () => {
    const classification = classifyFacebookError({
        message: 'temporary',
        response: {
            status: 400,
            headers: { 'retry-after': '45' },
            data: { error: { code: 999999, is_transient: true, message: 'try later' } },
        },
    });
    assert.equal(classification.retryable, true);
    assert.equal(classification.retryAfterSeconds, 45);
});

test('Meta request-level permission failures never amplify a 100-event batch', async () => {
    for (const error of [
        { response: { status: 403, data: { error: { code: 200, message: 'Permissions error' } } } },
        { response: { status: 400, data: { error: { code: 10, message: 'Application does not have permission' } } } },
        { response: { status: 400, data: { error: { code: 803, message: 'Object does not exist' } } } },
        { response: { status: 400, data: { error: { code: 100, message: 'Invalid request parameter' } } } },
    ]) {
        let requests = 0;
        const items = Array.from({ length: 100 }, (_, id) => ({ id }));
        const result = await isolateMetaBatch(items, { remaining: 16 }, {
            async send() {
                requests += 1;
                throw error;
            },
            classify: classifyFacebookError,
            shouldIsolate: shouldIsolateFacebookError,
            failure: (failedItems, classification) => ({
                count: failedItems.length,
                code: classification.code,
            }),
        });
        assert.equal(requests, 1);
        assert.equal(result.failures[0].count, 100);
        assert.equal(result.deferredItems.length, 0);
    }
});

test('Meta isolation budget preserves completed branches and defers only unresolved events', async () => {
    const items = Array.from({ length: 8 }, (_, id) => ({ id }));
    let requests = 0;
    const result = await isolateMetaBatch(items, { remaining: 2 }, {
        async send(batch) {
            requests += 1;
            if (batch.length === 8) {
                throw { response: { status: 400, data: { error: {
                    code: 100,
                    message: 'Invalid event data',
                    error_data: { blame_field_specs: [['data', '6', 'event_time']] },
                } } } };
            }
            return { ids: batch.map(item => item.id) };
        },
        classify: classifyFacebookError,
        shouldIsolate: shouldIsolateFacebookError,
        failure: () => assert.fail('no branch should be marked permanent'),
    });
    assert.equal(requests, 2);
    assert.deepEqual(result.successes[0].ids, [0, 1, 2, 3]);
    assert.deepEqual(result.deferredItems.map(item => item.id), [4, 5, 6, 7]);
    assert.equal(result.budgetExhausted, true);
});

test('Meta isolation stops sibling probes after a transient credential failure', async () => {
    const items = Array.from({ length: 4 }, (_, id) => ({ id }));
    let requests = 0;
    const result = await isolateMetaBatch(items, { remaining: 10 }, {
        async send(batch) {
            requests += 1;
            if (batch.length === 4) {
                throw { response: { status: 400, data: { error: {
                    code: 100,
                    message: 'Invalid event data',
                    error_data: { blame_field_specs: [['data', '1', 'custom_data']] },
                } } } };
            }
            throw { response: { status: 429, data: { error: { code: 4, is_transient: true } } } };
        },
        classify: classifyFacebookError,
        shouldIsolate: shouldIsolateFacebookError,
        failure: () => assert.fail('transient failure must not become permanent'),
    });
    assert.equal(requests, 2);
    assert.equal(result.retryError.response.status, 429);
    assert.deepEqual(result.deferredItems.map(item => item.id), [0, 1, 2, 3]);
});

test('local Redis fallback rate limit counts events instead of HTTP requests', () => {
    const windows = new Map();
    const first = consumeWeightedWindow(windows, 'shop:ip', 50, 60, { nowMs: 1000 });
    const second = consumeWeightedWindow(windows, 'shop:ip', 10, 60, { nowMs: 2000 });
    const rejected = consumeWeightedWindow(windows, 'shop:ip', 1, 60, { nowMs: 3000 });
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 10);
    assert.equal(second.allowed, true);
    assert.equal(second.remaining, 0);
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.count, 61);
});

test('Meta website events are validated before consuming platform quota', () => {
    const now = 1785000000;
    assert.deepEqual(validateMetaEvent({
        event_name: 'Purchase',
        event_id: 'checkout-1',
        event_time: now,
        action_source: 'website',
        event_source_url: 'https://demo.myshopify.com/checkouts/1',
        opt_out: false,
        user_data: { client_ip_address: '203.0.113.10', client_user_agent: 'Mozilla/5.0' },
        custom_data: { value: 46, currency: 'USD' },
    }, now), []);
    assert.deepEqual(validateMetaEvent({
        event_name: 'PageView',
        event_id: 'page-1',
        event_time: now,
        action_source: 'website',
        event_source_url: 'https://demo.myshopify.com/',
        opt_out: 'false',
        user_data: { client_ip_address: '203.0.113.10', client_user_agent: 'Mozilla/5.0' },
    }, now), [
        'opt_out must be boolean',
    ]);
    assert.deepEqual(validateMetaEvent({
        event_name: 'Purchase',
        event_id: 'checkout-1',
        event_time: now - (8 * 24 * 60 * 60),
        action_source: 'website',
        event_source_url: 'https://demo.myshopify.com/',
        user_data: {},
        custom_data: { value: -1, currency: 'usd' },
    }, now), [
        'user_data requires at least one valid matching signal',
        'event_time is older than seven days',
        'website events require client_user_agent',
        'Purchase value must be a non-negative number',
        'Purchase currency must be a three-letter uppercase code',
    ]);
    assert.deepEqual(validateMetaEvent({
        event_name: 'AddPaymentInfo',
        event_id: 'payment-1',
        event_time: now,
        action_source: 'website',
        event_source_url: 'https://demo.myshopify.com/checkouts/1',
        user_data: { em: [sha256('buyer@example.com')], client_user_agent: 'Mozilla/5.0' },
        custom_data: { value: 46, currency: 'USD' },
    }, now), []);
    assert.deepEqual(validateMetaEvent({
        event_name: 'Purchase',
        event_id: 'checkout-2',
        event_time: now,
        action_source: 'website',
        event_source_url: 'https://demo.myshopify.com/',
        user_data: { client_ip_address: '203.0.113.10', client_user_agent: 'Mozilla/5.0' },
        custom_data: {},
    }, now), [
        'Purchase value is required',
        'Purchase currency is required',
    ]);
    assert.deepEqual(validateMetaEvent({
        event_name: 'AddToCart',
        event_id: 'cart-1',
        event_time: now,
        action_source: 'website',
        event_source_url: 'https://demo.myshopify.com/products/1',
        user_data: { client_ip_address: '203.0.113.10', client_user_agent: 'Mozilla/5.0' },
        custom_data: { value: 10 },
    }, now), ['AddToCart value and currency must be provided together']);
});

test('commerce quality diagnostics identify missing funnel parameters without dropping the event', () => {
    assert.deepEqual(missingCommerceSignals('PageView', {}), []);
    assert.deepEqual(missingCommerceSignals('AddToCart', {
        value: 10,
        currency: 'USD',
        content_ids: ['111'],
        contents: [{ id: '111', quantity: 1 }],
    }), []);
    assert.deepEqual(missingCommerceSignals('Purchase', { value: 0, currency: 'USD' }), [
        'content_ids',
        'contents',
        'order_id',
    ]);
});

test('funnel summaries keep a fixed metric definition and currency-separated values', () => {
    assert.deepEqual(FUNNEL_EVENT_NAMES, [
        'AddToCart',
        'InitiateCheckout',
        'AddPaymentInfo',
        'Purchase',
    ]);
    const summary = decorateFunnelSummary([{
        event_name: 'AddToCart',
        total_events: '4',
        unique_events: '4',
        successful_events: '3',
        pending_events: '1',
        awaiting_payment_events: '0',
        failed_events: '0',
        missing_parameter_events: '1',
        locally_invalid_events: '0',
        avg_emq: '7.5',
        value_by_currency: { USD: 40, AUD: 20 },
    }]);
    assert.equal(summary.length, 4);
    assert.deepEqual(summary[0], {
        event_name: 'AddToCart',
        label: '加入购物车',
        shopify_source: 'product_added_to_cart',
        grain: 'action',
        total_events: 4,
        unique_events: 4,
        successful_events: 3,
        pending_events: 1,
        awaiting_payment_events: 0,
        failed_events: 0,
        missing_parameter_events: 1,
        locally_invalid_events: 0,
        avg_emq: 7.5,
        value_by_currency: { USD: 40, AUD: 20 },
        success_rate: 75,
    });
    assert.equal(summary[3].grain, 'order');
    assert.equal(summary[3].total_events, 0);
});

test('schema defines multistore routing and per-route idempotency boundaries', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'init.sql'), 'utf8');
    const scaleIndexes = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'scale-indexes.sql'), 'utf8');
    const workerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker.js'), 'utf8');
    const queueSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'queue.js'), 'utf8');
    assert.match(schema, /CREATE TABLE IF NOT EXISTS shop_pixel_routes/);
    assert.match(schema, /reporting_timezone VARCHAR\(64\) NOT NULL DEFAULT 'UTC'/);
    assert.match(schema, /shopify_api_version VARCHAR\(20\)/);
    assert.match(schema, /UNIQUE \(shop_id, pixel_id\)/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS event_deliveries/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS event_id_aliases/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS shopify_webhook_subscription_state/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS shopify_pixel_runtime_status/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS browser_delivery_diagnostics/);
    assert.match(schema, /event_counts JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    assert.match(scaleIndexes, /idx_browser_delivery_diagnostics_retention/);
    assert.match(schema, /UNIQUE \(shop_id, event_name, alias_type, alias_value\)/);
    assert.match(schema, /UNIQUE \(event_store_id, route_id\)/);
    assert.match(schema, /delivery_route_snapshot BIGINT\[\]/);
    assert.match(schema, /REFERENCES shop_pixel_routes\(id\) ON DELETE RESTRICT/);
    assert.match(schema, /REFERENCES pixels\(id\) ON DELETE RESTRICT/);
    assert.match(schema, /status VARCHAR\(20\) NOT NULL DEFAULT 'active'/);
    assert.match(schema, /CREATE OR REPLACE FUNCTION enforce_event_delivery_tenant\(\)/);
    assert.match(schema, /JOIN shop_pixel_routes route ON route\.shop_id = event\.shop_id/);
    assert.match(schema, /CREATE TRIGGER trg_event_delivery_tenant/);
    assert.match(schema, /ON event_store\(shop_id, event_name, event_id\)/);
    assert.doesNotMatch(schema, /DROP TABLE IF EXISTS schema_migrations/);
    assert.match(schema, /indexdef NOT LIKE '%\(shop_id, event_name, event_id\)%'/);
    assert.match(schema, /rate_limit_until TIMESTAMPTZ/);
    assert.match(schema, /credential_scope VARCHAR\(64\)/);
    assert.match(schema, /credential_version BIGINT NOT NULL DEFAULT 1/);
    assert.match(schema, /shop_pixel_routes \([\s\S]*?test_event_code VARCHAR\(100\)/);
    assert.match(schema, /test_event_code_expires_at TIMESTAMPTZ/);
    assert.match(schema, /WHERE test_event_code IS NOT NULL[\s\S]*?test_event_code_expires_at IS NULL/);
    assert.match(schema, /SET test_event_code = pixel\.test_event_code/);
    assert.match(schema, /UPDATE pixels[\s\S]*?SET test_event_code = NULL[\s\S]*?WHERE test_event_code IS NOT NULL/);
    assert.match(schema, /ALTER TABLE event_store SET \([\s\S]*?autovacuum_vacuum_scale_factor = 0\.02/);
    assert.match(scaleIndexes, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_store_pending_shop_time/);
    assert.match(scaleIndexes, /WHERE status = 'PENDING'/);
    assert.match(scaleIndexes, /idx_event_store_retention_all_terminal/);
    assert.match(scaleIndexes, /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_pixels_platform_external_id[\s\S]*?ON pixels\(platform, pixel_id\)/);
    assert.match(scaleIndexes, /idx_pixels_credential_scope/);
    assert.match(workerSource, /ed\.attempt_count = c\.attempt_count/);
    assert.match(workerSource, /redis\.call\("pexpire"/);
    assert.match(workerSource, /config\.deliveryMaxAttempts > 0/);
    assert.match(workerSource, /WHERE shop_id = \$1\s+AND id = ANY\(\$2::bigint\[\]\)/);
    assert.match(workerSource, /event\.status === 'PENDING' && Number\(event\.shop_id\) === normalizedShopId/);
    assert.match(workerSource, /scheduleShopContinuation\(normalizedShopId\)/);
    assert.match(workerSource, /config\.workerEventBatchSize/);
    assert.match(workerSource, /hasClaimableRouteEvents\(pixel\.route_id, idsToUpdate\)/);
    assert.match(workerSource, /redis\.set\(\s*'health:capi-worker'/);
    assert.match(workerSource, /config\.workerHeartbeatTtlSeconds/);
    assert.match(workerSource, /status IN \('PENDING', 'RETRYABLE_FAILED'\)[\s\S]*?next_attempt_at <= NOW\(\)/);
    assert.match(workerSource, /const token = `\$\{process\.pid\}:\$\{crypto\.randomUUID\(\)\}`/);
    assert.match(workerSource, /lock:delivery-shop:\$\{normalizedShopId\}/);
    assert.match(workerSource, /lock:delivery-credential:\$\{credentialScope\}/);
    assert.match(workerSource, /credentialFingerprint\(\s*pixel\.platform,\s*decryptedCredential,\s*pixel\.rate_limit_group,?\s*\)/);
    assert.match(workerSource, /credential_version = \$3/);
    assert.match(workerSource, /LOCAL_CREDENTIAL_CHANGED/);
    assert.match(workerSource, /p\.rate_limit_group,[\s\S]*?r\.test_event_code/);
    assert.match(workerSource, /WHERE credential_scope = \$1/);
    assert.match(workerSource, /snapshot_delivery\.event_store_id = ANY\(\$2::bigint\[\]\)/);
    assert.match(workerSource, /SET delivery_route_snapshot = active_routes\.route_ids/);
    assert.match(workerSource, /CARDINALITY\(active_routes\.route_ids\) > 0/);
    assert.match(workerSource, /successful_event_store_ids/);
    assert.match(workerSource, /accepted_event: true/);
    assert.match(workerSource, /meta_batch_events_received/);
    assert.match(workerSource, /UNNEST\(\$2::bigint\[\], \$3::int\[\], \$4::jsonb\[\]\)/);
    assert.match(workerSource, /r\.test_event_code_expires_at > NOW\(\)/);
    assert.match(workerSource, /LEFT JOIN event_deliveries delivery[\s\S]*?delivery\.next_attempt_at <= NOW\(\)/);
    assert.match(workerSource, /const responseCode = Number\(response\.data\?\.code \?\? 0\)/);
    assert.doesNotMatch(schema, /ON event_store\(shop_id, event_name, md5\(event_id\)\)/);
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.match(serverSource, /AWAITING_PAYMENT/);
    assert.match(serverSource, /webhookTopic !== 'orders\/paid'/);
    assert.match(serverSource, /paymentConfirmed: true/);
    assert.match(serverSource, /INSERT INTO shopify_webhook_inbox/);
    assert.match(serverSource, /failExhaustedShopifyWebhookInboxRows/);
    assert.match(serverSource, /attempt_count < \$2/);
    assert.match(serverSource, /Processing lease expired after the maximum attempt count/);
    assert.match(serverSource, /withTimeout\([\s\S]*?processShopifyWebhookInboxRow\(row\)/);
    assert.match(serverSource, /updated_at:<'?='?\$\{cutoff\}/);
    assert.match(serverSource, /lineItems\(first: 250\)/);
    assert.match(serverSource, /SHOPIFY_ORDER_LINE_ITEMS_QUERY/);
    assert.match(serverSource, /while \(pageInfo\?\.hasNextPage\)/);
    assert.match(serverSource, /email phone cartToken checkoutToken clientIp/);
    assert.match(serverSource, /currentAppInstallation \{ accessScopes \{ handle \} \}/);
    assert.match(serverSource, /customer @include\(if: \$includeCustomer\)/);
    assert.match(serverSource, /transactions\(first: 100\)/);
    assert.match(serverSource, /shopifyPaymentTimestamp\(node\) \|\| scanCutoff/);
    assert.match(serverSource, /ON CONFLICT \(shop_id, event_name, event_id\) DO NOTHING/);
    assert.match(serverSource, /SELECT id, shop_id, event_name, event_id, request_payload,[\s\S]*?FOR UPDATE/);
    assert.match(serverSource, /\['order', payload\._shopify_order_id\]/);
    assert.match(serverSource, /Keep the old scoped form as a compatibility alias/);
    assert.match(serverSource, /existing\.status === 'SUCCESS'/);
    assert.match(serverSource, /mergePersistedEventPayload\(existing\.request_payload, purePayload\)/);
    assert.match(serverSource, /mergedPayload\._quality = \{/);
    assert.match(serverSource, /const validationRepaired = recoverableValidationFailure[\s\S]*?mergedValidationErrors\.length === 0/);
    assert.match(serverSource, /if \(validationRepaired\)/);
    assert.match(serverSource, /calculateEMQ\(mergedPayload\.user_data \|\| \{\}\)/);
    assert.match(serverSource, /fbEventData\._quality\.local_validation_errors = validationErrors/);
    assert.match(serverSource, /insertBrowserIngestionRejection/);
    assert.match(serverSource, /Browser ingestion rejected:/);
    assert.match(serverSource, /supplied_fields:/);
    assert.match(serverSource, /_source: compactObject/);
    assert.match(serverSource, /decorateFunnelSummary\(funnelResult\.rows\)/);
    assert.match(serverSource, /requireIanaTimezone/);
    assert.match(serverSource, /reporting-timezone', asyncHandler/);
    assert.match(serverSource, /store_today:/);
    assert.match(serverSource, /reporting_timezone/);
    assert.match(serverSource, /auditShopifyApiVersion/);
    assert.match(serverSource, /shopify_api_health:/);
    assert.match(serverSource, /x-shopify-api-version/);
    assert.match(serverSource, /const snapshotStatus = summary\.events\.length \? 'SUCCESS' : 'EMPTY'/);
    assert.match(serverSource, /Meta Dataset Quality returned no event-level metrics/);
    assert.match(serverSource, /SHARED_FACEBOOK_DATASET_BLOCKED/);
    assert.match(serverSource, /shared_facebook_datasets/);
    assert.match(serverSource, /jsonb_object_agg\(currency, total_value\)/);
    assert.doesNotMatch(serverSource, /Event validation failed:/);
    assert.match(serverSource, /existing\.status === 'AWAITING_PAYMENT'[\s\S]*?purePayload\._payment_confirmed === true/);
    assert.match(serverSource, /paidOrderIgnoreReason/);
    assert.match(serverSource, /Missing stable order identity/);
    assert.match(serverSource, /if \(eventName !== 'Purchase'\) return \[\]/);
    assert.match(serverSource, /scheduler:stale_pending_shop_cursor/);
    assert.match(serverSource, /reconcileEventAggregateStatuses/);
    assert.match(serverSource, /SET status = 'archived'/);
    assert.doesNotMatch(serverSource, /DELETE FROM pixels WHERE id = \$1/);
    assert.match(serverSource, /error_code = 'ROUTE_ARCHIVED'/);
    assert.match(serverSource, /capi-saas-pro:aggregate-reconcile/);
    assert.match(serverSource, /FOR UPDATE OF event SKIP LOCKED/);
    assert.match(serverSource, /SET status = CASE WHEN \$2::boolean THEN 'PENDING' ELSE status END,[\s\S]*?request_payload = \$4::jsonb/);
    assert.match(serverSource, /GROUP BY e\.shop_id\s+ORDER BY e\.shop_id ASC/);
    assert.match(serverSource, /jobId: `rescue-\$\{shopId\}-\$\{rescueMinute\}`/);
    assert.match(serverSource, /enqueueReschedulableJob\(/);
    assert.match(workerSource, /enqueueReschedulableJob\(/);
    assert.match(workerSource, /if \(shuttingDown \|\| workerHeartbeatInFlight\) return workerHeartbeatInFlight/);
    assert.match(workerSource, /if \(workerHeartbeatInFlight\) await workerHeartbeatInFlight/);
    assert.match(queueSource, /const state = await job\.getState\(\)/);
    assert.match(queueSource, /LIVE_JOB_STATES\.has\(state\)/);
    assert.match(serverSource, /cleanupExpiredOperationalData/);
    assert.match(serverSource, /status IN \('SUCCESS', 'FAILED', 'PARTIAL_FAILED', 'AWAITING_PAYMENT'\)/);
    assert.match(serverSource, /const persisted = await persistOutboxEvent\(shopId,[\s\S]*?isAwaitingPayment/);
    assert.match(serverSource, /tenant_id: shopDomain/);
    assert.match(serverSource, /buildCustomData\(enrichedPayload, config\.commerceItemLimit\)/);
    assert.match(serverSource, /customer_lifecycle: enrichedPayload\.customer_lifecycle/);
    assert.match(serverSource, /order_identity: eventName === 'Purchase'/);
    assert.match(serverSource, /GROUP BY shop_id, order_identity/);
    assert.match(serverSource, /ledger\.shop_id = paid_orders\.shop_id/);
    assert.match(serverSource, /meta_delivered_orders/);
    assert.match(serverSource, /unledgered_eligible_orders/);
    assert.match(serverSource, /WHERE platform = \$1 AND pixel_id = \$2/);
    assert.match(serverSource, /credential_version = credential_version \+ CASE WHEN \$8::boolean THEN 1 ELSE 0 END/);
    assert.match(serverSource, /RECOVERABLE_META_CREDENTIAL_CODES/);
    assert.match(serverSource, /recovered_credential_failures: recoveredCredentialFailures/);
    assert.match(serverSource, /delivery\.error_code = ANY\(\$2::text\[\]\)/);
    assert.match(serverSource, /INSERT INTO shop_pixel_routes \([\s\S]*?shop_id, pixel_id, test_event_code, test_event_code_expires_at/);
    assert.match(serverSource, /'test_event_code', CASE[\s\S]*?r\.test_event_code_expires_at > NOW\(\)/);
    assert.match(serverSource, /config\.testEventCodeTtlMinutes/);
    assert.match(serverSource, /'platform_response', ed\.platform_response/);
    assert.match(serverSource, /lock:delivery-credential:\$\{pixel\.credential_scope \|\| pixel\.id\}/);
    assert.match(serverSource, /UNNEST\(\$1::int\[\]\) AS requested\(shop_id\)/);
    assert.match(serverSource, /SET status = 'inactive'[\s\S]*?WHERE pixel_id = \$1/);
    assert.match(serverSource, /error_code = 'ROUTE_INACTIVE'/);
    assert.match(serverSource, /route\.status = 'active'[\s\S]*?delivery\.status = 'FAILED_PERMANENT'/);
    assert.match(serverSource, /startRedisLockHeartbeat/);
    assert.match(serverSource, /if \(!config\.legacyRedisDrainEnabled\) return/);
    assert.match(serverSource, /redis\.get\('health:capi-worker'\)/);
    assert.match(serverSource, /const ready = redisState === 'ready'/);
    assert.match(serverSource, /immediate_dispatch: ready/);
    assert.match(serverSource, /if \(statusCode >= 500\) throw error/);
    assert.match(serverSource, /requireBoundedString\(trustedPayload\.event_id, 'event_id', 4096\)/);
    assert.match(serverSource, /err\.statusCode \|\| err\.status \|\| 500/);
    assert.match(serverSource, /payloadWeight = Math\.ceil\(Number\(req\.rawBody\?\.length \|\| 0\) \/ 16_384\)/);
    assert.match(serverSource, /buildCustomData\(enrichedPayload, config\.commerceItemLimit\)/);
    const redisSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'redis.js'), 'utf8');
    assert.match(redisSource, /maxRetriesPerRequest: 1/);
    assert.match(redisSource, /enableOfflineQueue: false/);
    assert.match(redisSource, /createBullMqWorkerConnection/);
    const migrateSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'migrate.js'), 'utf8');
    assert.match(migrateSource, /pg_try_advisory_lock/);
    assert.match(migrateSource, /indisvalid/);
    assert.match(migrateSource, /indisunique/);
    assert.match(migrateSource, /Duplicate external Pixel credentials must be consolidated/);
    assert.match(migrateSource, /DROP INDEX CONCURRENTLY IF EXISTS/);
    assert.match(migrateSource, /FROM pixels[\s\S]*?WHERE status = 'active'[\s\S]*?ORDER BY id/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS shopify_webhook_inbox/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS shopify_reconcile_state/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS shopify_privacy_inbox/);
    assert.match(schema, /UNIQUE \(shop_domain_hash, webhook_id\)/);
    assert.match(scaleIndexes, /idx_shopify_privacy_inbox_due/);
    assert.match(scaleIndexes, /idx_shopify_privacy_inbox_action/);
    assert.match(scaleIndexes, /idx_shopify_webhook_inbox_retention/);
    assert.match(scaleIndexes, /idx_shopify_privacy_inbox_retention/);
    assert.match(serverSource, /INSERT INTO shopify_webhook_inbox/);
    assert.match(serverSource, /financial_status:paid/);
    assert.match(serverSource, /shopify_reconcile_state/);
    assert.match(serverSource, /FOR UPDATE SKIP LOCKED/);
    assert.match(serverSource, /res\.status\(200\)\.json\(\{ success: true, accepted: true, durable: true/);
    assert.match(serverSource, /setImmediate\(\(\) => backgroundScheduler\.run/);
    assert.match(serverSource, /app\.post\('\/api\/webhook\/customers\/data_request'/);
    assert.match(serverSource, /app\.post\('\/api\/webhook\/customers\/redact'/);
    assert.match(serverSource, /app\.post\('\/api\/webhook\/shop\/redact'/);
    assert.match(serverSource, /return res\.status\(401\)\.send\('HMAC Failed'\)/);
    assert.match(serverSource, /\$2 <> '' AND/);
    assert.match(serverSource, /payload = NULL,[\s\S]*?result = NULL,[\s\S]*?shop_domain = NULL/);
    assert.match(serverSource, /DISTRIBUTED_RATE_LIMIT_SCRIPT/);
    assert.match(serverSource, /rate:pixel:\$\{digest\}/);
    assert.match(serverSource, /Recovered invalid cursor/);
    assert.match(serverSource, /const scheduledDrain = backgroundScheduler\.stopAndDrain\(\)/);
    assert.match(serverSource, /await scheduledDrain/);
    assert.match(serverSource, /backgroundScheduler\.run\([\s\S]*?shopify-webhook-immediate-drain/);
    assert.match(serverSource, /lock:shopify_webhook_audit/);
});

test('runtime config rejects weak encryption keys and malformed CORS origins', () => {
    const weakSecret = probeConfig({ AES_SECRET_KEY: 'too-short' });
    assert.notEqual(weakSecret.status, 0);
    assert.match(weakSecret.stderr, /AES_SECRET_KEY must be at least 32 characters/);

    const malformedOrigin = probeConfig({ CORS_ORIGIN: 'https://shop.example.com/path' });
    assert.notEqual(malformedOrigin.status, 0);
    assert.match(malformedOrigin.stderr, /CORS_ORIGIN entries must be exact http\(s\) origins/);

    const insecurePublicOrigin = probeConfig({ PUBLIC_BASE_URL: 'http://pixel.example.com' });
    assert.notEqual(insecurePublicOrigin.status, 0);
    assert.match(insecurePublicOrigin.stderr, /PUBLIC_BASE_URL must be a credential-free HTTPS URL/);

    const invalidJsonLimit = probeConfig({ JSON_LIMIT: 'unlimited' });
    assert.notEqual(invalidJsonLimit.status, 0);
    assert.match(invalidJsonLimit.stderr, /JSON_LIMIT must be a byte size/);

    const excessiveJsonLimit = probeConfig({ JSON_LIMIT: '17mb' });
    assert.notEqual(excessiveJsonLimit.status, 0);
    assert.match(excessiveJsonLimit.stderr, /JSON_LIMIT must be between 1kb and 16mb/);

    const excessiveCommerceItems = probeConfig({ COMMERCE_ITEM_LIMIT: '5001' });
    assert.notEqual(excessiveCommerceItems.status, 0);
    assert.match(excessiveCommerceItems.stderr, /COMMERCE_ITEM_LIMIT must not exceed 5000/);

    const productionWithoutIngestSecret = probeConfig({
        NODE_ENV: 'production',
        ADMIN_PASSWORD: 'production-password-strong',
        INGEST_TOKEN_SECRET: '',
    });
    assert.notEqual(productionWithoutIngestSecret.status, 0);
    assert.match(productionWithoutIngestSecret.stderr, /INGEST_TOKEN_SECRET must be set separately/);

    const productionSharedSecrets = probeConfig({
        NODE_ENV: 'production',
        ADMIN_PASSWORD: 'production-password-strong',
        INGEST_TOKEN_SECRET: 'test-secret-key-with-at-least-32-chars',
    });
    assert.notEqual(productionSharedSecrets.status, 0);
    assert.match(productionSharedSecrets.stderr, /INGEST_TOKEN_SECRET must differ from AES_SECRET_KEY/);

    const productionWeakAdminPassword = probeConfig({
        NODE_ENV: 'production',
        ADMIN_PASSWORD: 'short',
        INGEST_TOKEN_SECRET: 'separate-ingest-secret-with-32-characters',
    });
    assert.notEqual(productionWeakAdminPassword.status, 0);
    assert.match(productionWeakAdminPassword.stderr, /ADMIN_PASSWORD must be at least 16 characters/);

    const productionWithoutIngestEnforcement = probeConfig({
        NODE_ENV: 'production',
        ADMIN_PASSWORD: 'production-password-strong',
        INGEST_TOKEN_SECRET: 'separate-ingest-secret-with-32-characters',
        REQUIRE_INGEST_TOKEN: 'false',
    });
    assert.notEqual(productionWithoutIngestEnforcement.status, 0);
    assert.match(productionWithoutIngestEnforcement.stderr, /REQUIRE_INGEST_TOKEN must remain enabled/);

    const malformedApiVersion = probeConfig({ FB_API_VERSION: '../latest' });
    assert.notEqual(malformedApiVersion.status, 0);
    assert.match(malformedApiVersion.stderr, /FB_API_VERSION must look like v26\.0/);

    const malformedPartnerAgent = probeConfig({ META_PARTNER_AGENT: 'not allowed/value' });
    assert.notEqual(malformedPartnerAgent.status, 0);
    assert.match(malformedPartnerAgent.stderr, /META_PARTNER_AGENT must contain 1-100/);

    const normalizedQualityAgent = probeConfig({ META_QUALITY_AGENT_NAME: 'DataPartner' });
    assert.equal(normalizedQualityAgent.status, 0, normalizedQualityAgent.stderr);
    assert.equal(JSON.parse(normalizedQualityAgent.stdout).metaQualityAgentName, 'datapartner');

    const productionMetaProxy = probeConfig({
        NODE_ENV: 'production',
        ADMIN_PASSWORD: 'production-password-strong',
        INGEST_TOKEN_SECRET: 'separate-ingest-secret-with-32-characters',
        FB_GRAPH_BASE_URL: 'http://127.0.0.1:39999',
    });
    assert.notEqual(productionMetaProxy.status, 0);
    assert.match(productionMetaProxy.stderr, /official HTTPS endpoint in production/);

    const testMetaLoopback = probeConfig({ FB_GRAPH_BASE_URL: 'http://127.0.0.1:39999/' });
    assert.equal(testMetaLoopback.status, 0, testMetaLoopback.stderr);
    assert.equal(JSON.parse(testMetaLoopback.stdout).facebookGraphBaseUrl, 'http://127.0.0.1:39999');

    const malformedShopifyVersion = probeConfig({ SHOPIFY_API_VERSION: 'latest' });
    assert.notEqual(malformedShopifyVersion.status, 0);
    assert.match(malformedShopifyVersion.stderr, /SHOPIFY_API_VERSION must look like 2026-07/);

    const valid = probeConfig({
        CORS_ORIGIN: 'https://shop.example.com,http://localhost:3000',
        PUBLIC_BASE_URL: 'https://pixel.example.com/',
        TRUST_PROXY_HOPS: '0',
    });
    assert.equal(valid.status, 0, valid.stderr);
    const parsed = JSON.parse(valid.stdout);
    assert.deepEqual(parsed.corsOrigin, ['https://shop.example.com', 'http://localhost:3000']);
    assert.equal(parsed.trustProxy, 0);
    assert.equal(parsed.publicBaseUrl, 'https://pixel.example.com');
    assert.equal(parsed.allowSharedFacebookDatasetRoutes, true);

    const excessiveWorkerBatch = probeConfig({ WORKER_EVENT_BATCH_SIZE: '1001' });
    assert.notEqual(excessiveWorkerBatch.status, 0);
    assert.match(excessiveWorkerBatch.stderr, /WORKER_EVENT_BATCH_SIZE must not exceed 1000/);

    const unsafeHeaderDeadline = probeConfig({
        HTTP_KEEP_ALIVE_TIMEOUT_MS: '15000',
        HTTP_HEADERS_TIMEOUT_MS: '15000',
    });
    assert.notEqual(unsafeHeaderDeadline.status, 0);
    assert.match(unsafeHeaderDeadline.stderr, /HTTP_HEADERS_TIMEOUT_MS must exceed HTTP_KEEP_ALIVE_TIMEOUT_MS/);

    const unsafeShutdownDeadline = probeConfig({
        HTTP_REQUEST_TIMEOUT_MS: '30000',
        SHUTDOWN_TIMEOUT_MS: '30000',
    });
    assert.notEqual(unsafeShutdownDeadline.status, 0);
    assert.match(unsafeShutdownDeadline.stderr, /SHUTDOWN_TIMEOUT_MS must exceed HTTP_REQUEST_TIMEOUT_MS/);
});

test('CORS and partial-delivery safeguards remain wired into the runtime', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    const workerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker.js'), 'utf8');

    assert.match(serverSource, /app\.use\(\['\/api\/pixel-event', '\/api\/pixel-config', '\/api\/pixel-diagnostic'\], cors\(/);
    assert.ok(
        serverSource.indexOf("app.use('/api/admin', adminLimiter, authMw")
            < serverSource.indexOf('app.use(express.json'),
        'admin authentication must run before JSON body parsing',
    );
    assert.match(serverSource, /Cache-Control', 'private, no-store'/);
    assert.match(serverSource, /req\.get\('X-CAPI-Admin-Request'\) !== '1'/);
    assert.match(serverSource, /validateShopifyBrowserPayload\(payload\)/);
    assert.match(serverSource, /\['AddPaymentInfo', 'payment_info_submitted'\]/);
    assert.match(serverSource, /source_provider must be shopify_web_pixels/);
    assert.match(serverSource, /app\.get\('\/api\/admin\/privacy\/:id\/events'/);
    assert.match(serverSource, /app\.post\('\/api\/pixel-config', asyncHandler/);
    assert.match(serverSource, /app\.post\('\/api\/pixel-diagnostic', pixelLimiter/);
    assert.match(serverSource, /webhookSubscriptions\(first: 100, topics: \[ORDERS_PAID\]\)/);
    assert.match(serverSource, /webhookSubscriptionCreate\(topic: \$topic, webhookSubscription: \$webhookSubscription\)/);
    assert.match(serverSource, /app\.post\('\/api\/admin\/shops\/:id\/ensure-paid-webhook'/);
    assert.match(serverSource, /pixel\.platform = 'facebook'/);
    assert.match(serverSource, /PIXEL_CONFIG_CACHE_TTL_MS/);
    assert.doesNotMatch(serverSource, /app\.use\(cors\(/);
    assert.doesNotMatch(serverSource, /contentSecurityPolicy: false/);
    assert.doesNotMatch(serverSource, /https:\/\/cdn\.tailwindcss\.com/);
    assert.match(workerSource, /error\.partialDelivery =/);
    assert.match(workerSource, /retryable_event_ids/);
    assert.match(workerSource, /await applyPlatformResult\(/);
    assert.match(workerSource, /await scheduleRouteRetry\(normalizedShopId, retryAfterSeconds\)/);
    assert.match(workerSource, /jobId: `route-retry-\$\{shopId\}-\$\{dueSecond\}`/);
    assert.match(workerSource, /JOIN pixels active_pixel[\s\S]*active_pixel\.status = 'active'/);
    assert.match(serverSource, /SELECT DISTINCT ON \(m\.pixel_route_id, m\.shop_id\)/);
});

test('long event IDs retain a collision-resistant suffix before persistence', () => {
    const sharedPrefix = 'checkout-'.padEnd(300, 'x');
    const first = normalizeEventId(`${sharedPrefix}-first`);
    const second = normalizeEventId(`${sharedPrefix}-second`);

    assert.equal(first.length, 255);
    assert.equal(second.length, 255);
    assert.notEqual(first, second);
    assert.equal(normalizeEventId('gid://shopify/Order/12345'), '12345');
});

test('commerce events retain multi-page order contents up to the configured safety boundary', () => {
    const contents = Array.from({ length: 300 }, (_, index) => ({
        id: `variant-${index + 1}`,
        quantity: 1,
        item_price: index + 0.5,
    }));
    const customData = buildCustomData({
        shop_domain: 'demo.myshopify.com',
        order_id: '#1001',
        value: 999,
        currency: 'usd',
        contents,
        content_ids: ['stale-product'],
    }, 1000);

    assert.equal(customData.contents.length, 300);
    assert.equal(customData.content_ids.length, 300);
    assert.equal(customData.content_ids.includes('stale-product'), false);
    assert.equal(customData.order_id, 'demo.myshopify.com:#1001');
    assert.equal(customData.currency, 'USD');
    assert.equal(buildCustomData({ contents }, 250).contents.length, 250);
});

test('generated Shopify pixel sends Meta browser and CAPI events with identical dedupe IDs', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
    const match = html.match(/generatedCode\(\)\s*{\s*return `([\s\S]*?)`;\s*}\s*,\s*}\s*,\s*methods:/);
    assert.ok(match, 'generatedCode template should exist');

    const renderedTemplate = match[1]
        .replaceAll('${this.apiDomain}', 'https://nestworks.com.au:8443')
        .replaceAll('${this.currentShop}', 'demo.myshopify.com')
        .replaceAll('${this.currentShopIngestToken}', 'test-ingest-token')
        .replaceAll('${JSON.stringify(this.currentMetaPixelIds)}', '["1234567890","2222222222"]')
        .replaceAll('${JSON.stringify(this.currentTikTokPixelIds)}', '["TT123"]');
    // The browser evaluates this as a template literal before presenting the
    // generated pixel. Cook escape sequences here so the VM executes exactly
    // the code a merchant copies from the admin UI.
    const generated = Function(`return \`${renderedTemplate}\`;`)();

    assert.doesNotMatch(
        generated,
        /\n\s*(?:[?:]|&&|\|\||\?\?)/,
        'generated Shopify pixel must not start a line with a conditional or logical operator',
    );

    assert.equal(generated.includes('document.createElement'), true);
    assert.equal(generated.includes('typeof document'), true);
    assert.equal(generated.includes('connect.facebook.net/en_US/fbevents.js'), true);
    assert.equal(generated.includes('analytics.tiktok.com'), false);
    assert.equal(generated.includes('fbq'), true);
    assert.equal(generated.includes('ttq'), false);
    assert.equal(generated.includes('FB_PIXEL_ID'), false);
    assert.equal(generated.includes('TIKTOK_PIXEL_ID'), false);
    assert.equal(generated.includes('META_ROUTE_PIXEL_IDS'), true);
    assert.equal(generated.includes('new URL'), false);
    assert.equal(generated.includes("metaEventName + '_' + Date.now()"), false);
    assert.equal(generated.includes('fallbackEventId'), true);
    assert.equal(generated.includes('shopScopedIdentifier'), true);
    assert.equal(generated.includes('AbortController'), true);
    assert.equal(generated.includes('KEEPALIVE_LIMIT_BYTES'), true);
    assert.equal(generated.includes('MAX_BATCH_EVENTS'), true);
    assert.equal(generated.includes('requeueFailedEvents'), true);
    assert.equal(generated.includes('sendDualChannelEvent'), true);
    assert.equal(generated.includes('metaBrowserAdvancedMatching'), true);
    assert.equal(generated.includes('sendGatewayEvent'), false);
    assert.equal(generated.includes('trackSingleCustom'), true);
    assert.equal(generated.includes("var options = { eventID: String(eventId) }"), true);
    assert.equal(generated.includes('META_PIXEL_MAX_LOAD_ATTEMPTS = 3'), true);
    assert.equal(generated.includes('META_PIXEL_MAX_QUEUE_SIZE = 500'), true);
    assert.equal(generated.includes('CAPI_PIXEL_CONFIG_URL'), true);
    assert.equal(generated.includes('CAPI_PIXEL_DIAGNOSTIC_URL'), true);
    assert.equal(generated.includes('SERVER_BATCH_REJECTED'), true);
    assert.equal(generated.includes('RETRY_EXHAUSTED'), true);
    assert.equal(generated.includes('QUEUE_OVERFLOW'), true);
    assert.equal(generated.includes('refreshMetaRouteConfig'), true);
    assert.equal(generated.includes('_shopify_y'), false);
    assert.equal(generated.includes('_shopify_s'), false);
    assert.equal(generated.includes('browser.localStorage'), true);
    assert.equal(generated.includes('MAX_CLIENT_RETRIES = 32'), true);
    assert.equal(generated.includes('CLIENT_RETRY_MAX_AGE_MS'), true);
    assert.equal(generated.includes('retryAfterMsFromResponse'), true);
    assert.equal(generated.includes('isRetryableResponse'), true);
    assert.equal(generated.includes('trackingAllowedByPrivacy'), true);
    assert.equal(generated.includes("visitorConsentCollected"), true);
    assert.equal(generated.includes('clearQueuedTrackingData'), true);
    assert.match(generated, /function requeueFailedEvents[\s\S]*?if \(!trackingAllowedByPrivacy\(\)\) return/);
    assert.match(generated, /await loadPersistedEventQueue\(\);[\s\S]*?if \(!trackingAllowedByPrivacy\(\)\)/);
    assert.equal(generated.includes('getInitContext'), true);
    assert.equal(generated.includes('inFlightEvents'), true);
    assert.equal(generated.includes('storageWriteChain'), true);
    assert.equal(generated.includes('activeGatewayControllers'), true);
    assert.equal(generated.includes('flushPromise'), true);
    assert.match(generated, /storageWriteChain = storageWriteChain\.catch[\s\S]*?removeStorageValue\(STORAGE_QUEUE_KEY\)/);

    const callbacks = {};
    const requests = [];
    const configRequests = [];
    const diagnosticRequests = [];
    const cookies = new Map();
    const localStorage = new Map();
    const metaScriptNodes = [];
    const metaPixelWarnings = [];
    let rejectNextBatchIndex = -1;
    let privacyCallback;
    let uuidCounter = 0;
    const firstScript = {
        parentNode: {
            insertBefore: node => metaScriptNodes.push(node),
        },
    };
    const sandbox = {
        console: {
            log: console.log,
            error: console.error,
            warn: message => metaPixelWarnings.push(String(message)),
        },
        URL,
        Date,
        Math,
        TextEncoder,
        AbortController,
        crypto: {
            randomUUID: () => `uuid-${++uuidCounter}`,
            subtle: crypto.webcrypto.subtle,
        },
        setTimeout: () => 1,
        clearTimeout: () => {},
        window: {},
        document: {
            createElement: tagName => ({ tagName }),
            getElementsByTagName: tagName => tagName === 'script' ? [firstScript] : [],
        },
        analytics: {
            subscribe: (name, fn) => {
                callbacks[name] = fn;
            },
        },
        init: {
            customerPrivacy: {
                analyticsProcessingAllowed: true,
                marketingAllowed: true,
                preferencesProcessingAllowed: false,
                saleOfDataAllowed: true,
            },
        },
        customerPrivacy: {
            subscribe: (name, fn) => {
                assert.equal(name, 'visitorConsentCollected');
                privacyCallback = fn;
            },
        },
        browser: {
            cookie: {
                get: async name => cookies.get(name),
                set: async value => {
                    const [pair] = String(value).split(';');
                    const index = pair.indexOf('=');
                    cookies.set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)));
                },
            },
            localStorage: {
                getItem: async key => localStorage.get(key),
                setItem: async (key, value) => {
                    localStorage.set(key, String(value));
                },
                removeItem: async key => {
                    localStorage.delete(key);
                },
            },
        },
        fetch: async (url, options) => {
            if (String(url).endsWith('/api/pixel-config')) {
                configRequests.push({ url, options, body: JSON.parse(options.body) });
                return {
                    ok: true,
                    json: async () => ({
                        shop_domain: 'demo.myshopify.com',
                        pixel_ids: ['1234567890', '2222222222'],
                    }),
                };
            }
            if (String(url).endsWith('/api/pixel-diagnostic')) {
                diagnosticRequests.push({ url, options, body: JSON.parse(options.body) });
                return { ok: true, json: async () => ({ success: true }) };
            }
            const body = JSON.parse(options.body);
            requests.push({ url, options, body });
            const events = Array.isArray(body.events) ? body.events : [body];
            const rejectedIndex = rejectNextBatchIndex;
            rejectNextBatchIndex = -1;
            return {
                ok: true,
                json: async () => events.length > 1 ? {
                    success: rejectedIndex < 0,
                    batch: true,
                    results: events.map((event, index) => index === rejectedIndex
                        ? { success: false, rejected: true, status: 422, error: 'test rejection' }
                        : { success: true, queued: true, event_id: event.event_id }),
                } : { success: true, queued: true, event_id: events[0].event_id },
            };
        },
    };

    vm.runInNewContext(generated, sandbox);
    assert.equal(typeof privacyCallback, 'function');

    privacyCallback({
        customerPrivacy: {
            analyticsProcessingAllowed: true,
            marketingAllowed: false,
            preferencesProcessingAllowed: false,
            saleOfDataAllowed: false,
        },
    });
    await callbacks.page_viewed({
        id: 'privacy-blocked-page',
        timestamp: '2026-06-24T00:00:00Z',
        clientId: 'privacy-blocked-client',
        context: {
            document: { location: { href: 'https://demo.myshopify.com/private' } },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {},
    });
    await sandbox.flushEventQueue();
    assert.equal(requests.length, 0);
    assert.equal(localStorage.has('capi_gateway_event_queue_v3:demo.myshopify.com'), false);
    assert.equal(sandbox.window.fbq, undefined);

    privacyCallback({
        customerPrivacy: {
            analyticsProcessingAllowed: true,
            marketingAllowed: true,
            preferencesProcessingAllowed: false,
            saleOfDataAllowed: true,
        },
    });

    const mergedOfflineDuplicate = sandbox.mergeQueuedEvents([
        {
            event_name: 'AddPaymentInfo',
            event_id: 'demo.myshopify.com:checkout-1:AddPaymentInfo',
            timestamp: '2026-06-24T00:00:00Z',
            email_hash: hashFor('old@example.com', 'email'),
            _client_first_queued_at: 100,
            _client_retry_count: 2,
        },
        {
            event_name: 'AddPaymentInfo',
            event_id: 'demo.myshopify.com:checkout-1:AddPaymentInfo',
            timestamp: '2026-06-24T00:01:00Z',
            email_hash: hashFor('new@example.com', 'email'),
            phone_hash: hashFor('+12125551212', 'phone'),
            _client_first_queued_at: 200,
            _client_retry_count: 1,
        },
    ]);
    assert.equal(mergedOfflineDuplicate.length, 1);
    assert.equal(mergedOfflineDuplicate[0].timestamp, '2026-06-24T00:00:00Z');
    assert.equal(mergedOfflineDuplicate[0].email_hash, hashFor('new@example.com', 'email'));
    assert.equal(mergedOfflineDuplicate[0].phone_hash, hashFor('+12125551212', 'phone'));
    assert.equal(mergedOfflineDuplicate[0]._client_first_queued_at, 100);
    assert.equal(mergedOfflineDuplicate[0]._client_retry_count, 2);

    const storagePressure = Array.from({ length: 1001 }, (_, index) => ({
        event_name: 'PageView',
        event_id: `page-${index}`,
    }));
    storagePressure.push({ event_name: 'Purchase', event_id: 'critical-purchase' });
    const boundedStorage = sandbox.boundStoredEvents(storagePressure);
    assert.equal(boundedStorage.length, 1000);
    assert.equal(boundedStorage.some(item => item.event_id === 'critical-purchase'), true);
    assert.equal(boundedStorage.some(item => item.event_id === 'page-0'), false);
    assert.equal(sandbox.lineItemToContent({
        id: 'gid://shopify/CheckoutLineItem/ephemeral-line-id',
        quantity: 1,
    }).id, undefined);

    const event = {
        id: 'shopify-event-1',
        timestamp: '2026-06-24T00:00:00Z',
        clientId: 'client-1',
        context: {
            document: {
                location: { href: 'https://demo.myshopify.com/checkouts/cn?fbclid=fb1' },
                referrer: 'https://facebook.com/',
            },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {
            checkout: {
                token: 'checkout-token-1',
                totalPrice: { amount: '46.00', currencyCode: 'USD' },
                order: {
                    id: 'gid://shopify/Order/987',
                    customer: { isFirstOrder: true },
                },
                billingAddress: {
                    city: 'São Paulo',
                    provinceCode: 'SP',
                    zip: '94035-1234',
                    countryCode: 'US',
                },
                lineItems: [
                    {
                        merchandise: {
                            id: 'gid://shopify/ProductVariant/111',
                            price: { amount: '46.00', currencyCode: 'USD' },
                        },
                        quantity: 1,
                    },
                ],
            },
            customer: {
                email: 'Buyer@Example.com',
                phone: '001 (212) 555-1212',
                firstName: 'Valéry',
                lastName: 'Lovelace',
            },
        },
    };

    await Promise.all([
        callbacks.checkout_contact_info_submitted(event),
        callbacks.checkout_contact_info_submitted(event),
        callbacks.checkout_address_info_submitted(event),
        callbacks.checkout_shipping_info_submitted(event),
        callbacks.payment_info_submitted(event),
        callbacks.checkout_completed(event),
    ]);
    await sandbox.flushEventQueue();

    const sentEvents = requests.flatMap(request => Array.isArray(request.body.events) ? request.body.events : [request.body]);
    const ids = Object.fromEntries(sentEvents.map(body => [body.event_name, body.event_id]));
    assert.equal(requests.length, 1);
    assert.equal(configRequests.length, 1);
    assert.equal(configRequests[0].body.shop_domain, 'demo.myshopify.com');
    assert.equal(configRequests[0].body.ingest_token, 'test-ingest-token');
    assert.equal(requests[0].options.keepalive, true);
    assert.equal(requests[0].body.shop_domain, 'demo.myshopify.com');
    assert.equal(localStorage.has('capi_gateway_event_queue_v3:demo.myshopify.com'), false);
    assert.equal(sentEvents.filter(body => body.event_name === 'CheckoutContactInfoSubmitted').length, 1);
    assert.deepEqual(sentEvents[0].route_hints, {
        facebook_pixel_ids: ['1234567890', '2222222222'],
        tiktok_pixel_ids: ['TT123'],
    });
    assert.deepEqual(sentEvents[0].pixel_ids, ['1234567890', '2222222222']);
    assert.deepEqual(sentEvents[0].dataset_ids, ['1234567890', '2222222222']);
    assert.equal(sentEvents[0].pixel_id, undefined);
    assert.equal(sentEvents[0].schema_version, '2.0');
    assert.equal(sentEvents[0].source_version, 'shopify-pixel-v18');
    assert.equal(sentEvents[0].source_provider, 'shopify_web_pixels');
    assert.equal(sentEvents[0].source_event_id, 'shopify-event-1');
    assert.equal(generated.includes('getOrCreateTtp'), false);
    assert.equal(generated.includes('getOrCreateFbp'), false);
    assert.equal(generated.includes("return getCookieValue('_fbp')"), true);
    assert.equal(generated.includes("Math.floor(Math.random() * 10000000000)"), false);
    assert.ok(String(sentEvents[0].trace_id).startsWith('trace_uuid-'));
    assert.equal(sentEvents[0].action_source, 'website');
    assert.equal(sentEvents[0].customer_lifecycle, 'new_customer');
    assert.equal(sentEvents[0].event_source_url, 'https://demo.myshopify.com/checkouts/cn?fbclid=fb1');
    assert.equal(sentEvents[0].external_id, 'client-1');
    assert.equal(sentEvents[0].client_id, 'client-1');
    assert.equal(sentEvents[0]._shopify_order_id, '987');
    assert.equal(sentEvents[0].email, undefined);
    assert.equal(sentEvents[0].phone, undefined);
    assert.equal(sentEvents[0].email_hash, hashFor('Buyer@Example.com', 'email'));
    assert.equal(sentEvents[0].phone_hash, hashFor('001 (212) 555-1212', 'phone'));
    assert.equal(sentEvents[0].first_name_hash, hashFor('Valéry', 'name'));
    assert.notEqual(sentEvents[0].first_name_hash, hashFor('Valery', 'name'));
    assert.equal(sentEvents[0].city_hash, hashFor('São Paulo', 'city'));
    assert.equal(sentEvents[0].state_hash, hashFor('SP', 'state', { country: 'US' }));
    assert.equal(sentEvents[0].zip_hash, hashFor('94035-1234', 'zip', { country: 'US' }));
    assert.equal(sentEvents[0].country_hash, hashFor('US', 'country'));
    assert.deepEqual(ids, {
        CheckoutContactInfoSubmitted: 'demo.myshopify.com:shopify-event-1:CheckoutContactInfoSubmitted',
        CheckoutAddressInfoSubmitted: 'demo.myshopify.com:shopify-event-1:CheckoutAddressInfoSubmitted',
        CheckoutShippingInfoSubmitted: 'demo.myshopify.com:shopify-event-1:CheckoutShippingInfoSubmitted',
        AddPaymentInfo: 'demo.myshopify.com:shopify-event-1:AddPaymentInfo',
        Purchase: 'demo.myshopify.com:checkout-token-1',
    });
    assert.equal(
        sentEvents.find(body => body.event_name === 'Purchase').order_id,
        'demo.myshopify.com:987',
    );

    assert.equal(metaScriptNodes.length, 1);
    assert.equal(metaScriptNodes[0].src, 'https://connect.facebook.net/en_US/fbevents.js');
    const metaQueue = Array.from(sandbox.window.fbq.queue, call => Array.from(call));
    const metaInitCalls = metaQueue.filter(call => call[0] === 'init');
    const metaTrackCalls = metaQueue.filter(call => call[0] === 'trackSingle' || call[0] === 'trackSingleCustom');
    assert.deepEqual(metaInitCalls.map(call => call[1]).sort(), ['1234567890', '2222222222']);
    assert.ok(metaInitCalls.every(call => call.length === 3));
    assert.ok(metaInitCalls.every(call => call[2].em === 'buyer@example.com'));
    assert.ok(metaInitCalls.every(call => call[2].ph === '12125551212'));
    assert.ok(metaInitCalls.every(call => call[2].external_id === 'demo.myshopify.com:client-1'));
    assert.equal(metaTrackCalls.length, 10);
    assert.deepEqual([...new Set(metaTrackCalls.map(call => call[1]))].sort(), ['1234567890', '2222222222']);
    metaTrackCalls.forEach(call => {
        assert.equal(call[4].eventID, ids[call[2]]);
    });
    const browserPurchase = metaTrackCalls.filter(call => call[2] === 'Purchase');
    assert.equal(browserPurchase.length, 2);
    assert.ok(browserPurchase.every(call => call[0] === 'trackSingle'));
    assert.ok(browserPurchase.every(call => call[3].value === 46 && call[3].currency === 'USD'));
    assert.ok(browserPurchase.every(call => call[3].order_id === 'demo.myshopify.com:987'));
    assert.ok(browserPurchase.every(call => call[3].customer_segmentation === 'new_customer_to_business'));
    assert.ok(browserPurchase.every(call => call[3].num_items === undefined));
    assert.equal(sandbox.metaBrowserCustomData({ num_items: 3 }, 'AddToCart').num_items, undefined);
    assert.equal(sandbox.metaBrowserCustomData({ num_items: 3 }, 'InitiateCheckout').num_items, 3);
    assert.equal(sandbox.metaBrowserCustomData({ search_string: 'boots' }, 'PageView').search_string, undefined);
    assert.equal(sandbox.metaBrowserCustomData({ search_string: 'boots' }, 'Search').search_string, 'boots');
    const browserCheckoutContact = metaTrackCalls.filter(call => call[2] === 'CheckoutContactInfoSubmitted');
    assert.ok(browserCheckoutContact.every(call => call[0] === 'trackSingleCustom'));

    requests.length = 0;
    const longLocalEventId = `checkout-${'x'.repeat(400)}-browser-capi`;
    await callbacks.page_viewed({
        id: longLocalEventId,
        timestamp: '2026-06-24T00:00:20Z',
        clientId: 'client-long-id',
        context: {
            document: { location: { href: 'https://demo.myshopify.com/long-id' } },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {},
    });
    await sandbox.flushEventQueue();
    const longCapiEvent = requests.flatMap(request => (
        Array.isArray(request.body.events) ? request.body.events : [request.body]
    )).find(body => body.client_id === 'client-long-id');
    const expectedLongId = tenantScopedIdentifier('demo.myshopify.com', longLocalEventId);
    const longBrowserCalls = Array.from(sandbox.window.fbq.queue, call => Array.from(call))
        .filter(call => call[2] === 'PageView' && call[4]?.eventID === expectedLongId);
    assert.equal(longCapiEvent.event_id, expectedLongId);
    assert.equal(longCapiEvent.event_id.length, 255);
    assert.equal(longBrowserCalls.length, 2);
    const longOrderId = `order-${'y'.repeat(400)}-browser-capi`;
    assert.equal(
        await sandbox.shopScopedIdentifier(longOrderId),
        tenantScopedIdentifier('demo.myshopify.com', longOrderId),
    );

    metaScriptNodes[0].onerror();
    sandbox.metaBrowserSdkRetryAt = 0;
    requests.length = 0;
    await callbacks.page_viewed({
        id: 'sdk-load-retry',
        timestamp: '2026-06-24T00:00:30Z',
        clientId: 'client-sdk-retry',
        context: {
            document: { location: { href: 'https://demo.myshopify.com/sdk-retry' } },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {},
    });
    await sandbox.flushEventQueue();
    assert.equal(metaScriptNodes.length, 2);
    assert.equal(metaPixelWarnings.some(message => message.includes('SDK failed to load (attempt 1)')), true);

    for (let index = 0; index < 600; index += 1) {
        sandbox.sendMetaBrowserEvent('PageView', `queue-pressure-${index}`, {});
    }
    sandbox.sendMetaBrowserEvent('Purchase', 'queue-critical-purchase', { value: 1, currency: 'USD' });
    const boundedMetaQueue = Array.from(sandbox.window.fbq.queue, call => Array.from(call));
    assert.ok(boundedMetaQueue.length <= 500);
    assert.deepEqual(
        boundedMetaQueue.filter(call => call[0] === 'init').map(call => call[1]).sort(),
        ['1234567890', '2222222222'],
    );
    assert.equal(boundedMetaQueue.some(call => call[2] === 'Purchase' && call[4]?.eventID === 'queue-critical-purchase'), true);

    const originalFetch = sandbox.fetch;
    sandbox.fetch = async (url, options) => {
        if (String(url).endsWith('/api/pixel-config')) {
            return {
                ok: true,
                json: async () => ({
                    shop_domain: 'demo.myshopify.com',
                    pixel_ids: ['3333333333'],
                }),
            };
        }
        return originalFetch(url, options);
    };
    await sandbox.refreshMetaRouteConfig();
    sandbox.sendMetaBrowserEvent('ViewContent', 'dynamic-route-refresh', {});
    const dynamicRouteCalls = Array.from(sandbox.window.fbq.queue, call => Array.from(call))
        .filter(call => call[2] === 'ViewContent' && call[4]?.eventID === 'dynamic-route-refresh');
    assert.deepEqual(dynamicRouteCalls.map(call => call[1]), ['3333333333']);
    assert.equal(
        Array.from(sandbox.window.fbq.queue, call => Array.from(call))
            .some(call => call[0] === 'init' && call[1] === '3333333333'),
        true,
    );
    sandbox.applyMetaRoutePixelIds(['1234567890', '2222222222']);
    sandbox.fetch = originalFetch;

    const priorFbc = cookies.get('_fbc');
    assert.equal(await sandbox.getOrCreateFbc(`https://demo.myshopify.com/?fbclid=${'x'.repeat(1025)}`), priorFbc);
    assert.equal(await sandbox.getOrCreateFbc('https://demo.myshopify.com/?fbclid=invalid%20click'), priorFbc);
    assert.equal(cookies.get('_fbc'), priorFbc);

    requests.length = 0;
    await Promise.all(Array.from({ length: 25 }, (_, index) => (
        callbacks.page_viewed({
            timestamp: `2026-06-24T00:01:${String(index).padStart(2, '0')}Z`,
            clientId: `client-${index}`,
            context: {
                document: {
                    location: { href: `https://demo.myshopify.com/products/${index}` },
                    referrer: 'https://facebook.com/',
                },
                navigator: { userAgent: 'Mozilla/5.0' },
            },
            data: {},
        })
    )));
    await sandbox.flushEventQueue();

    const pageViewBatchSizes = requests.map(request => Array.isArray(request.body.events) ? request.body.events.length : 1);
    assert.deepEqual(pageViewBatchSizes, [20, 5]);
    assert.ok(requests.every(request => request.options.keepalive === true));

    await new Promise(resolve => setImmediate(resolve));
    await sandbox.flushClientDiagnostics();
    diagnosticRequests.length = 0;
    requests.length = 0;
    rejectNextBatchIndex = 1;
    sandbox.enqueueEventPayload({ event_name: 'AddToCart', event_id: 'batch-ok' });
    sandbox.enqueueEventPayload({ event_name: 'InitiateCheckout', event_id: 'batch-rejected' });
    await sandbox.flushEventQueue();
    await new Promise(resolve => setImmediate(resolve));
    await sandbox.flushClientDiagnostics();
    const partialRejection = diagnosticRequests.find(request => request.body.code === 'SERVER_BATCH_REJECTED');
    assert.equal(partialRejection.body.dropped_count, 1);
    assert.deepEqual(partialRejection.body.event_counts, { InitiateCheckout: 1 });

    requests.length = 0;
    const sameMomentEvent = {
        timestamp: '2026-06-24T00:02:00Z',
        clientId: 'client-same',
        context: {
            document: {
                location: { href: 'https://demo.myshopify.com/pages/about?fbclid=fb2' },
                referrer: 'https://facebook.com/',
            },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {},
    };
    await Promise.all([
        callbacks.page_viewed({ ...sameMomentEvent, seq: 1 }),
        callbacks.page_viewed({ ...sameMomentEvent, seq: 2 }),
    ]);
    await sandbox.flushEventQueue();

    const sameMomentEvents = requests.flatMap(request => Array.isArray(request.body.events) ? request.body.events : [request.body]);
    assert.equal(sameMomentEvents.length, 2);
    assert.notEqual(sameMomentEvents[0].event_id, sameMomentEvents[1].event_id);

    requests.length = 0;
    sandbox.init = {
        context: {
            document: {
                location: { href: 'https://demo.myshopify.com/init-fallback?fbclid=fb3' },
                referrer: 'https://instagram.com/',
            },
            navigator: { userAgent: 'InitUA/1.0' },
        },
        data: {
            customer: { id: 'gid://shopify/Customer/777', email: 'init@example.com' },
        },
    };
    await callbacks.page_viewed({
        timestamp: '2026-06-24T00:03:00Z',
        clientId: 'client-init',
        data: {},
    });
    await sandbox.flushEventQueue();

    const initFallbackEvent = Array.isArray(requests[0].body.events) ? requests[0].body.events[0] : requests[0].body;
    assert.equal(initFallbackEvent.event_source_url, 'https://demo.myshopify.com/init-fallback?fbclid=fb3');
    assert.equal(initFallbackEvent.user_agent, 'InitUA/1.0');
    assert.equal(initFallbackEvent.external_id, '777');

    requests.length = 0;
    await callbacks.cart_viewed({
        id: 'cart-view-1',
        timestamp: '2026-06-24T00:04:00Z',
        clientId: 'client-cart',
        context: {
            document: {
                location: { href: 'https://demo.myshopify.com/cart' },
            },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {
            cart: {
                totalQuantity: 3,
                lines: [
                    {
                        merchandise: { id: 'gid://shopify/ProductVariant/222' },
                        quantity: 3,
                    },
                ],
            },
        },
    });
    await sandbox.flushEventQueue();

    const cartViewEvent = Array.isArray(requests[0].body.events) ? requests[0].body.events[0] : requests[0].body;
    assert.equal(cartViewEvent.event_name, 'CartView');
    assert.equal(cartViewEvent.value, undefined);
    assert.equal(cartViewEvent.num_items, 3);

    requests.length = 0;
    await callbacks.product_added_to_cart({
        id: 'add-cart-1',
        timestamp: '2026-06-24T00:04:30Z',
        clientId: 'client-cart',
        context: {
            document: { location: { href: 'https://demo.myshopify.com/products/shirt' } },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {
            cartLine: {
                merchandise: {
                    id: 'gid://shopify/ProductVariant/333',
                    price: { amount: 20, currencyCode: 'USD' },
                    product: { title: 'Shirt', type: 'Apparel' },
                },
                quantity: 2,
                cost: { totalAmount: { amount: 30, currencyCode: 'USD' } },
            },
        },
    });
    await sandbox.flushEventQueue();
    const addToCart = Array.isArray(requests[0].body.events) ? requests[0].body.events[0] : requests[0].body;
    assert.equal(addToCart.event_name, 'AddToCart');
    assert.equal(addToCart.event_id, 'demo.myshopify.com:add-cart-1');
    assert.equal(addToCart.value, 30);
    assert.equal(addToCart.contents[0].item_price, 15);
    assert.equal(addToCart.content_name, 'Shirt');
    assert.equal(addToCart.content_category, 'Apparel');

    requests.length = 0;
    const repeatedCheckout = {
        timestamp: '2026-06-24T00:04:45Z',
        clientId: 'client-checkout',
        context: {
            document: { location: { href: 'https://demo.myshopify.com/checkouts/repeated' } },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {
            checkout: {
                token: 'same-checkout-token',
                totalPrice: { amount: 35, currencyCode: 'USD' },
                lineItems: [{
                    merchandise: { id: 'gid://shopify/ProductVariant/444' },
                    quantity: 2,
                    finalLinePrice: { amount: 30, currencyCode: 'USD' },
                }],
            },
        },
    };
    await callbacks.checkout_started({ ...repeatedCheckout, id: 'checkout-action-1' });
    await callbacks.checkout_started({ ...repeatedCheckout, id: 'checkout-action-2' });
    await sandbox.flushEventQueue();
    const checkoutActions = requests.flatMap(request => Array.isArray(request.body.events)
        ? request.body.events
        : [request.body]);
    assert.equal(checkoutActions.length, 2);
    assert.deepEqual(checkoutActions.map(item => item.event_id), [
        'demo.myshopify.com:checkout-action-1:InitiateCheckout',
        'demo.myshopify.com:checkout-action-2:InitiateCheckout',
    ]);
    assert.ok(checkoutActions.every(item => item.value === 35 && item.currency === 'USD'));
    assert.ok(checkoutActions.every(item => item.contents[0].item_price === 15));

    requests.length = 0;
    await callbacks.checkout_completed({
        id: 'zero-purchase-event',
        timestamp: '2026-06-24T00:05:00Z',
        clientId: 'client-zero',
        context: {
            document: { location: { href: 'https://demo.myshopify.com/checkouts/zero' } },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {
            checkout: {
                token: 'checkout-zero',
                subtotalPrice: { amount: 0, currencyCode: 'USD' },
                currencyCode: 'USD',
                lineItems: [],
            },
        },
    });
    await sandbox.flushEventQueue();
    const zeroPurchase = Array.isArray(requests[0].body.events) ? requests[0].body.events[0] : requests[0].body;
    assert.equal(zeroPurchase.value, 0);
    assert.equal(zeroPurchase.currency, 'USD');

    requests.length = 0;
    const queuedFbq = sandbox.window.fbq;
    sandbox.window.fbq = () => {
        throw new Error('simulated browser pixel failure');
    };
    await callbacks.page_viewed({
        id: 'browser-pixel-failure',
        timestamp: '2026-06-24T00:05:30Z',
        clientId: 'client-browser-failure',
        context: {
            document: { location: { href: 'https://demo.myshopify.com/browser-pixel-failure' } },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {},
    });
    await sandbox.flushEventQueue();
    const capiFallbackEvent = Array.isArray(requests[0].body.events) ? requests[0].body.events[0] : requests[0].body;
    assert.equal(capiFallbackEvent.event_id, 'demo.myshopify.com:browser-pixel-failure');
    assert.equal(metaPixelWarnings.filter(message => message.includes('Meta browser Pixel event failed')).length, 2);
    sandbox.window.fbq = queuedFbq;

    requests.length = 0;
    let releaseInFlightRequest;
    sandbox.fetch = async (url, options) => {
        requests.push({ url, options, body: JSON.parse(options.body) });
        return new Promise(resolve => {
            releaseInFlightRequest = resolve;
        });
    };
    await callbacks.page_viewed({
        id: 'in-flight-page-view',
        timestamp: '2026-06-24T00:06:00Z',
        clientId: 'client-in-flight',
        context: {
            document: { location: { href: 'https://demo.myshopify.com/in-flight' } },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {},
    });
    const inFlightFlush = sandbox.flushEventQueue();
    await new Promise(resolve => setImmediate(resolve));
    const storedInFlight = JSON.parse(localStorage.get('capi_gateway_event_queue_v3:demo.myshopify.com'));
    assert.equal(storedInFlight.some(item => item.event_id === 'demo.myshopify.com:in-flight-page-view'), true);
    releaseInFlightRequest({ ok: true });
    await inFlightFlush;
    assert.equal(localStorage.has('capi_gateway_event_queue_v3:demo.myshopify.com'), false);

    requests.length = 0;
    let consentAbortObserved = false;
    sandbox.fetch = async (url, options) => new Promise((resolve, reject) => {
        requests.push({ url, options, body: JSON.parse(options.body) });
        options.signal.addEventListener('abort', () => {
            consentAbortObserved = true;
            reject(new Error('consent revoked'));
        }, { once: true });
    });
    await callbacks.page_viewed({
        id: 'consent-revoked-in-flight',
        timestamp: '2026-06-24T00:06:30Z',
        clientId: 'client-consent-revoked',
        context: {
            document: { location: { href: 'https://demo.myshopify.com/consent-revoked' } },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {},
    });
    const revokedFlush = sandbox.flushEventQueue();
    await new Promise(resolve => setImmediate(resolve));
    privacyCallback({
        customerPrivacy: {
            analyticsProcessingAllowed: true,
            marketingAllowed: false,
            preferencesProcessingAllowed: false,
            saleOfDataAllowed: false,
        },
    });
    await revokedFlush;
    await sandbox.storageWriteChain;
    assert.equal(consentAbortObserved, true);
    assert.equal(localStorage.has('capi_gateway_event_queue_v3:demo.myshopify.com'), false);
    assert.equal(sandbox.window.fbq.queue.length, 0);

});

test('admin page script parses and handles admin action failures', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="\/admin\/assets\/admin\.css">/);
    assert.doesNotMatch(html, /cdn\.tailwindcss\.com/);
    const adminCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'admin.css'), 'utf8');
    assert.match(adminCss, /\.app-header/);
    assert.match(serverSource, /app\.get\('\/admin\/assets\/admin\.css'/);
    assert.match(html, /<script src="\/admin\/assets\/vue\.global\.prod\.js"><\/script>/);
    assert.doesNotMatch(html, /https:\/\/(?:unpkg\.com|cdn\.tailwindcss\.com)/);
    assert.match(html, /生成代码已经同时发送 Meta 浏览器 Pixel 与本项目 CAPI，并自动复用同一 eventID/);
    const localVue = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'vue.global.prod.js'), 'utf8');
    assert.match(localVue, /vue v3\.5\.40/);
    assert.match(serverSource, /app\.get\('\/admin\/assets\/vue\.global\.prod\.js'/);
    assert.match(serverSource, /server\.requestTimeout = config\.httpRequestTimeoutMs/);
    assert.match(serverSource, /server\.closeIdleConnections\?\.\(\)/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'ecosystem.config.js'), 'utf8'), /SHUTDOWN_TIMEOUT_MS/);
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    const adminScript = scripts.find(script => script.includes('createApp'));
    assert.ok(adminScript, 'admin Vue script should exist');

    let appOptions;
    let adminFetchRequest;
    const sandbox = {
        Vue: {
            createApp: options => {
                appOptions = options;
                assert.equal(typeof options.data, 'function');
                assert.equal(typeof options.computed.generatedCode, 'function');
                assert.equal(typeof options.computed.emqSignals, 'function');
                assert.equal(typeof options.computed.officialMetaQuality, 'function');
                assert.equal(typeof options.methods.addPixel, 'function');
                assert.equal(typeof options.methods.formatPercent, 'function');
                assert.equal(typeof options.methods.officialAverageScore, 'function');
                return { mount: () => {} };
            },
        },
        window: { location: { origin: 'https://nestworks.com.au:8443' } },
        fetch: async (requestPath, options) => {
            adminFetchRequest = { requestPath, options };
            return { ok: true, text: async () => '{}' };
        },
        console,
    };
    vm.runInNewContext(adminScript, sandbox);

    const context = {
        notice: null,
        busy: {},
        setNotice: appOptions.methods.setNotice,
    };
    const result = await appOptions.methods.runAction.call(context, 'savePixel', async () => {
        throw new Error('permission denied');
    });

    assert.equal(result, null);
    assert.equal(context.notice.type, 'error');
    assert.equal(context.notice.message, 'permission denied');
    assert.equal(context.busy.savePixel, false);
    assert.equal(appOptions.methods.formatPercent(82.345), '82.3%');
    assert.equal(appOptions.methods.formatPercent(null), '-');
    const defaultSignalKeys = JSON.parse(JSON.stringify(appOptions.computed.emqSignals.call({ summary: {} }).map(item => item.key)));
    assert.deepEqual(defaultSignalKeys, [
        'email',
        'phone',
        'external_id',
        'fbp',
        'fbc',
        'client_ip_address',
        'client_user_agent',
    ]);
    assert.equal(appOptions.methods.officialAverageScore({ summary: { average_score: 8.64 } }), '8.6/10');
    assert.equal(appOptions.methods.officialAverageScore({ summary: {} }), '-');
    assert.deepEqual(JSON.parse(JSON.stringify(appOptions.computed.officialMetaQuality.call({ summary: {} }))), []);
    await appOptions.methods.api('/api/admin/shops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
    assert.equal(adminFetchRequest.requestPath, '/api/admin/shops');
    assert.equal(adminFetchRequest.options.headers['X-CAPI-Admin-Request'], '1');
});

test('deployment workflow preserves production secrets and verifies runtime readiness', () => {
    const installer = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'install_ubuntu.sh'), 'utf8');
    const baotaTemplate = fs.readFileSync(
        path.join(__dirname, '..', 'deploy', 'baota-nginx-non443.conf.template'),
        'utf8',
    );
    const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
    const backup = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'backup.sh'), 'utf8');
    const restore = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'restore.sh'), 'utf8');
    const ownershipRepair = fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'repair-db-ownership.sh'),
        'utf8',
    );
    const baotaConfigurator = fs.readFileSync(
        path.join(__dirname, '..', 'deploy', 'configure_baota_nginx.sh'),
        'utf8',
    );
    const baotaUpdater = fs.readFileSync(
        path.join(__dirname, '..', 'deploy', 'update_baota.sh'),
        'utf8',
    );

    assert.match(installer, /FORCE_ENV_REWRITE="\$\{FORCE_ENV_REWRITE:-0\}"/);
    assert.match(installer, /Preserving existing \.env and database credentials/);
    assert.match(installer, /Creating a pre-upgrade database and environment backup/);
    assert.match(installer, /DB_PASSWORD is required when FORCE_ENV_REWRITE=1/);
    assert.match(installer, /AES_SECRET_KEY is required when FORCE_ENV_REWRITE=1/);
    assert.match(installer, /SHOPIFY_APP_SECRET="\$\{SHOPIFY_APP_SECRET:-\}"/);
    assert.match(installer, /META_PARTNER_AGENT="\$\{META_PARTNER_AGENT:-\}"/);
    assert.match(installer, /META_QUALITY_AGENT_NAME=\$\{META_QUALITY_AGENT_NAME\}/);
    assert.match(installer, /SHOPIFY_PRIVACY_RETENTION_DAYS=30/);
    assert.match(installer, /ALTER DATABASE .* OWNER TO/);
    assert.match(installer, /ALTER TABLE %I\.%I OWNER TO %I/);
    assert.match(installer, /ALTER SEQUENCE %I\.%I OWNER TO %I/);
    assert.match(installer, /verify_runtime\(\)/);
    assert.match(installer, /\/healthz/);
    assert.match(installer, /\/readyz/);
    assert.doesNotMatch(installer, /proxy_read_timeout 86400s/);
    assert.match(baotaTemplate, /proxy_set_header Connection ""/);
    assert.match(baotaTemplate, /proxy_read_timeout 35s/);
    assert.match(baotaTemplate, /listen __PUBLIC_PORT__ ssl;/);
    assert.match(baotaTemplate, /http2 on;/);
    assert.doesNotMatch(baotaTemplate, /listen __PUBLIC_PORT__ ssl http2;/);
    assert.match(ci, /npm run build:admin/);
    assert.match(ci, /npm ci --omit=dev --ignore-scripts/);
    assert.match(ci, /scripts\/repair-db-ownership\.sh/);
    assert.match(ci, /deploy\/configure_baota_nginx\.sh/);
    assert.match(ci, /deploy\/update_baota\.sh/);
    assert.match(backup, /trap cleanup_partial_files EXIT/);
    assert.match(backup, /pg_dump .*--file="\$DB_TMP"/);
    assert.match(backup, /pg_restore --list "\$DB_TMP"/);
    assert.match(backup, /mv -f -- "\$DB_TMP" "\$db_file"/);
    assert.match(restore, /--single-transaction/);
    assert.ok(
        restore.indexOf('pg_restore --list "$BACKUP_FILE"') < restore.indexOf('\n  stop_runtime\n'),
        'restore archives must be validated before runtime is stopped',
    );
    assert.match(restore, /for process_name in capi-api capi-worker/);
    assert.match(restore, /pm2_as_runtime_user stop "\$process_name"/);
    assert.match(restore, /pm2_as_runtime_user restart capi-api --update-env/);
    assert.match(restore, /pm2_as_runtime_user restart capi-worker --update-env/);
    assert.doesNotMatch(restore, /startOrReload/);
    assert.match(restore, /runtime remains stopped and maintenance mode stays enabled/);
    assert.match(baotaUpdater, /command -v pg_restore .*fail "pg_restore was not found/);
    assert.match(ownershipRepair, /DATABASE_URL must include a user and database name/);
    assert.match(ownershipRepair, /\/www\/server\/nodejs/);
    assert.match(ownershipRepair, /\/usr\/lib\/postgresql/);
    assert.match(ownershipRepair, /runuser -u postgres -- "\$PSQL_BIN"/);
    assert.doesNotMatch(ownershipRepair, /require\(['"]dotenv['"]\)/);
    assert.match(ownershipRepair, /ALTER SCHEMA public OWNER TO/);
    assert.match(ownershipRepair, /remaining_wrong_owners/);
    assert.match(baotaConfigurator, /INSTALL_WATCHER/);
    assert.match(baotaConfigurator, /nginx validation failed; restored the previous vhost configuration/);
    assert.match(baotaConfigurator, /PathChanged=\$\{VHOST_FILE\}/);
    assert.match(baotaConfigurator, /\/www\/server\/nginx\/sbin\/nginx/);
    assert.match(baotaConfigurator, /kill -HUP "\$nginx_master_pid"/);
    assert.doesNotMatch(baotaConfigurator, /systemctl reload nginx/);
    assert.match(baotaUpdater, /npm ci --omit=dev/);
    assert.match(baotaUpdater, /bash scripts\/repair-db-ownership\.sh/);
    assert.match(baotaUpdater, /pm2 start .*src\/worker\.js/);
    assert.match(baotaUpdater, /run_as_app bash scripts\/backup\.sh/);
    assert.match(baotaUpdater, /maintenance mode remains enabled/);
    assert.match(baotaUpdater, /APP_USER="\$\(stat -c '%U' "\$APP_DIR"\)"/);
    assert.doesNotMatch(baotaUpdater, /pm2 startup systemd -u root --hp \/root/);
});
