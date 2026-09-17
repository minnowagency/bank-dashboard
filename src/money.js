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
