const test = require('node:test');
const assert = require('node:assert/strict');
const { base32Encode, base32Decode, generateSecret, codeAt, verifyCode, otpauthUri, STEP_SECONDS } = require('../src/totp');

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890" (6-digit truncation of the 8-digit vectors)
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('RFC 6238 test vectors', () => {
  assert.equal(codeAt(RFC_SECRET, Math.floor(59 / STEP_SECONDS)), '287082');
  assert.equal(codeAt(RFC_SECRET, Math.floor(1111111109 / STEP_SECONDS)), '081804');
  assert.equal(codeAt(RFC_SECRET, Math.floor(1234567890 / STEP_SECONDS)), '005924');
  assert.equal(codeAt(RFC_SECRET, Math.floor(2000000000 / STEP_SECONDS)), '279037');
});

test('base32 round-trips and tolerates spaces, lowercase and padding', () => {
  const buf = Buffer.from([0, 1, 2, 250, 251, 255, 7]);
  const enc = base32Encode(buf);
  assert.match(enc, /^[A-Z2-7]+$/);
  assert.deepEqual(base32Decode(enc), buf);
  assert.deepEqual(base32Decode(enc.toLowerCase().replace(/(.{4})/g, '$1 ') + '=='), buf);
});

test('generateSecret is 160 random bits in base32', () => {
  const a = generateSecret();
  assert.equal(base32Decode(a).length, 20);
  assert.notEqual(a, generateSecret());
});

test('verifyCode accepts ±1 step, rejects others, and refuses replays', () => {
  const s = generateSecret();
  const now = 1789000000;
  const step = Math.floor(now / STEP_SECONDS);
  assert.deepEqual(verifyCode(s, codeAt(s, step), now, null), { ok: true, step });
  assert.equal(verifyCode(s, codeAt(s, step - 1), now, null).ok, true);
  assert.equal(verifyCode(s, codeAt(s, step + 1), now, null).ok, true);
  assert.equal(verifyCode(s, codeAt(s, step - 2), now, null).ok, false);
  assert.equal(verifyCode(s, codeAt(s, step), now, step).ok, false, 'same step already used');
  assert.equal(verifyCode(s, codeAt(s, step - 1), now, step).ok, false, 'older step after a newer one');
  assert.equal(verifyCode(s, ` ${codeAt(s, step).slice(0, 3)} ${codeAt(s, step).slice(3)} `, now, null).ok, true, 'spaces ignored');
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined]) assert.equal(verifyCode(s, bad, now, null).ok, false);
});

test('otpauthUri carries issuer, account and secret', () => {
  const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'michael', issuer: 'Bank Dashboard' });
  assert.equal(uri, 'otpauth://totp/Bank%20Dashboard:michael?secret=JBSWY3DPEHPK3PXP&issuer=Bank%20Dashboard&algorithm=SHA1&digits=6&period=30');
});
