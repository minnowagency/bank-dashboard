// RFC 6238 time-based one-time codes (SHA-1, 6 digits, 30-second steps) —
// what every authenticator app speaks. node:crypto only.
const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1; // accept the previous and next step for clock drift
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(off) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Returns { ok, step }. lastStep is the last step this user redeemed: codes at
// or before it are refused, so a code works once.
function verifyCode(secret, code, now, lastStep) {
  const c = String(code == null ? '' : code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return { ok: false };
  const current = Math.floor(now / STEP_SECONDS);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = current + d;
    if (lastStep != null && step <= lastStep) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return { ok: true, step };
  }
  return { ok: false };
}

function otpauthUri({ secret, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = { base32Encode, base32Decode, generateSecret, codeAt, verifyCode, otpauthUri, STEP_SECONDS };
