const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createUser } = require('../src/auth');
const { createApp } = require('../src/app');
const { decrypt } = require('../src/crypto');
const { addItem } = require('../src/plaid');

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
  const a = createApp(db, { plaid: { client, appSecret: KEY, syncNow: async () => { synced.push(1); }, ...(plaidOpts || {}) } });
  return { app: a, db, client, synced };
}
async function login(a, u, p) {
  const res = await request(a).post('/login').type('form').send({ username: u, password: p });
  return res.headers['set-cookie'][0].split(';')[0];
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
  const a = createApp(db, {});
  const owner = await login(a, 'michael', 'ownerpass1');
  const page = await request(a).get('/connections').set('Cookie', owner);
  assert.equal(page.status, 200);
  assert.match(page.text, /isn't configured/);
  assert.equal((await request(a).post('/connections/link-token').set('Cookie', owner).send({})).status, 503);
});
