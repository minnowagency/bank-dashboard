#!/usr/bin/env node
// Usage: node bin/create-user.js <username> <owner|member>   (password read from hidden stdin prompt)
const readline = require('readline');
const { openDb } = require('../src/db');
const { createUser } = require('../src/auth');
const { loadConfig } = require('../src/config');

const [username, role] = process.argv.slice(2);
if (!username || !['owner', 'member'].includes(role)) {
  console.error('Usage: node bin/create-user.js <username> <owner|member>');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// hide typed password
rl._writeToOutput = (s) => { if (s.includes('\n')) rl.output.write('\n'); };
process.stdout.write(`Password for ${username}: `);
rl.question('', (password) => {
  rl.close();
  if (password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
  const db = openDb(loadConfig().dbPath);
  createUser(db, username, password, role);
  console.log(`User '${username}' (${role}) created/updated.`);
});
