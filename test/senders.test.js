const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { openDb } = require('../src/db');
const { runSync } = require('../src/sync');
const { senderLast4, applySenders } = require('../src/senders');
const { makeApp, login, T0 } = require('./helpers');

test('senderLast4 reads the originating account from Truist wire and transfer formats only', () => {
  assert.equal(senderLast4('WIRE REF# 20260914-00028165 DBT ACCT: XXXXXXXXX6212 FUNDS TRANSFER'), '6212');
  assert.equal(senderLast4('TRUIST ONLINE TRANSFER - FROM *9711'), '9711');
  assert.equal(senderLast4('HYGINIX858-566-6212 CA US'), null, 'a phone number is not a sender');
  assert.equal(senderLast4('TRUIST ONLINE TRANSFER - TO *8743'), null, 'outbound is not a sender');
  assert.equal(senderLast4('GUSTO PAYROLL'), null);
});

function seeded() {
  const { app, db } = makeApp();
  const ins = db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description,
    category_id, category_source, ai_confidence, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const transfers = db.prepare("SELECT id FROM categories WHERE name='Transfers'").get().id;
  const other = db.prepare("SELECT id FROM categories WHERE name='Other'").get().id;
  ins.run('CHK|w1', 'w1', 'CHK', T0, 2500000, 'WIRE REF# 20260914-00028165 DBT ACCT: XXXXXXXXX6212 FUNDS TRANSFER', null, null, null, T0);
  ins.run('CHK|w2', 'w2', 'CHK', T0 - 86400, 1200000, 'WIRE REF# 20260901-00011111 DBT ACCT: XXXXXXXXX6212 FUNDS TRANSFER', transfers, 'ai', 'high', T0);
  ins.run('CHK|w3', 'w3', 'CHK', T0, 500000, 'TRUIST ONLINE TRANSFER - FROM *9711', null, null, null, T0);
  ins.run('CHK|w4', 'w4', 'CHK', T0, 99900, 'WIRE REF# 20260902-00022222 DBT ACCT: XXXXXXXXX6212 FUNDS TRANSFER', other, 'manual', null, T0);
  ins.run('PER|w5', 'w5', 'PER', T0, 700000, 'WIRE REF# 20260903-00033333 DBT ACCT: XXXXXXXXX6212 FUNDS TRANSFER', null, null, null, T0);
  return { app, db };
}

test('applySenders categorizes uncategorized and AI-filed inbound wires, never manual ones', () => {
  const { db } = seeded();
  const revenue = db.prepare("SELECT id FROM categories WHERE name='Revenue'").get().id;
  const other = db.prepare("SELECT id FROM categories WHERE name='Other'").get().id;
  db.prepare("INSERT INTO senders (last4, name, category_id, created_at) VALUES ('6212', 'hppyc', ?, 0)").run(revenue);

  assert.equal(applySenders(db), 3); // w1 (uncategorized), w2 (ai), w5 (uncategorized, other account)
  const get = (uid) => db.prepare('SELECT category_id, category_source FROM transactions WHERE uid=?').get(uid);
  assert.equal(get('CHK|w1').category_id, revenue);
  assert.equal(get('CHK|w1').category_source, 'rule');
  assert.equal(get('CHK|w2').category_id, revenue, 'a human sender label beats the AI');
  assert.equal(get('CHK|w4').category_id, other, 'manual stays');
  assert.equal(get('CHK|w3').category_id, null, 'unlabeled sender untouched');
  assert.equal(applySenders(db), 0, 'idempotent');
});

test('feed rows carry the sender name so the dashboard can say who paid', async () => {
  const { app, db } = seeded();
  const revenue = db.prepare("SELECT id FROM categories WHERE name='Revenue'").get().id;
  db.prepare("INSERT INTO senders (last4, name, category_id, created_at) VALUES ('6212', 'hppyc', ?, 0)").run(revenue);
  const owner = await login(app, 'michael', 'ownerpass1');
  const page = await request(app).get('/?period=all').set('Cookie', owner);
  assert.match(page.text, /from hppyc/);
});

test('POST /senders labels a sender and applies it; visibility and validation hold', async () => {
  const { app, db } = seeded();
  const revenue = db.prepare("SELECT id FROM categories WHERE name='Revenue'").get().id;
  const owner = await login(app, 'michael', 'ownerpass1');

  const res = await request(app).post('/senders').set('Cookie', owner).type('form')
    .send({ last4: '6212', name: 'hppyc', category_id: String(revenue), uid: 'CHK|w1' });
  assert.equal(res.status, 302);
  assert.equal(db.prepare("SELECT name FROM senders WHERE last4='6212'").get().name, 'hppyc');
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='CHK|w2'").get().category_id, revenue);

  // relabel changes the category everywhere except manual rows
  const dist = db.prepare("SELECT id FROM categories WHERE name='Distributions'").get().id;
  await request(app).post('/senders').set('Cookie', owner).type('form')
    .send({ last4: '6212', name: 'hppyc', category_id: String(dist) });
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='CHK|w1'").get().category_id, dist);

  assert.equal((await request(app).post('/senders').set('Cookie', owner).type('form')
    .send({ last4: '12', name: 'x', category_id: String(revenue) })).status, 400);
  assert.equal((await request(app).post('/senders').set('Cookie', owner).type('form')
    .send({ last4: '9711', name: 'x', category_id: '9999' })).status, 400);

  // a member may label senders too, but only from rows they can see
  const member = await login(app, 'asst', 'memberpass1');
  assert.equal((await request(app).post('/senders').set('Cookie', member).type('form')
    .send({ last4: '9711', name: 'RHJL', category_id: String(dist), uid: 'PER|w5' })).status, 404);
  assert.equal((await request(app).post('/senders').set('Cookie', member).type('form')
    .send({ last4: '9711', name: 'RHJL', category_id: String(dist), uid: 'CHK|w3' })).status, 302);

  const del = await request(app).post('/senders/9711/delete').set('Cookie', owner);
  assert.equal(del.status, 302);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM senders WHERE last4='9711'").get().n, 0);
});

test('the rules page lists senders and the row detail offers the sender form on inbound wires', async () => {
  const { app, db } = seeded();
  const revenue = db.prepare("SELECT id FROM categories WHERE name='Revenue'").get().id;
  db.prepare("INSERT INTO senders (last4, name, category_id, created_at) VALUES ('6212', 'hppyc', ?, 0)").run(revenue);
  const owner = await login(app, 'michael', 'ownerpass1');
  const rules = await request(app).get('/rules').set('Cookie', owner);
  assert.match(rules.text, /\*6212/);
  assert.match(rules.text, /hppyc/);
  // the unlabeled sending account gets an inline label form on the Rules page
  assert.match(rules.text, /<strong>\*9711<\/strong>/);
  assert.match(rules.text, /id="us-9711"/);
  assert.ok(!/id="us-6212"/.test(rules.text), 'labeled senders are not offered again');
  const dash = await request(app).get('/?period=all').set('Cookie', owner);
  assert.match(dash.text, /name="last4" value="9711"/);  // unlabeled wire offers the form
  assert.match(dash.text, /name="note"/);                // note form is back in the row detail
  // the labeled sender's own category is preselected, so "Update sender" can't silently relabel it
  const revenueId = revenue;
  const labeledForm = dash.text.split('name="last4" value="6212"')[1].split('</form>')[0];
  assert.match(labeledForm, new RegExp(`<option value="${revenueId}" selected`));
  const unlabeledForm = dash.text.split('name="last4" value="9711"')[1].split('</form>')[0];
  assert.match(unlabeledForm, new RegExp(`<option value="${revenueId}" selected`));
});

test('sync applies sender labels before rules and AI', async () => {
  const db = openDb(':memory:');
  const revenue = db.prepare("SELECT id FROM categories WHERE name='Revenue'").get().id;
  db.prepare("INSERT INTO senders (last4, name, category_id, created_at) VALUES ('6212', 'hppyc', ?, 0)").run(revenue);
  const payload = () => ({ errors: [], accounts: [{ id: 'A1', name: 'Checking', orgName: 'Truist', balanceCents: 1, balanceDate: T0,
    transactions: [{ id: 'x', postedAt: T0, amountCents: 100000, description: 'WIRE REF# 1-2 DBT ACCT: XXXXXXXXX6212 FUNDS TRANSFER', pending: 0, cardMember: null }] }] });
  let aiSaw = null;
  await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => payload(), now: () => T0,
    aiCategorizeFn: async (d) => { aiSaw = d.prepare("SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL").get().n; return null; } });
  assert.equal(aiSaw, 0, 'nothing left for the AI once the sender label applied');
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='A1|x'").get().category_id, revenue);
});
