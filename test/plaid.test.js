const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { encrypt, decrypt } = require('../src/crypto');
const { plaidSync, addItem, PLAID_INTERVAL_MS } = require('../src/plaid');

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
