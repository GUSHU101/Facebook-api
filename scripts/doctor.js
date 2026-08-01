require('dotenv').config();

const { Pool } = require('pg');
const Redis = require('ioredis');
const config = require('../src/config');
const { credentialFingerprint, decryptTokenIfPossible } = require('../src/utils/crypto');

const checks = [];
const runtimeTables = ['shops', 'pixels', 'shop_pixel_routes', 'event_store', 'shopify_webhook_inbox', 'shopify_privacy_inbox', 'shopify_reconcile_state', 'shopify_webhook_subscription_state', 'shopify_pixel_runtime_status', 'browser_delivery_diagnostics', 'event_id_aliases', 'event_deliveries', 'dead_letters', 'meta_quality_snapshots'];
const runtimeSequences = [
    'shops_id_seq',
    'pixels_id_seq',
    'shop_pixel_routes_id_seq',
    'event_store_id_seq',
    'shopify_webhook_inbox_id_seq',
    'shopify_privacy_inbox_id_seq',
    'browser_delivery_diagnostics_id_seq',
    'event_id_aliases_id_seq',
    'event_deliveries_id_seq',
    'dead_letters_id_seq',
    'meta_quality_snapshots_id_seq',
];

async function check(name, fn) {
    try {
        const detail = await fn();
        checks.push({ name, ok: true, detail });
    } catch (error) {
        checks.push({ name, ok: false, detail: error.message });
    }
}

async function main() {
    const pool = new Pool({
        connectionString: config.databaseUrl,
        options: '-c timezone=UTC',
    });
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
    redis.on('error', () => {});

    await check('environment', async () => {
        const required = [
            'DATABASE_URL',
            'REDIS_URL',
            'AES_SECRET_KEY',
            'ADMIN_USERNAME',
            'ADMIN_PASSWORD',
        ];
        const missing = required.filter(name => !process.env[name]);
        if (missing.length) throw new Error(`Missing ${missing.join(', ')}`);
        if (String(process.env.AES_SECRET_KEY).length < 32) {
            throw new Error('AES_SECRET_KEY should be at least 32 characters');
        }
        if (String(process.env.ADMIN_PASSWORD).length < 16) {
            throw new Error('ADMIN_PASSWORD should be at least 16 characters');
        }
        if (process.env.ADMIN_PASSWORD === process.env.ADMIN_USERNAME) {
            throw new Error('ADMIN_PASSWORD must differ from ADMIN_USERNAME');
        }
        if (!config.requireIngestToken) {
            throw new Error('REQUIRE_INGEST_TOKEN must remain enabled in production');
        }
        if (process.env.NODE_ENV === 'production' && !process.env.INGEST_TOKEN_SECRET) {
            throw new Error('INGEST_TOKEN_SECRET must be set separately from AES_SECRET_KEY in production');
        }
        return 'required variables present and public token secret is separated in production';
    });

    await check('postgres connection', async () => {
        await pool.query('SELECT 1');
        return 'connected';
    });

    await check('postgres schema', async () => {
        const requiredColumns = [
            ['shops', 'shop_domain'],
            ['shops', 'app_secret'],
            ['shops', 'admin_access_token'],
            ['shops', 'reporting_timezone'],
            ['pixels', 'platform'],
            ['pixels', 'access_token'],
            ['pixels', 'credential_scope'],
            ['pixels', 'credential_version'],
            ['pixels', 'rate_limit_group'],
            ['pixels', 'rate_limit_until'],
            ['pixels', 'consecutive_failures'],
            ['shop_pixel_routes', 'shop_id'],
            ['shop_pixel_routes', 'pixel_id'],
            ['shop_pixel_routes', 'test_event_code'],
            ['shop_pixel_routes', 'test_event_code_expires_at'],
            ['event_store', 'request_payload'],
            ['event_store', 'fb_response'],
            ['shopify_webhook_inbox', 'webhook_id'],
            ['shopify_webhook_inbox', 'status'],
            ['shopify_webhook_inbox', 'shopify_api_version'],
            ['shopify_privacy_inbox', 'shop_domain_hash'],
            ['shopify_privacy_inbox', 'payload_digest'],
            ['shopify_privacy_inbox', 'status'],
            ['shopify_reconcile_state', 'last_successful_at'],
            ['shopify_reconcile_state', 'after_cursor'],
            ['shopify_webhook_subscription_state', 'status'],
            ['shopify_webhook_subscription_state', 'last_checked_at'],
            ['shopify_pixel_runtime_status', 'source_version'],
            ['shopify_pixel_runtime_status', 'last_seen_at'],
            ['browser_delivery_diagnostics', 'code'],
            ['browser_delivery_diagnostics', 'event_counts'],
            ['event_id_aliases', 'canonical_event_id'],
            ['event_deliveries', 'route_id'],
            ['event_deliveries', 'status'],
            ['dead_letters', 'status'],
        ];

        for (const [table, column] of requiredColumns) {
            const { rowCount } = await pool.query(
                `SELECT 1
                 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = $1
                   AND column_name = $2`,
                [table, column],
            );
            if (rowCount === 0) throw new Error(`Missing column ${table}.${column}`);
        }

        const secretType = await pool.query(
            `SELECT data_type
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'shops'
               AND column_name = 'app_secret'`,
        );
        if (secretType.rows[0]?.data_type !== 'text') {
            throw new Error('shops.app_secret should be TEXT; run npm run migrate');
        }
        return 'required columns present';
    });

    await check('encrypted credential key', async () => {
        const sources = [
            ['shop', 'shops', 'app_secret'],
            ['shop_admin', 'shops', 'admin_access_token'],
            ['pixel', 'pixels', 'access_token'],
        ];
        let checked = 0;
        for (const [kind, table, field] of sources) {
            let afterId = 0;
            while (true) {
                // Identifiers come only from the static allowlist above.
                const { rows } = await pool.query(
                    `SELECT id, ${field} AS encrypted_value
                     FROM ${table}
                     WHERE id > $1 AND ${field} IS NOT NULL AND ${field} <> ''
                     ORDER BY id
                     LIMIT 500`,
                    [afterId],
                );
                for (const row of rows) {
                    try {
                        decryptTokenIfPossible(row.encrypted_value);
                    } catch (error) {
                        throw new Error(`${kind} credential ${row.id} cannot be decrypted with AES_SECRET_KEY`);
                    }
                    checked += 1;
                    afterId = Number(row.id);
                }
                if (rows.length < 500) break;
            }
        }
        return `${checked} stored credentials decrypt successfully`;
    });

    await check('tenant delivery isolation', async () => {
        const { rows: [result] } = await pool.query(
            `SELECT COUNT(*)::int AS violations
             FROM event_deliveries delivery
             JOIN event_store event ON event.id = delivery.event_store_id
             JOIN shop_pixel_routes route ON route.id = delivery.route_id
             WHERE event.shop_id <> route.shop_id`,
        );
        if (Number(result.violations) > 0) {
            throw new Error(`${result.violations} delivery rows cross shop ownership boundaries`);
        }
        return 'event_store.shop_id matches every delivery route shop_id';
    });

    await check('production test-event routes', async () => {
        const { rows: [result] } = await pool.query(
            `SELECT COUNT(*) FILTER (
                        WHERE test_event_code IS NOT NULL
                          AND test_event_code_expires_at > NOW()
                    )::int AS active,
                    COUNT(*) FILTER (
                        WHERE test_event_code IS NOT NULL
                          AND (test_event_code_expires_at IS NULL OR test_event_code_expires_at <= NOW())
                    )::int AS expired
             FROM shop_pixel_routes
             WHERE status = 'active'`,
        );
        if (process.env.NODE_ENV === 'production' && Number(result.active) > 0) {
            throw new Error(`${result.active} active delivery routes are still using a diagnostic test event code`);
        }
        return `${result.active} active and ${result.expired} expired test-event routes; TTL ${config.testEventCodeTtlMinutes} minutes`;
    });

    await check('routing state integrity', async () => {
        const { rows: [result] } = await pool.query(
            `SELECT
                 COUNT(*) FILTER (
                     WHERE route.status <> 'active'
                       AND delivery.status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')
                 )::int AS inactive_outstanding,
                 (
                     SELECT COUNT(*)::int
                     FROM event_store event
                     WHERE event.status = 'PENDING'
                       AND NOT EXISTS (
                           SELECT 1
                           FROM shop_pixel_routes active_route
                           WHERE active_route.shop_id = event.shop_id
                             AND active_route.status = 'active'
                       )
                 ) AS unrouted_pending
             FROM event_deliveries delivery
             JOIN shop_pixel_routes route ON route.id = delivery.route_id`,
        );
        if (Number(result.inactive_outstanding) > 0) {
            throw new Error(`${result.inactive_outstanding} outstanding deliveries belong to inactive routes`);
        }
        if (Number(result.unrouted_pending) > 0) {
            throw new Error(`${result.unrouted_pending} pending events are safely retained but need an active Pixel route`);
        }
        return 'no inactive outstanding deliveries or unrouted pending events';
    });

    await check('Shopify webhook inbox', async () => {
        const { rows: [result] } = await pool.query(
            `SELECT
                 COUNT(*) FILTER (WHERE status = 'FAILED_PERMANENT')::int AS permanent_failed,
                 COUNT(*) FILTER (
                     WHERE status = 'PROCESSING' AND lease_expires_at < NOW()
                 )::int AS expired_leases,
                 COUNT(*) FILTER (
                     WHERE status IN ('PENDING', 'RETRYABLE_FAILED') AND next_attempt_at <= NOW()
                 )::int AS due
             FROM shopify_webhook_inbox`,
        );
        if (Number(result.permanent_failed) > 0) {
            throw new Error(`${result.permanent_failed} paid-order webhooks failed permanently and require investigation`);
        }
        return `${result.due} paid-order webhooks due; ${result.expired_leases} expired leases are safely reclaimable`;
    });

    await check('Shopify webhook API version', async () => {
        const { rows: [result] } = await pool.query(
            `SELECT COUNT(*) FILTER (
                        WHERE shopify_api_version IS NOT NULL
                          AND shopify_api_version <> $1
                    )::int AS mismatched,
                    COUNT(*) FILTER (WHERE shopify_api_version IS NULL)::int AS unknown
             FROM shopify_webhook_inbox
             WHERE created_at >= NOW() - INTERVAL '7 days'`,
            [config.shopifyApiVersion],
        );
        if (Number(result.mismatched) > 0) {
            throw new Error(
                `${result.mismatched} recent webhooks were not generated by configured Shopify API ${config.shopifyApiVersion}`,
            );
        }
        return `configured ${config.shopifyApiVersion}; ${result.unknown} recent legacy deliveries have no version header`;
    });

    await check('Shopify paid-order reconciliation', async () => {
        const { rows } = await pool.query(
            `SELECT shop.shop_domain, state.last_error
             FROM shops shop
             JOIN shopify_reconcile_state state ON state.shop_id = shop.id
             WHERE shop.admin_access_token IS NOT NULL
               AND shop.admin_access_token <> ''
               AND state.last_error IS NOT NULL
             ORDER BY state.updated_at DESC
             LIMIT 10`,
        );
        if (rows.length > 0) {
            throw new Error(rows.map(row => `${row.shop_domain}: ${row.last_error}`).join(' | '));
        }
        return 'configured reconciliation jobs have no recorded GraphQL errors';
    });

    await check('Shopify ORDERS_PAID subscription audit', async () => {
        const { rows } = await pool.query(
            `SELECT shop.shop_domain, state.status, state.last_error
             FROM shopify_webhook_subscription_state state
             JOIN shops shop ON shop.id = state.shop_id
             WHERE state.last_checked_at >= NOW() - INTERVAL '2 days'
               AND state.status NOT IN ('HEALTHY', 'HEALTHY_WITH_ALTERNATES')
             ORDER BY state.last_checked_at DESC
             LIMIT 10`,
        );
        if (rows.length > 0) {
            throw new Error(rows.map(row => `${row.shop_domain}: ${row.status}${row.last_error ? ` (${row.last_error})` : ''}`).join(' | '));
        }
        return `no unhealthy fresh ORDERS_PAID subscription audits; scheduled by ${config.shopifyWebhookAuditCron}`;
    });

    await check('browser delivery-loss diagnostics', async () => {
        const { rows: [result] } = await pool.query(
            `SELECT COUNT(*)::int AS incidents,
                    COALESCE(SUM(dropped_count), 0)::int AS affected
             FROM browser_delivery_diagnostics
             WHERE created_at >= NOW() - INTERVAL '24 hours'`,
        );
        if (Number(result.incidents) > 0) {
            return `self-reported warning: ${result.incidents} browser delivery-loss diagnostics affected ${result.affected} events in the last 24 hours; correlate with durable ingestion and route ledgers`;
        }
        return 'no client-reported browser queue/storage/retry/permanent-rejection loss in the last 24 hours';
    });

    await check('Shopify privacy inbox', async () => {
        const { rows: [result] } = await pool.query(
            `SELECT
                 COUNT(*) FILTER (WHERE status = 'FAILED_PERMANENT')::int AS permanent_failed,
                 COUNT(*) FILTER (WHERE status = 'ACTION_REQUIRED')::int AS action_required,
                 COUNT(*) FILTER (
                     WHERE status = 'PROCESSING' AND lease_expires_at < NOW()
                 )::int AS expired_leases,
                 COUNT(*) FILTER (
                     WHERE status IN ('PENDING', 'RETRYABLE_FAILED') AND next_attempt_at <= NOW()
                 )::int AS due
             FROM shopify_privacy_inbox`,
        );
        if (Number(result.permanent_failed) > 0) {
            throw new Error(`${result.permanent_failed} privacy webhooks failed permanently and require immediate investigation`);
        }
        return `${result.action_required} data requests require action; ${result.due} jobs due; ${result.expired_leases} expired leases reclaimable`;
    });

    await check('event aggregate consistency', async () => {
        const { rows: [result] } = await pool.query(
            `WITH delivery_summary AS (
                 SELECT event_store_id,
                        COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE status = 'SUCCESS') AS succeeded,
                        COUNT(*) FILTER (WHERE status = 'FAILED_PERMANENT') AS permanent_failed,
                        COUNT(*) FILTER (
                            WHERE status IN ('PENDING', 'IN_PROGRESS', 'RETRYABLE_FAILED')
                        ) AS outstanding
                 FROM event_deliveries
                 GROUP BY event_store_id
             ),
             expected AS (
                 SELECT event_store_id,
                        CASE
                            WHEN total > 0 AND succeeded = total THEN 'SUCCESS'
                            WHEN outstanding > 0 THEN 'PENDING'
                            WHEN succeeded > 0 AND permanent_failed > 0 THEN 'PARTIAL_FAILED'
                            WHEN permanent_failed = total THEN 'FAILED'
                        END AS status
                 FROM delivery_summary
             )
             SELECT COUNT(*)::int AS mismatches
             FROM expected
             JOIN event_store event ON event.id = expected.event_store_id
             WHERE expected.status IS NOT NULL
               AND event.status IS DISTINCT FROM expected.status
               AND NOT EXISTS (
                   SELECT 1
                   FROM shop_pixel_routes route
                   WHERE route.shop_id = event.shop_id
                     AND route.status = 'active'
                     AND NOT EXISTS (
                         SELECT 1
                         FROM event_deliveries missing
                         WHERE missing.event_store_id = event.id
                           AND missing.route_id = route.id
                     )
               )`,
        );
        if (Number(result.mismatches) > 0) {
            throw new Error(`${result.mismatches} event aggregate statuses disagree with the delivery ledger`);
        }
        return 'event_store status agrees with per-route delivery ledger';
    });

    await check('shared pixel credential identity', async () => {
        const { rows } = await pool.query(
            `SELECT platform, pixel_id, COUNT(*)::int AS credentials
             FROM pixels
             GROUP BY platform, pixel_id
             HAVING COUNT(*) > 1
             ORDER BY credentials DESC, platform, pixel_id
             LIMIT 20`,
        );
        if (rows.length > 0) {
            const examples = rows.map(row => `${row.platform}:${row.pixel_id} (${row.credentials})`).join(', ');
            throw new Error(`Duplicate external pixel credentials would bypass shared cooldown/leases: ${examples}`);
        }
        return 'each external platform/pixel identity has one shared credential row';
    });

    await check('Meta Dataset shop isolation', async () => {
        if (config.allowSharedFacebookDatasetRoutes) {
            return 'shared Meta Dataset routes are explicitly enabled by configuration';
        }
        const { rows } = await pool.query(
            `SELECT pixel.name, pixel.pixel_id, COUNT(DISTINCT route.shop_id)::int AS shops
             FROM pixels pixel
             JOIN shop_pixel_routes route ON route.pixel_id = pixel.id
             WHERE pixel.platform = 'facebook'
               AND pixel.status = 'active'
               AND route.status = 'active'
             GROUP BY pixel.id, pixel.name, pixel.pixel_id
             HAVING COUNT(DISTINCT route.shop_id) > 1
             ORDER BY shops DESC
             LIMIT 20`,
        );
        if (rows.length > 0) {
            throw new Error(rows.map(row => `${row.name || row.pixel_id}: ${row.shops} shops`).join(', '));
        }
        return 'every active Meta Dataset is isolated to one Shopify shop';
    });

    await check('postgres scale indexes', async () => {
        const required = [
            'idx_event_store_pending_shop_time',
            'idx_event_store_retention_all_terminal',
            'idx_event_store_timestamp_brin',
            'idx_event_id_aliases_updated',
            'idx_dead_letters_failed_at',
            'idx_meta_quality_snapshots_retention',
            'idx_shopify_webhook_inbox_due',
            'idx_shopify_webhook_inbox_retention',
            'idx_shopify_privacy_inbox_due',
            'idx_shopify_privacy_inbox_action',
            'idx_shopify_privacy_inbox_retention',
            'idx_browser_delivery_diagnostics_retention',
            'idx_shopify_webhook_subscription_checked',
            'idx_pixels_platform_external_id',
            'idx_pixels_credential_scope',
        ];
        const { rows } = await pool.query(
            `SELECT index_class.relname AS index_name,
                    index_meta.indisvalid,
                    index_meta.indisunique,
                    pg_get_indexdef(index_meta.indexrelid) AS definition
             FROM pg_index index_meta
             JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
             JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
             WHERE namespace.nspname = 'public'
               AND index_class.relname = ANY($1::text[])`,
            [required],
        );
        const valid = new Set(rows.filter(row => row.indisvalid).map(row => row.index_name));
        const missing = required.filter(name => !valid.has(name));
        if (missing.length > 0) throw new Error(`Missing/invalid scale indexes: ${missing.join(', ')}; rerun npm run migrate`);
        const pixelIdentity = rows.find(row => row.index_name === 'idx_pixels_platform_external_id');
        if (!pixelIdentity?.indisunique || !/\(platform, pixel_id\)\s*$/i.test(pixelIdentity.definition || '')) {
            throw new Error('Pixel identity index must be UNIQUE on exactly (platform, pixel_id); rerun npm run migrate');
        }
        return `${valid.size} online scale indexes valid`;
    });

    await check('persistent credential throttle scopes', async () => {
        const { rows: [result] } = await pool.query(
            `SELECT COUNT(*)::int AS missing
             FROM pixels
             WHERE status = 'active'
               AND (credential_scope IS NULL OR credential_scope = '')`,
        );
        if (Number(result.missing) > 0) {
            throw new Error(`${result.missing} pixel credentials have no persisted throttle scope; rerun npm run migrate`);
        }
        let afterId = 0;
        let checked = 0;
        while (true) {
            const { rows } = await pool.query(
                `SELECT id, platform, access_token, rate_limit_group, credential_scope
                 FROM pixels
                 WHERE id > $1
                   AND status = 'active'
                 ORDER BY id
                 LIMIT 500`,
                [afterId],
            );
            for (const row of rows) {
                const expected = credentialFingerprint(
                    row.platform,
                    decryptTokenIfPossible(row.access_token),
                    row.rate_limit_group,
                );
                if (row.credential_scope !== expected) {
                    throw new Error(`Pixel ${row.id} throttle scope disagrees with its platform/token/group; update the credential or rerun migration`);
                }
                checked += 1;
                afterId = Number(row.id);
            }
            if (rows.length < 500) break;
        }
        return `${checked} platform credentials retain a restart-safe throttle scope`;
    });

    await check('postgres autovacuum', async () => {
        const { rows: [setting] } = await pool.query('SHOW autovacuum');
        if (String(setting.autovacuum).toLowerCase() !== 'on') {
            throw new Error('autovacuum must be enabled for bounded-retention tables');
        }
        return 'enabled';
    });

    await check('storage footprint', async () => {
        const { rows: [result] } = await pool.query(
            `SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size,
                    pg_size_pretty(
                        pg_total_relation_size('event_store'::regclass)
                        + pg_total_relation_size('event_deliveries'::regclass)
                        + pg_total_relation_size('event_id_aliases'::regclass)
                    ) AS event_ledger_size,
                    pg_size_pretty(
                        pg_total_relation_size('shopify_webhook_inbox'::regclass)
                        + pg_total_relation_size('shopify_privacy_inbox'::regclass)
                    ) AS webhook_inbox_size`,
        );
        return `database ${result.database_size}; event ledger ${result.event_ledger_size}; webhook inbox ${result.webhook_inbox_size}`;
    });

    await check('postgres privileges', async () => {
        const { rows: [identity] } = await pool.query('SELECT current_user, current_database()');
        const user = identity.current_user;
        const database = identity.current_database;

        const schemaPrivileges = await pool.query(
            `SELECT
                has_schema_privilege(current_user, 'public', 'USAGE') AS usage,
                has_schema_privilege(current_user, 'public', 'CREATE') AS create`,
        );
        if (!schemaPrivileges.rows[0].usage || !schemaPrivileges.rows[0].create) {
            throw new Error(`Database user ${user} needs USAGE and CREATE on schema public in ${database}`);
        }

        const ownedRelations = [...runtimeTables, ...runtimeSequences];
        const { rows: wrongOwners } = await pool.query(
            `SELECT relation.relname AS relation_name,
                    pg_get_userbyid(relation.relowner) AS owner
             FROM pg_class relation
             JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND relation.relname = ANY($1::text[])
               AND relation.relowner <> (SELECT usesysid FROM pg_user WHERE usename = current_user)
             ORDER BY relation.relname`,
            [ownedRelations],
        );
        if (wrongOwners.length > 0) {
            const examples = wrongOwners
                .slice(0, 5)
                .map(row => `${row.relation_name} (owner=${row.owner})`)
                .join(', ');
            throw new Error(
                `Database user ${user} must own project tables and sequences for safe migrations; `
                + `wrong owners: ${examples}. Run sudo bash scripts/repair-db-ownership.sh`,
            );
        }

        const tablePrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
        for (const table of runtimeTables) {
            const privilegeChecks = tablePrivileges.map(privilege => (
                `has_table_privilege(current_user, 'public.${table}', '${privilege}') AS ${privilege.toLowerCase()}`
            )).join(', ');
            const { rows: [privileges] } = await pool.query(`SELECT ${privilegeChecks}`);
            const missing = tablePrivileges.filter(privilege => !privileges[privilege.toLowerCase()]);
            if (missing.length > 0) {
                throw new Error(`Database user ${user} missing ${missing.join(', ')} on table ${table}`);
            }
        }

        const sequencePrivileges = ['USAGE', 'SELECT', 'UPDATE'];
        for (const sequence of runtimeSequences) {
            const privilegeChecks = sequencePrivileges.map(privilege => (
                `has_sequence_privilege(current_user, 'public.${sequence}', '${privilege}') AS ${privilege.toLowerCase()}`
            )).join(', ');
            const { rows: [privileges] } = await pool.query(`SELECT ${privilegeChecks}`);
            const missing = sequencePrivileges.filter(privilege => !privileges[privilege.toLowerCase()]);
            if (missing.length > 0) {
                throw new Error(`Database user ${user} missing ${missing.join(', ')} on sequence ${sequence}`);
            }
        }

        return `user=${user}, database=${database}, tables=${runtimeTables.length}, sequences=${runtimeSequences.length}`;
    });

    await check('redis connection', async () => {
        const pong = await redis.ping();
        if (pong !== 'PONG') throw new Error(`Unexpected ping response: ${pong}`);
        return 'connected';
    });

    await check('redis eviction policy', async () => {
        try {
            const result = await redis.config('GET', 'maxmemory-policy');
            const policy = Array.isArray(result) ? result[1] : undefined;
            if (policy && policy !== 'noeviction') {
                throw new Error(`maxmemory-policy=${policy}; BullMQ requires noeviction to protect queue keys`);
            }
            return `maxmemory-policy=${policy || 'unknown'}`;
        } catch (error) {
            if (/NOPERM|unknown command/i.test(error.message)) return 'CONFIG unavailable; verify noeviction in provider console';
            throw error;
        }
    });

    await check('queue config', async () => {
        if (config.workerConcurrency < 1) throw new Error('WORKER_CONCURRENCY must be positive');
        if (config.batchSize < 1) throw new Error('BATCH_SIZE must be positive');
        if (config.workerEventBatchSize < 1) throw new Error('WORKER_EVENT_BATCH_SIZE must be positive');
        if (config.aggregateReconcileBatchSize < 1) throw new Error('AGGREGATE_RECONCILE_BATCH_SIZE must be positive');
        if (config.httpHeadersTimeoutMs <= config.httpKeepAliveTimeoutMs) {
            throw new Error('HTTP_HEADERS_TIMEOUT_MS must exceed HTTP_KEEP_ALIVE_TIMEOUT_MS');
        }
        if (config.httpRequestTimeoutMs < config.httpHeadersTimeoutMs) {
            throw new Error('HTTP_REQUEST_TIMEOUT_MS must be at least HTTP_HEADERS_TIMEOUT_MS');
        }
        if (config.shutdownTimeoutMs <= config.httpRequestTimeoutMs) {
            throw new Error('SHUTDOWN_TIMEOUT_MS must exceed HTTP_REQUEST_TIMEOUT_MS');
        }
        if (config.facebookBatchSize > 1000) throw new Error('FACEBOOK_BATCH_SIZE must not exceed 1000');
        if (config.deliveryRescueMinutes < 1) throw new Error('DELIVERY_RESCUE_MINUTES must be positive');
        if (config.aliasRetentionDays < 30) throw new Error('ALIAS_RETENTION_DAYS must be at least 30');
        return `legacy_drain=${config.legacyRedisDrainEnabled}, pack_batch=${config.batchSize}, worker_batch=${config.workerEventBatchSize}, concurrency=${config.workerConcurrency}, rescue_after=${config.deliveryRescueMinutes}m`;
    });

    await redis.quit();
    await pool.end();

    for (const item of checks) {
        console.log(`${item.ok ? 'OK' : 'FAIL'} ${item.name}: ${item.detail}`);
    }

    if (checks.some(item => !item.ok)) process.exit(1);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
