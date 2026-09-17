const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { visibleAccounts, feedQuery, totals } = require('../src/feed');

const T0 = 1789000000;
const OWNER = { id: 1, role: 'owner' };
const MEMBER = { id: 2, role: 'member' };

function fixture() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO accounts (id, name, display_name, kind, visibility, balance_cents) VALUES
    ('CHK', 'Business Checking', 'Ops',  'bank',   'company', 4218010),
    ('AMX', 'Amex 91002',        NULL,   'credit', 'company', -1893344),
    ('PER', 'Personal Amex',     NULL,   'credit', 'private',  -50000)`).run();
  const ins = db.prepare(`INSERT INTO transactions
    (uid, sf_id, account_id, posted_at, amount_cents, description, card_member, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run('CHK|1', '1', 'CHK', T0,        -124000, 'UPS FREIGHT',     null,       T0);
  ins.run('CHK|2', '2', 'CHK', T0 - 86400, 680122, 'STRIPE PAYOUT',   null,       T0);
  ins.run('AMX|3', '3', 'AMX', T0,          -8000, 'DELTA AIR',       'JANE DOE', T0);
  ins.run('PER|4', '4', 'PER', T0,          -9999, 'PERSONAL DINNER', null,       T0);
  return db;
}

test('visibleAccounts: owner sees all, member sees only company', () => {
  const db = fixture();
  assert.deepEqual(visibleAccounts(db, OWNER).map(a => a.id).sort(), ['AMX', 'CHK', 'PER']);
  assert.deepEqual(visibleAccounts(db, MEMBER).map(a => a.id).sort(), ['AMX', 'CHK']);
});

test('feedQuery hides private rows and private-only card members from member', () => {
  const db = fixture();
  const owner = feedQuery(db, OWNER, {});
  const member = feedQuery(db, MEMBER, {});
  assert.equal(owner.rows.length, 4);
  assert.equal(member.rows.length, 3);
  assert.ok(!member.rows.some(r => r.uid === 'PER|4'));
  assert.ok(!member.accounts.some(a => a.id === 'PER'));
});

test('filters: search, account, amount range, date range, uncategorized', () => {
  const db = fixture();
  assert.deepEqual(feedQuery(db, OWNER, { q: 'ups' }).rows.map(r => r.uid), ['CHK|1']);
  assert.deepEqual(feedQuery(db, OWNER, { account: 'AMX' }).rows.map(r => r.uid), ['AMX|3']);
  assert.deepEqual(feedQuery(db, OWNER, { min: '1000' }).rows.map(r => r.uid), ['CHK|1', 'CHK|2']);
  assert.equal(feedQuery(db, OWNER, { from: '2099-01-01' }).rows.length, 0);
  assert.equal(feedQuery(db, OWNER, { uncategorized: '1' }).rows.length, 4);
  assert.equal(feedQuery(db, OWNER, { member: 'JANE DOE' }).rows.length, 1);
});

test('garbage filter values are ignored, not thrown', () => {
  const db = fixture();
  assert.equal(feedQuery(db, OWNER, { min: 'abc', from: 'not-a-date' }).rows.length, 4);
});

test('totals: bank cash vs credit owed, per visibility', () => {
  const db = fixture();
  assert.deepEqual(totals(db, OWNER), { cashCents: 4218010, owedCents: 1943344 });
  assert.deepEqual(totals(db, MEMBER), { cashCents: 4218010, owedCents: 1893344 });
});

test('member with zero visible accounts gets empty results, not SQL errors', () => {
  const db = openDb(':memory:');
  assert.equal(feedQuery(db, MEMBER, {}).rows.length, 0);
  assert.deepEqual(totals(db, MEMBER), { cashCents: 0, owedCents: 0 });
});
