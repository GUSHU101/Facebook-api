-- Run outside a transaction so existing high-volume installations keep
-- accepting writes while PostgreSQL builds these hot-path indexes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_store_pending_shop_time
    ON event_store(shop_id, timestamp, id)
    WHERE status = 'PENDING';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_store_retention_all_terminal
    ON event_store(timestamp, id)
    WHERE status IN ('SUCCESS', 'FAILED', 'PARTIAL_FAILED', 'AWAITING_PAYMENT');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_store_timestamp_brin
    ON event_store USING BRIN(timestamp);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_id_aliases_updated
    ON event_id_aliases(updated_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dead_letters_failed_at
    ON dead_letters(failed_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_quality_snapshots_retention
    ON meta_quality_snapshots(fetched_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopify_webhook_inbox_due
    ON shopify_webhook_inbox(next_attempt_at, id)
    WHERE status IN ('PENDING', 'RETRYABLE_FAILED', 'PROCESSING');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopify_webhook_inbox_retention
    ON shopify_webhook_inbox((COALESCE(processed_at, created_at)), id)
    WHERE status IN ('SUCCESS', 'FAILED_PERMANENT');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopify_privacy_inbox_due
    ON shopify_privacy_inbox(next_attempt_at, id)
    WHERE status IN ('PENDING', 'RETRYABLE_FAILED', 'PROCESSING');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopify_privacy_inbox_action
    ON shopify_privacy_inbox(created_at, id)
    WHERE status = 'ACTION_REQUIRED';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopify_privacy_inbox_retention
    ON shopify_privacy_inbox((COALESCE(completed_at, processed_at, created_at)), id)
    WHERE status IN ('SUCCESS', 'FAILED_PERMANENT');

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_pixels_platform_external_id
    ON pixels(platform, pixel_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pixels_credential_scope
    ON pixels(credential_scope)
    WHERE credential_scope IS NOT NULL;

-- Redundant/low-selectivity legacy indexes amplify every high-volume insert
-- and status update. Their useful access paths are covered by the composite,
-- partial, BRIN, or primary-key indexes above.
DROP INDEX CONCURRENTLY IF EXISTS idx_event_store_status;
DROP INDEX CONCURRENTLY IF EXISTS idx_event_store_id_desc;
DROP INDEX CONCURRENTLY IF EXISTS idx_event_store_terminal_retention;
DROP INDEX CONCURRENTLY IF EXISTS idx_pixels_platform;
