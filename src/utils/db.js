const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
    connectionString: config.databaseUrl,
    max: Number(process.env.DB_POOL_MAX || 20),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
});

pool.on('error', error => {
    console.error('Unexpected PostgreSQL pool error:', error);
});

module.exports = pool;
