# Bank Dashboard — project notes for Claude

Read this first. It carries the context a new session needs; the full designs are in `docs/superpowers/specs/`.

## What this is
A private dashboard for Michael's companies' bank accounts and Amex cards: balances, a categorized transaction feed, review queue, rules, AI categorization, sender labels for intercompany wires, recurring-item detection, and a per-account cash forecast. Two users: `michael` (owner) and an optional `assistant` (member) who never sees accounts marked Private.

## Stack and conventions
- Node ≥ 22.13, CommonJS, Express 4, EJS, Node's built-in `node:sqlite` (no native modules — Michael's Mac cannot build them; see gotchas). No framework, no build step; `public/app.js` is progressive enhancement over real links/forms.
- Money is integer cents; timestamps are epoch seconds; business days/months are computed in `America/New_York` (`src/feed.js` `resolvePeriod`/`startOfDay`).
- Tests: `npm test` (`node --test "test/*.test.js"`), currently 150+. Every change ships with tests; suite must be green before deploy.
- Visibility is enforced in one place: `visibleAccounts()` in `src/feed.js` (hidden accounts and, for members, private accounts are absent everywhere). Every query that lists accounts or transactions must go through it or an `IN (visible ids)` list.
- Automation (rules, senders, transfers, AI) only ever touches rows with `category_id IS NULL`, except sender labels which also outrank AI. `category_source='manual'` is never overwritten.
- DB migrations are idempotent and run at startup in `src/db.js` (column adds, a transactions-table rebuild when the CHECK constraint changes, guarded one-time data repairs keyed in `settings`).

## Domain rules that shaped the code (don't undo these)
- **Each bank account is a separate company** (BHCC LLC 8743, SMFG, Checking 0342, …). RHJL LLC 9711 is a business Michael is exiting: **hidden** (excluded from every view and never sent to the AI).
- Companies pay each other by wire, so **bank→bank movement is income for the receiver, never a transfer**. Only bank→credit-card payments pair as Transfers (`src/transfers.js`).
- Truist wire descriptions identify the payer only by the sending account's last four (`DBT ACCT: XXXXXXXXX6212`, `FROM *9711`). `src/senders.js` maps **(last4, receiving account) → who + category**; the same sender is product sales (Revenue) into one company and Distributions or Capital contributions into another. Labeled on `/rules`.
- Summary strip and recurring detection exclude Transfers.

## AI categorization (`src/ai-categorize.js`)
Claude Opus 5, effort low, structured output via zod. **Privacy contract:** exactly five fields leave the server per transaction (batch ref, date, amount, digit-masked description, "cardholder A" label); `test/ai-categorize.test.js` seeds secrets and fails the build if anything else could appear. High confidence applies (`category_source='ai'`); medium/low become review-queue suggestions. Key in `.env` (`ANTHROPIC_API_KEY`); owner toggle on `/rules`.

## Data source
- **Plaid** (`src/plaid.js`, spec `2026-09-23-plaid-connector-design.md`): owner-only `/connections` page with Plaid Link; polls `/transactions/sync` every 5 minutes (no webhooks — no domain yet); 24 months of history; access tokens AES-256-GCM in `plaid_items` with `APP_SECRET` from `.env`. Accounts match existing rows by mask; overlap with older history is de-duplicated; pending→posted migrates in place. Plaid amounts are positive-for-money-out (flipped on ingest); dates are calendar days → Eastern noon.
- **SimpleFIN** (`src/simplefin.js`, `src/sync.js`) was the original source; it auto-disables once any Plaid item exists and stays as a fallback.
- Shared post-processing after either source: `sync.postProcess` (transfers → senders → rules → AI → recurring refresh).

## Server and deploy
- Droplet `root@67.205.187.129` (DigitalOcean NYC1, Ubuntu 24.04, Node 22). App at `/opt/bank-dashboard` as user `bankdash`; systemd unit `bank-dashboard`; Caddy with a Let's Encrypt **short-lived IP certificate** (Caddyfile needs `tls { issuer acme { profile shortlived } }`). Live at https://67.205.187.129.
- **Deploy procedure** (from a checkout, tests green):
  1. `ssh root@67.205.187.129 'sqlite3 /opt/bank-dashboard/data/bank.sqlite3 ".backup /root/bank-pre-<change>-$(date +%Y%m%d-%H%M%S).sqlite3"'`
  2. `rsync -a --exclude node_modules --exclude data --exclude .env --exclude .superpowers --exclude .claude --exclude .git ./ root@67.205.187.129:/opt/bank-dashboard/`
  3. `ssh root@67.205.187.129 'cd /opt/bank-dashboard && npm ci --omit=dev && chown -R bankdash:bankdash . && chmod 600 .env && systemctl restart bank-dashboard && sleep 8 && systemctl is-active bank-dashboard && curl -s http://127.0.0.1:3000/health'`
- Secrets live only in `/opt/bank-dashboard/.env` (mode 600): `SIMPLEFIN_ACCESS_URL`, `ANTHROPIC_API_KEY`, `PLAID_CLIENT_ID/SECRET/ENV`, `APP_SECRET`. Helper scripts with hidden prompts: `bank-set-api-key`, `bank-set-plaid-keys`, `bank-backup-setup`. Never print or paste secrets into chat.
- Backups: nightly 03:17 UTC cron `bank-backup` → gpg-encrypted SQLite to a DO Space (rclone alias `bankbackup:`), 60-day retention; passphrase `/etc/bank-dashboard/backup.pass`. Restore steps in `deploy/README.md`. `APP_SECRET` must be kept with the passphrase.
- Michael sets passwords himself (`sudo -u bankdash node bin/create-user.js <user> <owner|member>`); Claude never handles passwords.

## Gotchas
- Michael's MacBook has a broken Xcode CLT receipt (macOS 26): native modules won't build → keep dependencies pure JS.
- Node 25 rejects `node --test <dir>`; the test script uses a glob.
- `node:sqlite` rows have a null prototype — spread them before `assert.deepEqual`.
- Ubuntu's Node 22 prints a harmless "SQLite is experimental" warning.
- Dashboard defaults to "This month": tests that assert on fixture rows pass `?period=all`.

## Open items
- Link the remaining Truist logins and the Amex accounts through Plaid; then run the runbook §9 checks (Amex payment signs pair as transfers; how employee cards appear — Plaid provides no card-member field).
- Label the wire senders on `/rules` (five sender→receiver pairs were pending).
- Once labeled data accumulates: average-range monthly forecast per sender (spec `2026-09-22-recurring-forecast-design.md`, Future).
- Webhooks and a normal certificate once a domain exists; on-demand `/transactions/refresh` button; merchant-name cleanup via Plaid enrichment.
- Assistant login not yet created.
