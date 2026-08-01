const META_QUALITY_METRIC_TYPE = 'EVENT_MATCH_QUALITY';
const META_DATASET_QUALITY_FIELDS = [
    'event_name',
    // Diagnostics are not part of every default Graph object projection.
    // Request them explicitly while retaining the default score and match-key
    // fields documented for AdsPixelCAPIEMQ.
    'event_match_quality{composite_score,match_key_feedback,diagnostics}',
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
        // Meta's Dataset Quality guide has used both spellings in examples.
        // The current field selector is dedup_key_feedback, but accepting the
        // response alias keeps historical snapshots and API variants visible.
        dedup_key_feedback: firstPresent(
            value?.dedup_key_feedback,
            value?.dedupe_key_feedback,
        ),
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
        const details = compactObject(officialQualityDetails(value));
        // Coverage, freshness, dedupe feedback and EMQ diagnostics remain
        // actionable even when Meta has not produced a composite score yet.
        if (eventName && (score !== null || Object.keys(details).length > 0)) {
            const key = String(eventName);
            if (!seen.has(key)) {
                seen.add(key);
                events.push(compactObject({
                    event_name: key,
                    score: score === null ? undefined : Number(score.toFixed(1)),
                    ...details,
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
    const scoredEvents = events.filter(item => Number.isFinite(Number(item.score)));
    const average = scoredEvents.length
        ? Number((scoredEvents.reduce((sum, item) => sum + Number(item.score), 0) / scoredEvents.length).toFixed(1))
        : null;
    return {
        metric_type: META_QUALITY_METRIC_TYPE,
        average_score: average,
        scored_event_count: scoredEvents.length,
        diagnostic_count: events.reduce(
            (sum, item) => sum + (Array.isArray(item.diagnostics) ? item.diagnostics.length : 0),
            0,
        ),
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
