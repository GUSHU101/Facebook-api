function tiktokEventName(metaEventName) {
    return {
        Purchase: 'CompletePayment',
        AddToCart: 'AddToCart',
        InitiateCheckout: 'InitiateCheckout',
        AddPaymentInfo: 'AddPaymentInfo',
        ViewContent: 'ViewContent',
        Search: 'Search',
        PageView: 'PageView',
    }[metaEventName] || metaEventName;
}

function formatTikTokTimestamp(eventTime) {
    const seconds = Number(eventTime);
    return new Date((Number.isFinite(seconds) ? seconds : Math.floor(Date.now() / 1000)) * 1000).toISOString();
}

function tiktokContents(customData) {
    const contents = Array.isArray(customData.contents) ? customData.contents : [];
    return contents.map(item => ({
        content_id: item.id || item.content_id,
        quantity: item.quantity,
        price: item.item_price || item.price,
        content_type: customData.content_type,
        content_name: customData.content_name,
        content_category: customData.content_category,
    })).filter(item => item.content_id);
}

function buildTikTokPayload(pixel, event) {
    const payload = event.request_payload;
    const customData = payload.custom_data || {};
    const userData = payload.user_data || {};
    const platformData = payload._platform_data?.tiktok || {};
    const tiktokPayload = {
        pixel_code: pixel.pixel_id,
        event: tiktokEventName(payload.event_name),
        event_id: payload.event_id,
        timestamp: formatTikTokTimestamp(payload.event_time),
        context: {
            ad: platformData.ttclid ? { callback: platformData.ttclid } : undefined,
            page: {
                url: payload.event_source_url,
            },
            user: {
                email: Array.isArray(userData.em) ? userData.em[0] : undefined,
                phone_number: Array.isArray(userData.ph) ? userData.ph[0] : undefined,
                external_id: Array.isArray(userData.external_id) ? userData.external_id[0] : undefined,
                ttp: platformData.ttp,
            },
            user_agent: userData.client_user_agent,
            ip: userData.client_ip_address,
        },
        properties: {
            contents: tiktokContents(customData),
            currency: customData.currency,
            value: customData.value,
            query: customData.search_string,
            description: customData.content_name,
            order_id: customData.order_id,
        },
        event_source: 'web',
        test_event_code: pixel.test_event_code || undefined,
    };

    return JSON.parse(JSON.stringify(tiktokPayload));
}

module.exports = {
    buildTikTokPayload,
    formatTikTokTimestamp,
    tiktokContents,
    tiktokEventName,
};
