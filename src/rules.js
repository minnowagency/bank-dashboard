function applyRulesToUncategorized(db) {
  const rules = db.prepare('SELECT * FROM rules ORDER BY position ASC, id ASC').all();
  if (rules.length === 0) return 0;
  const txns = db.prepare(
    'SELECT uid, account_id, amount_cents, description FROM transactions WHERE category_id IS NULL').all();
  const set = db.prepare(`UPDATE transactions
    SET category_id = ?, category_source = 'rule', rule_id = ?, categorized_by = NULL
    WHERE uid = ? AND category_id IS NULL`);
  let n = 0;
  db.transaction(() => {
    for (const t of txns) {
      const desc = t.description.toLowerCase();
      const r = rules.find((r) =>
        desc.includes(r.pattern.toLowerCase()) &&
        (r.account_id == null || r.account_id === t.account_id) &&
        (r.amount_cents == null || r.amount_cents === t.amount_cents));
      if (r) { set.run(r.category_id, r.id, t.uid); n++; }
    }
  })();
  return n;
}

function createRule(db, { pattern, accountId = null, amountCents = null, categoryId, ownerOnly = false, createdBy = null }) {
  if (!pattern || !pattern.trim()) throw new Error('rule pattern required');
  const pos = (db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM rules').get().p) + 1;
  const id = db.prepare(`INSERT INTO rules (position, pattern, account_id, amount_cents, category_id, owner_only, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(pos, pattern.trim(), accountId, amountCents, categoryId, ownerOnly ? 1 : 0, createdBy).lastInsertRowid;
  applyRulesToUncategorized(db);
  return id;
}

module.exports = { applyRulesToUncategorized, createRule };
