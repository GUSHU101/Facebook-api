const crypto = require('crypto');
const { compactObject, firstPresent, normalizeShopifyId } = require('./common');

function toAbsoluteShopUrl(shopDomain, value) {
    if (!value) return `https://${shopDomain}`;
    const text = String(value);
    if (/^https?:\/\//i.test(text)) return text;
    return `https://${shopDomain}${text.startsWith('/') ? text : `/${text}`}`;
}

function readOrderAttribute(order, names) {
    const attributes = [
        ...(Array.isArray(order.note_attributes) ? order.note_attributes : []),
        ...(Array.isArray(order.custom_attributes) ? order.custom_attributes : []),
    ];
    const normalizedNames = new Set(names.map(name => name.toLowerCase()));
    const found = attributes.find(item => normalizedNames.has(String(item.name || item.key || '').toLowerCase()));
    return found?.value;
}

function buildFbcFromUrl(sourceUrl, timestampMs = Date.now()) {
    try {
        const parsed = new URL(sourceUrl);
        const fbclid = parsed.searchParams.get('fbclid');
        if (!fbclid) return undefined;
        return `fb.1.${timestampMs}.${fbclid}`;
    } catch (error) {
        return undefined;
    }
}

function normalizeContentId(value) {
    return normalizeShopifyId(value);
}

function buildOrderContents(order) {
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    return lineItems.map(item => {
        const id = normalizeContentId(firstPresent(item.variant_id, item.product_id, item.sku, item.id));
        if (!id) return undefined;
        const quantity = Number(item.quantity || 1);
        const itemPrice = Number(firstPresent(item.price, item.pre_tax_price, item.discounted_price));
        return compactObject({
            id,
            quantity: Number.isFinite(quantity) ? quantity : 1,
            item_price: Number.isFinite(itemPrice) ? itemPrice : undefined,
        });
    }).filter(Boolean);
}

function buildShopifyOrderPurchasePayload(order, shopDomain, options = {}) {
    const billingAddress = order.billing_address || {};
    const shippingAddress = order.shipping_address || {};
    const customer = order.customer || {};
    const address = Object.keys(billingAddress).length ? billingAddress : shippingAddress;
    const contents = buildOrderContents(order);
    const sourceUrl = toAbsoluteShopUrl(shopDomain, firstPresent(order.landing_site, order.referring_site, order.order_status_url));
    const checkoutToken = firstPresent(order.checkout_token, order.cart_token, order.token);
    const fbp = firstPresent(
        readOrderAttribute(order, ['_fbp', 'fbp', 'facebook_browser_id']),
        order.client_details?.fbp,
    );
    const fbc = firstPresent(
        readOrderAttribute(order, ['_fbc', 'fbc', 'facebook_click_id']),
        order.client_details?.fbc,
        buildFbcFromUrl(sourceUrl, options.nowMs),
    );
    const ttp = firstPresent(
        readOrderAttribute(order, ['_ttp', 'ttp', 'tiktok_cookie_id']),
        order.client_details?.ttp,
    );
    const ttclid = firstPresent(
        readOrderAttribute(order, ['ttclid', 'tiktok_click_id']),
        (() => {
            try {
                return new URL(sourceUrl).searchParams.get('ttclid');
            } catch (error) {
                return undefined;
            }
        })(),
    );
    const shopifyY = readOrderAttribute(order, ['_shopify_y', 'shopify_y']);
    const shopifyS = readOrderAttribute(order, ['_shopify_s', 'shopify_s']);
    const clientId = firstPresent(readOrderAttribute(order, ['client_id', 'shopify_client_id']), shopifyY);
    const orderId = normalizeShopifyId(order.id);
    const orderName = firstPresent(order.name, order.order_number, orderId);

    return {
        event_name: 'Purchase',
        event_id: firstPresent(readOrderAttribute(order, ['event_id', 'capi_event_id']), checkoutToken, orderId, orderName, crypto.randomUUID()).toString(),
        email: firstPresent(order.email, order.contact_email, customer.email),
        phone: firstPresent(order.phone, customer.phone, billingAddress.phone, shippingAddress.phone),
        firstName: firstPresent(billingAddress.first_name, shippingAddress.first_name, customer.first_name),
        lastName: firstPresent(billingAddress.last_name, shippingAddress.last_name, customer.last_name),
        city: address.city,
        state: address.province_code || address.province,
        zip: address.zip,
        country: address.country_code || address.country,
        external_id: firstPresent(
            normalizeShopifyId(customer.id),
            normalizeShopifyId(customer.admin_graphql_api_id),
            clientId,
            checkoutToken,
            orderId,
            orderName,
        ),
        client_id: clientId,
        checkout_token: checkoutToken,
        cart_token: order.cart_token,
        shopify_y: shopifyY,
        shopify_s: shopifyS,
        client_ip: firstPresent(order.browser_ip, order.client_details?.browser_ip),
        user_agent: order.client_details?.user_agent,
        fbp,
        fbc,
        ttp,
        ttclid,
        value: firstPresent(order.current_total_price, order.total_price),
        currency: firstPresent(order.currency, order.presentment_currency, order.current_total_price_set?.shop_money?.currency_code),
        content_ids: contents.map(item => item.id),
        contents,
        content_type: 'product',
        num_items: contents.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        order_id: orderName,
        source_url: sourceUrl,
        timestamp: order.created_at || order.processed_at || order.updated_at,
    };
}

module.exports = {
    buildFbcFromUrl,
    buildOrderContents,
    buildShopifyOrderPurchasePayload,
    normalizeContentId,
    readOrderAttribute,
    toAbsoluteShopUrl,
};
