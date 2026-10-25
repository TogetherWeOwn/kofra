-- Large replay responses exceed D1's 2 MB value/row limit. Keep the atomic
-- claim and small results in idempotency_keys; large results use bounded rows.
CREATE TABLE idempotency_result_chunks (
  key_hash TEXT NOT NULL REFERENCES idempotency_keys(key_hash) ON DELETE CASCADE,
  owner_token TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (key_hash, owner_token, chunk_index)
);

-- Reclaiming an expired key must also retire the previous owner's payload.
CREATE TRIGGER idempotency_result_chunks_reclaim
AFTER UPDATE OF owner_token ON idempotency_keys
WHEN OLD.owner_token != NEW.owner_token
BEGIN
  DELETE FROM idempotency_result_chunks WHERE key_hash = NEW.key_hash;
END;
