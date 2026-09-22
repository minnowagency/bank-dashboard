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

function senderMap(db) {
  return new Map(db.prepare('SELECT last4, name, category_id FROM senders').all().map(r => [r.last4, r]));
}

// Applies labels to inbound rows that are uncategorized or AI-categorized.
// A person's label outranks the AI; manual and transfer rows are never touched.
function applySenders(db) {
  const senders = senderMap(db);
  if (senders.size === 0) return 0;
  const rows = db.prepare(`SELECT uid, description, category_id FROM transactions
    WHERE amount_cents > 0 AND (category_id IS NULL OR category_source = 'ai')`).all();
  const set = db.prepare(`UPDATE transactions
    SET category_id = ?, category_source = 'rule', rule_id = NULL, categorized_by = NULL,
        suggested_category_id = NULL, ai_confidence = NULL, ai_reason = NULL
    WHERE uid = ? AND (category_id IS NULL OR category_source = 'ai')`);
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const last4 = senderLast4(r.description);
      const s = last4 && senders.get(last4);
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
    r.sender_last4 = last4;
    r.sender_name = last4 && senders.has(last4) ? senders.get(last4).name : null;
  }
  return rows;
}

module.exports = { senderLast4, applySenders, annotateSenders };
