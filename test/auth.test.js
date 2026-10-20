const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createUser, verifyLogin, createSession, getSessionUser, deleteSession,
        SESSION_TTL_SECONDS, LOCKOUT_AFTER, LOCKOUT_SECONDS } = require('../src/auth');

const NOW = 1789000000;

test('createUser + verifyLogin round-trip; wrong password rejected', () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'hunter2!', 'owner');
  assert.equal(verifyLogin(db, 'michael', 'wrong', NOW).ok, false);
  const r = verifyLogin(db, 'michael', 'hunter2!', NOW);
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 'owner');
  assert.equal(verifyLogin(db, 'nobody', 'x', NOW).ok, false);
});

test('5 failures lock the account for 15 minutes; success resets', () => {
  const db = openDb(':memory:');
  createUser(db, 'asst', 'pw', 'member');
  for (let i = 0; i < LOCKOUT_AFTER; i++) assert.equal(verifyLogin(db, 'asst', 'bad', NOW).ok, false);
  const locked = verifyLogin(db, 'asst', 'pw', NOW + 10);        // right password, but locked
  assert.deepEqual({ ok: locked.ok, reason: locked.reason }, { ok: false, reason: 'locked' });
  const after = verifyLogin(db, 'asst', 'pw', NOW + LOCKOUT_SECONDS + 1);
  assert.equal(after.ok, true);
  assert.equal(db.prepare("SELECT failed_attempts FROM users WHERE username='asst'").get().failed_attempts, 0);
});

test('sessions: create, fetch, expire, delete', () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'pw', 'owner');
  const uid = db.prepare("SELECT id FROM users WHERE username='michael'").get().id;
  const token = createSession(db, uid, NOW);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(getSessionUser(db, token, NOW + 100).username, 'michael');
  assert.equal(getSessionUser(db, token, NOW + SESSION_TTL_SECONDS + 1), null);
  deleteSession(db, token);
  assert.equal(getSessionUser(db, token, NOW + 100), null);
  assert.equal(getSessionUser(db, 'nonsense', NOW), null);
  assert.equal(getSessionUser(db, undefined, NOW), null);
});

test('createSession purges expired sessions before inserting the new one', () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'pw', 'owner');
  const uid = db.prepare("SELECT id FROM users WHERE username='michael'").get().id;
  const first = createSession(db, uid, NOW);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  createSession(db, uid, NOW + SESSION_TTL_SECONDS + 10);
  const tokens = db.prepare('SELECT token FROM sessions').all().map(r => r.token);
  assert.equal(tokens.length, 1, 'expired session purged, only the new one remains');
  assert.ok(!tokens.includes(first), 'the expired session row is gone');
});

test('createUser on existing username resets password and clears lockout', () => {
  const db = openDb(':memory:');
  createUser(db, 'asst', 'old', 'member');
  for (let i = 0; i < LOCKOUT_AFTER; i++) verifyLogin(db, 'asst', 'bad', NOW);
  createUser(db, 'asst', 'newpw', 'member');
  assert.equal(verifyLogin(db, 'asst', 'newpw', NOW + 1).ok, true);
});

// ---- hardening: hashed sessions, idle timeout, 2FA ----
const auth = require('../src/auth');
const { codeAt, STEP_SECONDS } = require('../src/totp');
const KEY = 'a'.repeat(64);
const userRow = (db, name) => ({ ...db.prepare('SELECT * FROM users WHERE username = ?').get(name) });

test('the sessions table stores a hash, never the cookie value', () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'pw', 'owner');
  const token = createSession(db, userRow(db, 'michael').id, NOW);
  const stored = db.prepare('SELECT token FROM sessions').get().token;
  assert.notEqual(stored, token);
  assert.equal(stored, require('crypto').createHash('sha256').update(token).digest('hex'));
  assert.equal(getSessionUser(db, stored, NOW + 1), null, 'the stored hash is not itself a valid cookie');
});

test('sessions end after a day idle; use within the day keeps them alive up to 7 days', () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'pw', 'owner');
  const uid = userRow(db, 'michael').id;
  const idle = createSession(db, uid, NOW);
  assert.equal(getSessionUser(db, idle, NOW + auth.SESSION_IDLE_SECONDS + 1), null);
  const used = createSession(db, uid, NOW);
  for (let t = NOW + 3600; t < NOW + auth.SESSION_TTL_SECONDS; t += 20 * 3600) {
    assert.equal(getSessionUser(db, used, t).username, 'michael');
  }
  assert.equal(getSessionUser(db, used, NOW + auth.SESSION_TTL_SECONDS + 1), null, 'absolute lifetime still applies');
  assert.equal(auth.SESSION_TTL_SECONDS, 7 * 86400);
});

test('setting a password ends that user\'s sessions', () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'pw', 'owner');
  const token = createSession(db, userRow(db, 'michael').id, NOW);
  createUser(db, 'michael', 'newpw', 'owner');
  assert.equal(getSessionUser(db, token, NOW + 1), null);
});

test('enrollment: pending secret is encrypted, confirmed by a code, yields 10 single-use recovery codes', () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'pw', 'owner');
  const secret = auth.startTotpEnrollment(db, userRow(db, 'michael'), KEY);
  const row = userRow(db, 'michael');
  assert.ok(!row.totp_pending_enc.includes(secret), 'secret not stored in the clear');
  assert.equal(auth.startTotpEnrollment(db, row, KEY), secret, 'reloading the page shows the same secret');
  assert.equal(auth.hasTotp(row), false);
  assert.equal(auth.confirmTotpEnrollment(db, row, '000000', KEY, NOW).ok, codeAt(secret, Math.floor(NOW / STEP_SECONDS)) === '000000');
  const r = auth.confirmTotpEnrollment(db, row, codeAt(secret, Math.floor(NOW / STEP_SECONDS)), KEY, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.recoveryCodes.length, 10);
  assert.match(r.recoveryCodes[0], /^[a-z2-7]{5}-[a-z2-7]{5}$/);
  const enrolled = userRow(db, 'michael');
  assert.equal(auth.hasTotp(enrolled), true);
  assert.equal(enrolled.totp_pending_enc, null);
  const hashes = db.prepare('SELECT code_hash FROM recovery_codes').all().map(x => x.code_hash);
  assert.ok(r.recoveryCodes.every(c => !hashes.includes(c) && !hashes.includes(c.replace('-', ''))), 'codes stored hashed');

  // the enrollment code can't be replayed at login
  assert.equal(auth.verifySecondFactor(db, enrolled, codeAt(secret, Math.floor(NOW / STEP_SECONDS)), KEY, NOW).ok, false);
  const next = Math.floor(NOW / STEP_SECONDS) + 1;
  assert.deepEqual(auth.verifySecondFactor(db, enrolled, codeAt(secret, next), KEY, next * STEP_SECONDS), { ok: true, method: 'totp' });

  // recovery code: works once, any case, with or without the dash
  const rc = r.recoveryCodes[3];
  assert.deepEqual(auth.verifySecondFactor(db, userRow(db, 'michael'), ` ${rc.toUpperCase().replace('-', '')} `, KEY, NOW), { ok: true, method: 'recovery' });
  assert.equal(auth.verifySecondFactor(db, userRow(db, 'michael'), rc, KEY, NOW).ok, false);
  assert.equal(auth.unusedRecoveryCount(db, enrolled.id), 9);
  assert.equal(auth.verifySecondFactor(db, userRow(db, 'michael'), 'zzzzz-zzzzz', KEY, NOW).ok, false);
});

test('enrollment refuses without APP_SECRET', () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'pw', 'owner');
  assert.throws(() => auth.startTotpEnrollment(db, userRow(db, 'michael'), ''), /APP_SECRET/);
});

test('login challenges expire, allow 5 tries, and are stored hashed', () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'pw', 'owner');
  const uid = userRow(db, 'michael').id;
  const t = auth.createLoginChallenge(db, uid, NOW);
  assert.notEqual(db.prepare('SELECT token FROM login_challenges').get().token, t);
  assert.equal(auth.getChallengeUser(db, t, NOW + 10).username, 'michael');
  assert.equal(auth.getChallengeUser(db, t, NOW + auth.CHALLENGE_TTL_SECONDS + 1), null);
  for (let i = 0; i < auth.CHALLENGE_MAX_ATTEMPTS; i++) auth.failChallenge(db, t);
  assert.equal(auth.getChallengeUser(db, t, NOW + 10), null);
});

test('resetTotp clears the factor, recovery codes and sessions', () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'pw', 'owner');
  const secret = auth.startTotpEnrollment(db, userRow(db, 'michael'), KEY);
  auth.confirmTotpEnrollment(db, userRow(db, 'michael'), codeAt(secret, Math.floor(NOW / STEP_SECONDS)), KEY, NOW);
  const s = createSession(db, userRow(db, 'michael').id, NOW);
  assert.equal(auth.resetTotp(db, 'michael'), true);
  assert.equal(auth.hasTotp(userRow(db, 'michael')), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recovery_codes').get().n, 0);
  assert.equal(getSessionUser(db, s, NOW + 1), null);
  assert.equal(auth.resetTotp(db, 'nobody'), false);
});

test('a correct password does not clear earlier failures; only clearFailures (a full sign-in) does', () => {
  const db = openDb(':memory:');
  createUser(db, 'asst', 'pw', 'member');
  verifyLogin(db, 'asst', 'bad', NOW);
  verifyLogin(db, 'asst', 'bad', NOW);
  assert.equal(verifyLogin(db, 'asst', 'pw', NOW).ok, true);
  const u = db.prepare("SELECT * FROM users WHERE username='asst'").get();
  assert.equal(u.failed_attempts, 2, 'password alone leaves the counter for the code step');
  auth.clearFailures(db, u.id);
  assert.equal(db.prepare("SELECT failed_attempts FROM users WHERE username='asst'").get().failed_attempts, 0);
});
