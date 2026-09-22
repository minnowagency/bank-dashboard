const { toCents, toEpochDay } = require('./money');

function visibleAccounts(db, user) {
  const sql = `SELECT * FROM accounts WHERE hidden = 0 ${user.role === 'owner' ? '' : "AND visibility='company'"}
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

const TZ = 'America/New_York';

// Wall-clock parts of an epoch in the business timezone.
function partsIn(epoch) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(epoch * 1000));
  const g = (t) => Number(f.find(p => p.type === t).value);
  return { year: g('year'), month: g('month'), day: g('day'),
           hour: g('hour') % 24, minute: g('minute'), second: g('second') };
}

// Epoch of Eastern midnight starting the given calendar day. The zone's offset
// is derived from the zone itself, so DST needs no special case.
function startOfDay(year, month, day) {
  const midday = Math.floor(Date.UTC(year, month - 1, day, 12, 0, 0) / 1000);
  const p = partsIn(midday);
  const offset = midday - Math.floor(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000);
  return Math.floor(Date.UTC(year, month - 1, day, 0, 0, 0) / 1000) + offset;
}

function addMonths(year, month, delta) {
  const zero = (year * 12) + (month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const PERIOD_KEYS = ['this-month', 'last-month', '30d', 'ytd', 'all'];

// A YYYY-MM-DD the user typed means that calendar day here, not in UTC.
function easternDay(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text).trim());
  if (!m) throw new Error(`expected YYYY-MM-DD, got: ${text}`);
  return startOfDay(Number(m[1]), Number(m[2]), Number(m[3]));
}

// Resolves the requested window to epoch bounds [from, to), plus the preceding
// window of the same length for the comparison figures.
function resolvePeriod(filters = {}, now = Math.floor(Date.now() / 1000)) {
  const rawFrom = isBlank(filters.from) ? null : quietly(() => easternDay(s(filters.from)));
  const rawTo = isBlank(filters.to) ? null : quietly(() => easternDay(s(filters.to)));
  if (Number.isFinite(rawFrom) || Number.isFinite(rawTo)) {
    const from = Number.isFinite(rawFrom) ? rawFrom : null;
    const to = Number.isFinite(rawTo) ? rawTo + 86400 : null; // the 'to' day is included
    const span = from !== null && to !== null ? to - from : null;
    return { key: 'custom', label: 'Custom range', from, to,
             prevFrom: span ? from - span : null, prevTo: span ? from : null };
  }

  const key = PERIOD_KEYS.includes(filters.period) ? filters.period : 'this-month';
  const t = partsIn(now);

  if (key === 'all') return { key, label: 'All time', from: null, to: null, prevFrom: null, prevTo: null };

  if (key === 'this-month' || key === 'last-month') {
    const cur = addMonths(t.year, t.month, key === 'last-month' ? -1 : 0);
    const next = addMonths(cur.year, cur.month, 1);
    const prev = addMonths(cur.year, cur.month, -1);
    return {
      key,
      label: cur.year === t.year ? MONTHS[cur.month - 1] : `${MONTHS[cur.month - 1]} ${cur.year}`,
      from: startOfDay(cur.year, cur.month, 1),
      to: startOfDay(next.year, next.month, 1),
      prevFrom: startOfDay(prev.year, prev.month, 1),
      prevTo: startOfDay(cur.year, cur.month, 1),
    };
  }
  if (key === 'ytd') {
    const from = startOfDay(t.year, 1, 1);
    return { key, label: `${t.year} to date`, from,
             to: startOfDay(t.year, t.month, t.day) + 86400,
             prevFrom: startOfDay(t.year - 1, 1, 1), prevTo: from };
  }
  const to = startOfDay(t.year, t.month, t.day) + 86400;
  const from = to - 30 * 86400;
  return { key, label: 'Last 30 days', from, to, prevFrom: from - 30 * 86400, prevTo: from };
}

// In / out / net over the window, excluding transfers (internal moves and card
// payments are neither income nor spending), scoped to what this user can see.
function periodSummary(db, user, filters = {}, now = Math.floor(Date.now() / 1000)) {
  const period = resolvePeriod(filters, now);
  const accounts = visibleAccounts(db, user);
  const account = s(filters.account);
  const ids = account && accounts.some(a => a.id === account)
    ? [account] : accounts.map(a => a.id);
  const zero = { inCents: 0, outCents: 0, netCents: 0 };
  if (ids.length === 0) {
    return { ...zero, period, prev: period.prevFrom === null ? null : { ...zero } };
  }

  const transfers = db.prepare("SELECT id FROM categories WHERE name='Transfers'").get();
  const ph = ids.map(() => '?').join(',');
  const window = (from, to) => {
    const where = [`t.account_id IN (${ph})`];
    const params = [...ids];
    if (transfers) { where.push('(t.category_id IS NULL OR t.category_id != ?)'); params.push(transfers.id); }
    if (from !== null) { where.push('t.posted_at >= ?'); params.push(from); }
    if (to !== null) { where.push('t.posted_at < ?'); params.push(to); }
    const row = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS inc,
        COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents END), 0) AS out
      FROM transactions t WHERE ${where.join(' AND ')}`).get(...params);
    return { inCents: row.inc, outCents: row.out, netCents: row.inc - row.out };
  };

  return { ...window(period.from, period.to), period,
           prev: period.prevFrom === null ? null : window(period.prevFrom, period.prevTo) };
}

function feedQuery(db, user, filters = {}, { limit = 500, now = Math.floor(Date.now() / 1000) } = {}) {
  const period = resolvePeriod(filters, now);
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

  // Date bounds come from the resolved period, which already folds in an
  // explicit from/to range when one was given.
  if (period.from !== null) { where.push('t.posted_at >= ?'); params.push(period.from); }
  if (period.to !== null) { where.push('t.posted_at < ?'); params.push(period.to); }
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

  return { rows, accounts, categories, members, period };
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

// Groups feed rows into day sections: pending first, then Today / Yesterday /
// "Tue, Sep 16", using the same timezone as periods.
function groupByDay(rows, now = Math.floor(Date.now() / 1000)) {
  const t = partsIn(now);
  const todayStart = startOfDay(t.year, t.month, t.day);
  const groups = [];
  const index = new Map();
  const push = (key, label, row) => {
    if (!index.has(key)) { index.set(key, { key, label, rows: [] }); groups.push(index.get(key)); }
    index.get(key).rows.push(row);
  };
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
  for (const row of rows) {
    if (row.pending) { push('pending', 'Pending', row); continue; }
    const p = partsIn(row.posted_at);
    const dayStart = startOfDay(p.year, p.month, p.day);
    const label = dayStart === todayStart ? 'Today'
      : dayStart === todayStart - 86400 ? 'Yesterday'
      : fmt.format(new Date(row.posted_at * 1000));
    push(`d${dayStart}`, label, row);
  }
  // pending always leads
  groups.sort((a, b) => (a.key === 'pending' ? -1 : b.key === 'pending' ? 1 : 0));
  return groups;
}

module.exports = { visibleAccounts, feedQuery, totals, resolvePeriod, periodSummary, groupByDay, TZ };
