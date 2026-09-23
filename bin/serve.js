#!/usr/bin/env node
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { runSync } = require('../src/sync');
const { fetchAccounts } = require('../src/simplefin');
const { startScheduler } = require('../src/scheduler');
const { makeClient, plaidSync, PLAID_INTERVAL_MS } = require('../src/plaid');
const { aiEnabled } = require('../src/app');
const { categorizeUncategorized } = require('../src/ai-categorize');

const config = loadConfig();
const plaidReady = !!(config.plaidClientId && config.plaidSecret && config.appSecret);
if (!config.accessUrl && !plaidReady) {
  console.error('No data source configured. Set Plaid keys (deploy/set-plaid-keys.sh) or SIMPLEFIN_ACCESS_URL.');
  process.exit(1);
}

function redact(text) {
  let redacted = text;
  if (!config.accessUrl) return redacted;
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

// AI categorization runs only when a key is present and the owner hasn't
// switched it off. Without it, unmatched transactions just await review.
let anthropic = null;
if (config.anthropicApiKey) {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  console.log('[ai] categorization available');
} else {
  console.log('[ai] no ANTHROPIC_API_KEY set; skipping AI categorization');
}

const aiCategorizeFn = anthropic
  ? async (database) => {
      if (!aiEnabled(database)) return null;
      const r = await categorizeUncategorized(database, { client: anthropic, log: console.log });
      console.log(`[ai] applied=${r.applied} suggested=${r.suggested} failed=${r.failed} ` +
        `batches=${r.batches} tokens=${r.inputTokens}/${r.outputTokens}`);
      return r;
    }
  : null;

const plaidClient = plaidReady ? makeClient(config) : null;
console.log(plaidReady ? '[plaid] configured' : '[plaid] not configured');

// Plaid is the source as soon as one connection exists; SimpleFIN otherwise.
function plaidItemCount() { return db.prepare('SELECT COUNT(*) AS n FROM plaid_items').get().n; }
async function syncOnce() {
  if (plaidReady && plaidItemCount() > 0) {
    const r = await plaidSync(db, { client: plaidClient, appSecret: config.appSecret, aiCategorizeFn, log: console.log });
    console.log(`[sync:plaid] ok=${r.ok} items=${r.items} added=${r.added} removed=${r.removed} errors=${r.errors.length}`);
    return r;
  }
  if (!config.accessUrl) return { ok: true };
  const r = await runSync(db, { accessUrl: config.accessUrl, fetchAccountsFn: fetchAccounts,
    aiCategorizeFn, log: console.log });
  console.log(`[sync] ok=${r.ok} new=${r.newTransactions || 0} errors=${redact(JSON.stringify(r.errors))}`);
  return r;
}
// One sync at a time: a Link completion and the timer must not overlap.
let syncing = null;
const syncNow = () => syncing || (syncing = syncOnce().finally(() => { syncing = null; }));
startScheduler({ run: syncNow, intervalMs: plaidReady ? PLAID_INTERVAL_MS : undefined });

const app = createApp(db, { cookieSecure: config.cookieSecure,
  plaid: plaidReady ? { client: plaidClient, appSecret: config.appSecret, syncNow } : null });
app.listen(config.port, config.host, () => {
  console.log(`bank-dashboard listening on http://${config.host}:${config.port}`);
});
