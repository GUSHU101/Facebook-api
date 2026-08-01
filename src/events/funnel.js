const FUNNEL_EVENT_DEFINITIONS = Object.freeze([
    Object.freeze({
        event_name: 'AddToCart',
        label: '加入购物车',
        shopify_source: 'product_added_to_cart',
        grain: 'action',
    }),
    Object.freeze({
        event_name: 'InitiateCheckout',
        label: '发起结账',
        shopify_source: 'checkout_started',
        grain: 'action',
    }),
    Object.freeze({
        event_name: 'AddPaymentInfo',
        label: '添加支付信息',
        shopify_source: 'payment_info_submitted',
        grain: 'action',
    }),
    Object.freeze({
        event_name: 'Purchase',
        label: '购买',
        shopify_source: 'orders/paid + checkout_completed',
        grain: 'order',
    }),
]);

const FUNNEL_EVENT_NAMES = Object.freeze(
    FUNNEL_EVENT_DEFINITIONS.map(definition => definition.event_name),
);

const FUNNEL_EVENT_NAME_SET = new Set(FUNNEL_EVENT_NAMES);

function decorateFunnelSummary(rows = []) {
    const byName = new Map(rows.map(row => [String(row.event_name), row]));
    return FUNNEL_EVENT_DEFINITIONS.map(definition => {
        const row = byName.get(definition.event_name) || {};
        const totalEvents = Number(row.total_events || 0);
        const successfulEvents = Number(row.successful_events || 0);
        return {
            ...definition,
            total_events: totalEvents,
            unique_events: Number(row.unique_events || 0),
            successful_events: successfulEvents,
            pending_events: Number(row.pending_events || 0),
            awaiting_payment_events: Number(row.awaiting_payment_events || 0),
            failed_events: Number(row.failed_events || 0),
            missing_parameter_events: Number(row.missing_parameter_events || 0),
            locally_invalid_events: Number(row.locally_invalid_events || 0),
            avg_emq: row.avg_emq === null || row.avg_emq === undefined
                ? null
                : Number(row.avg_emq),
            value_by_currency: row.value_by_currency || {},
            success_rate: totalEvents
                ? Number(((successfulEvents / totalEvents) * 100).toFixed(1))
                : null,
        };
    });
}

module.exports = {
    FUNNEL_EVENT_DEFINITIONS,
    FUNNEL_EVENT_NAMES,
    FUNNEL_EVENT_NAME_SET,
    decorateFunnelSummary,
};
