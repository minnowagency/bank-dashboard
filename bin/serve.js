#!/usr/bin/env node
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { runSync } = require('../src/sync');
const { fetchAccounts } = require('../src/simplefin');
const { startScheduler } = require('../src/scheduler');

const config = loadConfig();
if (!config.accessUrl) {
  console.error('SIMPLEFIN_ACCESS_URL is not set. Run: node bin/claim-token.js <setup-token>');
  process.exit(1);
}

function redact(text) {
  let redacted = text;
  redacted = redacted.replace(new RegExp(config.accessUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[redacted]');
  try {
    const u = new URL(config.accessUrl);
    if (u.username) redacted = redacted.replace(new RegExp(u.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[redacted]');
    if (u.password) redacted = redacted.replace(new RegExp(u.password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[redacted]');
    if (u.username && u.password) redacted = redacted.replace(new RegExp(`${u.username}:${u.password}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[redacted]');
  } catch {}
  return redacted;
}

const db = openDb(config.dbPath);

startScheduler({
  run: async () => {
    const r = await runSync(db, { accessUrl: config.accessUrl, fetchAccountsFn: fetchAccounts });
    console.log(`[sync] ok=${r.ok} new=${r.newTransactions || 0} errors=${redact(JSON.stringify(r.errors))}`);
    return r;
  },
});

const app = createApp(db, { cookieSecure: config.cookieSecure });
app.listen(config.port, config.host, () => {
  console.log(`bank-dashboard listening on http://${config.host}:${config.port}`);
});
