const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { encrypt, decrypt } = require('../src/crypto');
const { plaidSync, addItem, PLAID_INTERVAL_MS, repairOverlapDuplicates } = require('../src/plaid');

const KEY = 'a'.repeat(64); // 32 bytes hex
const et = (s) => Math.floor(new Date(s).getTime() / 1000);
const NOW = et('2026-09-23T12:00:00-04:00');

test('access tokens round-trip through encryption and the ciphertext hides the token', () => {
  const enc = encrypt('access-production-abc', KEY);
  assert.ok(!enc.includes('access-production'));
  assert.equal(decrypt(enc, KEY), 'access-production-abc');
  assert.notEqual(encrypt('access-production-abc', KEY), enc, 'fresh nonce each time');
  assert.throws(() => decrypt(enc, 'b'.repeat(64)), 'wrong key must fail, not return garbage');
});

// A fake Plaid client scripted per test.
function fakePlaid(script) {
  const calls = [];
  const api = { calls };
  for (const [name, fn] of Object.entries(script)) {
    api[name] = async (req) => { calls.push([name, req]); return { data: await fn(req) }; };
  }
  return api;
}

const ACCOUNTS = [
  { account_id: 'pa-chk', name: 'BHCC LLC', official_name: 'Business Checking', mask: '8743', type: 'depository', subtype: 'checking',
    balances: { current: 42180.10, available: 42000 } },
  { account_id: 'pa-amx', name: 'Amex Business', mask: '1002', type: 'credit', subtype: 'credit card',
    balances: { current: 4812.77, available: 10000 } },
];
const tx = (id, accountId, amount, date, extra = {}) => ({
  transaction_id: id, account_id: accountId, amount, date, name: extra.name || 'UPS FREIGHT',
  merchant_name: extra.merchant || null, pending: !!extra.pending,
  pending_transaction_id: extra.pendingId || null,
});

function seededDb() {
  const db = openDb(':memory:');
  // an existing SimpleFIN account with owner settings and one categorized transaction in the overlap window
  db.prepare(`INSERT INTO accounts (id, name, display_name, kind, visibility, hidden, balance_cents, last_synced_at)
    VALUES ('ACT-old-8743', 'BHCC LLC 8743 (8743)', 'Ops', 'bank', 'company', 0, 100, ?)`).run(NOW - 86400);
  const supplies = db.prepare("SELECT id FROM categories WHERE name='Supplies'").get().id;
  db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, category_id,
    category_source, note, first_seen_at) VALUES ('ACT-old-8743|sf1', 'sf1', 'ACT-old-8743', ?, -124000, 'UPS FREIGHT',
    ?, 'manual', 'trade show crates', ?)`).run(et('2026-09-20T15:00:00-04:00'), supplies, NOW);
  return db;
}

function itemWithScript(db, sync) {
  addItem(db, { itemId: 'item-1', accessToken: 'access-production-abc', institutionName: 'Truist', now: NOW }, KEY);
  return fakePlaid({
    accountsGet: async () => ({ accounts: ACCOUNTS }),
    itemGet: async () => ({ item: { error: null } }),
    transactionsSync: sync,
  });
}

test('first sync links the existing account by mask, adds new accounts, and de-duplicates the overlap', async () => {
  const db = seededDb();
  const client = itemWithScript(db, async (req) => ({
    added: [
      tx('pt-1', 'pa-chk', 1240.00, '2026-09-21'),         // same amount ±2 days as the SimpleFIN row
      tx('pt-2', 'pa-chk', -6801.22, '2026-09-22', { name: 'STRIPE PAYOUT' }),
      tx('pt-3', 'pa-amx', 80.00, '2026-09-22', { name: 'DELTA AIR', pending: true }),
    ],
    modified: [], removed: [], next_cursor: 'c1', has_more: false,
  }));

  const r = await plaidSync(db, { client, appSecret: KEY, now: () => NOW });
  assert.equal(r.ok, true);

  const chk = db.prepare("SELECT * FROM accounts WHERE id='ACT-old-8743'").get();
  assert.equal(chk.source, 'plaid');
  assert.equal(chk.source_account_id, 'pa-chk');
  assert.equal(chk.display_name, 'Ops', 'owner settings untouched');
  assert.equal(chk.visibility, 'company');
  assert.equal(chk.balance_cents, 4218010);
  const amx = db.prepare("SELECT * FROM accounts WHERE source_account_id='pa-amx'").get();
  assert.equal(amx.id, 'plaid:pa-amx');
  assert.equal(amx.kind, 'credit');
  assert.equal(amx.visibility, 'private', 'new accounts start private');
  assert.equal(amx.balance_cents, -481277, 'credit balance stored as negative owed');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 3, 'overlap row was linked, not duplicated');
  const linked = db.prepare("SELECT * FROM transactions WHERE uid='ACT-old-8743|sf1'").get();
  assert.equal(linked.plaid_txn_id, 'pt-1');
  assert.equal(linked.note, 'trade show crates');
  assert.equal(linked.category_source, 'manual');
  const stripe = db.prepare("SELECT * FROM transactions WHERE plaid_txn_id='pt-2'").get();
  assert.equal(stripe.amount_cents, 680122, 'Plaid sign is flipped: money in is positive');
  assert.equal(stripe.account_id, 'ACT-old-8743');
  const delta = db.prepare("SELECT * FROM transactions WHERE plaid_txn_id='pt-3'").get();
  assert.equal(delta.pending, 1);
  assert.equal(delta.account_id, 'plaid:pa-amx');

  const item = db.prepare("SELECT * FROM plaid_items WHERE item_id='item-1'").get();
  assert.equal(item.cursor, 'c1');
  assert.equal(item.status, 'ok');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='data_source'").get().value, 'plaid');
});

test('pending → posted keeps the note and category on one row; removed deletes; cursor pages', async () => {
  const db = seededDb();
  let page = 0;
  const client = itemWithScript(db, async (req) => {
    page++;
    if (page === 1) {
      assert.equal(req.cursor, undefined, 'first sync starts without a cursor');
      return { added: [tx('pend-1', 'pa-amx', 80.00, '2026-09-22', { name: 'DELTA AIR', pending: true })],
        modified: [], removed: [], next_cursor: 'c1', has_more: true };
    }
    if (page === 2) {
      assert.equal(req.cursor, 'c1');
      return { added: [tx('gone-1', 'pa-amx', 5.00, '2026-09-22', { name: 'TEMP HOLD', pending: true })],
        modified: [], removed: [], next_cursor: 'c2', has_more: false };
    }
    assert.equal(req.cursor, 'c2', 'second run resumes from the persisted cursor');
    return {
      added: [tx('post-1', 'pa-amx', 80.00, '2026-09-23', { name: 'DELTA AIR LINES', pendingId: 'pend-1' })],
      modified: [], removed: [{ transaction_id: 'gone-1' }], next_cursor: 'c3', has_more: false,
    };
  });

  await plaidSync(db, { client, appSecret: KEY, now: () => NOW });
  const fees = db.prepare("SELECT id FROM categories WHERE name='Fees'").get().id;
  db.prepare("UPDATE transactions SET category_id=?, category_source='manual', note='Jane flight' WHERE plaid_txn_id='pend-1'").run(fees);
  assert.equal(db.prepare("SELECT cursor FROM plaid_items").get().cursor, 'c2');

  await plaidSync(db, { client, appSecret: KEY, now: () => NOW + 60 });
  const rows = db.prepare("SELECT * FROM transactions WHERE account_id='plaid:pa-amx'").all();
  assert.equal(rows.length, 1, 'pending row migrated, temp hold removed');
  assert.equal(rows[0].plaid_txn_id, 'post-1');
  assert.equal(rows[0].pending, 0);
  assert.equal(rows[0].description, 'DELTA AIR LINES');
  assert.equal(rows[0].note, 'Jane flight');
  assert.equal(rows[0].category_id, fees);
  assert.equal(db.prepare("SELECT cursor FROM plaid_items").get().cursor, 'c3');
});

test('an item error is recorded, surfaced in sync_errors, and does not stop other items', async () => {
  const db = seededDb();
  addItem(db, { itemId: 'item-bad', accessToken: 'access-bad', institutionName: 'Amex', now: NOW }, KEY);
  addItem(db, { itemId: 'item-ok', accessToken: 'access-ok', institutionName: 'Truist', now: NOW }, KEY);
  const client = fakePlaid({
    accountsGet: async (req) => {
      if (req.access_token === 'access-bad') {
        const err = new Error('login required');
        err.response = { data: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' } };
        throw err;
      }
      return { accounts: ACCOUNTS };
    },
    itemGet: async () => ({ item: { error: null } }),
    transactionsSync: async () => ({ added: [], modified: [], removed: [], next_cursor: 'c1', has_more: false }),
  });
  const r = await plaidSync(db, { client, appSecret: KEY, now: () => NOW });
  assert.equal(r.ok, true);
  const bad = db.prepare("SELECT * FROM plaid_items WHERE item_id='item-bad'").get();
  assert.equal(bad.status, 'error');
  assert.match(bad.error, /ITEM_LOGIN_REQUIRED/);
  const ok = db.prepare("SELECT * FROM plaid_items WHERE item_id='item-ok'").get();
  assert.equal(ok.status, 'ok');
  const errors = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='sync_errors'").get().value);
  assert.ok(errors.some(e => /Amex/.test(e) && /re-connect|reconnect|log in/i.test(e)), errors.join(' | '));
});

test('the shared pipeline runs after a Plaid sync (transfers + rules + recurring)', async () => {
  const db = seededDb();
  const client = itemWithScript(db, async () => ({
    added: [
      tx('o1', 'pa-chk', 5000.00, '2026-09-22', { name: 'AMEX EPAYMENT' }),
      tx('i1', 'pa-amx', -5000.00, '2026-09-22', { name: 'PAYMENT THANK YOU' }),
    ],
    modified: [], removed: [], next_cursor: 'c1', has_more: false,
  }));
  await plaidSync(db, { client, appSecret: KEY, now: () => NOW });
  const transfers = db.prepare("SELECT id FROM categories WHERE name='Transfers'").get().id;
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE plaid_txn_id='o1'").get().category_id, transfers);
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE plaid_txn_id='i1'").get().category_id, transfers);
});

test('plaidSync with no items is a no-op and the poll interval is five minutes', async () => {
  const db = openDb(':memory:');
  const r = await plaidSync(db, { client: fakePlaid({}), appSecret: KEY, now: () => NOW });
  assert.equal(r.ok, true);
  assert.equal(r.items, 0);
  assert.equal(PLAID_INTERVAL_MS, 5 * 60 * 1000);
});

test('overlap: SimpleFIN rows dated 2–3 days before Plaid posting (8am vs noon, across a weekend) are adopted, not duplicated', async () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO accounts (id, name, kind, visibility, hidden, balance_cents, last_synced_at)
    VALUES ('ACT-old-8743', 'BHCC LLC 8743 (8743)', 'bank', 'company', 0, 100, ?)`).run(NOW);
  const old = db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, first_seen_at)
    VALUES (?, ?, 'ACT-old-8743', ?, ?, ?, ?)`);
  // SimpleFIN stamped these at 08:00 Eastern on the transaction date
  old.run('ACT-old-8743|sf-hyg', 'sf-hyg', et('2026-07-17T08:00:00-04:00'), -29500, 'HYGINIX858-566-6212 CA US', NOW);
  old.run('ACT-old-8743|sf-ccp', 'sf-ccp', et('2026-09-05T08:00:00-04:00'), -1000000, 'Credit card payment', NOW);  // Friday
  old.run('ACT-old-8743|sf-nad', 'sf-nad', et('2026-09-20T08:00:00-04:00'), -51500, 'CASH APP*NADIA SOTGIUOakland CA US', NOW);
  const client = itemWithScript(db, async () => ({
    added: [
      tx('p-hyg', 'pa-chk', 295, '2026-07-19', { name: 'HYGINIX858-566-6212' }),            // 2 days later
      tx('p-ccp', 'pa-chk', 10000, '2026-09-08', { name: 'MOBILE TO ****7263 - TRUIST' }),    // the Monday after
      tx('p-jos', 'pa-chk', 515, '2026-09-17', { name: 'CASH APP*JOSHUA COATESOakland' }),    // different payee, same amount, in window
      tx('p-nad', 'pa-chk', 515, '2026-09-21', { name: 'CASH APP*NADIA SOTGIUOakland' }),
      tx('p-new', 'pa-chk', 295, '2026-08-16', { name: 'HYGINIX858-566-6212' }),              // genuinely new: no SimpleFIN row
    ],
    modified: [], removed: [], next_cursor: 'c1', has_more: false,
  }));
  assert.equal((await plaidSync(db, { client, appSecret: KEY, now: () => NOW })).ok, true);
  const ids = (uid) => db.prepare('SELECT plaid_txn_id FROM transactions WHERE uid = ?').get(uid).plaid_txn_id;
  assert.equal(ids('ACT-old-8743|sf-hyg'), 'p-hyg');
  assert.equal(ids('ACT-old-8743|sf-ccp'), 'p-ccp');
  assert.equal(ids('ACT-old-8743|sf-nad'), 'p-nad', 'the matching payee wins over a nearer same-amount payment');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 5, '3 adopted + JOSHUA + the new HYGINIX');
});

test('repairOverlapDuplicates: dry run changes nothing; apply merges copies into the older rows', () => {
  const db = openDb(':memory:');
  const transfers = db.prepare("SELECT id FROM categories WHERE name='Transfers'").get().id;
  const supplies = db.prepare("SELECT id FROM categories WHERE name='Supplies'").get().id;
  db.prepare(`INSERT INTO accounts (id, name, kind, visibility, hidden, balance_cents, last_synced_at, source) VALUES
    ('B', 'BHCC 8743', 'bank', 'company', 0, 0, ?, 'plaid'), ('C', 'BHCC CC 7263', 'credit', 'company', 0, 0, ?, 'plaid')`).run(NOW, NOW);
  const ins = db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description, pending,
    plaid_txn_id, category_id, category_source, note, transfer_pair_uid, first_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const d8 = (day) => et(`${day}T08:00:00-04:00`);
  const d12 = (day) => et(`${day}T12:00:00-04:00`);
  // earliest Plaid-inserted row defines coverage
  ins.run('B|p:early', 'p:early', 'B', d12('2026-06-01'), -100, 'EARLY', 0, 'early', null, null, null, null, NOW);
  // old card payment (annotated) and its Plaid copy, which Plaid paired with the card side
  ins.run('B|sf1', 'sf1', 'B', d8('2026-09-05'), -1000000, 'Credit card payment', 0, null, null, null, 'monthly paydown', null, NOW);
  ins.run('B|p:ccp', 'p:ccp', 'B', d12('2026-09-08'), -1000000, 'MOBILE TO ****7263 - TRUIST', 0, 'ccp', transfers, 'transfer', null, 'C|p:pay', NOW);
  ins.run('C|p:pay', 'p:pay', 'C', d12('2026-09-08'), 1000000, 'PAYMENT THANK YOU', 0, 'pay', transfers, 'transfer', null, 'B|p:ccp', NOW);
  // two same-amount Cash App payments: the old NADIA row must merge with the NADIA copy
  ins.run('B|sf2', 'sf2', 'B', d8('2026-09-20'), -51500, 'CASH APP*NADIA SOTGIUOakland CA US', 0, null, supplies, 'manual', null, null, NOW);
  ins.run('B|p:jos', 'p:jos', 'B', d12('2026-09-17'), -51500, 'CASH APP*JOSHUA COATESOakland', 0, 'jos', null, null, null, null, NOW);
  ins.run('B|p:nad', 'p:nad', 'B', d12('2026-09-21'), -51500, 'CASH APP*NADIA SOTGIUOakland', 0, 'nad', null, null, null, null, NOW);
  // stale SimpleFIN pending row, and an old row with no Plaid copy at all
  ins.run('B|sf3', 'sf3', 'B', d8('2026-10-02'), -100, 'GOOGLE *CHROME TEMP', 1, null, null, null, null, null, NOW);
  ins.run('B|sf4', 'sf4', 'B', d8('2026-09-01'), -4242, 'ONLY IN SIMPLEFIN', 0, null, null, null, null, null, NOW);

  const count = () => db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
  const dry = repairOverlapDuplicates(db);
  assert.equal(count(), 9, 'dry run writes nothing');
  assert.deepEqual(dry.merged.map(m => [m.keep.uid, m.drop.uid]).sort(), [['B|sf1', 'B|p:ccp'], ['B|sf2', 'B|p:nad']]);
  assert.deepEqual(dry.stalePending.map(r => r.uid), ['B|sf3']);
  assert.deepEqual(dry.unmatched.map(r => r.uid), ['B|sf4']);

  repairOverlapDuplicates(db, { apply: true });
  assert.equal(count(), 6);
  const row = (uid) => ({ ...db.prepare('SELECT * FROM transactions WHERE uid = ?').get(uid) });
  const kept = row('B|sf1');
  assert.equal(kept.plaid_txn_id, 'ccp');
  assert.equal(kept.note, 'monthly paydown');
  assert.equal(kept.category_source, 'transfer', 'uncategorized old row takes the copy\'s category');
  assert.equal(kept.transfer_pair_uid, 'C|p:pay');
  assert.equal(row('C|p:pay').transfer_pair_uid, 'B|sf1', 'the card side now points at the kept row');
  const nad = row('B|sf2');
  assert.equal(nad.plaid_txn_id, 'nad');
  assert.equal(nad.category_source, 'manual', 'a manual category is never replaced');
  assert.equal(row('B|p:jos').plaid_txn_id, 'jos', 'the other payee is untouched');
  assert.equal(db.prepare("SELECT 1 FROM transactions WHERE uid IN ('B|p:ccp','B|p:nad','B|sf3')").get(), undefined);
  assert.equal(row('B|sf4').uid, 'B|sf4', 'unmatched rows are reported, never deleted');
  assert.equal(repairOverlapDuplicates(db, { apply: true }).merged.length, 0, 'idempotent');
});

// ---- card statement details (Plaid Liabilities) ----
const LIAB = {
  accounts: ACCOUNTS,
  liabilities: { credit: [{
    account_id: 'pa-amx', last_statement_balance: 4120.55, last_statement_issue_date: '2026-09-28',
    minimum_payment_amount: 41.21, next_payment_due_date: '2026-10-25', last_payment_amount: 4120.55,
    last_payment_date: '2026-10-11', is_overdue: false, aprs: [],
  }] },
};
const statementSync = (db, { liabilities, liabilitiesGet }) => {
  addItem(db, { itemId: 'item-1', accessToken: 'access-production-abc', institutionName: 'American Express', now: NOW }, KEY);
  if (liabilities) db.prepare("UPDATE plaid_items SET liabilities = 'on' WHERE item_id = 'item-1'").run();
  return fakePlaid({
    accountsGet: async () => ({ accounts: ACCOUNTS }),
    transactionsSync: async () => ({ added: [], modified: [], removed: [], next_cursor: 'c', has_more: false }),
    liabilitiesGet: liabilitiesGet || (async () => LIAB),
  });
};

test('statement details are never requested (or billed) until the owner enables them for that login', async () => {
  const db = openDb(':memory:');
  const client = statementSync(db, { liabilities: false });
  await plaidSync(db, { client, appSecret: KEY, now: () => NOW });
  assert.ok(!client.calls.some(c => c[0] === 'liabilitiesGet'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM card_statements').get().n, 0);
});

test('enabled: statement balance, minimum, due date and last payment are stored per card, refreshed at most every 6 hours', async () => {
  const db = openDb(':memory:');
  const client = statementSync(db, { liabilities: true });
  let t = NOW;
  await plaidSync(db, { client, appSecret: KEY, now: () => t });
  const s = { ...db.prepare("SELECT * FROM card_statements WHERE account_id = 'plaid:pa-amx'").get() };
  assert.equal(s.statement_balance_cents, 412055);
  assert.equal(s.minimum_payment_cents, 4121);
  assert.equal(s.last_payment_cents, 412055);
  assert.equal(new Date(s.statement_date * 1000).toISOString().slice(0, 10), '2026-09-28');
  assert.equal(new Date(s.due_date * 1000).toISOString().slice(0, 10), '2026-10-25');
  assert.equal(new Date(s.last_payment_date * 1000).toISOString().slice(0, 10), '2026-10-11');
  assert.equal(s.is_overdue, 0);
  const calls = () => client.calls.filter(c => c[0] === 'liabilitiesGet').length;
  t = NOW + 3600;
  await plaidSync(db, { client, appSecret: KEY, now: () => t });
  assert.equal(calls(), 1, 'not again within 6 hours');
  t = NOW + 6 * 3600 + 1;
  await plaidSync(db, { client, appSecret: KEY, now: () => t });
  assert.equal(calls(), 2);
});

test('a statement-details failure is recorded on the login but never breaks the transaction sync', async () => {
  const db = openDb(':memory:');
  const err = Object.assign(new Error('400'), { response: { data: { error_code: 'PRODUCTS_NOT_SUPPORTED', error_message: 'not supported' } } });
  const client = statementSync(db, { liabilities: true, liabilitiesGet: async () => { throw err; } });
  const r = await plaidSync(db, { client, appSecret: KEY, now: () => NOW });
  assert.equal(r.ok, true);
  const item = db.prepare("SELECT * FROM plaid_items WHERE item_id = 'item-1'").get();
  assert.equal(item.status, 'ok');
  assert.match(item.liabilities_error, /PRODUCTS_NOT_SUPPORTED/);
});
