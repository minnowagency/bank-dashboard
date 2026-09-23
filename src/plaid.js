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
const DAY = 86400;
const OVERLAP_MATCH_SECONDS = 2 * DAY;

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

function applyTransaction(db, t, accountIds, now) {
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
  const twin = db.prepare(`SELECT uid FROM transactions WHERE plaid_txn_id IS NULL AND account_id = ?
    AND amount_cents = ? AND ABS(posted_at - ?) <= ? ORDER BY ABS(posted_at - ?) LIMIT 1`)
    .get(accountId, amountCents, postedAt, OVERLAP_MATCH_SECONDS, postedAt);
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
      for (const t of [...(page.added || []), ...(page.modified || [])]) { applyTransaction(db, t, accountIds, now()); added++; }
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

module.exports = { PLAID_INTERVAL_MS, makeClient, addItem, accessTokenFor, plaidSync, dayToEpoch, friendlyItemError };
