const request = require('supertest');
const { openDb } = require('../src/db');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/app');

const T0 = 1789000000;

function makeApp() {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'ownerpass1', 'owner');
  createUser(db, 'asst', 'memberpass1', 'member');
  db.prepare(`INSERT INTO accounts (id, name, display_name, kind, visibility, balance_cents, last_synced_at) VALUES
    ('CHK', 'Business Checking', 'Ops',  'bank',   'company', 4218010, ${T0}),
    ('AMX', 'Amex 91002',        NULL,   'credit', 'company', -1893344, ${T0}),
    ('PER', 'Personal Amex',     NULL,   'credit', 'private',  -50000, ${T0})`).run();
  const ins = db.prepare(`INSERT INTO transactions
    (uid, sf_id, account_id, posted_at, amount_cents, description, card_member, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run('CHK|1', '1', 'CHK', T0,        -124000, 'UPS FREIGHT',     null,       T0);
  ins.run('CHK|2', '2', 'CHK', T0 - 86400, 680122, 'STRIPE PAYOUT',   null,       T0);
  ins.run('AMX|3', '3', 'AMX', T0,          -8000, 'DELTA AIR',       'JANE DOE', T0);
  ins.run('PER|4', '4', 'PER', T0,          -9999, 'PERSONAL DINNER', null,       T0);
  return { app: createApp(db), db };
}

async function login(app, username, password) {
  const res = await request(app).post('/login').type('form').send({ username, password });
  const cookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('session='));
  if (!cookie) throw new Error(`login failed for ${username}: ${res.status}`);
  return cookie.split(';')[0];
}

module.exports = { makeApp, login, T0 };
