-- One row per free try-on. A row for an identity OR a device means the try is spent.
CREATE TABLE IF NOT EXISTS trials (
  id           TEXT PRIMARY KEY,
  identity_key TEXT,               -- 'google:<sub>' or 'email:<addr>'
  email        TEXT,
  device_token TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  started_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trials_identity ON trials(identity_key);
CREATE INDEX IF NOT EXISTS idx_trials_device ON trials(device_token);
