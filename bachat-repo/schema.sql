-- Cloudflare D1 Schema for Samuha Bachat (समूह बचत)
-- Accounting logic remains 100% in accounting.js; D1 stores versioned atomic state,
-- hashed credentials, immutable month snapshots, chat messages, and push subscriptions.

CREATE TABLE IF NOT EXISTS system_secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_state (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_credentials (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,           -- 'admin' | 'admin_ro' | 'member'
  username TEXT,
  mobile TEXT,
  member_id TEXT,
  name TEXT,
  secret_hash TEXT NOT NULL,    -- PBKDF2-SHA256 salted hash of password or 4-digit PIN
  pin_hash TEXT,                -- PBKDF2-SHA256 salted hash of admin/admin_ro PIN
  accounts_writer INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_username ON auth_credentials(username);
CREATE INDEX IF NOT EXISTS idx_auth_mobile ON auth_credentials(mobile);

CREATE TABLE IF NOT EXISTS processed_txns (
  txn_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  base_version INTEGER,
  applied_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS month_snapshots (
  month_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  year_bs INTEGER,
  month_index INTEGER,
  month_json TEXT NOT NULL,
  r2_backup_key TEXT,
  closed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,        -- 'group' | 'private:<memberId>'
  from_id TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_role TEXT NOT NULL,
  text TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  bill_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_channel_time ON chat_messages(channel, created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  sub_key TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  role TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS schedule_log (
  job_key TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL
);
