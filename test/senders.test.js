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
  db.prepare("INSERT INTO senders (last4, account_id, name, category_id, created_at) VALUES ('6212', 'CHK', 'hppyc', ?, 0)").run(revenue);

  assert.equal(applySenders(db), 2); // w1 (uncategorized), w2 (ai); w5 is into PER, which has no label
  const get = (uid) => db.prepare('SELECT category_id, category_source FROM transactions WHERE uid=?').get(uid);
  assert.equal(get('CHK|w1').category_id, revenue);
  assert.equal(get('CHK|w1').category_source, 'rule');
  assert.equal(get('CHK|w2').category_id, revenue, 'a human sender label beats the AI');
  assert.equal(get('CHK|w4').category_id, other, 'manual stays');
  assert.equal(get('CHK|w3').category_id, null, 'unlabeled sender untouched');
  assert.equal(get('PER|w5').category_id, null, 'same sender into another company is a separate label');
  assert.equal(applySenders(db), 0, 'idempotent');
});

test('feed rows carry the sender name so the dashboard can say who paid', async () => {
  const { app, db } = seeded();
  const revenue = db.prepare("SELECT id FROM categories WHERE name='Revenue'").get().id;
  db.prepare("INSERT INTO senders (last4, account_id, name, category_id, created_at) VALUES ('6212', 'CHK', 'hppyc', ?, 0)").run(revenue);
  const owner = await login(app, 'michael', 'ownerpass1');
  const page = await request(app).get('/?period=all').set('Cookie', owner);
  assert.match(page.text, /from hppyc/);
});

test('POST /senders labels a sender and applies it; visibility and validation hold', async () => {
  const { app, db } = seeded();
  const revenue = db.prepare("SELECT id FROM categories WHERE name='Revenue'").get().id;
  const owner = await login(app, 'michael', 'ownerpass1');

  const res = await request(app).post('/senders').set('Cookie', owner).type('form')
    .send({ last4: '6212', account_id: 'CHK', name: 'hppyc', category_id: String(revenue) });
  assert.equal(res.status, 302);
  assert.equal(db.prepare("SELECT name FROM senders WHERE last4='6212' AND account_id='CHK'").get().name, 'hppyc');
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='CHK|w2'").get().category_id, revenue);
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='PER|w5'").get().category_id, null,
    'the same sender into another company is not affected');

  // same sender into the other company can mean something else
  const dist = db.prepare("SELECT id FROM categories WHERE name='Distributions'").get().id;
  await request(app).post('/senders').set('Cookie', owner).type('form')
    .send({ last4: '6212', account_id: 'PER', name: 'hppyc', category_id: String(dist) });
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='PER|w5'").get().category_id, dist);
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='CHK|w1'").get().category_id, revenue);

  // relabel changes the category everywhere for that pair except manual rows
  await request(app).post('/senders').set('Cookie', owner).type('form')
    .send({ last4: '6212', account_id: 'CHK', name: 'hppyc', category_id: String(dist) });
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='CHK|w1'").get().category_id, dist);

  assert.equal((await request(app).post('/senders').set('Cookie', owner).type('form')
    .send({ last4: '12', account_id: 'CHK', name: 'x', category_id: String(revenue) })).status, 400);
  assert.equal((await request(app).post('/senders').set('Cookie', owner).type('form')
    .send({ last4: '9711', account_id: 'CHK', name: 'x', category_id: '9999' })).status, 400);

  // a member may label senders too, but only into accounts they can see
  const member = await login(app, 'asst', 'memberpass1');
  assert.equal((await request(app).post('/senders').set('Cookie', member).type('form')
    .send({ last4: '9711', account_id: 'PER', name: 'RHJL', category_id: String(dist) })).status, 404);
  assert.equal((await request(app).post('/senders').set('Cookie', member).type('form')
    .send({ last4: '9711', account_id: 'CHK', name: 'RHJL', category_id: String(dist) })).status, 302);

  assert.equal((await request(app).post('/senders/9711/PER/delete').set('Cookie', member)).status, 404);
  const del = await request(app).post('/senders/9711/CHK/delete').set('Cookie', owner);
  assert.equal(del.status, 302);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM senders WHERE last4='9711'").get().n, 0);
});

test('the rules page lists senders and the row detail offers the sender form on inbound wires', async () => {
  const { app, db } = seeded();
  const revenue = db.prepare("SELECT id FROM categories WHERE name='Revenue'").get().id;
  db.prepare("INSERT INTO senders (last4, account_id, name, category_id, created_at) VALUES ('6212', 'CHK', 'hppyc', ?, 0)").run(revenue);
  const owner = await login(app, 'michael', 'ownerpass1');
  const rules = await request(app).get('/rules').set('Cookie', owner);
  assert.match(rules.text, /\*6212/);
  assert.match(rules.text, /hppyc/);
  // unlabeled (sender, receiver) pairs get an inline label form on the Rules page
  assert.match(rules.text, /id="us-9711-CHK"/);
  assert.ok(!/id="us-6212-CHK"/.test(rules.text), 'labeled pairs are not offered again');
  assert.match(rules.text, /id="us-6212-PER"/, 'the same sender into another company still needs a label');
  assert.match(rules.text, /name="name" value="hppyc"/, 'the known name is prefilled for the new pair');
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
  db.prepare("INSERT INTO accounts (id, name) VALUES ('A1', 'Checking')").run();
  db.prepare("INSERT INTO senders (last4, account_id, name, category_id, created_at) VALUES ('6212', 'A1', 'hppyc', ?, 0)").run(revenue);
  const payload = () => ({ errors: [], accounts: [{ id: 'A1', name: 'Checking', orgName: 'Truist', balanceCents: 1, balanceDate: T0,
    transactions: [{ id: 'x', postedAt: T0, amountCents: 100000, description: 'WIRE REF# 1-2 DBT ACCT: XXXXXXXXX6212 FUNDS TRANSFER', pending: 0, cardMember: null }] }] });
  let aiSaw = null;
  await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => payload(), now: () => T0,
    aiCategorizeFn: async (d) => { aiSaw = d.prepare("SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL").get().n; return null; } });
  assert.equal(aiSaw, 0, 'nothing left for the AI once the sender label applied');
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='A1|x'").get().category_id, revenue);
});

test('an old single-key senders table is expanded to one label per receiving account', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(os.tmpdir(), `bd-senders-migrate-${process.pid}.sqlite3`);
  fs.rmSync(file, { force: true });
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    INSERT INTO categories (name) VALUES ('Revenue');
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO accounts (id, name) VALUES ('CHK','a'),('SMF','b'),('X','c');
    CREATE TABLE transactions (uid TEXT PRIMARY KEY, sf_id TEXT NOT NULL, account_id TEXT NOT NULL, posted_at INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL, description TEXT NOT NULL, category_id INTEGER,
      category_source TEXT CHECK (category_source IN ('rule','manual','transfer','ai')), first_seen_at INTEGER NOT NULL);
    INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, first_seen_at)
      VALUES ('CHK|1','1','CHK',0,100,'WIRE REF# 1-2 DBT ACCT: XXXXXXXXX6212 FUNDS TRANSFER',0),
             ('SMF|2','2','SMF',0,100,'TRUIST ONLINE TRANSFER - FROM *6212',0),
             ('X|3','3','X',0,100,'NOT A WIRE',0);
    CREATE TABLE senders (last4 TEXT PRIMARY KEY, name TEXT NOT NULL, category_id INTEGER NOT NULL, created_by INTEGER, created_at INTEGER NOT NULL);
    INSERT INTO senders VALUES ('6212','hppyc',1,NULL,0);`);
  legacy.close();
  const db = openDb(file);
  const rows = db.prepare('SELECT last4, account_id, name FROM senders ORDER BY account_id').all().map(r => ({ ...r }));
  assert.deepEqual(rows, [{ last4: '6212', account_id: 'CHK', name: 'hppyc' }, { last4: '6212', account_id: 'SMF', name: 'hppyc' }]);
  db.close();
  openDb(file).close();
  fs.rmSync(file, { force: true });
});
