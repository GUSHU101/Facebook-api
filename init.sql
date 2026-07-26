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
    shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
    platform VARCHAR(50) DEFAULT 'facebook',
    name VARCHAR(100) NOT NULL,
    pixel_id VARCHAR(64) NOT NULL,
    access_token TEXT NOT NULL,
    quality_access_token TEXT,
    test_event_code VARCHAR(100),
    rate_limit_until TIMESTAMPTZ,
    last_rate_limit_at TIMESTAMPTZ,
    last_usage_pct NUMERIC(5,2),
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_delivery_at TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- A pixel credential can be routed from many shops. Keeping credentials in
-- pixels and bindings here avoids copying tokens for every shop.
CREATE TABLE IF NOT EXISTS shop_pixel_routes (
    id BIGSERIAL PRIMARY KEY,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    pixel_id INTEGER NOT NULL REFERENCES pixels(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (shop_id, pixel_id)
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

-- Durable aliases converge Shopify checkout/order/cart identifiers on one
-- canonical event_id even after Redis restarts or cache eviction.
CREATE TABLE IF NOT EXISTS event_id_aliases (
    id BIGSERIAL PRIMARY KEY,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    event_name VARCHAR(50) NOT NULL,
    alias_type VARCHAR(30) NOT NULL,
    alias_value VARCHAR(255) NOT NULL,
    canonical_event_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (shop_id, event_name, alias_type, alias_value)
);

-- Durable, per-event/per-route delivery ledger. This is the authoritative
-- idempotency boundary; event_store.status is only an aggregate summary.
CREATE TABLE IF NOT EXISTS event_deliveries (
    id BIGSERIAL PRIMARY KEY,
    event_store_id BIGINT NOT NULL REFERENCES event_store(id) ON DELETE CASCADE,
    route_id BIGINT NOT NULL REFERENCES shop_pixel_routes(id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_expires_at TIMESTAMPTZ,
    last_attempt_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    platform_response JSONB,
    error_code VARCHAR(100),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (event_store_id, route_id)
);

-- Defense in depth: even if a future application bug supplies arbitrary IDs,
-- PostgreSQL rejects a delivery that links one shop's event to another shop's
-- route. The normal INSERT already joins on shop_id, so this trigger is a
-- guardrail rather than routing logic.
CREATE OR REPLACE FUNCTION enforce_event_delivery_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM event_store event
        JOIN shop_pixel_routes route ON route.shop_id = event.shop_id
        WHERE event.id = NEW.event_store_id
          AND route.id = NEW.route_id
    ) THEN
        RAISE EXCEPTION 'event delivery tenant mismatch: event_store_id=%, route_id=%',
            NEW.event_store_id, NEW.route_id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'public.event_deliveries'::regclass
          AND tgname = 'trg_event_delivery_tenant'
          AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER trg_event_delivery_tenant
        BEFORE INSERT OR UPDATE OF event_store_id, route_id
        ON event_deliveries
        FOR EACH ROW
        EXECUTE FUNCTION enforce_event_delivery_tenant();
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS dead_letters (
    id BIGSERIAL PRIMARY KEY,
    shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
    failed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    payload TEXT NOT NULL,
    error_reason TEXT,
    status VARCHAR(30) DEFAULT 'FAILED_PERMANENT'
);

CREATE TABLE IF NOT EXISTS meta_quality_snapshots (
    id BIGSERIAL PRIMARY KEY,
    pixel_route_id INTEGER REFERENCES pixels(id) ON DELETE CASCADE,
    shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
    dataset_id VARCHAR(64) NOT NULL,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(30) DEFAULT 'SUCCESS',
    metric_type VARCHAR(100) DEFAULT 'EVENT_MATCH_QUALITY',
    summary_payload JSONB,
    raw_payload JSONB,
    error_message TEXT
);

-- Existing database reconciliation. These statements are intentionally
-- idempotent so this one file can replace incremental migration files. Keep
-- any legacy migration journal intact; operators may still need it for audit.

ALTER TABLE shops
    ADD COLUMN IF NOT EXISTS app_secret TEXT,
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE shops
    ALTER COLUMN app_secret TYPE TEXT,
    ALTER COLUMN status SET DEFAULT 'active';

ALTER TABLE pixels
    ADD COLUMN IF NOT EXISTS platform VARCHAR(50) DEFAULT 'facebook',
    ADD COLUMN IF NOT EXISTS quality_access_token TEXT,
    ADD COLUMN IF NOT EXISTS test_event_code VARCHAR(100),
    ADD COLUMN IF NOT EXISTS rate_limit_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_rate_limit_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_usage_pct NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_delivery_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE pixels
    ALTER COLUMN shop_id DROP NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.pixels'::regclass
          AND conname = 'pixels_shop_id_fkey'
          AND pg_get_constraintdef(oid) NOT LIKE '%ON DELETE SET NULL%'
    ) THEN
        ALTER TABLE pixels DROP CONSTRAINT pixels_shop_id_fkey;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.pixels'::regclass
          AND conname = 'pixels_shop_id_fkey'
    ) THEN
        ALTER TABLE pixels
            ADD CONSTRAINT pixels_shop_id_fkey
            FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL;
    END IF;
END
$$;

UPDATE pixels
SET platform = 'facebook'
WHERE platform IS NULL OR platform = '';

ALTER TABLE pixels
    ALTER COLUMN platform SET DEFAULT 'facebook';

INSERT INTO shop_pixel_routes (shop_id, pixel_id)
SELECT p.shop_id, p.id
FROM pixels p
WHERE p.shop_id IS NOT NULL
ON CONFLICT (shop_id, pixel_id) DO NOTHING;

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

-- High-churn outbox tables need substantially earlier vacuum/analyze than the
-- PostgreSQL defaults once they contain millions of rows.
ALTER TABLE event_store SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_analyze_scale_factor = 0.01,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_threshold = 1000
);

ALTER TABLE event_deliveries SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_analyze_scale_factor = 0.01,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_threshold = 1000
);

ALTER TABLE event_id_aliases SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_threshold = 1000
);

-- Old releases used the same index name for an md5(event_id) expression. Only
-- replace that legacy definition once; repeatedly dropping this index would
-- take an avoidable write lock on a large event table during every deploy.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_event_dedupe'
          AND indexdef NOT LIKE '%(shop_id, event_name, event_id)%'
    ) THEN
        DROP INDEX public.idx_event_dedupe;
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_dedupe
    ON event_store(shop_id, event_name, event_id);

CREATE INDEX IF NOT EXISTS idx_shops_status
    ON shops(status);

CREATE INDEX IF NOT EXISTS idx_pixels_shop_id
    ON pixels(shop_id);

CREATE INDEX IF NOT EXISTS idx_pixels_rate_limit_until
    ON pixels(rate_limit_until)
    WHERE rate_limit_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shop_pixel_routes_shop_status
    ON shop_pixel_routes(shop_id, status, id);

CREATE INDEX IF NOT EXISTS idx_shop_pixel_routes_pixel
    ON shop_pixel_routes(pixel_id);

CREATE INDEX IF NOT EXISTS idx_event_store_shop_status_id
    ON event_store(shop_id, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_event_id_aliases_canonical
    ON event_id_aliases(shop_id, event_name, canonical_event_id);

CREATE INDEX IF NOT EXISTS idx_event_deliveries_ready
    ON event_deliveries(status, next_attempt_at, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_event_deliveries_event
    ON event_deliveries(event_store_id, status);

CREATE INDEX IF NOT EXISTS idx_event_deliveries_route
    ON event_deliveries(route_id, status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_dead_letters_status_id
    ON dead_letters(status, id DESC);

CREATE INDEX IF NOT EXISTS idx_meta_quality_snapshots_route_time
    ON meta_quality_snapshots(pixel_route_id, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_meta_quality_snapshots_shop_time
    ON meta_quality_snapshots(shop_id, fetched_at DESC);

COMMIT;
