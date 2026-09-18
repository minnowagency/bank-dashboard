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
