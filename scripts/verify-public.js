require('dotenv').config();

const config = require('../src/config');

async function fetchJson(url, timeoutMs = 10_000) {
    const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch (error) {
        throw new Error(`${url} returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok) {
        throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
}

async function main() {
    if (!config.publicBaseUrl) {
        throw new Error('PUBLIC_BASE_URL is required, for example https://pixel.example.com');
    }
    const healthUrl = new URL('/healthz', `${config.publicBaseUrl}/`).toString();
    const readyUrl = new URL('/readyz', `${config.publicBaseUrl}/`).toString();
    const [health, readiness] = await Promise.all([
        fetchJson(healthUrl),
        fetchJson(readyUrl),
    ]);
    if (health.status !== 'ok') throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
    if (readiness.status !== 'ready') throw new Error(`Unexpected readiness response: ${JSON.stringify(readiness)}`);
    console.log(`PASS public HTTPS certificate and runtime readiness: ${config.publicBaseUrl}`);
    console.log(JSON.stringify({ health, readiness }, null, 2));
}

main().catch(error => {
    console.error(`FAIL public verification: ${error.message}`);
    process.exitCode = 1;
});
