const request = require('supertest');
const { openDb } = require('../src/db');
const { createUser, confirmTotpEnrollment } = require('../src/auth');
const { createApp } = require('../src/app');
const { encrypt } = require('../src/crypto');
const { codeAt, STEP_SECONDS } = require('../src/totp');

const TEST_APP_SECRET = 'b'.repeat(64);
const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const nowSec = () => Math.floor(Date.now() / 1000);
const currentCode = () => codeAt(TEST_TOTP_SECRET, Math.floor(nowSec() / STEP_SECONDS));
const dbs = new WeakMap();   // app -> db, so login() can reset the replay guard

// Gives a user two-factor with the known test secret (as if they had scanned it).
function enrollTotp(db, username, appSecret = TEST_APP_SECRET) {
  db.prepare('UPDATE users SET totp_pending_enc = ? WHERE username = ?').run(encrypt(TEST_TOTP_SECRET, appSecret), username);
  const u = { ...db.prepare('SELECT * FROM users WHERE username = ?').get(username) };
  const r = confirmTotpEnrollment(db, u, currentCode(), appSecret, nowSec());
  if (!r.ok) throw new Error('test enrollment failed');
  return r.recoveryCodes;
}

function registerApp(app, db) { dbs.set(app, db); return app; }

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
  enrollTotp(db, 'michael');
  enrollTotp(db, 'asst');
  return { app: registerApp(createApp(db, { appSecret: TEST_APP_SECRET }), db), db };
}

const cookieNamed = (res, name) => {
  const c = (res.headers['set-cookie'] || []).find(x => x.startsWith(`${name}=`));
  return c ? c.split(';')[0] : null;
};

// Password, then the current authenticator code; returns the session cookie.
async function login(app, username, password) {
  const db = dbs.get(app);
  if (db) db.prepare('UPDATE users SET totp_last_step = NULL WHERE username = ?').run(username);  // as if 30 s had passed
  const res = await request(app).post('/login').type('form').send({ username, password });
  const mfa = cookieNamed(res, 'mfa');
  if (!mfa) throw new Error(`password step failed for ${username}: ${res.status}`);
  const res2 = await request(app).post('/login/2fa').set('Cookie', mfa).type('form').send({ code: currentCode() });
  const cookie = cookieNamed(res2, 'session');
  if (!cookie) throw new Error(`code step failed for ${username}: ${res2.status}`);
  return cookie;
}

module.exports = { makeApp, login, enrollTotp, registerApp, cookieNamed, currentCode, T0,
  TEST_APP_SECRET, TEST_TOTP_SECRET };
