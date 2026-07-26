function headerValue(headers, name) {
    if (!headers) return undefined;
    if (typeof headers.get === 'function') {
        const value = headers.get(name);
        if (value !== undefined && value !== null) return value;
    }

    const wanted = String(name).toLowerCase();
    const key = Object.keys(headers).find(item => String(item).toLowerCase() === wanted);
    return key ? headers[key] : undefined;
}

function parseRetryAfterSeconds(value, nowMs = Date.now()) {
    if (value === undefined || value === null || value === '') return undefined;

    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);

    const timestamp = Date.parse(String(value));
    if (!Number.isFinite(timestamp)) return undefined;
    return Math.max(0, Math.ceil((timestamp - nowMs) / 1000));
}

function parseJsonHeader(value) {
    if (!value) return undefined;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch (error) {
        return undefined;
    }
}

function walkUsage(value, state) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach(item => walkUsage(item, state));
        return;
    }

    for (const [key, item] of Object.entries(value)) {
        const normalizedKey = String(key).toLowerCase();
        const numeric = Number(item);
        if (
            Number.isFinite(numeric)
            && ['call_count', 'total_cputime', 'total_time', 'acc_id_util_pct'].includes(normalizedKey)
        ) {
            state.maxUsagePercent = Math.max(state.maxUsagePercent, numeric);
        }
        if (Number.isFinite(numeric) && normalizedKey === 'estimated_time_to_regain_access') {
            // Meta documents this field in minutes, while all internal
            // cooldowns use seconds.
            state.estimatedRecoverySeconds = Math.max(
                state.estimatedRecoverySeconds,
                numeric * 60,
            );
        }
        if (item && typeof item === 'object') walkUsage(item, state);
    }
}

function metaRateControlFromHeaders(headers, nowMs = Date.now()) {
    const state = {
        maxUsagePercent: 0,
        estimatedRecoverySeconds: 0,
    };
    const usageHeaders = [
        'x-business-use-case-usage',
        'x-app-usage',
        'x-ad-account-usage',
    ];

    for (const name of usageHeaders) {
        walkUsage(parseJsonHeader(headerValue(headers, name)), state);
    }

    const retryAfterSeconds = parseRetryAfterSeconds(headerValue(headers, 'retry-after'), nowMs);
    let cooldownSeconds = Math.max(
        Number(retryAfterSeconds || 0),
        state.estimatedRecoverySeconds,
    );
    if (state.maxUsagePercent >= 100) {
        cooldownSeconds = Math.max(cooldownSeconds, state.estimatedRecoverySeconds, 300);
    } else if (state.maxUsagePercent >= 95) {
        cooldownSeconds = Math.max(cooldownSeconds, 60);
    } else if (state.maxUsagePercent >= 90) {
        cooldownSeconds = Math.max(cooldownSeconds, 15);
    } else if (state.maxUsagePercent >= 80) {
        cooldownSeconds = Math.max(cooldownSeconds, 2);
    }

    return {
        maxUsagePercent: state.maxUsagePercent || undefined,
        estimatedRecoverySeconds: state.estimatedRecoverySeconds || undefined,
        retryAfterSeconds,
        cooldownSeconds: cooldownSeconds || undefined,
    };
}

function retryDelayWithJitterSeconds(
    attempt,
    baseSeconds,
    maxSeconds,
    retryAfterSeconds,
    retryAfterMaxSeconds = 86400,
    randomValue = Math.random(),
) {
    const safeAttempt = Math.max(1, Number(attempt) || 1);
    const base = Math.max(1, Number(baseSeconds) || 1);
    const maximum = Math.max(base, Number(maxSeconds) || base);
    const exponential = Math.min(maximum, base * (2 ** (safeAttempt - 1)));
    const boundedRandom = Math.min(1, Math.max(0, Number(randomValue) || 0));
    const jittered = Math.max(1, Math.ceil(exponential * (0.8 + (boundedRandom * 0.4))));
    const platformDelay = Math.min(
        Math.max(maximum, Number(retryAfterMaxSeconds) || maximum),
        Math.max(0, Number(retryAfterSeconds) || 0),
    );
    return Math.max(jittered, platformDelay);
}

function classifyFacebookError(error) {
    const fbError = error?.response?.data?.error;
    const code = Number(fbError?.code);
    const status = Number(error?.response?.status);
    const permanentCodes = new Set([102, 190, 463, 467, 2500]);
    const retryableCodes = new Set([1, 2, 4, 17, 32, 613, 80004]);
    const rateControl = metaRateControlFromHeaders(error?.response?.headers);
    const message = fbError?.message || error?.message || 'Meta request failed';

    if (error?.retryable === true) {
        return {
            retryable: true,
            code: error.code,
            message,
            retryAfterSeconds: error.retryAfterSeconds || rateControl.retryAfterSeconds,
            rateControl,
        };
    }
    if (permanentCodes.has(code)) return { retryable: false, code, message, rateControl };
    if (
        fbError?.is_transient === true
        || retryableCodes.has(code)
        || [408, 425, 429].includes(status)
        || status >= 500
        || !error?.response
    ) {
        return {
            retryable: true,
            code: Number.isFinite(code) ? code : (Number.isFinite(status) ? status : undefined),
            message,
            retryAfterSeconds: rateControl.retryAfterSeconds,
            rateControl,
        };
    }

    return {
        retryable: false,
        code: Number.isFinite(code) ? code : (Number.isFinite(status) ? status : undefined),
        message,
        rateControl,
    };
}

function classifyTikTokError(error) {
    const status = Number(error?.response?.status);
    const retryAfterSeconds = parseRetryAfterSeconds(headerValue(error?.response?.headers, 'retry-after'));
    if (
        error?.retryable === true
        || !error?.response
        || status >= 500
        || [408, 425, 429].includes(status)
    ) {
        return {
            retryable: true,
            code: error?.code || (Number.isFinite(status) ? status : undefined),
            message: error?.message || 'TikTok request failed',
            retryAfterSeconds: error?.retryAfterSeconds || retryAfterSeconds,
        };
    }

    const data = error.response.data || {};
    const code = data.code || data.error?.code || status;
    const message = data.message || data.error?.message || error.message;
    return { retryable: false, code, message };
}

module.exports = {
    classifyFacebookError,
    classifyTikTokError,
    headerValue,
    metaRateControlFromHeaders,
    parseRetryAfterSeconds,
    retryDelayWithJitterSeconds,
};
