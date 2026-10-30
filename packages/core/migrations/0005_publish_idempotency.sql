-- D1 arbitrates concurrent retries across Worker isolates and locations.
-- Keys include the operation and authorization identity, hashed before storage.
CREATE TABLE idempotency_keys (
  key_hash TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  result_json TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idempotency_keys_expires ON idempotency_keys(expires_at);
