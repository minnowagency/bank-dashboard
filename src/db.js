const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SEED_CATEGORIES = ['Payroll', 'Shipping', 'Supplies', 'Taxes', 'Fees',
  'Transfers', 'Revenue', 'Utilities', 'Insurance', 'Other'];

// CREATE TABLE IF NOT EXISTS never alters a table that already exists, so
// columns added after first deploy are backfilled here.
function migrate(db, schemaSql) {
  const cols = db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
  if (!cols.includes('hidden')) db.exec('ALTER TABLE accounts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  rebuildTransactionsIfStale(db, schemaSql);
}

// SQLite cannot alter a CHECK constraint, so widening category_source to allow
// 'ai' means rebuilding the table. schema.sql stays the single source of truth:
// the old table is renamed aside, schema.sql recreates the new one, rows are
// copied column-by-column for whatever columns both versions share, and the
// old table is dropped. Annotations survive because they are ordinary columns.
function rebuildTransactionsIfStale(db, schemaSql) {
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get();
  if (!ddl || ddl.sql.includes("'ai'")) return;

  const before = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const idx of ['idx_txn_account_posted', 'idx_txn_posted', 'idx_txn_uncat']) {
        db.exec(`DROP INDEX IF EXISTS ${idx}`);
      }
      db.exec('ALTER TABLE transactions RENAME TO transactions_legacy');
      db.exec(schemaSql); // CREATE TABLE IF NOT EXISTS: only transactions is missing
      const oldCols = db.prepare('PRAGMA table_info(transactions_legacy)').all().map(c => c.name);
      const newCols = db.prepare('PRAGMA table_info(transactions)').all().map(c => c.name);
      const shared = oldCols.filter(c => newCols.includes(c));
      const list = shared.join(', ');
      db.exec(`INSERT INTO transactions (${list}) SELECT ${list} FROM transactions_legacy`);
      db.exec('DROP TABLE transactions_legacy');
    })();
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  const after = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
  if (after !== before) throw new Error(`transactions migration lost rows: ${before} -> ${after}`);
}

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  const db = {
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
    pragma: (s) => raw.exec(`PRAGMA ${s}`),
    transaction: (fn) => (...args) => {
      raw.exec('BEGIN');
      try { const out = fn(...args); raw.exec('COMMIT'); return out; }
      catch (err) { raw.exec('ROLLBACK'); throw err; }
    },
    close: () => raw.close(),
  };
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  migrate(db, schemaSql);
  const insert = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
  for (const c of SEED_CATEGORIES) insert.run(c);
  return db;
}

module.exports = { openDb, SEED_CATEGORIES };
