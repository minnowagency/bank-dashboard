function startScheduler({ run, intervalMs = 4 * 3600 * 1000, retryMs = 15 * 60 * 1000,
                          maxRetryMs = 2 * 3600 * 1000, setTimeoutFn = setTimeout }) {
  let stopped = false;
  let backoff = retryMs;
  async function tick() {
    if (stopped) return;
    let ok = false;
    try { ok = (await run()).ok; } catch { ok = false; }
    if (stopped) return;
    if (ok) {
      backoff = retryMs;
      setTimeoutFn(tick, intervalMs);
    } else {
      setTimeoutFn(tick, backoff);
      backoff = Math.min(backoff * 2, maxRetryMs);
    }
  }
  tick();
  return { stop: () => { stopped = true; } };
}

module.exports = { startScheduler };
