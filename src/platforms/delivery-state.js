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

module.exports = {
    aggregateDeliveryStatus,
    retryDelaySeconds,
};
