-- Run outside a transaction so existing high-volume installations keep
-- accepting writes while PostgreSQL builds these hot-path indexes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_store_pending_shop_time
    ON event_store(shop_id, timestamp, id)
    WHERE status = 'PENDING';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_store_terminal_retention
    ON event_store(timestamp, id)
    WHERE status IN ('SUCCESS', 'FAILED', 'PARTIAL_FAILED');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_store_timestamp_brin
    ON event_store USING BRIN(timestamp);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_id_aliases_updated
    ON event_id_aliases(updated_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dead_letters_failed_at
    ON dead_letters(failed_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_quality_snapshots_retention
    ON meta_quality_snapshots(fetched_at, id);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_pixels_platform_external_id
    ON pixels(platform, pixel_id);

-- Redundant/low-selectivity legacy indexes amplify every high-volume insert
-- and status update. Their useful access paths are covered by the composite,
-- partial, BRIN, or primary-key indexes above.
DROP INDEX CONCURRENTLY IF EXISTS idx_event_store_status;
DROP INDEX CONCURRENTLY IF EXISTS idx_event_store_id_desc;
DROP INDEX CONCURRENTLY IF EXISTS idx_pixels_platform;
