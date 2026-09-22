const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login } = require('./helpers');

test('partial=1 returns just the overview fragment, with the same rows', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const full = await request(app).get('/?period=all').set('Cookie', cookie);
  const part = await request(app).get('/?period=all&partial=1').set('Cookie', cookie);

  assert.equal(part.status, 200);
  assert.ok(!/<nav|<!DOCTYPE/i.test(part.text), 'fragment must not include page chrome');
  assert.match(part.text, /UPS FREIGHT/);
  assert.match(full.text, /UPS FREIGHT/);
  assert.match(full.text, /<nav/);
});

test('the period chips and account tiles are plain links that work without JavaScript', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/?period=all').set('Cookie', cookie);
  assert.match(res.text, /href="\/\?period=this-month"/);
  assert.match(res.text, /class="tile[^"]*"\s+href="\/\?period=all&amp;account=CHK"/);

  // following a tile link filters the feed
  const filtered = await request(app).get('/?period=all&account=AMX').set('Cookie', cookie);
  assert.match(filtered.text, /DELTA AIR/);
  assert.ok(!/UPS FREIGHT/.test(filtered.text));
});

test('the feed groups by day and puts pending first', async () => {
  const { app, db } = makeApp();
  db.prepare("UPDATE transactions SET pending = 1 WHERE uid = 'AMX|3'").run();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/?period=all').set('Cookie', cookie);
  assert.match(res.text, /class="day">Pending</);
  assert.ok(res.text.indexOf('Pending') < res.text.indexOf('UPS FREIGHT'), 'pending group leads the feed');
});

test('categorizing in-row answers JSON when asked, and still redirects for a form post', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const supplies = db.prepare("SELECT id FROM categories WHERE name='Supplies'").get().id;

  const json = await request(app).post('/txns/CHK|1/category').set('Cookie', cookie)
    .set('Accept', 'application/json').type('form').send({ category_id: String(supplies) });
  assert.equal(json.status, 200);
  assert.deepEqual(json.body, { ok: true, uid: 'CHK|1', category_id: supplies, category_name: 'Supplies' });

  const form = await request(app).post('/txns/CHK|2/category').set('Cookie', cookie)
    .type('form').send({ category_id: String(supplies) });
  assert.equal(form.status, 302);
});

test('bulk categorize applies to many rows at once', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const fees = db.prepare("SELECT id FROM categories WHERE name='Fees'").get().id;

  const res = await request(app).post('/txns/bulk-category').set('Cookie', cookie)
    .type('form').send({ category_id: String(fees), uids: ['CHK|1', 'CHK|2', 'AMX|3'] });
  assert.equal(res.status, 302);
  const rows = db.prepare("SELECT category_id, category_source, categorized_by FROM transactions WHERE uid IN ('CHK|1','CHK|2','AMX|3')").all();
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.category_id, fees);
    assert.equal(r.category_source, 'manual');
    assert.ok(r.categorized_by);
  }
});

test('bulk categorize skips rows the user cannot see and rejects a bad category', async () => {
  const { app, db } = makeApp();
  const member = await login(app, 'asst', 'memberpass1');
  const fees = db.prepare("SELECT id FROM categories WHERE name='Fees'").get().id;

  const res = await request(app).post('/txns/bulk-category').set('Cookie', member)
    .set('Accept', 'application/json').type('form')
    .send({ category_id: String(fees), uids: ['CHK|1', 'PER|4'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, 1, 'only the visible row is categorized');
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='PER|4'").get().category_id, null);

  const bad = await request(app).post('/txns/bulk-category').set('Cookie', member)
    .type('form').send({ category_id: '9999', uids: ['CHK|1'] });
  assert.equal(bad.status, 400);
});

test('bulk categorize never overwrites a category that is already set', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const fees = db.prepare("SELECT id FROM categories WHERE name='Fees'").get().id;
  const other = db.prepare("SELECT id FROM categories WHERE name='Other'").get().id;
  db.prepare("UPDATE transactions SET category_id=?, category_source='manual' WHERE uid='CHK|1'").run(other);

  await request(app).post('/txns/bulk-category').set('Cookie', cookie)
    .type('form').send({ category_id: String(fees), uids: ['CHK|1'] });
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='CHK|1'").get().category_id, other);
});

test('review page offers bulk selection and a no-JavaScript fallback', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/review').set('Cookie', cookie);
  assert.match(res.text, /id="bulkform"/);
  assert.match(res.text, /name="uids"/);
  assert.match(res.text, /<noscript>/);
});

test('the summary strip shows in, out and net for the period', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/?period=all').set('Cookie', cookie);
  assert.match(res.text, /\$6,801\.22/);   // in
  assert.match(res.text, /\$1,419\.99/);   // out: 1240.00 + 80.00 + 99.99
});
