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
    shopifyCustomerSegmentation,
} = require('../src/events/shopify');
const {
    browserAttributionIdentity,
    buildBrowserAttributionSnapshot,
    buildCommerceAttributionSnapshot,
    sanitizeStoredAttribution,
    snapshotForAttributionKey,
} = require('../src/events/attribution');
const { mergePersistedEventPayload } = require('../src/events/merge');
const { eventHasSuccessfulDelivery, shouldSkipPixel, successfulDeliveryKeys } = require('../src/platforms/delivery');
const { aggregateDeliveryStatus, retryDelaySeconds } = require('../src/platforms/delivery-state');
const {
    normalizeMetaCookie,
    prepareMetaEvent,
    sanitizeMetaCustomData,
    sanitizeMetaUserData,
    validateMetaEvent,
} = require('../src/platforms/meta');
const {
    classifyFacebookError,
    metaRateControlFromHeaders,
    parseRetryAfterSeconds,
    retryDelayWithJitterSeconds,
} = require('../src/platforms/rate-control');
const { buildTikTokPayload, tiktokEventName } = require('../src/platforms/tiktok');
const { missingMatchSignals } = require('../src/utils/emq');
const {
    boundedScalarValues,
    collectHashedUserData,
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
    assert.equal(payload.event_id, 'demo.myshopify.com:checkout-token-1');
    assert.equal(payload.source_url, 'https://demo.myshopify.com/products/socks?fbclid=fb-click-1&ttclid=tt-click-1');
    assert.equal(payload.fbp, 'fb.1.browser');
    assert.equal(payload.fbc, 'fb.1.1234567890000.fb-click-1');
    assert.equal(normalizeMetaCookie(payload.fbc), payload.fbc);
    assert.equal(payload.ttp, 'ttp-cookie');
    assert.equal(payload.ttclid, 'tt-click-1');
    assert.equal(payload.client_id, 'shopify-y-cookie');
    assert.equal(payload.checkout_token, 'checkout-token-1');
    assert.equal(payload.shopify_y, 'shopify-y-cookie');
    assert.equal(payload.external_id, '12345');
    assert.deepEqual(payload.content_ids, ['111', '222']);
    assert.deepEqual(payload.contents, [
        { id: '111', quantity: 2, item_price: 8 },
        { id: '222', quantity: 1, item_price: 30 },
    ]);
    assert.equal(payload.num_items, 3);
    assert.equal(payload.order_id, '#1001');
    assert.equal(payload.customer_segmentation, 'new_customer_to_business');
    assert.equal(payload.timestamp, '2026-06-23T08:05:00Z');
});

test('Shopify customer segmentation uses explicit first-order state before order count', () => {
    assert.equal(shopifyCustomerSegmentation({ isFirstOrder: true, orders_count: 5 }), 'new_customer_to_business');
    assert.equal(shopifyCustomerSegmentation({ isFirstOrder: false, orders_count: 1 }), 'existing_customer_to_business');
    assert.equal(shopifyCustomerSegmentation({ orders_count: 1 }), 'new_customer_to_business');
    assert.equal(shopifyCustomerSegmentation({ orders_count: 2 }), 'existing_customer_to_business');
    assert.equal(shopifyCustomerSegmentation({}), undefined);
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

test('Shopify Purchase payload never invents a random dedupe identity', () => {
    const payload = buildShopifyOrderPurchasePayload({
        current_total_price: '10.00',
        currency: 'USD',
        line_items: [],
    }, 'demo.myshopify.com');
    assert.equal(payload.event_id, undefined);
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

test('Meta website events are validated before consuming platform quota', () => {
    const now = 1785000000;
    assert.deepEqual(validateMetaEvent({
        event_name: 'Purchase',
        event_id: 'checkout-1',
        event_time: now,
        action_source: 'website',
        event_source_url: 'https://demo.myshopify.com/checkouts/1',
        customer_segmentation: 'new_customer_to_business',
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
        customer_segmentation: 'guessed_customer',
        opt_out: 'false',
        user_data: { client_ip_address: '203.0.113.10', client_user_agent: 'Mozilla/5.0' },
    }, now), [
        'customer_segmentation must be a supported Meta segment',
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

test('schema defines multistore routing and per-route idempotency boundaries', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'init.sql'), 'utf8');
    const scaleIndexes = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'scale-indexes.sql'), 'utf8');
    const workerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker.js'), 'utf8');
    assert.match(schema, /CREATE TABLE IF NOT EXISTS shop_pixel_routes/);
    assert.match(schema, /UNIQUE \(shop_id, pixel_id\)/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS event_deliveries/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS event_id_aliases/);
    assert.match(schema, /UNIQUE \(shop_id, event_name, alias_type, alias_value\)/);
    assert.match(schema, /UNIQUE \(event_store_id, route_id\)/);
    assert.match(schema, /CREATE OR REPLACE FUNCTION enforce_event_delivery_tenant\(\)/);
    assert.match(schema, /JOIN shop_pixel_routes route ON route\.shop_id = event\.shop_id/);
    assert.match(schema, /CREATE TRIGGER trg_event_delivery_tenant/);
    assert.match(schema, /ON event_store\(shop_id, event_name, event_id\)/);
    assert.doesNotMatch(schema, /DROP TABLE IF EXISTS schema_migrations/);
    assert.match(schema, /indexdef NOT LIKE '%\(shop_id, event_name, event_id\)%'/);
    assert.match(schema, /rate_limit_until TIMESTAMPTZ/);
    assert.match(schema, /ALTER TABLE event_store SET \([\s\S]*?autovacuum_vacuum_scale_factor = 0\.02/);
    assert.match(scaleIndexes, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_store_pending_shop_time/);
    assert.match(scaleIndexes, /WHERE status = 'PENDING'/);
    assert.match(scaleIndexes, /idx_event_store_terminal_retention/);
    assert.match(scaleIndexes, /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_pixels_platform_external_id[\s\S]*?ON pixels\(platform, pixel_id\)/);
    assert.match(workerSource, /ed\.attempt_count = c\.attempt_count/);
    assert.match(workerSource, /redis\.call\("pexpire"/);
    assert.match(workerSource, /config\.deliveryMaxAttempts > 0/);
    assert.match(workerSource, /WHERE shop_id = \$1\s+AND id = ANY\(\$2::bigint\[\]\)/);
    assert.match(workerSource, /event\.status === 'PENDING' && Number\(event\.shop_id\) === normalizedShopId/);
    assert.match(workerSource, /scheduleShopContinuation\(normalizedShopId\)/);
    assert.match(workerSource, /config\.workerEventBatchSize/);
    assert.match(workerSource, /hasClaimableRouteEvents\(pixel\.route_id, idsToUpdate\)/);
    assert.match(workerSource, /status IN \('PENDING', 'RETRYABLE_FAILED'\)[\s\S]*?next_attempt_at <= NOW\(\)/);
    assert.match(workerSource, /const token = `\$\{process\.pid\}:\$\{crypto\.randomUUID\(\)\}`/);
    assert.match(workerSource, /lock:delivery-shop:\$\{normalizedShopId\}/);
    assert.match(workerSource, /lock:delivery-credential:\$\{credentialId\}/);
    assert.match(workerSource, /LEFT JOIN event_deliveries delivery[\s\S]*?delivery\.next_attempt_at <= NOW\(\)/);
    assert.match(workerSource, /const responseCode = Number\(response\.data\?\.code \?\? 0\)/);
    assert.doesNotMatch(schema, /ON event_store\(shop_id, event_name, md5\(event_id\)\)/);
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.match(serverSource, /AWAITING_PAYMENT/);
    assert.match(serverSource, /webhookTopic !== 'orders\/paid'/);
    assert.match(serverSource, /paymentConfirmed: true/);
    assert.match(serverSource, /ON CONFLICT \(shop_id, event_name, event_id\) DO NOTHING/);
    assert.match(serverSource, /SELECT id, shop_id, event_name, event_id, request_payload,[\s\S]*?FOR UPDATE/);
    assert.match(serverSource, /existing\.status === 'SUCCESS'/);
    assert.match(serverSource, /mergePersistedEventPayload\(existing\.request_payload, purePayload\)/);
    assert.match(serverSource, /calculateEMQ\(mergedPayload\.user_data \|\| \{\}\)/);
    assert.match(serverSource, /existing\.status === 'AWAITING_PAYMENT'[\s\S]*?purePayload\._payment_confirmed === true/);
    assert.match(serverSource, /paidOrderIgnoreReason/);
    assert.match(serverSource, /Missing stable order identity/);
    assert.match(serverSource, /if \(eventName !== 'Purchase'\) return \[\]/);
    assert.match(serverSource, /scheduler:stale_pending_shop_cursor/);
    assert.match(serverSource, /reconcileEventAggregateStatuses/);
    assert.match(serverSource, /capi-saas-pro:aggregate-reconcile/);
    assert.match(serverSource, /FOR UPDATE OF event SKIP LOCKED/);
    assert.match(serverSource, /SET status = CASE WHEN \$2::boolean THEN 'PENDING' ELSE status END,[\s\S]*?request_payload = \$4::jsonb/);
    assert.match(serverSource, /GROUP BY e\.shop_id\s+ORDER BY e\.shop_id ASC/);
    assert.match(serverSource, /jobId: `rescue-\$\{shopId\}-\$\{rescueMinute\}`/);
    assert.match(serverSource, /const state = await job\.getState\(\)/);
    assert.match(serverSource, /state === 'completed' \|\| state === 'failed'/);
    assert.match(serverSource, /cleanupExpiredOperationalData/);
    assert.match(serverSource, /status IN \('SUCCESS', 'FAILED', 'PARTIAL_FAILED', 'AWAITING_PAYMENT'\)/);
    assert.match(serverSource, /const persisted = await persistOutboxEvent\(shopId,[\s\S]*?isAwaitingPayment/);
    assert.match(serverSource, /tenant_id: shopDomain/);
    assert.match(serverSource, /order_id: tenantScopedIdentifier\(/);
    assert.match(serverSource, /customer_segmentation: normalizeCustomerSegmentation/);
    assert.match(serverSource, /WHERE platform = \$1 AND pixel_id = \$2/);
    assert.match(serverSource, /UNNEST\(\$1::int\[\]\) AS requested\(shop_id\)/);
    assert.match(serverSource, /SET status = 'inactive'[\s\S]*?WHERE pixel_id = \$1/);
    assert.match(serverSource, /error_code = 'ROUTE_INACTIVE'/);
    assert.match(serverSource, /route\.status = 'active'[\s\S]*?delivery\.status = 'FAILED_PERMANENT'/);
    assert.match(serverSource, /startRedisLockHeartbeat/);
    assert.match(serverSource, /if \(!config\.legacyRedisDrainEnabled\) return/);
    assert.match(serverSource, /if \(statusCode >= 500\) throw error/);
    assert.match(serverSource, /requireBoundedString\(trustedPayload\.event_id, 'event_id', 4096\)/);
    assert.match(serverSource, /err\.statusCode \|\| err\.status \|\| 500/);
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
    const webhookPersistIndex = serverSource.indexOf('const result = await queueEventForOutbox(req, {');
    const webhookReceiptIndex = serverSource.indexOf("'Shopify webhook receipt save'");
    assert.ok(
        webhookPersistIndex >= 0 && webhookReceiptIndex > webhookPersistIndex,
        'webhook receipt must be saved only after durable outbox persistence',
    );
});

test('runtime config rejects weak encryption keys and malformed CORS origins', () => {
    const weakSecret = probeConfig({ AES_SECRET_KEY: 'too-short' });
    assert.notEqual(weakSecret.status, 0);
    assert.match(weakSecret.stderr, /AES_SECRET_KEY must be at least 32 characters/);

    const malformedOrigin = probeConfig({ CORS_ORIGIN: 'https://shop.example.com/path' });
    assert.notEqual(malformedOrigin.status, 0);
    assert.match(malformedOrigin.stderr, /CORS_ORIGIN entries must be exact http\(s\) origins/);

    const invalidJsonLimit = probeConfig({ JSON_LIMIT: 'unlimited' });
    assert.notEqual(invalidJsonLimit.status, 0);
    assert.match(invalidJsonLimit.stderr, /JSON_LIMIT must be a byte size/);

    const excessiveJsonLimit = probeConfig({ JSON_LIMIT: '17mb' });
    assert.notEqual(excessiveJsonLimit.status, 0);
    assert.match(excessiveJsonLimit.stderr, /JSON_LIMIT must be between 1kb and 16mb/);

    const malformedApiVersion = probeConfig({ FB_API_VERSION: '../latest' });
    assert.notEqual(malformedApiVersion.status, 0);
    assert.match(malformedApiVersion.stderr, /FB_API_VERSION must look like v25\.0/);

    const valid = probeConfig({
        CORS_ORIGIN: 'https://shop.example.com,http://localhost:3000',
        TRUST_PROXY_HOPS: '0',
    });
    assert.equal(valid.status, 0, valid.stderr);
    const parsed = JSON.parse(valid.stdout);
    assert.deepEqual(parsed.corsOrigin, ['https://shop.example.com', 'http://localhost:3000']);
    assert.equal(parsed.trustProxy, 0);

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

    assert.match(serverSource, /app\.use\('\/api\/pixel-event', cors\(/);
    assert.doesNotMatch(serverSource, /app\.use\(cors\(/);
    assert.doesNotMatch(serverSource, /contentSecurityPolicy: false/);
    assert.doesNotMatch(serverSource, /https:\/\/cdn\.tailwindcss\.com/);
    assert.match(workerSource, /error\.partialDelivery =/);
    assert.match(workerSource, /retryable_event_ids/);
    assert.match(workerSource, /await applyPlatformResult\(/);
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

test('generated Shopify pixel uses unique checkout stage event IDs while preserving Purchase dedupe ID', async () => {
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

    assert.equal(generated.includes('document.createElement'), false);
    assert.equal(generated.includes('typeof document'), false);
    assert.equal(generated.includes('connect.facebook.net'), false);
    assert.equal(generated.includes('analytics.tiktok.com'), false);
    assert.equal(generated.includes('fbq'), false);
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
    assert.equal(generated.includes('sendDualChannelEvent'), false);
    assert.equal(generated.includes('sendGatewayEvent'), true);
    assert.equal(generated.includes('browser.localStorage'), true);
    assert.equal(generated.includes('MAX_CLIENT_RETRIES = 32'), true);
    assert.equal(generated.includes('CLIENT_RETRY_MAX_AGE_MS'), true);
    assert.equal(generated.includes('retryAfterMsFromResponse'), true);
    assert.equal(generated.includes('isRetryableResponse'), true);
    assert.equal(generated.includes('trackingAllowedByPrivacy'), false);
    assert.equal(generated.includes('getInitContext'), true);
    assert.equal(generated.includes('inFlightEvents'), true);
    assert.equal(generated.includes('storageWriteChain'), true);
    assert.equal(generated.includes('flushPromise'), true);

    const callbacks = {};
    const requests = [];
    const cookies = new Map();
    const localStorage = new Map();
    let uuidCounter = 0;
    const sandbox = {
        console,
        URL,
        Date,
        Math,
        TextEncoder,
        crypto: {
            randomUUID: () => `uuid-${++uuidCounter}`,
            subtle: crypto.webcrypto.subtle,
        },
        setTimeout: () => 1,
        clearTimeout: () => {},
        analytics: {
            subscribe: (name, fn) => {
                callbacks[name] = fn;
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
            requests.push({ url, options, body: JSON.parse(options.body) });
            return { ok: true };
        },
    };

    vm.runInNewContext(generated, sandbox);

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
    assert.equal(sentEvents[0].source_version, 'shopify-pixel-v10');
    assert.equal(generated.includes('getOrCreateTtp'), false);
    assert.equal(generated.includes('getOrCreateFbp'), false);
    assert.equal(generated.includes("return getCookieValue('_fbp')"), true);
    assert.equal(generated.includes("Math.floor(Math.random() * 10000000000)"), false);
    assert.ok(String(sentEvents[0].trace_id).startsWith('trace_uuid-'));
    assert.equal(sentEvents[0].action_source, 'website');
    assert.equal(sentEvents[0].customer_segmentation, 'new_customer_to_business');
    assert.equal(sentEvents[0].event_source_url, 'https://demo.myshopify.com/checkouts/cn?fbclid=fb1');
    assert.equal(sentEvents[0].external_id, 'client-1');
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
        CheckoutContactInfoSubmitted: 'demo.myshopify.com:checkout-token-1:CheckoutContactInfoSubmitted',
        CheckoutAddressInfoSubmitted: 'demo.myshopify.com:checkout-token-1:CheckoutAddressInfoSubmitted',
        CheckoutShippingInfoSubmitted: 'demo.myshopify.com:checkout-token-1:CheckoutShippingInfoSubmitted',
        AddPaymentInfo: 'demo.myshopify.com:checkout-token-1:AddPaymentInfo',
        Purchase: 'demo.myshopify.com:checkout-token-1',
    });

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
    assert.match(html, /只有两边的事件名称和 eventID 完全一致时 Meta 才能浏览器\/服务端去重/);
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
});

test('deployment workflow preserves production secrets and verifies runtime readiness', () => {
    const installer = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'install_ubuntu.sh'), 'utf8');
    const baotaTemplate = fs.readFileSync(
        path.join(__dirname, '..', 'deploy', 'baota-nginx-non443.conf.template'),
        'utf8',
    );
    const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

    assert.match(installer, /FORCE_ENV_REWRITE="\$\{FORCE_ENV_REWRITE:-0\}"/);
    assert.match(installer, /Preserving existing \.env and database credentials/);
    assert.match(installer, /Creating a pre-upgrade database and environment backup/);
    assert.match(installer, /DB_PASSWORD is required when FORCE_ENV_REWRITE=1/);
    assert.match(installer, /AES_SECRET_KEY is required when FORCE_ENV_REWRITE=1/);
    assert.match(installer, /verify_runtime\(\)/);
    assert.match(installer, /\/healthz/);
    assert.match(installer, /\/readyz/);
    assert.doesNotMatch(installer, /proxy_read_timeout 86400s/);
    assert.match(baotaTemplate, /proxy_set_header Connection ""/);
    assert.match(baotaTemplate, /proxy_read_timeout 35s/);
    assert.match(ci, /npm run build:admin/);
    assert.match(ci, /npm ci --omit=dev --ignore-scripts/);
});
