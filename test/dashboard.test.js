const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login, T0 } = require('./helpers');

test('owner dashboard shows all accounts, totals, and private rows', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Ops/);                 // display_name preferred
  assert.match(res.text, /Personal Amex/);       // owner sees private
  assert.match(res.text, /PERSONAL DINNER/);
  assert.match(res.text, /\$42,180\.10/);        // total cash
  assert.match(res.text, /\$19,433\.44/);        // total owed (both cards)
});

test('member dashboard: private account absent everywhere', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'asst', 'memberpass1');
  const res = await request(app).get('/').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.ok(!/Personal Amex/.test(res.text));
  assert.ok(!/PERSONAL DINNER/.test(res.text));
  assert.match(res.text, /\$18,933\.44/);        // owed excludes private card
});

test('filters flow through querystring', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/?q=ups').set('Cookie', cookie);
  assert.match(res.text, /UPS FREIGHT/);
  assert.ok(!/STRIPE PAYOUT/.test(res.text));
});

test('stale accounts produce a warning banner', async () => {
  const { app, db } = makeApp();
  db.prepare('UPDATE accounts SET last_synced_at = ? WHERE id = ?').run(T0 - 3 * 86400, 'CHK');
  db.prepare("INSERT INTO settings (key, value) VALUES ('sync_errors', ?)")
    .run(JSON.stringify(['Connection to Truist may need attention']));
  const realNow = Date.now;
  Date.now = () => T0 * 1000; // freeze time so staleness is deterministic
  try {
    const cookie = await login(app, 'michael', 'ownerpass1');
    const res = await request(app).get('/').set('Cookie', cookie);
    assert.match(res.text, /has not synced in over 24 hours/);
    assert.match(res.text, /Connection to Truist may need attention/);
  } finally { Date.now = realNow; }
});
