const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login } = require('./helpers');

test('export.csv respects filters and visibility, escapes fields', async () => {
  const { app, db } = makeApp();
  db.prepare(`UPDATE transactions SET note = 'has, comma and "quote"' WHERE uid = 'CHK|1'`).run();
  const owner = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/export.csv').set('Cookie', owner);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /attachment/);
  const lines = res.text.trim().split('\n');
  assert.equal(lines[0], 'date,description,account,card_member,category,amount,pending,note');
  assert.equal(lines.length, 5); // header + 4 txns for owner
  assert.match(res.text, /-1240\.00/);
  assert.match(res.text, /"has, comma and ""quote"""/);

  const member = await login(app, 'asst', 'memberpass1');
  const mres = await request(app).get('/export.csv').set('Cookie', member);
  assert.equal(mres.text.trim().split('\n').length, 4); // header + 3 (no private)
  assert.ok(!/PERSONAL DINNER/.test(mres.text));

  const filtered = await request(app).get('/export.csv?q=ups').set('Cookie', owner);
  assert.equal(filtered.text.trim().split('\n').length, 2);
});

test('export.csv neutralizes CSV formula injection in text fields but not the amount column', async () => {
  const { app, db } = makeApp();
  db.prepare(`UPDATE transactions SET note = '=SUM(A1)' WHERE uid = 'CHK|1'`).run();
  const owner = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/export.csv').set('Cookie', owner);
  assert.equal(res.status, 200);
  const line = res.text.split('\n').find(l => l.includes('UPS FREIGHT'));
  assert.ok(line, 'expected the UPS FREIGHT row in the export');
  assert.match(line, /'=SUM\(A1\)/);
  assert.match(line, /(?<!')-1240\.00/);
});
