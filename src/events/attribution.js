const { compactObject, firstPresent } = require('./common');
const { collectHashedUserData } = require('../utils/crypto');

const COMMERCE_KEY_TYPES = new Set(['checkout', 'cart', 'order']);

function browserAttributionIdentity(payload = {}) {
    // A customer/external ID can be reused on several devices. Treating it as
    // a browser key would copy fbp/fbc and client network signals from one
    // device to another, producing false ad attribution.
    return firstPresent(payload.client_id, payload.shopify_y);
}

function buildBrowserAttributionSnapshot(payload = {}) {
    return compactObject({
        fbp: firstPresent(payload.fbp, payload._fbp),
        fbc: firstPresent(payload.fbc, payload._fbc),
        ttp: payload.ttp,
        ttclid: payload.ttclid,
        source_url: firstPresent(payload.source_url, payload.url),
        referrer: payload.referrer,
        client_ip: payload.client_ip,
        user_agent: payload.user_agent,
        client_id: firstPresent(payload.client_id, payload.shopify_y),
        shopify_y: payload.shopify_y,
        shopify_s: payload.shopify_s,
    });
}

function buildCommerceAttributionSnapshot(payload = {}) {
    const country = firstPresent(payload.country, payload.country_code, payload.customer_country);
    return compactObject({
        ...buildBrowserAttributionSnapshot(payload),
        email_hash: collectHashedUserData(
            [payload.email_hash, payload.email_sha256],
            [payload.em, payload.email, payload.customer_email],
            'email',
        ),
        phone_hash: collectHashedUserData(
            [payload.phone_hash, payload.phone_sha256],
            [payload.ph, payload.phone, payload.customer_phone],
            'phone',
            { country },
        ),
        first_name_hash: collectHashedUserData(
            [payload.first_name_hash],
            [payload.fn, payload.firstName, payload.first_name, payload.customer_first_name],
            'name',
        ),
        last_name_hash: collectHashedUserData(
            [payload.last_name_hash],
            [payload.ln, payload.lastName, payload.last_name, payload.customer_last_name],
            'name',
        ),
        city_hash: collectHashedUserData(
            [payload.city_hash],
            [payload.ct, payload.city, payload.customer_city],
            'city',
        ),
        state_hash: collectHashedUserData(
            [payload.state_hash],
            [payload.st, payload.state, payload.province, payload.province_code, payload.customer_state],
            'state',
            { country },
        ),
        zip_hash: collectHashedUserData(
            [payload.zip_hash],
            [payload.zp, payload.zip, payload.postal_code, payload.postalCode, payload.customer_zip],
            'zip',
            { country },
        ),
        country_hash: collectHashedUserData(
            [payload.country_hash, payload.country_sha256],
            [payload.country_hashed, country],
            'country',
        ),
        external_id: payload.external_id,
        checkout_token: payload.checkout_token,
        cart_token: payload.cart_token,
    });
}

function sanitizeStoredAttribution(snapshot, keyType) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return {};
    const sanitized = COMMERCE_KEY_TYPES.has(keyType)
        ? buildCommerceAttributionSnapshot(snapshot)
        : buildBrowserAttributionSnapshot(snapshot);
    const updatedAt = Number(snapshot.updated_at);
    return {
        ...sanitized,
        updated_at: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
    };
}

function snapshotForAttributionKey(payload, keyType) {
    const snapshot = COMMERCE_KEY_TYPES.has(keyType)
        ? buildCommerceAttributionSnapshot(payload)
        : buildBrowserAttributionSnapshot(payload);
    // Cache recency is server-authoritative. A storefront must not be able to
    // pin arbitrary old attribution above newer checkout/order observations.
    return { ...snapshot, updated_at: Date.now() };
}

module.exports = {
    browserAttributionIdentity,
    buildBrowserAttributionSnapshot,
    buildCommerceAttributionSnapshot,
    sanitizeStoredAttribution,
    snapshotForAttributionKey,
};
