const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SEED_CATEGORIES = ['Payroll', 'Shipping', 'Supplies', 'Taxes', 'Fees',
  'Transfers', 'Revenue', 'Utilities', 'Insurance', 'Other'];

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
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const insert = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
  for (const c of SEED_CATEGORIES) insert.run(c);
  return db;
}

module.exports = { openDb, SEED_CATEGORIES };
