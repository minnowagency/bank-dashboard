# Usability & Design Round — Spec

**Date:** 2026-09-22
**Status:** Approved in chat (features, visual style, technical approach)
**Builds on:** `2026-09-06-bank-dashboard-design.md`

## Goal

Make the dashboard pleasant for daily use: fewer clicks to categorize, obvious
navigation, a clearer picture of the month, and a look that holds up on a phone
at night.

## Scope (approved features)

1. **Clickable account tiles** — click filters the page to that account, click again clears.
2. **Date shortcuts** — This month (default) · Last month · 30 days · YTD · All, plus custom range.
3. **Live filters** — search/select changes update the page with no Filter button and no reload; URL stays in sync.
5. **In-row category** — a dropdown on each row saves instantly.
6. **Bulk categorize in Review** — checkboxes + a sticky bar: "N selected → [category] Apply".
8. **Month summary strip** — in / out / net for the period, each compared with the previous period.
11. **Visual refresh** — rounded soft cards, midnight palette, hover/transition polish.
12. **Mobile layout** — swipeable tiles, stacked summary, two-line rows, bottom filter panel.

Out of scope this round: merchant-name cleanup (feature 10), spending-by-category
chart (9), rule prompts after manual categorization (7).

## Visual system

- **One design, two palettes**, switched by `prefers-color-scheme` (no toggle).
  Night: `#0f1318` ground, `#181e26` cards, `#4ade80` accent. Day: `#f7f5f1`
  ground, `#fff` cards, `#16794a` accent. Both from the approved mockup.
- Rounded cards (14px), soft shadows, tabular-figure numbers, uppercase micro-labels.
- Motion: tile hover lift, feed cross-fade on update, bulk bar slide-in — all
  suppressed under `prefers-reduced-motion`.
- Money in is accent-colored; money out uses the body color; credit balances read
  "owed" in the warm red.

## Behavior

**Period.** `period=this-month|last-month|30d|ytd|all` (default `this-month`), or an
explicit `from`/`to` range which overrides it. Boundaries are computed in
**America/New_York** so late-evening transactions land on the business day.

**Summary.** In = sum of positive amounts, Out = |sum of negative|, Net = difference,
over the period, for the visible (and account-filtered) set, **excluding anything
categorized Transfers** so internal moves and card payments don't inflate either
number. The comparison is the immediately preceding window of the same length;
`all` shows no comparison.

**Live updates.** Interactions fetch the same URL with `partial=1`, which returns
just the overview fragment (summary + tiles + feed), swapped into the page;
`history.replaceState` keeps the address bar accurate. Everything degrades: with
JavaScript off, the filter form submits normally and every control is a real
form or link.

**In-row categorize.** `POST /txns/:uid/category` returns JSON when the request
asks for JSON, so the row updates in place; the HTML redirect path is unchanged.

**Bulk categorize.** `POST /txns/bulk-category` takes `uids[]` + `category_id`,
validates the category, and applies only to transactions visible to the user
(others are silently skipped, never 500), recording them as manual.

**Grouping.** The feed is grouped by day: Pending first, then Today, Yesterday,
then `Tue, Sep 16`. Day boundaries use the same timezone as periods.

## Files

- `public/style.css` — rewritten as tokens + components.
- `public/app.js` — new; ~150 lines of progressive enhancement, no dependencies.
- `src/feed.js` — add `resolvePeriod()` and `periodSummary()`.
- `src/app.js` — partial rendering, JSON category response, bulk route.
- `src/views/` — `dashboard.ejs` split into `_overview.ejs` (the fragment) plus
  chrome; `review.ejs`, `rules.ejs`, `accounts.ejs`, `login.ejs`, `_header.ejs`
  restyled.

## Testing

- `resolvePeriod` across month/year boundaries and DST, in Eastern time.
- `periodSummary`: transfers excluded, account filter honored, member scoping,
  empty set → zeros, previous-period comparison.
- Partial response returns the fragment only (no `<nav>`), same data as the full page.
- `POST /txns/bulk-category`: applies to many, skips invisible rows, 400 on a bad
  category, member cannot touch a private row.
- Category route still redirects for HTML and returns JSON for JSON.
- Every page renders with no JavaScript (existing supertest coverage keeps passing).

## Non-goals / risks

- No build step, no framework, no new runtime dependency.
- The AI badge, suggestions and hide/visibility rules from earlier rounds must
  keep working unchanged; their tests stay green.
