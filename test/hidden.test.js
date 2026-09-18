const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const { runSync } = require('../src/sync');
const { makeApp, login, T0 } = require('./helpers');

const hide = (app, cookie, id, extra = {}) => request(app).post(`/accounts/${id}`).set('Cookie', cookie)
  .type('form').send({ display_name: '', visibility: 'company', kind: 'bank', hidden: '1', ...extra });

test('openDb adds the hidden column to a pre-existing database without it', () => {
  const file = path.join(os.tmpdir(), `bd-migrate-${process.pid}.sqlite3`);
  fs.rmSync(file, { force: true });
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, org_name TEXT,
    kind TEXT NOT NULL DEFAULT 'bank', visibility TEXT NOT NULL DEFAULT 'private',
    balance_cents INTEGER NOT NULL DEFAULT 0, balance_date INTEGER, last_synced_at INTEGER, sync_error TEXT)`);
  legacy.exec("INSERT INTO accounts (id, name) VALUES ('OLD', 'Old Account')");
  legacy.close();

  const db = openDb(file);
  assert.equal(db.prepare("SELECT hidden FROM accounts WHERE id='OLD'").get().hidden, 0);
  db.close();
  openDb(file).close(); // second open must not try to add the column again
  fs.rmSync(file, { force: true });
});

test('hiding an account removes it from dashboard, totals, review, export, and rules counts', async () => {
  const { app } = makeApp();
  const owner = await login(app, 'michael', 'ownerpass1');
  assert.equal((await hide(app, owner, 'CHK', { display_name: 'Ops' })).status, 302);

  const dash = await request(app).get('/').set('Cookie', owner);
  assert.ok(!/UPS FREIGHT/.test(dash.text));
  assert.ok(!/STRIPE PAYOUT/.test(dash.text));
  assert.ok(!/>Ops</.test(dash.text));
  assert.match(dash.text, /Total cash: <strong>\$0\.00/);
  assert.match(dash.text, /DELTA AIR/); // other accounts unaffected

  const review = await request(app).get('/review').set('Cookie', owner);
  assert.ok(!/UPS FREIGHT/.test(review.text));

  const csv = await request(app).get('/export.csv').set('Cookie', owner);
  assert.ok(!/UPS FREIGHT/.test(csv.text));

  const direct = await request(app).get('/?account=CHK').set('Cookie', owner);
  assert.ok(!/UPS FREIGHT/.test(direct.text)); // can't reach it via the filter either
});

test('hidden accounts are hidden from the member too, and actions on their transactions 404', async () => {
  const { app, db } = makeApp();
  const owner = await login(app, 'michael', 'ownerpass1');
  await hide(app, owner, 'CHK');
  const member = await login(app, 'asst', 'memberpass1');
  assert.ok(!/UPS FREIGHT/.test((await request(app).get('/').set('Cookie', member)).text));
  const res = await request(app).post('/txns/CHK|1/note').set('Cookie', owner).type('form').send({ note: 'x' });
  assert.equal(res.status, 404);
  assert.equal(db.prepare("SELECT note FROM transactions WHERE uid='CHK|1'").get().note, null);
});

test('accounts page still lists a hidden account and un-hiding restores it', async () => {
  const { app, db } = makeApp();
  const owner = await login(app, 'michael', 'ownerpass1');
  await hide(app, owner, 'CHK', { display_name: 'Ops' });
  const page = await request(app).get('/accounts').set('Cookie', owner);
  assert.match(page.text, /Business Checking/);
  assert.match(page.text, /name="hidden" value="1" checked/);

  await request(app).post('/accounts/CHK').set('Cookie', owner).type('form')
    .send({ display_name: 'Ops', visibility: 'company', kind: 'bank' }); // checkbox unticked → absent
  assert.equal(db.prepare("SELECT hidden FROM accounts WHERE id='CHK'").get().hidden, 0);
  assert.match((await request(app).get('/').set('Cookie', owner)).text, /UPS FREIGHT/);
});

test('sync never un-hides an account', async () => {
  const db = openDb(':memory:');
  const payload = () => ({ errors: [], accounts: [{ id: 'A1', name: 'Old Biz', orgName: 'Truist',
    balanceCents: 100, balanceDate: T0, transactions: [] }] });
  await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => payload(), now: () => T0 });
  db.prepare("UPDATE accounts SET hidden = 1 WHERE id='A1'").run();
  await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => payload(), now: () => T0 + 10 });
  assert.equal(db.prepare("SELECT hidden FROM accounts WHERE id='A1'").get().hidden, 1);
});

test('owner editing a rule whose account is hidden keeps the account condition', async () => {
  const { app, db } = makeApp();
  const owner = await login(app, 'michael', 'ownerpass1');
  const fees = db.prepare("SELECT id FROM categories WHERE name='Fees'").get().id;
  db.prepare("INSERT INTO rules (id, position, pattern, account_id, category_id) VALUES (7, 1, 'UPS', 'CHK', ?)").run(fees);
  await hide(app, owner, 'CHK');
  await request(app).post('/rules/7/edit').set('Cookie', owner).type('form')
    .send({ pattern: 'UPS FREIGHT', account_id: '', category_id: String(fees) });
  const r = db.prepare('SELECT * FROM rules WHERE id = 7').get();
  assert.equal(r.pattern, 'UPS FREIGHT');
  assert.equal(r.account_id, 'CHK');
});
