const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createUser } = require('../src/auth');
const { runSync } = require('../src/sync');
const {
  ALLOWED_TXN_KEYS, maskDigits, cardholderLabels, buildRequest, categorizeUncategorized,
} = require('../src/ai-categorize');

const T0 = 1789000000;

// A database seeded with values that must NEVER reach the API.
const SECRETS = {
  accountName: 'Business Checking 4827100095',
  displayName: 'Ops Account',
  orgName: 'Truist',
  cardMember: 'JANE DOE',
  accessUrl: 'https://u:sup3rsecret@bridge.simplefin.org/simplefin',
  passwordHash: '$2a$12$abcdefghijklmnopqrstuv',
  balance: 4218010,
};

function seeded() {
  const db = openDb(':memory:');
  createUser(db, 'michael', 'ownerpass1', 'owner');
  db.prepare("UPDATE users SET password_hash = ? WHERE username = 'michael'").run(SECRETS.passwordHash);
  db.prepare(`INSERT INTO accounts (id, name, display_name, org_name, kind, visibility, balance_cents, last_synced_at)
    VALUES ('CHK', ?, ?, ?, 'bank', 'company', ?, ?)`)
    .run(SECRETS.accountName, SECRETS.displayName, SECRETS.orgName, SECRETS.balance, T0);
  db.prepare(`INSERT INTO accounts (id, name, kind, visibility, hidden, balance_cents)
    VALUES ('OLD', 'Old Biz Checking', 'bank', 'company', 1, 999)`).run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('simplefin_access_url_DO_NOT', ?)").run(SECRETS.accessUrl);
  const ins = db.prepare(`INSERT INTO transactions
    (uid, sf_id, account_id, posted_at, amount_cents, description, card_member, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run('CHK|1', '1', 'CHK', T0, -21248, 'AMZN MKTP US ACCT 4827100095', SECRETS.cardMember, T0);
  ins.run('CHK|2', '2', 'CHK', T0 - 86400, -110832, 'DUKE ENERGY 8891', null, T0);
  ins.run('OLD|9', '9', 'OLD', T0, -5000, 'OLD BIZ SUPPLY CO', null, T0); // hidden account
  return db;
}

test('the request payload contains exactly the allowlisted fields and no sensitive values', () => {
  const db = seeded();
  const req = buildRequest(db, [
    { uid: 'CHK|1', posted_at: T0, amount_cents: -21248, description: 'AMZN MKTP US ACCT 4827100095', card_member: 'JANE DOE' },
  ]);

  const body = JSON.stringify(req);
  for (const [label, secret] of Object.entries(SECRETS)) {
    assert.ok(!body.includes(String(secret)), `payload leaked ${label}: ${secret}`);
  }
  // account ids and transaction uids are internal identifiers too
  assert.ok(!body.includes('CHK'), 'payload leaked an account id / uid');

  const items = req._items; // the transaction objects, exposed for this test
  assert.deepEqual(Object.keys(items[0]).sort(), [...ALLOWED_TXN_KEYS].sort());
  assert.deepEqual(items[0], {
    ref: 1, date: '2026-09-09', amount: '-212.48', text: 'AMZN MKTP US ACCT ####', cardholder: 'cardholder A',
  });
});

test('maskDigits masks long digit runs but keeps short ones', () => {
  assert.equal(maskDigits('ACCT 4827100095'), 'ACCT ####');
  assert.equal(maskDigits('UPS 1234 STORE'), 'UPS 1234 STORE');
  assert.equal(maskDigits('SQ *CAFE 88213'), 'SQ *CAFE ####');
});

test('cardholderLabels assigns stable letters and never returns real names', () => {
  const m = cardholderLabels([{ card_member: 'ZEB' }, { card_member: 'ANNA' }, { card_member: 'ZEB' }, { card_member: null }]);
  assert.equal(m.get('ANNA'), 'cardholder A');
  assert.equal(m.get('ZEB'), 'cardholder B');
  assert.equal(m.size, 2);
});

function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    messages: {
      parse: async (req) => { calls.push(req); return handler(req, calls.length); },
    },
  };
}

test('high confidence is applied as ai; lower confidence becomes a stored suggestion', async () => {
  const db = seeded();
  const client = fakeClient((req) => ({
    parsed_output: {
      results: [
        { ref: 1, category: 'Supplies', confidence: 'high', reason: 'Amazon marketplace purchase' },
        { ref: 2, category: 'Utilities', confidence: 'low', reason: 'Could be a deposit' },
      ],
    },
    usage: { input_tokens: 100, output_tokens: 20 },
  }));

  const out = await categorizeUncategorized(db, { client });
  assert.deepEqual({ applied: out.applied, suggested: out.suggested, failed: out.failed },
    { applied: 1, suggested: 1, failed: 0 });

  const supplies = db.prepare("SELECT id FROM categories WHERE name='Supplies'").get().id;
  const utilities = db.prepare("SELECT id FROM categories WHERE name='Utilities'").get().id;
  const t1 = db.prepare("SELECT * FROM transactions WHERE uid='CHK|1'").get();
  assert.equal(t1.category_id, supplies);
  assert.equal(t1.category_source, 'ai');
  assert.equal(t1.ai_confidence, 'high');
  assert.match(t1.ai_reason, /Amazon/);

  const t2 = db.prepare("SELECT * FROM transactions WHERE uid='CHK|2'").get();
  assert.equal(t2.category_id, null, 'low confidence must not be applied');
  assert.equal(t2.suggested_category_id, utilities);
  assert.match(t2.ai_reason, /deposit/);
});

test('hidden accounts are never sent', async () => {
  const db = seeded();
  const client = fakeClient(() => ({ parsed_output: { results: [] }, usage: {} }));
  await categorizeUncategorized(db, { client });
  const sent = JSON.stringify(client.calls);
  assert.ok(!sent.includes('OLD BIZ SUPPLY'), 'a hidden account transaction was sent');
});

test('manual and rule categories are left alone', async () => {
  const db = seeded();
  const other = db.prepare("SELECT id FROM categories WHERE name='Other'").get().id;
  db.prepare("UPDATE transactions SET category_id=?, category_source='manual' WHERE uid='CHK|1'").run(other);
  const client = fakeClient(() => ({ parsed_output: { results: [] }, usage: {} }));
  await categorizeUncategorized(db, { client });
  const payload = JSON.parse(client.calls[0].messages[0].content);
  assert.ok(!payload.transactions.some(t => t.text.includes('AMZN')),
    'an already-categorized transaction was sent for categorization');
  // it may still appear as guidance — that is the point of past_decisions
  assert.ok(payload.past_decisions.some(e => e.text.includes('AMZN')));
  assert.equal(db.prepare("SELECT category_source FROM transactions WHERE uid='CHK|1'").get().category_source, 'manual');
});

test('an unknown category name from the model is ignored, not applied', async () => {
  const db = seeded();
  const client = fakeClient(() => ({
    parsed_output: { results: [{ ref: 1, category: 'Cryptocurrency', confidence: 'high', reason: 'x' }] },
    usage: {},
  }));
  const out = await categorizeUncategorized(db, { client });
  assert.equal(out.applied, 0);
  assert.equal(db.prepare("SELECT category_id FROM transactions WHERE uid='CHK|1'").get().category_id, null);
});

test('API failure is contained: nothing categorized, no throw', async () => {
  const db = seeded();
  const client = fakeClient(() => { throw new Error('529 overloaded'); });
  const out = await categorizeUncategorized(db, { client });
  assert.equal(out.failed > 0, true);
  assert.equal(out.applied, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NOT NULL').get().n, 0);
});

test('parse failure (parsed_output null) is contained', async () => {
  const db = seeded();
  const client = fakeClient(() => ({ parsed_output: null, usage: {} }));
  const out = await categorizeUncategorized(db, { client });
  assert.equal(out.applied, 0);
  assert.equal(out.failed > 0, true);
});

test('examples of the owner\'s own manual categorizations are included as guidance', async () => {
  const db = seeded();
  const supplies = db.prepare("SELECT id FROM categories WHERE name='Supplies'").get().id;
  db.prepare(`INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description,
    category_id, category_source, first_seen_at) VALUES ('CHK|7','7','CHK',?,?,'HOME DEPOT #4501',?,'manual',?)`)
    .run(T0 - 200000, -8400, supplies, T0);
  const client = fakeClient(() => ({ parsed_output: { results: [] }, usage: {} }));
  await categorizeUncategorized(db, { client });
  const sent = JSON.stringify(client.calls[0]);
  assert.match(sent, /HOME DEPOT/);
  assert.match(sent, /Supplies/);
});

test('runSync runs the AI step after rules and tolerates its failure', async () => {
  const db = openDb(':memory:');
  const payload = () => ({ errors: [], accounts: [{ id: 'A1', name: 'Checking', orgName: 'Truist',
    balanceCents: 1, balanceDate: T0,
    transactions: [{ id: 't1', postedAt: T0, amountCents: -100, description: 'MYSTERY SHOP', pending: 0, cardMember: null }] }] });

  let called = 0;
  const ok = await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => payload(), now: () => T0,
    aiCategorizeFn: async () => { called++; return { applied: 1, suggested: 0, failed: 0 }; } });
  assert.equal(called, 1);
  assert.deepEqual(ok.ai, { applied: 1, suggested: 0, failed: 0 });

  const boom = await runSync(db, { accessUrl: 'x', fetchAccountsFn: async () => payload(), now: () => T0 + 10,
    aiCategorizeFn: async () => { throw new Error('nope'); } });
  assert.equal(boom.ok, true, 'AI failure must not fail the sync');
});
