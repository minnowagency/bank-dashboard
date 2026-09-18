const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SESSION_TTL_SECONDS = 30 * 86400;
const LOCKOUT_AFTER = 5;
const LOCKOUT_SECONDS = 15 * 60;

function createUser(db, username, password, role) {
  if (!['owner', 'member'].includes(role)) throw new Error(`bad role: ${role}`);
  const hash = bcrypt.hashSync(password, 12);
  db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash, role = excluded.role,
      failed_attempts = 0, locked_until = NULL`).run(username, hash, role);
}

function verifyLogin(db, username, password, now) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u) return { ok: false, reason: 'bad-credentials' };
  if (u.locked_until && u.locked_until > now) return { ok: false, reason: 'locked' };
  if (!bcrypt.compareSync(password, u.password_hash)) {
    const attempts = u.failed_attempts + 1;
    if (attempts >= LOCKOUT_AFTER) {
      db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?')
        .run(now + LOCKOUT_SECONDS, u.id);
    } else {
      db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, u.id);
    }
    return { ok: false, reason: 'bad-credentials' };
  }
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(u.id);
  return { ok: true, user: u };
}

function createSession(db, userId, now) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, now + SESSION_TTL_SECONDS);
  return token;
}

function getSessionUser(db, token, now) {
  if (!token) return null;
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, now) || null;
}

function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = { createUser, verifyLogin, createSession, getSessionUser, deleteSession,
  SESSION_TTL_SECONDS, LOCKOUT_AFTER, LOCKOUT_SECONDS };
