const crypto = require('crypto');

function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function firstPresent(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function normalizeShopifyId(value) {
    if (value === undefined || value === null || value === '') return undefined;
    return String(value).trim().replace(/^gid:\/\/shopify\/[A-Za-z]+\/(.+)$/, '$1') || undefined;
}

function normalizeEventId(value, maxLength = 255) {
    const normalized = normalizeShopifyId(value);
    if (!normalized) return undefined;
    const text = String(normalized).trim();
    if (text.length <= maxLength) return text;

    const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
    const prefixLength = Math.max(0, maxLength - digest.length - 1);
    return `${text.slice(0, prefixLength)}-${digest}`.slice(0, maxLength);
}

function tenantScopedExternalId(tenantId, externalId) {
    const normalizedTenant = String(tenantId || '').trim().toLowerCase();
    const normalizedExternalId = normalizeShopifyId(externalId);
    if (!normalizedTenant || !normalizedExternalId) return undefined;

    // Store-local customer/client IDs are not globally unique. Prefixing with
    // the server-authoritative tenant prevents two shops sharing one dataset
    // from producing the same advertiser external_id.
    return crypto
        .createHash('sha256')
        .update(`${normalizedTenant}:${String(normalizedExternalId).trim().toLowerCase()}`)
        .digest('hex');
}

function stripPrivateFields(eventPayload) {
    return Object.fromEntries(Object.entries(eventPayload).filter(([key]) => !key.startsWith('_')));
}

const COMMERCE_EVENTS = new Set(['AddToCart', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase']);

function missingCommerceSignals(eventName, customData = {}) {
    if (!COMMERCE_EVENTS.has(eventName)) return [];
    const missing = [];
    if (customData.value === undefined || customData.value === null || customData.value === '') missing.push('value');
    if (!String(customData.currency || '').trim()) missing.push('currency');
    if (!Array.isArray(customData.content_ids) || customData.content_ids.length === 0) missing.push('content_ids');
    if (!Array.isArray(customData.contents) || customData.contents.length === 0) missing.push('contents');
    if (eventName === 'Purchase' && !String(customData.order_id || '').trim()) missing.push('order_id');
    return missing;
}

module.exports = {
    compactObject,
    firstPresent,
    missingCommerceSignals,
    normalizeEventId,
    normalizeShopifyId,
    stripPrivateFields,
    tenantScopedExternalId,
};
