const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SEED_CATEGORIES = ['Payroll', 'Shipping', 'Supplies', 'Taxes', 'Fees',
  'Transfers', 'Revenue', 'Distributions', 'Capital contributions', 'Utilities', 'Insurance', 'Other'];

// CREATE TABLE IF NOT EXISTS never alters a table that already exists, so
// columns added after first deploy are backfilled here.
function migrate(db, schemaSql) {
  const cols = db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
  if (!cols.includes('hidden')) db.exec('ALTER TABLE accounts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  rebuildTransactionsIfStale(db, schemaSql);
  repairIntercompanyTransfers(db);
  rebuildSendersIfStale(db, schemaSql);
}

// The first senders table was keyed by sending account only; labels now
// belong to a (sending account, receiving company) pair. Old labels are
// expanded to every receiving account that has wires from that sender, which
// reproduces the old behavior exactly until someone refines them.
function rebuildSendersIfStale(db, schemaSql) {
  const cols = db.prepare('PRAGMA table_info(senders)').all().map(c => c.name);
  if (cols.length === 0 || cols.includes('account_id')) return;
  db.transaction(() => {
    db.exec('ALTER TABLE senders RENAME TO senders_legacy');
    db.exec(schemaSql);
    const old = db.prepare('SELECT * FROM senders_legacy').all();
    const ins = db.prepare(`INSERT OR IGNORE INTO senders (last4, account_id, name, category_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const receivers = db.prepare(`SELECT DISTINCT account_id FROM transactions WHERE amount_cents > 0
      AND (description LIKE ? OR description LIKE ?)`);
    for (const s of old) {
      for (const r of receivers.all(`%ACCT: %${s.last4}%`, `%FROM *${s.last4}%`)) {
        ins.run(s.last4, r.account_id, s.name, s.category_id, s.created_by, s.created_at);
      }
    }
    db.exec('DROP TABLE senders_legacy');
  })();
}

// Bank<->bank pairs made under the old rule were intercompany payments, and
// the AI had filed inbound wires as Transfers. Undo both once so they get
// categorized as income. Manual categorizations are left alone.
function repairIntercompanyTransfers(db) {
  const KEY = 'migration:intercompany-transfers';
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(KEY)) return;
  const hasKind = db.prepare('PRAGMA table_info(accounts)').all().some(c => c.name === 'kind');
  const hasPairs = db.prepare('PRAGMA table_info(transactions)').all().some(c => c.name === 'transfer_pair_uid');
  if (hasKind && hasPairs) {
    db.transaction(() => {
      db.exec(`UPDATE transactions SET category_id = NULL, category_source = NULL, transfer_pair_uid = NULL
        WHERE category_source = 'transfer' AND uid IN (
          SELECT a.uid FROM transactions a
          JOIN transactions b ON b.uid = a.transfer_pair_uid
          JOIN accounts aa ON aa.id = a.account_id JOIN accounts ab ON ab.id = b.account_id
          WHERE aa.kind = ab.kind)`);
      db.exec(`UPDATE transactions SET category_id = NULL, category_source = NULL, ai_confidence = NULL, ai_reason = NULL
        WHERE category_source = 'ai' AND amount_cents > 0
          AND category_id = (SELECT id FROM categories WHERE name = 'Transfers')`);
      db.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(KEY);
    })();
  }
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

module.exports = { openDb, SEED_CATEGORIES, repairIntercompanyTransfers };
