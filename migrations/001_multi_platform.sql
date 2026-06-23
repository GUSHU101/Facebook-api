ALTER TABLE pixels
    ADD COLUMN IF NOT EXISTS platform VARCHAR(50) DEFAULT 'facebook';

UPDATE pixels
SET platform = 'facebook'
WHERE platform IS NULL OR platform = '';

ALTER TABLE pixels
    ALTER COLUMN platform SET DEFAULT 'facebook';

CREATE INDEX IF NOT EXISTS idx_pixels_platform
    ON pixels(platform);

CREATE INDEX IF NOT EXISTS idx_event_store_shop_status_id
    ON event_store(shop_id, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_dead_letters_status_id
    ON dead_letters(status, id DESC);
