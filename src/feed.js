const { toCents, toEpochDay } = require('./money');

function visibleAccounts(db, user) {
  const sql = `SELECT * FROM accounts ${user.role === 'owner' ? '' : "WHERE visibility='company'"}
               ORDER BY kind ASC, COALESCE(display_name, name) ASC`;
  return db.prepare(sql).all();
}

function quietly(fn) { try { return fn(); } catch { return undefined; } }

// Coerce a raw filter input to a plain string: repeated query params arrive as
// arrays (?q=a&q=b), and non-strings must never reach a SQL bind.
const s = (v) => Array.isArray(v) ? String(v[0]) : (v === undefined || v === null ? '' : String(v));

// Treat a filter as absent when it's undefined/null/blank after trimming.
function isBlank(raw) {
  return raw === undefined || raw === null || String(raw).trim() === '';
}

function feedQuery(db, user, filters = {}, { limit = 500 } = {}) {
  const accounts = visibleAccounts(db, user);
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  if (accounts.length === 0) return { rows: [], accounts, categories, members: [] };

  const ids = accounts.map(a => a.id);
  const ph = ids.map(() => '?').join(',');
  const where = [`t.account_id IN (${ph})`];
  const params = [...ids];

  const account = s(filters.account);
  if (account && ids.includes(account)) { where.push('t.account_id = ?'); params.push(account); }
  const category = s(filters.category);
  if (category !== '' && Number.isInteger(Number(category))) { where.push('t.category_id = ?'); params.push(Number(category)); }
  if (filters.uncategorized) where.push('t.category_id IS NULL');
  const q = s(filters.q);
  if (q !== '') { where.push("instr(lower(t.description), lower(?)) > 0"); params.push(q); }
  const member = s(filters.member);
  if (member !== '') { where.push('t.card_member = ?'); params.push(member); }

  const fromRaw = filters.from;
  if (!isBlank(fromRaw)) {
    const from = quietly(() => toEpochDay(s(fromRaw)));
    if (Number.isFinite(from)) { where.push('t.posted_at >= ?'); params.push(from); }
  }
  const toRaw = filters.to;
  if (!isBlank(toRaw)) {
    const to = quietly(() => toEpochDay(s(toRaw)));
    if (Number.isFinite(to)) { where.push('t.posted_at < ?'); params.push(to + 86400); }
  }
  const minRaw = filters.min;
  if (!isBlank(minRaw)) {
    const min = quietly(() => toCents(s(minRaw)));
    if (Number.isFinite(min)) { where.push('ABS(t.amount_cents) >= ?'); params.push(Math.abs(min)); }
  }
  const maxRaw = filters.max;
  if (!isBlank(maxRaw)) {
    const max = quietly(() => toCents(s(maxRaw)));
    if (Number.isFinite(max)) { where.push('ABS(t.amount_cents) <= ?'); params.push(Math.abs(max)); }
  }

  const limitSql = limit ? `LIMIT ${Number(limit)}` : '';
  const rows = db.prepare(`
    SELECT t.*, c.name AS category_name,
           COALESCE(a.display_name, a.name) AS account_name, a.kind AS account_kind
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY t.posted_at DESC, t.uid DESC
    ${limitSql}`).all(...params);

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
