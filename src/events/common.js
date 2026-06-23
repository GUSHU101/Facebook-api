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

function stripPrivateFields(eventPayload) {
    return Object.fromEntries(Object.entries(eventPayload).filter(([key]) => !key.startsWith('_')));
}

module.exports = {
    compactObject,
    firstPresent,
    normalizeShopifyId,
    stripPrivateFields,
};
