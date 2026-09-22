const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { resolvePeriod, periodSummary } = require('../src/feed');

const OWNER = { id: 1, role: 'owner' };
const MEMBER = { id: 2, role: 'member' };

// Eastern-time helpers: epoch seconds for a wall-clock moment in New York.
const et = (s) => Math.floor(new Date(s).getTime() / 1000);

test('resolvePeriod: this month starts at Eastern midnight on the 1st', () => {
  const now = et('2026-09-22T14:00:00-04:00');
  const p = resolvePeriod({ period: 'this-month' }, now);
  assert.equal(p.key, 'this-month');
  assert.equal(p.from, et('2026-09-01T00:00:00-04:00'));
  assert.equal(p.to, et('2026-10-01T00:00:00-04:00'));
  // previous window is August
  assert.equal(p.prevFrom, et('2026-08-01T00:00:00-04:00'));
  assert.equal(p.prevTo, et('2026-09-01T00:00:00-04:00'));
  assert.equal(p.label, 'September');
});

test('resolvePeriod: last month, and January rolls back to December of the prior year', () => {
  const sept = resolvePeriod({ period: 'last-month' }, et('2026-09-22T14:00:00-04:00'));
  assert.equal(sept.from, et('2026-08-01T00:00:00-04:00'));
  assert.equal(sept.to, et('2026-09-01T00:00:00-04:00'));

  const jan = resolvePeriod({ period: 'last-month' }, et('2026-01-09T10:00:00-05:00'));
  assert.equal(jan.from, et('2025-12-01T00:00:00-05:00'));
  assert.equal(jan.to, et('2026-01-01T00:00:00-05:00'));
  assert.equal(jan.label, 'December 2025');
});

test('resolvePeriod: a transaction late on the last day of the month stays in that month', () => {
  // 2026-08-31 23:30 Eastern is 2026-09-01 03:30 UTC — the naive UTC answer is wrong.
  const late = et('2026-08-31T23:30:00-04:00');
  const aug = resolvePeriod({ period: 'this-month' }, et('2026-08-15T12:00:00-04:00'));
  assert.ok(late >= aug.from && late < aug.to, 'late-evening txn must fall in August');
});

test('resolvePeriod: 30d, ytd, all, and an explicit range overriding the preset', () => {
  const now = et('2026-09-22T14:00:00-04:00');
  const d30 = resolvePeriod({ period: '30d' }, now);
  assert.equal(d30.to - d30.from, 30 * 86400);
  assert.equal(d30.prevTo, d30.from);

  const ytd = resolvePeriod({ period: 'ytd' }, now);
  assert.equal(ytd.from, et('2026-01-01T00:00:00-05:00'));

  const all = resolvePeriod({ period: 'all' }, now);
  assert.equal(all.from, null);
  assert.equal(all.prevFrom, null, 'no comparison window for all time');

  const custom = resolvePeriod({ period: 'this-month', from: '2026-03-01', to: '2026-03-31' }, now);
  assert.equal(custom.key, 'custom');
  assert.equal(custom.from, et('2026-03-01T00:00:00-05:00'));
  assert.equal(custom.to, et('2026-04-01T00:00:00-04:00'), 'to is inclusive of the whole end day');
});

test('resolvePeriod: unknown period falls back to this month', () => {
  const now = et('2026-09-22T14:00:00-04:00');
  assert.equal(resolvePeriod({ period: 'nonsense' }, now).key, 'this-month');
  assert.equal(resolvePeriod({}, now).key, 'this-month');
});

function fixture() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO accounts (id, name, kind, visibility, hidden, balance_cents) VALUES
    ('CHK', 'Checking', 'bank', 'company', 0, 100000),
    ('PER', 'Personal', 'bank', 'private', 0, 50000),
    ('OLD', 'Old Biz',  'bank', 'company', 1, 999)`).run();
  const transfers = db.prepare("SELECT id FROM categories WHERE name='Transfers'").get().id;
  const ins = db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents,
    description, category_id, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const SEP = et('2026-09-10T12:00:00-04:00');
  const AUG = et('2026-08-10T12:00:00-04:00');
  ins.run('CHK|1', '1', 'CHK', SEP, 500000, 'CUSTOMER PAYMENT', null, 0);
  ins.run('CHK|2', '2', 'CHK', SEP, -120000, 'SUPPLIER', null, 0);
  ins.run('CHK|3', '3', 'CHK', SEP, -900000, 'CARD PAYMENT', transfers, 0);   // excluded
  ins.run('CHK|4', '4', 'CHK', SEP, 900000, 'TRANSFER IN', transfers, 0);      // excluded
  ins.run('PER|5', '5', 'PER', SEP, -30000, 'PERSONAL', null, 0);              // owner only
  ins.run('OLD|6', '6', 'OLD', SEP, -70000, 'OLD BIZ', null, 0);               // hidden
  ins.run('CHK|7', '7', 'CHK', AUG, 200000, 'AUG INCOME', null, 0);            // previous period
  return db;
}

test('periodSummary: excludes transfers, respects visibility and the account filter', () => {
  const db = fixture();
  const now = et('2026-09-22T14:00:00-04:00');

  const owner = periodSummary(db, OWNER, { period: 'this-month' }, now);
  assert.equal(owner.inCents, 500000);
  assert.equal(owner.outCents, 150000, 'supplier + personal, no transfers, no hidden account');
  assert.equal(owner.netCents, 350000);

  const member = periodSummary(db, MEMBER, { period: 'this-month' }, now);
  assert.equal(member.outCents, 120000, 'member must not see the private account');

  const filtered = periodSummary(db, OWNER, { period: 'this-month', account: 'CHK' }, now);
  assert.equal(filtered.outCents, 120000);
});

test('periodSummary: compares with the previous window and handles an empty one', () => {
  const db = fixture();
  const now = et('2026-09-22T14:00:00-04:00');
  const s = periodSummary(db, OWNER, { period: 'this-month' }, now);
  assert.equal(s.prev.inCents, 200000, 'August income');
  assert.equal(s.prev.outCents, 0);

  const july = periodSummary(db, OWNER, { from: '2026-07-01', to: '2026-07-31' }, now);
  assert.deepEqual([july.inCents, july.outCents, july.netCents], [0, 0, 0]);
});

test('periodSummary: all-time has no comparison, and a member with no accounts gets zeros', () => {
  const db = fixture();
  const now = et('2026-09-22T14:00:00-04:00');
  const all = periodSummary(db, OWNER, { period: 'all' }, now);
  assert.equal(all.inCents, 700000);
  assert.equal(all.prev, null);

  const empty = periodSummary(openDb(':memory:'), MEMBER, { period: 'this-month' }, now);
  assert.deepEqual([empty.inCents, empty.outCents], [0, 0]);
});

test('feedQuery honors the period so the feed matches the summary', () => {
  const db = fixture();
  const { feedQuery } = require('../src/feed');
  const now = et('2026-09-22T14:00:00-04:00');
  const sept = feedQuery(db, OWNER, { period: 'this-month' }, { now });
  assert.ok(!sept.rows.some(r => r.uid === 'CHK|7'), 'August row must not appear in September');
  const all = feedQuery(db, OWNER, { period: 'all' }, { now });
  assert.ok(all.rows.some(r => r.uid === 'CHK|7'));
});
