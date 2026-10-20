#!/usr/bin/env node
// One-time: merge transactions Plaid duplicated because the old overlap window
// (48 h) missed SimpleFIN rows dated 2–4 days earlier.
// Usage (on the server, service stopped for --apply):
//   sudo -u bankdash node bin/repair-plaid-overlap.js            # dry run: report only
//   sudo -u bankdash node bin/repair-plaid-overlap.js --apply
const { openDb } = require('../src/db');
const { loadConfig } = require('../src/config');
const { repairOverlapDuplicates } = require('../src/plaid');

const apply = process.argv.includes('--apply');
const db = openDb(loadConfig().dbPath);
const r = repairOverlapDuplicates(db, { apply });
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const amt = (c) => (c / 100).toFixed(2).padStart(11);
const line = (t) => `${day(t.posted_at)} ${amt(t.amount_cents)}  ${String(t.description).slice(0, 34)}`;
console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${r.merged.length} duplicates merged, ${r.stalePending.length} stale pending removed, ${r.unmatched.length} unmatched left alone\n`);
for (const m of r.merged) console.log(`merge  keep ${line(m.keep)}\n       drop ${line(m.drop)}`);
for (const p of r.stalePending) console.log(`pending drop ${line(p)}`);
for (const u of r.unmatched) console.log(`unmatched   ${line(u)}`);
