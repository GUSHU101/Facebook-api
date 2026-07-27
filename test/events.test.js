// CAPI SaaS Hub - Shopify Customer Events Unified Event Gateway
const CAPI_HUB_URL = "https://pixel.atelierwrap.cc:8443/api/pixel-event";
const CAPI_PIXEL_CONFIG_URL = "https://pixel.atelierwrap.cc:8443/api/pixel-config";
const SHOP_DOMAIN = "jr078r-zx.myshopify.com";
const SHOP_INGEST_TOKEN = "853c679c1e298f3c59845d0c5e0eaa78eb638efc3c4c61a51b594fa43b11f703";
var META_ROUTE_PIXEL_IDS = ["1017012367716175"];
const TIKTOK_ROUTE_PIXEL_IDS = [];
const SCHEMA_VERSION = "2.0";
const SOURCE_VERSION = "shopify-pixel-v14";
const META_PIXEL_SCRIPT_URL = "https://connect.facebook.net/en_US/fbevents.js";
const META_STANDARD_BROWSER_EVENTS = new Set([
    'PageView', 'ViewContent', 'Search', 'AddToCart',
    'InitiateCheckout', 'AddPaymentInfo', 'Purchase',
]);
const META_PIXEL_MAX_LOAD_ATTEMPTS = 3;
const META_PIXEL_RETRY_BACKOFF_MS = [1000, 5000, 30000];
const META_PIXEL_MAX_QUEUE_SIZE = 500;
const META_ROUTE_CONFIG_WAIT_MS = 500;
const META_ROUTE_CONFIG_TTL_MS = 60 * 1000;
const META_ROUTE_CONFIG_STORAGE_KEY = 'capi_meta_route_config_v1:' + SHOP_DOMAIN;
const META_PIXEL_LOW_PRIORITY_EVENTS = new Set([
    'PageView', 'Search', 'CartView', 'CollectionView',
    'RemoveFromCart', 'CheckoutContactInfoSubmitted',
    'CheckoutAddressInfoSubmitted', 'CheckoutShippingInfoSubmitted',
]);
const RECENT_EVENT_TTL_MS = 5000;
const MAX_RECENT_EVENTS = 5000;
const EVENT_QUEUE_FLUSH_MS = 1000;
const FETCH_TIMEOUT_MS = 8000;
const KEEPALIVE_LIMIT_BYTES = 60000;
const MAX_BATCH_EVENTS = 20;
const MAX_CLIENT_RETRIES = 32;
const CLIENT_RETRY_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;
const RETRY_BACKOFF_MS = [1000, 3000, 10000, 30000, 60000, 300000, 900000, 1800000, 3600000, 7200000, 14400000, 21600000];
const STORAGE_QUEUE_KEY = 'capi_gateway_event_queue_v3:' + SHOP_DOMAIN;
const MAX_STORED_EVENTS = 1000;
const recentEvents = new Map();
const eventQueue = [];
var inFlightEvents = [];
var eventQueueTimer = null;
var persistedQueueLoaded = false;
var storageWriteChain = Promise.resolve();
var flushPromise = null;
const initializedMetaBrowserPixelIds = new Set();
var metaBrowserSdkLoading = false;
var metaBrowserSdkLoadAttempts = 0;
var metaBrowserSdkRetryAt = 0;
var metaRouteConfigPromise = null;
var metaRouteConfigPending = false;

function normalizedMetaPixelIds() {
    return Array.from(new Set(META_ROUTE_PIXEL_IDS.map(function (value) {
        return String(value || '').trim();
    }).filter(function (value) {
        return /^\d{5,32}$/.test(value);
    })));
}

function trimMetaBrowserQueue() {
    var fbq = typeof window !== 'undefined' && window.fbq;
    var queue = fbq && fbq.queue;
    if (!Array.isArray(queue) || fbq.callMethod || queue.length <= META_PIXEL_MAX_QUEUE_SIZE) return;

    function removeOldest(predicate) {
        var index = queue.findIndex(function (call) {
            return call && call[0] !== 'init' && predicate(call);
        });
        if (index < 0) return false;
        queue.splice(index, 1);
        return true;
    }

    while (queue.length > META_PIXEL_MAX_QUEUE_SIZE) {
        if (removeOldest(function (call) { return META_PIXEL_LOW_PRIORITY_EVENTS.has(call[2]); })) continue;
        if (removeOldest(function (call) { return call[2] !== 'Purchase'; })) continue;
        if (removeOldest(function () { return true; })) continue;
        break;
    }
}

function injectMetaBrowserPixelScript() {
    if (metaBrowserSdkLoading || metaBrowserSdkLoadAttempts >= META_PIXEL_MAX_LOAD_ATTEMPTS) return;
    if (Date.now() < metaBrowserSdkRetryAt) return;

    metaBrowserSdkLoading = true;
    metaBrowserSdkLoadAttempts += 1;
    var attempt = metaBrowserSdkLoadAttempts;
    try {
        var script = document.createElement('script');
        script.async = true;
        script.src = META_PIXEL_SCRIPT_URL;
        script.onload = function () {
            metaBrowserSdkLoading = false;
            metaBrowserSdkRetryAt = 0;
            trimMetaBrowserQueue();
        };
        script.onerror = function () {
            metaBrowserSdkLoading = false;
            var delay = META_PIXEL_RETRY_BACKOFF_MS[Math.min(attempt - 1, META_PIXEL_RETRY_BACKOFF_MS.length - 1)];
            metaBrowserSdkRetryAt = Date.now() + delay;
            console.warn('Meta browser Pixel SDK failed to load (attempt ' + attempt + '); server CAPI remains active');
            if (attempt < META_PIXEL_MAX_LOAD_ATTEMPTS && typeof setTimeout === 'function') {
                setTimeout(function () {
                    if (!metaBrowserSdkLoading && metaBrowserSdkLoadAttempts === attempt) {
                        metaBrowserSdkRetryAt = 0;
                        bootstrapMetaBrowserPixel();
                    }
                }, delay + 25);
            }
        };
        var firstScript = document.getElementsByTagName && document.getElementsByTagName('script')[0];
        if (firstScript && firstScript.parentNode) firstScript.parentNode.insertBefore(script, firstScript);
        else {
            var scriptParentNode = document.head || document.body || document.documentElement;
            if (!scriptParentNode || !scriptParentNode.appendChild) throw new Error('No script parent available');
            scriptParentNode.appendChild(script);
        }
    } catch (error) {
        metaBrowserSdkLoading = false;
        var retryDelay = META_PIXEL_RETRY_BACKOFF_MS[Math.min(attempt - 1, META_PIXEL_RETRY_BACKOFF_MS.length - 1)];
        metaBrowserSdkRetryAt = Date.now() + retryDelay;
        console.warn('Meta browser Pixel SDK injection failed; server CAPI remains active');
        if (attempt < META_PIXEL_MAX_LOAD_ATTEMPTS && typeof setTimeout === 'function') {
            setTimeout(function () {
                if (!metaBrowserSdkLoading && metaBrowserSdkLoadAttempts === attempt) {
                    metaBrowserSdkRetryAt = 0;
                    bootstrapMetaBrowserPixel();
                }
            }, retryDelay + 25);
        }
    }
}

function bootstrapMetaBrowserPixel() {
    var pixelIds = normalizedMetaPixelIds();
    if (!pixelIds.length || typeof window === 'undefined' || typeof document === 'undefined') return false;

    try {
        if (!window.fbq) {
            var fbq = function () {
                if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments);
                else fbq.queue.push(arguments);
            };
            window.fbq = fbq;
            window._fbq = fbq;
            fbq.push = fbq;
            fbq.loaded = true;
            fbq.version = '2.0';
            fbq.queue = [];
        }

        if (!window.fbq.callMethod) injectMetaBrowserPixelScript();

        pixelIds.forEach(function (pixelId) {
            if (initializedMetaBrowserPixelIds.has(pixelId)) return;
            window.fbq('init', pixelId);
            initializedMetaBrowserPixelIds.add(pixelId);
        });
        trimMetaBrowserQueue();
        return true;
    } catch (error) {
        console.warn('Meta browser Pixel initialization failed; server CAPI remains active');
        return false;
    }
}

function metaBrowserCustomData(customData) {
    customData = customData || {};
    return compact({
        value: customData.value,
        currency: customData.currency,
        content_ids: customData.content_ids,
        contents: customData.contents,
        content_type: customData.content_type,
        num_items: customData.num_items,
        search_string: customData.search_string,
        content_name: customData.content_name,
        content_category: customData.content_category,
        order_id: customData.order_id,
    });
}

function sendMetaBrowserEvent(eventName, eventId, customData) {
    if (!eventId || !bootstrapMetaBrowserPixel()) return false;
    var command = META_STANDARD_BROWSER_EVENTS.has(eventName) ? 'trackSingle' : 'trackSingleCustom';
    var parameters = metaBrowserCustomData(customData);
    var options = { eventID: String(eventId) };
    normalizedMetaPixelIds().forEach(function (pixelId) {
        try {
            window.fbq(command, pixelId, eventName, parameters, options);
        } catch (error) {
            console.warn('Meta browser Pixel event failed for dataset ' + pixelId);
        }
    });
    trimMetaBrowserQueue();
    return true;
}

async function getCookieValue(name) {
    try {
        if (typeof browser !== 'undefined' && browser.cookie && browser.cookie.get) {
            return await browser.cookie.get(name);
        }
    } catch (error) {}
    return undefined;
}

async function setCookieValue(name, value, days) {
    if (!value) return;
    var maxAge = (days || 90) * 24 * 60 * 60;
    try {
        if (typeof browser !== 'undefined' && browser.cookie && browser.cookie.set) {
            await browser.cookie.set(name + '=' + encodeURIComponent(value) + '; max-age=' + maxAge + '; path=/; SameSite=Lax');
            return;
        }
    } catch (error) {}
}

async function getStorageValue(key) {
    try {
        if (typeof browser !== 'undefined' && browser.localStorage && browser.localStorage.getItem) {
            return await browser.localStorage.getItem(key);
        }
    } catch (error) {}
    return undefined;
}

async function setStorageValue(key, value) {
    try {
        if (typeof browser !== 'undefined' && browser.localStorage && browser.localStorage.setItem) {
            await browser.localStorage.setItem(key, value);
        }
    } catch (error) {}
}

async function removeStorageValue(key) {
    try {
        if (typeof browser !== 'undefined' && browser.localStorage && browser.localStorage.removeItem) {
            await browser.localStorage.removeItem(key);
        }
    } catch (error) {}
}

function applyMetaRoutePixelIds(values) {
    if (!Array.isArray(values)) return false;
    META_ROUTE_PIXEL_IDS = Array.from(new Set(values.map(function (value) {
        return String(value || '').trim();
    }).filter(function (value) {
        return /^\d{5,32}$/.test(value);
    })));
    return true;
}

async function refreshMetaRouteConfig() {
    try {
        var cachedText = await getStorageValue(META_ROUTE_CONFIG_STORAGE_KEY);
        var cached = cachedText ? JSON.parse(cachedText) : null;
        var cacheBelongsToShop = cached && cached.shop_domain === SHOP_DOMAIN;
        var cacheIsFresh = cached && Number(cached.expires_at || 0) > Date.now();
        if (cacheBelongsToShop && cacheIsFresh && Array.isArray(cached.pixel_ids)) {
            applyMetaRoutePixelIds(cached.pixel_ids);
        }
    } catch (error) {}

    var options = requestOptionsForBody(JSON.stringify({
        shop_domain: SHOP_DOMAIN,
        ingest_token: SHOP_INGEST_TOKEN,
    }));
    options.keepalive = false;
    try {
        var response = await fetch(CAPI_PIXEL_CONFIG_URL, options);
        if (!response || response.ok === false || typeof response.json !== 'function') return false;
        var payload = await response.json();
        if (!payload || payload.shop_domain !== SHOP_DOMAIN || !Array.isArray(payload.pixel_ids)) return false;
        applyMetaRoutePixelIds(payload.pixel_ids);
        await setStorageValue(META_ROUTE_CONFIG_STORAGE_KEY, JSON.stringify({
            shop_domain: SHOP_DOMAIN,
            pixel_ids: META_ROUTE_PIXEL_IDS,
            expires_at: Date.now() + META_ROUTE_CONFIG_TTL_MS,
        }));
        return true;
    } catch (error) {
        return false;
    } finally {
        if (options._timeoutId) clearTimeout(options._timeoutId);
    }
}

async function waitForMetaRouteConfig() {
    if (!metaRouteConfigPromise || !metaRouteConfigPending) return;
    await Promise.race([
        metaRouteConfigPromise,
        new Promise(function (resolve) { setTimeout(resolve, META_ROUTE_CONFIG_WAIT_MS); }),
    ]);
}

function startMetaRouteConfigRefresh() {
    metaRouteConfigPending = true;
    metaRouteConfigPromise = refreshMetaRouteConfig().finally(function () {
        metaRouteConfigPending = false;
    });
}

function scheduleMetaRouteConfigRefresh() {
    if (typeof setTimeout !== 'function') return;
    setTimeout(function () {
        startMetaRouteConfigRefresh();
        scheduleMetaRouteConfigRefresh();
    }, META_ROUTE_CONFIG_TTL_MS);
}

function moneyAmount(value) {
    var raw = value;
    if (value && typeof value === 'object') {
        raw = firstNonEmpty(value.amount, value.value);
    }
    var amount = Number(raw);
    return Number.isFinite(amount) ? amount : undefined;
}

function moneyCurrency(value, fallback) {
    return (value && (value.currencyCode || value.currency)) || fallback;
}

function firstNonEmpty() {
    return Array.prototype.slice.call(arguments).find(function (value) {
        return value !== undefined && value !== null && value !== '';
    });
}

function normalizeShopifyId(value) {
    if (value === undefined || value === null || value === '') return undefined;
    var text = String(value).trim();
    var marker = 'gid://shopify/';
    if (!text.startsWith(marker)) return text || undefined;
    return text.slice(marker.length).split('/').pop() || undefined;
}

function fallbackIdentifierDigest(value) {
    var text = String(value || '');
    var seeds = [2166136261, 2246822507, 3266489909, 668265263];
    return seeds.map(function (seed, seedIndex) {
        var hash = seed >>> 0;
        for (var index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index) + seedIndex;
            hash = Math.imul(hash, 16777619) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
    }).join('');
}

async function rawSha256Hex(value) {
    try {
        var cryptoApi = typeof globalThis !== 'undefined' && globalThis.crypto;
        var subtle = cryptoApi && cryptoApi.subtle;
        var encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined;
        if (subtle && encoder) {
            return toHex(await subtle.digest('SHA-256', encoder.encode(String(value))));
        }
    } catch (error) {}
    return undefined;
}

async function shopScopedIdentifier(value, maxLength) {
    var normalized = normalizeShopifyId(value);
    if (!normalized) return undefined;
    var prefix = String(SHOP_DOMAIN || '').trim().toLowerCase() + ':';
    var text = String(normalized).trim();
    var scoped = text.toLowerCase().indexOf(prefix) === 0 ? prefix + text.slice(prefix.length) : prefix + text;
    var boundedLength = Number(maxLength || 255);
    if (scoped.length <= boundedLength) return scoped;
    var digest = await rawSha256Hex(scoped) || fallbackIdentifierDigest(scoped);
    var suffix = String(digest).slice(0, 32);
    return scoped.slice(0, Math.max(0, boundedLength - suffix.length - 1)) + '-' + suffix;
}

function lineItemToContent(item) {
    item = item || {};
    var variant = item.variant || item.merchandise || {};
    var product = item.product || variant.product || {};
    var quantity = Number(item.quantity || 1);
    var totalPrice = moneyAmount(item.cost && item.cost.totalAmount || item.finalLinePrice);
    var price = moneyAmount(item.cost && item.cost.amountPerQuantity || variant.price);
    if (totalPrice !== undefined && quantity > 0) {
        price = totalPrice / quantity;
    }
    return {
        id: normalizeShopifyId(variant.id || product.id || item.id),
        quantity: Number.isFinite(quantity) ? quantity : 1,
        item_price: price,
    };
}

function compact(object) {
    var output = {};
    Object.keys(object).forEach(function (key) {
        var value = object[key];
        if (value !== undefined && value !== null && value !== '') output[key] = value;
    });
    return output;
}

function normalizeForHash(value, type, contextCountry) {
    if (value === undefined || value === null) return undefined;
    var normalized = String(value).trim().toLowerCase();
    if (!normalized) return undefined;
    if (type === 'email') {
        if (/\s/.test(normalized)) return undefined;
    } else if (type === 'phone') {
        var rawPhone = String(value).trim();
        var hasInternationalPrefix = /^\+|^00/.test(rawPhone);
        normalized = rawPhone.replace(/[^0-9]/g, '').replace(/^0+/, '');
        var phoneCountry = String(contextCountry || '').trim().toLowerCase().replace(/[^a-z]/g, '');
        if (!hasInternationalPrefix) {
            var northAmericanCountries = ['us', 'usa', 'unitedstates', 'unitedstatesofamerica', 'ca', 'canada'];
            if (northAmericanCountries.indexOf(phoneCountry) !== -1) {
                if (/^\d{10}$/.test(normalized)) normalized = '1' + normalized;
                else if (!/^1\d{10}$/.test(normalized)) normalized = '';
            } else {
                normalized = '';
            }
        }
    } else if (type === 'name') {
        normalized = normalized.replace(/[^\p{L}\p{N}]/gu, '');
    } else if (type === 'city' || type === 'state') {
        try {
            normalized = normalized.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        } catch (error) {}
        normalized = normalized.replace(/[^\p{L}\p{N}]/gu, '');
        if (type === 'state') {
            var stateCountry = String(contextCountry || '').trim().toLowerCase().replace(/[^a-z]/g, '');
            var isUnitedStates = ['us', 'usa', 'unitedstates', 'unitedstatesofamerica'].indexOf(stateCountry) !== -1;
            if (isUnitedStates && !/^[a-z]{2}$/.test(normalized)) normalized = '';
        }
    } else if (type === 'zip') {
        normalized = normalized.replace(/[^a-z0-9]/g, '');
        var country = String(contextCountry || '').trim().toLowerCase().replace(/[^a-z]/g, '');
        if (country === 'us' || country === 'usa' || country === 'unitedstates' || country === 'unitedstatesofamerica') {
            var usZip = normalized.match(/^\d{5}/);
            normalized = usZip ? usZip[0] : '';
        }
    } else if (type === 'country') {
        normalized = /^[a-z]{2}$/.test(normalized) ? normalized : '';
    } else {
        normalized = normalized.replace(/\s+/g, '');
    }
    return normalized || undefined;
}

function isSha256Hex(value) {
    return /^[a-f0-9]{64}$/.test(String(value || '').trim().toLowerCase());
}

function toHex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (byte) {
        return byte.toString(16).padStart(2, '0');
    }).join('');
}

async function sha256Hex(value, type, contextCountry) {
    var normalized = normalizeForHash(value, type, contextCountry);
    if (!normalized) return undefined;
    if (isSha256Hex(normalized)) return normalized;
    try {
        var cryptoApi = typeof globalThis !== 'undefined' && globalThis.crypto;
        var subtle = cryptoApi && cryptoApi.subtle;
        var encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined;
        if (subtle && encoder) {
            return toHex(await subtle.digest('SHA-256', encoder.encode(normalized)));
        }
    } catch (error) {}
    return undefined;
}

function randomId(prefix) {
    try {
        var cryptoApi = typeof globalThis !== 'undefined' && globalThis.crypto;
        if (cryptoApi && cryptoApi.randomUUID) return prefix + '_' + cryptoApi.randomUUID();
    } catch (error) {}
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
}

function safeDecode(value) {
    try {
        return decodeURIComponent(String(value || '').replace(/\+/g, ' '));
    } catch (error) {
        return String(value || '');
    }
}

function getUrlParam(name, href) {
    var text = String(href || '');
    var queryStart = text.indexOf('?');
    if (queryStart === -1) return undefined;

    var queryEnd = text.indexOf('#', queryStart);
    var query = text.slice(queryStart + 1, queryEnd === -1 ? text.length : queryEnd);
    var parts = query.split('&');
    for (var index = 0; index < parts.length; index += 1) {
        var part = parts[index];
        if (!part) continue;
        var equalsIndex = part.indexOf('=');
        var rawKey = equalsIndex === -1 ? part : part.slice(0, equalsIndex);
        var rawValue = equalsIndex === -1 ? '' : part.slice(equalsIndex + 1);
        var key = safeDecode(rawKey);
        if (key === name) return safeDecode(rawValue) || undefined;
    }
    return undefined;
}

function shouldSendRecentEvent(eventName, eventId) {
    var now = Date.now();
    var key = eventName + ':' + eventId;
    recentEvents.forEach(function (expiresAt, item) {
        if (expiresAt <= now) recentEvents.delete(item);
    });
    if (recentEvents.has(key)) return false;
    recentEvents.set(key, now + RECENT_EVENT_TTL_MS);
    while (recentEvents.size > MAX_RECENT_EVENTS) {
        recentEvents.delete(recentEvents.keys().next().value);
    }
    return true;
}

function eventIdFrom(value) {
    var normalized = normalizeShopifyId(value);
    return normalized ? String(normalized) : undefined;
}

function stableHash(value) {
    var text = String(value || '');
    var hash = 2166136261;
    for (var index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

async function fallbackEventId(eventName, event, currentUrl) {
    var stableInput = [
        SHOP_DOMAIN,
        event && event.clientId,
        event && event.timestamp,
        event && event.seq,
        event && event.name,
        currentUrl,
        eventName,
    ].join('|');
    var digest = await sha256Hex(stableInput, 'default');
    if (digest) return eventName + '_' + digest.slice(0, 32);
    // Two independent deterministic hashes keep fallback IDs stable across
    // client retries in environments without Web Crypto.
    var stablePart = stableHash(stableInput);
    var stablePartReversed = stableHash(stableInput.split('').reverse().join(''));
    return eventName + '_' + stablePart + stablePartReversed;
}

function purchaseEventId(checkout, event) {
    checkout = checkout || {};
    return firstNonEmpty(checkout.token, checkout.checkoutToken, eventIdFrom(checkout.order && checkout.order.id), checkout.order && checkout.order.name, event.id);
}

function checkoutStageEventId(checkout, event, eventName) {
    checkout = checkout || {};
    var baseId = firstNonEmpty(checkout.token, checkout.checkoutToken, event.id);
    return baseId ? String(baseId) + ':' + eventName : undefined;
}

function checkoutLineItems(checkout) {
    return Array.isArray(checkout && checkout.lineItems) ? checkout.lineItems : [];
}

function checkoutValue(checkout) {
    checkout = checkout || {};
    return moneyAmount(firstNonEmpty(checkout.totalPrice, checkout.subtotalPrice));
}

function checkoutCurrency(checkout) {
    checkout = checkout || {};
    return moneyCurrency(firstNonEmpty(checkout.totalPrice, checkout.subtotalPrice), checkout.currencyCode);
}

async function getFbp() {
    // _fbp identifies a browser that the Meta Pixel has actually observed.
    // Forward the real first-party cookie when present; inventing one would
    // create a synthetic match signal and can reduce attribution accuracy.
    return getCookieValue('_fbp');
}

async function getOrCreateFbc(href) {
    var fbclid = String(getUrlParam('fbclid', href) || '').trim();
    if (!fbclid || fbclid.length > 1024 || /\s/.test(fbclid)) fbclid = undefined;
    var existing = await getCookieValue('_fbc');
    if (fbclid && (!existing || !existing.endsWith('.' + fbclid))) {
        var generated = 'fb.1.' + Date.now() + '.' + fbclid;
        await setCookieValue('_fbc', generated);
        return generated;
    }
    return existing;
}

async function getTtp() {
    // TikTok documents ttp as the first-party cookie used with its Pixel.
    // Forward a real existing value, but never fabricate a match identifier.
    return getCookieValue('_ttp');
}

async function rememberTtclid(href) {
    var fromUrl = getUrlParam('ttclid', href);
    if (fromUrl) {
        await setCookieValue('ttclid', fromUrl);
        return fromUrl;
    }
    return getCookieValue('ttclid');
}

function primaryExternalId(event, customer, checkout, checkoutToken) {
    return firstNonEmpty(
        normalizeShopifyId(customer && customer.id),
        normalizeShopifyId(checkout && checkout.order && checkout.order.customer && checkout.order.customer.id),
        event && event.clientId,
        checkoutToken
    );
}

function getInitContext() {
    try {
        if (typeof init !== 'undefined' && init && init.context) return init.context;
    } catch (error) {}
    return {};
}

function getInitData() {
    try {
        if (typeof init !== 'undefined' && init && init.data) return init.data;
    } catch (error) {}
    return {};
}

function scheduleEventQueueFlush(delayMs) {
    if (eventQueueTimer) clearTimeout(eventQueueTimer);
    eventQueueTimer = setTimeout(function () {
        eventQueueTimer = null;
        flushEventQueue();
    }, Math.max(0, delayMs || EVENT_QUEUE_FLUSH_MS));
}

function mergeQueuedEvents(events) {
    var merged = [];
    var indexes = new Map();
    events.forEach(function (event) {
        var key = [event.event_name, event.event_id].join(':');
        if (!indexes.has(key)) {
            indexes.set(key, merged.length);
            merged.push(event);
            return;
        }
        var index = indexes.get(key);
        var existing = merged[index];
        var combined = Object.assign({}, existing, event);
        var firstQueuedAt = [existing._client_first_queued_at, event._client_first_queued_at]
            .map(Number).filter(Number.isFinite);
        var retryCount = Math.max(Number(existing._client_retry_count || 0), Number(event._client_retry_count || 0));
        var nextAttemptAt = [existing._client_next_attempt_at, event._client_next_attempt_at]
            .map(Number).filter(function (value) { return Number.isFinite(value) && value > 0; });
        var existingTime = Date.parse(String(existing.timestamp || ''));
        var eventTime = Date.parse(String(event.timestamp || ''));
        combined._client_first_queued_at = firstQueuedAt.length ? Math.min.apply(Math, firstQueuedAt) : Date.now();
        combined._client_retry_count = retryCount || undefined;
        combined._client_next_attempt_at = nextAttemptAt.length ? Math.min.apply(Math, nextAttemptAt) : undefined;
        combined.timestamp = firstNonEmpty(existing.timestamp, event.timestamp);
        if (Number.isFinite(existingTime) && Number.isFinite(eventTime)) {
            combined.timestamp = existingTime <= eventTime ? existing.timestamp : event.timestamp;
        }
        merged[index] = compact(combined);
    });
    return merged;
}

function storedEventPriority(event) {
    var priorities = {
        Purchase: 100,
        AddPaymentInfo: 90,
        InitiateCheckout: 80,
        AddToCart: 70,
        CheckoutShippingInfoSubmitted: 60,
        CheckoutAddressInfoSubmitted: 60,
        CheckoutContactInfoSubmitted: 60,
    };
    return priorities[event && event.event_name] || 10;
}

function boundStoredEvents(events) {
    var merged = mergeQueuedEvents(events);
    if (merged.length <= MAX_STORED_EVENTS) return merged;
    return merged.map(function (event, index) {
        return { event: event, index: index, priority: storedEventPriority(event) };
    }).sort(function (left, right) {
        if (right.priority !== left.priority) return right.priority - left.priority;
        return right.index - left.index;
    }).slice(0, MAX_STORED_EVENTS).sort(function (left, right) {
        return left.index - right.index;
    }).map(function (item) { return item.event; });
}

function persistEventQueue() {
    // Keep unconfirmed in-flight requests in durable browser storage. If the
    // page closes after the server accepted them, stable event IDs make the
    // replay harmless; dropping them before acceptance would be irreversible.
    var storable = boundStoredEvents(inFlightEvents.concat(eventQueue));
    storageWriteChain = storageWriteChain.then(function () {
        if (!storable.length) return removeStorageValue(STORAGE_QUEUE_KEY);
        return setStorageValue(STORAGE_QUEUE_KEY, JSON.stringify(storable));
    });
    return storageWriteChain;
}

async function loadPersistedEventQueue() {
    if (persistedQueueLoaded) return;
    persistedQueueLoaded = true;
    await storageWriteChain;
    var stored = await getStorageValue(STORAGE_QUEUE_KEY);
    if (!stored) return;
    try {
        var parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length) {
            var merged = boundStoredEvents(parsed.concat(eventQueue));
            eventQueue.splice(0, eventQueue.length);
            Array.prototype.push.apply(eventQueue, merged);
        }
    } catch (error) {}
}

function enqueueEventPayload(payload) {
    eventQueue.push(Object.assign({
        _client_first_queued_at: Date.now(),
    }, payload));
    persistEventQueue();
    if (!eventQueueTimer) scheduleEventQueueFlush(EVENT_QUEUE_FLUSH_MS);
}

function requestPayloadForEvents(events) {
    return events.length === 1 ? events[0] : { shop_domain: SHOP_DOMAIN, events: events };
}

function serializedSize(value) {
    try {
        var serialized = typeof value === 'string' ? value : JSON.stringify(value);
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(serialized).byteLength;
        return unescape(encodeURIComponent(serialized)).length;
    } catch (error) {
        return KEEPALIVE_LIMIT_BYTES + 1;
    }
}

function buildEventBatches(events) {
    var batches = [];
    var current = [];
    events.forEach(function (event) {
        var candidate = current.concat([event]);
        var tooManyEvents = candidate.length > MAX_BATCH_EVENTS;
        var tooLarge = serializedSize(requestPayloadForEvents(candidate)) >= KEEPALIVE_LIMIT_BYTES;
        if (current.length && (tooManyEvents || tooLarge)) {
            batches.push(current);
            current = [event];
        } else {
            current = candidate;
        }
    });
    if (current.length) batches.push(current);
    return batches;
}

function retryAfterMsFromResponse(response) {
    try {
        if (!response || !response.headers || !response.headers.get) return 0;
        var raw = response.headers.get('retry-after');
        if (!raw) return 0;
        var numeric = Number(raw);
        if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric * 1000);
        var timestamp = Date.parse(String(raw));
        return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
    } catch (error) {
        return 0;
    }
}

function isRetryableResponse(response) {
    var status = Number(response && response.status);
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function requeueFailedEvents(events, retryAfterMs) {
    var now = Date.now();
    var retryable = events.filter(function (event) {
        var firstQueuedAt = Number(event._client_first_queued_at || now);
        return Number(event._client_retry_count || 0) < MAX_CLIENT_RETRIES && now - firstQueuedAt < CLIENT_RETRY_MAX_AGE_MS;
    }).map(function (event) {
        var nextRetryCount = Number(event._client_retry_count || 0) + 1;
        var baseDelay = RETRY_BACKOFF_MS[Math.min(nextRetryCount - 1, RETRY_BACKOFF_MS.length - 1)] || EVENT_QUEUE_FLUSH_MS;
        var jitter = 0.8 + (Math.random() * 0.4);
        var delay = Math.max(Number(retryAfterMs || 0), Math.ceil(baseDelay * jitter));
        return Object.assign({}, event, {
            _client_retry_count: nextRetryCount,
            _client_next_attempt_at: now + delay,
            _client_first_queued_at: Number(event._client_first_queued_at || now),
        });
    });

    if (!retryable.length) return;
    Array.prototype.push.apply(eventQueue, retryable);
    persistEventQueue();
    if (!eventQueueTimer) scheduleEventQueueFlush(RETRY_BACKOFF_MS[0]);
}

function removeInFlightEvents(events) {
    var keys = new Set(events.map(function (event) {
        return [event.event_name, event.event_id].join(':');
    }));
    inFlightEvents = inFlightEvents.filter(function (event) {
        return !keys.has([event.event_name, event.event_id].join(':'));
    });
}

function requestOptionsForBody(body) {
    var options = {
        method: 'POST',
        keepalive: serializedSize(body) < KEEPALIVE_LIMIT_BYTES,
        headers: { 'Content-Type': 'application/json' },
        body: body,
    };

    if (typeof AbortController !== 'undefined') {
        var controller = new AbortController();
        var timeoutId = setTimeout(function () {
            controller.abort();
        }, FETCH_TIMEOUT_MS);
        options.signal = controller.signal;
        options._timeoutId = timeoutId;
    }

    return options;
}

async function flushEventQueueOnce() {
    if (eventQueueTimer) {
        clearTimeout(eventQueueTimer);
        eventQueueTimer = null;
    }
    await loadPersistedEventQueue();
    if (!eventQueue.length) return;

    var now = Date.now();
    var dueEvents = [];
    var waitingEvents = [];
    eventQueue.splice(0, eventQueue.length).forEach(function (event) {
        if (Number(event._client_next_attempt_at || 0) > now) {
            waitingEvents.push(event);
        } else {
            dueEvents.push(event);
        }
    });
    Array.prototype.push.apply(eventQueue, waitingEvents);
    if (!dueEvents.length) {
        await persistEventQueue();
        var nextAttemptAt = Math.min.apply(Math, waitingEvents.map(function (event) {
            return Number(event._client_next_attempt_at || (now + EVENT_QUEUE_FLUSH_MS));
        }));
        scheduleEventQueueFlush(Math.max(EVENT_QUEUE_FLUSH_MS, nextAttemptAt - now));
        return;
    }

    inFlightEvents = dueEvents.slice();
    await persistEventQueue();
    var batches = buildEventBatches(dueEvents);
    for (var index = 0; index < batches.length; index += 1) {
        var batch = batches[index];
        var requestPayload = requestPayloadForEvents(batch);
        var options = requestOptionsForBody(JSON.stringify(requestPayload));

        try {
            var response = await fetch(CAPI_HUB_URL, options);
            if (response && response.ok === false) {
                if (isRetryableResponse(response)) {
                    removeInFlightEvents(batch);
                    requeueFailedEvents(batch, retryAfterMsFromResponse(response));
                } else {
                    removeInFlightEvents(batch);
                    console.warn('CAPI gateway rejected a non-retryable event batch', response.status);
                }
            } else {
                removeInFlightEvents(batch);
            }
        } catch (error) {
            removeInFlightEvents(batch);
            requeueFailedEvents(batch);
        } finally {
            if (options._timeoutId) clearTimeout(options._timeoutId);
            delete options._timeoutId;
        }
    }

    await persistEventQueue();
    if (eventQueue.length && !eventQueueTimer) scheduleEventQueueFlush(EVENT_QUEUE_FLUSH_MS);
}

function flushEventQueue() {
    if (flushPromise) return flushPromise;
    flushPromise = flushEventQueueOnce().finally(function () {
        flushPromise = null;
        if (eventQueue.length && !eventQueueTimer) scheduleEventQueueFlush(EVENT_QUEUE_FLUSH_MS);
    });
    return flushPromise;
}

async function sendDualChannelEvent(metaEventName, event, customData, forcedEventId) {
    customData = customData || {};
    event = event || {};
    var initContext = getInitContext();
    var initData = getInitData();
    var context = event.context || initContext || {};
    var documentInfo = context.document || {};
    var navigatorInfo = context.navigator || {};
    var fallbackDocumentInfo = initContext.document || {};
    var fallbackNavigatorInfo = initContext.navigator || {};
    var locationInfo = documentInfo.location || fallbackDocumentInfo.location || {};
    var checkout = event.data && event.data.checkout || {};
    var normalizedOrderId = normalizeShopifyId(checkout.order && checkout.order.id);
    var orderId = firstNonEmpty(checkout.order && checkout.order.name, normalizedOrderId);
    var customer = event.data && event.data.customer || checkout.order && checkout.order.customer || initData.customer || {};
    var billingAddress = checkout.billingAddress || {};
    var shippingAddress = checkout.shippingAddress || {};
    var address = billingAddress.city || billingAddress.zip || billingAddress.countryCode ? billingAddress : (shippingAddress || customer.defaultAddress || {});
    var currentUrl = locationInfo.href || documentInfo.URL || documentInfo.referrer || fallbackDocumentInfo.URL || fallbackDocumentInfo.referrer;
    var eventId = String(await shopScopedIdentifier(
        eventIdFrom(forcedEventId) || event.id || await fallbackEventId(metaEventName, event, currentUrl)
    ));
    if (!shouldSendRecentEvent(metaEventName, eventId)) return;
    await waitForMetaRouteConfig();
    var scopedOrderId = await shopScopedIdentifier(firstNonEmpty(customData.order_id, orderId));
    var browserCustomData = {
        ...customData,
        order_id: scopedOrderId,
    };
    sendMetaBrowserEvent(metaEventName, eventId, browserCustomData);

    var fbp = await getFbp();
    var fbc = await getOrCreateFbc(currentUrl);
    var ttp = await getTtp();
    var ttclid = await rememberTtclid(currentUrl);
    var checkoutToken = checkout.token || checkout.checkoutToken;
    var cartToken = normalizeShopifyId(event.data && event.data.cart && event.data.cart.id || checkout.cartToken);
    var externalId = primaryExternalId(event, customer, checkout, checkoutToken);
    var rawEmail = customer.email || checkout.email;
    var rawPhone = customer.phone || checkout.phone || address.phone;
    var rawFirstName = customer.firstName || address.firstName;
    var rawLastName = customer.lastName || address.lastName;
    var rawCity = address.city;
    var rawState = address.provinceCode || address.province;
    var rawZip = address.zip;
    var rawCountry = address.countryCode || address.country;
    var orderCustomer = checkout.order && checkout.order.customer || {};
    var isFirstOrder = firstNonEmpty(orderCustomer.isFirstOrder, customer && customer.isFirstOrder);
    var customerSegmentation;
    if (isFirstOrder === true) {
        customerSegmentation = 'new_customer_to_business';
    } else if (isFirstOrder === false) {
        customerSegmentation = 'existing_customer_to_business';
    }
    var hashedFields = await Promise.all([
        sha256Hex(rawEmail, 'email'),
        sha256Hex(rawPhone, 'phone', rawCountry),
        sha256Hex(rawFirstName, 'name'),
        sha256Hex(rawLastName, 'name'),
        sha256Hex(rawCity, 'city'),
        sha256Hex(rawState, 'state', rawCountry),
        sha256Hex(rawZip, 'zip', rawCountry),
        sha256Hex(rawCountry, 'country'),
    ]);
    var traceId = randomId('trace');

    enqueueEventPayload(compact({
        shop_domain: SHOP_DOMAIN,
        ingest_token: SHOP_INGEST_TOKEN,
            tenant_id: SHOP_DOMAIN,
            schema_version: SCHEMA_VERSION,
            source_version: SOURCE_VERSION,
            trace_id: traceId,
            pixel_ids: META_ROUTE_PIXEL_IDS,
            dataset_ids: META_ROUTE_PIXEL_IDS,
            event_name: metaEventName,
            event_id: eventId,
            action_source: 'website',
            customer_segmentation: customerSegmentation,
            timestamp: event.timestamp,
            url: currentUrl,
            event_source_url: currentUrl,
            referrer: documentInfo.referrer || fallbackDocumentInfo.referrer,
            user_agent: navigatorInfo.userAgent || fallbackNavigatorInfo.userAgent,
            fbp: fbp,
            fbc: fbc,
            ttp: ttp,
            ttclid: ttclid,
            email_hash: hashedFields[0],
            phone_hash: hashedFields[1],
            first_name_hash: hashedFields[2],
            last_name_hash: hashedFields[3],
            city_hash: hashedFields[4],
            state_hash: hashedFields[5],
            zip_hash: hashedFields[6],
            country_hash: hashedFields[7],
            client_id: event.clientId,
            checkout_token: checkoutToken,
            cart_token: cartToken,
            order_id: scopedOrderId,
            route_hints: {
                facebook_pixel_ids: META_ROUTE_PIXEL_IDS,
                tiktok_pixel_ids: TIKTOK_ROUTE_PIXEL_IDS,
            },
            external_id: externalId,
            value: customData.value,
            currency: customData.currency,
            content_ids: customData.content_ids,
            contents: customData.contents,
            content_type: customData.content_type,
            num_items: customData.num_items,
            search_string: customData.search_string,
            content_name: customData.content_name,
            content_category: customData.content_category,
        }));
}

startMetaRouteConfigRefresh();
scheduleMetaRouteConfigRefresh();

analytics.subscribe('page_viewed', function (event) {
    return sendDualChannelEvent('PageView', event);
});

analytics.subscribe('cart_viewed', function (event) {
    var cart = event.data && event.data.cart || {};
    var lines = cart.lines || cart.cartLines || [];
    var contents = lines.map(lineItemToContent).filter(function (item) { return item.id; });
    return sendDualChannelEvent('CartView', event, {
        value: moneyAmount(cart.cost && cart.cost.totalAmount),
        currency: moneyCurrency(cart.cost && cart.cost.totalAmount),
        content_ids: contents.map(function (item) { return item.id; }),
        contents: contents,
        content_type: 'product',
        num_items: contents.reduce(function (sum, item) { return sum + Number(item.quantity || 0); }, 0),
    });
});

analytics.subscribe('collection_viewed', function (event) {
    var collection = event.data && event.data.collection || {};
    return sendDualChannelEvent('CollectionView', event, {
        content_category: collection.title,
        content_name: collection.title,
    });
});

analytics.subscribe('product_viewed', function (event) {
    var variant = event.data && event.data.productVariant || {};
    var product = event.data && event.data.product || variant.product || {};
    var contentId = normalizeShopifyId(variant.id || product.id);
    return sendDualChannelEvent('ViewContent', event, {
        value: moneyAmount(variant.price),
        currency: moneyCurrency(variant.price),
        content_ids: contentId ? [contentId] : undefined,
        contents: contentId ? [{ id: contentId, quantity: 1, item_price: moneyAmount(variant.price) }] : undefined,
        content_type: 'product',
        content_name: product.title || variant.title,
    });
});

analytics.subscribe('product_added_to_cart', function (event) {
    var line = event.data && event.data.cartLine || {};
    var content = lineItemToContent(line);
    var variant = line.merchandise || line.variant || {};
    var product = variant.product || line.product || {};
    return sendDualChannelEvent('AddToCart', event, {
        value: moneyAmount(line.cost && line.cost.totalAmount),
        currency: moneyCurrency(line.cost && line.cost.totalAmount),
        content_ids: content.id ? [content.id] : undefined,
        contents: content.id ? [content] : undefined,
        content_type: 'product',
        content_name: product.title || variant.title,
        content_category: product.type,
        num_items: content.quantity,
    });
});

analytics.subscribe('product_removed_from_cart', function (event) {
    var line = event.data && event.data.cartLine || {};
    var content = lineItemToContent(line);
    return sendDualChannelEvent('RemoveFromCart', event, {
        value: moneyAmount(line.cost && line.cost.totalAmount),
        currency: moneyCurrency(line.cost && line.cost.totalAmount),
        content_ids: content.id ? [content.id] : undefined,
        contents: content.id ? [content] : undefined,
        content_type: 'product',
        num_items: content.quantity,
    });
});

analytics.subscribe('checkout_started', function (event) {
    var checkout = event.data && event.data.checkout || {};
    var contents = checkoutLineItems(checkout).map(lineItemToContent).filter(function (item) { return item.id; });
    return sendDualChannelEvent('InitiateCheckout', event, {
        value: checkoutValue(checkout),
        currency: checkoutCurrency(checkout),
        content_ids: contents.map(function (item) { return item.id; }),
        contents: contents,
        content_type: 'product',
        num_items: contents.reduce(function (sum, item) { return sum + Number(item.quantity || 0); }, 0),
    }, checkoutStageEventId(checkout, event, 'InitiateCheckout'));
});

analytics.subscribe('checkout_contact_info_submitted', function (event) {
    var checkout = event.data && event.data.checkout || {};
    var contents = checkoutLineItems(checkout).map(lineItemToContent).filter(function (item) { return item.id; });
    return sendDualChannelEvent('CheckoutContactInfoSubmitted', event, {
        value: checkoutValue(checkout),
        currency: checkoutCurrency(checkout),
        content_ids: contents.map(function (item) { return item.id; }),
        contents: contents,
        content_type: 'product',
        num_items: contents.reduce(function (sum, item) { return sum + Number(item.quantity || 0); }, 0),
    }, checkoutStageEventId(checkout, event, 'CheckoutContactInfoSubmitted'));
});

analytics.subscribe('checkout_address_info_submitted', function (event) {
    var checkout = event.data && event.data.checkout || {};
    var contents = checkoutLineItems(checkout).map(lineItemToContent).filter(function (item) { return item.id; });
    return sendDualChannelEvent('CheckoutAddressInfoSubmitted', event, {
        value: checkoutValue(checkout),
        currency: checkoutCurrency(checkout),
        content_ids: contents.map(function (item) { return item.id; }),
        contents: contents,
        content_type: 'product',
        num_items: contents.reduce(function (sum, item) { return sum + Number(item.quantity || 0); }, 0),
    }, checkoutStageEventId(checkout, event, 'CheckoutAddressInfoSubmitted'));
});

analytics.subscribe('checkout_shipping_info_submitted', function (event) {
    var checkout = event.data && event.data.checkout || {};
    var contents = checkoutLineItems(checkout).map(lineItemToContent).filter(function (item) { return item.id; });
    return sendDualChannelEvent('CheckoutShippingInfoSubmitted', event, {
        value: checkoutValue(checkout),
        currency: checkoutCurrency(checkout),
        content_ids: contents.map(function (item) { return item.id; }),
        contents: contents,
        content_type: 'product',
        num_items: contents.reduce(function (sum, item) { return sum + Number(item.quantity || 0); }, 0),
    }, checkoutStageEventId(checkout, event, 'CheckoutShippingInfoSubmitted'));
});

analytics.subscribe('payment_info_submitted', function (event) {
    var checkout = event.data && event.data.checkout || {};
    var contents = checkoutLineItems(checkout).map(lineItemToContent).filter(function (item) { return item.id; });
    return sendDualChannelEvent('AddPaymentInfo', event, {
        value: checkoutValue(checkout),
        currency: checkoutCurrency(checkout),
        content_ids: contents.map(function (item) { return item.id; }),
        contents: contents,
        content_type: 'product',
        num_items: contents.reduce(function (sum, item) { return sum + Number(item.quantity || 0); }, 0),
    }, checkoutStageEventId(checkout, event, 'AddPaymentInfo'));
});

analytics.subscribe('checkout_completed', function (event) {
    var checkout = event.data && event.data.checkout || {};
    var contents = checkoutLineItems(checkout).map(lineItemToContent).filter(function (item) { return item.id; });
    return sendDualChannelEvent('Purchase', event, {
        value: checkoutValue(checkout),
        currency: checkoutCurrency(checkout),
        content_ids: contents.map(function (item) { return item.id; }),
        contents: contents,
        content_type: 'product',
        num_items: contents.reduce(function (sum, item) { return sum + Number(item.quantity || 0); }, 0),
        order_id: firstNonEmpty(checkout.order && checkout.order.name, normalizeShopifyId(checkout.order && checkout.order.id)),
    }, purchaseEventId(checkout, event));
});

analytics.subscribe('search_submitted', function (event) {
    var query = event.data && event.data.searchResult && event.data.searchResult.query || event.data && event.data.search && event.data.search.query;
    return sendDualChannelEvent('Search', event, { search_string: query });
});
