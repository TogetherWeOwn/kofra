-- One unfinished upload per pending file, including concurrent POSTs.
-- Expired sessions retain ownership until cleanup has confirmed R2 removal.
CREATE UNIQUE INDEX upload_sessions_one_unfinished
  ON upload_sessions(version_id, sha256)
  WHERE status IN ('active', 'completing');
