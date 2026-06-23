require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('../src/config');

async function main() {
    const pool = new Pool({ connectionString: config.databaseUrl });
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(file => file.endsWith('.sql'))
        .sort();

    if (files.length === 0) {
        console.log('No migrations found');
        return;
    }

    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename TEXT PRIMARY KEY,
                executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        for (const file of files) {
            const { rowCount } = await client.query(
                'SELECT 1 FROM schema_migrations WHERE filename = $1',
                [file],
            );
            if (rowCount > 0) {
                console.log(`Skipping ${file}`);
                continue;
            }

            console.log(`Applying ${file}`);
            const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        }

        console.log('Migrations complete');
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
