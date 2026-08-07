const { headerValue, parseRetryAfterSeconds } = require('./rate-control');

const RETRYABLE_GRAPHQL_CODES = new Set([
    'THROTTLED',
    'INTERNAL_SERVER_ERROR',
    'SERVICE_UNAVAILABLE',
]);

function shopifyGraphqlErrors(failure) {
    const candidates = [
        failure?.response?.data?.errors,
        failure?.data?.errors,
    ];
    return candidates.find(Array.isArray) || [];
}

function isRetryableShopifyGraphqlFailure(failure) {
    const status = Number(failure?.response?.status ?? failure?.status);
    if ([408, 425, 429].includes(status) || status >= 500) return true;

    const errors = shopifyGraphqlErrors(failure);
    if (errors.length > 0) {
        // Do not hide a permanent query or permission error behind retries when
        // Shopify returns a mixed error list.
        return errors.every(item => {
            const code = String(item?.extensions?.code || '').toUpperCase();
            const message = String(item?.message || '');
            return RETRYABLE_GRAPHQL_CODES.has(code)
                || /\bthrottl(?:e|ed|ing)\b|temporar(?:y|ily) unavailable|internal server error/i.test(message);
        });
    }

    if (failure?.response) return false;
    return [
        'ECONNABORTED',
        'ECONNREFUSED',
        'ECONNRESET',
        'EAI_AGAIN',
        'EHOSTUNREACH',
        'ENOTFOUND',
        'ENETDOWN',
        'ENETUNREACH',
        'ERR_NETWORK',
        'ETIMEDOUT',
    ].includes(String(failure?.code || '').toUpperCase());
}

function graphqlThrottleDelayMs(failure) {
    const cost = failure?.response?.data?.extensions?.cost
        || failure?.data?.extensions?.cost;
    const available = Number(cost?.throttleStatus?.currentlyAvailable);
    const restoreRate = Number(cost?.throttleStatus?.restoreRate);
    const requested = Number(cost?.requestedQueryCost || cost?.actualQueryCost);
    if (!Number.isFinite(available) || !Number.isFinite(restoreRate) || restoreRate <= 0
        || !Number.isFinite(requested) || requested <= available) return 0;
    return Math.ceil(((requested - available) / restoreRate) * 1000);
}

function shopifyGraphqlRetryDelayMs(failure, attempt, options = {}) {
    const baseMs = Math.max(100, Number(options.baseMs) || 1000);
    const maxMs = Math.max(baseMs, Number(options.maxMs) || 15000);
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const headers = failure?.response?.headers || failure?.headers;
    const retryAfterSeconds = parseRetryAfterSeconds(headerValue(headers, 'retry-after'), nowMs);
    const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
    const throttleMs = graphqlThrottleDelayMs(failure);
    const safeAttempt = Math.max(1, Number(attempt) || 1);
    const exponentialMs = baseMs * (2 ** (safeAttempt - 1));
    return Math.min(maxMs, Math.max(baseMs, exponentialMs, retryAfterMs, throttleMs));
}

function shopifyGraphqlRetryReason(failure) {
    const errors = shopifyGraphqlErrors(failure);
    if (errors.length > 0) {
        return errors.map(item => String(item?.extensions?.code || item?.message || 'GraphQL error')).join(', ');
    }
    const status = Number(failure?.response?.status ?? failure?.status);
    if (Number.isFinite(status)) return `HTTP ${status}`;
    return String(failure?.code || failure?.message || 'network error');
}

async function requestShopifyGraphqlQuery(request, options = {}) {
    if (typeof request !== 'function') throw new TypeError('request must be a function');
    const maxAttempts = Math.max(1, Math.min(10, Number(options.maxAttempts) || 3));
    const sleep = typeof options.sleep === 'function'
        ? options.sleep
        : delayMs => new Promise(resolve => setTimeout(resolve, delayMs));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response;
        try {
            response = await request(attempt);
        } catch (error) {
            if (attempt >= maxAttempts || !isRetryableShopifyGraphqlFailure(error)) throw error;
            const delayMs = shopifyGraphqlRetryDelayMs(error, attempt, options);
            if (typeof options.onRetry === 'function') {
                options.onRetry({ attempt, delayMs, reason: shopifyGraphqlRetryReason(error) });
            }
            await sleep(delayMs);
            continue;
        }

        if (attempt < maxAttempts && isRetryableShopifyGraphqlFailure(response)) {
            const delayMs = shopifyGraphqlRetryDelayMs(response, attempt, options);
            if (typeof options.onRetry === 'function') {
                options.onRetry({ attempt, delayMs, reason: shopifyGraphqlRetryReason(response) });
            }
            await sleep(delayMs);
            continue;
        }
        return response;
    }
    throw new Error('Shopify GraphQL query exhausted without a response');
}

module.exports = {
    graphqlThrottleDelayMs,
    isRetryableShopifyGraphqlFailure,
    requestShopifyGraphqlQuery,
    shopifyGraphqlErrors,
    shopifyGraphqlRetryDelayMs,
};
