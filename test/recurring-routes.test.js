const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login, T0 } = require('./helpers');
const { runSync } = require('../src/sync');
const { openDb } = require('../src/db');

const DAY = 86400;
function item(db, account, name, status, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`INSERT INTO recurring_items (account_id, merchant_key, display_name, kind, cadence,
    amount_cents, amount_min_cents, amount_max_cents, last_seen, next_due, status, evidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(account, name.toUpperCase(), name, extra.kind || 'expense', extra.cadence || 'monthly',
      extra.cents || 10000, extra.cents || 10000, extra.cents || 10000, now - 20 * DAY, now + 10 * DAY, status,
      JSON.stringify([{ date: now - 50 * DAY, amount_cents: 10000 }, { date: now - 20 * DAY, amount_cents: 10000 }]),
      now, now).lastInsertRowid;
}

test('recurring page lists candidates with evidence and confirmed items; member sees only visible accounts', async () => {
  const { app, db } = makeApp();
  item(db, 'CHK', 'Duke Energy', 'candidate');
  item(db, 'CHK', 'Rent', 'confirmed');
  item(db, 'PER', 'Netflix', 'candidate');
  const owner = await login(app, 'michael', 'ownerpass1');
  const page = await request(app).get('/recurring').set('Cookie', owner);
  assert.equal(page.status, 200);
  assert.match(page.text, /Duke Energy/);
  assert.match(page.text, /Rent/);
  assert.match(page.text, /Netflix/);
  const member = await login(app, 'asst', 'memberpass1');
  const mpage = await request(app).get('/recurring').set('Cookie', member);
  assert.ok(!/Netflix/.test(mpage.text));
});

test('confirm, dismiss, edit and delete respect visibility', async () => {
  const { app, db } = makeApp();
  const id = item(db, 'CHK', 'Duke Energy', 'candidate');
  const secret = item(db, 'PER', 'Netflix', 'candidate');
  const member = await login(app, 'asst', 'memberpass1');

  assert.equal((await request(app).post(`/recurring/${id}/confirm`).set('Cookie', member)).status, 302);
  assert.equal(db.prepare('SELECT status FROM recurring_items WHERE id=?').get(id).status, 'confirmed');

  assert.equal((await request(app).post(`/recurring/${secret}/confirm`).set('Cookie', member)).status, 404);
  assert.equal(db.prepare('SELECT status FROM recurring_items WHERE id=?').get(secret).status, 'candidate');

  await request(app).post(`/recurring/${id}/edit`).set('Cookie', member).type('form')
    .send({ display_name: 'Power bill', amount: '135.00', cadence: 'monthly' });
  const r = db.prepare('SELECT * FROM recurring_items WHERE id=?').get(id);
  assert.equal(r.display_name, 'Power bill');
  assert.equal(r.amount_cents, 13500);

  await request(app).post(`/recurring/${id}/dismiss`).set('Cookie', member);
  assert.equal(db.prepare('SELECT status FROM recurring_items WHERE id=?').get(id).status, 'dismissed');

  const bad = await request(app).post(`/recurring/${id}/edit`).set('Cookie', member).type('form')
    .send({ display_name: 'x', amount: 'abc', cadence: 'monthly' });
  assert.equal(bad.status, 400);
});

test('a manual item can be added and forecast', async () => {
  const { app, db } = makeApp();
  const owner = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).post('/recurring').set('Cookie', owner).type('form')
    .send({ account_id: 'CHK', display_name: 'Insurance', kind: 'expense', cadence: 'monthly',
            amount: '450.00', next_due: '2099-01-15' });
  assert.equal(res.status, 302);
  const r = db.prepare("SELECT * FROM recurring_items WHERE display_name='Insurance'").get();
  assert.equal(r.status, 'manual');
  assert.equal(r.amount_cents, 45000);

  const denied = await request(app).post('/recurring').set('Cookie', await login(app, 'asst', 'memberpass1'))
    .type('form').send({ account_id: 'PER', display_name: 'x', kind: 'expense', cadence: 'monthly', amount: '1', next_due: '2099-01-01' });
  assert.equal(denied.status, 404, 'member cannot add to a private account');
});

test('forecast page renders per-account weeks and the overdue list', async () => {
  const { app, db } = makeApp();
  item(db, 'CHK', 'Rent', 'confirmed', { cents: 300000 });
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE recurring_items SET next_due = ? WHERE display_name='Rent'").run(now - 9 * DAY);
  const owner = await login(app, 'michael', 'ownerpass1');
  const page = await request(app).get('/forecast').set('Cookie', owner);
  assert.equal(page.status, 200);
  assert.match(page.text, /Ops/);               // account section by display name
  assert.match(page.text, /Overdue/);
  assert.match(page.text, /Rent/);
  assert.match(page.text, /\$3,000\.00/);
  const one = await request(app).get('/forecast?account=AMX').set('Cookie', owner);
  assert.ok(!/<h2>Ops /.test(one.text), 'only the selected account gets a section');
  assert.match(one.text, /<h2>Amex 91002 /);
});

test('sync refreshes recurring candidates after categorization', async () => {
  const db = openDb(':memory:');
  const NOW = T0;
  const mk = (id, daysAgo) => ({ id, postedAt: NOW - daysAgo * DAY, amountCents: -19900, description: 'CPI SECURITY', pending: 0, cardMember: null });
  const payload = () => ({ errors: [], accounts: [{ id: 'A1', name: 'Checking', orgName: 'Truist', balanceCents: 1, balanceDate: NOW,
    transactions: [mk('a', 65), mk('b', 35), mk('c', 5)] }] });
  await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => payload(), now: () => NOW });
  const row = db.prepare("SELECT * FROM recurring_items WHERE merchant_key='CPI SECURITY'").get();
  assert.ok(row, 'candidate created by sync');
  assert.equal(row.cadence, 'monthly');
});
