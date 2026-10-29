-- Resumable multipart uploads (R-35). A session stages one pending manifest
-- file in R2 under uploads/<session id> through a real R2 multipart upload;
-- completed bytes are hash-verified before they are promoted to blobs/<sha256>.
-- Part rows are the durable acknowledgement list a client resumes from.

CREATE TABLE upload_sessions (
  id            TEXT PRIMARY KEY,
  version_id    TEXT NOT NULL,
  site_id       TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  size          INTEGER NOT NULL,
  part_size     INTEGER NOT NULL,
  part_count    INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  r2_upload_id  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active', 'completing', 'completed', 'failed')),
  staged        INTEGER NOT NULL DEFAULT 0,
  content_type  TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX upload_sessions_version ON upload_sessions(version_id, sha256);
CREATE INDEX upload_sessions_expiry ON upload_sessions(expires_at, id);

CREATE TABLE upload_parts (
  session_id   TEXT NOT NULL,
  part_number  INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  etag         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, part_number)
) WITHOUT ROWID;
