# Recurring Items & Cash Forecast — Spec

**Date:** 2026-09-22
**Status:** Approved in chat; shipped the same day
**Builds on:** `2026-09-06-bank-dashboard-design.md`, `2026-09-22-usability-round-design.md`

## Goal

Tell Michael what each company will spend and receive week by week, from
recurring items detected in its own history, without him writing rules.

## Key facts that shaped the design

- **Each bank account is a separate company** (BHCC, SMFG, …), and companies pay
  each other by wire/transfer (SMFG is paid by hppyc for product; BHCC receives
  distributions). Money moving bank→bank is therefore **income for the
  receiver**, never an internal transfer. Only a bank account paying the same
  company's credit card is internal.
- SimpleFIN provides ~90 days of history, so monthly items have 2–3 occurrences
  and annual items cannot be detected.

## Detection (`src/recurring.js`)

- Deterministic, runs after categorization on every sync (`refreshCandidates`).
- Groups posted, non-Transfer transactions of non-hidden accounts by
  account × direction × normalized merchant (`normalizeMerchant` strips digits,
  store IDs and POS noise).
- Cadence: weekly (7±2d, ≥3 seen), biweekly (14±3d, ≥3), monthly (30.4±5d, ≥2).
  All gaps must fit one cadence. Amounts must sit within a 1.5× band; the typical
  amount is the median, with min/max kept as the range.
- `next_due` = last occurrence advanced one cadence (monthly keeps the
  day-of-month, in America/New_York).
- Detections are upserted into `recurring_items` keyed by (account, merchant,
  kind). **Status and human edits survive refreshes**; only `candidate` rows get
  their name/amount refreshed from the data. Dismissed stays dismissed.

## Confirmation (`/recurring`)

- Candidates are shown with their evidence (dates and amounts) and next expected
  date; Confirm / Dismiss. Confirmed items are editable (name, cadence, amount)
  and can be stopped; dismissed ones can be confirmed later.
- Manual items (annual insurance, etc.) can be added with a next date.
- Both users can act, scoped to the accounts they can see.

## Forecast (`/forecast`)

- Per account (= per company), next 8 weeks from today (Eastern): expected in,
  out, net, the items due each week with dates, and a projected balance that
  starts from the account's current balance. A chip row narrows to one account.
- Only `confirmed` and `manual` items count. Nothing is forecast from candidates.
- Items 5+ days past `next_due` with no matching transaction are listed as
  **Overdue**; items 0–4 days late show in week 1 marked "late".
- A banner warns when a bank account's projected balance goes below zero.

## Transfer rule change (cross-cutting)

- `detectTransfers` pairs only when one side is a bank account and the other a
  credit card.
- New seed category **Distributions**; the AI prompt says inbound wires/ACH from
  other businesses are Revenue or Distributions, and Transfers is reserved for
  the company's own card payments.
- One-time guarded migration `migration:intercompany-transfers`: unpairs
  bank↔bank pairs and resets AI-filed inbound Transfers (manual categorizations
  untouched) so they are re-categorized under the new guidance.

## Future

- A per-account **company** label, so that if a company ever has two accounts
  (checking + savings) transfers within that company pair again.
- Semimonthly detection (1st/15th) — the cadence exists for manual items only.
