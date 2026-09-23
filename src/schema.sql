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
  hidden INTEGER NOT NULL DEFAULT 0,  -- owner-set; hides the account from every view but /accounts
  source TEXT NOT NULL DEFAULT 'simplefin',
  source_account_id TEXT,              -- the provider's id for this account
  mask TEXT,                           -- last four digits, used to match providers to existing rows
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
  category_source TEXT CHECK (category_source IN ('rule','manual','transfer','ai')),
  categorized_by INTEGER REFERENCES users(id),
  rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  note TEXT,
  note_by INTEGER REFERENCES users(id),
  transfer_pair_uid TEXT,
  plaid_txn_id TEXT,                   -- set once Plaid has seen this transaction
  suggested_category_id INTEGER REFERENCES categories(id),  -- AI suggestion awaiting review
  ai_confidence TEXT,
  ai_reason TEXT,
  first_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_account_posted ON transactions(account_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_txn_posted ON transactions(posted_at);
CREATE INDEX IF NOT EXISTS idx_txn_uncat ON transactions(category_id) WHERE category_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_plaid ON transactions(plaid_txn_id) WHERE plaid_txn_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS recurring_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  merchant_key TEXT NOT NULL,          -- normalized description the detector groups on
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly','biweekly','semimonthly','monthly')),
  amount_cents INTEGER NOT NULL,       -- typical amount, positive; sign comes from kind
  amount_min_cents INTEGER NOT NULL,
  amount_max_cents INTEGER NOT NULL,
  last_seen INTEGER,                   -- posted_at of the latest matching transaction
  next_due INTEGER,                    -- epoch of the next expected occurrence
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','confirmed','dismissed','manual')),
  evidence TEXT NOT NULL DEFAULT '[]', -- JSON [{date, amount_cents}] the detector matched
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (account_id, merchant_key, kind)
);

CREATE TABLE IF NOT EXISTS senders (
  last4 TEXT NOT NULL,                 -- last four digits of the originating account
  account_id TEXT NOT NULL REFERENCES accounts(id),  -- the receiving company
  name TEXT NOT NULL,                  -- who the originating account belongs to ("hppyc")
  category_id INTEGER NOT NULL REFERENCES categories(id),  -- what it means to the receiver
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (last4, account_id)
);

CREATE TABLE IF NOT EXISTS plaid_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL UNIQUE,
  access_token_enc TEXT NOT NULL,      -- AES-256-GCM, key in .env (APP_SECRET)
  institution_name TEXT,
  cursor TEXT,                         -- /transactions/sync cursor; NULL = full backfill next run
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error')),
  error TEXT,
  last_synced_at INTEGER,
  account_ids TEXT NOT NULL DEFAULT '[]',   -- Plaid account ids seen for this item
  created_at INTEGER NOT NULL
);
