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
