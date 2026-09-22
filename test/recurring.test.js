const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { normalizeMerchant, detectCandidates, refreshCandidates, forecast } = require('../src/recurring');

const OWNER = { id: 1, role: 'owner' };
const MEMBER = { id: 2, role: 'member' };
const et = (s) => Math.floor(new Date(s).getTime() / 1000);
const NOW = et('2026-09-22T12:00:00-04:00');
const DAY = 86400;

function base() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO accounts (id, name, kind, visibility, hidden, balance_cents) VALUES
    ('CHK', 'BHCC LLC', 'bank', 'company', 0, 1000000),
    ('PER', 'Personal', 'bank', 'private', 0, 50000),
    ('OLD', 'RHJL', 'bank', 'company', 1, 999)`).run();
  return db;
}
let seq = 0;
function txn(db, account, daysAgo, cents, desc, categoryName) {
  const cat = categoryName ? db.prepare('SELECT id FROM categories WHERE name=?').get(categoryName).id : null;
  db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, category_id, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(`${account}|${++seq}`, String(seq), account, NOW - daysAgo * DAY, cents, desc, cat, NOW);
}

test('normalizeMerchant strips numbers, store ids and POS noise', () => {
  assert.equal(normalizeMerchant('DUKE ENERGY 8891'), 'DUKE ENERGY');
  assert.equal(normalizeMerchant('POS PURCHASE 0917 UPS STORE #1234 CHARLOTTE NC'), 'UPS STORE CHARLOTTE NC');
  assert.equal(normalizeMerchant('AMZN Mktp US*2K4LM'), 'AMZN MKTP US');
  assert.equal(normalizeMerchant('Gusto'), 'GUSTO');
  assert.equal(normalizeMerchant('CHECK #2779'), 'CHECK');
});

test('detects a monthly expense from two occurrences and a weekly one from three', () => {
  const db = base();
  txn(db, 'CHK', 40, -199900, 'RF MORTGAGE SERV');
  txn(db, 'CHK', 10, -199900, 'RF MORTGAGE SERV');
  txn(db, 'CHK', 21, -4200, 'SQ *CLEANING CO');
  txn(db, 'CHK', 14, -4200, 'SQ *CLEANING CO');
  txn(db, 'CHK', 7, -4200, 'SQ *CLEANING CO');
  const found = detectCandidates(db, NOW);
  const mortgage = found.find(c => c.merchant_key === 'RF MORTGAGE SERV');
  assert.equal(mortgage.cadence, 'monthly');
  assert.equal(mortgage.kind, 'expense');
  assert.equal(mortgage.amount_cents, 199900);
  assert.equal(mortgage.next_due, NOW - 10 * DAY + 30 * DAY);
  const cleaning = found.find(c => c.merchant_key === 'SQ CLEANING CO');
  assert.equal(cleaning.cadence, 'weekly');
  assert.equal(cleaning.evidence.length, 3);
});

test('detects biweekly income with a variable amount as a range', () => {
  const db = base();
  txn(db, 'CHK', 42, 680122, 'STRIPE PAYOUT');
  txn(db, 'CHK', 28, 712000, 'STRIPE PAYOUT');
  txn(db, 'CHK', 14, 655500, 'STRIPE PAYOUT');
  txn(db, 'CHK', 0, 690000, 'STRIPE PAYOUT');
  const stripe = detectCandidates(db, NOW).find(c => c.merchant_key === 'STRIPE PAYOUT');
  assert.equal(stripe.kind, 'income');
  assert.equal(stripe.cadence, 'biweekly');
  assert.equal(stripe.amount_min_cents, 655500);
  assert.equal(stripe.amount_max_cents, 712000);
  assert.ok(stripe.amount_cents >= 655500 && stripe.amount_cents <= 712000);
});

test('ignores irregular spacing, one-offs, transfers and hidden accounts', () => {
  const db = base();
  txn(db, 'CHK', 50, -5000, 'RANDOM VENDOR');
  txn(db, 'CHK', 3, -5000, 'RANDOM VENDOR');          // 47 days apart: not a cadence
  txn(db, 'CHK', 9, -25000, 'ONE TIME THING');
  txn(db, 'CHK', 30, -500000, 'ONLINE TRANSFER', 'Transfers');
  txn(db, 'CHK', 0, -500000, 'ONLINE TRANSFER', 'Transfers');
  txn(db, 'OLD', 30, -1000, 'OLD BIZ RENT');
  txn(db, 'OLD', 0, -1000, 'OLD BIZ RENT');
  const keys = detectCandidates(db, NOW).map(c => c.merchant_key);
  assert.deepEqual(keys, []);
});

test('refreshCandidates inserts new candidates and preserves confirmed/dismissed status and edits', () => {
  const db = base();
  txn(db, 'CHK', 70, -199900, 'RF MORTGAGE SERV');
  txn(db, 'CHK', 40, -199900, 'RF MORTGAGE SERV');
  refreshCandidates(db, NOW);
  const row = db.prepare("SELECT * FROM recurring_items WHERE merchant_key='RF MORTGAGE SERV'").get();
  assert.equal(row.status, 'candidate');

  db.prepare("UPDATE recurring_items SET status='confirmed', display_name='Shop mortgage' WHERE id=?").run(row.id);
  txn(db, 'CHK', 10, -199900, 'RF MORTGAGE SERV'); // the next monthly occurrence arrives
  refreshCandidates(db, NOW + DAY);
  const again = db.prepare('SELECT * FROM recurring_items WHERE id=?').get(row.id);
  assert.equal(again.status, 'confirmed');
  assert.equal(again.display_name, 'Shop mortgage');
  assert.equal(again.last_seen, NOW - 10 * DAY);
  assert.equal(JSON.parse(again.evidence).length, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recurring_items').get().n, 1, 'no duplicate row');
});

test('forecast buckets confirmed items by week per account and projects the balance', () => {
  const db = base();
  const ins = db.prepare(`INSERT INTO recurring_items (account_id, merchant_key, display_name, kind, cadence,
    amount_cents, amount_min_cents, amount_max_cents, last_seen, next_due, status, evidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`);
  ins.run('CHK', 'RENT', 'Rent', 'expense', 'monthly', 300000, 300000, 300000, NOW - 20 * DAY, NOW + 10 * DAY, 'confirmed', NOW, NOW);
  ins.run('CHK', 'CLEANING', 'Cleaning', 'expense', 'weekly', 4200, 4200, 4200, NOW - 3 * DAY, NOW + 4 * DAY, 'confirmed', NOW, NOW);
  ins.run('CHK', 'STRIPE', 'Stripe', 'income', 'biweekly', 690000, 655500, 712000, NOW - 2 * DAY, NOW + 12 * DAY, 'confirmed', NOW, NOW);
  ins.run('CHK', 'MAYBE', 'Maybe', 'expense', 'monthly', 99900, 99900, 99900, NOW - 2 * DAY, NOW + 3 * DAY, 'candidate', NOW, NOW);
  ins.run('PER', 'NETFLIX', 'Netflix', 'expense', 'monthly', 1599, 1599, 1599, NOW - 2 * DAY, NOW + 3 * DAY, 'confirmed', NOW, NOW);

  const f = forecast(db, OWNER, { now: NOW, weeks: 4 });
  const chk = f.accounts.find(a => a.id === 'CHK');
  assert.equal(chk.weeks.length, 4);
  assert.equal(chk.weeks[0].outCents, 4200, 'week 1: cleaning only (candidate excluded)');
  assert.equal(chk.weeks[1].outCents, 4200 + 300000, 'week 2: cleaning + rent');
  assert.equal(chk.weeks[1].inCents, 690000, 'stripe lands in week 2');
  assert.equal(chk.weeks[0].balanceCents, 1000000 - 4200);
  assert.equal(chk.weeks[1].balanceCents, 1000000 - 4200 - 4200 - 300000 + 690000);
  assert.ok(chk.weeks[1].items.some(i => i.name === 'Rent'));
  assert.ok(f.accounts.some(a => a.id === 'PER'), 'owner sees the private account');

  const m = forecast(db, MEMBER, { now: NOW, weeks: 4 });
  assert.ok(!m.accounts.some(a => a.id === 'PER'));
});

test('forecast flags overdue items instead of silently skipping them', () => {
  const db = base();
  db.prepare(`INSERT INTO recurring_items (account_id, merchant_key, display_name, kind, cadence,
    amount_cents, amount_min_cents, amount_max_cents, last_seen, next_due, status, evidence, created_at, updated_at)
    VALUES ('CHK', 'RENT', 'Rent', 'expense', 'monthly', 300000, 300000, 300000, ?, ?, 'confirmed', '[]', ?, ?)`)
    .run(NOW - 37 * DAY, NOW - 7 * DAY, NOW, NOW);
  const f = forecast(db, OWNER, { now: NOW, weeks: 4 });
  const chk = f.accounts.find(a => a.id === 'CHK');
  assert.equal(chk.overdue.length, 1);
  assert.equal(chk.overdue[0].name, 'Rent');
  // and it is still expected again next month
  assert.ok(chk.weeks.some(w => w.items.some(i => i.name === 'Rent')));
});
