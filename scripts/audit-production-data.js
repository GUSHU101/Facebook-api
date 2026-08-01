'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const OUTPUT_DIR = path.resolve(process.cwd(), '.audit');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'production-data-profile.json');
const FUNNEL_EVENTS = new Set([
    'AddToCart',
    'InitiateCheckout',
    'AddPaymentInfo',
    'Purchase',
]);

function increment(target, key, amount = 1) {
    const normalized = String(key ?? 'UNKNOWN');
    target[normalized] = (target[normalized] || 0) + amount;
}

function percent(numerator, denominator) {
    return denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;
}

function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return Number(sorted[index].toFixed(3));
}

function iso(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function eventEpoch(payload, fallback) {
    const raw = Number(payload?.event_time);
    if (Number.isFinite(raw) && raw > 0) return raw;
    const date = fallback instanceof Date ? fallback : new Date(fallback);
    return Number.isNaN(date.getTime()) ? null : date.getTime() / 1000;
}

function nonEmpty(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
}

function orderIdentity(payload) {
    const values = [
        payload?.id,
        payload?.order_id,
        payload?.admin_graphql_api_id,
        payload?.checkout_id,
        payload?.checkout_token,
        payload?.cart_token,
        payload?.token,
        payload?.name,
        payload?.order_number,
    ];
    return values.find(nonEmpty) ?? null;
}

function purchaseIdentity(payload) {
    const custom = payload?.custom_data || {};
    const values = [
        payload?._shopify_order_id,
        custom.order_id,
        custom.order_number,
        payload?.event_id,
    ];
    return values.find(nonEmpty) ?? null;
}

function safeShopRows(rows) {
    return rows.map(row => ({
        id: row.id,
        shop_domain: row.shop_domain,
        status: row.status,
        created_at: iso(row.created_at),
        has_admin_access_token: Boolean(row.has_admin_access_token),
    }));
}

async function tableExists(client, name) {
    const result = await client.query(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [`public.${name}`],
    );
    return result.rows[0]?.exists === true;
}

async function selectIfExists(client, table, sql) {
    if (!(await tableExists(client, table))) return [];
    return (await client.query(sql)).rows;
}

async function main(databaseUrl = process.env.DATABASE_URL) {
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required');
    }

    const client = new Client({
        connectionString: databaseUrl,
        statement_timeout: 120000,
        query_timeout: 120000,
        application_name: 'capi-production-readonly-audit',
    });

    await client.connect();
    await client.query('BEGIN READ ONLY');

    try {
        const generatedAt = new Date();
        const schemaRows = (await client.query(`
            SELECT c.relname AS table_name,
                   pg_total_relation_size(c.oid)::bigint AS total_bytes,
                   COALESCE(s.n_live_tup, 0)::bigint AS estimated_rows
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
            WHERE n.nspname = 'public' AND c.relkind = 'r'
            ORDER BY c.relname
        `)).rows;

        const exactCounts = {};
        for (const row of schemaRows) {
            const safeName = String(row.table_name).replace(/[^a-z0-9_]/gi, '');
            const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM public.${safeName}`);
            exactCounts[safeName] = Number(result.rows[0].count);
        }

        const shops = await selectIfExists(client, 'shops', `
            SELECT id, shop_domain, status, created_at,
                   (admin_access_token IS NOT NULL AND admin_access_token <> '') AS has_admin_access_token
            FROM shops ORDER BY id
        `);
        const pixels = await selectIfExists(client, 'pixels', `
            SELECT id, shop_id, platform, name, pixel_id, credential_scope,
                   rate_limit_group, test_event_code, credential_version,
                   rate_limit_until, last_rate_limit_at, last_usage_pct,
                   consecutive_failures, last_delivery_at, status, archived_at,
                   created_at,
                   (quality_access_token IS NOT NULL AND quality_access_token <> '') AS has_quality_token
            FROM pixels ORDER BY id
        `);
        const routes = await selectIfExists(client, 'shop_pixel_routes', `
            SELECT r.id, r.shop_id, s.shop_domain, r.pixel_id AS pixel_record_id,
                   p.platform, p.pixel_id, r.test_event_code, r.test_event_code_expires_at,
                   r.status, r.created_at
            FROM shop_pixel_routes r
            JOIN shops s ON s.id = r.shop_id
            JOIN pixels p ON p.id = r.pixel_id
            ORDER BY r.id
        `);
        const events = await selectIfExists(client, 'event_store', `
            SELECT id, shop_id, timestamp, event_name, event_id, status,
                   emq_estimate, request_payload, fb_response, delivery_route_snapshot
            FROM event_store ORDER BY id
        `);
        const deliveries = await selectIfExists(client, 'event_deliveries', `
            SELECT id, event_store_id, route_id, status, attempt_count,
                   next_attempt_at, lease_expires_at, last_attempt_at, delivered_at,
                   error_code, error_message, created_at, updated_at
            FROM event_deliveries ORDER BY id
        `);
        const webhooks = await selectIfExists(client, 'shopify_webhook_inbox', `
            SELECT id, shop_id, webhook_id, topic, triggered_at, payload, status,
                   attempt_count, next_attempt_at, lease_expires_at, error_message,
                   created_at, processed_at
            FROM shopify_webhook_inbox ORDER BY id
        `);
        const aliases = await selectIfExists(client, 'event_id_aliases', `
            SELECT id, shop_id, event_name, alias_type, alias_value,
                   canonical_event_id, created_at, updated_at
            FROM event_id_aliases ORDER BY id
        `);
        const deadLetters = await selectIfExists(client, 'dead_letters', `
            SELECT id, shop_id, failed_at, error_reason, status FROM dead_letters ORDER BY id
        `);
        const qualitySnapshots = await selectIfExists(client, 'meta_quality_snapshots', `
            SELECT id, pixel_route_id, shop_id, dataset_id, fetched_at, status,
                   metric_type, summary_payload, error_message
            FROM meta_quality_snapshots ORDER BY id
        `);
        const reconcileState = await selectIfExists(client, 'shopify_reconcile_state', `
            SELECT shop_id, last_successful_at, scan_since, scan_cutoff,
                   (after_cursor IS NOT NULL AND after_cursor <> '') AS has_after_cursor,
                   last_error, updated_at
            FROM shopify_reconcile_state ORDER BY shop_id
        `);

        const shopById = new Map(shops.map(row => [Number(row.id), row.shop_domain]));
        const eventById = new Map(events.map(row => [Number(row.id), row]));
        const routeById = new Map(routes.map(row => [Number(row.id), row]));
        const eventKeyCounts = new Map();
        const eventSummary = {};
        const sourceVersions = {};
        const sourceProviders = {};
        const sourceEventNames = {};
        const statusCounts = {};
        const lagSeconds = [];
        const futureEvents = [];
        const missingSource = [];
        const routeSnapshotMismatches = [];
        const nowEpoch = generatedAt.getTime() / 1000;
        const identitySignals = ['em', 'ph', 'external_id', 'fbp', 'fbc', 'client_ip_address', 'client_user_agent'];

        for (const event of events) {
            const shopDomain = shopById.get(Number(event.shop_id)) || `shop:${event.shop_id}`;
            const key = `${event.shop_id}|${event.event_name}|${event.event_id}`;
            eventKeyCounts.set(key, (eventKeyCounts.get(key) || 0) + 1);
            increment(statusCounts, event.status);

            const payload = event.request_payload || {};
            const source = payload._source || {};
            const sourceVersion = source.source_version || payload._platform_data?.source_version || 'MISSING';
            const sourceProvider = source.provider
                || source.source_provider
                || (sourceVersion !== 'MISSING' ? 'shopify_web_pixels' : null)
                || (event.event_name === 'Purchase' && payload._payment_confirmed === true
                    ? 'shopify_webhook_or_reconcile'
                    : 'MISSING');
            const sourceEventName = source.event_name || source.source_event_name || 'MISSING';
            increment(sourceVersions, sourceVersion);
            increment(sourceProviders, sourceProvider);
            increment(sourceEventNames, sourceEventName);

            if (!payload._source) missingSource.push(Number(event.id));
            const epoch = eventEpoch(payload, event.timestamp);
            const insertedEpoch = new Date(event.timestamp).getTime() / 1000;
            if (epoch !== null && Number.isFinite(insertedEpoch)) {
                lagSeconds.push(insertedEpoch - epoch);
                if (epoch > nowEpoch + 300) futureEvents.push(Number(event.id));
            }

            const eventKey = `${shopDomain}|${event.event_name}`;
            if (!eventSummary[eventKey]) {
                eventSummary[eventKey] = {
                    shop_domain: shopDomain,
                    event_name: event.event_name,
                    total: 0,
                    unique_event_ids: new Set(),
                    statuses: {},
                    signals: Object.fromEntries(identitySignals.map(signal => [signal, 0])),
                    custom_data: { currency: 0, value: 0, content_ids: 0, order_id: 0 },
                    source_versions: {},
                    first_event_time: null,
                    last_event_time: null,
                };
            }
            const item = eventSummary[eventKey];
            item.total += 1;
            item.unique_event_ids.add(event.event_id);
            increment(item.statuses, event.status);
            increment(item.source_versions, sourceVersion);
            for (const signal of identitySignals) {
                if (nonEmpty(payload.user_data?.[signal])) item.signals[signal] += 1;
            }
            for (const field of Object.keys(item.custom_data)) {
                if (nonEmpty(payload.custom_data?.[field])) item.custom_data[field] += 1;
            }
            const eventIso = epoch === null ? null : new Date(epoch * 1000).toISOString();
            if (eventIso && (!item.first_event_time || eventIso < item.first_event_time)) item.first_event_time = eventIso;
            if (eventIso && (!item.last_event_time || eventIso > item.last_event_time)) item.last_event_time = eventIso;
        }

        const duplicates = [...eventKeyCounts.entries()]
            .filter(([, count]) => count > 1)
            .map(([key, count]) => {
                const [shopId, eventName] = key.split('|');
                return { shop_domain: shopById.get(Number(shopId)), event_name: eventName, count };
            });

        const normalizedEventSummary = Object.values(eventSummary).map(item => ({
            ...item,
            unique_event_ids: item.unique_event_ids.size,
            duplicate_rate_pct: percent(item.total - item.unique_event_ids.size, item.total),
            signal_coverage_pct: Object.fromEntries(
                Object.entries(item.signals).map(([signal, count]) => [signal, percent(count, item.total)]),
            ),
            custom_data_coverage_pct: Object.fromEntries(
                Object.entries(item.custom_data).map(([field, count]) => [field, percent(count, item.total)]),
            ),
        }));

        const deliveryStatus = {};
        const deliveryErrors = {};
        const orphanDeliveries = [];
        const crossTenantDeliveries = [];
        const deliveryCountsByEvent = new Map();
        for (const delivery of deliveries) {
            increment(deliveryStatus, delivery.status);
            if (delivery.error_code || delivery.error_message) {
                increment(deliveryErrors, `${delivery.error_code || 'NO_CODE'}|${delivery.error_message || 'NO_MESSAGE'}`);
            }
            const event = eventById.get(Number(delivery.event_store_id));
            const route = routeById.get(Number(delivery.route_id));
            if (!event || !route) orphanDeliveries.push(Number(delivery.id));
            else if (Number(event.shop_id) !== Number(route.shop_id)) crossTenantDeliveries.push(Number(delivery.id));
            deliveryCountsByEvent.set(
                Number(delivery.event_store_id),
                (deliveryCountsByEvent.get(Number(delivery.event_store_id)) || 0) + 1,
            );
        }

        for (const event of events) {
            const expected = Array.isArray(event.delivery_route_snapshot) ? event.delivery_route_snapshot.length : 0;
            const actual = deliveryCountsByEvent.get(Number(event.id)) || 0;
            if (expected !== actual) {
                routeSnapshotMismatches.push({ event_store_id: Number(event.id), expected, actual });
            }
        }

        const webhookTopics = {};
        const webhookStatuses = {};
        const webhookErrors = {};
        const paidOrdersByShop = new Map();
        for (const webhook of webhooks) {
            increment(webhookTopics, webhook.topic);
            increment(webhookStatuses, webhook.status);
            if (webhook.error_message) increment(webhookErrors, webhook.error_message);
            if (webhook.topic === 'orders/paid') {
                const key = `${webhook.shop_id}|${String(orderIdentity(webhook.payload) || webhook.webhook_id)}`;
                paidOrdersByShop.set(key, webhook);
            }
        }

        const purchasesByShop = new Map();
        for (const event of events.filter(item => item.event_name === 'Purchase')) {
            const identity = purchaseIdentity(event.request_payload) || event.event_id;
            const key = `${event.shop_id}|${String(identity)}`;
            if (!purchasesByShop.has(key)) purchasesByShop.set(key, []);
            purchasesByShop.get(key).push(event);
        }

        const purchaseWithoutPaidWebhook = [...purchasesByShop.entries()]
            .filter(([key]) => !paidOrdersByShop.has(key))
            .map(([, purchaseEvents]) => ({
                shop_domain: shopById.get(Number(purchaseEvents[0].shop_id)),
                event_count: purchaseEvents.length,
                statuses: purchaseEvents.map(item => item.status),
            }));
        const paidWebhookWithoutPurchase = [...paidOrdersByShop.entries()]
            .filter(([key]) => !purchasesByShop.has(key))
            .map(([, webhook]) => ({
                shop_domain: shopById.get(Number(webhook.shop_id)),
                webhook_status: webhook.status,
                triggered_at: iso(webhook.triggered_at || webhook.created_at),
            }));

        const aliasKeyCounts = new Map();
        for (const alias of aliases) {
            const key = `${alias.shop_id}|${alias.event_name}|${alias.alias_type}|${alias.alias_value}`;
            aliasKeyCounts.set(key, (aliasKeyCounts.get(key) || 0) + 1);
        }
        const duplicateAliases = [...aliasKeyCounts.values()].filter(count => count > 1).length;

        const result = {
            generated_at: generatedAt.toISOString(),
            scope: 'Complete production-table read; output is aggregated and excludes credentials, raw customer identifiers, IP addresses, user agents, and raw payload bodies.',
            database: {
                tables: schemaRows.map(row => ({
                    table_name: row.table_name,
                    exact_rows: exactCounts[row.table_name],
                    total_bytes: Number(row.total_bytes),
                })),
                total_bytes: schemaRows.reduce((sum, row) => sum + Number(row.total_bytes), 0),
            },
            configuration: {
                shops: safeShopRows(shops),
                pixels: pixels.map(row => ({
                    ...row,
                    rate_limit_until: iso(row.rate_limit_until),
                    last_rate_limit_at: iso(row.last_rate_limit_at),
                    last_delivery_at: iso(row.last_delivery_at),
                    archived_at: iso(row.archived_at),
                    created_at: iso(row.created_at),
                })),
                routes: routes.map(row => ({ ...row, created_at: iso(row.created_at) })),
                reconcile_state: reconcileState.map(row => ({
                    ...row,
                    last_successful_at: iso(row.last_successful_at),
                    scan_since: iso(row.scan_since),
                    scan_cutoff: iso(row.scan_cutoff),
                    updated_at: iso(row.updated_at),
                })),
            },
            events: {
                total: events.length,
                status_counts: statusCounts,
                source_versions: sourceVersions,
                source_providers: sourceProviders,
                source_event_names: sourceEventNames,
                duplicate_keys: duplicates.length,
                duplicate_rows: duplicates.reduce((sum, item) => sum + item.count - 1, 0),
                duplicate_rate_pct: percent(duplicates.reduce((sum, item) => sum + item.count - 1, 0), events.length),
                duplicate_breakdown: duplicates,
                missing_source_metadata: missingSource.length,
                future_dated_events: futureEvents.length,
                ingestion_lag_seconds: {
                    p50: percentile(lagSeconds, 0.5),
                    p95: percentile(lagSeconds, 0.95),
                    max: lagSeconds.length ? Number(Math.max(...lagSeconds).toFixed(3)) : null,
                    min: lagSeconds.length ? Number(Math.min(...lagSeconds).toFixed(3)) : null,
                },
                by_shop_and_event: normalizedEventSummary,
                funnel: normalizedEventSummary.filter(item => FUNNEL_EVENTS.has(item.event_name)),
            },
            delivery: {
                total: deliveries.length,
                status_counts: deliveryStatus,
                errors: deliveryErrors,
                orphan_deliveries: orphanDeliveries.length,
                cross_tenant_deliveries: crossTenantDeliveries.length,
                route_snapshot_mismatches: routeSnapshotMismatches.length,
                route_snapshot_mismatch_sample: routeSnapshotMismatches.slice(0, 25),
            },
            shopify_webhooks: {
                total: webhooks.length,
                topics: webhookTopics,
                statuses: webhookStatuses,
                errors: webhookErrors,
                unique_paid_orders: paidOrdersByShop.size,
                paid_orders_without_purchase: paidWebhookWithoutPurchase,
                purchases_without_paid_webhook: purchaseWithoutPaidWebhook,
            },
            aliases: {
                total: aliases.length,
                duplicate_alias_keys: duplicateAliases,
            },
            dead_letters: {
                total: deadLetters.length,
                by_status: deadLetters.reduce((acc, row) => (increment(acc, row.status), acc), {}),
                by_reason: deadLetters.reduce((acc, row) => (increment(acc, row.error_reason || 'MISSING'), acc), {}),
            },
            meta_quality: {
                total: qualitySnapshots.length,
                by_status: qualitySnapshots.reduce((acc, row) => (increment(acc, row.status), acc), {}),
                latest_fetched_at: qualitySnapshots.length
                    ? iso(qualitySnapshots[qualitySnapshots.length - 1].fetched_at)
                    : null,
                errors: qualitySnapshots
                    .filter(row => row.error_message)
                    .map(row => ({ shop_id: row.shop_id, status: row.status, error_message: row.error_message })),
            },
        };

        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
        await client.query('COMMIT');
        if (process.stdout?.write) process.stdout.write(`${OUTPUT_FILE}\n`);
        return { outputFile: OUTPUT_FILE, result };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

module.exports = { main };

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}
