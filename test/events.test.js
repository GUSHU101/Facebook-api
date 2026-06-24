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
const { decryptTokenIfPossible, encryptToken, normalizeForHash } = require('../src/utils/crypto');

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
    assert.equal(payload.external_id, '12345');
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
    assert.equal(payload.external_id, '987');
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

test('encrypted secret helper remains backward compatible with plaintext values', () => {
    const encrypted = encryptToken('shopify-secret-1');
    assert.equal(decryptTokenIfPossible(encrypted), 'shopify-secret-1');
    assert.equal(decryptTokenIfPossible('legacy-plaintext-secret'), 'legacy-plaintext-secret');
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

test('generated Shopify pixel uses unique checkout stage event IDs while preserving Purchase dedupe ID', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
    const match = html.match(/generatedCode\(\)\s*{\s*return `([\s\S]*?)`;\s*}\s*,\s*}\s*,\s*methods:/);
    assert.ok(match, 'generatedCode template should exist');

    const generated = match[1]
        .replaceAll('${this.apiDomain}', 'https://nestworks.com.au:8443')
        .replaceAll('${this.currentShop}', 'demo.myshopify.com')
        .replaceAll('${JSON.stringify(this.currentMetaPixelIds)}', '["1234567890"]')
        .replaceAll('${JSON.stringify(this.currentTikTokPixelIds)}', '["TT123"]');

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
    assert.equal(generated.includes('AbortController'), true);
    assert.equal(generated.includes('KEEPALIVE_LIMIT_BYTES'), true);
    assert.equal(generated.includes('MAX_BATCH_EVENTS'), true);
    assert.equal(generated.includes('requeueFailedEvents'), true);
    assert.equal(generated.includes('trackingAllowedByPrivacy'), true);
    assert.equal(generated.includes('getInitContext'), true);

    const callbacks = {};
    const requests = [];
    const cookies = new Map();
    const sandbox = {
        console,
        URL,
        Date,
        Math,
        globalThis: {},
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
        },
        fetch: async (url, options) => {
            requests.push({ url, options, body: JSON.parse(options.body) });
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
    await sandbox.flushEventQueue();

    const sentEvents = requests.flatMap(request => Array.isArray(request.body.events) ? request.body.events : [request.body]);
    const ids = Object.fromEntries(sentEvents.map(body => [body.event_name, body.event_id]));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.keepalive, true);
    assert.equal(requests[0].body.shop_domain, 'demo.myshopify.com');
    assert.equal(sentEvents.filter(body => body.event_name === 'CheckoutContactInfoSubmitted').length, 1);
    assert.deepEqual(sentEvents[0].route_hints, {
        facebook_pixel_ids: ['1234567890'],
        tiktok_pixel_ids: ['TT123'],
    });
    assert.equal(sentEvents[0].action_source, 'website');
    assert.equal(sentEvents[0].event_source_url, 'https://demo.myshopify.com/checkouts/cn?fbclid=fb1');
    assert.equal(sentEvents[0].external_id, 'client-1');
    assert.deepEqual(ids, {
        CheckoutContactInfoSubmitted: 'checkout-token-1:CheckoutContactInfoSubmitted',
        CheckoutAddressInfoSubmitted: 'checkout-token-1:CheckoutAddressInfoSubmitted',
        CheckoutShippingInfoSubmitted: 'checkout-token-1:CheckoutShippingInfoSubmitted',
        AddPaymentInfo: 'checkout-token-1:AddPaymentInfo',
        Purchase: 'checkout-token-1',
    });

    requests.length = 0;
    for (let index = 0; index < 25; index += 1) {
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
        });
    }
    await new Promise(resolve => setTimeout(resolve, 0));
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
    callbacks.page_viewed({ ...sameMomentEvent, seq: 1 });
    callbacks.page_viewed({ ...sameMomentEvent, seq: 2 });
    await new Promise(resolve => setTimeout(resolve, 0));
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
        customerPrivacy: {
            analyticsProcessingAllowed: true,
            marketingAllowed: true,
        },
    };
    callbacks.page_viewed({
        timestamp: '2026-06-24T00:03:00Z',
        clientId: 'client-init',
        data: {},
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    await sandbox.flushEventQueue();

    const initFallbackEvent = Array.isArray(requests[0].body.events) ? requests[0].body.events[0] : requests[0].body;
    assert.equal(initFallbackEvent.event_source_url, 'https://demo.myshopify.com/init-fallback?fbclid=fb3');
    assert.equal(initFallbackEvent.user_agent, 'InitUA/1.0');
    assert.equal(initFallbackEvent.external_id, '777');

    requests.length = 0;
    sandbox.init.customerPrivacy.marketingAllowed = false;
    callbacks.page_viewed({
        timestamp: '2026-06-24T00:04:00Z',
        clientId: 'client-privacy',
        context: {
            document: { location: { href: 'https://demo.myshopify.com/privacy' } },
            navigator: { userAgent: 'Mozilla/5.0' },
        },
        data: {},
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    await sandbox.flushEventQueue();
    assert.equal(requests.length, 0);
});

test('admin page script parses and handles admin action failures', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
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
                assert.equal(typeof options.methods.addPixel, 'function');
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
});
