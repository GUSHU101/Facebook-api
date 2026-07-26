const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: config.dbIdleTimeoutMs,
    connectionTimeoutMillis: config.dbConnectionTimeoutMs,
    statement_timeout: config.dbStatementTimeoutMs,
    query_timeout: config.dbStatementTimeoutMs + 5000,
    maxUses: config.dbPoolMaxUses,
    keepAlive: true,
    application_name: 'capi-saas-pro',
    // The schema contains legacy TIMESTAMP columns. Pin every application
    // session to UTC so retention, retry and lease comparisons remain stable
    // regardless of the VPS or PostgreSQL server timezone.
    options: '-c timezone=UTC',
});

pool.on('error', error => {
    console.error('Unexpected PostgreSQL pool error:', error);
});

module.exports = pool;
