// Response headers, cross-origin POST refusal, and a failed-attempt limiter
// for the sign-in forms. Plaid Link is the only third-party origin the pages use.

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.plaid.com",
  "frame-src https://cdn.plaid.com",
  "connect-src 'self' https://*.plaid.com",
  "style-src 'self' 'unsafe-inline'",   // views use style attributes
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  });
  if (!req.path.startsWith('/static/')) res.set('Cache-Control', 'no-store');
  next();
}

// A browser sends Origin on every cross-site POST; SameSite=Strict already
// withholds the cookie, this refuses the request outright as well.
function sameOriginPosts(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let host;
  try { host = new URL(origin).host; } catch { return res.status(403).send('Forbidden'); }
  const allowed = [req.get('host'), req.get('x-forwarded-host')].filter(Boolean);
  if (allowed.includes(host)) return next();
  return res.status(403).send('Forbidden');
}

// Counts failures per client IP in a sliding window. In memory: a restart
// clears it, which is fine next to the per-account lockout stored in the DB.
function createFailureLimiter({ max = 10, windowSeconds = 15 * 60, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const hits = new Map();
  const prune = (ip, t) => {
    const list = (hits.get(ip) || []).filter(x => x > t - windowSeconds);
    if (list.length) hits.set(ip, list); else hits.delete(ip);
    return list;
  };
  return {
    blocked: (ip) => prune(ip, now()).length >= max,
    fail: (ip) => { const t = now(); hits.set(ip, [...prune(ip, t), t]); },
  };
}

module.exports = { securityHeaders, sameOriginPosts, createFailureLimiter, CSP };
