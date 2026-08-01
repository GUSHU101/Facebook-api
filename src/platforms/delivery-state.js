function aggregateDeliveryStatus(statuses) {
    const values = Array.isArray(statuses) ? statuses.filter(Boolean) : [];
    if (values.length === 0) return 'PENDING';

    const succeeded = values.filter(status => status === 'SUCCESS').length;
    const permanentFailed = values.filter(status => status === 'FAILED_PERMANENT').length;
    const outstanding = values.filter(status => (
        status === 'PENDING'
        || status === 'IN_PROGRESS'
        || status === 'RETRYABLE_FAILED'
    )).length;

    if (succeeded === values.length) return 'SUCCESS';
    if (outstanding > 0) return 'PENDING';
    if (succeeded > 0 && permanentFailed > 0) return 'PARTIAL_FAILED';
    if (permanentFailed === values.length) return 'FAILED';
    return 'PENDING';
}

function retryDelaySeconds(attempt, baseSeconds, maxSeconds) {
    const safeAttempt = Math.max(1, Number(attempt) || 1);
    const base = Math.max(1, Number(baseSeconds) || 1);
    const maximum = Math.max(base, Number(maxSeconds) || base);
    return Math.min(maximum, base * (2 ** (safeAttempt - 1)));
}

function summarizePermanentRouteFailures(deliveries, maxLength = 4000) {
    const grouped = new Map();
    for (const delivery of Array.isArray(deliveries) ? deliveries : []) {
        const routeId = String(delivery?.route_id ?? 'unknown');
        const platform = String(delivery?.platform || 'unknown');
        const pixelId = String(delivery?.pixel_id || 'unknown');
        const code = String(delivery?.code ?? 'unknown');
        const message = String(delivery?.message || 'Unknown permanent failure')
            .replace(/\s+/g, ' ')
            .trim();
        const key = JSON.stringify([routeId, platform, pixelId, code, message]);
        const existing = grouped.get(key);
        if (existing) {
            existing.count += 1;
        } else {
            grouped.set(key, { routeId, platform, pixelId, code, message, count: 1 });
        }
    }

    const details = [...grouped.values()].map(item => (
        `route=${item.routeId} ${item.platform} pixel=${item.pixelId}`
        + ` code=${item.code} count=${item.count}: ${item.message}`
    ));
    return `Permanent route failures: ${details.join(' | ')}`.slice(0, Math.max(1, Number(maxLength) || 4000));
}

module.exports = {
    aggregateDeliveryStatus,
    retryDelaySeconds,
    summarizePermanentRouteFailures,
};
