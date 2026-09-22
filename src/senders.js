// Sender labels: Truist wire and transfer descriptions carry no company name,
// only the last four digits of the originating account ("DBT ACCT: XXXXXXXXX6212",
// "FROM *9711"). A person labels that account once ("hppyc — product sales")
// and every inbound payment from it is categorized, past and future.

const WIRE = /DBT\s+ACCT:\s*X*(\d{4})\b/i;
const ONLINE = /TRANSFER\s*-\s*FROM\s*\*?X*(\d{4})\b/i;

// The originating account's last four digits, or null when the description
// is not an inbound wire/transfer. Deliberately format-specific so a phone
// number or invoice number can never be mistaken for a sender.
function senderLast4(description) {
  const s = String(description || '');
  const m = WIRE.exec(s) || ONLINE.exec(s);
  return m ? m[1] : null;
}

// Labels keyed by "last4|receiving account". The same sending account can
// mean product sales to one company and a distribution to another.
function senderMap(db) {
  return new Map(db.prepare('SELECT last4, account_id, name, category_id FROM senders').all()
    .map(r => [`${r.last4}|${r.account_id}`, r]));
}
// A name already used for this sending account with any receiver, for prefills.
function knownName(db, last4) {
  const r = db.prepare('SELECT name FROM senders WHERE last4 = ? ORDER BY created_at LIMIT 1').get(last4);
  return r ? r.name : null;
}

// Applies labels to inbound rows that are uncategorized or AI-categorized.
// A person's label outranks the AI; manual and transfer rows are never touched.
function applySenders(db) {
  const senders = senderMap(db);
  if (senders.size === 0) return 0;
  const rows = db.prepare(`SELECT uid, account_id, description, category_id FROM transactions
    WHERE amount_cents > 0 AND (category_id IS NULL OR category_source = 'ai')`).all();
  const set = db.prepare(`UPDATE transactions
    SET category_id = ?, category_source = 'rule', rule_id = NULL, categorized_by = NULL,
        suggested_category_id = NULL, ai_confidence = NULL, ai_reason = NULL
    WHERE uid = ? AND (category_id IS NULL OR category_source = 'ai')`);
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const last4 = senderLast4(r.description);
      const s = last4 && senders.get(`${last4}|${r.account_id}`);
      if (!s || r.category_id === s.category_id) continue;
      if (set.run(s.category_id, r.uid).changes) n++;
    }
  })();
  return n;
}

// Decorates feed rows with the sender's name for display.
function annotateSenders(db, rows) {
  const senders = senderMap(db);
  for (const r of rows) {
    const last4 = r.amount_cents > 0 ? senderLast4(r.description) : null;
    const s = last4 && senders.get(`${last4}|${r.account_id}`);
    r.sender_last4 = last4;
    r.sender_name = s ? s.name : (last4 ? knownName(db, last4) : null);
    r.sender_labeled = !!s;
    r.sender_category_id = s ? s.category_id : null;
  }
  return rows;
}

// Sending accounts seen in this user's inbound wires that have no label yet,
// with how many wires and how much money came from each.
function unlabeledSenders(db, accountIds) {
  if (accountIds.length === 0) return [];
  const senders = senderMap(db);
  const rows = db.prepare(`SELECT t.description, t.amount_cents, t.posted_at, t.account_id,
      COALESCE(a.display_name, a.name) AS account_name
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.amount_cents > 0 AND t.account_id IN (${accountIds.map(() => '?').join(',')})`).all(...accountIds);
  const agg = new Map();
  for (const r of rows) {
    const last4 = senderLast4(r.description);
    if (!last4 || senders.has(`${last4}|${r.account_id}`)) continue;
    const key = `${last4}|${r.account_id}`;
    const a = agg.get(key) || { last4, account_id: r.account_id, account_name: r.account_name,
      known_name: knownName(db, last4), count: 0, totalCents: 0, latest: 0 };
    a.count++; a.totalCents += r.amount_cents; a.latest = Math.max(a.latest, r.posted_at);
    agg.set(key, a);
  }
  return [...agg.values()].sort((x, y) => y.count - x.count);
}

// Order for the sender label dropdown: what an inbound wire usually is, first.
const INBOUND_FIRST = ['Revenue', 'Distributions', 'Capital contributions'];
function senderCategoryOptions(categories) {
  const rank = (c) => { const i = INBOUND_FIRST.indexOf(c.name); return i === -1 ? INBOUND_FIRST.length : i; };
  return [...categories].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map(c => ({ ...c, label: c.name === 'Revenue' ? 'Revenue (product sales)' : c.name }));
}

module.exports = { senderLast4, applySenders, annotateSenders, unlabeledSenders, senderCategoryOptions };
