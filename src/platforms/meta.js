function validateMetaEvent(event, nowSeconds = Math.floor(Date.now() / 1000)) {
    const errors = [];
    if (!event || typeof event !== 'object') return ['event must be an object'];
    if (!String(event.event_name || '').trim()) errors.push('event_name is required');
    if (!String(event.event_id || '').trim()) errors.push('event_id is required');

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

    const commerceEvents = new Set(['AddToCart', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase']);
    if (commerceEvents.has(event.event_name)) {
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

module.exports = {
    validateMetaEvent,
};
