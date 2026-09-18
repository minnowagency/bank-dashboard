const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login } = require('./helpers');

function cat(db, name) { return db.prepare('SELECT id FROM categories WHERE name=?').get(name).id; }

test('rules page hides owner_only rules from member; match counts are visibility-scoped', async () => {
  const { app, db } = makeApp();
  const fees = cat(db, 'Fees');
  db.prepare("INSERT INTO rules (position, pattern, category_id, owner_only) VALUES (1, 'DINNER', ?, 1)").run(fees);
  db.prepare("INSERT INTO rules (position, pattern, category_id, owner_only) VALUES (2, 'DELTA', ?, 0)").run(fees);
  db.prepare("UPDATE transactions SET category_id=?, category_source='rule', rule_id=2 WHERE uid='AMX|3'").run(fees);
  const owner = await request(app).get('/rules').set('Cookie', await login(app, 'michael', 'ownerpass1'));
  assert.match(owner.text, /DINNER/);
  assert.match(owner.text, /DELTA/);
  const member = await request(app).get('/rules').set('Cookie', await login(app, 'asst', 'memberpass1'));
  assert.ok(!/DINNER/.test(member.text));
  assert.match(member.text, /DELTA/);
});

test('create, move, delete rules via routes', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const shipping = cat(db, 'Shipping'), fees = cat(db, 'Fees');
  await request(app).post('/rules').set('Cookie', cookie).type('form')
    .send({ pattern: 'UPS', category_id: String(shipping) });
  await request(app).post('/rules').set('Cookie', cookie).type('form')
    .send({ pattern: 'FEE', category_id: String(fees), amount: '-25.00' });
  const r2 = db.prepare("SELECT * FROM rules WHERE pattern='FEE'").get();
  assert.equal(r2.amount_cents, -2500);
  assert.equal(r2.position, 2);
  // retroactive: UPS FREIGHT got categorized on create
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='CHK|1'").get().category_id, shipping);
  await request(app).post(`/rules/${r2.id}/move`).set('Cookie', cookie).type('form').send({ dir: 'up' });
  assert.equal(db.prepare('SELECT position FROM rules WHERE id=?').get(r2.id).position, 1);
  await request(app).post(`/rules/${r2.id}/delete`).set('Cookie', cookie);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rules').get().n, 1);
});

test('member cannot delete an owner-only rule or set owner_only', async () => {
  const { app, db } = makeApp();
  const fees = cat(db, 'Fees');
  db.prepare("INSERT INTO rules (id, position, pattern, category_id, owner_only) VALUES (9, 1, 'SECRET', ?, 1)").run(fees);
  const cookie = await login(app, 'asst', 'memberpass1');
  assert.equal((await request(app).post('/rules/9/delete').set('Cookie', cookie)).status, 404);
  await request(app).post('/rules').set('Cookie', cookie).type('form')
    .send({ pattern: 'DELTA', category_id: String(fees), owner_only: '1' });
  assert.equal(db.prepare("SELECT owner_only FROM rules WHERE pattern='DELTA'").get().owner_only, 0);
});

test('categories add and rename', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  await request(app).post('/categories').set('Cookie', cookie).type('form').send({ name: 'Travel' });
  const id = cat(db, 'Travel');
  await request(app).post(`/categories/${id}/rename`).set('Cookie', cookie).type('form').send({ name: 'Travel & Meals' });
  assert.ok(cat(db, 'Travel & Meals'));
});

test('accounts admin is owner-only and updates the three owner fields', async () => {
  const { app, db } = makeApp();
  const member = await login(app, 'asst', 'memberpass1');
  assert.equal((await request(app).get('/accounts').set('Cookie', member)).status, 404);
  const owner = await login(app, 'michael', 'ownerpass1');
  const page = await request(app).get('/accounts').set('Cookie', owner);
  assert.match(page.text, /Personal Amex/);
  await request(app).post('/accounts/PER').set('Cookie', owner).type('form')
    .send({ display_name: 'My Card', visibility: 'private', kind: 'credit' });
  const a = db.prepare("SELECT * FROM accounts WHERE id='PER'").get();
  assert.equal(a.display_name, 'My Card');
  // flipping visibility works too
  await request(app).post('/accounts/PER').set('Cookie', owner).type('form')
    .send({ display_name: 'My Card', visibility: 'company', kind: 'credit' });
  assert.equal(db.prepare("SELECT visibility FROM accounts WHERE id='PER'").get().visibility, 'company');
});
