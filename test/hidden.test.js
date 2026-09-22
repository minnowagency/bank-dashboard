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

  const dash = await request(app).get('/?period=all').set('Cookie', owner);
  assert.ok(!/UPS FREIGHT/.test(dash.text));
  assert.ok(!/STRIPE PAYOUT/.test(dash.text));
  assert.ok(!/>Ops</.test(dash.text));
  assert.match(dash.text, /Cash on hand \$0\.00/);
  assert.match(dash.text, /DELTA AIR/); // other accounts unaffected

  const review = await request(app).get('/review').set('Cookie', owner);
  assert.ok(!/UPS FREIGHT/.test(review.text));

  const csv = await request(app).get('/export.csv').set('Cookie', owner);
  assert.ok(!/UPS FREIGHT/.test(csv.text));

  const direct = await request(app).get('/?period=all&account=CHK').set('Cookie', owner);
  assert.ok(!/UPS FREIGHT/.test(direct.text)); // can't reach it via the filter either
});

test('hidden accounts are hidden from the member too, and actions on their transactions 404', async () => {
  const { app, db } = makeApp();
  const owner = await login(app, 'michael', 'ownerpass1');
  await hide(app, owner, 'CHK');
  const member = await login(app, 'asst', 'memberpass1');
  assert.ok(!/UPS FREIGHT/.test((await request(app).get('/?period=all').set('Cookie', member)).text));
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
  assert.match((await request(app).get('/?period=all').set('Cookie', owner)).text, /UPS FREIGHT/);
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

test('one-time repair unpairs bank-to-bank transfers and resets AI-filed inbound Transfers', () => {
  const { makeApp } = require('./helpers');
  const { db } = makeApp();
  const transfers = db.prepare("SELECT id FROM categories WHERE name='Transfers'").get().id;
  const other = db.prepare("SELECT id FROM categories WHERE name='Other'").get().id;
  db.prepare("INSERT INTO accounts (id, name, kind, visibility) VALUES ('SAV', 'Other Co', 'bank', 'company')").run();
  const ins = db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description,
    category_id, category_source, transfer_pair_uid, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
  ins.run('CHK|a', 'a', 'CHK', T0, -100000, 'WIRE OUT', transfers, 'transfer', 'SAV|b');   // bank<->bank: undo
  ins.run('SAV|b', 'b', 'SAV', T0, 100000, 'WIRE IN', transfers, 'transfer', 'CHK|a');
  ins.run('CHK|c', 'c', 'CHK', T0, -50000, 'AMEX EPAYMENT', transfers, 'transfer', 'AMX|d'); // bank<->credit: keep
  ins.run('AMX|d', 'd', 'AMX', T0, 50000, 'PAYMENT THANK YOU', transfers, 'transfer', 'CHK|c');
  ins.run('CHK|e', 'e', 'CHK', T0, 2500000, 'WIRE REF 1 HPPYC', transfers, 'ai', null);        // ai inbound: reset
  ins.run('CHK|f', 'f', 'CHK', T0, 2500000, 'WIRE REF 2 HPPYC', transfers, 'manual', null);    // manual: keep
  ins.run('CHK|g', 'g', 'CHK', T0, -700, 'FEE', other, 'ai', null);                            // unrelated: keep
  db.prepare("DELETE FROM settings WHERE key = 'migration:intercompany-transfers'").run();

  const { repairIntercompanyTransfers } = require('../src/db');
  repairIntercompanyTransfers(db);
  // spread: node:sqlite rows have a null prototype, which strict deepEqual rejects
  const get = (uid) => ({ ...db.prepare('SELECT category_id, category_source, transfer_pair_uid FROM transactions WHERE uid=?').get(uid) });
  assert.deepEqual(get('CHK|a'), { category_id: null, category_source: null, transfer_pair_uid: null });
  assert.deepEqual(get('SAV|b'), { category_id: null, category_source: null, transfer_pair_uid: null });
  assert.equal(get('CHK|c').transfer_pair_uid, 'AMX|d');
  assert.equal(get('CHK|e').category_id, null);
  assert.equal(get('CHK|f').category_id, transfers);
  assert.equal(get('CHK|g').category_id, other);
  repairIntercompanyTransfers(db); // second call is a no-op
  assert.equal(get('CHK|c').transfer_pair_uid, 'AMX|d');
});
