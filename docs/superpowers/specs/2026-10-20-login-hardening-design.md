# Login Hardening (2FA, sessions, headers) — Spec

Stage 2 of the server hardening (Stage 0/1 notes are in CLAUDE.md). Goal: before
real bank logins are linked through Plaid, a stolen password alone must not open
the dashboard, and a stolen database copy must not yield a live session.

## Two-factor authentication (TOTP)
- **Required for every user.** After a correct password, a user without 2FA is
  confined to `/account/security` (enroll) and `/logout` until they enroll.
- RFC 6238, SHA-1, 6 digits, 30 s step, ±1 step tolerance. Implemented in
  `src/totp.js` with `node:crypto` (no dependency). A code is accepted once:
  `users.totp_last_step` rejects replays inside the window.
- The 160-bit secret is stored AES-256-GCM-encrypted with `APP_SECRET`
  (`src/crypto.js`). No `APP_SECRET` → enrollment refuses with a message.
- Enrollment: the page shows a QR code (server-rendered SVG via
  `qrcode-generator`, pure JS) plus the base32 key; the user confirms with a
  current code. Confirming enables 2FA, issues **10 recovery codes** (shown once,
  stored as SHA-256 hashes, single use) and signs out every other session.
- Login with 2FA: password success creates a **login challenge** (random token,
  cookie `mfa`, stored hashed, 5 minutes, 5 tries); `/login/2fa` accepts a TOTP
  code or a recovery code and only then creates the session. Failed codes also
  count toward the account lockout.
- Owner can regenerate recovery codes (needs a current code).
- Recovery when the authenticator is lost and the codes are gone:
  `sudo -u bankdash node bin/reset-2fa.js <user>` on the server (re-enroll next login).

## Sessions
- Cookie stores a random 256-bit token; the DB stores **SHA-256(token)**. The
  migration that introduces hashing deletes existing sessions once (everyone
  signs in again).
- Lifetime 7 days absolute, 24 hours idle (`last_seen_at`, touched at most once
  a minute). Cookie: HttpOnly, Secure (production), **SameSite=Strict**.
- `createUser` (password set/reset via CLI) deletes that user's sessions.

## Brute force and enumeration
- Account lockout unchanged (5 failures → 15 min).
- Per-client limiter: 10 failed password/code attempts per 15 minutes per client
  IP (in memory; `trust proxy` = loopback so `tailscale serve`'s
  X-Forwarded-For is used) → 429.
- Unknown usernames still run a bcrypt compare (no timing oracle).
- `[auth]` log lines for login ok / fail / locked / 2FA events, with username and
  client IP, never secrets.

## Headers and request checks (`src/security.js`)
- `X-Powered-By` off. `Content-Security-Policy`: `default-src 'self'`;
  scripts `'self'` + `https://cdn.plaid.com`; frames `https://cdn.plaid.com`;
  connect `'self'` + `https://*.plaid.com`; styles `'self' 'unsafe-inline'`
  (views use style attributes); images `'self' data:`; `frame-ancestors 'none'`;
  `form-action 'self'`; `base-uri 'none'`. Inline scripts moved to
  `public/connections.js`.
- `Strict-Transport-Security` (1 year), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, restrictive
  `Permissions-Policy`, `Cache-Control: no-store` on authenticated pages.
- State-changing requests (POST) carrying an `Origin` header that doesn't match
  the request host (or `X-Forwarded-Host`) → 403. Complements SameSite=Strict.

## Not in scope
WebAuthn/passkeys; per-user 2FA disable (2FA is mandatory); email alerts.
