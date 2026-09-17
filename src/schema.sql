CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,               -- SimpleFIN account id
  name TEXT NOT NULL,
  display_name TEXT,                 -- owner-set; sync never touches
  org_name TEXT,
  kind TEXT NOT NULL DEFAULT 'bank' CHECK (kind IN ('bank','credit')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('company','private')),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  balance_date INTEGER,
  last_synced_at INTEGER,
  sync_error TEXT
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position INTEGER NOT NULL,
  pattern TEXT NOT NULL,             -- case-insensitive substring of description
  account_id TEXT REFERENCES accounts(id),
  amount_cents INTEGER,              -- optional exact-amount condition
  category_id INTEGER NOT NULL REFERENCES categories(id),
  owner_only INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  uid TEXT PRIMARY KEY,              -- account_id || '|' || sf_id
  sf_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  posted_at INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0,
  card_member TEXT,
  category_id INTEGER REFERENCES categories(id),
  category_source TEXT CHECK (category_source IN ('rule','manual','transfer')),
  categorized_by INTEGER REFERENCES users(id),
  rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  note TEXT,
  note_by INTEGER REFERENCES users(id),
  transfer_pair_uid TEXT,
  first_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_account_posted ON transactions(account_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_txn_posted ON transactions(posted_at);
CREATE INDEX IF NOT EXISTS idx_txn_uncat ON transactions(category_id) WHERE category_id IS NULL;

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
