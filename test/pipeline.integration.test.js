const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');

const enabled = process.env.RUN_INTEGRATION_TESTS === '1';

async function waitForReady(url, child) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
        try {
            const response = await fetch(url);
            if (response.status === 200) return;
        } catch (error) {
            // Server socket is not accepting connections yet.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('server did not become ready');
}

async function waitForStatus(url, expectedStatus, child) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
        try {
            const response = await fetch(url);
            if (response.status === expectedStatus) return response;
        } catch (error) {
            // Server socket is not accepting connections yet.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`server did not return HTTP ${expectedStatus}`);
}

test('HTTP webhook replay is durably deduplicated before BullMQ dispatch', { skip: !enabled }, async () => {
    const port = Number(process.env.INTEGRATION_TEST_PORT || 39091);
    const origin = `http://127.0.0.1:${port}`;
    const shopDomain = `integration-${process.pid}.myshopify.com`;
    const appSecret = `integration_webhook_secret_${crypto.randomBytes(16).toString('hex')}`;
    const webhookId = `integration-replay-${crypto.randomUUID()}`;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const server = spawn(process.execPath, ['src/server.js'], {
        cwd: require('node:path').join(__dirname, '..'),
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    server.stdout.on('data', chunk => { diagnostics += chunk.toString(); });
    server.stderr.on('data', chunk => { diagnostics += chunk.toString(); });

    try {
        await waitForReady(`${origin}/readyz`, server);
        const authorization = `Basic ${Buffer.from(
            `${process.env.ADMIN_USERNAME}:${process.env.ADMIN_PASSWORD}`,
        ).toString('base64')}`;
        const shopResponse = await fetch(`${origin}/api/admin/shops`, {
            method: 'POST',
            headers: { Authorization: authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify({ shop_domain: shopDomain, app_secret: appSecret }),
        });
        assert.equal(shopResponse.status, 201, await shopResponse.text());

        const payload = Buffer.from(JSON.stringify({
            id: '90071992547409931234',
            name: '#INTEGRATION',
            source_name: 'web',
            financial_status: 'paid',
            processed_at: new Date().toISOString(),
            total_price: '12.50',
            currency: 'USD',
            line_items: [{ id: '1', variant_id: '2', quantity: 1, price: '12.50' }],
        }));
        const hmac = crypto.createHmac('sha256', appSecret).update(payload).digest('base64');
        const headers = {
            'Content-Type': 'application/json',
            'X-Shopify-Shop-Domain': shopDomain,
            'X-Shopify-Hmac-Sha256': hmac,
            'X-Shopify-Topic': 'orders/paid',
            'X-Shopify-Webhook-Id': webhookId,
            'X-Shopify-Triggered-At': new Date().toISOString(),
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const response = await fetch(`${origin}/api/webhook/orders/paid`, {
                method: 'POST',
                headers,
                body: payload,
            });
            assert.equal(response.status, 200, await response.text());
        }

        const { rows } = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM shopify_webhook_inbox inbox
             JOIN shops shop ON shop.id = inbox.shop_id
             WHERE shop.shop_domain = $1 AND inbox.webhook_id = $2`,
            [shopDomain, webhookId],
        );
        assert.equal(rows[0].count, 1);
    } catch (error) {
        error.message = `${error.message}\nServer diagnostics:\n${diagnostics}`;
        throw error;
    } finally {
        await pool.query(
            `DELETE FROM event_store
             WHERE shop_id IN (SELECT id FROM shops WHERE shop_domain = $1)`,
            [shopDomain],
        ).catch(() => {});
        await pool.query('DELETE FROM shops WHERE shop_domain = $1', [shopDomain]).catch(() => {});
        await pool.end().catch(() => {});
        if (server.exitCode === null) server.kill('SIGTERM');
        await Promise.race([
            new Promise(resolve => server.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
        if (server.exitCode === null) server.kill('SIGKILL');
    }
});

test('database prevents physical Pixel deletion from cascading delivery history', { skip: !enabled }, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const suffix = crypto.randomUUID();
    let shopId;
    let pixelId;
    let routeId;
    let eventId;
    try {
        ({ rows: [{ id: shopId }] } = await pool.query(
            `INSERT INTO shops (shop_domain, app_secret)
             VALUES ($1, 'integration-secret') RETURNING id`,
            [`ledger-${suffix}.myshopify.com`],
        ));
        ({ rows: [{ id: pixelId }] } = await pool.query(
            `INSERT INTO pixels (shop_id, name, pixel_id, access_token)
             VALUES ($1, 'integration', $2, 'token') RETURNING id`,
            [shopId, suffix],
        ));
        ({ rows: [{ id: routeId }] } = await pool.query(
            `INSERT INTO shop_pixel_routes (shop_id, pixel_id)
             VALUES ($1, $2) RETURNING id`,
            [shopId, pixelId],
        ));
        ({ rows: [{ id: eventId }] } = await pool.query(
            `INSERT INTO event_store
                (shop_id, event_name, event_id, request_payload, delivery_route_snapshot)
             VALUES ($1, 'PageView', $2, '{}'::jsonb, ARRAY[$3]::bigint[])
             RETURNING id`,
            [shopId, suffix, routeId],
        ));
        await pool.query(
            'INSERT INTO event_deliveries (event_store_id, route_id) VALUES ($1, $2)',
            [eventId, routeId],
        );
        await assert.rejects(
            pool.query('DELETE FROM pixels WHERE id = $1', [pixelId]),
            error => error?.code === '23503',
        );
        const { rows: [snapshot] } = await pool.query(
            `SELECT delivery_route_snapshot, CARDINALITY(delivery_route_snapshot) AS route_count
             FROM event_store WHERE id = $1`,
            [eventId],
        );
        assert.deepEqual(snapshot.delivery_route_snapshot.map(String), [String(routeId)]);
        assert.equal(snapshot.route_count, 1);
    } finally {
        if (eventId) await pool.query('DELETE FROM event_store WHERE id = $1', [eventId]).catch(() => {});
        if (routeId) await pool.query('DELETE FROM shop_pixel_routes WHERE id = $1', [routeId]).catch(() => {});
        if (pixelId) await pool.query('DELETE FROM pixels WHERE id = $1', [pixelId]).catch(() => {});
        if (shopId) await pool.query('DELETE FROM shops WHERE id = $1', [shopId]).catch(() => {});
        await pool.end().catch(() => {});
    }
});

test('Redis outage keeps liveness green but makes readiness fail closed', { skip: !enabled }, async () => {
    const port = Number(process.env.INTEGRATION_DEGRADED_PORT || 39092);
    const server = spawn(process.execPath, ['src/server.js'], {
        cwd: require('node:path').join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(port),
            REDIS_URL: 'redis://127.0.0.1:1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    server.stdout.on('data', chunk => { diagnostics += chunk.toString(); });
    server.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
    try {
        const health = await waitForStatus(`http://127.0.0.1:${port}/healthz`, 200, server);
        assert.equal((await health.json()).status, 'ok');
        const readiness = await waitForStatus(`http://127.0.0.1:${port}/readyz`, 503, server);
        const body = await readiness.json();
        assert.equal(body.status, 'degraded');
        assert.equal(body.postgres, 'ready');
        assert.equal(body.redis, 'degraded');
        assert.equal(body.immediate_dispatch, false);
    } catch (error) {
        error.message = `${error.message}\nServer diagnostics:\n${diagnostics}`;
        throw error;
    } finally {
        if (server.exitCode === null) server.kill('SIGTERM');
        await Promise.race([
            new Promise(resolve => server.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
        if (server.exitCode === null) server.kill('SIGKILL');
    }
});
