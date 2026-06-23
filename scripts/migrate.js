require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('../src/config');

async function main() {
    const pool = new Pool({ connectionString: config.databaseUrl });
    const schemaPath = path.join(__dirname, '..', 'init.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    const client = await pool.connect();
    try {
        console.log('Applying unified schema init.sql');
        await client.query(sql);
        console.log('Database schema is up to date');
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
