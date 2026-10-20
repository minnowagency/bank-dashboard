// Vendor invoices on payment terms: certain future outflows for the forecast.
// Every read and write goes through visibleAccounts, like the rest of the app.
const { visibleAccounts } = require('./feed');
const { toCents, toEpochDay } = require('./money');

const DAY = 86400;
const MATCH_BEFORE_SECONDS = 30 * DAY;   // a payment may precede the invoice/due date…
const MATCH_AFTER_SECONDS = 30 * DAY;    // …or come up to a month late
const REPLACE_WINDOW_SECONDS = 20 * DAY; // recurring occurrence an invoice stands in for

const dayOf = (s) => toEpochDay(s) + 12 * 3600;  // same convention as manual recurring items
const optDay = (s) => (String(s || '').trim() ? dayOf(s) : null);
const visibleIds = (db, user) => new Set(visibleAccounts(db, user).map(a => a.id));

function saveVendor(db, { id = null, name, terms_days = 30, account_id = null }, now, userId = null) {
  const n = String(name || '').trim();
  if (!n) throw new Error('vendor name required');
  const terms = Math.max(0, Math.min(365, Number.parseInt(terms_days, 10) || 0));
  const acct = account_id || null;
  if (id) {
    db.prepare('UPDATE vendors SET name = ?, terms_days = ?, account_id = ? WHERE id = ?').run(n, terms, acct, id);
    return Number(id);
  }
  return Number(db.prepare('INSERT INTO vendors (name, terms_days, account_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(n, terms, acct, userId, now).lastInsertRowid);
}

// A vendor typed in on an invoice is created with that invoice's paying account
// as its default, so a private account's vendor stays private.
function vendorByName(db, name, now, userId, accountId) {
  const n = String(name || '').trim();
  if (!n) throw new Error('vendor required');
  const v = db.prepare('SELECT * FROM vendors WHERE name = ? COLLATE NOCASE').get(n);
  if (v) return { ...v };
  return { ...db.prepare('SELECT * FROM vendors WHERE id = ?').get(saveVendor(db, { name: n, account_id: accountId || null }, now, userId)) };
}

// Creates (no f.id) or updates an invoice. Throws on bad input; the caller turns that into a 400.
function saveInvoice(db, user, f, now) {
  if (!f.vendor_id && !String(f.vendor_name || '').trim()) throw new Error('vendor required');
  let vendor = f.vendor_id
    ? { ...(db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(f.vendor_id)) || {}) }
    : null;
  const existing = f.vendor_name ? db.prepare('SELECT * FROM vendors WHERE name = ? COLLATE NOCASE').get(String(f.vendor_name).trim()) : null;
  const accountId = String(f.account_id || (vendor && vendor.account_id) || (existing && existing.account_id) || '');
  if (!visibleIds(db, user).has(accountId)) throw new Error('choose a paying account');
  if (!vendor) vendor = vendorByName(db, f.vendor_name, now, user.id, accountId);
  if (!vendor.id) throw new Error('vendor required');
  let cents;
  try { cents = toCents(String(f.amount || '').replace(/[$,\s]/g, '')); } catch { cents = 0; }
  if (!(cents > 0)) throw new Error('amount must be more than zero');
  const invoiceDate = optDay(f.invoice_date) || (f.due_date ? null : dayOf(new Date(now * 1000).toISOString().slice(0, 10)));
  const dueDate = optDay(f.due_date) || invoiceDate + vendor.terms_days * DAY;
  const replaces = f.replaces_recurring_id
    ? db.prepare('SELECT id FROM recurring_items WHERE id = ? AND account_id = ?').get(Number(f.replaces_recurring_id), accountId)
    : null;
  const vals = [vendor.id, accountId, String(f.invoice_number || '').trim() || null, cents, invoiceDate, dueDate,
    replaces ? replaces.id : null, String(f.note || '').trim() || null];
  let id = f.id ? Number(f.id) : null;
  if (id) {
    if (!getInvoice(db, user, id)) throw new Error('not found');
    db.prepare(`UPDATE invoices SET vendor_id = ?, account_id = ?, invoice_number = ?, amount_cents = ?, invoice_date = ?,
      due_date = ?, replaces_recurring_id = ?, note = ?, updated_at = ? WHERE id = ?`).run(...vals, now, id);
  } else {
    id = Number(db.prepare(`INSERT INTO invoices (vendor_id, account_id, invoice_number, amount_cents, invoice_date, due_date,
      replaces_recurring_id, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...vals, user.id, now, now).lastInsertRowid);
  }
  matchPayments(db);   // the payment may already be in the feed
  return id;
}

function getInvoice(db, user, id) {
  const r = db.prepare(`SELECT i.*, v.name AS vendor_name FROM invoices i JOIN vendors v ON v.id = i.vendor_id WHERE i.id = ?`).get(Number(id));
  return r && visibleIds(db, user).has(r.account_id) ? { ...r } : null;
}

function setStatus(db, user, id, status, now) {
  const r = getInvoice(db, user, id);
  if (!r) return false;
  db.prepare(`UPDATE invoices SET status = ?, paid_at = ?, paid_txn_uid = CASE WHEN ? = 'open' THEN NULL ELSE paid_txn_uid END,
    updated_at = ? WHERE id = ?`).run(status, status === 'paid' ? (r.paid_at || now) : null, status, now, r.id);
  return true;
}

// "Not this payment": reopen and never match that transaction to this invoice again.
function rejectMatch(db, user, id, now = Math.floor(Date.now() / 1000)) {
  const r = getInvoice(db, user, id);
  if (!r || !r.paid_txn_uid) return false;
  const rejected = [...new Set([...JSON.parse(r.rejected_txn_uids || '[]'), r.paid_txn_uid])];
  db.prepare(`UPDATE invoices SET status = 'open', paid_txn_uid = NULL, paid_at = NULL, rejected_txn_uids = ?, updated_at = ?
    WHERE id = ?`).run(JSON.stringify(rejected), now, r.id);
  return true;
}

// Open invoice + outgoing transaction of exactly that amount on the paying account,
// inside the window, not already settling another invoice → paid. Earliest due first.
function matchPayments(db) {
  const open = db.prepare("SELECT * FROM invoices WHERE status = 'open' ORDER BY due_date, id").all();
  const find = db.prepare(`SELECT uid, posted_at FROM transactions t
    WHERE account_id = ? AND amount_cents = ? AND pending = 0 AND posted_at BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.paid_txn_uid = t.uid)
    ORDER BY ABS(posted_at - ?) LIMIT 20`);
  const mark = db.prepare(`UPDATE invoices SET status = 'paid', paid_txn_uid = ?, paid_at = ?, updated_at = ? WHERE id = ?`);
  let n = 0;
  db.transaction(() => {
    for (const inv of open) {
      const from = (inv.invoice_date || inv.due_date) - MATCH_BEFORE_SECONDS;
      const rejected = new Set(JSON.parse(inv.rejected_txn_uids || '[]'));
      const t = find.all(inv.account_id, -inv.amount_cents, from, inv.due_date + MATCH_AFTER_SECONDS, inv.due_date)
        .find(x => !rejected.has(x.uid));
      if (!t) continue;
      mark.run(t.uid, t.posted_at, Math.floor(Date.now() / 1000), inv.id);
      n++;
    }
  })();
  return n;
}

function listInvoices(db, user, now) {
  const ids = [...visibleIds(db, user)];
  if (ids.length === 0) return { open: [], closed: [], vendors: [] };
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT i.*, v.name AS vendor_name, COALESCE(a.display_name, a.name) AS account_name,
      t.description AS paid_description, t.posted_at AS paid_posted_at
    FROM invoices i JOIN vendors v ON v.id = i.vendor_id JOIN accounts a ON a.id = i.account_id
    LEFT JOIN transactions t ON t.uid = i.paid_txn_uid
    WHERE i.account_id IN (${ph}) ORDER BY i.due_date, i.id`).all(...ids).map(r => ({ ...r, pastDue: r.due_date < now }));
  const vendors = db.prepare(`SELECT v.*, COALESCE(a.display_name, a.name) AS account_name FROM vendors v
    LEFT JOIN accounts a ON a.id = v.account_id
    WHERE v.account_id IN (${ph})
       OR (v.account_id IS NULL AND (NOT EXISTS (SELECT 1 FROM invoices i WHERE i.vendor_id = v.id)
                                     OR EXISTS (SELECT 1 FROM invoices i WHERE i.vendor_id = v.id AND i.account_id IN (${ph}))))
    ORDER BY v.name COLLATE NOCASE`).all(...ids, ...ids).map(v => ({ ...v }));
  return {
    open: rows.filter(r => r.status === 'open'),
    closed: rows.filter(r => r.status !== 'open').sort((a, b) => (b.paid_at || b.updated_at) - (a.paid_at || a.updated_at)).slice(0, 25),
    vendors,
  };
}

// Open invoices for one account's forecast. `replaces` maps recurring item id
// → due dates whose nearest occurrence the forecast should skip.
function forecastInvoices(db, accountId, horizonEnd) {
  const rows = db.prepare(`SELECT i.*, v.name AS vendor_name FROM invoices i JOIN vendors v ON v.id = i.vendor_id
    WHERE i.account_id = ? AND i.status = 'open' AND i.due_date < ? ORDER BY i.due_date`).all(accountId, horizonEnd);
  const replaces = new Map();
  for (const r of rows) {
    if (!r.replaces_recurring_id) continue;
    if (!replaces.has(r.replaces_recurring_id)) replaces.set(r.replaces_recurring_id, []);
    replaces.get(r.replaces_recurring_id).push(r.due_date);
  }
  return { rows: rows.map(r => ({ ...r })), replaces };
}

module.exports = { saveVendor, saveInvoice, getInvoice, setStatus, rejectMatch, matchPayments, listInvoices,
  forecastInvoices, REPLACE_WINDOW_SECONDS };
