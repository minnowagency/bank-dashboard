const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const totp = require('./totp');
const { encrypt, decrypt } = require('./crypto');

const SESSION_TTL_SECONDS = 7 * 86400;      // absolute lifetime
const SESSION_IDLE_SECONDS = 24 * 3600;     // signed out after a day without use
const SESSION_TOUCH_SECONDS = 60;           // last_seen_at is written at most once a minute
const CHALLENGE_TTL_SECONDS = 5 * 60;       // time allowed between password and code
const CHALLENGE_MAX_ATTEMPTS = 5;
const LOCKOUT_AFTER = 5;
const LOCKOUT_SECONDS = 15 * 60;
const RECOVERY_CODE_COUNT = 10;
const ISSUER = 'Bank Dashboard';

// Compared against when the username doesn't exist, so a wrong username costs
// the same bcrypt time as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

function createUser(db, username, password, role) {
  if (!['owner', 'member'].includes(role)) throw new Error(`bad role: ${role}`);
  const hash = bcrypt.hashSync(password, 12);
  db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash, role = excluded.role,
      failed_attempts = 0, locked_until = NULL`).run(username, hash, role);
  // A password set or reset ends every session that user had.
  db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(username);
}

function recordFailure(db, user, now) {
  const attempts = user.failed_attempts + 1;
  if (attempts >= LOCKOUT_AFTER) {
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?').run(now + LOCKOUT_SECONDS, user.id);
  } else {
    db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, user.id);
  }
}

const isLocked = (user, now) => Boolean(user.locked_until && user.locked_until > now);

function verifyLogin(db, username, password, now) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u) { bcrypt.compareSync(password, DUMMY_HASH); return { ok: false, reason: 'bad-credentials' }; }
  if (isLocked(u, now)) return { ok: false, reason: 'locked' };
  if (!bcrypt.compareSync(password, u.password_hash)) {
    recordFailure(db, u, now);
    return { ok: false, reason: 'bad-credentials' };
  }
  // Failures are cleared only by a complete sign-in (clearFailures), so wrong
  // second-factor codes keep counting even if the password is re-entered.
  return { ok: true, user: u };
}

function clearFailures(db, userId) {
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(userId);
}

// ---- sessions: the cookie holds a random token, the database only its hash ----

function createSession(db, userId, now) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(now, now - SESSION_IDLE_SECONDS);
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now + SESSION_TTL_SECONDS, now);
  return token;
}

function getSessionUser(db, token, now) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.*, s.last_seen_at AS session_last_seen FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND s.last_seen_at > ?`).get(sha256(token), now, now - SESSION_IDLE_SECONDS);
  if (!row) return null;
  if (now - row.session_last_seen >= SESSION_TOUCH_SECONDS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(now, sha256(token));
  }
  const { session_last_seen, ...user } = row;
  return user;
}

function deleteSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(sha256(token));
}

function deleteOtherSessions(db, userId, keepToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, sha256(keepToken || ''));
}

// ---- login challenges: password accepted, second factor still owed ----

function createLoginChallenge(db, userId, now) {
  db.prepare('DELETE FROM login_challenges WHERE expires_at <= ? OR user_id = ?').run(now, userId);
  const token = newToken();
  db.prepare('INSERT INTO login_challenges (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, now + CHALLENGE_TTL_SECONDS);
  return token;
}

function getChallengeUser(db, token, now) {
  if (!token) return null;
  return db.prepare(`SELECT u.* FROM login_challenges c JOIN users u ON u.id = c.user_id
    WHERE c.token = ? AND c.expires_at > ? AND c.attempts < ?`).get(sha256(token), now, CHALLENGE_MAX_ATTEMPTS) || null;
}

function failChallenge(db, token) {
  db.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE token = ?').run(sha256(token));
}

function deleteChallenge(db, token) {
  if (token) db.prepare('DELETE FROM login_challenges WHERE token = ?').run(sha256(token));
}

// ---- TOTP enrollment and verification ----

const hasTotp = (user) => Boolean(user && user.totp_secret_enc);

function requireKey(appSecret) {
  if (!appSecret) throw new Error('APP_SECRET is not set on the server');
}

// Returns the base32 secret to show; it is kept (encrypted) as pending until confirmed.
function startTotpEnrollment(db, user, appSecret) {
  requireKey(appSecret);
  if (user.totp_pending_enc) return decrypt(user.totp_pending_enc, appSecret);
  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_pending_enc = ? WHERE id = ?').run(encrypt(secret, appSecret), user.id);
  return secret;
}

const enrollmentUri = (user, secret) => totp.otpauthUri({ secret, account: user.username, issuer: ISSUER });

// Confirms the pending secret with a code from the app. Returns recovery codes once.
function confirmTotpEnrollment(db, user, code, appSecret, now) {
  requireKey(appSecret);
  if (!user.totp_pending_enc) return { ok: false };
  const secret = decrypt(user.totp_pending_enc, appSecret);
  const r = totp.verifyCode(secret, code, now, null);
  if (!r.ok) return { ok: false };
  db.prepare('UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_last_step = ? WHERE id = ?')
    .run(r.step, user.id);
  return { ok: true, recoveryCodes: regenerateRecoveryCodes(db, user.id) };
}

const normalizeRecovery = (c) => String(c || '').toLowerCase().replace(/[^a-z2-7]/g, '');

function regenerateRecoveryCodes(db, userId) {
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
  const codes = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const raw = totp.base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();  // 50 bits
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
    ins.run(userId, sha256(raw));
  }
  return codes;
}

const unusedRecoveryCount = (db, userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId).n;

// A 6-digit TOTP code or an unused recovery code. Returns { ok, method }.
function verifySecondFactor(db, user, input, appSecret, now) {
  requireKey(appSecret);
  if (!hasTotp(user)) return { ok: false };
  const digits = String(input || '').replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    const r = totp.verifyCode(decrypt(user.totp_secret_enc, appSecret), digits, now, user.totp_last_step);
    if (!r.ok) return { ok: false };
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(r.step, user.id);
    return { ok: true, method: 'totp' };
  }
  const norm = normalizeRecovery(input);
  if (norm.length !== 10) return { ok: false };
  const used = db.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
    .run(now, user.id, sha256(norm));
  return used.changes === 1 ? { ok: true, method: 'recovery' } : { ok: false };
}

// Server-side recovery (bin/reset-2fa.js): the user enrolls again at next sign-in.
function resetTotp(db, username) {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!u) return false;
  db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = NULL WHERE id = ?').run(u.id);
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  return true;
}

module.exports = {
  createUser, verifyLogin, recordFailure, clearFailures, isLocked,
  createSession, getSessionUser, deleteSession, deleteOtherSessions,
  createLoginChallenge, getChallengeUser, failChallenge, deleteChallenge,
  hasTotp, startTotpEnrollment, enrollmentUri, confirmTotpEnrollment, verifySecondFactor,
  regenerateRecoveryCodes, unusedRecoveryCount, resetTotp,
  SESSION_TTL_SECONDS, SESSION_IDLE_SECONDS, CHALLENGE_TTL_SECONDS, CHALLENGE_MAX_ATTEMPTS,
  LOCKOUT_AFTER, LOCKOUT_SECONDS,
};
