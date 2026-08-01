const net = require('node:net');
const { FUNNEL_EVENT_NAME_SET } = require('../events/funnel');

const HASHED_USER_FIELDS = ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'external_id'];
const META_COOKIE_PATTERN = /^fb\.\d+\.\d{13}\.[^\s]+$/;
const ACTION_SOURCES = new Set([
    'email', 'website', 'app', 'phone_call', 'chat', 'physical_store',
    'system_generated', 'business_messaging', 'other',
]);
const CUSTOMER_SEGMENTATION_VALUES = new Set([
    'new_customer_to_business',
    'existing_customer_to_business',
]);
function normalizeMetaCookie(value) {
    const normalized = String(value || '').trim();
    return META_COOKIE_PATTERN.test(normalized) ? normalized : undefined;
}

function validHashArray(value) {
    const values = Array.isArray(value) ? value : [value];
    return values.length > 0 && values.every(item => /^[a-f0-9]{64}$/.test(String(item || '')));
}

function sanitizeMetaUserData(userData = {}) {
    const output = {};
    for (const field of HASHED_USER_FIELDS) {
        const values = (Array.isArray(userData[field]) ? userData[field] : [userData[field]])
            .map(value => String(value || '').trim().toLowerCase())
            .filter(value => /^[a-f0-9]{64}$/.test(value));
        const unique = [...new Set(values)];
        if (unique.length) output[field] = unique;
    }

    const ipAddress = String(userData.client_ip_address || '').trim();
    const userAgent = String(userData.client_user_agent || '').trim();
    const fbc = normalizeMetaCookie(userData.fbc);
    const fbp = normalizeMetaCookie(userData.fbp);
    if (net.isIP(ipAddress)) output.client_ip_address = ipAddress;
    if (userAgent) output.client_user_agent = userAgent;
    if (fbc) output.fbc = fbc;
    if (fbp) output.fbp = fbp;
    return output;
}

function sanitizeMetaCustomData(customData = {}, eventName) {
    const output = { ...customData };
    const contents = Array.isArray(output.contents) ? output.contents : [];
    const contentIdsFromContents = contents
        .map(item => String(item?.id || item?.content_id || '').trim())
        .filter(Boolean);
    const suppliedContentIds = (Array.isArray(output.content_ids) ? output.content_ids : [])
        .map(value => String(value || '').trim())
        .filter(Boolean);
    const contentIds = [...new Set(
        contentIdsFromContents.length ? contentIdsFromContents : suppliedContentIds
    )];

    // When item-level contents are available they are authoritative. Keeping
    // an older, unrelated content_ids array would attribute the same event to
    // products that are no longer in the confirmed checkout.
    if (contentIds.length) output.content_ids = contentIds;
    else delete output.content_ids;
    if (!contents.length) delete output.contents;

    if (eventName !== 'InitiateCheckout') delete output.num_items;
    if (eventName !== 'Search') delete output.search_string;
    if (!CUSTOMER_SEGMENTATION_VALUES.has(output.customer_segmentation)) {
        delete output.customer_segmentation;
    }
    return output;
}

function prepareMetaEvent(event = {}) {
    return {
        ...event,
        user_data: sanitizeMetaUserData(event.user_data),
        custom_data: sanitizeMetaCustomData(event.custom_data, event.event_name),
    };
}

function validateMetaEvent(event, nowSeconds = Math.floor(Date.now() / 1000)) {
    const errors = [];
    if (!event || typeof event !== 'object') return ['event must be an object'];
    if (!String(event.event_name || '').trim()) errors.push('event_name is required');
    if (!String(event.event_id || '').trim()) errors.push('event_id is required');
    if (!ACTION_SOURCES.has(event.action_source)) errors.push('action_source is required and must be valid');
    if (event.opt_out !== undefined && typeof event.opt_out !== 'boolean') {
        errors.push('opt_out must be boolean');
    }

    const userData = event.user_data;
    if (!userData || typeof userData !== 'object' || Array.isArray(userData)) {
        errors.push('user_data is required');
    } else {
        const hasMatchSignal = HASHED_USER_FIELDS.some(field => validHashArray(userData[field]))
            || net.isIP(String(userData.client_ip_address || '').trim()) > 0
            || Boolean(normalizeMetaCookie(userData.fbc))
            || Boolean(normalizeMetaCookie(userData.fbp));
        if (!hasMatchSignal) errors.push('user_data requires at least one valid matching signal');
        for (const field of HASHED_USER_FIELDS) {
            if (userData[field] !== undefined && !validHashArray(userData[field])) {
                errors.push(`user_data.${field} must contain SHA-256 hashes`);
            }
        }
        if (userData.client_ip_address && !net.isIP(String(userData.client_ip_address).trim())) {
            errors.push('client_ip_address must be a valid IPv4 or IPv6 address');
        }
        for (const field of ['fbc', 'fbp']) {
            if (userData[field] && !normalizeMetaCookie(userData[field])) {
                errors.push(`${field} has an invalid Meta cookie format`);
            }
        }
    }

    const eventTime = Number(event.event_time);
    if (!Number.isInteger(eventTime) || eventTime <= 0) {
        errors.push('event_time must be Unix seconds');
    } else {
        if (eventTime > nowSeconds + 300) errors.push('event_time is more than five minutes in the future');
        if (eventTime < nowSeconds - (7 * 24 * 60 * 60)) errors.push('event_time is older than seven days');
    }

    if (event.action_source === 'website') {
        try {
            const sourceUrl = new URL(String(event.event_source_url || ''));
            if (!['http:', 'https:'].includes(sourceUrl.protocol)) throw new Error('invalid protocol');
        } catch (error) {
            errors.push('website events require a valid event_source_url');
        }
        if (!String(event.user_data?.client_user_agent || '').trim()) {
            errors.push('website events require client_user_agent');
        }
    }

    if (event.referrer_url) {
        try {
            const referrerUrl = new URL(String(event.referrer_url));
            if (!['http:', 'https:'].includes(referrerUrl.protocol)) throw new Error('invalid protocol');
        } catch (error) {
            errors.push('referrer_url must be a valid HTTP(S) URL');
        }
    }

    if (FUNNEL_EVENT_NAME_SET.has(event.event_name)) {
        const hasValue = event.custom_data?.value !== undefined
            && event.custom_data?.value !== null
            && event.custom_data?.value !== '';
        const hasCurrency = Boolean(String(event.custom_data?.currency || '').trim());
        if (hasValue && (!Number.isFinite(Number(event.custom_data.value)) || Number(event.custom_data.value) < 0)) {
            errors.push(`${event.event_name} value must be a non-negative number`);
        }
        if (hasCurrency && !/^[A-Z]{3}$/.test(String(event.custom_data.currency))) {
            errors.push(`${event.event_name} currency must be a three-letter uppercase code`);
        }
        if (hasValue !== hasCurrency) {
            errors.push(`${event.event_name} value and currency must be provided together`);
        }
        for (const content of Array.isArray(event.custom_data?.contents) ? event.custom_data.contents : []) {
            if (!String(content?.id || '').trim()) errors.push(`${event.event_name} content id is required`);
            if (content?.quantity !== undefined && (!Number.isFinite(Number(content.quantity)) || Number(content.quantity) <= 0)) {
                errors.push(`${event.event_name} content quantity must be positive`);
            }
            if (content?.item_price !== undefined && (!Number.isFinite(Number(content.item_price)) || Number(content.item_price) < 0)) {
                errors.push(`${event.event_name} content item_price must be non-negative`);
            }
        }
        if (event.custom_data?.content_type
            && !['product', 'product_group'].includes(event.custom_data.content_type)) {
            errors.push(`${event.event_name} content_type must be product or product_group`);
        }
    }

    if (event.event_name === 'Purchase') {
        if (event.custom_data?.value === undefined || event.custom_data?.value === null || event.custom_data?.value === '') {
            errors.push('Purchase value is required');
        }
        if (!String(event.custom_data?.currency || '').trim()) {
            errors.push('Purchase currency is required');
        }
    }

    return errors;
}

async function isolateMetaBatch(items, budget, handlers) {
    if (!Array.isArray(items) || items.length === 0) {
        return { successes: [], failures: [], deferredItems: [] };
    }
    if (!budget || !Number.isInteger(budget.remaining) || budget.remaining <= 0) {
        return {
            successes: [],
            failures: [],
            deferredItems: [...items],
            budgetExhausted: true,
        };
    }

    budget.remaining -= 1;
    try {
        return {
            successes: [await handlers.send(items)],
            failures: [],
            deferredItems: [],
        };
    } catch (error) {
        const classification = handlers.classify(error);
        if (classification.retryable) {
            return {
                successes: [],
                failures: [],
                deferredItems: [...items],
                retryError: error,
            };
        }
        if (items.length === 1 || !handlers.shouldIsolate(classification)) {
            return {
                successes: [],
                failures: [handlers.failure(items, classification)],
                deferredItems: [],
            };
        }

        const midpoint = Math.ceil(items.length / 2);
        const left = await isolateMetaBatch(items.slice(0, midpoint), budget, handlers);
        // A transient/rate-limit failure applies to the shared request scope.
        // Do not probe the sibling branch after it; defer that untouched branch
        // with the failed one and let the credential cooldown take effect.
        if (left.retryError) {
            return {
                successes: [...left.successes],
                failures: [...left.failures],
                deferredItems: [...left.deferredItems, ...items.slice(midpoint)],
                retryError: left.retryError,
                budgetExhausted: left.budgetExhausted === true,
            };
        }
        const right = await isolateMetaBatch(items.slice(midpoint), budget, handlers);
        return {
            successes: [...left.successes, ...right.successes],
            failures: [...left.failures, ...right.failures],
            deferredItems: [...left.deferredItems, ...right.deferredItems],
            retryError: left.retryError || right.retryError,
            budgetExhausted: left.budgetExhausted === true || right.budgetExhausted === true,
        };
    }
}

module.exports = {
    isolateMetaBatch,
    normalizeMetaCookie,
    prepareMetaEvent,
    sanitizeMetaCustomData,
    sanitizeMetaUserData,
    validateMetaEvent,
};
