-- CAPI SaaS Pro - PostgreSQL initialization script
-- Run this file once before starting the API and worker.

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
