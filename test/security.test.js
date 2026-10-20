const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/app');
const { createFailureLimiter } = require('../src/security');
const { codeAt, STEP_SECONDS } = require('../src/totp');
const { makeApp, login, cookieNamed, currentCode, registerApp, enrollTotp, TEST_APP_SECRET } = require('./helpers');

const password = (app, username, pw) => request(app).post('/login').type('form').send({ username, password: pw });

test('a correct password alone never yields a session when 2FA is on', async () => {
  const { app } = makeApp();
  const res = await password(app, 'michael', 'ownerpass1');
  assert.equal(cookieNamed(res, 'session'), null);
  const mfa = cookieNamed(res, 'mfa');
  // the challenge cookie is not a session
  assert.equal((await request(app).get('/').set('Cookie', mfa.replace(/^mfa=/, 'session='))).status, 302);
  const bad = await request(app).post('/login/2fa').set('Cookie', mfa).type('form').send({ code: '000000' === currentCode() ? '111111' : '000000' });
  assert.equal(bad.status, 401);
  assert.equal(cookieNamed(bad, 'session'), null);
});

test('2FA step: correct code signs in; the same code cannot be reused; no challenge → back to password', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  assert.equal((await request(app).get('/').set('Cookie', cookie)).status, 200);
  // replay the code that was just used, in a fresh challenge
  const mfa = cookieNamed(await password(app, 'michael', 'ownerpass1'), 'mfa');
  const step = db.prepare("SELECT totp_last_step FROM users WHERE username='michael'").get().totp_last_step;
  const replay = await request(app).post('/login/2fa').set('Cookie', mfa).type('form').send({ code: codeAt(require('./helpers').TEST_TOTP_SECRET, step) });
  assert.equal(replay.status, 401);
  assert.equal((await request(app).get('/login/2fa')).headers.location, '/login');
  assert.equal((await request(app).post('/login/2fa').type('form').send({ code: currentCode() })).status, 401);
});

test('a recovery code signs in once and lands on the security page', async () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'ownerpass1', 'owner');
  const codes = enrollTotp(db, 'michael');
  const app = registerApp(createApp(db, { appSecret: TEST_APP_SECRET }), db);
  const mfa = cookieNamed(await password(app, 'michael', 'ownerpass1'), 'mfa');
  const ok = await request(app).post('/login/2fa').set('Cookie', mfa).type('form').send({ code: codes[0] });
  assert.equal(ok.headers.location, '/account/security?used=recovery');
  const page = await request(app).get('/account/security?used=recovery').set('Cookie', cookieNamed(ok, 'session'));
  assert.match(page.text, /signed in with a recovery code/);
  assert.match(page.text, /<strong>9<\/strong> unused recovery codes/);
  const mfa2 = cookieNamed(await password(app, 'michael', 'ownerpass1'), 'mfa');
  assert.equal((await request(app).post('/login/2fa').set('Cookie', mfa2).type('form').send({ code: codes[0] })).status, 401);
});

test('wrong codes count toward the account lockout', async () => {
  const { app, db } = makeApp();
  for (let i = 0; i < 5; i++) {
    const mfa = cookieNamed(await password(app, 'asst', 'memberpass1'), 'mfa');
    if (!mfa) break;
    await request(app).post('/login/2fa').set('Cookie', mfa).type('form').send({ code: 'zzzzz-zzzzz' });
  }
  assert.ok(db.prepare("SELECT locked_until FROM users WHERE username='asst'").get().locked_until > 0);
  assert.equal((await password(app, 'asst', 'memberpass1')).status, 401);
});

test('without 2FA a user is confined to enrollment; enrolling shows recovery codes once and ends other sessions', async () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'ownerpass1', 'owner');
  const app = createApp(db, { appSecret: TEST_APP_SECRET });
  const first = await password(app, 'michael', 'ownerpass1');
  assert.equal(first.headers.location, '/account/security');
  const cookie = cookieNamed(first, 'session');
  const other = cookieNamed(await password(app, 'michael', 'ownerpass1'), 'session');
  for (const p of ['/', '/rules', '/connections', '/export.csv']) {
    const r = await request(app).get(p).set('Cookie', cookie);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.location, '/account/security', p);
  }
  assert.equal((await request(app).post('/rules').set('Cookie', cookie).type('form').send({ pattern: 'x' })).headers.location, '/account/security');

  const page = await request(app).get('/account/security').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<svg[^>]*viewBox/);
  const key = /<code class="secret">([A-Z2-7 ]+)<\/code>/.exec(page.text)[1].replace(/ /g, '');
  assert.equal(key.length, 32);
  assert.equal((await request(app).post('/account/security/enable').set('Cookie', cookie).type('form').send({ code: '12' })).status, 400);
  const code = codeAt(key, Math.floor(Date.now() / 1000 / STEP_SECONDS));
  const done = await request(app).post('/account/security/enable').set('Cookie', cookie).type('form').send({ code });
  assert.equal(done.status, 200);
  const shown = /<pre class="recovery-codes">([\s\S]*?)<\/pre>/.exec(done.text)[1].trim().split('\n');
  assert.equal(shown.length, 10);
  assert.equal((await request(app).get('/').set('Cookie', cookie)).status, 200, 'this session continues');
  assert.equal((await request(app).get('/').set('Cookie', other)).status, 302, 'other sessions signed out');
  assert.doesNotMatch((await request(app).get('/account/security').set('Cookie', cookie)).text, /class="recovery-codes"/, "codes not shown again");
});

test('enrollment without APP_SECRET explains instead of failing', async () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'ownerpass1', 'owner');
  const app = createApp(db, {});
  const cookie = cookieNamed(await password(app, 'michael', 'ownerpass1'), 'session');
  const page = await request(app).get('/account/security').set('Cookie', cookie);
  assert.equal(page.status, 503);
  assert.match(page.text, /APP_SECRET/);
});

test('regenerating recovery codes needs a current code', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  assert.equal((await request(app).post('/account/security/recovery-codes').set('Cookie', cookie).type('form').send({ code: '1' })).status, 400);
  db.prepare("UPDATE users SET totp_last_step = NULL WHERE username='michael'").run();
  const ok = await request(app).post('/account/security/recovery-codes').set('Cookie', cookie).type('form').send({ code: currentCode() });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /class="recovery-codes"/);
});

test('security headers on every response; no X-Powered-By; authenticated pages are not cached', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  for (const res of [await request(app).get('/login'), await request(app).get('/').set('Cookie', cookie)]) {
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' https:\/\/cdn\.plaid\.com(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['strict-transport-security'], /max-age=31536000/);
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
});

test('no view contains inline script or inline event handlers (CSP would block them)', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src', 'views');
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)[^>]*>/, `${f}: inline <script>`);
    assert.doesNotMatch(text, /\son(click|submit|change|input|load|keyup|keydown)\s*=/i, `${f}: inline handler`);
  }
});

test('cross-origin POSTs are refused; same-origin and Origin-less POSTs pass', async () => {
  const { app } = makeApp();
  const evil = await request(app).post('/login').set('Origin', 'https://evil.example').type('form').send({ username: 'michael', password: 'ownerpass1' });
  assert.equal(evil.status, 403);
  const same = await request(app).post('/login').set('Host', 'bank.ts.net').set('Origin', 'https://bank.ts.net').type('form').send({ username: 'michael', password: 'ownerpass1' });
  assert.equal(same.status, 302);
  const fwd = await request(app).post('/login').set('Host', '127.0.0.1:3000').set('X-Forwarded-Host', 'bank.ts.net').set('Origin', 'https://bank.ts.net').type('form').send({ username: 'michael', password: 'ownerpass1' });
  assert.equal(fwd.status, 302);
});

test('per-client limiter: 10 failures in 15 minutes blocks that client, even with the right password', async () => {
  let t = 1000;
  const limiter = createFailureLimiter({ now: () => t });
  const db = openDb(':memory:');
  createUser(db, 'michael', 'ownerpass1', 'owner');
  enrollTotp(db, 'michael');
  const app = createApp(db, { appSecret: TEST_APP_SECRET, limiter });
  for (let i = 0; i < 10; i++) await password(app, `nobody${i}`, 'x');  // unknown users: no account lockout
  const blocked = await password(app, 'michael', 'ownerpass1');
  assert.equal(blocked.status, 429);
  assert.match(blocked.text, /Too many failed attempts/);
  t += 15 * 60 + 1;
  assert.equal((await password(app, 'michael', 'ownerpass1')).status, 302);
});

test('limiter keys on the X-Forwarded-For client only when the proxy is local', async () => {
  const limiter = createFailureLimiter({ max: 2 });
  const db = openDb(':memory:');
  createUser(db, 'michael', 'ownerpass1', 'owner');
  const app = createApp(db, { appSecret: TEST_APP_SECRET, limiter });
  for (let i = 0; i < 2; i++) await password(app, 'nobody', 'x').set('X-Forwarded-For', '100.64.0.5');
  assert.equal((await password(app, 'nobody', 'x').set('X-Forwarded-For', '100.64.0.5')).status, 429);
  assert.equal((await password(app, 'nobody', 'x').set('X-Forwarded-For', '100.64.0.9')).status, 401, 'another device is unaffected');
});

test('auth log lines name user and IP but never the password or code', async () => {
  const lines = [];
  const db = openDb(':memory:');
  createUser(db, 'michael', 'ownerpass1', 'owner');
  enrollTotp(db, 'michael');
  const app = registerApp(createApp(db, { appSecret: TEST_APP_SECRET, log: (l) => lines.push(l) }), db);
  await password(app, 'michael', 'wrong-secret-pw');
  await login(app, 'michael', 'ownerpass1');
  const all = lines.join('\n');
  assert.match(all, /\[auth\] password bad-credentials user="michael" ip=/);
  assert.match(all, /\[auth\] login ok method=totp user=michael/);
  assert.doesNotMatch(all, /wrong-secret-pw|ownerpass1/);
  assert.doesNotMatch(all, /\b\d{6}\b/);
});

test('migration: pre-hashing session rows are dropped once', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-')), 'old.sqlite3');
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    INSERT INTO users (username, password_hash, role) VALUES ('michael', 'x', 'owner');
    INSERT INTO sessions VALUES ('plaintext-token', 1, 9999999999);`);
  raw.close();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  for (const c of ['totp_secret_enc', 'totp_pending_enc', 'totp_last_step']) assert.ok(cols.includes(c), c);
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, last_seen_at) VALUES ('h', 1, 9999999999, 1)").run();
  db.close();
  const again = openDb(file);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'runs once, not on every start');
});

test('re-entering the password between wrong codes does not escape the lockout', async () => {
  const { app, db } = makeApp();
  let attempts = 0;
  for (let i = 0; i < 6; i++) {
    const mfa = cookieNamed(await password(app, 'asst', 'memberpass1'), 'mfa');
    if (!mfa) break;
    attempts++;
    await request(app).post('/login/2fa').set('Cookie', mfa).type('form').send({ code: 'zzzzz-zzzzz' });
  }
  assert.equal(attempts, 5, 'the sixth password attempt is refused: account locked');
  assert.ok(db.prepare("SELECT locked_until FROM users WHERE username='asst'").get().locked_until > 0);
});

test('a user who can see no accounts gets an empty dashboard, not an error', async () => {
  const { app, db } = makeApp();
  db.prepare("UPDATE accounts SET visibility = 'private'").run();
  const member = await login(app, 'asst', 'memberpass1');
  const res = await request(app).get('/').set('Cookie', member);
  assert.equal(res.status, 200);
});
