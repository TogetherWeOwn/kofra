-- R-27a (SRV-12): per-site crawler opt-out. Anonymous and expiring
-- sites are always noindex (serving derives that from tenant_id/expires_at);
-- this flag lets any other site opt out too.
ALTER TABLE sites ADD COLUMN noindex INTEGER NOT NULL DEFAULT 0;
