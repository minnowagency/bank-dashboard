const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login } = require('./helpers');
const inv = require('../src/invoices');
const { forecast } = require('../src/recurring');

const DAY = 86400;
const OWNER = { id: 1, role: 'owner' };
const MEMBER = { id: 2, role: 'member' };
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const NOW = Math.floor(Date.UTC(2026, 9, 20, 16) / 1000);   // Tue Oct 20 2026, noon ET

function setup() {
  const { app, db } = makeApp();
  const vendorId = inv.saveVendor(db, { name: 'Acme Supply', terms_days: 30, account_id: 'CHK' }, NOW);
  return { app, db, vendorId };
}

test('due date defaults to invoice date + vendor terms; explicit due date wins', () => {
  const { db, vendorId } = setup();
  const a = inv.saveInvoice(db, OWNER, { vendor_id: vendorId, amount: '1200.00', invoice_date: '2026-10-01' }, NOW);
  assert.equal(iso(db.prepare('SELECT due_date FROM invoices WHERE id = ?').get(a).due_date), '2026-10-31');
  assert.equal(db.prepare('SELECT account_id FROM invoices WHERE id = ?').get(a).account_id, 'CHK', 'vendor default account');
  const b = inv.saveInvoice(db, OWNER, { vendor_id: vendorId, amount: '50', invoice_date: '2026-10-01', due_date: '2026-10-10', account_id: 'CHK' }, NOW);
  assert.equal(iso(db.prepare('SELECT due_date FROM invoices WHERE id = ?').get(b).due_date), '2026-10-10');
  assert.throws(() => inv.saveInvoice(db, OWNER, { vendor_id: vendorId, amount: '0' }, NOW), /amount/i);
  assert.throws(() => inv.saveInvoice(db, OWNER, { vendor_name: '', amount: '5' }, NOW), /vendor/i);
});

test('typing a new vendor name creates it with Net 30; names are case-insensitive', () => {
  const { db } = setup();
  inv.saveInvoice(db, OWNER, { vendor_name: 'acme supply', amount: '10', account_id: 'CHK' }, NOW);
  inv.saveInvoice(db, OWNER, { vendor_name: 'Paper Co', amount: '10', account_id: 'CHK' }, NOW);
  const vs = db.prepare('SELECT name, terms_days FROM vendors ORDER BY name').all().map(v => ({ ...v }));
  assert.deepEqual(vs, [{ name: 'Acme Supply', terms_days: 30 }, { name: 'Paper Co', terms_days: 30 }]);
});

test('open invoices are forecast outflows on their account, in their due week; past due lands in week 1', () => {
  const { db, vendorId } = setup();
  inv.saveInvoice(db, OWNER, { vendor_id: vendorId, amount: '1200', due_date: '2026-11-04', account_id: 'CHK', invoice_number: 'A-77' }, NOW);
  inv.saveInvoice(db, OWNER, { vendor_id: vendorId, amount: '300', due_date: '2026-10-12', account_id: 'CHK' }, NOW);
  const f = forecast(db, OWNER, { now: NOW, accountId: 'CHK' });
  const w = f.accounts[0].weeks;
  const due = w[2].items.find(i => i.cents === 120000);
  assert.ok(due, 'Nov 4 is in the third week starting Oct 20');
  assert.equal(due.name, 'Invoice · Acme Supply #A-77');
  assert.equal(due.kind, 'expense');
  const past = w[0].items.find(i => i.cents === 30000);
  assert.ok(past && past.pastDue);
  assert.equal(w[0].outCents, 30000);
  assert.equal(w[7].balanceCents, 4218010 - 150000, 'balance carries both');
});

test('an invoice that replaces a recurring item removes that item\'s nearest occurrence only', () => {
  const { db, vendorId } = setup();
  db.prepare(`INSERT INTO recurring_items (account_id, merchant_key, display_name, kind, cadence, amount_cents,
    amount_min_cents, amount_max_cents, next_due, status, created_at, updated_at)
    VALUES ('CHK', 'ACME', 'Acme (recurring)', 'expense', 'monthly', 100000, 90000, 110000, ?, 'confirmed', 1, 1)`)
    .run(Math.floor(Date.UTC(2026, 10, 1, 12) / 1000));
  const rid = db.prepare("SELECT id FROM recurring_items WHERE merchant_key='ACME'").get().id;
  inv.saveInvoice(db, OWNER, { vendor_id: vendorId, amount: '1234', due_date: '2026-11-03', account_id: 'CHK', replaces_recurring_id: rid }, NOW);
  const items = forecast(db, OWNER, { now: NOW, accountId: 'CHK' }).accounts[0].weeks.flatMap(w => w.items);
  assert.equal(items.filter(i => i.name === 'Acme (recurring)').length, 1, 'Dec occurrence stays, Nov is replaced');
  assert.equal(iso(items.find(i => i.name === 'Acme (recurring)').date), '2026-12-01');
  assert.equal(items.filter(i => i.name.startsWith('Invoice')).length, 1);
});

test('a matching payment marks the invoice paid and drops it from the forecast; "not this payment" reopens it for good', () => {
  const { db, vendorId } = setup();
  const id = inv.saveInvoice(db, OWNER, { vendor_id: vendorId, amount: '1240.00', invoice_date: '2026-10-15', due_date: '2026-11-14', account_id: 'CHK' }, NOW);
  // fixture CHK|1 is UPS FREIGHT -1240.00 dated 2026-09-09: before the 30-day look-back from Oct 15
  assert.equal(inv.matchPayments(db), 0);
  db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, first_seen_at)
    VALUES ('CHK|pay', 'pay', 'CHK', ?, -124000, 'ACH ACME SUPPLY', ?)`).run(NOW - 2 * DAY, NOW);
  db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, first_seen_at)
    VALUES ('AMX|pay', 'payx', 'AMX', ?, -124000, 'other account', ?)`).run(NOW - 2 * DAY, NOW);
  assert.equal(inv.matchPayments(db), 1);
  const row = { ...db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) };
  assert.equal(row.status, 'paid');
  assert.equal(row.paid_txn_uid, 'CHK|pay', 'same account only');
  assert.equal(forecast(db, OWNER, { now: NOW, accountId: 'CHK' }).accounts[0].weeks.flatMap(w => w.items).length, 0);

  inv.rejectMatch(db, OWNER, id);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(id).status, 'open');
  assert.equal(inv.matchPayments(db), 0, 'the rejected payment is never matched again');
});

test('one payment settles one invoice', () => {
  const { db, vendorId } = setup();
  inv.saveInvoice(db, OWNER, { vendor_id: vendorId, amount: '99', due_date: '2026-10-25', account_id: 'CHK' }, NOW);
  inv.saveInvoice(db, OWNER, { vendor_id: vendorId, amount: '99', due_date: '2026-10-26', account_id: 'CHK' }, NOW);
  db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, first_seen_at)
    VALUES ('CHK|p99', 'p99', 'CHK', ?, -9900, 'ACME', ?)`).run(NOW, NOW);
  assert.equal(inv.matchPayments(db), 1);
  assert.deepEqual(db.prepare('SELECT status FROM invoices ORDER BY due_date').all().map(r => r.status), ['paid', 'open']);
});

test('members: see and add invoices only on accounts they can see', () => {
  const { db, vendorId } = setup();
  db.prepare("INSERT INTO accounts (id, name, kind, visibility) VALUES ('PRV', 'Private Checking', 'bank', 'private')").run();
  inv.saveInvoice(db, OWNER, { vendor_id: vendorId, amount: '10', due_date: '2026-10-30', account_id: 'PRV' }, NOW);
  inv.saveInvoice(db, OWNER, { vendor_id: vendorId, amount: '20', due_date: '2026-10-30', account_id: 'CHK' }, NOW);
  assert.deepEqual(inv.listInvoices(db, MEMBER, NOW).open.map(i => i.amount_cents), [2000]);
  assert.equal(inv.listInvoices(db, OWNER, NOW).open.length, 2);
  assert.throws(() => inv.saveInvoice(db, MEMBER, { vendor_id: vendorId, amount: '5', account_id: 'PRV' }, NOW), /account/i);
  assert.equal(forecast(db, MEMBER, { now: NOW }).accounts.some(a => a.id === 'PRV'), false);
});

test('routes: add, mark paid, void; member can add on a company account; forms are visibility-checked', async () => {
  const { app, db } = setup();
  const owner = await login(app, 'michael', 'ownerpass1');
  const page = await request(app).get('/invoices').set('Cookie', owner);
  assert.equal(page.status, 200);
  assert.match(page.text, /Acme Supply/);
  const soon = new Date(Date.now() + 10 * DAY * 1000).toISOString().slice(0, 10);
  const add = await request(app).post('/invoices').set('Cookie', owner).type('form')
    .send({ vendor_name: 'Acme Supply', amount: '2500.00', due_date: soon, account_id: 'CHK', invoice_number: 'INV-1' });
  assert.equal(add.status, 302);
  const id = db.prepare("SELECT id FROM invoices WHERE invoice_number='INV-1'").get().id;
  assert.match((await request(app).get('/forecast?account=CHK').set('Cookie', owner)).text, /Invoice · Acme Supply #INV-1/);
  await request(app).post(`/invoices/${id}/paid`).set('Cookie', owner);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(id).status, 'paid');

  const member = await login(app, 'asst', 'memberpass1');
  const ok = await request(app).post('/invoices').set('Cookie', member).type('form')
    .send({ vendor_name: 'Paper Co', amount: '40', due_date: soon, account_id: 'CHK' });
  assert.equal(ok.status, 302);
  const bad = await request(app).post('/invoices').set('Cookie', member).type('form')
    .send({ vendor_name: 'Paper Co', amount: '40', due_date: soon, account_id: 'PER' });
  assert.equal(bad.status, 400);
  db.prepare("INSERT INTO accounts (id, name, kind, visibility) VALUES ('PRV', 'Private Checking', 'bank', 'private')").run();
  const priv = inv.saveInvoice(db, OWNER, { vendor_name: 'Secret', amount: '1', due_date: soon, account_id: 'PRV' }, NOW);
  assert.equal((await request(app).post(`/invoices/${priv}/void`).set('Cookie', member)).status, 404);
  assert.doesNotMatch((await request(app).get('/invoices').set('Cookie', member)).text, /Secret/);
});

test('sync post-processing matches invoice payments', async () => {
  const { db, vendorId } = setup();
  const { postProcess } = require('../src/sync');
  inv.saveInvoice(db, OWNER, { vendor_id: vendorId, amount: '77', due_date: iso(Math.floor(Date.now() / 1000)), account_id: 'CHK' }, Math.floor(Date.now() / 1000));
  db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, first_seen_at)
    VALUES ('CHK|p77', 'p77', 'CHK', ?, -7700, 'ACME', ?)`).run(Math.floor(Date.now() / 1000), 1);
  await postProcess(db, {});
  assert.equal(db.prepare('SELECT status FROM invoices').get().status, 'paid');
});
