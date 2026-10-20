const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/app');
const { decrypt } = require('../src/crypto');
const { addItem } = require('../src/plaid');
const { enrollTotp, registerApp, login } = require('./helpers');

const KEY = 'c'.repeat(64);

function fakePlaid() {
  const calls = [];
  const api = { calls };
  api.linkTokenCreate = async (req) => { calls.push(['linkTokenCreate', req]); return { data: { link_token: 'link-sandbox-123' } }; };
  api.itemPublicTokenExchange = async (req) => { calls.push(['exchange', req]); return { data: { access_token: 'access-production-xyz', item_id: 'item-9' } }; };
  api.itemRemove = async (req) => { calls.push(['itemRemove', req]); return { data: { removed: true } }; };
  api.accountsGet = async () => ({ data: { accounts: [] } });
  api.transactionsSync = async () => ({ data: { added: [], modified: [], removed: [], next_cursor: 'c', has_more: false } });
  return api;
}

function app(plaidOpts) {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'ownerpass1', 'owner');
  createUser(db, 'asst', 'memberpass1', 'member');
  const client = fakePlaid();
  const synced = [];
  enrollTotp(db, 'michael', KEY);
  enrollTotp(db, 'asst', KEY);
  const a = registerApp(createApp(db, { plaid: { client, appSecret: KEY, syncNow: async () => { synced.push(1); }, ...(plaidOpts || {}) } }), db);
  return { app: a, db, client, synced };
}

test('connections page and its actions are owner-only', async () => {
  const { app: a } = app();
  const member = await login(a, 'asst', 'memberpass1');
  assert.equal((await request(a).get('/connections').set('Cookie', member)).status, 404);
  assert.equal((await request(a).post('/connections/link-token').set('Cookie', member).send({})).status, 404);
  assert.equal((await request(a).post('/connections/exchange').set('Cookie', member).send({ public_token: 'x' })).status, 404);
});

test('link token requests 24 months of transactions; update mode carries the item access token', async () => {
  const { app: a, db, client } = app();
  const owner = await login(a, 'michael', 'ownerpass1');
  const res = await request(a).post('/connections/link-token').set('Cookie', owner).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.link_token, 'link-sandbox-123');
  const req = client.calls.find(c => c[0] === 'linkTokenCreate')[1];
  assert.deepEqual(req.products, ['transactions']);
  assert.equal(req.transactions.days_requested, 730);
  assert.deepEqual(req.country_codes, ['US']);
  assert.equal(req.access_token, undefined);

  addItem(db, { itemId: 'item-1', accessToken: 'access-1', institutionName: 'Truist', now: 1 }, KEY);
  const id = db.prepare("SELECT id FROM plaid_items WHERE item_id='item-1'").get().id;
  await request(a).post('/connections/link-token').set('Cookie', owner).send({ item_id: id });
  const upd = client.calls.filter(c => c[0] === 'linkTokenCreate').pop()[1];
  assert.equal(upd.access_token, 'access-1', 'update mode uses the decrypted item token');
  assert.equal(upd.products, undefined, 'update mode does not re-request products');
});

test('exchange stores the item with an encrypted token and triggers a sync', async () => {
  const { app: a, db, synced } = app();
  const owner = await login(a, 'michael', 'ownerpass1');
  const res = await request(a).post('/connections/exchange').set('Cookie', owner)
    .send({ public_token: 'public-abc', institution_name: 'Truist' });
  assert.equal(res.status, 200);
  const item = db.prepare("SELECT * FROM plaid_items WHERE item_id='item-9'").get();
  assert.equal(item.institution_name, 'Truist');
  assert.ok(!item.access_token_enc.includes('access-production'));
  assert.equal(decrypt(item.access_token_enc, KEY), 'access-production-xyz');
  assert.equal(synced.length, 1);
  assert.equal((await request(a).post('/connections/exchange').set('Cookie', owner).send({})).status, 400);
});

test('the page lists items with their accounts and status; delete removes the item at Plaid too', async () => {
  const { app: a, db, client } = app();
  addItem(db, { itemId: 'item-1', accessToken: 'access-1', institutionName: 'Truist', now: 1 }, KEY);
  db.prepare("UPDATE plaid_items SET status='error', error='ITEM_LOGIN_REQUIRED: x' WHERE item_id='item-1'").run();
  db.prepare(`INSERT INTO accounts (id, name, display_name, kind, source, source_account_id) VALUES
    ('plaid:a1', 'Checking', 'Ops', 'bank', 'plaid', 'a1')`).run();
  const owner = await login(a, 'michael', 'ownerpass1');
  const page = await request(a).get('/connections').set('Cookie', owner);
  assert.equal(page.status, 200);
  assert.match(page.text, /Truist/);
  assert.match(page.text, /Needs attention/);
  assert.match(page.text, /cdn\.plaid\.com/);

  const id = db.prepare("SELECT id FROM plaid_items WHERE item_id='item-1'").get().id;
  const del = await request(a).post(`/connections/${id}/delete`).set('Cookie', owner);
  assert.equal(del.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plaid_items').get().n, 0);
  assert.equal(client.calls.find(c => c[0] === 'itemRemove')[1].access_token, 'access-1');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE id='plaid:a1'").get().n, 1, 'history stays');
});

test('without Plaid configured the page explains what is missing instead of failing', async () => {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'ownerpass1', 'owner');
  enrollTotp(db, 'michael', KEY);
  const a = registerApp(createApp(db, { appSecret: KEY }), db);
  const owner = await login(a, 'michael', 'ownerpass1');
  const page = await request(a).get('/connections').set('Cookie', owner);
  assert.equal(page.status, 200);
  assert.match(page.text, /isn't configured/);
  assert.equal((await request(a).post('/connections/link-token').set('Cookie', owner).send({})).status, 503);
});

test('statement details: consent link asks only for liabilities on that login; completing it enables the fetch', async () => {
  const { app: a, db, client, synced } = app();
  addItem(db, { itemId: 'item-amx', accessToken: 'access-amx', institutionName: 'American Express', now: 1 }, KEY);
  const id = db.prepare("SELECT id FROM plaid_items WHERE item_id='item-amx'").get().id;
  db.prepare(`INSERT INTO accounts (id, name, kind, source, source_account_id) VALUES ('plaid:pa-gold', 'Business Gold Card', 'credit', 'plaid', 'pa-gold')`).run();
  db.prepare(`UPDATE plaid_items SET account_ids = '["pa-gold"]' WHERE id = ?`).run(id);
  const owner = await login(a, 'michael', 'ownerpass1');

  const page = await request(a).get('/connections').set('Cookie', owner);
  assert.match(page.text, new RegExp(`class="[^"]*js-statements[^"]*" data-id="${id}"`));

  await request(a).post('/connections/link-token').set('Cookie', owner).send({ item_id: id, add: 'liabilities' });
  const req = client.calls.find(c => c[0] === 'linkTokenCreate')[1];
  assert.equal(req.access_token, 'access-amx', 'update mode on the existing login');
  assert.deepEqual(req.additional_consented_products, ['liabilities']);
  assert.equal(req.products, undefined);

  const r = await request(a).post('/connections/exchange').set('Cookie', owner).send({ public_token: 'p', item_id: id, add: 'liabilities' });
  assert.equal(r.status, 200);
  const item = db.prepare('SELECT * FROM plaid_items WHERE id = ?').get(id);
  assert.equal(item.liabilities, 'on');
  assert.equal(item.liabilities_fetched_at, null, 'fetched on the next sync');
  assert.equal(synced.length, 1);
  assert.ok(!client.calls.some(c => c[0] === 'exchange'), 'no new item: the token is unchanged');
  const after = await request(a).get('/connections').set('Cookie', owner);
  assert.match(after.text, /Statement details on/);
});
