# Company Bank Dashboard — Design Spec

**Date:** 2026-09-06
**Status:** Approved design, pending implementation plan

## Purpose

A view-only web dashboard showing all ten of the company's Truist bank accounts in one place: current balances, a unified searchable transaction feed, automatic categorization, and annotations — so Michael and his assistant stop hunting through ten separate bank logins to figure out what transactions are what.

Read-only by construction: the system can never move money or modify anything at the bank.

## Users & access

- Two users (Michael + assistant) sharing **one username/password**.
- Accessible from anywhere via HTTPS at a subdomain (exact hostname decided at build time).
- No roles, no multi-tenancy, no self-registration.

## Data source

- **SimpleFIN Bridge** (~$1.50/mo) as the aggregator. Each of the ten Truist logins is connected once through SimpleFIN's own flow; bank credentials are never entered into or stored by this app.
- The app stores a single **SimpleFIN access URL** (read-only by design) on the server.
- **Risk & fallback:** before any other work, verify a real Truist business login connects through SimpleFIN. If it does not, fall back to Plaid (same app architecture; different sync module).
- On first link, SimpleFIN typically provides ~90 days of history per account; the app ingests everything offered.

## Architecture

One droplet (new, dedicated — separate from the existing restock VPS), one Node.js process, one SQLite file.

```
SimpleFIN API ──(every 4h, read-only)──> Sync job ──upsert──> SQLite ──read──> Express web UI ──HTTPS via Caddy──> browser
```

Components:

1. **Sync job** — in-process scheduler (every 4 hours). Fetches balances + transactions since last sync with overlap; upserts by SimpleFIN's stable transaction ID so pending→posted updates never duplicate. Applies the rules engine to newly seen transactions.
2. **SQLite database** — tables: `accounts`, `transactions`, `rules`, `categories`, plus app settings. User annotations (manually set categories, notes) are stored such that re-syncs cannot overwrite them.
3. **Web UI** — Express, server-rendered HTML, minimal vanilla JS for search/filter interactions. No SPA framework, no build pipeline.

## Pages & features

Layout: **Overview First** — balance cards on top, unified feed below (user-selected from mockups).

1. **Dashboard (home)**
   - Balance card per account: name, balance, last-synced time; total-cash figure.
   - Unified transaction feed: date, description, account, category, amount. Red/green amounts; pending visually distinct.
   - Search box + filters: account, category, date range, amount.
   - "Needs review (n)" badge linking to the review queue.
2. **Transaction detail** (row expand)
   - Full description, change category, add a free-text note, "create rule from this."
3. **Review queue**
   - Transactions matched by no rule, oldest first. Categorizing an item removes it from the queue and offers to create a rule ("Always tag 'AMZN MKTP' as Supplies?").
4. **Rules & categories**
   - Rule = "description contains X (optional: account Y, amount condition Z) → category C." First matching rule wins; rules are ordered, editable, deletable, and show a match count.
   - A new or edited rule applies retroactively to existing **uncategorized** transactions only (clearing them from the review queue); it never overrides a category a person set by hand.
   - Seeded categories (renamable/extensible): Payroll, Shipping, Supplies, Taxes, Fees, Transfers, Revenue, Utilities, Insurance, Other.

Cross-cutting:

- **Transfer detection:** when two transactions across the company's accounts pair up (same amount, opposite signs, dates within ±3 days), both are auto-tagged Transfers so in/out totals aren't inflated by internal moves. When multiple candidates share an amount, pair closest-dated first; each transaction pairs at most once. Auto-tagged transfers count as categorized and skip the review queue.
- **CSV export** of any filtered transaction view.

Explicitly out of scope (YAGNI): budgeting, invoicing, payments, multi-user roles, mobile app (the site is responsive; that's enough), real-time sync.

## Security

- Login: bcrypt-hashed shared credential; 30-day session cookie; 5 failed attempts → 15-minute lockout.
- Caddy terminates HTTPS with auto-renewing Let's Encrypt certs; the app listens on localhost only.
- Droplet hardening: firewall (SSH + HTTPS only), SSH keys only, unattended security updates.
- The SimpleFIN access URL lives in an `.env` file on the droplet (never in git, not in SQLite).
- Nightly encrypted backup of the SQLite file to off-box storage (e.g., DigitalOcean Spaces), preserving notes/rules if the droplet dies.
- Breach blast radius: balances and transaction history (visibility only). SimpleFIN token cannot move money; Truist credentials never touch this system.

## Error handling

- Per-account "last synced" timestamp on its balance card.
- Warning banner when any account is stale >24h, with a plain-English cause ("Truist login #4 needs re-linking — instructions here").
- Failed syncs retry automatically with backoff; sync failures never take down the web UI.
- Sync overlap window ensures a failed run drops no transactions.

## Testing

- Automated tests for: sync upsert behavior (no duplicates, pending→posted transition, annotations never clobbered), rules engine matching/ordering, transfer pairing.
- Basic smoke test for auth + page rendering.

## Costs

- SimpleFIN Bridge ~$1.50/mo · dedicated droplet ~$6/mo · subdomain on an existing domain: $0.

## Open items for the implementation plan

1. Verify Truist connectivity through SimpleFIN with one real login before building anything else. During this spike, also confirm SimpleFIN's error responses distinguish "re-link needed" from transient failures (the staleness banner copy depends on it).
2. Choose the subdomain / confirm which domain's DNS to use.
3. Choose off-box backup target (DO Spaces vs other).
