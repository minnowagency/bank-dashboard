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

const db = openDb(config.dbPath);

startScheduler({
  run: async () => {
    const r = await runSync(db, { accessUrl: config.accessUrl, fetchAccountsFn: fetchAccounts });
    console.log(`[sync] ok=${r.ok} new=${r.newTransactions || 0} errors=${JSON.stringify(r.errors)}`);
    return r;
  },
});

const app = createApp(db, { cookieSecure: config.cookieSecure });
app.listen(config.port, config.host, () => {
  console.log(`bank-dashboard listening on http://${config.host}:${config.port}`);
});
