# Company Bank Dashboard — Design Spec

**Date:** 2026-09-06
**Status:** Approved design, pending implementation plan

## Purpose

A view-only web dashboard showing all of the company's finances in one place — ten Truist bank accounts plus American Express cards (company cards and employee cards) — with current balances, a unified searchable transaction feed, automatic categorization, and annotations, so Michael and his assistant stop hunting through separate bank logins to figure out what transactions are what.

Michael's personal accounts (e.g., his personal Amex) sync into the same system but are visible **only to him** (see Visibility).

Read-only by construction: the system can never move money or modify anything at the bank.

## Users & access

- Two users, each with their own username/password: **Michael (owner)** and **assistant (member)**. Annotations (notes, manual categorizations) record which user made them. Either password can be reset from the server without affecting the other.
- **Visibility:** every account carries a flag — **Company** (both users see it) or **Private** (owner only). The member's entire view — balance cards, feed, totals, review queue, search, rules match counts, CSV export — is computed as if Private accounts do not exist (absent, not masked). Only the owner can change visibility. **New accounts default to Private** so a fresh connection can never leak before the owner has reviewed it.
- Accessible from anywhere via HTTPS directly on the droplet's IP — no custom domain for now. Preferred: Let's Encrypt IP-address certificate (short-lived, auto-renewed by Caddy); fallback if that's rough at build time: a free `<ip>.sslip.io` hostname with a standard Let's Encrypt cert. A real subdomain can be pointed at the droplet later with no app changes.
- No self-registration; no roles beyond owner/member.

## Data source

- **SimpleFIN Bridge** (~$1.50/mo) as the aggregator. Connections: the ten Truist logins, the company American Express login(s), and Michael's personal Amex — each linked once through SimpleFIN's own flow; bank credentials are never entered into or stored by this app.
- At build time, verify SimpleFIN's sign conventions for Amex card payments (they vary by aggregator) so transfer pairing matches reality.
- **Employee Amex cards:** verify at build time how they arrive — as separate sub-accounts (each becomes its own account card + filter) or as transactions on the main account carrying the card member's name (then surfaced as a "card member" field parsed from the data, with a filter). Either path yields per-employee visibility.
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
   - Balance card per account: name, balance, last-synced time; total-cash figure (bank accounts only).
   - **Credit cards get their own row/group**: balance shown as amount owed, visually distinct, excluded from total cash. Optional "total owed" figure.
   - Card transactions show the card member where available; feed is filterable by card member.
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
   - Either user can create rules; rules apply across all accounts regardless of who created them. A rule created from a Private-account transaction is itself **owner-only** (hidden from the member's rules list) so personal merchant names never appear in the shared list.
   - Seeded categories (renamable/extensible): Payroll, Shipping, Supplies, Taxes, Fees, Transfers, Revenue, Utilities, Insurance, Other.

Cross-cutting:

- **Transfer detection:** when two transactions across connected accounts pair up (same amount, opposite signs, dates within ±3 days), both are auto-tagged Transfers so in/out totals aren't inflated by internal moves. This covers Truist↔Truist moves **and credit-card payments** (Truist debit ↔ Amex payment credit). When multiple candidates share an amount, pair closest-dated first; each transaction pairs at most once. Auto-tagged transfers count as categorized and skip the review queue. Pairing never crosses the visibility boundary in what it displays: a Company-account transaction paired with a Private-account one still shows only the Company side to the member.
- **CSV export** of any filtered transaction view.

Explicitly out of scope (YAGNI): budgeting, invoicing, payments, roles beyond owner/member, per-transaction (rather than per-account) visibility, mobile app (the site is responsive; that's enough), real-time sync.

## Security

- Login: two user accounts, bcrypt-hashed passwords; 30-day session cookie; 5 failed attempts → 15-minute lockout per account.
- Caddy terminates HTTPS with auto-renewing Let's Encrypt certs (IP cert, or sslip.io fallback — see Users & access); the app listens on localhost only.
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

1. ~~Verify Truist connectivity through SimpleFIN~~ — verified 2026-09-17: first Truist login shows Status OK in Bridge. Still to confirm at build time: transactions flow via the API, and whether SimpleFIN's error responses distinguish "re-link needed" from transient failures (the staleness banner copy depends on it).
2. ~~Choose the subdomain~~ — resolved: IP-based HTTPS for now (LE IP cert, sslip.io fallback).
3. Choose off-box backup target (DO Spaces vs other).
