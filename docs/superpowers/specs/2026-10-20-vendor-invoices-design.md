# Vendor Invoices in the Forecast — Spec

## Why
Recurring detection only forecasts what repeats. Vendors on payment terms
(Net 15/30/60) send invoices with known amounts and due dates; those are the
most certain outflows there are, and the forecast should include them.

## Data
- `vendors` — name (unique, case-insensitive), `terms_days` (default 30),
  optional default paying account.
- `invoices` — vendor, **paying account** (forecasts are per account = per
  company), amount (positive cents), optional invoice # / invoice date / note,
  `due_date`, status `open | paid | void`, `paid_txn_uid` + `paid_at`,
  optional `replaces_recurring_id`, `rejected_txn_uids` (JSON).
- Due date: entered, or blank → invoice date + vendor terms (invoice date
  defaults to today). Dates are stored like manual recurring items
  (`toEpochDay` + 12 h).

## Who
Owner and member can add, edit, mark paid and void invoices **on accounts they
can see** (`visibleAccounts`); a private account's invoices never reach a member.
Vendors are a shared list; a member doesn't see a vendor whose default account
is private.

## Forecast
- Open invoices due before the horizon are outflows on their paying account,
  in the week of their due date. **Past-due open invoices land in week 1 marked
  "past due"** — unlike a missed recurring item, an unpaid invoice is still owed.
- `replaces_recurring_id`: the invoice stands in for that recurring item's
  nearest occurrence (within 20 days of the due date), so a vendor that is
  both recurring and invoiced is not counted twice.

## Payment matching
After every sync (and when an invoice is saved), each open invoice looks for an
outgoing transaction on its paying account with exactly the invoice amount,
dated from 30 days before the invoice date (or due date) to 30 days after the
due date, not linked to another invoice and not previously rejected for it.
A match marks it paid. "Not this payment" reopens it and remembers the
rejection. Manual "Mark paid" also works (no transaction needed).

## Pages
`/invoices`: open invoices (past due first, then by due date) with totals per
account, an add form, recently paid/void, and the vendor list with terms.
Forecast items from invoices are labelled "Invoice · <vendor> #<number>".

## Out of scope
Partial payments, attachments/PDF parsing, email intake, recurring invoice templates.
