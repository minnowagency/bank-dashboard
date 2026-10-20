// Plaid connector: link items, poll /transactions/sync, land rows in the same
// tables the SimpleFIN path uses, then run the shared post-processing.
//
// Plaid's amount sign is the reverse of ours (positive = money out), and its
// dates are calendar days; both are normalized here so nothing downstream
// knows which provider a row came from.

const { encrypt, decrypt } = require('./crypto');
const { postProcess } = require('./sync');
const { startOfDay } = require('./feed');

const PLAID_INTERVAL_MS = 5 * 60 * 1000;
const LIABILITIES_REFRESH_SECONDS = 6 * 3600;  // statements change monthly; Plaid refreshes about daily
const DAY = 86400;
// SimpleFIN dated card and transfer rows by transaction day (stamped 08:00 ET),
// Plaid by posting day (noon ET): usually 2 days later, 3–4 across a weekend.
const OVERLAP_MATCH_SECONDS = 5 * DAY;
// Same-payee test for choosing between same-amount candidates: the first 12
// letters/digits of the description ("CASHAPPNADIA" vs "CASHAPPJOSHU").
const payeeKey = (d) => String(d || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

function makeClient(config) {
  const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[config.plaidEnv] || PlaidEnvironments.production,
    baseOptions: { headers: { 'PLAID-CLIENT-ID': config.plaidClientId, 'PLAID-SECRET': config.plaidSecret } },
  }));
}

function addItem(db, { itemId, accessToken, institutionName, now }, appSecret) {
  db.prepare(`INSERT INTO plaid_items (item_id, access_token_enc, institution_name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET access_token_enc = excluded.access_token_enc,
      institution_name = COALESCE(excluded.institution_name, institution_name), status = 'ok', error = NULL`)
    .run(itemId, encrypt(accessToken, appSecret), institutionName || null, now);
}

function accessTokenFor(db, item, appSecret) {
  return decrypt(item.access_token_enc, appSecret);
}

// Plaid "YYYY-MM-DD" -> Eastern noon, so the row lands on the business day.
function dayToEpoch(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  return startOfDay(Number(m[1]), Number(m[2]), Number(m[3])) + 12 * 3600;
}

function toCents(n) { return Math.round(Number(n) * 100); }

// Match a Plaid account to an existing row (by provider id, then by mask
// against an unlinked SimpleFIN account), or create one. Owner settings on an
// existing row are never touched.
function upsertAccount(db, a, now) {
  const byId = db.prepare('SELECT id FROM accounts WHERE source_account_id = ?').get(a.account_id);
  const kind = a.type === 'credit' ? 'credit' : 'bank';
  const balance = a.balances && a.balances.current != null ? toCents(a.balances.current) : 0;
  const balanceCents = kind === 'credit' ? -balance : balance;
  let id = byId ? byId.id : null;
  if (!id && a.mask) {
    const byMask = db.prepare(`SELECT id FROM accounts WHERE source_account_id IS NULL AND kind = ?
      AND (mask = ? OR name LIKE ? OR name LIKE ?) ORDER BY id LIMIT 1`)
      .get(kind, a.mask, `%(${a.mask})%`, `% ${a.mask}`);
    if (byMask) id = byMask.id;
  }
  if (id) {
    db.prepare(`UPDATE accounts SET source = 'plaid', source_account_id = ?, mask = COALESCE(?, mask),
      balance_cents = ?, balance_date = ?, last_synced_at = ?, sync_error = NULL WHERE id = ?`)
      .run(a.account_id, a.mask || null, balanceCents, now, now, id);
    return id;
  }
  id = `plaid:${a.account_id}`;
  db.prepare(`INSERT INTO accounts (id, name, org_name, kind, balance_cents, balance_date, last_synced_at,
      source, source_account_id, mask)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'plaid', ?, ?)`)
    .run(id, a.official_name || a.name || `Account ${a.mask || ''}`.trim(), a.institution_name || null, kind,
      balanceCents, now, now, a.account_id, a.mask || null);
  return id;
}

// samePayeeOnly: adopt an older row only when the payee matches; returns false
// (nothing written) if that left the transaction unplaced, so a second pass can
// match it by date alone once every same-payee pair in the page is taken.
function applyTransaction(db, t, accountIds, now, { samePayeeOnly = false } = {}) {
  const accountId = accountIds.get(t.account_id);
  if (!accountId) return; // account not returned by accountsGet; skip rather than guess
  const amountCents = -toCents(t.amount);
  const postedAt = dayToEpoch(t.date) || now;
  const description = t.merchant_name && t.merchant_name.length > 0 && !/^[\d\s]*$/.test(t.merchant_name)
    ? t.name || t.merchant_name : (t.name || t.merchant_name || '');
  const pending = t.pending ? 1 : 0;

  const byPlaidId = db.prepare('SELECT uid FROM transactions WHERE plaid_txn_id = ?').get(t.transaction_id);
  if (byPlaidId) {
    db.prepare(`UPDATE transactions SET posted_at = ?, amount_cents = ?, description = ?, pending = ?, account_id = ?
      WHERE uid = ?`).run(postedAt, amountCents, description, pending, accountId, byPlaidId.uid);
    return;
  }
  if (t.pending_transaction_id) {
    const pendingRow = db.prepare('SELECT uid FROM transactions WHERE plaid_txn_id = ?').get(t.pending_transaction_id);
    if (pendingRow) {
      // the posted version replaces the pending one in place, keeping annotations
      db.prepare(`UPDATE transactions SET plaid_txn_id = ?, sf_id = ?, posted_at = ?, amount_cents = ?, description = ?,
        pending = 0, account_id = ? WHERE uid = ?`)
        .run(t.transaction_id, `p:${t.transaction_id}`, postedAt, amountCents, description, accountId, pendingRow.uid);
      return;
    }
  }
  // overlap with history from the previous provider: adopt the existing row
  const candidates = db.prepare(`SELECT uid, description, posted_at FROM transactions WHERE plaid_txn_id IS NULL
    AND account_id = ? AND amount_cents = ? AND ABS(posted_at - ?) <= ?`)
    .all(accountId, amountCents, postedAt, OVERLAP_MATCH_SECONDS);
  const key = payeeKey(description);
  const eligible = samePayeeOnly ? candidates.filter(c => payeeKey(c.description) === key) : candidates;
  if (samePayeeOnly && eligible.length === 0 && candidates.length > 0) return false;
  const twin = eligible.sort((a, b) =>
    (payeeKey(b.description) === key) - (payeeKey(a.description) === key)
    || Math.abs(a.posted_at - postedAt) - Math.abs(b.posted_at - postedAt))[0];
  if (twin) {
    db.prepare('UPDATE transactions SET plaid_txn_id = ?, pending = ? WHERE uid = ?').run(t.transaction_id, pending, twin.uid);
    return;
  }
  db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, pending,
      plaid_txn_id, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`${accountId}|p:${t.transaction_id}`, `p:${t.transaction_id}`, accountId, postedAt, amountCents, description,
      pending, t.transaction_id, now);
}

function plaidErrorText(err) {
  const d = err && err.response && err.response.data;
  if (d && d.error_code) return `${d.error_code}: ${d.error_message || ''}`.trim();
  return String((err && err.message) || err);
}

function friendlyItemError(item, code) {
  const who = item.institution_name || 'A bank connection';
  if (/ITEM_LOGIN_REQUIRED|INVALID_CREDENTIALS|INVALID_MFA|ITEM_LOCKED/.test(code)) {
    return `${who} needs to be re-connected — open Connections and click Fix to log in again.`;
  }
  return `${who} sync failed: ${code}`;
}

async function syncItem(db, client, item, appSecret, now) {
  const access_token = accessTokenFor(db, item, appSecret);
  const accounts = (await client.accountsGet({ access_token })).data.accounts;
  const accountIds = new Map();
  db.transaction(() => {
    for (const a of accounts) accountIds.set(a.account_id, upsertAccount(db, { ...a, institution_name: item.institution_name }, now()));
    db.prepare('UPDATE plaid_items SET account_ids = ? WHERE id = ?').run(JSON.stringify([...accountIds.keys()]), item.id);
  })();

  let cursor = item.cursor || undefined;
  let added = 0, removed = 0, pages = 0;
  for (;;) {
    const req = { access_token, count: 500 };
    if (cursor) req.cursor = cursor;
    const page = (await client.transactionsSync(req)).data;
    pages++;
    db.transaction(() => {
      const txns = [...(page.added || []), ...(page.modified || [])];
      const deferred = txns.filter(t => applyTransaction(db, t, accountIds, now(), { samePayeeOnly: true }) === false);
      for (const t of deferred) applyTransaction(db, t, accountIds, now());
      added += txns.length;
      for (const r of page.removed || []) {
        removed += db.prepare('DELETE FROM transactions WHERE plaid_txn_id = ?').run(r.transaction_id).changes;
      }
      cursor = page.next_cursor;
      db.prepare(`UPDATE plaid_items SET cursor = ?, status = 'ok', error = NULL, last_synced_at = ? WHERE id = ?`)
        .run(cursor, now(), item.id);
    })();
    if (!page.has_more) break;
    if (pages > 200) throw new Error('transactions/sync did not converge');
  }
  return { added, removed, pages };
}

// Card statement details (Plaid Liabilities) for an item the owner enabled.
// A failure is kept on the item for the Connections page; it never fails the sync.
async function syncLiabilities(db, client, item, appSecret, now) {
  if (item.liabilities !== 'on') return;
  if (item.liabilities_fetched_at && now - item.liabilities_fetched_at < LIABILITIES_REFRESH_SECONDS) return;
  try {
    const data = (await client.liabilitiesGet({ access_token: accessTokenFor(db, item, appSecret) })).data;
    const cents = (n) => (n == null ? null : toCents(n));
    const up = db.prepare(`INSERT INTO card_statements (account_id, statement_balance_cents, statement_date,
        minimum_payment_cents, due_date, last_payment_cents, last_payment_date, is_overdue, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET statement_balance_cents = excluded.statement_balance_cents,
        statement_date = excluded.statement_date, minimum_payment_cents = excluded.minimum_payment_cents,
        due_date = excluded.due_date, last_payment_cents = excluded.last_payment_cents,
        last_payment_date = excluded.last_payment_date, is_overdue = excluded.is_overdue, fetched_at = excluded.fetched_at`);
    db.transaction(() => {
      for (const c of (data.liabilities && data.liabilities.credit) || []) {
        const acct = db.prepare('SELECT id FROM accounts WHERE source_account_id = ?').get(c.account_id);
        if (!acct) continue;
        up.run(acct.id, cents(c.last_statement_balance), dayToEpoch(c.last_statement_issue_date),
          cents(c.minimum_payment_amount), dayToEpoch(c.next_payment_due_date), cents(c.last_payment_amount),
          dayToEpoch(c.last_payment_date), c.is_overdue == null ? null : (c.is_overdue ? 1 : 0), now);
      }
      db.prepare('UPDATE plaid_items SET liabilities_fetched_at = ?, liabilities_error = NULL WHERE id = ?').run(now, item.id);
    })();
  } catch (err) {
    // retry on the normal refresh schedule rather than every 5 minutes
    db.prepare('UPDATE plaid_items SET liabilities_fetched_at = ?, liabilities_error = ? WHERE id = ?')
      .run(now, plaidErrorText(err), item.id);
  }
}

// Polls every configured item. One item failing never stops the others; its
// error is stored on the item and surfaced in the owner's banner.
async function plaidSync(db, { client, appSecret, aiCategorizeFn = null, log = () => {},
                              now = () => Math.floor(Date.now() / 1000) }) {
  const items = db.prepare('SELECT * FROM plaid_items ORDER BY id').all();
  const out = { ok: true, items: items.length, added: 0, removed: 0, errors: [] };
  if (items.length === 0) return out;

  const startedAt = now();
  const runId = db.prepare('INSERT INTO sync_runs (started_at) VALUES (?)').run(startedAt).lastInsertRowid;
  for (const item of items) {
    try {
      const r = await syncItem(db, client, item, appSecret, now);
      out.added += r.added; out.removed += r.removed;
      await syncLiabilities(db, client, item, appSecret, now());
    } catch (err) {
      const text = plaidErrorText(err);
      db.prepare(`UPDATE plaid_items SET status = 'error', error = ? WHERE id = ?`).run(text, item.id);
      out.errors.push(friendlyItemError(item, text));
      log(`[plaid] item ${item.item_id} (${item.institution_name || '?'}) failed: ${text}`);
    }
  }
  const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  setSetting.run('sync_errors', JSON.stringify(out.errors));
  setSetting.run('data_source', 'plaid');

  const post = await postProcess(db, { aiCategorizeFn, log, now });
  db.prepare('UPDATE sync_runs SET finished_at = ?, ok = 1 WHERE id = ?').run(now(), runId);
  return { ...out, ...post };
}

// One-time repair for overlap rows the old 48-hour window missed: Plaid
// inserted a second copy of a transaction SimpleFIN had already stored. The
// older row is kept (its annotations and SimpleFIN description, which carries
// wire sender digits); it takes over the Plaid id, and the Plaid copy's
// category and transfer pairing when it has none of its own. SimpleFIN pending
// rows inside Plaid's coverage never post now and are dropped unless annotated.
function repairOverlapDuplicates(db, { apply = false } = {}) {
  const report = { merged: [], stalePending: [], unmatched: [] };
  const accounts = db.prepare("SELECT id FROM accounts WHERE source = 'plaid'").all();
  const run = () => {
    for (const { id } of accounts) {
      const start = db.prepare("SELECT MIN(posted_at) AS t FROM transactions WHERE account_id = ? AND uid LIKE '%|p:%'").get(id).t;
      if (start == null) continue;
      const olds = db.prepare(`SELECT * FROM transactions WHERE account_id = ? AND plaid_txn_id IS NULL AND posted_at >= ?
        ORDER BY posted_at`).all(id, start - OVERLAP_MATCH_SECONDS).map(r => ({ ...r }));
      const taken = new Set();
      const copiesFor = (o) => db.prepare(`SELECT * FROM transactions WHERE account_id = ? AND uid LIKE '%|p:%'
        AND amount_cents = ? AND ABS(posted_at - ?) <= ?`).all(id, o.amount_cents, o.posted_at, OVERLAP_MATCH_SECONDS)
        .map(r => ({ ...r })).filter(c => !taken.has(c.uid));
      const pick = (o, samePayeeOnly) => {
        const key = payeeKey(o.description);
        const list = copiesFor(o).filter(c => !samePayeeOnly || payeeKey(c.description) === key);
        return list.sort((a, b) => (payeeKey(b.description) === key) - (payeeKey(a.description) === key)
          || Math.abs(a.posted_at - o.posted_at) - Math.abs(b.posted_at - o.posted_at))[0];
      };
      const pairs = [];
      const rest = [];
      for (const o of olds.filter(r => !r.pending)) {
        const c = pick(o, true);
        if (c) { taken.add(c.uid); pairs.push([o, c]); } else rest.push(o);
      }
      for (const o of rest) {
        const c = pick(o, false);
        if (c) { taken.add(c.uid); pairs.push([o, c]); } else report.unmatched.push(o);
      }
      for (const o of olds.filter(r => r.pending)) {
        if (o.note || o.category_source === 'manual') report.unmatched.push(o);
        else report.stalePending.push(o);
      }
      for (const [o, c] of pairs) {
        report.merged.push({ keep: o, drop: c });
        if (!apply) continue;
        const takeCategory = o.category_id == null && o.suggested_category_id == null;
        db.prepare('DELETE FROM transactions WHERE uid = ?').run(c.uid);   // first: plaid_txn_id is unique
        db.prepare(`UPDATE transactions SET plaid_txn_id = ?, pending = ?,
            category_id = ?, category_source = ?, categorized_by = ?, rule_id = ?,
            suggested_category_id = ?, ai_confidence = ?, ai_reason = ?, transfer_pair_uid = ?
          WHERE uid = ?`).run(c.plaid_txn_id, c.pending,
          takeCategory ? c.category_id : o.category_id, takeCategory ? c.category_source : o.category_source,
          takeCategory ? c.categorized_by : o.categorized_by, takeCategory ? c.rule_id : o.rule_id,
          takeCategory ? c.suggested_category_id : o.suggested_category_id,
          takeCategory ? c.ai_confidence : o.ai_confidence, takeCategory ? c.ai_reason : o.ai_reason,
          o.transfer_pair_uid || c.transfer_pair_uid, o.uid);
        db.prepare('UPDATE transactions SET transfer_pair_uid = ? WHERE transfer_pair_uid = ?').run(o.uid, c.uid);
      }
    }
    if (apply) {
      for (const p of report.stalePending) db.prepare('DELETE FROM transactions WHERE uid = ?').run(p.uid);
      // a pair partner that no longer exists leaves nothing to pair with
      db.exec(`UPDATE transactions SET transfer_pair_uid = NULL WHERE transfer_pair_uid IS NOT NULL
        AND transfer_pair_uid NOT IN (SELECT uid FROM transactions)`);
    }
  };
  if (apply) db.transaction(run)(); else run();
  return report;
}

module.exports = { PLAID_INTERVAL_MS, makeClient, repairOverlapDuplicates, addItem, accessTokenFor, plaidSync, dayToEpoch, friendlyItemError };
