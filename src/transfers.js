const WINDOW_SECONDS = 3 * 86400;

function detectTransfers(db) {
  const transfersId = db.prepare("SELECT id FROM categories WHERE name='Transfers'").get().id;
  const candidates = db.prepare(`
    SELECT a.uid AS out_uid, b.uid AS in_uid, ABS(a.posted_at - b.posted_at) AS gap
    FROM transactions a
    JOIN transactions b
      ON b.amount_cents = -a.amount_cents
     AND b.account_id != a.account_id
     AND ABS(b.posted_at - a.posted_at) <= ?
    WHERE a.amount_cents < 0
      AND a.category_id IS NULL AND b.category_id IS NULL
      AND a.transfer_pair_uid IS NULL AND b.transfer_pair_uid IS NULL
    ORDER BY gap ASC, a.posted_at ASC, a.uid ASC`).all(WINDOW_SECONDS);

  const mark = db.prepare(`UPDATE transactions
    SET category_id = ?, category_source = 'transfer', transfer_pair_uid = ?
    WHERE uid = ?`);
  const used = new Set();
  let pairs = 0;
  db.transaction(() => {
    for (const c of candidates) {
      if (used.has(c.out_uid) || used.has(c.in_uid)) continue;
      used.add(c.out_uid);
      used.add(c.in_uid);
      mark.run(transfersId, c.in_uid, c.out_uid);
      mark.run(transfersId, c.out_uid, c.in_uid);
      pairs++;
    }
  })();
  return pairs;
}

module.exports = { detectTransfers, WINDOW_SECONDS };
