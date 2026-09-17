const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { detectTransfers } = require('../src/transfers');

const DAY = 86400;
const T0 = 1789000000;

function seed(db) {
  db.prepare("INSERT INTO accounts (id, name) VALUES ('CHK','Checking'),('SAV','Savings'),('AMX','Amex')").run();
}
let seq = 0;
function txn(db, accountId, amountCents, postedAt, extra = {}) {
  const uid = `${accountId}|t${++seq}`;
  db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, first_seen_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(uid, `t${seq}`, accountId, postedAt, amountCents, extra.description || 'XFER', T0);
  if (extra.categoryId) db.prepare('UPDATE transactions SET category_id=? WHERE uid=?').run(extra.categoryId, uid);
  return uid;
}

test('pairs opposite-sign equal amounts across accounts within 3 days', () => {
  const db = openDb(':memory:');
  seed(db);
  const out = txn(db, 'CHK', -50000, T0);
  const inn = txn(db, 'SAV', 50000, T0 + DAY);
  assert.equal(detectTransfers(db), 1);
  const a = db.prepare('SELECT * FROM transactions WHERE uid=?').get(out);
  const b = db.prepare('SELECT * FROM transactions WHERE uid=?').get(inn);
  const transfersId = db.prepare("SELECT id FROM categories WHERE name='Transfers'").get().id;
  assert.equal(a.category_id, transfersId);
  assert.equal(a.category_source, 'transfer');
  assert.equal(a.transfer_pair_uid, b.uid);
  assert.equal(b.transfer_pair_uid, a.uid);
});

test('does not pair outside the window, same account, or already-categorized rows', () => {
  const db = openDb(':memory:');
  seed(db);
  txn(db, 'CHK', -10000, T0);
  txn(db, 'SAV', 10000, T0 + 4 * DAY);              // too far apart
  txn(db, 'CHK', -20000, T0);
  txn(db, 'CHK', 20000, T0);                        // same account
  txn(db, 'CHK', -30000, T0);
  txn(db, 'SAV', 30000, T0, { categoryId: 1 });     // already categorized
  assert.equal(detectTransfers(db), 0);
});

test('ambiguous candidates pair closest-dated first, each side used once', () => {
  const db = openDb(':memory:');
  seed(db);
  const out1 = txn(db, 'CHK', -75000, T0);
  const inFar = txn(db, 'AMX', 75000, T0 + 2 * DAY);
  const inNear = txn(db, 'AMX', 75000, T0);
  assert.equal(detectTransfers(db), 1);
  assert.equal(db.prepare('SELECT transfer_pair_uid FROM transactions WHERE uid=?').get(out1).transfer_pair_uid, inNear);
  assert.equal(db.prepare('SELECT transfer_pair_uid FROM transactions WHERE uid=?').get(inFar).transfer_pair_uid, null);
});

test('idempotent: second run finds nothing new', () => {
  const db = openDb(':memory:');
  seed(db);
  txn(db, 'CHK', -50000, T0);
  txn(db, 'SAV', 50000, T0);
  assert.equal(detectTransfers(db), 1);
  assert.equal(detectTransfers(db), 0);
});
