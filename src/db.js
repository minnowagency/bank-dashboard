const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SEED_CATEGORIES = ['Payroll', 'Shipping', 'Supplies', 'Taxes', 'Fees',
  'Transfers', 'Revenue', 'Utilities', 'Insurance', 'Other'];

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const insert = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
  for (const c of SEED_CATEGORIES) insert.run(c);
  return db;
}

module.exports = { openDb, SEED_CATEGORIES };
