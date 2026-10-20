const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const auth = require('./auth');
const { verifyLogin, createSession, getSessionUser, deleteSession, SESSION_TTL_SECONDS } = auth;
const { securityHeaders, sameOriginPosts, createFailureLimiter } = require('./security');
const qrcode = require('qrcode-generator');
const { createRule, applyRulesToUncategorized } = require('./rules');
const { toCents } = require('./money');

const nowSec = () => Math.floor(Date.now() / 1000);

function createApp(db, { cookieSecure = false, plaid = null, appSecret = plaid ? plaid.appSecret : '',
  log = () => {}, limiter = createFailureLimiter() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');   // tailscale serve forwards the client IP
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(securityHeaders);
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(sameOriginPosts);
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));
  app.locals.fmtUSD = require('./money').fmtUSD;
  app.locals.senderCategoryOptions = senderCategoryOptions;
  app.locals.fmtDate = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 10);

  const cookieOpts = (maxAgeSeconds) => ({ httpOnly: true, sameSite: 'strict', secure: cookieSecure, path: '/',
    maxAge: maxAgeSeconds * 1000 });
  const TOO_MANY = 'Too many failed attempts from this device. Try again in 15 minutes.';
  const startSession = (res, user) => {
    auth.clearFailures(db, user.id);
    res.cookie('session', createSession(db, user.id, nowSec()), cookieOpts(SESSION_TTL_SECONDS));
  };

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.get('/login', (req, res) => res.render('login', { error: null }));

  app.post('/login', (req, res) => {
    const username = String(req.body.username || '');
    if (limiter.blocked(req.ip)) { log(`[auth] rate-limited ip=${req.ip}`); return res.status(429).render('login', { error: TOO_MANY }); }
    const r = verifyLogin(db, username, String(req.body.password || ''), nowSec());
    if (!r.ok) {
      limiter.fail(req.ip);
      log(`[auth] password ${r.reason} user=${JSON.stringify(username)} ip=${req.ip}`);
      const msg = r.reason === 'locked'
        ? 'Account locked for 15 minutes after too many attempts.'
        : 'Invalid username or password.';
      return res.status(401).render('login', { error: msg });
    }
    if (auth.hasTotp(r.user)) {
      res.cookie('mfa', auth.createLoginChallenge(db, r.user.id, nowSec()), cookieOpts(auth.CHALLENGE_TTL_SECONDS));
      log(`[auth] password ok, code required user=${r.user.username} ip=${req.ip}`);
      return res.redirect('/login/2fa');
    }
    // Not enrolled yet: the session is confined to the enrollment page below.
    log(`[auth] password ok, 2fa not set up user=${r.user.username} ip=${req.ip}`);
    startSession(res, r.user);
    res.redirect('/account/security');
  });

  app.get('/login/2fa', (req, res) => {
    if (!auth.getChallengeUser(db, req.cookies.mfa, nowSec())) return res.redirect('/login');
    res.render('login_2fa', { error: null });
  });

  app.post('/login/2fa', (req, res) => {
    const now = nowSec();
    if (limiter.blocked(req.ip)) { log(`[auth] rate-limited ip=${req.ip}`); return res.status(429).render('login_2fa', { error: TOO_MANY }); }
    const user = auth.getChallengeUser(db, req.cookies.mfa, now);
    if (!user) return res.status(401).render('login', { error: 'Sign-in timed out. Enter your password again.' });
    if (auth.isLocked(user, now)) {
      auth.deleteChallenge(db, req.cookies.mfa);
      return res.status(401).render('login', { error: 'Account locked for 15 minutes after too many attempts.' });
    }
    const v = auth.verifySecondFactor(db, user, req.body.code, appSecret, now);
    if (!v.ok) {
      auth.failChallenge(db, req.cookies.mfa);
      auth.recordFailure(db, user, now);
      limiter.fail(req.ip);
      log(`[auth] code failed user=${user.username} ip=${req.ip}`);
      return res.status(401).render('login_2fa', { error: 'That code didn\'t work. Try the current code from your app.' });
    }
    auth.deleteChallenge(db, req.cookies.mfa);
    res.clearCookie('mfa', { path: '/' });
    log(`[auth] login ok method=${v.method} user=${user.username} ip=${req.ip}`);
    startSession(res, user);
    res.redirect(v.method === 'recovery' ? '/account/security?used=recovery' : '/');
  });

  // Everything below requires auth
  app.use((req, res, next) => {
    const user = getSessionUser(db, req.cookies.session, nowSec());
    if (!user) return res.redirect('/login');
    req.user = user;
    res.locals.user = user;
    // Two-factor is mandatory: until it's set up, only enrollment and sign-out work.
    if (!auth.hasTotp(user) && !req.path.startsWith('/account/security') && req.path !== '/logout') {
      return res.redirect('/account/security');
    }
    next();
  });

  app.post('/logout', (req, res) => {
    deleteSession(db, req.cookies.session);
    res.clearCookie('session', { path: '/' });
    res.redirect('/login');
  });

  registerSecurityRoutes(app, db, { appSecret, log });
  registerRoutes(app, db, plaid);
  return app;
}

const { feedQuery, totals, visibleAccounts, periodSummary, groupByDay } = require('./feed');
const { forecast } = require('./recurring');
const { applySenders, annotateSenders, unlabeledSenders, senderCategoryOptions } = require('./senders');
const { addItem, accessTokenFor } = require('./plaid');

function reviewCount(db, user) {
  const ids = visibleAccounts(db, user).map(a => a.id);
  if (ids.length === 0) return 0;
  return db.prepare(`SELECT COUNT(*) AS n FROM transactions
    WHERE category_id IS NULL AND account_id IN (${ids.map(() => '?').join(',')})`).get(...ids).n;
}

function staleness(db, user) {
  const nowS = Math.floor(Date.now() / 1000);
  const stale = visibleAccounts(db, user)
    .filter(a => !a.last_synced_at || a.last_synced_at < nowS - 86400);
  let errors = [];
  const row = db.prepare("SELECT value FROM settings WHERE key='sync_errors'").get();
  if (row) { try { errors = JSON.parse(row.value); } catch { errors = []; } }
  return { stale, errors };
}

// AI categorization defaults to on; the owner can switch it off from /rules.
function aiEnabled(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key='ai_enabled'").get();
  return !row || row.value === '1';
}

// /account/security: enroll an authenticator app, and later regenerate recovery codes.
function registerSecurityRoutes(app, db, { appSecret, log }) {
  const qrSvg = (text) => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 5, margin: 4, scalable: true }); };
  const page = (req, res, extra = {}) => {
    const user = req.user;
    const base = { title: 'Security', active: 'security', error: null, recoveryCodes: null,
      usedRecovery: req.query.used === 'recovery', enrolled: auth.hasTotp(user), ...extra };
    if (base.enrolled) return res.render('security', { ...base, unusedCodes: auth.unusedRecoveryCount(db, user.id) });
    if (!appSecret) return res.status(503).render('security', { ...base, error: 'Two-factor setup needs APP_SECRET in the server\'s .env. Run bank-set-plaid-keys (or ask Claude) and restart.' });
    const secret = auth.startTotpEnrollment(db, user, appSecret);
    res.render('security', { ...base, secret: secret.replace(/(.{4})/g, '$1 ').trim(), qr: qrSvg(auth.enrollmentUri(user, secret)) });
  };

  app.get('/account/security', (req, res) => page(req, res));

  app.post('/account/security/enable', (req, res) => {
    if (auth.hasTotp(req.user) || !appSecret) return res.redirect('/account/security');
    const fresh = { ...db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id) };
    const r = auth.confirmTotpEnrollment(db, fresh, req.body.code, appSecret, Math.floor(Date.now() / 1000));
    if (!r.ok) { res.status(400); return page(req, res, { error: 'That code didn\'t match. Check the time on your phone and enter the current code.' }); }
    auth.deleteOtherSessions(db, req.user.id, req.cookies.session);
    log(`[auth] 2fa enabled user=${req.user.username}`);
    req.user = { ...db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id) };
    page(req, res, { recoveryCodes: r.recoveryCodes });
  });

  app.post('/account/security/recovery-codes', (req, res) => {
    const v = auth.verifySecondFactor(db, req.user, req.body.code, appSecret, Math.floor(Date.now() / 1000));
    if (!v.ok) { res.status(400); return page(req, res, { error: 'That code didn\'t work.' }); }
    const codes = auth.regenerateRecoveryCodes(db, req.user.id);
    log(`[auth] recovery codes regenerated user=${req.user.username}`);
    page(req, res, { recoveryCodes: codes });
  });
}

function registerRoutes(app, db, plaid) {
  function visibleTxn(db, user, uid) {
    const t = db.prepare(`SELECT t.*, a.visibility, a.hidden FROM transactions t
      JOIN accounts a ON a.id = t.account_id WHERE t.uid = ?`).get(uid);
    if (!t || t.hidden) return null;
    if (user.role !== 'owner' && t.visibility !== 'company') return null;
    return t;
  }
  function validateCategoryId(db, cid) {
    if (!Number.isInteger(cid)) return false;
    return db.prepare('SELECT id FROM categories WHERE id = ?').get(cid) != null;
  }
  const wantsJson = (req) => String(req.get('accept') || '').includes('application/json');
  const back = (req, res) => {
    const ref = req.get('referer');
    if (!ref) return res.redirect('/');
    try {
      const parsed = new URL(ref);
      if (parsed.host === req.get('host')) {
        const pathname = parsed.pathname + parsed.search;
        if (pathname.startsWith('//')) return res.redirect('/');
        return res.redirect(pathname);
      }
    } catch (e) {
      // ignore parse errors, fall through to default
    }
    res.redirect('/');
  };

  const ownerOnly = (req, res, next) => req.user.role === 'owner' ? next() : res.status(404).send('Not found');

  app.post('/txns/:uid/category', (req, res) => {
    const t = visibleTxn(db, req.user, req.params.uid);
    if (!t) return res.status(404).send('Not found');
    const cid = req.body.category_id ? Number(req.body.category_id) : null;
    if (cid === null) {
      db.prepare(`UPDATE transactions SET category_id=NULL, category_source=NULL,
                  categorized_by=NULL, rule_id=NULL, suggested_category_id=NULL WHERE uid=?`).run(t.uid);
    } else {
      if (!validateCategoryId(db, cid)) return res.status(400).send('Unknown category');
      db.prepare(`UPDATE transactions SET category_id=?, category_source='manual',
                  categorized_by=?, rule_id=NULL, suggested_category_id=NULL WHERE uid=?`)
        .run(cid, req.user.id, t.uid);
    }
    if (wantsJson(req)) {
      const name = cid ? db.prepare('SELECT name FROM categories WHERE id=?').get(cid).name : null;
      return res.json({ ok: true, uid: t.uid, category_id: cid, category_name: name });
    }
    back(req, res);
  });

  app.post('/txns/:uid/note', (req, res) => {
    const t = visibleTxn(db, req.user, req.params.uid);
    if (!t) return res.status(404).send('Not found');
    const note = String(req.body.note || '').trim();
    db.prepare('UPDATE transactions SET note=?, note_by=? WHERE uid=?')
      .run(note || null, note ? req.user.id : null, t.uid);
    back(req, res);
  });

  app.post('/txns/:uid/make-rule', (req, res) => {
    const t = visibleTxn(db, req.user, req.params.uid);
    if (!t) return res.status(404).send('Not found');
    const categoryId = Number(req.body.category_id);
    const pattern = String(req.body.pattern || '').trim();
    if (!pattern) return res.status(400).send('Pattern required');
    if (!validateCategoryId(db, categoryId)) return res.status(400).send('Unknown category');
    createRule(db, { pattern, categoryId, ownerOnly: t.visibility === 'private', createdBy: req.user.id });
    db.prepare(`UPDATE transactions SET category_id=?, category_source='manual',
                categorized_by=?, rule_id=NULL WHERE uid=?`).run(categoryId, req.user.id, t.uid);
    back(req, res);
  });

  app.post('/txns/bulk-category', (req, res) => {
    const cid = Number(req.body.category_id);
    if (!validateCategoryId(db, cid)) return res.status(400).send('Unknown category');
    const uids = [].concat(req.body.uids || []).map(String);
    const set = db.prepare(`UPDATE transactions SET category_id=?, category_source='manual',
      categorized_by=?, rule_id=NULL, suggested_category_id=NULL WHERE uid=? AND category_id IS NULL`);
    let applied = 0;
    db.transaction(() => {
      for (const uid of uids) {
        // rows this user cannot see are skipped silently, never an error
        if (visibleTxn(db, req.user, uid) && set.run(cid, req.user.id, uid).changes) applied++;
      }
    })();
    if (wantsJson(req)) return res.json({ ok: true, applied });
    back(req, res);
  });

  app.get('/review', (req, res) => {
    const ids = visibleAccounts(db, req.user).map(a => a.id);
    const rows = ids.length === 0 ? [] : db.prepare(`
      SELECT t.*, COALESCE(a.display_name, a.name) AS account_name
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.category_id IS NULL AND t.account_id IN (${ids.map(() => '?').join(',')})
      ORDER BY t.posted_at ASC LIMIT 200`).all(...ids);
    const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
    res.render('review', { title: 'Review', rows, categories, reviewCount: rows.length, active: 'review' });
  });

  // Plaid Liabilities data for the card tiles: what's due, by when, and
  // whether a payment has landed since the statement closed.
  function withStatements(db, cards, now) {
    const get = db.prepare('SELECT * FROM card_statements WHERE account_id = ?');
    return cards.map(a => {
      const s = get.get(a.id);
      if (!s) return a;
      const paid = Boolean(s.last_payment_date && s.statement_date && s.last_payment_date >= s.statement_date && s.last_payment_cents > 0);
      const owing = !paid && (s.minimum_payment_cents || 0) > 0;
      return { ...a, statement: { ...s, paid,
        overdue: Boolean(s.is_overdue) && !paid,
        dueSoon: owing && s.due_date != null && s.due_date - now <= 5 * 86400 } };
    });
  }

  app.get('/', (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const { rows, accounts, categories, members, period } = feedQuery(db, req.user, req.query, { now });
    annotateSenders(db, rows);
    const view = {
      title: 'Overview',
      rows, accounts, categories, members, period,
      groups: groupByDay(rows, now),
      summary: periodSummary(db, req.user, req.query, now),
      banks: accounts.filter(a => a.kind === 'bank'),
      credits: withStatements(db, accounts.filter(a => a.kind === 'credit'), now),
      totals: totals(db, req.user),
      filters: req.query,
      reviewCount: reviewCount(db, req.user),
      staleness: staleness(db, req.user),
    };
    // The client script refetches this same URL with partial=1 and swaps the
    // fragment in; everything still works as a full page load without it.
    if (req.query.partial === '1') return res.render('_overview', view);
    res.render('dashboard', view);
  });

  function rulesFor(db, user) {
    const sql = user.role === 'owner'
      ? 'SELECT * FROM rules ORDER BY position ASC, id ASC'
      : 'SELECT * FROM rules WHERE owner_only = 0 ORDER BY position ASC, id ASC';
    return db.prepare(sql).all();
  }

  app.get('/rules', (req, res) => {
    const visAccts = visibleAccounts(db, req.user);
    const ids = visAccts.map(a => a.id);
    const countStmt = ids.length === 0 ? null : db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE rule_id = ? AND account_id IN (${ids.map(() => '?').join(',')})`);
    const rules = rulesFor(db, req.user).map(r => ({
      ...r, matches: countStmt ? countStmt.get(r.id, ...ids).n : 0,
      category_name: db.prepare('SELECT name FROM categories WHERE id=?').get(r.category_id).name,
      account_name: r.account_id && ids.includes(r.account_id)
        ? (db.prepare('SELECT COALESCE(display_name, name) AS n FROM accounts WHERE id=?').get(r.account_id) || {}).n
        : null,
    }));
    const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
    const senders = ids.length === 0 ? [] : db.prepare(`SELECT s.*, c.name AS category_name,
        COALESCE(a.display_name, a.name) AS account_name
      FROM senders s JOIN categories c ON c.id = s.category_id JOIN accounts a ON a.id = s.account_id
      WHERE s.account_id IN (${ids.map(() => '?').join(',')}) ORDER BY s.name, account_name`).all(...ids);
    res.render('rules', { title: 'Rules', rules, categories, senders, unlabeled: unlabeledSenders(db, ids),
      accounts: visAccts, aiOn: aiEnabled(db), reviewCount: reviewCount(db, req.user), active: 'rules' });
  });

  app.post('/rules', (req, res) => {
    const pattern = String(req.body.pattern || '').trim();
    const categoryId = Number(req.body.category_id);
    if (!pattern || !categoryId) return res.status(400).send('Pattern and category required');
    if (!validateCategoryId(db, categoryId)) return res.status(400).send('Unknown category');
    let amountCents = null;
    if (req.body.amount && String(req.body.amount).trim()) {
      try { amountCents = toCents(req.body.amount); } catch { return res.status(400).send('Bad amount'); }
    }
    const visIds = visibleAccounts(db, req.user).map(a => a.id);
    const accountId = req.body.account_id && visIds.includes(req.body.account_id) ? req.body.account_id : null;
    // if account is private, force owner_only=1
    let ownerOnly = req.user.role === 'owner' && !!req.body.owner_only;
    if (accountId) {
      const acct = db.prepare('SELECT visibility FROM accounts WHERE id = ?').get(accountId);
      if (acct && acct.visibility === 'private') ownerOnly = true;
    }
    createRule(db, { pattern, accountId, amountCents, categoryId,
      ownerOnly, createdBy: req.user.id });
    res.redirect('/rules');
  });

  function visibleRule(db, user, id) {
    const r = db.prepare('SELECT * FROM rules WHERE id = ?').get(Number(id));
    if (!r) return null;
    if (user.role !== 'owner' && r.owner_only) return null;
    return r;
  }

  app.post('/rules/:id/edit', (req, res) => {
    const r = visibleRule(db, req.user, req.params.id);
    if (!r) return res.status(404).send('Not found');
    const pattern = String(req.body.pattern || '').trim();
    const categoryId = Number(req.body.category_id);
    if (!pattern || !categoryId) return res.status(400).send('Pattern and category required');
    if (!validateCategoryId(db, categoryId)) return res.status(400).send('Unknown category');
    let amountCents = null;
    if (req.body.amount && String(req.body.amount).trim()) {
      try { amountCents = toCents(req.body.amount); } catch { return res.status(400).send('Bad amount'); }
    }
    const visIds = visibleAccounts(db, req.user).map(a => a.id);
    const submitted = req.body.account_id;
    let accountId;
    if (submitted && visIds.includes(submitted)) {
      // explicit, visible choice: always honored, regardless of role
      accountId = submitted;
    } else if (req.user.role === 'owner' && (!r.account_id || visIds.includes(r.account_id))) {
      // the owner's form shows the rule's current account, so a blank
      // submission is an explicit "clear to any" — unless that account is
      // hidden and therefore absent from the form's options
      accountId = null;
    } else {
      // members can't see (or select) a private account_id, so a blank
      // submission from a member's form must NOT silently un-scope a rule
      // that already carries a private/invisible account_id
      accountId = r.account_id;
    }
    // identity, position, owner_only, and created_by stay unchanged, except: a
    // private account_id always forces owner_only=1 (same leak rule as creation)
    let ownerOnly = r.owner_only;
    if (accountId) {
      const acct = db.prepare('SELECT visibility FROM accounts WHERE id = ?').get(accountId);
      if (acct && acct.visibility === 'private') ownerOnly = 1;
    }
    db.prepare(`UPDATE rules SET pattern = ?, account_id = ?, amount_cents = ?, category_id = ?, owner_only = ?
                WHERE id = ?`).run(pattern, accountId, amountCents, categoryId, ownerOnly ? 1 : 0, r.id);
    applyRulesToUncategorized(db);
    res.redirect('/rules');
  });

  app.post('/rules/:id/delete', (req, res) => {
    const r = visibleRule(db, req.user, req.params.id);
    if (!r) return res.status(404).send('Not found');
    db.prepare('DELETE FROM rules WHERE id = ?').run(r.id);
    res.redirect('/rules');
  });

  app.post('/rules/:id/move', ownerOnly, (req, res) => {
    const r = db.prepare('SELECT * FROM rules WHERE id = ?').get(Number(req.params.id));
    if (!r) return res.status(404).send('Not found');
    const list = db.prepare('SELECT * FROM rules ORDER BY position ASC, id ASC').all();
    const i = list.findIndex(x => x.id === r.id);
    const j = req.body.dir === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < list.length) {
      const swap = db.prepare('UPDATE rules SET position = ? WHERE id = ?');
      db.transaction(() => {
        swap.run(list[j].position, list[i].id);
        swap.run(list[i].position, list[j].id);
      })();
      applyRulesToUncategorized(db);
    }
    res.redirect('/rules');
  });

  app.post('/categories', (req, res) => {
    const name = String(req.body.name || '').trim();
    if (name) db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(name);
    res.redirect('/rules');
  });

  app.post('/categories/:id/rename', (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.redirect('/rules');
    const clash = db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').get(name, Number(req.params.id));
    if (clash) return res.status(400).send('Category name already in use');
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, Number(req.params.id));
    res.redirect('/rules');
  });

  app.post('/settings/ai', ownerOnly, (req, res) => {
    const value = req.body.enabled === '1' ? '1' : '0';
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_enabled', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
    res.redirect('/rules');
  });

  app.get('/accounts', ownerOnly, (req, res) => {
    const accounts = db.prepare('SELECT * FROM accounts ORDER BY kind, COALESCE(display_name, name)').all();
    res.render('accounts', { title: 'Accounts', accounts, reviewCount: reviewCount(db, req.user), active: 'accounts' });
  });

  app.post('/accounts/:id', ownerOnly, (req, res) => {
    const vis = req.body.visibility;
    const kind = req.body.kind;
    if (!['company', 'private'].includes(vis)) return res.status(400).send('Invalid visibility');
    if (!['bank', 'credit'].includes(kind)) return res.status(400).send('Invalid kind');
    const dn = String(req.body.display_name || '').trim() || null;
    const hidden = req.body.hidden === '1' ? 1 : 0;
    db.prepare('UPDATE accounts SET display_name = ?, visibility = ?, kind = ?, hidden = ? WHERE id = ?')
      .run(dn, vis, kind, hidden, req.params.id);
    res.redirect('/accounts');
  });

  // ---- Sender labels ----------------------------------------------------
  app.post('/senders', (req, res) => {
    const last4 = String(req.body.last4 || '').trim();
    const accountId = String(req.body.account_id || '').trim();
    const name = String(req.body.name || '').trim();
    const cid = Number(req.body.category_id);
    if (!/^\d{4}$/.test(last4) || !name) return res.status(400).send('Sender account digits and a name are required');
    if (!validateCategoryId(db, cid)) return res.status(400).send('Unknown category');
    // the receiving account must be one this user can see
    if (!visibleAccounts(db, req.user).some(a => a.id === accountId)) return res.status(404).send('Not found');
    db.prepare(`INSERT INTO senders (last4, account_id, name, category_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(last4, account_id) DO UPDATE SET name = excluded.name, category_id = excluded.category_id`)
      .run(last4, accountId, name, cid, req.user.id, Math.floor(Date.now() / 1000));
    // a relabel must move rows this pair already categorized, too
    db.prepare(`UPDATE transactions SET category_id = NULL, category_source = NULL
      WHERE category_source = 'rule' AND rule_id IS NULL AND amount_cents > 0 AND account_id = ? AND category_id != ?
        AND (description LIKE ? OR description LIKE ?)`).run(accountId, cid, `%ACCT: %${last4}%`, `%FROM *${last4}%`);
    applySenders(db);
    back(req, res);
  });

  app.post('/senders/:last4/:account/delete', (req, res) => {
    const accountId = String(req.params.account);
    if (!visibleAccounts(db, req.user).some(a => a.id === accountId)) return res.status(404).send('Not found');
    db.prepare('DELETE FROM senders WHERE last4 = ? AND account_id = ?').run(String(req.params.last4), accountId);
    res.redirect('/rules');
  });

  // ---- Recurring items and the forecast --------------------------------
  const CADENCES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
  function visibleItem(db, user, id) {
    const r = db.prepare('SELECT * FROM recurring_items WHERE id = ?').get(Number(id));
    if (!r) return null;
    return visibleAccounts(db, user).some(a => a.id === r.account_id) ? r : null;
  }
  function parseAmount(raw) {
    try { const c = toCents(String(raw)); return Number.isFinite(c) && c > 0 ? c : null; } catch { return null; }
  }

  app.get('/recurring', (req, res) => {
    const accounts = visibleAccounts(db, req.user);
    const ids = accounts.map(a => a.id);
    const rows = ids.length === 0 ? [] : db.prepare(`
      SELECT r.*, COALESCE(a.display_name, a.name) AS account_name
      FROM recurring_items r JOIN accounts a ON a.id = r.account_id
      WHERE r.account_id IN (${ids.map(() => '?').join(',')})
      ORDER BY r.kind, r.next_due`).all(...ids)
      .map(r => ({ ...r, evidence: JSON.parse(r.evidence || '[]') }));
    res.render('recurring', {
      title: 'Recurring', active: 'recurring', accounts, cadences: CADENCES,
      candidates: rows.filter(r => r.status === 'candidate'),
      active_items: rows.filter(r => r.status === 'confirmed' || r.status === 'manual'),
      dismissed: rows.filter(r => r.status === 'dismissed'),
      reviewCount: reviewCount(db, req.user),
    });
  });

  app.post('/recurring', (req, res) => {
    const accountId = String(req.body.account_id || '');
    if (!visibleAccounts(db, req.user).some(a => a.id === accountId)) return res.status(404).send('Not found');
    const name = String(req.body.display_name || '').trim();
    const kind = req.body.kind === 'income' ? 'income' : 'expense';
    const cadence = CADENCES.includes(req.body.cadence) ? req.body.cadence : null;
    const cents = parseAmount(req.body.amount);
    let nextDue = null;
    try { nextDue = require('./money').toEpochDay(String(req.body.next_due || '')) + 12 * 3600; } catch { nextDue = null; }
    if (!name || !cadence || !cents || !nextDue) return res.status(400).send('Name, cadence, amount and next date are required');
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO recurring_items (account_id, merchant_key, display_name, kind, cadence, amount_cents,
      amount_min_cents, amount_max_cents, last_seen, next_due, status, evidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'manual', '[]', ?, ?)`)
      .run(accountId, `MANUAL:${name.toUpperCase()}:${now}`, name, kind, cadence, cents, cents, cents, nextDue, now, now);
    res.redirect('/recurring');
  });

  for (const [action, status] of [['confirm', 'confirmed'], ['dismiss', 'dismissed']]) {
    app.post(`/recurring/:id/${action}`, (req, res) => {
      const r = visibleItem(db, req.user, req.params.id);
      if (!r) return res.status(404).send('Not found');
      db.prepare('UPDATE recurring_items SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Math.floor(Date.now() / 1000), r.id);
      res.redirect('/recurring');
    });
  }

  app.post('/recurring/:id/edit', (req, res) => {
    const r = visibleItem(db, req.user, req.params.id);
    if (!r) return res.status(404).send('Not found');
    const name = String(req.body.display_name || '').trim() || r.display_name;
    const cadence = CADENCES.includes(req.body.cadence) ? req.body.cadence : r.cadence;
    const cents = parseAmount(req.body.amount);
    if (!cents) return res.status(400).send('Bad amount');
    db.prepare(`UPDATE recurring_items SET display_name = ?, cadence = ?, amount_cents = ?, updated_at = ? WHERE id = ?`)
      .run(name, cadence, cents, Math.floor(Date.now() / 1000), r.id);
    res.redirect('/recurring');
  });

  app.post('/recurring/:id/delete', (req, res) => {
    const r = visibleItem(db, req.user, req.params.id);
    if (!r) return res.status(404).send('Not found');
    db.prepare('DELETE FROM recurring_items WHERE id = ?').run(r.id);
    res.redirect('/recurring');
  });

  app.get('/forecast', (req, res) => {
    const accountId = String(req.query.account || '') || null;
    const f = forecast(db, req.user, { accountId, weeks: 8 });
    res.render('forecast', {
      title: 'Forecast', active: 'forecast', f, accounts: visibleAccounts(db, req.user),
      selected: accountId, reviewCount: reviewCount(db, req.user),
    });
  });

  // ---- Vendor invoices (owner and member, on accounts they can see) -------
  const invoices = require('./invoices');
  const invoicePage = (req, res, { error = null, status = 200 } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const accounts = visibleAccounts(db, req.user);
    const ids = accounts.map(a => a.id);
    const recurring = ids.length === 0 ? [] : db.prepare(`SELECT r.id, r.display_name, r.account_id FROM recurring_items r
      WHERE r.status IN ('confirmed','manual') AND r.account_id IN (${ids.map(() => '?').join(',')})
      ORDER BY r.display_name`).all(...ids);
    const list = invoices.listInvoices(db, req.user, now);
    const totals = {};
    for (const i of list.open) totals[i.account_name] = (totals[i.account_name] || 0) + i.amount_cents;
    res.status(status).render('invoices', { title: 'Invoices', active: 'invoices', reviewCount: reviewCount(db, req.user),
      ...list, totals, accounts, recurring, error, form: error ? req.body : {} });
  };

  app.get('/invoices', (req, res) => invoicePage(req, res));

  app.post('/invoices', (req, res) => {
    try { invoices.saveInvoice(db, req.user, req.body, Math.floor(Date.now() / 1000)); }
    catch (err) { return invoicePage(req, res, { error: err.message, status: 400 }); }
    res.redirect('/invoices');
  });

  app.post('/invoices/:id/edit', (req, res) => {
    if (!invoices.getInvoice(db, req.user, req.params.id)) return res.status(404).send('Not found');
    try { invoices.saveInvoice(db, req.user, { ...req.body, id: req.params.id }, Math.floor(Date.now() / 1000)); }
    catch (err) { return invoicePage(req, res, { error: err.message, status: 400 }); }
    res.redirect('/invoices');
  });

  for (const [action, status] of [['paid', 'paid'], ['void', 'void'], ['reopen', 'open']]) {
    app.post(`/invoices/:id/${action}`, (req, res) => {
      if (!invoices.setStatus(db, req.user, req.params.id, status, Math.floor(Date.now() / 1000))) return res.status(404).send('Not found');
      res.redirect('/invoices');
    });
  }

  app.post('/invoices/:id/not-this-payment', (req, res) => {
    if (!invoices.rejectMatch(db, req.user, req.params.id)) return res.status(404).send('Not found');
    res.redirect('/invoices');
  });

  app.post('/vendors', (req, res) => {
    const accountId = String(req.body.account_id || '') || null;
    if (accountId && !visibleAccounts(db, req.user).some(a => a.id === accountId)) return res.status(404).send('Not found');
    const id = req.body.id ? Number(req.body.id) : null;
    if (id && !invoices.listInvoices(db, req.user, 0).vendors.some(v => v.id === id)) return res.status(404).send('Not found');
    try { invoices.saveVendor(db, { id, name: req.body.name, terms_days: req.body.terms_days, account_id: accountId }, Math.floor(Date.now() / 1000), req.user.id); }
    catch (err) { return invoicePage(req, res, { error: err.message, status: 400 }); }
    res.redirect('/invoices');
  });

  // ---- Plaid connections (owner only) -------------------------------------
  app.use('/connections', ownerOnly, express.json());
  const plaidReady = !!(plaid && plaid.client && plaid.appSecret);

  app.get('/connections', (req, res) => {
    const items = db.prepare('SELECT * FROM plaid_items ORDER BY id').all()
      .map(it => ({ ...it, accounts: accountsForItem(db, it) }));
    res.render('connections', { title: 'Connections', active: 'connections', items, plaidReady,
      reviewCount: reviewCount(db, req.user) });
  });

  function accountsForItem(db, item) {
    const ids = JSON.parse(item.account_ids || '[]');
    if (ids.length === 0) return [];
    return db.prepare(`SELECT display_name, name, kind FROM accounts WHERE source_account_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  }

  app.post('/connections/link-token', async (req, res) => {
    if (!plaidReady) return res.status(503).json({ error: 'Plaid is not configured' });
    try {
      const body = { user: { client_user_id: `owner-${req.user.id}` }, client_name: 'Bank Dashboard',
        country_codes: ['US'], language: 'en' };
      const itemId = req.body && req.body.item_id ? Number(req.body.item_id) : null;
      if (itemId) {
        const item = db.prepare('SELECT * FROM plaid_items WHERE id = ?').get(itemId);
        if (!item) return res.status(404).json({ error: 'Unknown connection' });
        body.access_token = accessTokenFor(db, item, plaid.appSecret); // update mode: re-authenticate
        // ...or consent to statement details (Plaid Liabilities) on this login
        if (req.body.add === 'liabilities') body.additional_consented_products = ['liabilities'];
      } else {
        body.products = ['transactions'];
        body.transactions = { days_requested: 730 };
      }
      const r = await plaid.client.linkTokenCreate(body);
      res.json({ link_token: r.data.link_token });
    } catch (err) {
      res.status(502).json({ error: plaidMessage(err) });
    }
  });

  app.post('/connections/exchange', async (req, res) => {
    if (!plaidReady) return res.status(503).json({ error: 'Plaid is not configured' });
    const publicToken = req.body && req.body.public_token;
    if (!publicToken) return res.status(400).json({ error: 'public_token required' });
    try {
      const existing = req.body.item_id ? db.prepare('SELECT * FROM plaid_items WHERE id = ?').get(Number(req.body.item_id)) : null;
      if (existing) {
        // update mode: the item keeps its token; just clear the error
        db.prepare("UPDATE plaid_items SET status = 'ok', error = NULL WHERE id = ?").run(existing.id);
        if (req.body.add === 'liabilities') {
          db.prepare(`UPDATE plaid_items SET liabilities = 'on', liabilities_fetched_at = NULL, liabilities_error = NULL
            WHERE id = ?`).run(existing.id);
        }
      } else {
        const r = await plaid.client.itemPublicTokenExchange({ public_token: publicToken });
        addItem(db, { itemId: r.data.item_id, accessToken: r.data.access_token,
          institutionName: req.body.institution_name || null, now: Math.floor(Date.now() / 1000) }, plaid.appSecret);
      }
      if (plaid.syncNow) plaid.syncNow().catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: plaidMessage(err) });
    }
  });

  app.post('/connections/:id/delete', async (req, res) => {
    const item = db.prepare('SELECT * FROM plaid_items WHERE id = ?').get(Number(req.params.id));
    if (!item) return res.status(404).send('Not found');
    if (plaidReady) {
      try { await plaid.client.itemRemove({ access_token: accessTokenFor(db, item, plaid.appSecret) }); }
      catch (err) { /* already gone at Plaid, or Plaid down: still remove locally */ }
    }
    db.prepare('DELETE FROM plaid_items WHERE id = ?').run(item.id);
    res.redirect('/connections');
  });

  function plaidMessage(err) {
    const d = err && err.response && err.response.data;
    return d && d.error_message ? `${d.error_code}: ${d.error_message}` : String((err && err.message) || err);
  }

  app.get('/export.csv', (req, res) => {
    const { rows } = feedQuery(db, req.user, req.query, { limit: 0 });
    const esc = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const cents = (c) => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
    const header = 'date,description,account,card_member,category,amount,pending,note';
    const lines = rows.map(t => [
      new Date(t.posted_at * 1000).toISOString().slice(0, 10),
      esc(t.description), esc(t.account_name), esc(t.card_member),
      esc(t.category_name), cents(t.amount_cents), t.pending ? '1' : '0', esc(t.note),
    ].join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
    res.send([header, ...lines].join('\n') + '\n');
  });
}

module.exports = { createApp, aiEnabled };
