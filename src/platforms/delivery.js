function successfulDeliveryKeys(dbEvents) {
    const keys = new Set();
    for (const event of dbEvents) {
        const deliveries = event.fb_response?.deliveries || [];
        for (const delivery of deliveries) {
            if (delivery.status === 'SUCCESS' && delivery.platform && delivery.pixel_id) {
                keys.add(`${delivery.platform}:${delivery.pixel_id}`);
            }
        }
    }
    return keys;
}

function shouldSkipPixel(pixel, successfulKeys) {
    return successfulKeys.has(`${pixel.platform || 'facebook'}:${pixel.pixel_id}`);
}

module.exports = {
    shouldSkipPixel,
    successfulDeliveryKeys,
};
