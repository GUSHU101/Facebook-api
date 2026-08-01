const crypto = require('crypto');
const { FUNNEL_EVENT_NAME_SET } = require('./funnel');

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

function tenantScopedIdentifier(tenantId, value, maxLength = 255) {
    const normalizedTenant = String(tenantId || '').trim().toLowerCase();
    const normalizedValue = normalizeShopifyId(value);
    if (!normalizedTenant || !normalizedValue) return undefined;
    const prefix = `${normalizedTenant}:`;
    const text = String(normalizedValue).trim();
    return normalizeEventId(
        text.toLowerCase().startsWith(prefix)
            ? `${prefix}${text.slice(prefix.length)}`
            : `${prefix}${text}`,
        maxLength,
    );
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

function buildCustomData(payload = {}, commerceItemLimit = 1000) {
    const itemLimit = Math.max(1, Number(commerceItemLimit) || 1000);
    const contents = Array.isArray(payload.contents)
        ? payload.contents.slice(0, itemLimit)
            .filter(Boolean)
            .map(item => compactObject({
                id: firstPresent(item.id, item.content_id)
                    ? String(firstPresent(item.id, item.content_id))
                    : undefined,
                quantity: Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0
                    ? Number(item.quantity)
                    : undefined,
                item_price: Number.isFinite(Number(firstPresent(item.item_price, item.price)))
                    && Number(firstPresent(item.item_price, item.price)) >= 0
                    ? Number(firstPresent(item.item_price, item.price))
                    : undefined,
            }))
            .filter(item => item.id)
        : undefined;
    // Item-level contents are authoritative. Deriving IDs from them prevents
    // a stale caller-supplied content_ids list from describing other products.
    const contentIds = contents?.length
        ? contents.map(item => String(item.id))
        : (Array.isArray(payload.content_ids)
            ? payload.content_ids.slice(0, itemLimit).filter(Boolean).map(String)
            : undefined);
    const numItems = Number.isFinite(Number(payload.num_items))
        ? Number(payload.num_items)
        : contents?.reduce((sum, item) => sum + Number(item.quantity || 0), 0);

    return compactObject({
        value: payload.value !== undefined && Number.isFinite(Number(payload.value)) && Number(payload.value) >= 0
            ? Number(payload.value)
            : undefined,
        currency: payload.currency ? String(payload.currency).trim().toUpperCase() : undefined,
        content_ids: contentIds?.length ? contentIds : undefined,
        contents: contents?.length ? contents : undefined,
        content_type: payload.content_type,
        content_name: payload.content_name,
        content_category: payload.content_category,
        num_items: numItems > 0 ? numItems : undefined,
        order_id: tenantScopedIdentifier(
            firstPresent(payload.tenant_id, payload.shop_domain),
            payload.order_id,
        ),
        search_string: payload.search_string,
    });
}

function stripPrivateFields(eventPayload) {
    return Object.fromEntries(Object.entries(eventPayload).filter(([key]) => !key.startsWith('_')));
}

function missingCommerceSignals(eventName, customData = {}) {
    if (!FUNNEL_EVENT_NAME_SET.has(eventName)) return [];
    const missing = [];
    if (customData.value === undefined || customData.value === null || customData.value === '') missing.push('value');
    if (!String(customData.currency || '').trim()) missing.push('currency');
    if (!Array.isArray(customData.content_ids) || customData.content_ids.length === 0) missing.push('content_ids');
    if (!Array.isArray(customData.contents) || customData.contents.length === 0) missing.push('contents');
    if (eventName === 'Purchase' && !String(customData.order_id || '').trim()) missing.push('order_id');
    return missing;
}

module.exports = {
    buildCustomData,
    compactObject,
    firstPresent,
    missingCommerceSignals,
    normalizeEventId,
    normalizeShopifyId,
    stripPrivateFields,
    tenantScopedExternalId,
    tenantScopedIdentifier,
};
