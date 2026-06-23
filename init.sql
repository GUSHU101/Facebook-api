-- CAPI SaaS Pro - unified PostgreSQL schema
-- Safe for both first install and existing database upgrades.
-- Re-run this file after pulling new code; it does not delete business data.

BEGIN;

CREATE TABLE IF NOT EXISTS shops (
    id SERIAL PRIMARY KEY,
    shop_domain VARCHAR(255) UNIQUE NOT NULL,
    app_secret TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pixels (
    id SERIAL PRIMARY KEY,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    platform VARCHAR(50) DEFAULT 'facebook',
    name VARCHAR(100) NOT NULL,
    pixel_id VARCHAR(64) NOT NULL,
    access_token TEXT NOT NULL,
    test_event_code VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS event_store (
    id BIGSERIAL PRIMARY KEY,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    event_name VARCHAR(50) NOT NULL,
    event_id VARCHAR(255) NOT NULL,
    status VARCHAR(30) DEFAULT 'PENDING',
    emq_estimate NUMERIC(3,1),
    request_payload JSONB NOT NULL,
    fb_response JSONB
);

CREATE TABLE IF NOT EXISTS dead_letters (
    id BIGSERIAL PRIMARY KEY,
    shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
    failed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    payload TEXT NOT NULL,
    error_reason TEXT,
    status VARCHAR(30) DEFAULT 'FAILED_PERMANENT'
);

-- Existing database reconciliation. These statements are intentionally
-- idempotent so this one file can replace incremental migration files.
DROP TABLE IF EXISTS schema_migrations;

ALTER TABLE shops
    ADD COLUMN IF NOT EXISTS app_secret TEXT,
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE shops
    ALTER COLUMN app_secret TYPE TEXT,
    ALTER COLUMN status SET DEFAULT 'active';

ALTER TABLE pixels
    ADD COLUMN IF NOT EXISTS platform VARCHAR(50) DEFAULT 'facebook',
    ADD COLUMN IF NOT EXISTS test_event_code VARCHAR(100),
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

UPDATE pixels
SET platform = 'facebook'
WHERE platform IS NULL OR platform = '';

ALTER TABLE pixels
    ALTER COLUMN platform SET DEFAULT 'facebook';

ALTER TABLE event_store
    ADD COLUMN IF NOT EXISTS timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS emq_estimate NUMERIC(3,1),
    ADD COLUMN IF NOT EXISTS request_payload JSONB,
    ADD COLUMN IF NOT EXISTS fb_response JSONB;

ALTER TABLE event_store
    ALTER COLUMN status SET DEFAULT 'PENDING';

ALTER TABLE dead_letters
    ADD COLUMN IF NOT EXISTS failed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS error_reason TEXT,
    ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'FAILED_PERMANENT';

ALTER TABLE dead_letters
    ALTER COLUMN status SET DEFAULT 'FAILED_PERMANENT';

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_dedupe
    ON event_store(shop_id, event_name, md5(event_id));

CREATE INDEX IF NOT EXISTS idx_shops_status
    ON shops(status);

CREATE INDEX IF NOT EXISTS idx_pixels_shop_id
    ON pixels(shop_id);

CREATE INDEX IF NOT EXISTS idx_pixels_platform
    ON pixels(platform);

CREATE INDEX IF NOT EXISTS idx_event_store_status
    ON event_store(status);

CREATE INDEX IF NOT EXISTS idx_event_store_shop_status_id
    ON event_store(shop_id, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_event_store_id_desc
    ON event_store(id DESC);

CREATE INDEX IF NOT EXISTS idx_dead_letters_status_id
    ON dead_letters(status, id DESC);

COMMIT;
