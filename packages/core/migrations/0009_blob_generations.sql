-- Hashes remain the public/deduplication identity; physical objects are never
-- overwritten or reused. NULL retains the pre-migration blobs/<sha256> key.
ALTER TABLE blobs ADD COLUMN storage_key TEXT;

-- A writer may attach its object only while this reservation still exists.
-- GC removes it transactionally before deleting an unattached object.
CREATE TABLE blob_uploads (
  storage_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX blob_uploads_created ON blob_uploads(created_at);

-- Persist a bounded R2 inventory scan across hourly runs, including objects
-- left by a crash after R2.put or a failed R2.delete.
CREATE TABLE blob_gc_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT
);
INSERT INTO blob_gc_cursor (id, cursor) VALUES (1, NULL);
