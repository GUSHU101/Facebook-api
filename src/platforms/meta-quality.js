const META_QUALITY_METRIC_TYPE = 'EVENT_MATCH_QUALITY';
const META_DATASET_QUALITY_FIELDS = [
    'event_name',
    'event_match_quality',
    'event_coverage',
    'dedup_key_feedback',
    'data_freshness',
    'acr',
].join(',');

function firstPresent(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function scoreFromValue(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const match = value.match(/\d+(?:\.\d+)?/);
        if (match) return Number(match[0]);
    }
    if (typeof value === 'object') {
        return scoreFromValue(firstPresent(
            value.composite_score,
            value.score,
            value.value,
            value.rating,
            value.event_match_quality_score,
            value.match_quality_score,
            value.event_match_quality,
        ));
    }
    return null;
}

function eventNameFromObject(value) {
    return firstPresent(
        value.event_name,
        value.event,
        value.standard_event,
        value.event_type,
        value.name,
    );
}

function officialQualityDetails(value) {
    const matchQuality = value?.event_match_quality;
    return {
        match_key_feedback: Array.isArray(matchQuality?.match_key_feedback)
            ? matchQuality.match_key_feedback
            : undefined,
        diagnostics: Array.isArray(matchQuality?.diagnostics)
            ? matchQuality.diagnostics
            : undefined,
        event_coverage: value?.event_coverage,
        dedup_key_feedback: value?.dedup_key_feedback,
        data_freshness: value?.data_freshness,
        acr: value?.acr,
    };
}

function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => (
        item !== undefined && item !== null && item !== ''
    )));
}

function extractOfficialEmqEvents(rawPayload) {
    const events = [];
    const seen = new Set();

    function visit(value) {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }

        const eventName = eventNameFromObject(value);
        const score = scoreFromValue(firstPresent(
            value.event_match_quality_score,
            value.match_quality_score,
            value.event_match_quality,
            value.emq_score,
            value.score,
        ));
        if (eventName && score !== null) {
            const key = String(eventName);
            if (!seen.has(key)) {
                seen.add(key);
                events.push(compactObject({
                    event_name: key,
                    score: Number(score.toFixed(1)),
                    ...officialQualityDetails(value),
                }));
            }
        }

        Object.values(value).forEach(visit);
    }

    visit(rawPayload);
    return events;
}

function summarizeMetaQuality(rawPayload) {
    const events = extractOfficialEmqEvents(rawPayload);
    const average = events.length
        ? Number((events.reduce((sum, item) => sum + Number(item.score || 0), 0) / events.length).toFixed(1))
        : null;
    return {
        metric_type: META_QUALITY_METRIC_TYPE,
        average_score: average,
        events,
    };
}

function buildMetaQualityRequestParams(datasetId, agentName = '') {
    const normalizedAgent = String(agentName || '').trim().toLowerCase();
    return compactObject({
        dataset_id: String(datasetId),
        fields: `web{${META_DATASET_QUALITY_FIELDS}}`,
        agent_name: normalizedAgent || undefined,
    });
}

module.exports = {
    META_DATASET_QUALITY_FIELDS,
    META_QUALITY_METRIC_TYPE,
    buildMetaQualityRequestParams,
    extractOfficialEmqEvents,
    summarizeMetaQuality,
};
