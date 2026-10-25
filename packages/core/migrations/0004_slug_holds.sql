-- R-59 link permanence: hold freed site names, 308 old names after rename.
-- Times are unix epoch milliseconds. Triggers compare against the SQLite wall
-- clock (strftime('%s','now')*1000); expired rows are ignored everywhere and
-- purged by the hourly cleanup.

-- 1 when the site's current name was explicitly chosen, 0 when generated.
-- Decides the tombstone hold after delete/expiry (chosen vs generated).
-- The permanence-safe default is 1: a pre-existing name's provenance is
-- unknowable, so it gets the long hold; creates set the value explicitly.
ALTER TABLE sites ADD COLUMN slug_chosen INTEGER NOT NULL DEFAULT 1;

-- Old names that 308 to a live site's current name. One row per old name;
-- rename chains resolve through the site's current slug at serve time.
CREATE TABLE slug_redirects (
  slug        TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  chosen      INTEGER NOT NULL DEFAULT 0,
  hold_until  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX slug_redirects_site ON slug_redirects(site_id);

-- Freed names held for their previous tenant (the deleted/expired name itself,
-- plus every old name still redirecting to the site, collapsed here on delete).
-- Deliberately no foreign keys and no UNIQUE on slug: rows outlive their sites,
-- operator-released rows are the audit trail, and every guard below is
-- EXISTS-based, so INSERTs never conflict with each other.
CREATE TABLE slug_tombstones (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL,
  tenant_id       TEXT,
  site_id         TEXT NOT NULL,
  chosen          INTEGER NOT NULL DEFAULT 0,
  hold_until      INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  released_at     INTEGER,
  release_reason  TEXT,
  released_by     TEXT
);
CREATE INDEX slug_tombstones_slug ON slug_tombstones(slug, hold_until);

-- Database fences cover every name acquisition, including races. Same-tenant
-- reclaim passes the tombstone fence; the service deletes the reclaimed rows
-- in the same batch. Anonymous (NULL tenant) creations never reclaim.
CREATE TRIGGER slug_hold_create BEFORE INSERT ON sites
WHEN EXISTS (SELECT 1 FROM slug_tombstones t WHERE t.slug = NEW.slug
  AND t.released_at IS NULL AND t.hold_until > strftime('%s','now')*1000
  AND (NEW.tenant_id IS NULL OR t.tenant_id IS NOT NEW.tenant_id))
BEGIN SELECT RAISE(ABORT, 'slug_name_held'); END;

CREATE TRIGGER slug_redirect_create BEFORE INSERT ON sites
WHEN EXISTS (SELECT 1 FROM slug_redirects r WHERE r.slug = NEW.slug
  AND r.hold_until > strftime('%s','now')*1000)
BEGIN SELECT RAISE(ABORT, 'slug_name_redirect'); END;

CREATE TRIGGER slug_hold_rename BEFORE UPDATE OF slug ON sites
WHEN EXISTS (SELECT 1 FROM slug_tombstones t WHERE t.slug = NEW.slug
  AND t.released_at IS NULL AND t.hold_until > strftime('%s','now')*1000
  AND (NEW.tenant_id IS NULL OR t.tenant_id IS NOT NEW.tenant_id))
BEGIN SELECT RAISE(ABORT, 'slug_name_held'); END;

-- Same-site rename-back passes (the service collapses its own redirect row in
-- the same batch); every other rename to a bound name is refused.
CREATE TRIGGER slug_redirect_rename BEFORE UPDATE OF slug ON sites
WHEN EXISTS (SELECT 1 FROM slug_redirects r WHERE r.slug = NEW.slug
  AND r.hold_until > strftime('%s','now')*1000 AND r.site_id IS NOT NEW.id)
BEGIN SELECT RAISE(ABORT, 'slug_name_redirect'); END;
