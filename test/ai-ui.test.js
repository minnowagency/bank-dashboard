const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const { makeApp, login, T0 } = require('./helpers');

test('migration rebuilds a legacy transactions table, keeping every row and annotation', () => {
  const file = path.join(os.tmpdir(), `bd-ai-migrate-${process.pid}.sqlite3`);
  fs.rmSync(file, { force: true });

  // A pre-AI database: category_source CHECK without 'ai', no AI columns.
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE transactions (
      uid TEXT PRIMARY KEY, sf_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id),
      posted_at INTEGER NOT NULL, amount_cents INTEGER NOT NULL, description TEXT NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0, card_member TEXT,
      category_id INTEGER REFERENCES categories(id),
      category_source TEXT CHECK (category_source IN ('rule','manual','transfer')),
      categorized_by INTEGER, rule_id INTEGER, note TEXT, note_by INTEGER,
      transfer_pair_uid TEXT, first_seen_at INTEGER NOT NULL);
    CREATE INDEX idx_txn_posted ON transactions(posted_at);`);
  legacy.exec("INSERT INTO categories (name) VALUES ('Supplies')");
  legacy.exec("INSERT INTO accounts (id, name) VALUES ('CHK', 'Checking')");
  for (let i = 1; i <= 50; i++) {
    legacy.exec(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, first_seen_at)
      VALUES ('CHK|${i}', '${i}', 'CHK', ${T0 - i * 100}, ${-100 * i}, 'TXN ${i}', ${T0})`);
  }
  legacy.exec(`UPDATE transactions SET note='trade show deposit', note_by=1, category_id=1,
    category_source='manual', categorized_by=1, transfer_pair_uid='CHK|2' WHERE uid='CHK|1'`);
  legacy.close();

  const db = openDb(file);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 50);
  const t = db.prepare("SELECT * FROM transactions WHERE uid='CHK|1'").get();
  assert.equal(t.note, 'trade show deposit');
  assert.equal(t.category_source, 'manual');
  assert.equal(t.category_id, 1);
  assert.equal(t.transfer_pair_uid, 'CHK|2');
  assert.equal(t.suggested_category_id, null);
  // the widened CHECK now accepts 'ai'
  db.prepare("UPDATE transactions SET category_source='ai' WHERE uid='CHK|2'").run();
  assert.equal(db.prepare("SELECT category_source FROM transactions WHERE uid='CHK|2'").get().category_source, 'ai');
  // indexes are back
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='transactions'").all()
    .map(r => r.name);
  assert.ok(idx.includes('idx_txn_posted'));
  db.close();

  openDb(file).close(); // second open must be a no-op
  fs.rmSync(file, { force: true });
});

test('AI-categorized rows show an AI badge with the reason; suggestions are preselected in review', async () => {
  const { app, db } = makeApp();
  const owner = await login(app, 'michael', 'ownerpass1');
  const supplies = db.prepare("SELECT id FROM categories WHERE name='Supplies'").get().id;
  const utilities = db.prepare("SELECT id FROM categories WHERE name='Utilities'").get().id;
  db.prepare(`UPDATE transactions SET category_id=?, category_source='ai', ai_confidence='high',
    ai_reason='Amazon marketplace purchase' WHERE uid='CHK|1'`).run(supplies);
  db.prepare(`UPDATE transactions SET suggested_category_id=?, ai_confidence='low',
    ai_reason='Utility-looking payee' WHERE uid='CHK|2'`).run(utilities);

  const dash = await request(app).get('/').set('Cookie', owner);
  assert.match(dash.text, /class="ai-badge"[^>]*title="Amazon marketplace purchase"/);

  const review = await request(app).get('/review').set('Cookie', owner);
  assert.match(review.text, /Utility-looking payee/);
  assert.match(review.text, new RegExp(`<option value="${utilities}" selected`));
});

test('the AI toggle is owner-only and persists', async () => {
  const { app, db } = makeApp();
  const member = await login(app, 'asst', 'memberpass1');
  assert.equal((await request(app).post('/settings/ai').set('Cookie', member).type('form').send({ enabled: '0' })).status, 404);

  const owner = await login(app, 'michael', 'ownerpass1');
  await request(app).post('/settings/ai').set('Cookie', owner).type('form').send({ enabled: '0' });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='ai_enabled'").get().value, '0');
  const rules = await request(app).get('/rules').set('Cookie', owner);
  assert.match(rules.text, /Categorize new transactions with AI/);

  await request(app).post('/settings/ai').set('Cookie', owner).type('form').send({ enabled: '1' });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='ai_enabled'").get().value, '1');
});

test('accepting a suggestion clears it and records a manual categorization', async () => {
  const { app, db } = makeApp();
  const owner = await login(app, 'michael', 'ownerpass1');
  const utilities = db.prepare("SELECT id FROM categories WHERE name='Utilities'").get().id;
  db.prepare("UPDATE transactions SET suggested_category_id=?, ai_confidence='low' WHERE uid='CHK|2'").run(utilities);

  await request(app).post('/txns/CHK|2/category').set('Cookie', owner).type('form')
    .send({ category_id: String(utilities) });
  const t = db.prepare("SELECT * FROM transactions WHERE uid='CHK|2'").get();
  assert.equal(t.category_id, utilities);
  assert.equal(t.category_source, 'manual');
  assert.equal(t.suggested_category_id, null, 'suggestion should be cleared once acted on');
});

test('aiEnabled reflects the stored setting, defaulting to on', () => {
  const { aiEnabled } = require('../src/app');
  const db = openDb(':memory:');
  assert.equal(aiEnabled(db), true);
  db.prepare("INSERT INTO settings (key, value) VALUES ('ai_enabled', '0')").run();
  assert.equal(aiEnabled(db), false);
});
