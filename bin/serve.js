#!/usr/bin/env node
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { runSync } = require('../src/sync');
const { fetchAccounts } = require('../src/simplefin');
const { startScheduler } = require('../src/scheduler');
const { aiEnabled } = require('../src/app');
const { categorizeUncategorized } = require('../src/ai-categorize');

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

startScheduler({
  run: async () => {
    const r = await runSync(db, { accessUrl: config.accessUrl, fetchAccountsFn: fetchAccounts,
      aiCategorizeFn, log: console.log });
    console.log(`[sync] ok=${r.ok} new=${r.newTransactions || 0} errors=${redact(JSON.stringify(r.errors))}`);
    return r;
  },
});

const app = createApp(db, { cookieSecure: config.cookieSecure });
app.listen(config.port, config.host, () => {
  console.log(`bank-dashboard listening on http://${config.host}:${config.port}`);
});
