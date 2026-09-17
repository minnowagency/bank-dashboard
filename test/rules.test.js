const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { applyRulesToUncategorized, createRule } = require('../src/rules');

const T0 = 1789000000;
let seq = 0;
function txn(db, accountId, description, amountCents, opts = {}) {
  const uid = `${accountId}|t${++seq}`;
  db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, first_seen_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(uid, `t${seq}`, accountId, T0, amountCents, description, T0);
  if (opts.manualCategory) {
    db.prepare("UPDATE transactions SET category_id=?, category_source='manual', categorized_by=1 WHERE uid=?")
      .run(opts.manualCategory, uid);
  }
  return uid;
}
function cat(db, name) { return db.prepare('SELECT id FROM categories WHERE name=?').get(name).id; }

test('first matching rule wins, in position order, case-insensitive', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO accounts (id, name) VALUES ('A','A')").run();
  const shipping = cat(db, 'Shipping'), fees = cat(db, 'Fees');
  db.prepare('INSERT INTO rules (position, pattern, category_id) VALUES (1, ?, ?)').run('ups', shipping);
  db.prepare('INSERT INTO rules (position, pattern, category_id) VALUES (2, ?, ?)').run('UPS FREIGHT', fees);
  const uid = txn(db, 'A', 'UPS FREIGHT 00123', -5000);
  assert.equal(applyRulesToUncategorized(db), 1);
  const t = db.prepare('SELECT * FROM transactions WHERE uid=?').get(uid);
  assert.equal(t.category_id, shipping);       // position 1 won despite rule 2 also matching
  assert.equal(t.category_source, 'rule');
  assert.equal(t.rule_id, 1);
});

test('account and amount conditions restrict matches', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO accounts (id, name) VALUES ('A','A'),('B','B')").run();
  const fees = cat(db, 'Fees');
  db.prepare("INSERT INTO rules (position, pattern, account_id, amount_cents, category_id) VALUES (1, 'FEE', 'A', -2500, ?)").run(fees);
  const hit = txn(db, 'A', 'MONTHLY FEE', -2500);
  const wrongAccount = txn(db, 'B', 'MONTHLY FEE', -2500);
  const wrongAmount = txn(db, 'A', 'MONTHLY FEE', -2600);
  assert.equal(applyRulesToUncategorized(db), 1);
  assert.equal(db.prepare('SELECT category_id FROM transactions WHERE uid=?').get(hit).category_id, fees);
  assert.equal(db.prepare('SELECT category_id FROM transactions WHERE uid=?').get(wrongAccount).category_id, null);
  assert.equal(db.prepare('SELECT category_id FROM transactions WHERE uid=?').get(wrongAmount).category_id, null);
});

test('never touches manually categorized rows', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)").run(1, 'test', 'hash', 'owner');
  db.prepare("INSERT INTO accounts (id, name) VALUES ('A','A')").run();
  const shipping = cat(db, 'Shipping'), other = cat(db, 'Other');
  db.prepare("INSERT INTO rules (position, pattern, category_id) VALUES (1, 'UPS', ?)").run(shipping);
  const uid = txn(db, 'A', 'UPS STORE', -1000, { manualCategory: other });
  assert.equal(applyRulesToUncategorized(db), 0);
  const t = db.prepare('SELECT * FROM transactions WHERE uid=?').get(uid);
  assert.equal(t.category_id, other);
  assert.equal(t.category_source, 'manual');
});

test('createRule appends at end and applies retroactively to uncategorized only', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO accounts (id, name) VALUES ('A','A')").run();
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('m','x','owner')").run();
  const shipping = cat(db, 'Shipping');
  const uid = txn(db, 'A', 'FEDEX 771', -3000);
  db.prepare("INSERT INTO rules (position, pattern, category_id) VALUES (5, 'zzz', 1)").run();
  const id = createRule(db, { pattern: 'FEDEX', categoryId: shipping, ownerOnly: false, createdBy: 1 });
  const r = db.prepare('SELECT * FROM rules WHERE id=?').get(id);
  assert.equal(r.position, 6);
  assert.equal(db.prepare('SELECT category_id FROM transactions WHERE uid=?').get(uid).category_id, shipping);
});
