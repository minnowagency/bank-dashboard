const { toCents } = require('./money');

async function claimSetupToken(setupToken, fetchFn = fetch) {
  const claimUrl = Buffer.from(String(setupToken).trim(), 'base64').toString('utf8');
  if (!/^https:\/\//.test(claimUrl)) throw new Error('setup token did not decode to an https claim URL');
  const res = await fetchFn(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } });
  if (!res.ok) throw new Error(`claim failed: HTTP ${res.status}`);
  return (await res.text()).trim();
}

function splitAuth(accessUrl) {
  let u;
  try {
    u = new URL(accessUrl);
  } catch (err) {
    throw new Error('invalid SimpleFIN access URL');
  }
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
