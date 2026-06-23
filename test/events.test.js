const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.DATABASE_URL ||= 'postgres://user:pass@127.0.0.1:5432/test';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.AES_SECRET_KEY ||= 'test-secret-key-with-at-least-32-chars';
process.env.ADMIN_USERNAME ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'password';

const { stripPrivateFields } = require('../src/events/common');
const { buildShopifyOrderPurchasePayload } = require('../src/events/shopify');
const { eventHasSuccessfulDelivery, shouldSkipPixel, successfulDeliveryKeys } = require('../src/platforms/delivery');
const { buildTikTokPayload, tiktokEventName } = require('../src/platforms/tiktok');
const { missingMatchSignals } = require('../src/utils/emq');
const { normalizeForHash } = require('../src/utils/crypto');

function sha256(value) {
    return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

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
        customer: { id: 12345 },
        line_items: [
            { variant_id: 111, quantity: 2, price: '8.00' },
            { product_id: 222, quantity: 1, price: '30.00' },
        ],
    }, 'demo.myshopify.com', { nowMs: 1234567890 });

    assert.equal(payload.event_name, 'Purchase');
    assert.equal(payload.event_id, 'checkout-token-1');
    assert.equal(payload.source_url, 'https://demo.myshopify.com/products/socks?fbclid=fb-click-1&ttclid=tt-click-1');
    assert.equal(payload.fbp, 'fb.1.browser');
    assert.equal(payload.fbc, 'fb.1.1234567890.fb-click-1');
    assert.equal(payload.ttp, 'ttp-cookie');
    assert.equal(payload.ttclid, 'tt-click-1');
    assert.equal(payload.client_id, 'shopify-y-cookie');
    assert.equal(payload.checkout_token, 'checkout-token-1');
    assert.equal(payload.shopify_y, 'shopify-y-cookie');
    assert.deepEqual(payload.external_id, ['12345', 'shopify-y-cookie', 'checkout-token-1', '987', '#1001']);
    assert.deepEqual(payload.content_ids, ['111', '222']);
    assert.deepEqual(payload.contents, [
        { id: '111', quantity: 2, item_price: 8 },
        { id: '222', quantity: 1, item_price: 30 },
    ]);
    assert.equal(payload.num_items, 3);
    assert.equal(payload.order_id, '#1001');
});

test('buildShopifyOrderPurchasePayload normalizes Shopify GIDs for Purchase dedupe fallback', () => {
    const payload = buildShopifyOrderPurchasePayload({
        id: 'gid://shopify/Order/987',
        email: 'buyer@example.com',
        current_total_price: '46.00',
        currency: 'USD',
        line_items: [],
    }, 'demo.myshopify.com');

    assert.equal(payload.event_id, '987');
    assert.equal(payload.order_id, '987');
    assert.deepEqual(payload.external_id, ['987']);
});

test('buildTikTokPayload maps Purchase to CompletePayment and preserves dedupe event_id', () => {
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
    assert.equal(payload.event, 'CompletePayment');
    assert.equal(payload.event_id, 'checkout-token-1');
    assert.equal(payload.context.ad.callback, 'tt-click-1');
    assert.equal(payload.context.user.ttp, 'ttp-cookie');
    assert.equal(payload.properties.value, 46);
    assert.equal(payload.properties.currency, 'USD');
    assert.equal(payload.properties.order_id, '#1001');
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
    assert.equal(normalizeForHash('+1 (212) 555-1212', 'phone'), '12125551212');
    assert.equal(normalizeForHash(' São Paulo ', 'city'), 'saopaulo');
    assert.equal(normalizeForHash(' E1 1AA ', 'zip'), 'e11aa');
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
    assert.equal(tiktokEventName('Purchase'), 'CompletePayment');
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
            fb_response: {
                deliveries: [
                    { platform: 'facebook', pixel_id: 'META1', status: 'SUCCESS' },
                    { platform: 'tiktok', pixel_id: 'TT1', status: 'SUCCESS' },
                ],
            },
        },
        {
            fb_response: {
                deliveries: [
                    { platform: 'facebook', pixel_id: 'META1', status: 'SUCCESS' },
                    { platform: 'tiktok', pixel_id: 'TT1', status: 'FAILED' },
                ],
            },
        },
    ]);

    assert.equal(shouldSkipPixel({ platform: 'facebook', pixel_id: 'META1' }, keys), true);
    assert.equal(shouldSkipPixel({ platform: 'tiktok', pixel_id: 'TT1' }, keys), false);
});

test('eventHasSuccessfulDelivery checks success per event and pixel', () => {
    const event = {
        fb_response: {
            deliveries: [
                { platform: 'facebook', pixel_id: 'META1', status: 'SUCCESS' },
                { platform: 'tiktok', pixel_id: 'TT1', status: 'FAILED' },
            ],
        },
    };

    assert.equal(eventHasSuccessfulDelivery(event, { platform: 'facebook', pixel_id: 'META1' }), true);
    assert.equal(eventHasSuccessfulDelivery(event, { platform: 'tiktok', pixel_id: 'TT1' }), false);
});

test('generated Shopify pixel uses unique checkout stage event IDs while preserving Purchase dedupe ID', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
    const match = html.match(/generatedCode\(\)\s*{\s*return `([\s\S]*?)`;\s*}\s*,\s*}\s*,\s*methods:/);
    assert.ok(match, 'generatedCode template should exist');

    const generated = match[1]
        .replaceAll('${this.apiDomain}', 'https://nestworks.com.au:8443')
        .replaceAll('${this.currentShop}', 'demo.myshopify.com')
        .replaceAll('${this.currentPixelId}', '1234567890')
        .replaceAll('${this.currentTikTokPixelId}', '');

    const callbacks = {};
    const bodies = [];
    const cookies = new Map();
    const sandbox = {
        console,
        URL,
        Date,
        Math,
        globalThis: {},
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
        },
        fetch: async (url, options) => {
            bodies.push(JSON.parse(options.body));
            return { ok: true };
        },
    };

    vm.runInNewContext(generated, sandbox);

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
                order: { id: 'gid://shopify/Order/987' },
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
        },
    };

    callbacks.checkout_contact_info_submitted(event);
    callbacks.checkout_contact_info_submitted(event);
    callbacks.checkout_address_info_submitted(event);
    callbacks.checkout_shipping_info_submitted(event);
    callbacks.payment_info_submitted(event);
    callbacks.checkout_completed(event);

    await new Promise(resolve => setTimeout(resolve, 0));

    const ids = Object.fromEntries(bodies.map(body => [body.event_name, body.event_id]));
    assert.equal(bodies.filter(body => body.event_name === 'CheckoutContactInfoSubmitted').length, 1);
    assert.deepEqual(ids, {
        CheckoutContactInfoSubmitted: 'checkout-token-1:CheckoutContactInfoSubmitted',
        CheckoutAddressInfoSubmitted: 'checkout-token-1:CheckoutAddressInfoSubmitted',
        CheckoutShippingInfoSubmitted: 'checkout-token-1:CheckoutShippingInfoSubmitted',
        AddPaymentInfo: 'checkout-token-1:AddPaymentInfo',
        Purchase: 'checkout-token-1',
    });
});
