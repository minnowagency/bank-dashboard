const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login, T0 } = require('./helpers');

test('owner dashboard shows all accounts, totals, and private rows', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/?period=all').set('Cookie', cookie);
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
  const res = await request(app).get('/?period=all').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.ok(!/Personal Amex/.test(res.text));
  assert.ok(!/PERSONAL DINNER/.test(res.text));
  assert.match(res.text, /\$18,933\.44/);        // owed excludes private card
});

test('filters flow through querystring', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/?period=all&q=ups').set('Cookie', cookie);
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
    const res = await request(app).get('/?period=all').set('Cookie', cookie);
    assert.match(res.text, /has not synced in over 24 hours/);
    assert.match(res.text, /Connection to Truist may need attention/);
  } finally { Date.now = realNow; }
});

test('member does not see sync error details (privacy)', async () => {
  const { app, db } = makeApp();
  db.prepare('UPDATE accounts SET last_synced_at = ? WHERE id = ?').run(T0 - 3 * 86400, 'CHK');
  db.prepare("INSERT INTO settings (key, value) VALUES ('sync_errors', ?)")
    .run(JSON.stringify(['Connection to Truist may need attention']));
  const realNow = Date.now;
  Date.now = () => T0 * 1000;
  try {
    const cookie = await login(app, 'asst', 'memberpass1');
    const res = await request(app).get('/?period=all').set('Cookie', cookie);
    assert.match(res.text, /not synced in over 24 hours/);
    assert.ok(!/Connection to Truist may need attention/.test(res.text));
  } finally { Date.now = realNow; }
});

test('card tiles show statement balance, minimum and due date; due-soon and paid states', async () => {
  const { app, db } = makeApp();
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO card_statements (account_id, statement_balance_cents, statement_date, minimum_payment_cents,
    due_date, last_payment_cents, last_payment_date, is_overdue, fetched_at) VALUES
    ('AMX', 1893344, ?, 18933, ?, NULL, NULL, 0, ?), ('PER', 50000, ?, 2500, ?, 50000, ?, 0, ?)`)
    .run(now - 20 * day, now + 3 * day, now, now - 20 * day, now + 10 * day, now - 2 * day, now);
  const owner = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/').set('Cookie', owner);
  const tile = (name) => res.text.slice(res.text.indexOf(name), res.text.indexOf('</a>', res.text.indexOf(name)));
  const amx = tile('Amex 91002');
  assert.match(amx, /Statement \$18,933\.44/);
  assert.match(amx, /Min \$189\.33/);
  assert.match(amx, /class="due soon"/);
  const per = tile('Personal Amex');
  assert.match(per, /Paid \$500\.00/);
  assert.doesNotMatch(per, /class="due soon"/);
  // a member never sees a private card's statement
  const member = await login(app, 'asst', 'memberpass1');
  assert.doesNotMatch((await request(app).get('/').set('Cookie', member)).text, /\$500\.00/);
});
