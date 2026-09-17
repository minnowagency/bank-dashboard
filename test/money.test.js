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
