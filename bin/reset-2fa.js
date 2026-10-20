#!/usr/bin/env node
// Usage (on the server): sudo -u bankdash node bin/reset-2fa.js <username>
// For a lost authenticator with no recovery codes left: removes the user's
// two-factor setup, recovery codes and sessions. They enroll again after their
// next password sign-in.
const { openDb } = require('../src/db');
const { resetTotp } = require('../src/auth');
const { loadConfig } = require('../src/config');

const [username] = process.argv.slice(2);
if (!username) { console.error('Usage: node bin/reset-2fa.js <username>'); process.exit(1); }
const db = openDb(loadConfig().dbPath);
if (!resetTotp(db, username)) { console.error(`No user '${username}'.`); process.exit(1); }
console.log(`Two-factor reset for '${username}'. They will set it up again after their next sign-in.`);
