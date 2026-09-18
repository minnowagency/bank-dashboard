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

test('renaming a category to a name already in use returns 400, not a crash', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const fees = cat(db, 'Fees');
  const res = await request(app).post(`/categories/${fees}/rename`).set('Cookie', cookie).type('form')
    .send({ name: 'Shipping' });
  assert.equal(res.status, 400);
  assert.equal(cat(db, 'Fees'), fees, 'Fees category untouched after rejected rename');
});

test('rule editing: owner updates pattern+category, position unchanged', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const shipping = cat(db, 'Shipping'), fees = cat(db, 'Fees');
  db.prepare("INSERT INTO rules (id, position, pattern, category_id, owner_only) VALUES (5, 3, 'OLD', ?, 0)").run(shipping);
  const res = await request(app).post('/rules/5/edit').set('Cookie', cookie).type('form')
    .send({ pattern: 'NEW', category_id: String(fees) });
  assert.equal(res.status, 302);
  const r = db.prepare('SELECT * FROM rules WHERE id = 5').get();
  assert.equal(r.pattern, 'NEW');
  assert.equal(r.category_id, fees);
  assert.equal(r.position, 3, 'position unchanged by edit');
});

test('member editing an owner_only rule gets 404', async () => {
  const { app, db } = makeApp();
  const fees = cat(db, 'Fees');
  db.prepare("INSERT INTO rules (id, position, pattern, category_id, owner_only) VALUES (6, 1, 'SECRET', ?, 1)").run(fees);
  const cookie = await login(app, 'asst', 'memberpass1');
  const res = await request(app).post('/rules/6/edit').set('Cookie', cookie).type('form')
    .send({ pattern: 'HACKED', category_id: String(fees) });
  assert.equal(res.status, 404);
  assert.equal(db.prepare('SELECT pattern FROM rules WHERE id = 6').get().pattern, 'SECRET');
});

test('editing a shared rule to a private account_id forces owner_only=1', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const fees = cat(db, 'Fees');
  db.prepare("INSERT INTO rules (id, position, pattern, category_id, owner_only) VALUES (7, 1, 'SHARED', ?, 0)").run(fees);
  const res = await request(app).post('/rules/7/edit').set('Cookie', cookie).type('form')
    .send({ pattern: 'SHARED', category_id: String(fees), account_id: 'PER' });
  assert.equal(res.status, 302);
  const r = db.prepare('SELECT * FROM rules WHERE id = 7').get();
  assert.equal(r.account_id, 'PER');
  assert.equal(r.owner_only, 1, 'private account_id forces owner_only=1 on edit');
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

test('rule with private account_id gets owner_only=1 forced; member cannot see account name', async () => {
  const { app, db } = makeApp();
  const owner = await login(app, 'michael', 'ownerpass1');
  const fees = cat(db, 'Fees');
  // owner creates a shared rule (owner_only unchecked) with account_id='PER' (private)
  await request(app).post('/rules').set('Cookie', owner).type('form')
    .send({ pattern: 'TEST', category_id: String(fees), account_id: 'PER' });
  const r = db.prepare("SELECT owner_only FROM rules WHERE pattern='TEST'").get();
  assert.equal(r.owner_only, 1, 'private account forces owner_only=1');
  // member should not see it
  const member = await login(app, 'asst', 'memberpass1');
  const page = await request(app).get('/rules').set('Cookie', member);
  assert.ok(!/TEST/.test(page.text), 'member does not see rule with private account');
  // legacy data: rule with owner_only=0 and account_id='PER'
  db.prepare("INSERT INTO rules (position, pattern, category_id, owner_only, account_id) VALUES (1, 'LEGACY', ?, 0, 'PER')").run(fees);
  const memberPage = await request(app).get('/rules').set('Cookie', member);
  assert.ok(!/Personal Amex/.test(memberPage.text), 'member does not see private account name in rule list');
});

test('rule move is owner-only; member gets 404', async () => {
  const { app, db } = makeApp();
  const fees = cat(db, 'Fees');
  const owner = await login(app, 'michael', 'ownerpass1');
  await request(app).post('/rules').set('Cookie', owner).type('form')
    .send({ pattern: 'SHARED', category_id: String(fees) });
  const r = db.prepare("SELECT id FROM rules WHERE pattern='SHARED'").get();
  const member = await login(app, 'asst', 'memberpass1');
  assert.equal((await request(app).post(`/rules/${r.id}/move`).set('Cookie', member).type('form').send({ dir: 'up' })).status, 404);
});

test('POST /accounts/:id rejects invalid visibility/kind enums', async () => {
  const { app, db } = makeApp();
  const owner = await login(app, 'michael', 'ownerpass1');
  const before = db.prepare("SELECT visibility FROM accounts WHERE id='CHK'").get().visibility;
  const res = await request(app).post('/accounts/CHK').set('Cookie', owner).type('form')
    .send({ display_name: 'Test', visibility: 'bogus', kind: 'credit' });
  assert.equal(res.status, 400);
  const after = db.prepare("SELECT visibility FROM accounts WHERE id='CHK'").get().visibility;
  assert.equal(after, before, 'visibility unchanged after invalid enum');
  const res2 = await request(app).post('/accounts/CHK').set('Cookie', owner).type('form')
    .send({ display_name: 'Test', visibility: 'private', kind: 'bogus' });
  assert.equal(res2.status, 400);
});
