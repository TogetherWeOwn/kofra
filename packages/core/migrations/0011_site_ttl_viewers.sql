-- R-27c (PUB-16): TTL for keyed sites. Set through update_site_settings
-- (ttlSeconds, null clears); expires_at is recomputed at finalize and when the
-- setting changes, and expired keyed sites go through the normal expiry cleanup.
ALTER TABLE sites ADD COLUMN ttl_seconds INTEGER;

-- R-27c (VIEW-06): per-site viewers switch. 0 serves every file raw and skips
-- viewers; the renderMarkdown setting keeps working when viewers are on.
ALTER TABLE sites ADD COLUMN viewers INTEGER NOT NULL DEFAULT 1;
