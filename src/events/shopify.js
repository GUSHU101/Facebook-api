const {
    compactObject,
    firstPresent,
    normalizeShopifyId,
    tenantScopedIdentifier,
} = require('./common');

function toAbsoluteShopUrl(shopDomain, value) {
    const shopRoot = `https://${shopDomain}`;
    if (!value) return shopRoot;
    try {
        const parsed = new URL(String(value), `${shopRoot}/`);
        // Webhook fields can contain an external referrer or a private order
        // status URL. CAPI event_source_url must remain the merchant website.
        if (parsed.hostname.toLowerCase() !== String(shopDomain).toLowerCase()) return shopRoot;
        return parsed.toString();
    } catch (error) {
        return shopRoot;
    }
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
        let creationTime = Number(timestampMs);
        if (Number.isFinite(creationTime) && creationTime > 0 && creationTime < 10_000_000_000) {
            creationTime *= 1000;
        }
        creationTime = Math.trunc(creationTime);
        if (!/^\d{13}$/.test(String(creationTime))) creationTime = Date.now();
        return `fb.1.${creationTime}.${fbclid}`;
    } catch (error) {
        return undefined;
    }
}

function normalizeContentId(value) {
    return normalizeShopifyId(value);
}

function paidOrderIgnoreReason(order = {}, allowedSources = ['web']) {
    if (order.test === true) return 'test_order';
    const sourceName = String(order.source_name || order.sourceName || '').trim().toLowerCase();
    if (!sourceName) return 'missing_order_source';
    const allowed = new Set(allowedSources.map(source => String(source).trim().toLowerCase()).filter(Boolean));
    return allowed.has(sourceName) ? undefined : `non_web_order_source:${sourceName}`;
}

function shopifyCustomerLifecycle(customer = {}) {
    if (customer.isFirstOrder === true || customer.is_first_order === true) {
        return 'new_customer';
    }
    if (customer.isFirstOrder === false || customer.is_first_order === false) {
        return 'existing_customer';
    }
    const orderCount = Number(firstPresent(customer.orders_count, customer.ordersCount));
    if (Number.isInteger(orderCount) && orderCount > 0) {
        return orderCount === 1 ? 'new_customer' : 'existing_customer';
    }
    return undefined;
}

function shopifyPaymentTimestamp(order = {}) {
    const rawTransactions = Array.isArray(order.transactions)
        ? order.transactions
        : (Array.isArray(order.transactions?.nodes) ? order.transactions.nodes : []);
    const successfulPaymentTimes = rawTransactions
        .filter(transaction => {
            const status = String(transaction?.status || '').trim().toUpperCase();
            const kind = String(transaction?.kind || '').trim().toUpperCase();
            return status === 'SUCCESS' && ['SALE', 'CAPTURE'].includes(kind);
        })
        .map(transaction => firstPresent(
            transaction.processed_at,
            transaction.processedAt,
            transaction.created_at,
            transaction.createdAt,
        ))
        .map(value => ({ value, timestamp: Date.parse(String(value || '')) }))
        .filter(item => Number.isFinite(item.timestamp))
        .sort((left, right) => right.timestamp - left.timestamp);
    return firstPresent(
        successfulPaymentTimes[0]?.value,
        order.updated_at,
        order.updatedAt,
        order.processed_at,
        order.processedAt,
        order.created_at,
        order.createdAt,
    );
}

function allocatedDiscount(item) {
    const directDiscount = Number(item.total_discount);
    const allocationTotal = (Array.isArray(item.discount_allocations) ? item.discount_allocations : [])
        .reduce((sum, allocation) => {
            const amount = Number(allocation?.amount);
            return sum + (Number.isFinite(amount) && amount >= 0 ? amount : 0);
        }, 0);
    return Math.max(
        Number.isFinite(directDiscount) && directDiscount >= 0 ? directDiscount : 0,
        allocationTotal,
    );
}

function discountedUnitPrice(item, quantity) {
    const explicitlyDiscounted = Number(firstPresent(
        item.discounted_unit_price,
        item.discounted_price,
        item.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount,
        item.discountedUnitPriceSet?.shopMoney?.amount,
    ));
    if (Number.isFinite(explicitlyDiscounted) && explicitlyDiscounted >= 0) return explicitlyDiscounted;

    const baseUnitPrice = Number(item.price);
    if (!Number.isFinite(baseUnitPrice) || baseUnitPrice < 0) return undefined;
    const discount = allocatedDiscount(item);
    return Math.max(0, ((baseUnitPrice * quantity) - discount) / quantity);
}

function buildOrderContents(order) {
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    return lineItems.map(item => {
        // Shopify Order/LineItem IDs identify a transaction row, not a Meta
        // Catalog item. Only durable catalog identities are eligible here.
        const id = normalizeContentId(firstPresent(item.variant_id, item.product_id, item.sku));
        if (!id) return undefined;
        const requestedQuantity = Number(item.quantity);
        const quantity = Number.isFinite(requestedQuantity) && requestedQuantity > 0 ? requestedQuantity : 1;
        const itemPrice = discountedUnitPrice(item, quantity);
        return compactObject({
            id,
            quantity,
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
    const reportedItemQuantity = Number(firstPresent(
        order.current_subtotal_line_items_quantity,
        order.subtotal_line_items_quantity,
    ));
    const sourceUrl = toAbsoluteShopUrl(shopDomain, order.landing_site);
    const checkoutToken = firstPresent(order.checkout_token, order.cart_token, order.token);
    const fbp = firstPresent(
        readOrderAttribute(order, ['_fbp', 'fbp', 'facebook_browser_id']),
        order.client_details?.fbp,
    );
    const orderCreatedAtMs = Date.parse(String(firstPresent(order.created_at, order.processed_at, '') || ''));
    const fbcCreatedAtMs = options.nowMs !== undefined && options.nowMs !== null
        && Number.isFinite(Number(options.nowMs))
        ? Number(options.nowMs)
        : (Number.isFinite(orderCreatedAtMs) ? orderCreatedAtMs : Date.now());
    const fbc = firstPresent(
        readOrderAttribute(order, ['_fbc', 'fbc', 'facebook_click_id']),
        order.client_details?.fbc,
        buildFbcFromUrl(sourceUrl, fbcCreatedAtMs),
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
    const stableEventId = tenantScopedIdentifier(shopDomain, firstPresent(
        checkoutToken,
        orderId,
        orderName,
        // Note attributes can be storefront-controlled. They are useful only
        // as a last-resort compatibility fallback, never ahead of immutable
        // Shopify checkout/order identifiers.
        readOrderAttribute(order, ['event_id', 'capi_event_id']),
    ));

    return {
        event_name: 'Purchase',
        // action_source describes where the conversion happened, not how the
        // event was recovered. Reconciled Online Store orders still occurred
        // on the merchant website and must match the browser Pixel semantics.
        action_source: 'website',
        // Never invent a Purchase ID: a random fallback would turn every
        // Shopify webhook retry into a distinct conversion. The authenticated
        // webhook handler rejects payloads that lack this stable identity.
        event_id: stableEventId === undefined ? undefined : String(stableEventId),
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
        _shopify_order_id: orderId,
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
        num_items: Number.isFinite(reportedItemQuantity) && reportedItemQuantity >= 0
            ? reportedItemQuantity
            : contents.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        order_id: orderName,
        customer_lifecycle: shopifyCustomerLifecycle(customer),
        source_url: sourceUrl,
        // For orders/paid, the webhook trigger time is the closest available
        // timestamp to the actual payment transition. Checkout creation time
        // can be hours or days earlier for deferred/manual payment flows.
        timestamp: firstPresent(options.eventTimestamp, order.processed_at, order.updated_at, order.created_at),
    };
}

module.exports = {
    buildFbcFromUrl,
    buildOrderContents,
    buildShopifyOrderPurchasePayload,
    discountedUnitPrice,
    normalizeContentId,
    paidOrderIgnoreReason,
    readOrderAttribute,
    shopifyCustomerLifecycle,
    shopifyPaymentTimestamp,
    toAbsoluteShopUrl,
};
