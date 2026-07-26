require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('../src/config');
const { credentialFingerprint, decryptTokenIfPossible } = require('../src/utils/crypto');

async function main() {
    const pool = new Pool({
        connectionString: config.databaseUrl,
        options: '-c timezone=UTC',
    });
    const schemaPath = path.join(__dirname, '..', 'init.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const onlineIndexesPath = path.join(__dirname, 'scale-indexes.sql');
    const onlineIndexStatements = fs.readFileSync(onlineIndexesPath, 'utf8')
        .split(';')
        .map(statement => statement.trim())
        .filter(Boolean);

    const client = await pool.connect();
    let migrationLockAcquired = false;
    try {
        const lockResult = await client.query(
            "SELECT pg_try_advisory_lock(hashtext('capi-saas-pro:migrate')) AS acquired",
        );
        migrationLockAcquired = lockResult.rows[0]?.acquired === true;
        if (!migrationLockAcquired) {
            throw new Error('Another schema migration is already running; retry after it completes');
        }
        console.log('Applying unified schema init.sql');
        await client.query(sql);
        console.log('Backfilling stable credential throttle scopes');
        const credentials = await client.query(
            `SELECT id, platform, access_token, rate_limit_group
             FROM pixels
             ORDER BY id`,
        );
        for (const credential of credentials.rows) {
            const token = decryptTokenIfPossible(credential.access_token);
            const scope = credentialFingerprint(credential.platform, token, credential.rate_limit_group);
            if (!scope) throw new Error(`Pixel ${credential.id} has no usable credential scope`);
            await client.query('UPDATE pixels SET credential_scope = $2 WHERE id = $1', [credential.id, scope]);
        }
        console.log('Applying online scale indexes');
        for (const statement of onlineIndexStatements) {
            const indexName = statement.match(
                /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z0-9_]+)/i,
            )?.[1];
            if (indexName) {
                if (indexName === 'idx_pixels_platform_external_id') {
                    const duplicates = await client.query(
                        `SELECT platform, pixel_id, COUNT(*)::int AS credentials
                         FROM pixels
                         GROUP BY platform, pixel_id
                         HAVING COUNT(*) > 1
                         ORDER BY credentials DESC
                         LIMIT 5`,
                    );
                    if (duplicates.rowCount > 0) {
                        const examples = duplicates.rows
                            .map(row => `${row.platform}:${row.pixel_id} (${row.credentials})`)
                            .join(', ');
                        throw new Error(`Duplicate external Pixel credentials must be consolidated before migration: ${examples}`);
                    }
                }
                const validity = await client.query(
                    `SELECT index_meta.indisvalid,
                            index_meta.indisunique,
                            pg_get_indexdef(index_meta.indexrelid) AS definition
                     FROM pg_index index_meta
                     JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
                     JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
                     WHERE namespace.nspname = 'public'
                       AND index_class.relname = $1`,
                    [indexName],
                );
                const existing = validity.rows[0];
                const requiresUnique = /^CREATE\s+UNIQUE\s+INDEX/i.test(statement);
                const wrongPixelIdentityDefinition = indexName === 'idx_pixels_platform_external_id'
                    && !/\(platform, pixel_id\)\s*$/i.test(existing?.definition || '');
                if (existing && (
                    existing.indisvalid !== true
                    || (requiresUnique && existing.indisunique !== true)
                    || wrongPixelIdentityDefinition
                )) {
                    console.warn(`Dropping invalid or obsolete concurrent index ${indexName} before retry`);
                    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public."${indexName}"`);
                }
            }
            await client.query(statement);
        }
        console.log('Database schema is up to date');
    } finally {
        if (migrationLockAcquired) {
            await client.query("SELECT pg_advisory_unlock(hashtext('capi-saas-pro:migrate'))").catch(() => {});
        }
        client.release();
        await pool.end();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
