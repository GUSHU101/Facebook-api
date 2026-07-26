const { compactObject, firstPresent, missingCommerceSignals } = require('./common');
const { calculateEMQ, missingMatchSignals } = require('../utils/emq');

function mergeUniqueArrays(left, right) {
    const output = [];
    const seen = new Set();
    for (const value of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
        const key = JSON.stringify(value);
        if (!seen.has(key)) {
            seen.add(key);
            output.push(value);
        }
    }
    return output.length ? output : undefined;
}

function mergeUserData(left = {}, right = {}) {
    const arrayFields = ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'external_id'];
    const merged = { ...left, ...right };
    for (const field of arrayFields) {
        merged[field] = mergeUniqueArrays(left[field], right[field]);
    }
    return compactObject({
        ...merged,
        client_ip_address: firstPresent(right.client_ip_address, left.client_ip_address),
        client_user_agent: firstPresent(right.client_user_agent, left.client_user_agent),
        fbc: firstPresent(right.fbc, left.fbc),
        fbp: firstPresent(right.fbp, left.fbp),
    });
}

function mergeCustomData(left = {}, right = {}) {
    const selectedContents = Array.isArray(right.contents) && right.contents.length
        ? right.contents
        : left.contents;
    const selectedContentIds = Array.isArray(right.content_ids) && right.content_ids.length
        ? right.content_ids
        : left.content_ids;
    const derivedContentIds = Array.isArray(selectedContents)
        ? selectedContents.map(item => item?.id || item?.content_id).filter(Boolean).map(String)
        : [];
    return compactObject({
        ...left,
        ...right,
        // Keep IDs and contents from the same authoritative observation. A
        // union with an older cart snapshot can attribute items that were
        // removed before the paid order was finalized.
        content_ids: mergeUniqueArrays(selectedContentIds, derivedContentIds),
        contents: selectedContents,
        value: firstPresent(right.value, left.value),
        currency: firstPresent(right.currency, left.currency),
        order_id: firstPresent(right.order_id, left.order_id),
        num_items: firstPresent(right.num_items, left.num_items),
    });
}

function mergePlatformData(left = {}, right = {}) {
    return compactObject({
        ...left,
        ...right,
        tiktok: compactObject({
            ...(left.tiktok || {}),
            ...(right.tiktok || {}),
        }),
    });
}

function validEventTime(value) {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function mergePersistedEventPayload(existing = {}, incoming = {}) {
    const existingConfirmed = existing._payment_confirmed === true;
    const incomingConfirmed = incoming._payment_confirmed === true;
    const preferIncoming = incomingConfirmed || !existingConfirmed;
    const preferred = preferIncoming
        ? { left: existing, right: incoming }
        : { left: incoming, right: existing };
    const existingTime = validEventTime(existing.event_time);
    const incomingTime = validEventTime(incoming.event_time);
    const eventTime = incomingConfirmed
        ? incomingTime
        : (existingConfirmed
            ? existingTime
            : Math.min(...[existingTime, incomingTime].filter(Boolean)));
    const existingUrl = String(existing.event_source_url || '');
    const incomingUrl = String(incoming.event_source_url || '');
    const userData = mergeUserData(preferred.left.user_data, preferred.right.user_data);
    const customData = mergeCustomData(preferred.left.custom_data, preferred.right.custom_data);

    return compactObject({
        ...preferred.left,
        ...preferred.right,
        event_time: Number.isFinite(eventTime) ? eventTime : firstPresent(incomingTime, existingTime),
        event_source_url: incomingUrl.length > existingUrl.length
            ? incoming.event_source_url
            : existing.event_source_url,
        user_data: userData,
        custom_data: customData,
        _platform_data: mergePlatformData(preferred.left._platform_data, preferred.right._platform_data),
        _requires_payment_confirmation: Boolean(
            existing._requires_payment_confirmation || incoming._requires_payment_confirmation
        ),
        _payment_confirmed: Boolean(existingConfirmed || incomingConfirmed),
        _duplicate_candidate: Boolean(existing._duplicate_candidate || incoming._duplicate_candidate),
        _attribution_enriched: Boolean(existing._attribution_enriched || incoming._attribution_enriched),
        _received_at: Math.min(
            Number(existing._received_at || incoming._received_at || Date.now()),
            Number(incoming._received_at || existing._received_at || Date.now()),
        ),
        _quality: {
            missing_match_signals: missingMatchSignals(userData),
            missing_event_parameters: missingCommerceSignals(
                firstPresent(incoming.event_name, existing.event_name),
                customData,
            ),
        },
    });
}

module.exports = {
    mergeCustomData,
    mergePersistedEventPayload,
    mergePlatformData,
    mergeUniqueArrays,
    mergeUserData,
};
