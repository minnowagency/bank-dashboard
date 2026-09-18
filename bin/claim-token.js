#!/usr/bin/env node
// Usage: node bin/claim-token.js <setup-token-from-bridge.simplefin.org>
const fs = require('fs');
const { claimSetupToken } = require('../src/simplefin');

const token = process.argv[2];
if (!token) { console.error('Usage: node bin/claim-token.js <setup-token>'); process.exit(1); }

claimSetupToken(token).then((accessUrl) => {
  fs.appendFileSync('.env', `SIMPLEFIN_ACCESS_URL=${accessUrl}\n`, { mode: 0o600 });
  try { fs.chmodSync('.env', 0o600); } catch {}
  console.log('Access URL claimed and saved to .env (not printed for safety).');
  console.log('NOTE: a setup token can only be claimed once — if this failed, generate a new one.');
}).catch((err) => { console.error(`Claim failed: ${err.message}`); process.exit(1); });
