const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Shopify Standard Events reference, audited 2026-08-07:
// https://shopify.dev/docs/api/web-pixels-api/standard-events?who=publisher
const SHOPIFY_STANDARD_EVENTS = Object.freeze([
    'alert_displayed',
    'cart_viewed',
    'checkout_address_info_submitted',
    'checkout_completed',
    'checkout_contact_info_submitted',
    'checkout_shipping_info_submitted',
    'checkout_started',
    'collection_viewed',
    'page_viewed',
    'payment_info_submitted',
    'product_added_to_cart',
    'product_removed_from_cart',
    'product_viewed',
    'search_submitted',
    'ui_extension_errored',
]);

function assert(condition, message) {
    if (!condition) throw new Error(`Shopify pixel audit failed: ${message}`);
}

function generatedPixelSource() {
    const htmlPath = path.join(__dirname, '..', 'src', 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const match = html.match(/generatedCode\(\)\s*{\s*return compactGeneratedPixelSource\(`([\s\S]*?)`\);\s*}/);
    assert(match, 'generatedCode template was not found');

    const rendered = match[1]
        .replaceAll('${this.apiDomain}', 'https://capi.example.com')
        .replaceAll('${this.currentShop}', 'audit.myshopify.com')
        .replaceAll('${this.currentShopIngestToken}', 'audit-ingest-token')
        .replaceAll('${JSON.stringify(this.currentMetaPixelIds)}', '["1234567890"]')
        .replaceAll('${JSON.stringify(this.currentTikTokPixelIds)}', '[]');

    return Function(`return \`${rendered}\`;`)()
        .replace(/^[\t ]+/gm, '')
        .replace(/^\/\/[^\r\n]*(?:\r?\n|$)/gm, '')
        .replace(/(?:\r?\n){2,}/g, '\n')
        .trim();
}

function audit() {
    const source = generatedPixelSource();
    assert(source.length <= 64_000, `generated code has ${source.length} characters; maximum is 64,000`);
    assert(!/<\/?(?:script|noscript)\b/i.test(source), 'custom pixel must contain JavaScript only, without HTML tags');
    assert(!/\bdocument\.cookie\b|\bwindow\.localStorage\b|\bwindow\.sessionStorage\b/.test(source), 'top-frame storage must use Shopify browser APIs');
    assert(!/\bwindow\.location\b/.test(source), 'top-frame URLs must come from Shopify event/init context');
    assert(!/\n\s*(?:[?:]|&&|\|\||\?\?)/.test(source), 'a continuation operator starts a line and can fail Shopify static checks');
    assert(source.includes('browser.cookie.get'), 'Shopify BrowserCookie getter is missing');
    assert(source.includes('browser.cookie.set'), 'Shopify BrowserCookie setter is missing');
    assert(source.includes('browser.localStorage.getItem'), 'Shopify BrowserLocalStorage getter is missing');
    assert(source.includes('browser.localStorage.setItem'), 'Shopify BrowserLocalStorage setter is missing');
    assert(source.includes("subscribe('visitorConsentCollected'"), 'Shopify customer-privacy update subscription is missing');
    assert(source.includes('init.customerPrivacy'), 'Shopify initial customer-privacy state is missing');
    assert(source.includes('event.context'), 'Shopify top-frame event context is missing');
    assert(source.includes('event.timestamp'), 'Shopify authoritative event timestamp is missing');
    assert(source.includes('event.id'), 'Shopify authoritative event ID is missing');
    assert(source.includes('shopify-pixel-v25'), 'current source version is not v25');
    assert(source.includes('META_CLICK_ID_MAX_LENGTH = 500'), 'official Meta fbclid length boundary is missing');
    assert(source.includes('getOrCreateFbp'), 'official first-party fbp management is missing');
    assert(source.includes('primeMetaAttributionCookies'), 'landing-page fbp/fbc capture is missing');
    assert(source.includes('lineItem.lineComponents'), 'Shopify bundle lineComponents support is missing');
    assert(source.includes('checkoutContents(checkout)'), 'checkout bundle contents mapping is missing');
    assert(source.includes("subscribe('all_standard_events'"), 'future standard-event compatibility alarm is missing');

    const subscriptions = [...source.matchAll(/analytics\.subscribe\('([^']+)'/g)].map(item => item[1]);
    for (const eventName of SHOPIFY_STANDARD_EVENTS) {
        assert(
            subscriptions.filter(name => name === eventName).length === 1,
            `${eventName} must have exactly one schema-aware subscription`,
        );
    }
    const unexpected = subscriptions.filter(name => (
        name !== 'all_standard_events' && !SHOPIFY_STANDARD_EVENTS.includes(name)
    ));
    assert(unexpected.length === 0, `unexpected subscriptions: ${unexpected.join(', ')}`);
    assert(
        subscriptions.filter(name => name === 'all_standard_events').length === 1,
        'all_standard_events compatibility alarm must be subscribed exactly once',
    );

    new vm.Script(source, { filename: 'shopify-customer-events-v25.js' });
    return {
        sourceVersion: 'shopify-pixel-v25',
        characters: source.length,
        standardEvents: SHOPIFY_STANDARD_EVENTS.length,
        aggregateCompatibilityAlarm: true,
        syntax: 'valid',
    };
}

if (require.main === module) {
    console.log(JSON.stringify(audit()));
}

module.exports = { SHOPIFY_STANDARD_EVENTS, audit, generatedPixelSource };
