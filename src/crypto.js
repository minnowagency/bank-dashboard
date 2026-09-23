// AES-256-GCM for secrets at rest (Plaid access tokens). The key lives only in
// .env, so a copy of the database alone cannot reach the banks.
const crypto = require('crypto');

function keyBytes(hexKey) {
  if (!/^[0-9a-f]{64}$/i.test(String(hexKey || ''))) throw new Error('APP_SECRET must be 64 hex characters (32 bytes)');
  return Buffer.from(hexKey, 'hex');
}

function encrypt(plain, hexKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(hexKey), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${body.toString('base64')}`;
}

function decrypt(blob, hexKey) {
  const [v, iv, tag, body] = String(blob).split(':');
  if (v !== 'v1') throw new Error('unknown ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(hexKey), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
