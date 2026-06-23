function successfulDeliveryKey(pixel) {
    return `${pixel.platform || 'facebook'}:${pixel.pixel_id}`;
}

function eventIdForDelivery(event) {
    return event?.request_payload?.event_id || event?.event_id;
}

function deliveryAppliesToEvent(delivery, event) {
    if (!Array.isArray(delivery.event_ids) || delivery.event_ids.length === 0) {
        return true;
    }

    const eventId = eventIdForDelivery(event);
    return eventId !== undefined && delivery.event_ids.map(String).includes(String(eventId));
}

function eventHasSuccessfulDelivery(event, pixel) {
    const key = successfulDeliveryKey(pixel);
    const deliveries = event.fb_response?.deliveries || [];
    return deliveries.some(delivery => (
        delivery.status === 'SUCCESS'
        && `${delivery.platform || 'facebook'}:${delivery.pixel_id}` === key
        && deliveryAppliesToEvent(delivery, event)
    ));
}

function successfulDeliveryKeys(dbEvents) {
    if (!Array.isArray(dbEvents) || dbEvents.length === 0) return new Set();

    let sharedKeys;
    for (const event of dbEvents) {
        const eventKeys = new Set();
        const deliveries = event.fb_response?.deliveries || [];
        for (const delivery of deliveries) {
            if (
                delivery.status === 'SUCCESS'
                && delivery.platform
                && delivery.pixel_id
                && deliveryAppliesToEvent(delivery, event)
            ) {
                eventKeys.add(`${delivery.platform}:${delivery.pixel_id}`);
            }
        }

        if (sharedKeys === undefined) {
            sharedKeys = eventKeys;
        } else {
            sharedKeys = new Set([...sharedKeys].filter(key => eventKeys.has(key)));
        }
    }

    return sharedKeys || new Set();
}

function shouldSkipPixel(pixel, successfulKeys) {
    return successfulKeys.has(successfulDeliveryKey(pixel));
}

module.exports = {
    eventHasSuccessfulDelivery,
    shouldSkipPixel,
    successfulDeliveryKeys,
};
