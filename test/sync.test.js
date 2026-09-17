const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { runSync, OVERLAP_SECONDS } = require('../src/sync');

const NOW = 1789000000;
const now = () => NOW;

// Setup: insert default user for foreign key references in tests
function setupDb(db) {
  db.prepare('INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'test', 'hash', 'owner');
}

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
  setupDb(db);
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
