const test = require('node:test');
const assert = require('node:assert/strict');
const { startScheduler } = require('../src/scheduler');

test('scheduler: immediate run, interval on success, backoff doubling on failure, reset after success', async () => {
  const delays = [];
  const timers = [];
  const setTimeoutFn = (fn, ms) => { delays.push(ms); timers.push(fn); return delays.length; };
  const results = [{ ok: true }, { ok: false }, { ok: false }, { ok: false }, { ok: true }, { ok: true }];
  let calls = 0;
  const run = async () => results[calls++];

  const s = startScheduler({ run, intervalMs: 1000, retryMs: 100, maxRetryMs: 250, setTimeoutFn });
  // allow each chained run to settle
  for (let i = 0; i < results.length - 1; i++) {
    await new Promise(r => setImmediate(r));
    timers[i]();               // fire the most recently scheduled timer
  }
  await new Promise(r => setImmediate(r));
  assert.equal(calls, results.length);
  assert.deepEqual(delays, [1000, 100, 200, 250, 1000, 1000]);
  s.stop();
});
