-- R-27: parsed _redirects/_headers per version, and keyed-site lifetime settings.
ALTER TABLE versions ADD COLUMN config_json TEXT;
ALTER TABLE sites ADD COLUMN noindex INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN viewers INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sites ADD COLUMN ttl_seconds INTEGER;
