# Plaid Connector — Spec

**Date:** 2026-09-23
**Status:** Approved in chat
**Replaces:** SimpleFIN as the live data source (SimpleFIN code stays as a fallback)

## Why

SimpleFIN refreshes about once a day. Plaid pulls from each bank several times a
day and provides up to 24 months of history, which also makes recurring
detection and the planned average-range income forecast far better.

## Scope

- Owner-only **Connections** page: link a bank login through Plaid Link, see
  each connection's status, fix one that needs re-authentication, remove one.
- **Polling sync every 5 minutes** using `/transactions/sync` cursors
  (no webhooks — no domain yet; webhooks are an additive follow-up).
- **24 months** of history requested at link time.
- Existing data and human work carry over: accounts are matched by last-four
  mask; overlapping transactions are matched and the existing row kept.
- SimpleFIN sync switches off automatically once any Plaid connection exists.

## Data model

- `plaid_items`: `item_id` (unique), `access_token_enc` (AES-256-GCM with
  `APP_SECRET` from `.env`), `institution_name`, `cursor`, `status`
  (`ok|error`), `error`, `last_synced_at`, `created_at`.
- `accounts` gains `source` (`simplefin|plaid`), `source_account_id`, `mask`.
  The primary key `id` never changes for an account that already exists, so
  every table that references accounts keeps working.
- `transactions` gains `plaid_txn_id` (unique when set).

## Sync algorithm (per item, every 5 minutes)

1. `accountsGet` → upsert accounts. Match order: same `source_account_id`;
   else an unlinked existing account whose name contains `(mask)`/`mask`
   (SimpleFIN names look like `BHCC LLC 8743 (8743)`); else insert
   `plaid:<account_id>`. Matching only sets `source*`/`mask`/balance — never
   `visibility`, `hidden`, `display_name`, `kind`.
   Balances: depository `current` → `balance_cents`; credit `current` (amount
   owed) → `-balance_cents`.
2. `transactionsSync` loop until `has_more=false`, then persist `next_cursor`.
   Plaid amounts are positive for money out; the app stores money in as
   positive, so the sign is flipped. `date` (YYYY-MM-DD) → Eastern noon.
   - **added/modified:** if a row has this `plaid_txn_id` → update fields;
     else if `pending_transaction_id` names a row → update **that** row in place
     (annotations follow the pending→posted transition); else if an unlinked
     SimpleFIN row in the same account has the same amount within ±2 days →
     link it (set `plaid_txn_id`) and refresh `pending`; else insert.
   - **removed:** delete the row.
3. Item errors (`ITEM_LOGIN_REQUIRED` etc.) → `status='error'`, message stored,
   surfaced on Connections and in the owner's staleness banner.
4. Shared post-processing, identical to the SimpleFIN path: transfer pairing,
   sender labels, rules, AI categorization, recurring refresh.

## Connections page

- `POST /connections/link-token` returns a link token (products:
  transactions; `transactions.days_requested: 730`).
- Plaid Link JS (`cdn.plaid.com`) opens in the browser; on success the page
  posts `public_token` + institution name to `POST /connections/exchange`,
  which exchanges it, stores the encrypted access token, and runs a first sync
  immediately.
- `POST /connections/:id/fix` returns an update-mode link token for re-auth.
- `POST /connections/:id/delete` calls `itemRemove` and deletes the item; its
  accounts and transactions stay (history is still useful; the owner can hide
  the account).

## Configuration

`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`production`), `APP_SECRET`
(32 random bytes, hex) — written by `deploy/set-plaid-keys.sh` via hidden
prompts. Sync source selection: Plaid when configured and ≥1 item exists,
otherwise SimpleFIN when configured, otherwise nothing.

## Testing

Token encryption round-trip; account matching by mask (linked / new /
never-clobber settings); transaction ingest: insert, modify, pending→posted
migration keeping note+category, SimpleFIN de-duplication, removal; cursor
persistence across pages; item error handling; connection routes owner-only;
source selection.

## Out of scope (follow-ups)

Webhooks (needs a hostname), on-demand `/transactions/refresh` button,
Plaid merchant enrichment for merchant-name cleanup.
