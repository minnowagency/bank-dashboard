# Bank Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** View-only web dashboard for ~10 Truist accounts + Amex cards via SimpleFIN, with two users (owner/member), per-account visibility, rules-based categorization, notes, transfer pairing, review queue, and CSV export.

**Architecture:** One Node.js process: an in-process sync job pulls SimpleFIN every 4h into SQLite; Express serves server-rendered EJS pages behind cookie sessions; Caddy terminates HTTPS on a dedicated droplet.

**Tech Stack:** Node.js ≥20 (CommonJS), Express 4, EJS, better-sqlite3, bcryptjs, cookie-parser; tests with built-in `node --test` + supertest.

**Spec:** `docs/superpowers/specs/2026-09-06-bank-dashboard-design.md`

## Global Constraints

- Node ≥ 20, CommonJS (`require`), no build pipeline, no SPA framework.
- Money is **integer cents** everywhere (`amount_cents`); never floats. Timestamps are **epoch seconds**.
- All DB access via better-sqlite3 (synchronous). One SQLite file; WAL mode; foreign keys ON.
- The app binds **127.0.0.1 only**. Caddy is the only public listener.
- The SimpleFIN access URL lives only in `.env` (never git, never SQLite).
- Visibility rule: a `member` user must never see accounts with `visibility='private'` — absent, not masked — in every route, count, filter dropdown, and export.
- New accounts default `visibility='private'`. Sync upserts never overwrite `visibility`, `kind`, or `display_name`.
- Rules/transfer categorization only ever touches rows with `category_id IS NULL`; `category_source='manual'` rows are untouchable by automation.
- Tests: `npm test` runs `node --test test/`. Every task ends green. Commit after every task with the given message.
- Run all commands from the repo root `~/bank-dashboard` unless stated otherwise.

---

### Task 1: Scaffold, schema, db module

**Files:**
- Create: `package.json`, `src/schema.sql`, `src/db.js`, `test/db.test.js`
- Modify: `.gitignore` (append)

**Interfaces:**
- Produces: `openDb(dbPath)` → better-sqlite3 Database with schema applied + categories seeded; `SEED_CATEGORIES` array. All later tasks call `openDb(':memory:')` in tests.

- [ ] **Step 1: Scaffold package**

Create `package.json`:

```json
{
  "name": "bank-dashboard",
  "private": true,
  "version": "0.1.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test test/",
    "start": "node bin/serve.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^11.3.0",
    "cookie-parser": "^1.4.6",
    "ejs": "^3.1.10",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "supertest": "^7.0.0"
  }
}
```

Append to `.gitignore`:

```
node_modules/
data/
.env
```

Run: `npm install` — expect a lockfile and no errors (better-sqlite3 compiles natively; needs Xcode CLT locally, build-essential on the droplet).

- [ ] **Step 2: Write the failing test**

`test/db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, SEED_CATEGORIES } = require('../src/db');

test('openDb creates schema and seeds categories', () => {
  const db = openDb(':memory:');
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  for (const t of ['users','sessions','accounts','transactions','categories','rules','sync_runs','settings']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const cats = db.prepare('SELECT name FROM categories ORDER BY id').all().map(r => r.name);
  assert.deepEqual(cats, SEED_CATEGORIES);
});

test('openDb is idempotent on an existing file', () => {
  const path = require('path').join(require('os').tmpdir(), `bd-test-${process.pid}.sqlite3`);
  require('fs').rmSync(path, { force: true });
  openDb(path).close();
  const db = openDb(path); // second open must not error or duplicate seeds
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM categories').get().n, SEED_CATEGORIES.length);
  db.close();
  require('fs').rmSync(path, { force: true });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/db`.

- [ ] **Step 4: Write schema and db module**

`src/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,               -- SimpleFIN account id
  name TEXT NOT NULL,
  display_name TEXT,                 -- owner-set; sync never touches
  org_name TEXT,
  kind TEXT NOT NULL DEFAULT 'bank' CHECK (kind IN ('bank','credit')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('company','private')),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  balance_date INTEGER,
  last_synced_at INTEGER,
  sync_error TEXT
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position INTEGER NOT NULL,
  pattern TEXT NOT NULL,             -- case-insensitive substring of description
  account_id TEXT REFERENCES accounts(id),
  amount_cents INTEGER,              -- optional exact-amount condition
  category_id INTEGER NOT NULL REFERENCES categories(id),
  owner_only INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  uid TEXT PRIMARY KEY,              -- account_id || '|' || sf_id
  sf_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  posted_at INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0,
  card_member TEXT,
  category_id INTEGER REFERENCES categories(id),
  category_source TEXT CHECK (category_source IN ('rule','manual','transfer')),
  categorized_by INTEGER REFERENCES users(id),
  rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  note TEXT,
  note_by INTEGER REFERENCES users(id),
  transfer_pair_uid TEXT,
  first_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_account_posted ON transactions(account_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_txn_posted ON transactions(posted_at);
CREATE INDEX IF NOT EXISTS idx_txn_uncat ON transactions(category_id) WHERE category_id IS NULL;

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`src/db.js`:

```js
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SEED_CATEGORIES = ['Payroll', 'Shipping', 'Supplies', 'Taxes', 'Fees',
  'Transfers', 'Revenue', 'Utilities', 'Insurance', 'Other'];

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const insert = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
  for (const c of SEED_CATEGORIES) insert.run(c);
  return db;
}

module.exports = { openDb, SEED_CATEGORIES };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test` — Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore src/ test/
git commit -m "feat: scaffold project with sqlite schema and db module"
```

---

### Task 2: Money helpers

**Files:**
- Create: `src/money.js`, `test/money.test.js`

**Interfaces:**
- Produces: `toCents(strOrNum)` → integer cents (throws on garbage); `fmtUSD(cents)` → `"-$1,234.05"` style string; `toEpochDay(yyyyMmDd)` → epoch seconds at UTC midnight. Used by simplefin client, feed filters, and views.

- [ ] **Step 1: Write the failing test**

`test/money.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { toCents, fmtUSD, toEpochDay } = require('../src/money');

test('toCents parses decimal strings exactly', () => {
  assert.equal(toCents('12.34'), 1234);
  assert.equal(toCents('-9.5'), -950);
  assert.equal(toCents('0.07'), 7);
  assert.equal(toCents('1000'), 100000);
  assert.equal(toCents(25), 2500);          // numeric input tolerated
  assert.throws(() => toCents('12.345'));   // >2 decimals: refuse, don't round
  assert.throws(() => toCents('abc'));
  assert.throws(() => toCents(''));
});

test('fmtUSD formats cents', () => {
  assert.equal(fmtUSD(1234), '$12.34');
  assert.equal(fmtUSD(-950), '-$9.50');
  assert.equal(fmtUSD(123456789), '$1,234,567.89');
  assert.equal(fmtUSD(0), '$0.00');
});

test('toEpochDay parses YYYY-MM-DD as UTC midnight', () => {
  assert.equal(toEpochDay('1970-01-02'), 86400);
  assert.throws(() => toEpochDay('02/01/1970'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/money.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/money.js`:

```js
function toCents(v) {
  const s = String(v).trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`unparseable amount: ${JSON.stringify(v)}`);
  const [, sign, whole, frac = ''] = m;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(cents)) throw new Error(`amount out of range: ${s}`);
  return sign === '-' ? -cents : cents;
}

function fmtUSD(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

function toEpochDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`expected YYYY-MM-DD, got: ${s}`);
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000);
}

module.exports = { toCents, fmtUSD, toEpochDay };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add src/money.js test/money.test.js
git commit -m "feat: money parsing/formatting helpers (integer cents)"
```

---

### Task 3: SimpleFIN client

**Files:**
- Create: `src/simplefin.js`, `test/simplefin.test.js`

**Interfaces:**
- Consumes: `toCents` from `src/money.js`.
- Produces:
  - `claimSetupToken(setupToken, fetchFn = fetch)` → `Promise<string>` access URL.
  - `fetchAccounts(accessUrl, { startDate = 0, fetchFn = fetch })` → `Promise<{ errors: string[], accounts: Array<{ id, name, orgName, balanceCents, balanceDate, transactions: Array<{ id, postedAt, amountCents, description, pending, cardMember }> }> }>`
- Protocol notes for the implementer: a SimpleFIN **setup token is base64 of a claim URL**; POSTing to the claim URL (once) returns the **access URL** in the response body. The access URL embeds basic-auth credentials (`https://user:pass@host/simplefin`). **Node's `fetch` rejects URLs with embedded credentials**, so credentials must be stripped and sent as an `Authorization: Basic` header. Accounts endpoint: `GET {base}/accounts?start-date=<epoch>&pending=1`.

- [ ] **Step 1: Write the failing test**

`test/simplefin.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { claimSetupToken, fetchAccounts } = require('../src/simplefin');

function fakeResponse(body, { status = 200, json = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => (json ? body : JSON.parse(body)),
  };
}

test('claimSetupToken decodes base64 and POSTs to the claim URL', async () => {
  const claimUrl = 'https://bridge.simplefin.org/simplefin/claim/DEMO';
  const setupToken = Buffer.from(claimUrl).toString('base64');
  let seen;
  const fetchFn = async (url, opts) => { seen = { url, opts }; return fakeResponse('https://u:p@bridge.simplefin.org/simplefin\n'); };
  const accessUrl = await claimSetupToken(setupToken, fetchFn);
  assert.equal(seen.url, claimUrl);
  assert.equal(seen.opts.method, 'POST');
  assert.equal(accessUrl, 'https://u:p@bridge.simplefin.org/simplefin');
});

test('claimSetupToken rejects tokens that do not decode to https URLs', async () => {
  await assert.rejects(() => claimSetupToken(Buffer.from('garbage').toString('base64'), async () => fakeResponse('')));
});

const SAMPLE = {
  errors: ['Connection to Truist may need attention'],
  accounts: [{
    id: 'ACT-1', name: 'Business Checking', currency: 'USD',
    balance: '42180.10', 'balance-date': 1789000000,
    org: { name: 'Truist' },
    transactions: [
      { id: 'TX-1', posted: 1788900000, amount: '-1240.00', description: 'UPS FREIGHT' },
      { id: 'TX-2', posted: 1788910000, amount: '6801.22', description: 'STRIPE PAYOUT', pending: true,
        extra: { card_member: 'JANE DOE' } },
    ],
  }],
};

test('fetchAccounts strips credentials into a Basic auth header and normalizes', async () => {
  let seen;
  const fetchFn = async (url, opts) => { seen = { url, opts }; return fakeResponse(SAMPLE, { json: true }); };
  const out = await fetchAccounts('https://u:p@example.org/simplefin', { startDate: 123, fetchFn });

  assert.equal(seen.url, 'https://example.org/simplefin/accounts?start-date=123&pending=1');
  assert.equal(seen.opts.headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.deepEqual(out.errors, ['Connection to Truist may need attention']);

  const a = out.accounts[0];
  assert.equal(a.id, 'ACT-1');
  assert.equal(a.orgName, 'Truist');
  assert.equal(a.balanceCents, 4218010);
  assert.equal(a.balanceDate, 1789000000);
  assert.deepEqual(a.transactions[0], {
    id: 'TX-1', postedAt: 1788900000, amountCents: -124000,
    description: 'UPS FREIGHT', pending: 0, cardMember: null,
  });
  assert.equal(a.transactions[1].pending, 1);
  assert.equal(a.transactions[1].cardMember, 'JANE DOE');
});

test('fetchAccounts throws on non-2xx', async () => {
  await assert.rejects(
    () => fetchAccounts('https://u:p@example.org/simplefin', { fetchFn: async () => fakeResponse('nope', { status: 403 }) }),
    /403/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/simplefin.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/simplefin.js`:

```js
const { toCents } = require('./money');

async function claimSetupToken(setupToken, fetchFn = fetch) {
  const claimUrl = Buffer.from(String(setupToken).trim(), 'base64').toString('utf8');
  if (!/^https:\/\//.test(claimUrl)) throw new Error('setup token did not decode to an https claim URL');
  const res = await fetchFn(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } });
  if (!res.ok) throw new Error(`claim failed: HTTP ${res.status}`);
  return (await res.text()).trim();
}

function splitAuth(accessUrl) {
  const u = new URL(accessUrl);
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  const base = u.toString().replace(/\/$/, '');
  return { base, header: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

function normalizeTxn(t) {
  return {
    id: t.id,
    postedAt: t.posted || t.transacted_at || 0,
    amountCents: toCents(t.amount),
    description: t.description || '',
    pending: t.pending ? 1 : 0,
    cardMember: (t.extra && (t.extra.card_member || t.extra['card-member'])) || null,
  };
}

async function fetchAccounts(accessUrl, { startDate = 0, fetchFn = fetch } = {}) {
  const { base, header } = splitAuth(accessUrl);
  const res = await fetchFn(`${base}/accounts?start-date=${startDate}&pending=1`, {
    headers: { Authorization: header },
  });
  if (!res.ok) throw new Error(`accounts fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  return {
    errors: body.errors || [],
    accounts: (body.accounts || []).map((a) => ({
      id: a.id,
      name: a.name,
      orgName: (a.org && (a.org.name || a.org.domain)) || '',
      balanceCents: toCents(a.balance),
      balanceDate: a['balance-date'] || null,
      transactions: (a.transactions || []).map(normalizeTxn),
    })),
  };
}

module.exports = { claimSetupToken, fetchAccounts };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/simplefin.js test/simplefin.test.js
git commit -m "feat: SimpleFIN client (claim token, fetch + normalize accounts)"
```

---

### Task 4: Sync engine — account & transaction upserts

**Files:**
- Create: `src/sync.js`, `test/sync.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 1); the normalized shape returned by `fetchAccounts` (Task 3).
- Produces: `runSync(db, { accessUrl, fetchAccountsFn, now })` → `Promise<{ ok, errors, newTransactions }>`. Also exports `OVERLAP_SECONDS`. Tasks 5–6 extend this file; Task 14 schedules it.
- Behavior contract: upserts accounts **without touching** `visibility`, `kind`, `display_name`; upserts transactions by `uid = accountId|txnId` **without touching** `category_id`, `category_source`, `categorized_by`, `rule_id`, `note`, `note_by`, `transfer_pair_uid`; records a `sync_runs` row either way; stores `last_sync_start` in settings and re-fetches with a 7-day overlap; stores connection-level errors as JSON in settings key `sync_errors`; guesses `kind='credit'` only on **first insert** when org/name matches /american express|amex|card/i.

- [ ] **Step 1: Write the failing test**

`test/sync.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { runSync, OVERLAP_SECONDS } = require('../src/sync');

const NOW = 1789000000;
const now = () => NOW;

function payload() {
  return {
    errors: [],
    accounts: [{
      id: 'A1', name: 'Business Checking', orgName: 'Truist',
      balanceCents: 100000, balanceDate: NOW - 100,
      transactions: [
        { id: 'T1', postedAt: NOW - 5000, amountCents: -124000, description: 'UPS FREIGHT', pending: 1, cardMember: null },
      ],
    }],
  };
}

test('first sync inserts accounts (private by default) and transactions', async () => {
  const db = openDb(':memory:');
  const r = await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => payload(), now });
  assert.equal(r.ok, true);
  const a = db.prepare("SELECT * FROM accounts WHERE id='A1'").get();
  assert.equal(a.visibility, 'private');
  assert.equal(a.kind, 'bank');
  assert.equal(a.balance_cents, 100000);
  const t = db.prepare("SELECT * FROM transactions WHERE uid='A1|T1'").get();
  assert.equal(t.amount_cents, -124000);
  assert.equal(t.pending, 1);
  const run = db.prepare('SELECT * FROM sync_runs').get();
  assert.equal(run.ok, 1);
});

test('re-sync updates pending->posted without duplicating or clobbering annotations', async () => {
  const db = openDb(':memory:');
  await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => payload(), now });
  db.prepare("UPDATE accounts SET visibility='company', display_name='Ops', kind='credit' WHERE id='A1'").run();
  db.prepare("UPDATE transactions SET note='trade show', note_by=1, category_id=3, category_source='manual', categorized_by=1 WHERE uid='A1|T1'").run();

  const second = payload();
  second.accounts[0].transactions[0].pending = 0;           // posted now
  second.accounts[0].transactions[0].description = 'UPS FREIGHT 123'; // bank finalized text
  await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => second, now });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 1);
  const t = db.prepare("SELECT * FROM transactions WHERE uid='A1|T1'").get();
  assert.equal(t.pending, 0);
  assert.equal(t.description, 'UPS FREIGHT 123');
  assert.equal(t.note, 'trade show');
  assert.equal(t.category_source, 'manual');
  assert.equal(t.category_id, 3);
  const a = db.prepare("SELECT * FROM accounts WHERE id='A1'").get();
  assert.equal(a.visibility, 'company');   // sync must not reset
  assert.equal(a.display_name, 'Ops');
  assert.equal(a.kind, 'credit');
});

test('amex-looking new accounts get kind=credit on first insert', async () => {
  const db = openDb(':memory:');
  const p = payload();
  p.accounts[0].id = 'AMX1';
  p.accounts[0].orgName = 'American Express';
  await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => p, now });
  assert.equal(db.prepare("SELECT kind FROM accounts WHERE id='AMX1'").get().kind, 'credit');
});

test('uses last_sync_start minus overlap as start-date on the next run', async () => {
  const db = openDb(':memory:');
  const seen = [];
  const f = async (url, opts) => { seen.push(opts.startDate); return payload(); };
  await runSync(db, { accessUrl: 'x', fetchAccountsFn: (u, o) => f(u, o), now });
  await runSync(db, { accessUrl: 'x', fetchAccountsFn: (u, o) => f(u, o), now: () => NOW + 100 });
  assert.equal(seen[0], 0);
  assert.equal(seen[1], NOW - OVERLAP_SECONDS);
});

test('failed fetch records a failed sync_run and returns ok:false', async () => {
  const db = openDb(':memory:');
  const r = await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => { throw new Error('boom'); }, now });
  assert.equal(r.ok, false);
  const run = db.prepare('SELECT * FROM sync_runs').get();
  assert.equal(run.ok, 0);
  assert.match(run.error, /boom/);
});

test('connection errors are stored in settings sync_errors', async () => {
  const db = openDb(':memory:');
  const p = payload();
  p.errors = ['Connection to Truist may need attention'];
  await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => p, now });
  const stored = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='sync_errors'").get().value);
  assert.deepEqual(stored, ['Connection to Truist may need attention']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sync.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/sync.js`:

```js
const OVERLAP_SECONDS = 7 * 86400;

function guessKind(orgName, name) {
  return /american express|amex|card/i.test(`${orgName} ${name}`) ? 'credit' : 'bank';
}

async function runSync(db, { accessUrl, fetchAccountsFn, now = () => Math.floor(Date.now() / 1000) }) {
  const startedAt = now();
  const runId = db.prepare('INSERT INTO sync_runs (started_at) VALUES (?)').run(startedAt).lastInsertRowid;
  try {
    const last = db.prepare("SELECT value FROM settings WHERE key='last_sync_start'").get();
    const startDate = last ? Math.max(0, Number(last.value) - OVERLAP_SECONDS) : 0;
    const { errors, accounts } = await fetchAccountsFn(accessUrl, { startDate });

    const upsertAccount = db.prepare(`
      INSERT INTO accounts (id, name, org_name, kind, balance_cents, balance_date, last_synced_at, sync_error)
      VALUES (@id, @name, @orgName, @kind, @balanceCents, @balanceDate, @syncedAt, NULL)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        org_name = excluded.org_name,
        balance_cents = excluded.balance_cents,
        balance_date = excluded.balance_date,
        last_synced_at = excluded.last_synced_at,
        sync_error = NULL`);

    const upsertTxn = db.prepare(`
      INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description,
                                pending, card_member, first_seen_at)
      VALUES (@uid, @sfId, @accountId, @postedAt, @amountCents, @description,
              @pending, @cardMember, @firstSeen)
      ON CONFLICT(uid) DO UPDATE SET
        posted_at = excluded.posted_at,
        amount_cents = excluded.amount_cents,
        description = excluded.description,
        pending = excluded.pending,
        card_member = COALESCE(excluded.card_member, transactions.card_member)`);

    const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

    let newTransactions = 0;
    const before = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
    db.transaction(() => {
      for (const a of accounts) {
        upsertAccount.run({
          id: a.id, name: a.name, orgName: a.orgName,
          kind: guessKind(a.orgName, a.name),
          balanceCents: a.balanceCents, balanceDate: a.balanceDate, syncedAt: now(),
        });
        for (const t of a.transactions) {
          upsertTxn.run({
            uid: `${a.id}|${t.id}`, sfId: t.id, accountId: a.id,
            postedAt: t.postedAt, amountCents: t.amountCents, description: t.description,
            pending: t.pending, cardMember: t.cardMember, firstSeen: now(),
          });
        }
      }
      setSetting.run('last_sync_start', String(startedAt));
      setSetting.run('sync_errors', JSON.stringify(errors));
    })();
    newTransactions = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n - before;

    db.prepare('UPDATE sync_runs SET finished_at = ?, ok = 1 WHERE id = ?').run(now(), runId);
    return { ok: true, errors, newTransactions };
  } catch (err) {
    db.prepare('UPDATE sync_runs SET finished_at = ?, ok = 0, error = ? WHERE id = ?')
      .run(now(), String((err && err.message) || err), runId);
    return { ok: false, errors: [String((err && err.message) || err)], newTransactions: 0 };
  }
}

module.exports = { runSync, OVERLAP_SECONDS, guessKind };
```

Note: `guessKind` is passed only on INSERT; the `ON CONFLICT ... DO UPDATE` clause deliberately omits `kind`, `visibility`, and `display_name`, which is what makes the "never clobber owner settings" test pass.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync.js test/sync.test.js
git commit -m "feat: sync engine with annotation-preserving upserts and overlap window"
```

---

### Task 5: Transfer detection

**Files:**
- Create: `src/transfers.js`, `test/transfers.test.js`

**Interfaces:**
- Consumes: schema (Task 1); seeded 'Transfers' category.
- Produces: `detectTransfers(db)` → number of pairs marked. Marks both sides: `category_id = <Transfers>`, `category_source='transfer'`, `transfer_pair_uid=<other uid>`. Only touches rows where `category_id IS NULL AND transfer_pair_uid IS NULL`. Window ±3 days; closest-dated first; each transaction pairs at most once. Task 6 wires it into `runSync` **before** rules.

- [ ] **Step 1: Write the failing test**

`test/transfers.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { detectTransfers } = require('../src/transfers');

const DAY = 86400;
const T0 = 1789000000;

function seed(db) {
  db.prepare("INSERT INTO accounts (id, name) VALUES ('CHK','Checking'),('SAV','Savings'),('AMX','Amex')").run();
}
let seq = 0;
function txn(db, accountId, amountCents, postedAt, extra = {}) {
  const uid = `${accountId}|t${++seq}`;
  db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, first_seen_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(uid, `t${seq}`, accountId, postedAt, amountCents, extra.description || 'XFER', T0);
  if (extra.categoryId) db.prepare('UPDATE transactions SET category_id=? WHERE uid=?').run(extra.categoryId, uid);
  return uid;
}

test('pairs opposite-sign equal amounts across accounts within 3 days', () => {
  const db = openDb(':memory:');
  seed(db);
  const out = txn(db, 'CHK', -50000, T0);
  const inn = txn(db, 'SAV', 50000, T0 + DAY);
  assert.equal(detectTransfers(db), 1);
  const a = db.prepare('SELECT * FROM transactions WHERE uid=?').get(out);
  const b = db.prepare('SELECT * FROM transactions WHERE uid=?').get(inn);
  const transfersId = db.prepare("SELECT id FROM categories WHERE name='Transfers'").get().id;
  assert.equal(a.category_id, transfersId);
  assert.equal(a.category_source, 'transfer');
  assert.equal(a.transfer_pair_uid, b.uid);
  assert.equal(b.transfer_pair_uid, a.uid);
});

test('does not pair outside the window, same account, or already-categorized rows', () => {
  const db = openDb(':memory:');
  seed(db);
  txn(db, 'CHK', -10000, T0);
  txn(db, 'SAV', 10000, T0 + 4 * DAY);              // too far apart
  txn(db, 'CHK', -20000, T0);
  txn(db, 'CHK', 20000, T0);                        // same account
  txn(db, 'CHK', -30000, T0);
  txn(db, 'SAV', 30000, T0, { categoryId: 1 });     // already categorized
  assert.equal(detectTransfers(db), 0);
});

test('ambiguous candidates pair closest-dated first, each side used once', () => {
  const db = openDb(':memory:');
  seed(db);
  const out1 = txn(db, 'CHK', -75000, T0);
  const inFar = txn(db, 'AMX', 75000, T0 + 2 * DAY);
  const inNear = txn(db, 'AMX', 75000, T0);
  assert.equal(detectTransfers(db), 1);
  assert.equal(db.prepare('SELECT transfer_pair_uid FROM transactions WHERE uid=?').get(out1).transfer_pair_uid, inNear);
  assert.equal(db.prepare('SELECT transfer_pair_uid FROM transactions WHERE uid=?').get(inFar).transfer_pair_uid, null);
});

test('idempotent: second run finds nothing new', () => {
  const db = openDb(':memory:');
  seed(db);
  txn(db, 'CHK', -50000, T0);
  txn(db, 'SAV', 50000, T0);
  assert.equal(detectTransfers(db), 1);
  assert.equal(detectTransfers(db), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/transfers.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/transfers.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transfers.js test/transfers.test.js
git commit -m "feat: transfer detection with closest-date pairing"
```

---

### Task 6: Rules engine + pipeline wiring

**Files:**
- Create: `src/rules.js`, `test/rules.test.js`
- Modify: `src/sync.js` (wire pipeline), `test/sync.test.js` (add pipeline test)

**Interfaces:**
- Consumes: schema (Task 1), `detectTransfers` (Task 5), `runSync` (Task 4).
- Produces:
  - `applyRulesToUncategorized(db)` → count categorized. Sets `category_id`, `category_source='rule'`, `rule_id`; only touches `category_id IS NULL` rows; rules ordered by `position`, first match wins. Match = description contains `pattern` case-insensitively AND (`account_id` null or equal) AND (`amount_cents` null or equal).
  - `createRule(db, { pattern, accountId, amountCents, categoryId, ownerOnly, createdBy })` → rule id (appends at max position + 1, then applies retroactively).
  - `runSync` now ends with: `detectTransfers(db)` **then** `applyRulesToUncategorized(db)` (structural signal beats text match), and returns `{ ok, errors, newTransactions, transferPairs, ruleMatches }`.

- [ ] **Step 1: Write the failing test**

`test/rules.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { applyRulesToUncategorized, createRule } = require('../src/rules');

const T0 = 1789000000;
let seq = 0;
function txn(db, accountId, description, amountCents, opts = {}) {
  const uid = `${accountId}|t${++seq}`;
  db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, first_seen_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(uid, `t${seq}`, accountId, T0, amountCents, description, T0);
  if (opts.manualCategory) {
    db.prepare("UPDATE transactions SET category_id=?, category_source='manual', categorized_by=1 WHERE uid=?")
      .run(opts.manualCategory, uid);
  }
  return uid;
}
function cat(db, name) { return db.prepare('SELECT id FROM categories WHERE name=?').get(name).id; }

test('first matching rule wins, in position order, case-insensitive', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO accounts (id, name) VALUES ('A','A')").run();
  const shipping = cat(db, 'Shipping'), fees = cat(db, 'Fees');
  db.prepare('INSERT INTO rules (position, pattern, category_id) VALUES (1, ?, ?)').run('ups', shipping);
  db.prepare('INSERT INTO rules (position, pattern, category_id) VALUES (2, ?, ?)').run('UPS FREIGHT', fees);
  const uid = txn(db, 'A', 'UPS FREIGHT 00123', -5000);
  assert.equal(applyRulesToUncategorized(db), 1);
  const t = db.prepare('SELECT * FROM transactions WHERE uid=?').get(uid);
  assert.equal(t.category_id, shipping);       // position 1 won despite rule 2 also matching
  assert.equal(t.category_source, 'rule');
  assert.equal(t.rule_id, 1);
});

test('account and amount conditions restrict matches', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO accounts (id, name) VALUES ('A','A'),('B','B')").run();
  const fees = cat(db, 'Fees');
  db.prepare("INSERT INTO rules (position, pattern, account_id, amount_cents, category_id) VALUES (1, 'FEE', 'A', -2500, ?)").run(fees);
  const hit = txn(db, 'A', 'MONTHLY FEE', -2500);
  const wrongAccount = txn(db, 'B', 'MONTHLY FEE', -2500);
  const wrongAmount = txn(db, 'A', 'MONTHLY FEE', -2600);
  assert.equal(applyRulesToUncategorized(db), 1);
  assert.equal(db.prepare('SELECT category_id FROM transactions WHERE uid=?').get(hit).category_id, fees);
  assert.equal(db.prepare('SELECT category_id FROM transactions WHERE uid=?').get(wrongAccount).category_id, null);
  assert.equal(db.prepare('SELECT category_id FROM transactions WHERE uid=?').get(wrongAmount).category_id, null);
});

test('never touches manually categorized rows', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO accounts (id, name) VALUES ('A','A')").run();
  const shipping = cat(db, 'Shipping'), other = cat(db, 'Other');
  db.prepare("INSERT INTO rules (position, pattern, category_id) VALUES (1, 'UPS', ?)").run(shipping);
  const uid = txn(db, 'A', 'UPS STORE', -1000, { manualCategory: other });
  assert.equal(applyRulesToUncategorized(db), 0);
  const t = db.prepare('SELECT * FROM transactions WHERE uid=?').get(uid);
  assert.equal(t.category_id, other);
  assert.equal(t.category_source, 'manual');
});

test('createRule appends at end and applies retroactively to uncategorized only', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO accounts (id, name) VALUES ('A','A')").run();
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('m','x','owner')").run();
  const shipping = cat(db, 'Shipping');
  const uid = txn(db, 'A', 'FEDEX 771', -3000);
  db.prepare("INSERT INTO rules (position, pattern, category_id) VALUES (5, 'zzz', 1)").run();
  const id = createRule(db, { pattern: 'FEDEX', categoryId: shipping, ownerOnly: false, createdBy: 1 });
  const r = db.prepare('SELECT * FROM rules WHERE id=?').get(id);
  assert.equal(r.position, 6);
  assert.equal(db.prepare('SELECT category_id FROM transactions WHERE uid=?').get(uid).category_id, shipping);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rules.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/rules.js`:

```js
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
```

- [ ] **Step 4: Wire the pipeline into runSync**

In `src/sync.js`, add at the top:

```js
const { detectTransfers } = require('./transfers');
const { applyRulesToUncategorized } = require('./rules');
```

In `runSync`, replace the success return with:

```js
    const transferPairs = detectTransfers(db);
    const ruleMatches = applyRulesToUncategorized(db);
    db.prepare('UPDATE sync_runs SET finished_at = ?, ok = 1 WHERE id = ?').run(now(), runId);
    return { ok: true, errors, newTransactions, transferPairs, ruleMatches };
```

Append to `test/sync.test.js`:

```js
test('runSync pipeline: transfers detected before rules apply', async () => {
  const db = openDb(':memory:');
  const fees = db.prepare("SELECT id FROM categories WHERE name='Fees'").get().id;
  db.prepare("INSERT INTO rules (position, pattern, category_id) VALUES (1, 'PAYMENT', ?)").run(fees);
  const p = {
    errors: [],
    accounts: [
      { id: 'CHK', name: 'Checking', orgName: 'Truist', balanceCents: 0, balanceDate: NOW,
        transactions: [{ id: 'o1', postedAt: NOW, amountCents: -80000, description: 'AMEX EPAYMENT', pending: 0, cardMember: null }] },
      { id: 'AMX', name: 'Card', orgName: 'American Express', balanceCents: 0, balanceDate: NOW,
        transactions: [{ id: 'i1', postedAt: NOW, amountCents: 80000, description: 'PAYMENT RECEIVED', pending: 0, cardMember: null }] },
    ],
  };
  const r = await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => p, now });
  assert.equal(r.transferPairs, 1);
  assert.equal(r.ruleMatches, 0); // transfer pairing won even though the 'PAYMENT' rule also matched
  const transfersId = db.prepare("SELECT id FROM categories WHERE name='Transfers'").get().id;
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='CHK|o1'").get().category_id, transfersId);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rules.js src/sync.js test/rules.test.js test/sync.test.js
git commit -m "feat: rules engine, createRule, and transfers-then-rules sync pipeline"
```

---

### Task 7: Auth — users, sessions, lockout, CLI

**Files:**
- Create: `src/auth.js`, `bin/create-user.js`, `test/auth.test.js`

**Interfaces:**
- Consumes: schema (Task 1).
- Produces (all consumed by Task 9's Express app):
  - `createUser(db, username, password, role)` — insert or reset (role in `'owner'|'member'`).
  - `verifyLogin(db, username, password, now)` → `{ ok: true, user }` or `{ ok: false, reason: 'bad-credentials'|'locked' }`. 5 consecutive failures → locked 15 min; success resets counter.
  - `createSession(db, userId, now)` → 64-hex token, 30-day expiry. `getSessionUser(db, token, now)` → user row or null. `deleteSession(db, token)`.
  - Constants: `SESSION_TTL_SECONDS`, `LOCKOUT_AFTER`, `LOCKOUT_SECONDS`.
- CLI: `node bin/create-user.js <username> <owner|member>` reads the password from stdin (invisible), then upserts the user. Used at deploy time.

- [ ] **Step 1: Write the failing test**

`test/auth.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createUser, verifyLogin, createSession, getSessionUser, deleteSession,
        SESSION_TTL_SECONDS, LOCKOUT_AFTER, LOCKOUT_SECONDS } = require('../src/auth');

const NOW = 1789000000;

test('createUser + verifyLogin round-trip; wrong password rejected', () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'hunter2!', 'owner');
  assert.equal(verifyLogin(db, 'michael', 'wrong', NOW).ok, false);
  const r = verifyLogin(db, 'michael', 'hunter2!', NOW);
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 'owner');
  assert.equal(verifyLogin(db, 'nobody', 'x', NOW).ok, false);
});

test('5 failures lock the account for 15 minutes; success resets', () => {
  const db = openDb(':memory:');
  createUser(db, 'asst', 'pw', 'member');
  for (let i = 0; i < LOCKOUT_AFTER; i++) assert.equal(verifyLogin(db, 'asst', 'bad', NOW).ok, false);
  const locked = verifyLogin(db, 'asst', 'pw', NOW + 10);        // right password, but locked
  assert.deepEqual({ ok: locked.ok, reason: locked.reason }, { ok: false, reason: 'locked' });
  const after = verifyLogin(db, 'asst', 'pw', NOW + LOCKOUT_SECONDS + 1);
  assert.equal(after.ok, true);
  assert.equal(db.prepare("SELECT failed_attempts FROM users WHERE username='asst'").get().failed_attempts, 0);
});

test('sessions: create, fetch, expire, delete', () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'pw', 'owner');
  const uid = db.prepare("SELECT id FROM users WHERE username='michael'").get().id;
  const token = createSession(db, uid, NOW);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(getSessionUser(db, token, NOW + 100).username, 'michael');
  assert.equal(getSessionUser(db, token, NOW + SESSION_TTL_SECONDS + 1), null);
  deleteSession(db, token);
  assert.equal(getSessionUser(db, token, NOW + 100), null);
  assert.equal(getSessionUser(db, 'nonsense', NOW), null);
  assert.equal(getSessionUser(db, undefined, NOW), null);
});

test('createUser on existing username resets password and clears lockout', () => {
  const db = openDb(':memory:');
  createUser(db, 'asst', 'old', 'member');
  for (let i = 0; i < LOCKOUT_AFTER; i++) verifyLogin(db, 'asst', 'bad', NOW);
  createUser(db, 'asst', 'newpw', 'member');
  assert.equal(verifyLogin(db, 'asst', 'newpw', NOW + 1).ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/auth.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/auth.js`:

```js
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SESSION_TTL_SECONDS = 30 * 86400;
const LOCKOUT_AFTER = 5;
const LOCKOUT_SECONDS = 15 * 60;

function createUser(db, username, password, role) {
  if (!['owner', 'member'].includes(role)) throw new Error(`bad role: ${role}`);
  const hash = bcrypt.hashSync(password, 12);
  db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash, role = excluded.role,
      failed_attempts = 0, locked_until = NULL`).run(username, hash, role);
}

function verifyLogin(db, username, password, now) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u) return { ok: false, reason: 'bad-credentials' };
  if (u.locked_until && u.locked_until > now) return { ok: false, reason: 'locked' };
  if (!bcrypt.compareSync(password, u.password_hash)) {
    const attempts = u.failed_attempts + 1;
    if (attempts >= LOCKOUT_AFTER) {
      db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?')
        .run(now + LOCKOUT_SECONDS, u.id);
    } else {
      db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, u.id);
    }
    return { ok: false, reason: 'bad-credentials' };
  }
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(u.id);
  return { ok: true, user: u };
}

function createSession(db, userId, now) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, now + SESSION_TTL_SECONDS);
  return token;
}

function getSessionUser(db, token, now) {
  if (!token) return null;
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, now) || null;
}

function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = { createUser, verifyLogin, createSession, getSessionUser, deleteSession,
  SESSION_TTL_SECONDS, LOCKOUT_AFTER, LOCKOUT_SECONDS };
```

`bin/create-user.js`:

```js
#!/usr/bin/env node
// Usage: node bin/create-user.js <username> <owner|member>   (password read from hidden stdin prompt)
const readline = require('readline');
const { openDb } = require('../src/db');
const { createUser } = require('../src/auth');
const { loadConfig } = require('../src/config');

const [username, role] = process.argv.slice(2);
if (!username || !['owner', 'member'].includes(role)) {
  console.error('Usage: node bin/create-user.js <username> <owner|member>');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// hide typed password
rl._writeToOutput = (s) => { if (s.includes('\n')) rl.output.write('\n'); };
process.stdout.write(`Password for ${username}: `);
rl.question('', (password) => {
  rl.close();
  if (password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
  const db = openDb(loadConfig().dbPath);
  createUser(db, username, password, role);
  console.log(`User '${username}' (${role}) created/updated.`);
});
```

Note: `loadConfig` does not exist until Task 14. Until then the CLI cannot run — that is fine; it is not exercised by tests. (Task 14 creates `src/config.js` with `dbPath` defaulting to `data/bank.sqlite3`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth.js bin/create-user.js test/auth.test.js
git commit -m "feat: auth with bcrypt users, sqlite sessions, and lockout"
```

---

### Task 8: Visibility + feed query builder

**Files:**
- Create: `src/feed.js`, `test/feed.test.js`

**Interfaces:**
- Consumes: schema (Task 1), `toCents`/`toEpochDay` (Task 2).
- Produces (consumed by dashboard, review, export routes):
  - `visibleAccounts(db, user)` → account rows ordered by kind then display name; **owner sees all, member only `visibility='company'`**.
  - `feedQuery(db, user, filters)` → `{ rows, accounts, categories, members }` where `filters` may contain `account, category, q, member, from, to, min, max, uncategorized` (all strings from querystring). Rows include `category_name`, `account_name` (display_name fallback), `account_kind`. Member's rows, dropdown accounts, and card-member list all exclude private accounts. Bad filter input (unparseable dates/amounts) is ignored, never a 500.
  - `totals(db, user)` → `{ cashCents, owedCents }`: cash = sum of balances of visible `kind='bank'` accounts; owed = -sum of visible `kind='credit'` balances.

- [ ] **Step 1: Write the failing test**

`test/feed.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { visibleAccounts, feedQuery, totals } = require('../src/feed');

const T0 = 1789000000;
const OWNER = { id: 1, role: 'owner' };
const MEMBER = { id: 2, role: 'member' };

function fixture() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO accounts (id, name, display_name, kind, visibility, balance_cents) VALUES
    ('CHK', 'Business Checking', 'Ops',  'bank',   'company', 4218010),
    ('AMX', 'Amex 91002',        NULL,   'credit', 'company', -1893344),
    ('PER', 'Personal Amex',     NULL,   'credit', 'private',  -50000)`).run();
  const ins = db.prepare(`INSERT INTO transactions
    (uid, sf_id, account_id, posted_at, amount_cents, description, card_member, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run('CHK|1', '1', 'CHK', T0,        -124000, 'UPS FREIGHT',     null,       T0);
  ins.run('CHK|2', '2', 'CHK', T0 - 86400, 680122, 'STRIPE PAYOUT',   null,       T0);
  ins.run('AMX|3', '3', 'AMX', T0,          -8000, 'DELTA AIR',       'JANE DOE', T0);
  ins.run('PER|4', '4', 'PER', T0,          -9999, 'PERSONAL DINNER', null,       T0);
  return db;
}

test('visibleAccounts: owner sees all, member sees only company', () => {
  const db = fixture();
  assert.deepEqual(visibleAccounts(db, OWNER).map(a => a.id).sort(), ['AMX', 'CHK', 'PER']);
  assert.deepEqual(visibleAccounts(db, MEMBER).map(a => a.id).sort(), ['AMX', 'CHK']);
});

test('feedQuery hides private rows and private-only card members from member', () => {
  const db = fixture();
  const owner = feedQuery(db, OWNER, {});
  const member = feedQuery(db, MEMBER, {});
  assert.equal(owner.rows.length, 4);
  assert.equal(member.rows.length, 3);
  assert.ok(!member.rows.some(r => r.uid === 'PER|4'));
  assert.ok(!member.accounts.some(a => a.id === 'PER'));
});

test('filters: search, account, amount range, date range, uncategorized', () => {
  const db = fixture();
  assert.deepEqual(feedQuery(db, OWNER, { q: 'ups' }).rows.map(r => r.uid), ['CHK|1']);
  assert.deepEqual(feedQuery(db, OWNER, { account: 'AMX' }).rows.map(r => r.uid), ['AMX|3']);
  assert.deepEqual(feedQuery(db, OWNER, { min: '1000' }).rows.map(r => r.uid), ['CHK|1', 'CHK|2']);
  assert.equal(feedQuery(db, OWNER, { from: '2099-01-01' }).rows.length, 0);
  assert.equal(feedQuery(db, OWNER, { uncategorized: '1' }).rows.length, 4);
  assert.equal(feedQuery(db, OWNER, { member: 'JANE DOE' }).rows.length, 1);
});

test('garbage filter values are ignored, not thrown', () => {
  const db = fixture();
  assert.equal(feedQuery(db, OWNER, { min: 'abc', from: 'not-a-date' }).rows.length, 4);
});

test('totals: bank cash vs credit owed, per visibility', () => {
  const db = fixture();
  assert.deepEqual(totals(db, OWNER), { cashCents: 4218010, owedCents: 1943344 });
  assert.deepEqual(totals(db, MEMBER), { cashCents: 4218010, owedCents: 1893344 });
});

test('member with zero visible accounts gets empty results, not SQL errors', () => {
  const db = openDb(':memory:');
  assert.equal(feedQuery(db, MEMBER, {}).rows.length, 0);
  assert.deepEqual(totals(db, MEMBER), { cashCents: 0, owedCents: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/feed.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/feed.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feed.js test/feed.test.js
git commit -m "feat: visibility-scoped feed queries and balance totals"
```

---

### Task 9: Express app skeleton — login, logout, layout, gating

**Files:**
- Create: `src/app.js`, `src/views/login.ejs`, `src/views/_header.ejs`, `src/views/_footer.ejs`, `public/style.css`, `test/app.test.js`, `test/helpers.js`

**Interfaces:**
- Consumes: Task 7 auth functions; Task 8 `visibleAccounts` (used later).
- Produces: `createApp(db, { cookieSecure = false } = {})` → Express app. Routes this task: `GET /login`, `POST /login`, `POST /logout`, `GET /health` (no auth), and an auth middleware that redirects everything else to `/login`, attaching `req.user`. Cookie: `session`, HttpOnly, SameSite=Lax, `secure` per option (SameSite=Lax is the CSRF stance for this two-user app — all mutations are POSTs). Later tasks add routes to this same file.
- Test helper produced for later tasks — `test/helpers.js`: `makeApp()` → `{ app, db }` with seeded users (`michael`/`ownerpass1` owner, `asst`/`memberpass1` member), accounts `CHK` (bank, company), `AMX` (credit, company), `PER` (credit, private) and four transactions exactly matching Task 8's fixture; `login(app, username, password)` → session cookie string for supertest.

- [ ] **Step 1: Write the failing test**

`test/helpers.js`:

```js
const request = require('supertest');
const { openDb } = require('../src/db');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/app');

const T0 = 1789000000;

function makeApp() {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'ownerpass1', 'owner');
  createUser(db, 'asst', 'memberpass1', 'member');
  db.prepare(`INSERT INTO accounts (id, name, display_name, kind, visibility, balance_cents, last_synced_at) VALUES
    ('CHK', 'Business Checking', 'Ops',  'bank',   'company', 4218010, ${T0}),
    ('AMX', 'Amex 91002',        NULL,   'credit', 'company', -1893344, ${T0}),
    ('PER', 'Personal Amex',     NULL,   'credit', 'private',  -50000, ${T0})`).run();
  const ins = db.prepare(`INSERT INTO transactions
    (uid, sf_id, account_id, posted_at, amount_cents, description, card_member, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run('CHK|1', '1', 'CHK', T0,        -124000, 'UPS FREIGHT',     null,       T0);
  ins.run('CHK|2', '2', 'CHK', T0 - 86400, 680122, 'STRIPE PAYOUT',   null,       T0);
  ins.run('AMX|3', '3', 'AMX', T0,          -8000, 'DELTA AIR',       'JANE DOE', T0);
  ins.run('PER|4', '4', 'PER', T0,          -9999, 'PERSONAL DINNER', null,       T0);
  return { app: createApp(db), db };
}

async function login(app, username, password) {
  const res = await request(app).post('/login').type('form').send({ username, password });
  const cookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('session='));
  if (!cookie) throw new Error(`login failed for ${username}: ${res.status}`);
  return cookie.split(';')[0];
}

module.exports = { makeApp, login, T0 };
```

`test/app.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login } = require('./helpers');

test('unauthenticated requests redirect to /login; /health is open', async () => {
  const { app } = makeApp();
  assert.equal((await request(app).get('/health')).status, 200);
  const res = await request(app).get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('login sets HttpOnly SameSite=Lax cookie; bad login re-renders with error', async () => {
  const { app } = makeApp();
  const ok = await request(app).post('/login').type('form').send({ username: 'michael', password: 'ownerpass1' });
  assert.equal(ok.status, 302);
  const cookie = ok.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  const bad = await request(app).post('/login').type('form').send({ username: 'michael', password: 'nope' });
  assert.equal(bad.status, 401);
  assert.match(bad.text, /Invalid username or password/);
});

test('logout clears the session', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  await request(app).post('/logout').set('Cookie', cookie);
  const res = await request(app).get('/').set('Cookie', cookie);
  assert.equal(res.status, 302);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/app.test.js` — Expected: FAIL, `../src/app` not found.

- [ ] **Step 3: Implement**

`src/app.js`:

```js
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { verifyLogin, createSession, getSessionUser, deleteSession, SESSION_TTL_SECONDS } = require('./auth');

const nowSec = () => Math.floor(Date.now() / 1000);

function createApp(db, { cookieSecure = false } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));
  app.locals.fmtUSD = require('./money').fmtUSD;
  app.locals.fmtDate = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 10);

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.get('/login', (req, res) => res.render('login', { error: null }));

  app.post('/login', (req, res) => {
    const r = verifyLogin(db, String(req.body.username || ''), String(req.body.password || ''), nowSec());
    if (!r.ok) {
      const msg = r.reason === 'locked'
        ? 'Account locked for 15 minutes after too many attempts.'
        : 'Invalid username or password.';
      return res.status(401).render('login', { error: msg });
    }
    const token = createSession(db, r.user.id, nowSec());
    res.cookie('session', token, {
      httpOnly: true, sameSite: 'lax', secure: cookieSecure, maxAge: SESSION_TTL_SECONDS * 1000,
    });
    res.redirect('/');
  });

  // Everything below requires auth
  app.use((req, res, next) => {
    const user = getSessionUser(db, req.cookies.session, nowSec());
    if (!user) return res.redirect('/login');
    req.user = user;
    res.locals.user = user;
    next();
  });

  app.post('/logout', (req, res) => {
    deleteSession(db, req.cookies.session);
    res.clearCookie('session');
    res.redirect('/login');
  });

  registerRoutes(app, db); // dashboard, txns, review, rules, accounts, export (Tasks 10-13)
  return app;
}

function registerRoutes(app, db) {
  // Later tasks append route registrations here.
}

module.exports = { createApp };
```

`src/views/login.ejs`:

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Bank Dashboard</title><link rel="stylesheet" href="/static/style.css"></head>
<body class="login-page">
  <form method="post" action="/login" class="login-box">
    <h1>Bank Dashboard</h1>
    <% if (error) { %><p class="error"><%= error %></p><% } %>
    <label>Username <input name="username" autocomplete="username" required autofocus></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">Sign in</button>
  </form>
</body></html>
```

`src/views/_header.ejs`:

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title><%= title %> — Bank Dashboard</title><link rel="stylesheet" href="/static/style.css"></head>
<body>
<nav class="nav">
  <a href="/" class="brand">Bank Dashboard</a>
  <a href="/review">Review<% if (typeof reviewCount !== 'undefined' && reviewCount > 0) { %> (<%= reviewCount %>)<% } %></a>
  <a href="/rules">Rules</a>
  <% if (user.role === 'owner') { %><a href="/accounts">Accounts</a><% } %>
  <form method="post" action="/logout" class="inline"><button class="linklike"><%= user.username %> · sign out</button></form>
</nav>
<main>
```

`src/views/_footer.ejs`:

```html
</main></body></html>
```

`public/style.css` (complete file — spartan, readable, responsive):

```css
:root { --bg:#f7f7f5; --card:#fff; --line:#e2e2dd; --text:#1a1a18; --dim:#6b6b66;
        --green:#0a7a3d; --red:#b3261e; --accent:#1d4ed8; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text);
       font:15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width:1100px; margin:0 auto; padding:16px; }
.nav { display:flex; gap:18px; align-items:center; padding:10px 16px; background:var(--card);
       border-bottom:1px solid var(--line); flex-wrap:wrap; }
.nav .brand { font-weight:700; margin-right:auto; }
.nav a { color:var(--text); text-decoration:none; }
.inline { display:inline; } .linklike { background:none; border:none; color:var(--dim); cursor:pointer; font:inherit; }
h1 { font-size:20px; } h2 { font-size:16px; color:var(--dim); text-transform:uppercase; letter-spacing:.04em; }
.cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:10px; margin:12px 0; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
.card .amt { font-size:18px; font-weight:700; } .card .meta { color:var(--dim); font-size:12px; }
.card.credit .amt { color:var(--red); }
.banner { background:#fff7e0; border:1px solid #e5cf7a; border-radius:8px; padding:10px 12px; margin:12px 0; }
.totals { display:flex; gap:24px; margin:8px 0; font-size:15px; }
table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:8px; }
th, td { padding:8px 10px; text-align:left; border-top:1px solid var(--line); font-size:14px; vertical-align:top; }
th { color:var(--dim); font-weight:600; border-top:none; }
td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
.pos { color:var(--green); } .neg { color:var(--red); }
.pending { opacity:.6; font-style:italic; }
.filters { display:flex; gap:8px; flex-wrap:wrap; margin:12px 0; align-items:end; }
.filters label { display:flex; flex-direction:column; font-size:12px; color:var(--dim); gap:2px; }
input, select, button { font:inherit; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:#fff; }
button { cursor:pointer; } button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.error { color:var(--red); }
.login-page { display:flex; min-height:100vh; align-items:center; justify-content:center; }
.login-box { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:28px;
             display:flex; flex-direction:column; gap:12px; width:320px; }
.login-box label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--dim); }
.note { color:var(--dim); font-size:13px; }
details.rowdetail { margin:0; } details.rowdetail summary { cursor:pointer; list-style:none; }
.detail-forms { display:flex; gap:12px; flex-wrap:wrap; padding:8px 0; }
.tablewrap { overflow-x:auto; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.js src/views/ public/ test/app.test.js test/helpers.js
git commit -m "feat: express app with login/logout, session gating, base layout"
```

---

### Task 10: Dashboard page

**Files:**
- Create: `src/views/dashboard.ejs`, `test/dashboard.test.js`
- Modify: `src/app.js` (`registerRoutes`)

**Interfaces:**
- Consumes: `feedQuery`, `totals`, `visibleAccounts` (Task 8); helper fixtures (Task 9).
- Produces: `GET /` renders: staleness/connection banner, bank balance cards + total cash, credit-card cards + total owed, filter form (account, category, card member when present, search, from/to, min/max, uncategorized), transaction table (date, description, account, card member, category, amount; pending struck-dim; red/green amounts), "Review (n)" count in nav. Review count query used here: `SELECT COUNT(*) FROM transactions WHERE category_id IS NULL AND account_id IN (<visible>)`.

- [ ] **Step 1: Write the failing test**

`test/dashboard.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login, T0 } = require('./helpers');

test('owner dashboard shows all accounts, totals, and private rows', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Ops/);                 // display_name preferred
  assert.match(res.text, /Personal Amex/);       // owner sees private
  assert.match(res.text, /PERSONAL DINNER/);
  assert.match(res.text, /\$42,180\.10/);        // total cash
  assert.match(res.text, /\$19,433\.44/);        // total owed (both cards)
});

test('member dashboard: private account absent everywhere', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'asst', 'memberpass1');
  const res = await request(app).get('/').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.ok(!/Personal Amex/.test(res.text));
  assert.ok(!/PERSONAL DINNER/.test(res.text));
  assert.match(res.text, /\$18,933\.44/);        // owed excludes private card
});

test('filters flow through querystring', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/?q=ups').set('Cookie', cookie);
  assert.match(res.text, /UPS FREIGHT/);
  assert.ok(!/STRIPE PAYOUT/.test(res.text));
});

test('stale accounts produce a warning banner', async () => {
  const { app, db } = makeApp();
  db.prepare('UPDATE accounts SET last_synced_at = ? WHERE id = ?').run(T0 - 3 * 86400, 'CHK');
  db.prepare("INSERT INTO settings (key, value) VALUES ('sync_errors', ?)")
    .run(JSON.stringify(['Connection to Truist may need attention']));
  const realNow = Date.now;
  Date.now = () => T0 * 1000; // freeze time so staleness is deterministic
  try {
    const cookie = await login(app, 'michael', 'ownerpass1');
    const res = await request(app).get('/').set('Cookie', cookie);
    assert.match(res.text, /has not synced in over 24 hours/);
    assert.match(res.text, /Connection to Truist may need attention/);
  } finally { Date.now = realNow; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dashboard.test.js` — Expected: FAIL (GET / returns 404 → renders nothing).

- [ ] **Step 3: Implement**

In `src/app.js`, fill in `registerRoutes` (this function grows in Tasks 11-13):

```js
const { feedQuery, totals, visibleAccounts } = require('./feed');

function reviewCount(db, user) {
  const ids = visibleAccounts(db, user).map(a => a.id);
  if (ids.length === 0) return 0;
  return db.prepare(`SELECT COUNT(*) AS n FROM transactions
    WHERE category_id IS NULL AND account_id IN (${ids.map(() => '?').join(',')})`).get(...ids).n;
}

function staleness(db, user) {
  const nowS = Math.floor(Date.now() / 1000);
  const stale = visibleAccounts(db, user)
    .filter(a => !a.last_synced_at || a.last_synced_at < nowS - 86400);
  let errors = [];
  const row = db.prepare("SELECT value FROM settings WHERE key='sync_errors'").get();
  if (row) { try { errors = JSON.parse(row.value); } catch { errors = []; } }
  return { stale, errors };
}

function registerRoutes(app, db) {
  app.get('/', (req, res) => {
    const { rows, accounts, categories, members } = feedQuery(db, req.user, req.query);
    res.render('dashboard', {
      title: 'Overview',
      rows, accounts, categories, members,
      banks: accounts.filter(a => a.kind === 'bank'),
      credits: accounts.filter(a => a.kind === 'credit'),
      totals: totals(db, req.user),
      filters: req.query,
      reviewCount: reviewCount(db, req.user),
      staleness: staleness(db, req.user),
    });
  });
}
```

`src/views/dashboard.ejs`:

```html
<%- include('_header', { title, reviewCount }) %>

<% if (staleness.stale.length > 0) { %>
  <div class="banner">
    <strong><%= staleness.stale.length %> account<%= staleness.stale.length > 1 ? 's have' : ' has' %> not synced in over 24 hours.</strong>
    <% staleness.errors.forEach(e => { %><div><%= e %></div><% }) %>
    <div class="note">If a connection needs attention, re-link it at bridge.simplefin.org, then wait for the next sync.</div>
  </div>
<% } %>

<div class="totals">
  <span>Total cash: <strong><%= fmtUSD(totals.cashCents) %></strong></span>
  <% if (credits.length > 0) { %><span>Cards owed: <strong class="neg"><%= fmtUSD(totals.owedCents) %></strong></span><% } %>
</div>

<div class="cards">
  <% banks.forEach(a => { %>
    <div class="card">
      <div><%= a.display_name || a.name %><% if (user.role === 'owner' && a.visibility === 'private') { %> 🔒<% } %></div>
      <div class="amt"><%= fmtUSD(a.balance_cents) %></div>
      <div class="meta">synced <%= a.last_synced_at ? fmtDate(a.last_synced_at) : 'never' %></div>
    </div>
  <% }) %>
</div>
<% if (credits.length > 0) { %>
  <h2>Credit cards</h2>
  <div class="cards">
    <% credits.forEach(a => { %>
      <div class="card credit">
        <div><%= a.display_name || a.name %><% if (user.role === 'owner' && a.visibility === 'private') { %> 🔒<% } %></div>
        <div class="amt"><%= fmtUSD(-a.balance_cents) %> owed</div>
        <div class="meta">synced <%= a.last_synced_at ? fmtDate(a.last_synced_at) : 'never' %></div>
      </div>
    <% }) %>
  </div>
<% } %>

<form method="get" action="/" class="filters">
  <label>Account
    <select name="account"><option value="">All</option>
      <% accounts.forEach(a => { %><option value="<%= a.id %>" <%= filters.account === a.id ? 'selected' : '' %>><%= a.display_name || a.name %></option><% }) %>
    </select></label>
  <label>Category
    <select name="category"><option value="">All</option>
      <% categories.forEach(c => { %><option value="<%= c.id %>" <%= String(filters.category) === String(c.id) ? 'selected' : '' %>><%= c.name %></option><% }) %>
    </select></label>
  <% if (members.length > 0) { %>
    <label>Card member
      <select name="member"><option value="">All</option>
        <% members.forEach(m => { %><option <%= filters.member === m ? 'selected' : '' %>><%= m %></option><% }) %>
      </select></label>
  <% } %>
  <label>Search <input name="q" value="<%= filters.q || '' %>" placeholder="description"></label>
  <label>From <input type="date" name="from" value="<%= filters.from || '' %>"></label>
  <label>To <input type="date" name="to" value="<%= filters.to || '' %>"></label>
  <label>Min $ <input name="min" size="6" value="<%= filters.min || '' %>"></label>
  <label>Max $ <input name="max" size="6" value="<%= filters.max || '' %>"></label>
  <label><input type="checkbox" name="uncategorized" value="1" <%= filters.uncategorized ? 'checked' : '' %>> Uncategorized</label>
  <button class="primary">Filter</button>
  <a href="/export.csv?<%= new URLSearchParams(filters).toString() %>"><button type="button">Export CSV</button></a>
</form>

<div class="tablewrap">
<table>
  <tr><th>Date</th><th>Description</th><th>Account</th><th>Member</th><th>Category</th><th class="num">Amount</th></tr>
  <% rows.forEach(t => { %>
    <tr class="<%= t.pending ? 'pending' : '' %>">
      <td><%= fmtDate(t.posted_at) %></td>
      <td><%- include('_txn_detail', { t }) %></td>
      <td><%= t.account_name %></td>
      <td><%= t.card_member || '' %></td>
      <td><%= t.category_name || '—' %></td>
      <td class="num <%= t.amount_cents < 0 ? 'neg' : 'pos' %>"><%= fmtUSD(t.amount_cents) %></td>
    </tr>
  <% }) %>
</table>
</div>
<%- include('_footer') %>
```

Also create a **stub** `src/views/_txn_detail.ejs` so the page renders before Task 11 fills it in:

```html
<%= t.description %>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.js src/views/ test/dashboard.test.js
git commit -m "feat: overview dashboard with balances, filters, feed, staleness banner"
```

---

### Task 11: Transaction actions + review queue

**Files:**
- Create: `src/views/review.ejs`, `test/actions.test.js`
- Modify: `src/app.js` (`registerRoutes`), `src/views/_txn_detail.ejs` (replace stub)

**Interfaces:**
- Consumes: `createRule` (Task 6); helpers (Task 9).
- Produces routes (all return 302 back to `referer` or `/`; 404 if the txn's account is not visible to `req.user` — **member must get 404, not 403, for private-account txns**):
  - `POST /txns/:uid/category` body `{ category_id }` (empty string clears back to uncategorized) → sets `category_source='manual'`, `categorized_by=req.user.id`, `rule_id=NULL` (or all NULL when clearing).
  - `POST /txns/:uid/note` body `{ note }` → sets `note` (empty clears), `note_by=req.user.id`.
  - `POST /txns/:uid/make-rule` body `{ pattern, category_id }` → `createRule` with `ownerOnly = (account.visibility === 'private')`, then manually categorize this txn with the same category (manual wins over rule attribution for the source txn).
  - `GET /review` → uncategorized visible txns oldest-first, each with a category select + "Save", and a prefilled make-rule mini-form.

- [ ] **Step 1: Write the failing test**

`test/actions.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login } = require('./helpers');

function cat(db, name) { return db.prepare('SELECT id FROM categories WHERE name=?').get(name).id; }

test('manual categorization sets source/user and survives; clearing works', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const shipping = cat(db, 'Shipping');
  let res = await request(app).post('/txns/CHK|1/category').set('Cookie', cookie)
    .type('form').send({ category_id: String(shipping) });
  assert.equal(res.status, 302);
  let t = db.prepare("SELECT * FROM transactions WHERE uid='CHK|1'").get();
  assert.equal(t.category_id, shipping);
  assert.equal(t.category_source, 'manual');
  assert.equal(t.categorized_by, db.prepare("SELECT id FROM users WHERE username='michael'").get().id);
  await request(app).post('/txns/CHK|1/category').set('Cookie', cookie).type('form').send({ category_id: '' });
  t = db.prepare("SELECT * FROM transactions WHERE uid='CHK|1'").get();
  assert.equal(t.category_id, null);
  assert.equal(t.category_source, null);
});

test('notes save with attribution', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'asst', 'memberpass1');
  await request(app).post('/txns/AMX|3/note').set('Cookie', cookie).type('form').send({ note: 'Jane conference flight' });
  const t = db.prepare("SELECT * FROM transactions WHERE uid='AMX|3'").get();
  assert.equal(t.note, 'Jane conference flight');
  assert.equal(t.note_by, db.prepare("SELECT id FROM users WHERE username='asst'").get().id);
});

test('member cannot act on private-account transactions (404)', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'asst', 'memberpass1');
  const res = await request(app).post('/txns/PER|4/note').set('Cookie', cookie).type('form').send({ note: 'x' });
  assert.equal(res.status, 404);
  assert.equal(db.prepare("SELECT note FROM transactions WHERE uid='PER|4'").get().note, null);
});

test('make-rule from a private txn creates an owner_only rule; from company txn a shared one', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const other = cat(db, 'Other');
  await request(app).post('/txns/PER|4/make-rule').set('Cookie', cookie)
    .type('form').send({ pattern: 'PERSONAL DINNER', category_id: String(other) });
  const r1 = db.prepare("SELECT * FROM rules WHERE pattern='PERSONAL DINNER'").get();
  assert.equal(r1.owner_only, 1);
  const shipping = cat(db, 'Shipping');
  await request(app).post('/txns/CHK|1/make-rule').set('Cookie', cookie)
    .type('form').send({ pattern: 'UPS', category_id: String(shipping) });
  const r2 = db.prepare("SELECT * FROM rules WHERE pattern='UPS'").get();
  assert.equal(r2.owner_only, 0);
  assert.equal(db.prepare("SELECT category_source FROM transactions WHERE uid='CHK|1'").get().category_source, 'manual');
});

test('review queue lists only visible uncategorized, oldest first', async () => {
  const { app, db } = makeApp();
  const owner = await login(app, 'michael', 'ownerpass1');
  const asst = await login(app, 'asst', 'memberpass1');
  const or = await request(app).get('/review').set('Cookie', owner);
  assert.match(or.text, /PERSONAL DINNER/);
  assert.ok(or.text.indexOf('STRIPE PAYOUT') < or.text.indexOf('UPS FREIGHT')); // older first
  const ar = await request(app).get('/review').set('Cookie', asst);
  assert.ok(!/PERSONAL DINNER/.test(ar.text));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/actions.test.js` — Expected: FAIL (404s from missing routes / missing review view).

- [ ] **Step 3: Implement**

Add inside `registerRoutes` in `src/app.js` (after the `/` route). Also add `const { createRule } = require('./rules');` at the top of the file.

```js
  function visibleTxn(db, user, uid) {
    const t = db.prepare(`SELECT t.*, a.visibility FROM transactions t
      JOIN accounts a ON a.id = t.account_id WHERE t.uid = ?`).get(uid);
    if (!t) return null;
    if (user.role !== 'owner' && t.visibility !== 'company') return null;
    return t;
  }
  const back = (req, res) => res.redirect(req.get('referer') || '/');

  app.post('/txns/:uid/category', (req, res) => {
    const t = visibleTxn(db, req.user, req.params.uid);
    if (!t) return res.status(404).send('Not found');
    const cid = req.body.category_id ? Number(req.body.category_id) : null;
    if (cid === null) {
      db.prepare(`UPDATE transactions SET category_id=NULL, category_source=NULL,
                  categorized_by=NULL, rule_id=NULL WHERE uid=?`).run(t.uid);
    } else {
      db.prepare(`UPDATE transactions SET category_id=?, category_source='manual',
                  categorized_by=?, rule_id=NULL WHERE uid=?`).run(cid, req.user.id, t.uid);
    }
    back(req, res);
  });

  app.post('/txns/:uid/note', (req, res) => {
    const t = visibleTxn(db, req.user, req.params.uid);
    if (!t) return res.status(404).send('Not found');
    const note = String(req.body.note || '').trim();
    db.prepare('UPDATE transactions SET note=?, note_by=? WHERE uid=?')
      .run(note || null, note ? req.user.id : null, t.uid);
    back(req, res);
  });

  app.post('/txns/:uid/make-rule', (req, res) => {
    const t = visibleTxn(db, req.user, req.params.uid);
    if (!t) return res.status(404).send('Not found');
    const categoryId = Number(req.body.category_id);
    const pattern = String(req.body.pattern || '').trim();
    if (!pattern || !categoryId) return res.status(400).send('Pattern and category required');
    createRule(db, { pattern, categoryId, ownerOnly: t.visibility === 'private', createdBy: req.user.id });
    db.prepare(`UPDATE transactions SET category_id=?, category_source='manual',
                categorized_by=?, rule_id=NULL WHERE uid=?`).run(categoryId, req.user.id, t.uid);
    back(req, res);
  });

  app.get('/review', (req, res) => {
    const ids = visibleAccounts(db, req.user).map(a => a.id);
    const rows = ids.length === 0 ? [] : db.prepare(`
      SELECT t.*, COALESCE(a.display_name, a.name) AS account_name
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.category_id IS NULL AND t.account_id IN (${ids.map(() => '?').join(',')})
      ORDER BY t.posted_at ASC LIMIT 200`).all(...ids);
    const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
    res.render('review', { title: 'Review', rows, categories, reviewCount: rows.length });
  });
```

Replace `src/views/_txn_detail.ejs` (used by the dashboard feed; expand-in-place forms):

```html
<details class="rowdetail">
  <summary><%= t.description %><% if (t.note) { %> <span class="note">📝 <%= t.note %></span><% } %></summary>
  <div class="detail-forms">
    <form method="post" action="/txns/<%= encodeURIComponent(t.uid) %>/category">
      <select name="category_id"><option value="">— uncategorized —</option>
        <% categories.forEach(c => { %><option value="<%= c.id %>" <%= t.category_id === c.id ? 'selected' : '' %>><%= c.name %></option><% }) %>
      </select><button>Set category</button>
    </form>
    <form method="post" action="/txns/<%= encodeURIComponent(t.uid) %>/note">
      <input name="note" value="<%= t.note || '' %>" placeholder="note"><button>Save note</button>
    </form>
    <form method="post" action="/txns/<%= encodeURIComponent(t.uid) %>/make-rule">
      <input name="pattern" value="<%= t.description %>">
      <select name="category_id"><% categories.forEach(c => { %><option value="<%= c.id %>"><%= c.name %></option><% }) %></select>
      <button>+ Rule</button>
    </form>
  </div>
</details>
```

`src/views/review.ejs`:

```html
<%- include('_header', { title, reviewCount }) %>
<h1>Needs review (<%= rows.length %>)</h1>
<% if (rows.length === 0) { %><p class="note">Nothing to review. 🎉</p><% } %>
<div class="tablewrap">
<table>
  <tr><th>Date</th><th>Description</th><th>Account</th><th class="num">Amount</th><th>Categorize</th><th>Make rule</th></tr>
  <% rows.forEach(t => { %>
    <tr>
      <td><%= fmtDate(t.posted_at) %></td>
      <td><%= t.description %></td>
      <td><%= t.account_name %></td>
      <td class="num <%= t.amount_cents < 0 ? 'neg' : 'pos' %>"><%= fmtUSD(t.amount_cents) %></td>
      <td>
        <form method="post" action="/txns/<%= encodeURIComponent(t.uid) %>/category">
          <select name="category_id"><% categories.forEach(c => { %><option value="<%= c.id %>"><%= c.name %></option><% }) %></select>
          <button>Save</button>
        </form>
      </td>
      <td>
        <form method="post" action="/txns/<%= encodeURIComponent(t.uid) %>/make-rule">
          <input name="pattern" value="<%= t.description %>" size="18">
          <select name="category_id"><% categories.forEach(c => { %><option value="<%= c.id %>"><%= c.name %></option><% }) %></select>
          <button>+ Rule</button>
        </form>
      </td>
    </tr>
  <% }) %>
</table>
</div>
<%- include('_footer') %>
```

The dashboard's `_txn_detail` include needs `categories` in scope — pass it through in `dashboard.ejs`'s include: change `<%- include('_txn_detail', { t }) %>` to `<%- include('_txn_detail', { t, categories }) %>`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.js src/views/ test/actions.test.js
git commit -m "feat: transaction actions (category, note, make-rule) and review queue"
```

---

### Task 12: Rules, categories, and accounts admin pages

**Files:**
- Create: `src/views/rules.ejs`, `src/views/accounts.ejs`, `test/admin.test.js`
- Modify: `src/app.js` (`registerRoutes`)

**Interfaces:**
- Consumes: `createRule`, `applyRulesToUncategorized` (Task 6); helpers (Task 9).
- Produces routes:
  - `GET /rules` — rules list (member sees only `owner_only=0` rules; owner sees all with a 🔒 on owner-only ones) with per-rule match counts. **Match count is visibility-scoped:** `SELECT COUNT(*) FROM transactions WHERE rule_id=? AND account_id IN (<visible>)`. Below rules: categories list + add-category form.
  - `POST /rules` body `{ pattern, account_id?, amount?, category_id, owner_only? }` — create (amount parsed via `toCents`, blank → null; `owner_only` checkbox only honored for owners; a member POSTing `owner_only` gets it ignored).
  - `POST /rules/:id/delete` — delete (member cannot delete owner-only rules: 404). Categorized transactions keep their category (`rule_id` goes NULL via FK).
  - `POST /rules/:id/move` body `{ dir: 'up'|'down' }` — swap `position` with neighbor **within the requester's visible rule list**, then re-run `applyRulesToUncategorized` (order affects only uncategorized rows).
  - `POST /categories` body `{ name }` — add. `POST /categories/:id/rename` body `{ name }` — rename. (No delete — YAGNI; renaming covers the need.)
  - `GET /accounts` (owner only; member gets 404) — table of all accounts: display-name input, visibility select, kind select. `POST /accounts/:id` body `{ display_name, visibility, kind }` (owner only) — update those three fields.

- [ ] **Step 1: Write the failing test**

`test/admin.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login } = require('./helpers');

function cat(db, name) { return db.prepare('SELECT id FROM categories WHERE name=?').get(name).id; }

test('rules page hides owner_only rules from member; match counts are visibility-scoped', async () => {
  const { app, db } = makeApp();
  const fees = cat(db, 'Fees');
  db.prepare("INSERT INTO rules (position, pattern, category_id, owner_only) VALUES (1, 'DINNER', ?, 1)").run(fees);
  db.prepare("INSERT INTO rules (position, pattern, category_id, owner_only) VALUES (2, 'DELTA', ?, 0)").run(fees);
  db.prepare("UPDATE transactions SET category_id=?, category_source='rule', rule_id=2 WHERE uid='AMX|3'").run(fees);
  const owner = await request(app).get('/rules').set('Cookie', await login(app, 'michael', 'ownerpass1'));
  assert.match(owner.text, /DINNER/);
  assert.match(owner.text, /DELTA/);
  const member = await request(app).get('/rules').set('Cookie', await login(app, 'asst', 'memberpass1'));
  assert.ok(!/DINNER/.test(member.text));
  assert.match(member.text, /DELTA/);
});

test('create, move, delete rules via routes', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  const shipping = cat(db, 'Shipping'), fees = cat(db, 'Fees');
  await request(app).post('/rules').set('Cookie', cookie).type('form')
    .send({ pattern: 'UPS', category_id: String(shipping) });
  await request(app).post('/rules').set('Cookie', cookie).type('form')
    .send({ pattern: 'FEE', category_id: String(fees), amount: '-25.00' });
  const r2 = db.prepare("SELECT * FROM rules WHERE pattern='FEE'").get();
  assert.equal(r2.amount_cents, -2500);
  assert.equal(r2.position, 2);
  // retroactive: UPS FREIGHT got categorized on create
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='CHK|1'").get().category_id, shipping);
  await request(app).post(`/rules/${r2.id}/move`).set('Cookie', cookie).type('form').send({ dir: 'up' });
  assert.equal(db.prepare('SELECT position FROM rules WHERE id=?').get(r2.id).position, 1);
  await request(app).post(`/rules/${r2.id}/delete`).set('Cookie', cookie);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rules').get().n, 1);
});

test('member cannot delete an owner-only rule or set owner_only', async () => {
  const { app, db } = makeApp();
  const fees = cat(db, 'Fees');
  db.prepare("INSERT INTO rules (id, position, pattern, category_id, owner_only) VALUES (9, 1, 'SECRET', ?, 1)").run(fees);
  const cookie = await login(app, 'asst', 'memberpass1');
  assert.equal((await request(app).post('/rules/9/delete').set('Cookie', cookie)).status, 404);
  await request(app).post('/rules').set('Cookie', cookie).type('form')
    .send({ pattern: 'DELTA', category_id: String(fees), owner_only: '1' });
  assert.equal(db.prepare("SELECT owner_only FROM rules WHERE pattern='DELTA'").get().owner_only, 0);
});

test('categories add and rename', async () => {
  const { app, db } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  await request(app).post('/categories').set('Cookie', cookie).type('form').send({ name: 'Travel' });
  const id = cat(db, 'Travel');
  await request(app).post(`/categories/${id}/rename`).set('Cookie', cookie).type('form').send({ name: 'Travel & Meals' });
  assert.ok(cat(db, 'Travel & Meals'));
});

test('accounts admin is owner-only and updates the three owner fields', async () => {
  const { app, db } = makeApp();
  const member = await login(app, 'asst', 'memberpass1');
  assert.equal((await request(app).get('/accounts').set('Cookie', member)).status, 404);
  const owner = await login(app, 'michael', 'ownerpass1');
  const page = await request(app).get('/accounts').set('Cookie', owner);
  assert.match(page.text, /Personal Amex/);
  await request(app).post('/accounts/PER').set('Cookie', owner).type('form')
    .send({ display_name: 'My Card', visibility: 'private', kind: 'credit' });
  const a = db.prepare("SELECT * FROM accounts WHERE id='PER'").get();
  assert.equal(a.display_name, 'My Card');
  // flipping visibility works too
  await request(app).post('/accounts/PER').set('Cookie', owner).type('form')
    .send({ display_name: 'My Card', visibility: 'company', kind: 'credit' });
  assert.equal(db.prepare("SELECT visibility FROM accounts WHERE id='PER'").get().visibility, 'company');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/admin.test.js` — Expected: FAIL (missing routes/views).

- [ ] **Step 3: Implement**

Add inside `registerRoutes` in `src/app.js`. Also add `const { applyRulesToUncategorized } = require('./rules');` and `const { toCents } = require('./money');` at the top.

```js
  function rulesFor(db, user) {
    const sql = user.role === 'owner'
      ? 'SELECT * FROM rules ORDER BY position ASC, id ASC'
      : 'SELECT * FROM rules WHERE owner_only = 0 ORDER BY position ASC, id ASC';
    return db.prepare(sql).all();
  }

  app.get('/rules', (req, res) => {
    const ids = visibleAccounts(db, req.user).map(a => a.id);
    const countStmt = ids.length === 0 ? null : db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE rule_id = ? AND account_id IN (${ids.map(() => '?').join(',')})`);
    const rules = rulesFor(db, req.user).map(r => ({
      ...r, matches: countStmt ? countStmt.get(r.id, ...ids).n : 0,
      category_name: db.prepare('SELECT name FROM categories WHERE id=?').get(r.category_id).name,
      account_name: r.account_id
        ? (db.prepare('SELECT COALESCE(display_name, name) AS n FROM accounts WHERE id=?').get(r.account_id) || {}).n
        : null,
    }));
    const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
    res.render('rules', { title: 'Rules', rules, categories,
      accounts: visibleAccounts(db, req.user), reviewCount: reviewCount(db, req.user) });
  });

  app.post('/rules', (req, res) => {
    const pattern = String(req.body.pattern || '').trim();
    const categoryId = Number(req.body.category_id);
    if (!pattern || !categoryId) return res.status(400).send('Pattern and category required');
    let amountCents = null;
    if (req.body.amount && String(req.body.amount).trim()) {
      try { amountCents = toCents(req.body.amount); } catch { return res.status(400).send('Bad amount'); }
    }
    const visIds = visibleAccounts(db, req.user).map(a => a.id);
    const accountId = req.body.account_id && visIds.includes(req.body.account_id) ? req.body.account_id : null;
    createRule(db, { pattern, accountId, amountCents, categoryId,
      ownerOnly: req.user.role === 'owner' && !!req.body.owner_only, createdBy: req.user.id });
    res.redirect('/rules');
  });

  function visibleRule(db, user, id) {
    const r = db.prepare('SELECT * FROM rules WHERE id = ?').get(Number(id));
    if (!r) return null;
    if (user.role !== 'owner' && r.owner_only) return null;
    return r;
  }

  app.post('/rules/:id/delete', (req, res) => {
    const r = visibleRule(db, req.user, req.params.id);
    if (!r) return res.status(404).send('Not found');
    db.prepare('DELETE FROM rules WHERE id = ?').run(r.id);
    res.redirect('/rules');
  });

  app.post('/rules/:id/move', (req, res) => {
    const r = visibleRule(db, req.user, req.params.id);
    if (!r) return res.status(404).send('Not found');
    const list = rulesFor(db, req.user);
    const i = list.findIndex(x => x.id === r.id);
    const j = req.body.dir === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < list.length) {
      const swap = db.prepare('UPDATE rules SET position = ? WHERE id = ?');
      db.transaction(() => {
        swap.run(list[j].position, list[i].id);
        swap.run(list[i].position, list[j].id);
      })();
      applyRulesToUncategorized(db);
    }
    res.redirect('/rules');
  });

  app.post('/categories', (req, res) => {
    const name = String(req.body.name || '').trim();
    if (name) db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(name);
    res.redirect('/rules');
  });

  app.post('/categories/:id/rename', (req, res) => {
    const name = String(req.body.name || '').trim();
    if (name) db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, Number(req.params.id));
    res.redirect('/rules');
  });

  const ownerOnly = (req, res, next) => req.user.role === 'owner' ? next() : res.status(404).send('Not found');

  app.get('/accounts', ownerOnly, (req, res) => {
    const accounts = db.prepare('SELECT * FROM accounts ORDER BY kind, COALESCE(display_name, name)').all();
    res.render('accounts', { title: 'Accounts', accounts, reviewCount: reviewCount(db, req.user) });
  });

  app.post('/accounts/:id', ownerOnly, (req, res) => {
    const vis = ['company', 'private'].includes(req.body.visibility) ? req.body.visibility : 'private';
    const kind = ['bank', 'credit'].includes(req.body.kind) ? req.body.kind : 'bank';
    const dn = String(req.body.display_name || '').trim() || null;
    db.prepare('UPDATE accounts SET display_name = ?, visibility = ?, kind = ? WHERE id = ?')
      .run(dn, vis, kind, req.params.id);
    res.redirect('/accounts');
  });
```

`src/views/rules.ejs`:

```html
<%- include('_header', { title, reviewCount }) %>
<h1>Rules</h1>
<p class="note">First matching rule wins, top to bottom. Rules only categorize transactions that have no category yet.</p>
<div class="tablewrap">
<table>
  <tr><th></th><th>Pattern</th><th>Account</th><th class="num">Amount</th><th>Category</th><th class="num">Matches</th><th></th></tr>
  <% rules.forEach(r => { %>
    <tr>
      <td>
        <form method="post" action="/rules/<%= r.id %>/move" class="inline"><input type="hidden" name="dir" value="up"><button>↑</button></form>
        <form method="post" action="/rules/<%= r.id %>/move" class="inline"><input type="hidden" name="dir" value="down"><button>↓</button></form>
      </td>
      <td>"<%= r.pattern %>"<% if (r.owner_only) { %> 🔒<% } %></td>
      <td><%= r.account_name || 'any' %></td>
      <td class="num"><%= r.amount_cents === null ? 'any' : fmtUSD(r.amount_cents) %></td>
      <td><%= r.category_name %></td>
      <td class="num"><%= r.matches %></td>
      <td><form method="post" action="/rules/<%= r.id %>/delete" class="inline"><button>Delete</button></form></td>
    </tr>
  <% }) %>
</table>
</div>

<h2>Add rule</h2>
<form method="post" action="/rules" class="filters">
  <label>Description contains <input name="pattern" required></label>
  <label>Account <select name="account_id"><option value="">any</option>
    <% accounts.forEach(a => { %><option value="<%= a.id %>"><%= a.display_name || a.name %></option><% }) %></select></label>
  <label>Exact amount <input name="amount" size="8" placeholder="optional"></label>
  <label>Category <select name="category_id"><% categories.forEach(c => { %><option value="<%= c.id %>"><%= c.name %></option><% }) %></select></label>
  <% if (user.role === 'owner') { %><label><input type="checkbox" name="owner_only" value="1"> Only I can see this rule</label><% } %>
  <button class="primary">Add</button>
</form>

<h2>Categories</h2>
<div class="tablewrap">
<table>
  <% categories.forEach(c => { %>
    <tr><td><%= c.name %></td>
      <td><form method="post" action="/categories/<%= c.id %>/rename" class="inline">
        <input name="name" value="<%= c.name %>" size="16"><button>Rename</button></form></td></tr>
  <% }) %>
</table>
</div>
<form method="post" action="/categories" class="filters">
  <label>New category <input name="name" required></label><button class="primary">Add</button>
</form>
<%- include('_footer') %>
```

`src/views/accounts.ejs`:

```html
<%- include('_header', { title, reviewCount }) %>
<h1>Accounts</h1>
<p class="note">Private accounts are invisible to the member login. New accounts start Private.</p>
<% accounts.forEach(a => { %>
  <form id="f-<%= a.id %>" method="post" action="/accounts/<%= encodeURIComponent(a.id) %>"></form>
<% }) %>
<div class="tablewrap">
<table>
  <tr><th>Bank name</th><th>Display name</th><th>Type</th><th>Visibility</th><th class="num">Balance</th><th></th></tr>
  <% accounts.forEach(a => { %>
    <tr>
      <td><%= a.name %> <span class="note"><%= a.org_name || '' %></span></td>
      <td><input form="f-<%= a.id %>" name="display_name" value="<%= a.display_name || '' %>" size="14"></td>
      <td><select form="f-<%= a.id %>" name="kind">
        <option value="bank" <%= a.kind === 'bank' ? 'selected' : '' %>>bank</option>
        <option value="credit" <%= a.kind === 'credit' ? 'selected' : '' %>>credit card</option></select></td>
      <td><select form="f-<%= a.id %>" name="visibility">
        <option value="company" <%= a.visibility === 'company' ? 'selected' : '' %>>Company</option>
        <option value="private" <%= a.visibility === 'private' ? 'selected' : '' %>>Private 🔒</option></select></td>
      <td class="num"><%= fmtUSD(a.balance_cents) %></td>
      <td><button form="f-<%= a.id %>" class="primary">Save</button></td>
    </tr>
  <% }) %>
</table>
</div>
<p class="note">Forms use the HTML5 <code>form</code> attribute because a form element cannot legally span table cells.</p>
<%- include('_footer') %>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.js src/views/ test/admin.test.js
git commit -m "feat: rules/categories management and owner-only accounts admin"
```

---

### Task 13: CSV export

**Files:**
- Create: `test/export.test.js`
- Modify: `src/app.js` (`registerRoutes`)

**Interfaces:**
- Consumes: `feedQuery` (Task 8).
- Produces: `GET /export.csv?<same filters as dashboard>` → `text/csv` attachment `transactions.csv` with header `date,description,account,card_member,category,amount,pending,note` — amount as a decimal string (e.g. `-1240.00`), date as YYYY-MM-DD. Same visibility scoping as the dashboard (it reuses `feedQuery`). Fields are CSV-escaped (quotes doubled, fields with commas/quotes/newlines wrapped in quotes).

- [ ] **Step 1: Write the failing test**

`test/export.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login } = require('./helpers');

test('export.csv respects filters and visibility, escapes fields', async () => {
  const { app, db } = makeApp();
  db.prepare(`UPDATE transactions SET note = 'has, comma and "quote"' WHERE uid = 'CHK|1'`).run();
  const owner = await login(app, 'michael', 'ownerpass1');
  const res = await request(app).get('/export.csv').set('Cookie', owner);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /attachment/);
  const lines = res.text.trim().split('\n');
  assert.equal(lines[0], 'date,description,account,card_member,category,amount,pending,note');
  assert.equal(lines.length, 5); // header + 4 txns for owner
  assert.match(res.text, /-1240\.00/);
  assert.match(res.text, /"has, comma and ""quote"""/);

  const member = await login(app, 'asst', 'memberpass1');
  const mres = await request(app).get('/export.csv').set('Cookie', member);
  assert.equal(mres.text.trim().split('\n').length, 4); // header + 3 (no private)
  assert.ok(!/PERSONAL DINNER/.test(mres.text));

  const filtered = await request(app).get('/export.csv?q=ups').set('Cookie', owner);
  assert.equal(filtered.text.trim().split('\n').length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/export.test.js` — Expected: FAIL (404).

- [ ] **Step 3: Implement**

Add inside `registerRoutes` in `src/app.js`:

```js
  app.get('/export.csv', (req, res) => {
    const { rows } = feedQuery(db, req.user, req.query);
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const cents = (c) => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
    const header = 'date,description,account,card_member,category,amount,pending,note';
    const lines = rows.map(t => [
      new Date(t.posted_at * 1000).toISOString().slice(0, 10),
      esc(t.description), esc(t.account_name), esc(t.card_member),
      esc(t.category_name), cents(t.amount_cents), t.pending ? '1' : '0', esc(t.note),
    ].join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
    res.send([header, ...lines].join('\n') + '\n');
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.js test/export.test.js
git commit -m "feat: filtered CSV export"
```

---

### Task 14: Config, boot script, scheduler, claim-token CLI

**Files:**
- Create: `src/config.js`, `src/scheduler.js`, `bin/serve.js`, `bin/claim-token.js`, `test/config.test.js`, `test/scheduler.test.js`

**Interfaces:**
- Consumes: `runSync` (Tasks 4/6), `createApp` (Task 9), `claimSetupToken` (Task 3).
- Produces:
  - `loadConfig({ envFile } = {})` → `{ dbPath, port, host, accessUrl, cookieSecure }`. Reads a `.env` file (KEY=VALUE lines, `#` comments) then overlays `process.env`. Defaults: `dbPath='data/bank.sqlite3'`, `port=3000`, `host='127.0.0.1'`, `cookieSecure=true` when `NODE_ENV==='production'`. Env names: `DB_PATH`, `PORT`, `HOST`, `SIMPLEFIN_ACCESS_URL`, `NODE_ENV`.
  - `startScheduler({ run, intervalMs = 4*3600*1000, retryMs = 15*60*1000, maxRetryMs = 2*3600*1000, setTimeoutFn = setTimeout })` → `{ stop() }`. Runs `run()` immediately, then every `intervalMs` on success; on failure retries with doubling backoff capped at `maxRetryMs`, resetting after a success. `run` is `async () => ({ ok: boolean })`.
  - `bin/serve.js` — loads config, opens DB, exits with a clear message if `SIMPLEFIN_ACCESS_URL` is missing, starts scheduler with `runSync`, serves `createApp` on host:port.
  - `bin/claim-token.js` — `node bin/claim-token.js <setup-token>` → claims and **appends `SIMPLEFIN_ACCESS_URL=...` to `.env`** (chmod 600), printing only a success message (never the URL itself, to keep it out of terminal scrollback).

- [ ] **Step 1: Write the failing tests**

`test/config.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');

test('loadConfig defaults, .env parsing, and process.env overlay', () => {
  const envFile = path.join(os.tmpdir(), `bd-env-${process.pid}`);
  fs.writeFileSync(envFile, '# comment\nSIMPLEFIN_ACCESS_URL=https://u:p@x.example/simplefin\nPORT=4000\n');
  const c = loadConfig({ envFile });
  assert.equal(c.accessUrl, 'https://u:p@x.example/simplefin');
  assert.equal(c.port, 4000);
  assert.equal(c.dbPath, 'data/bank.sqlite3');
  assert.equal(c.host, '127.0.0.1');
  const old = process.env.PORT;
  process.env.PORT = '5000';
  try { assert.equal(loadConfig({ envFile }).port, 5000); }
  finally { if (old === undefined) delete process.env.PORT; else process.env.PORT = old; }
  fs.rmSync(envFile);
});

test('loadConfig tolerates a missing .env file', () => {
  const c = loadConfig({ envFile: '/nonexistent/.env' });
  assert.equal(c.port, 3000);
});
```

`test/scheduler.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { startScheduler } = require('../src/scheduler');

test('scheduler: immediate run, interval on success, backoff doubling on failure, reset after success', async () => {
  const delays = [];
  const timers = [];
  const setTimeoutFn = (fn, ms) => { delays.push(ms); timers.push(fn); return delays.length; };
  const results = [{ ok: true }, { ok: false }, { ok: false }, { ok: false }, { ok: true }, { ok: true }];
  let calls = 0;
  const run = async () => results[calls++];

  const s = startScheduler({ run, intervalMs: 1000, retryMs: 100, maxRetryMs: 250, setTimeoutFn });
  // allow each chained run to settle
  for (let i = 0; i < results.length - 1; i++) {
    await new Promise(r => setImmediate(r));
    timers[i]();               // fire the most recently scheduled timer
  }
  await new Promise(r => setImmediate(r));
  assert.equal(calls, results.length);
  assert.deepEqual(delays, [1000, 100, 200, 250, 1000, 1000]);
  s.stop();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/config.test.js test/scheduler.test.js` — Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/config.js`:

```js
const fs = require('fs');

function parseEnvFile(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

function loadConfig({ envFile = '.env' } = {}) {
  const fileEnv = parseEnvFile(envFile);
  const get = (k, d) => (process.env[k] !== undefined ? process.env[k] : (fileEnv[k] !== undefined ? fileEnv[k] : d));
  return {
    dbPath: get('DB_PATH', 'data/bank.sqlite3'),
    port: Number(get('PORT', 3000)),
    host: get('HOST', '127.0.0.1'),
    accessUrl: get('SIMPLEFIN_ACCESS_URL', ''),
    cookieSecure: get('NODE_ENV', '') === 'production',
  };
}

module.exports = { loadConfig };
```

`src/scheduler.js` (the first run is invoked directly — not via `setTimeoutFn` — so tests control every subsequent delay):

```js
function startScheduler({ run, intervalMs = 4 * 3600 * 1000, retryMs = 15 * 60 * 1000,
                          maxRetryMs = 2 * 3600 * 1000, setTimeoutFn = setTimeout }) {
  let stopped = false;
  let backoff = retryMs;
  async function tick() {
    if (stopped) return;
    let ok = false;
    try { ok = (await run()).ok; } catch { ok = false; }
    if (stopped) return;
    if (ok) {
      backoff = retryMs;
      setTimeoutFn(tick, intervalMs);
    } else {
      setTimeoutFn(tick, backoff);
      backoff = Math.min(backoff * 2, maxRetryMs);
    }
  }
  tick();
  return { stop: () => { stopped = true; } };
}

module.exports = { startScheduler };
```

`bin/serve.js`:

```js
#!/usr/bin/env node
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { runSync } = require('../src/sync');
const { fetchAccounts } = require('../src/simplefin');
const { startScheduler } = require('../src/scheduler');

const config = loadConfig();
if (!config.accessUrl) {
  console.error('SIMPLEFIN_ACCESS_URL is not set. Run: node bin/claim-token.js <setup-token>');
  process.exit(1);
}

const db = openDb(config.dbPath);

startScheduler({
  run: async () => {
    const r = await runSync(db, { accessUrl: config.accessUrl, fetchAccountsFn: fetchAccounts });
    console.log(`[sync] ok=${r.ok} new=${r.newTransactions || 0} errors=${JSON.stringify(r.errors)}`);
    return r;
  },
});

const app = createApp(db, { cookieSecure: config.cookieSecure });
app.listen(config.port, config.host, () => {
  console.log(`bank-dashboard listening on http://${config.host}:${config.port}`);
});
```

`bin/claim-token.js`:

```js
#!/usr/bin/env node
// Usage: node bin/claim-token.js <setup-token-from-bridge.simplefin.org>
const fs = require('fs');
const { claimSetupToken } = require('../src/simplefin');

const token = process.argv[2];
if (!token) { console.error('Usage: node bin/claim-token.js <setup-token>'); process.exit(1); }

claimSetupToken(token).then((accessUrl) => {
  fs.appendFileSync('.env', `SIMPLEFIN_ACCESS_URL=${accessUrl}\n`, { mode: 0o600 });
  try { fs.chmodSync('.env', 0o600); } catch {}
  console.log('Access URL claimed and saved to .env (not printed for safety).');
  console.log('NOTE: a setup token can only be claimed once — if this failed, generate a new one.');
}).catch((err) => { console.error(`Claim failed: ${err.message}`); process.exit(1); });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS (full suite).

- [ ] **Step 5: Smoke-run locally (manual)**

```bash
echo "SIMPLEFIN_ACCESS_URL=https://demo:demo@beta-bridge.simplefin.org/simplefin" > .env
node bin/create-user.js michael owner
node bin/serve.js
```

SimpleFIN publishes a public demo access URL (`demo:demo@beta-bridge.simplefin.org`); the first sync should populate demo accounts. Log in at http://127.0.0.1:3000, verify: balance cards render, feed shows transactions, review queue has items. Then delete `.env` and `data/` (demo data) before real deployment. If the demo endpoint is unreachable, skip — unit tests already cover the pipeline.

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/scheduler.js bin/ test/config.test.js test/scheduler.test.js
git commit -m "feat: config, boot script, sync scheduler with backoff, claim-token CLI"
```

---

### Task 15: Deployment — droplet, Caddy, systemd, backups

**Files:**
- Create: `deploy/README.md`, `deploy/Caddyfile`, `deploy/bank-dashboard.service`, `deploy/backup.sh`

This task is operational: the files are committed, then executed by hand against the new droplet with the user present (DigitalOcean login, SimpleFIN setup token, and backup passphrase are theirs). **Nothing in this task is automated from CI.**

- [ ] **Step 1: Write deploy files**

`deploy/Caddyfile` (replace `203.0.113.7` with the droplet IP at deploy time):

```
# Preferred: Let's Encrypt IP certificate (requires Caddy >= 2.10)
203.0.113.7 {
	reverse_proxy 127.0.0.1:3000
}

# Fallback if IP certs fail: use the sslip.io hostname instead of the IP block above:
# 203-0-113-7.sslip.io {
# 	reverse_proxy 127.0.0.1:3000
# }
```

`deploy/bank-dashboard.service`:

```ini
[Unit]
Description=Bank dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bankdash
WorkingDirectory=/opt/bank-dashboard
ExecStart=/usr/bin/node bin/serve.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/bank-dashboard/data
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`deploy/backup.sh`:

```bash
#!/usr/bin/env bash
# Nightly encrypted SQLite backup to DigitalOcean Spaces via rclone.
# Requires: sqlite3, gpg, rclone (configured with a 'spaces' remote), and
# a passphrase in /etc/bank-dashboard/backup.pass (root:root, mode 600).
set -euo pipefail
DB=/opt/bank-dashboard/data/bank.sqlite3
STAMP=$(date +%Y%m%d-%H%M%S)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
sqlite3 "$DB" ".backup '$TMP/bank-$STAMP.sqlite3'"
gpg --batch --symmetric --cipher-algo AES256 \
    --passphrase-file /etc/bank-dashboard/backup.pass \
    -o "$TMP/bank-$STAMP.sqlite3.gpg" "$TMP/bank-$STAMP.sqlite3"
rclone copy "$TMP/bank-$STAMP.sqlite3.gpg" spaces:bank-dashboard-backups/
# keep 60 days of backups
rclone delete --min-age 60d spaces:bank-dashboard-backups/ || true
```

`deploy/README.md` — the full runbook, verbatim:

````markdown
# Deploying bank-dashboard to a fresh DigitalOcean droplet

## 1. Droplet
- Create: Ubuntu 24.04 LTS, Basic $6/mo, SSH key auth (no password), any region near you.
- Note the IP. Everywhere below, replace 203.0.113.7 with it.

## 2. Base hardening (as root)
```bash
apt-get update && apt-get -y upgrade
apt-get -y install ufw unattended-upgrades build-essential sqlite3 gpg rclone git
dpkg-reconfigure -f noninteractive unattended-upgrades
ufw default deny incoming
ufw allow OpenSSH
ufw allow 80/tcp     # ACME challenges
ufw allow 443/tcp
ufw --force enable
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh
```

## 3. Node 22 + app user
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get -y install nodejs
useradd --system --create-home --home-dir /opt/bank-dashboard --shell /usr/sbin/nologin bankdash
```

## 4. App
```bash
# from your Mac, in the repo root:
rsync -a --exclude node_modules --exclude data --exclude .env --exclude .superpowers ./ root@203.0.113.7:/opt/bank-dashboard/
# on the droplet:
cd /opt/bank-dashboard && npm ci --omit=dev
chown -R bankdash:bankdash /opt/bank-dashboard
```

## 5. Secrets + users (on the droplet, as root, in /opt/bank-dashboard)
```bash
sudo -u bankdash node bin/claim-token.js '<setup token from bridge.simplefin.org>'
sudo -u bankdash node bin/create-user.js michael owner
sudo -u bankdash node bin/create-user.js assistant member
chmod 600 .env && chown bankdash:bankdash .env
```
Generate the setup token at bridge.simplefin.org ("New token"). A token can be claimed only once.

## 6. systemd + Caddy
```bash
cp deploy/bank-dashboard.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now bank-dashboard
journalctl -u bank-dashboard -f   # watch the first sync complete
# Caddy (official repo):
apt-get -y install debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get -y install caddy
caddy version   # must be >= 2.10 for IP certificates; otherwise use the sslip.io fallback
sed "s/203.0.113.7/$(curl -s ifconfig.me)/" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy
```
Visit https://<droplet-ip>/ — expect a valid padlock. If Caddy logs show ACME failures for the IP
cert, switch /etc/caddy/Caddyfile to the sslip.io variant and reload.

## 7. Backups
```bash
mkdir -p /etc/bank-dashboard
openssl rand -base64 32 > /etc/bank-dashboard/backup.pass && chmod 600 /etc/bank-dashboard/backup.pass
# Save a copy of backup.pass somewhere safe OFF the droplet (password manager) —
# without it, backups are unrecoverable.
rclone config   # create remote named 'spaces' → DigitalOcean Spaces, with a Space named bank-dashboard-backups
cp deploy/backup.sh /usr/local/bin/bank-backup && chmod +x /usr/local/bin/bank-backup
( crontab -l 2>/dev/null; echo '17 3 * * * /usr/local/bin/bank-backup' ) | crontab -
/usr/local/bin/bank-backup   # run once, verify the object appears in Spaces
```

## 8. Link the rest of the connections
At bridge.simplefin.org, add the remaining nine Truist logins, the company Amex, and the
personal Amex. They appear on the dashboard after the next sync (or restart the service to
sync now: `systemctl restart bank-dashboard`). Then, as the owner, open /accounts and flip
each company account to "Company" visibility, set display names, and correct any wrong
bank/credit-card type guesses.

## 9. Build-time verifications (from the spec)
- [ ] Amex card payments pair as Transfers — check signs; if Amex reports payments with the
      same sign as Truist debits, transfer pairing won't fire: inspect two real rows in
      sqlite3 and note findings in docs/superpowers/specs/.
- [ ] Employee cards: check whether they arrived as separate accounts or as card_member
      values; if neither, transactions may embed the member name in the description —
      adjust `normalizeTxn` in src/simplefin.js accordingly.
- [ ] Break a connection's password at the bank (or wait for one to need re-auth) is NOT
      required — just confirm the staleness banner text renders when `sync_errors` is
      non-empty after any real connection hiccup.
````

- [ ] **Step 2: Commit**

```bash
git add deploy/
git commit -m "feat: deployment runbook, Caddyfile, systemd unit, encrypted backups"
```

- [ ] **Step 3: Execute the runbook**

Work through `deploy/README.md` top to bottom with the user (they hold the DigitalOcean account, the SimpleFIN setup token, and choose the two passwords). Finish by completing section 9's checklist and reporting findings.

---

## Verification checklist (run after all tasks)

- [ ] `npm test` — entire suite green.
- [ ] Local smoke: demo SimpleFIN URL syncs; login works; member login shows no private data.
- [ ] Production: https://IP loads with valid TLS; both users can log in; 10 Truist + Amex connections syncing; visibility flags set; review queue functioning; CSV downloads; backup object present in Spaces.
