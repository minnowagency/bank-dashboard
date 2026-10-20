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
- Droplet `root@67.205.187.129` (DigitalOcean NYC1, Ubuntu 24.04, Node 22). App at `/opt/bank-dashboard` as user `bankdash`; systemd unit `bank-dashboard`, listening on 127.0.0.1:3000.
- **Tailnet-only since 2026-09-24:** reached at https://bank-dashboard.tail3844ec.ts.net via `tailscale serve --bg --https=443 http://127.0.0.1:3000` (Tailscale account = Michael's GitHub; node key expiry disabled). ufw allows only SSH; ports 80/443 closed and **Caddy stopped + disabled** (its IP-cert Caddyfile is kept; `deploy/Caddyfile`). The public IP no longer serves the dashboard. Rollback: `ufw allow 80/tcp && ufw allow 443/tcp && systemctl enable --now caddy` (ufw rule backups in `/root/ufw-user*.rules.bak-20260924`).
- Recovery path: DO Droplet Console (connects over SSH from DO's network, e.g. 162.243.190.66 — keep that working if SSH is ever restricted) and the DO Recovery Console (root password set 2026-09-24, stored in Michael's password manager).
- **Deploy procedure** (from a checkout, tests green):
  1. `ssh root@67.205.187.129 'bank-predeploy-backup <change>'` (gpg-encrypted snapshot in `/root/predeploy/`, 30-day retention; script is `deploy/predeploy-backup.sh`)
  2. `rsync -a --exclude node_modules --exclude data --exclude .env --exclude .superpowers --exclude .claude --exclude .git ./ root@67.205.187.129:/opt/bank-dashboard/`
  3. `ssh root@67.205.187.129 'cd /opt/bank-dashboard && npm ci --omit=dev && chown -R bankdash:bankdash . && chmod 600 .env && systemctl restart bank-dashboard && sleep 8 && systemctl is-active bank-dashboard && curl -s http://127.0.0.1:3000/health'`
- Secrets live only in `/opt/bank-dashboard/.env` (mode 600): `SIMPLEFIN_ACCESS_URL`, `ANTHROPIC_API_KEY`, `PLAID_CLIENT_ID/SECRET/ENV`, `APP_SECRET`. Helper scripts with hidden prompts: `bank-set-api-key`, `bank-set-plaid-keys`, `bank-backup-setup`. Never print or paste secrets into chat.
- Backups: nightly 03:17 UTC cron `bank-backup` → gpg-encrypted SQLite to a DO Space (rclone alias `bankbackup:`), 60-day retention; passphrase `/etc/bank-dashboard/backup.pass`. Restore steps in `deploy/README.md`. `APP_SECRET` must be kept with the passphrase.
- Michael sets passwords himself (`sudo -u bankdash node bin/create-user.js <user> <owner|member>`); Claude never handles passwords.
- **Sign-in is password + mandatory TOTP** (spec `2026-10-20-login-hardening-design.md`, `src/auth.js`, `src/totp.js`, `src/security.js`). The TOTP secret is encrypted with `APP_SECRET` — losing `APP_SECRET` means re-enrolling. Lost authenticator and no recovery codes: `cd /opt/bank-dashboard && sudo -u bankdash node bin/reset-2fa.js michael`, then sign in and enroll again. `[auth]` lines in `journalctl -u bank-dashboard` record sign-ins with the Tailscale IP.
- Tests log in through `test/helpers.js` `login()`, which completes the 2FA step with a fixed test secret; apps built outside `makeApp` need `enrollTotp` + `registerApp`.

## Gotchas
- Michael's MacBook has a broken Xcode CLT receipt (macOS 26): native modules won't build → keep dependencies pure JS.
- Node 25 rejects `node --test <dir>`; the test script uses a glob.
- `node:sqlite` rows have a null prototype — spread them before `assert.deepEqual`.
- Ubuntu's Node 22 prints a harmless "SQLite is experimental" warning.
- Dashboard defaults to "This month": tests that assert on fixture rows pass `?period=all`.

## Open items
- **Security hardening in progress** (started 2026-09-24, staged; do before linking real Plaid logins). Done: Stage 0 inventory, Stage 1 Tailscale + public 80/443 closed, Stage 2 (deployed 2026-10-20: mandatory TOTP + recovery codes, hashed 7d/24h-idle sessions, per-IP limiter, CSP/HSTS headers, cross-origin POST refusal; APP_SECRET generated on the server that day). Next: Michael enrolls 2FA on first sign-in; phone onto the tailnet; after Plaid keys are in, open Link once to confirm the CSP doesn't block it (adjust `src/security.js` CSP if the console shows violations); Stage 3 non-root sudo user (both SSH keys), then disable root login + X11 forwarding, decide SSH Tailscale-only (must keep DO console ranges); Stage 4 done 2026-10-20 (auto-reboot 09:30 UTC when an update needs it — `deploy/52bank-auto-reboot`; pre-deploy snapshots encrypted; data dir 700 / files 600, unit `UMask=0077`; logs re-scanned clean). Optional: Spaces bucket versioning so a root compromise can't delete backups; Stage 5 summary, Plaid security-questionnaire cheat-sheet, short infosec policy. After Plaid works: revoke the SimpleFIN access URL (plaintext read credential in .env).
- **Plaid live since 2026-10-20:** 7 logins (6 Truist + 1 Amex) of the 10 allowed; 13 accounts; RHJL 9711 deliberately not linked (still SimpleFIN, hidden). Runbook §9 results: Amex payment signs pair correctly (232/234 after the AI-outranking fix in `src/transfers.js`); Amex cards — including what are likely employee cards — arrive as **separate accounts** (masks 1005, 2002, 2004, 3000, 3008), not as card_member values. SimpleFIN is disabled (any Plaid item exists) and its subscription lapsed (402); **revoke the SimpleFIN access URL** and remove `SIMPLEFIN_ACCESS_URL` once RHJL no longer matters.
- Overlap de-dup window is 5 days with a same-payee preference (`src/plaid.js`); `bin/repair-plaid-overlap.js` merged 17 copies + 4 stale pendings on 2026-10-20 (dry run now finds 0).
- Card statement details (Plaid Liabilities, billed by Plaid): owner clicks "Add statement details" per login on Connections; nothing is called until then. Pending: Michael confirming Liabilities is enabled/priced on his Plaid account, then enabling it for the Amex login.
- AI categorization is working through the ~13k-row history backlog (one-time API cost); owner toggle on /rules.
- Label the wire senders on `/rules` (five sender→receiver pairs were pending).
- Once labeled data accumulates: average-range monthly forecast per sender (spec `2026-09-22-recurring-forecast-design.md`, Future).
- Webhooks and a normal certificate once a domain exists; on-demand `/transactions/refresh` button; merchant-name cleanup via Plaid enrichment.
- Assistant login not yet created.
