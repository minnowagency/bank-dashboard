const { toCents, toEpochDay } = require('./money');

function visibleAccounts(db, user) {
  const sql = `SELECT * FROM accounts ${user.role === 'owner' ? '' : "WHERE visibility='company'"}
               ORDER BY kind ASC, COALESCE(display_name, name) ASC`;
  return db.prepare(sql).all();
}

function quietly(fn) { try { return fn(); } catch { return undefined; } }

function feedQuery(db, user, filters = {}) {
  const accounts = visibleAccounts(db, user);
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  if (accounts.length === 0) return { rows: [], accounts, categories, members: [] };

  const ids = accounts.map(a => a.id);
  const ph = ids.map(() => '?').join(',');
  const where = [`t.account_id IN (${ph})`];
  const params = [...ids];

  if (filters.account && ids.includes(filters.account)) { where.push('t.account_id = ?'); params.push(filters.account); }
  if (filters.category) { where.push('t.category_id = ?'); params.push(Number(filters.category)); }
  if (filters.uncategorized) where.push('t.category_id IS NULL');
  if (filters.q) { where.push("instr(lower(t.description), lower(?)) > 0"); params.push(filters.q); }
  if (filters.member) { where.push('t.card_member = ?'); params.push(filters.member); }
  const from = filters.from && quietly(() => toEpochDay(filters.from));
  if (from !== undefined && from !== null && from !== false) { where.push('t.posted_at >= ?'); params.push(from); }
  const to = filters.to && quietly(() => toEpochDay(filters.to));
  if (to) { where.push('t.posted_at < ?'); params.push(to + 86400); }
  const min = filters.min && quietly(() => toCents(filters.min));
  if (min !== undefined && min !== null && min !== false) { where.push('ABS(t.amount_cents) >= ?'); params.push(Math.abs(min)); }
  const max = filters.max && quietly(() => toCents(filters.max));
  if (max) { where.push('ABS(t.amount_cents) <= ?'); params.push(Math.abs(max)); }

  const rows = db.prepare(`
    SELECT t.*, c.name AS category_name,
           COALESCE(a.display_name, a.name) AS account_name, a.kind AS account_kind
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY t.posted_at DESC, t.uid DESC
    LIMIT 500`).all(...params);

  const members = db.prepare(`
    SELECT DISTINCT card_member FROM transactions
    WHERE card_member IS NOT NULL AND account_id IN (${ph})
    ORDER BY card_member`).all(...ids).map(r => r.card_member);

  return { rows, accounts, categories, members };
}

function totals(db, user) {
  const accounts = visibleAccounts(db, user);
  let cashCents = 0, owedCents = 0;
  for (const a of accounts) {
    if (a.kind === 'bank') cashCents += a.balance_cents;
    else owedCents += -a.balance_cents;
  }
  return { cashCents, owedCents };
}

module.exports = { visibleAccounts, feedQuery, totals };
