const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { detectTransfers } = require('../src/transfers');

const DAY = 86400;
const T0 = 1789000000;

function seed(db) {
  db.prepare(`INSERT INTO accounts (id, name, kind) VALUES
    ('CHK','Checking','bank'), ('SAV','Savings','bank'), ('AMX','Amex','credit'), ('AMX2','Amex Gold','credit')`).run();
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
  const inn = txn(db, 'AMX', 50000, T0 + DAY);
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
  txn(db, 'AMX', 10000, T0 + 4 * DAY);              // too far apart
  txn(db, 'CHK', -20000, T0);
  txn(db, 'CHK', 20000, T0);                        // same account
  txn(db, 'CHK', -30000, T0);
  txn(db, 'AMX', 30000, T0, { categoryId: 1 });     // already categorized
  assert.equal(detectTransfers(db), 0);
});

test('ambiguous candidates pair closest-dated first, each side used once', () => {
  const db = openDb(':memory:');
  seed(db);
  const out1 = txn(db, 'CHK', -75000, T0);
  const inFar = txn(db, 'AMX2', 75000, T0 + 2 * DAY);
  const inNear = txn(db, 'AMX', 75000, T0);
  assert.equal(detectTransfers(db), 1);
  assert.equal(db.prepare('SELECT transfer_pair_uid FROM transactions WHERE uid=?').get(out1).transfer_pair_uid, inNear);
  assert.equal(db.prepare('SELECT transfer_pair_uid FROM transactions WHERE uid=?').get(inFar).transfer_pair_uid, null);
});

test('idempotent: second run finds nothing new', () => {
  const db = openDb(':memory:');
  seed(db);
  txn(db, 'CHK', -50000, T0);
  txn(db, 'AMX', 50000, T0);
  assert.equal(detectTransfers(db), 1);
  assert.equal(detectTransfers(db), 0);
});

test('bank-to-bank movement is intercompany income, never paired as a transfer', () => {
  const db = openDb(':memory:');
  seed(db);
  txn(db, 'CHK', -2500000, T0, { description: 'WIRE OUT TO BHCC' });
  txn(db, 'SAV', 2500000, T0, { description: 'WIRE IN FROM SMFG' });
  assert.equal(detectTransfers(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NOT NULL').get().n, 0);
});

test('a card payment pairs even when AI already categorized one side (card linked after the bank); manual and rule never', () => {
  const db = openDb(':memory:');
  seed(db);
  const transfers = db.prepare("SELECT id FROM categories WHERE name='Transfers'").get().id;
  const supplies = db.prepare("SELECT id FROM categories WHERE name='Supplies'").get().id;
  const mk = (uid, src, cat) => db.prepare(`UPDATE transactions SET category_id=?, category_source=?,
    suggested_category_id=?, ai_confidence='high', ai_reason='x' WHERE uid=?`).run(cat, src, cat, uid);
  const aiOut = txn(db, 'CHK', -1439434, T0);
  mk(aiOut, 'ai', transfers);
  const cardIn = txn(db, 'AMX', 1439434, T0 - 2 * DAY);
  const manualOut = txn(db, 'CHK', -500000, T0);
  mk(manualOut, 'manual', supplies);
  txn(db, 'AMX2', 500000, T0);
  const ruleOut = txn(db, 'CHK', -700000, T0);
  mk(ruleOut, 'rule', supplies);
  txn(db, 'AMX2', 700000, T0);

  assert.equal(detectTransfers(db), 1);
  const a = { ...db.prepare('SELECT * FROM transactions WHERE uid=?').get(aiOut) };
  assert.equal(a.transfer_pair_uid, cardIn);
  assert.equal(a.category_source, 'transfer');
  assert.equal(a.ai_confidence, null, 'AI annotation cleared once the pair decides');
  assert.equal(db.prepare('SELECT transfer_pair_uid FROM transactions WHERE uid=?').get(cardIn).transfer_pair_uid, aiOut);
  assert.equal(db.prepare('SELECT category_source FROM transactions WHERE uid=?').get(manualOut).category_source, 'manual');
  assert.equal(db.prepare('SELECT category_source FROM transactions WHERE uid=?').get(ruleOut).category_source, 'rule');
});
