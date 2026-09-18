const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login } = require('./helpers');

function cat(db, name) { return db.prepare('SELECT id FROM categories WHERE name=?').get(name).id; }

test('manual categorization sets source/user and survives; clearing works', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const shipping = cat(db, 'Shipping');
  let res = await request(app).post('/txns/CHK|1/category').set('Cookie', cookie)
    .type('form').send({ category_id: String(shipping) });
  assert.equal(res.status, 302);
  let t = db.prepare("SELECT * FROM transactions WHERE uid='CHK|1'").get();
  assert.equal(t.category_id, shipping);
  assert.equal(t.category_source, 'manual');
  assert.equal(t.categorized_by, db.prepare("SELECT id FROM users WHERE username='michael'").get().id);
  await request(app).post('/txns/CHK|1/category').set('Cookie', cookie).type('form').send({ category_id: '' });
  t = db.prepare("SELECT * FROM transactions WHERE uid='CHK|1'").get();
  assert.equal(t.category_id, null);
  assert.equal(t.category_source, null);
});

test('notes save with attribution', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'asst', 'memberpass1');
  await request(app).post('/txns/AMX|3/note').set('Cookie', cookie).type('form').send({ note: 'Jane conference flight' });
  const t = db.prepare("SELECT * FROM transactions WHERE uid='AMX|3'").get();
  assert.equal(t.note, 'Jane conference flight');
  assert.equal(t.note_by, db.prepare("SELECT id FROM users WHERE username='asst'").get().id);
});

test('member cannot act on private-account transactions (404)', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'asst', 'memberpass1');
  const res = await request(app).post('/txns/PER|4/note').set('Cookie', cookie).type('form').send({ note: 'x' });
  assert.equal(res.status, 404);
  assert.equal(db.prepare("SELECT note FROM transactions WHERE uid='PER|4'").get().note, null);
});

test('make-rule from a private txn creates an owner_only rule; from company txn a shared one', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const other = cat(db, 'Other');
  await request(app).post('/txns/PER|4/make-rule').set('Cookie', cookie)
    .type('form').send({ pattern: 'PERSONAL DINNER', category_id: String(other) });
  const r1 = db.prepare("SELECT * FROM rules WHERE pattern='PERSONAL DINNER'").get();
  assert.equal(r1.owner_only, 1);
  const shipping = cat(db, 'Shipping');
  await request(app).post('/txns/CHK|1/make-rule').set('Cookie', cookie)
    .type('form').send({ pattern: 'UPS', category_id: String(shipping) });
  const r2 = db.prepare("SELECT * FROM rules WHERE pattern='UPS'").get();
  assert.equal(r2.owner_only, 0);
  assert.equal(db.prepare("SELECT category_source FROM transactions WHERE uid='CHK|1'").get().category_source, 'manual');
});

test('review queue lists only visible uncategorized, oldest first', async () => {
  const { app, db } = makeApp();
  const owner = await login(app, 'michael', 'ownerpass1');
  const asst = await login(app, 'asst', 'memberpass1');
  const or = await request(app).get('/review').set('Cookie', owner);
  assert.match(or.text, /PERSONAL DINNER/);
  assert.ok(or.text.indexOf('STRIPE PAYOUT') < or.text.indexOf('UPS FREIGHT')); // older first
  const ar = await request(app).get('/review').set('Cookie', asst);
  assert.ok(!/PERSONAL DINNER/.test(ar.text));
});
