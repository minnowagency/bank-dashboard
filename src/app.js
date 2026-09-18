const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { verifyLogin, createSession, getSessionUser, deleteSession, SESSION_TTL_SECONDS } = require('./auth');
const { createRule, applyRulesToUncategorized } = require('./rules');
const { toCents } = require('./money');

const nowSec = () => Math.floor(Date.now() / 1000);

function createApp(db, { cookieSecure = false } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));
  app.locals.fmtUSD = require('./money').fmtUSD;
  app.locals.fmtDate = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 10);

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.get('/login', (req, res) => res.render('login', { error: null }));

  app.post('/login', (req, res) => {
    const r = verifyLogin(db, String(req.body.username || ''), String(req.body.password || ''), nowSec());
    if (!r.ok) {
      const msg = r.reason === 'locked'
        ? 'Account locked for 15 minutes after too many attempts.'
        : 'Invalid username or password.';
      return res.status(401).render('login', { error: msg });
    }
    const token = createSession(db, r.user.id, nowSec());
    res.cookie('session', token, {
      httpOnly: true, sameSite: 'lax', secure: cookieSecure, maxAge: SESSION_TTL_SECONDS * 1000,
    });
    res.redirect('/');
  });

  // Everything below requires auth
  app.use((req, res, next) => {
    const user = getSessionUser(db, req.cookies.session, nowSec());
    if (!user) return res.redirect('/login');
    req.user = user;
    res.locals.user = user;
    next();
  });

  app.post('/logout', (req, res) => {
    deleteSession(db, req.cookies.session);
    res.clearCookie('session');
    res.redirect('/login');
  });

  registerRoutes(app, db); // dashboard, txns, review, rules, accounts, export (Tasks 10-13)
  return app;
}

const { feedQuery, totals, visibleAccounts } = require('./feed');

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

function registerRoutes(app, db) {
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
                  categorized_by=NULL, rule_id=NULL WHERE uid=?`).run(t.uid);
    } else {
      if (!validateCategoryId(db, cid)) return res.status(400).send('Unknown category');
      db.prepare(`UPDATE transactions SET category_id=?, category_source='manual',
                  categorized_by=?, rule_id=NULL WHERE uid=?`).run(cid, req.user.id, t.uid);
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

  app.get('/review', (req, res) => {
    const ids = visibleAccounts(db, req.user).map(a => a.id);
    const rows = ids.length === 0 ? [] : db.prepare(`
      SELECT t.*, COALESCE(a.display_name, a.name) AS account_name
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.category_id IS NULL AND t.account_id IN (${ids.map(() => '?').join(',')})
      ORDER BY t.posted_at ASC LIMIT 200`).all(...ids);
    const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
    res.render('review', { title: 'Review', rows, categories, reviewCount: rows.length });
  });

  app.get('/', (req, res) => {
    const { rows, accounts, categories, members } = feedQuery(db, req.user, req.query);
    res.render('dashboard', {
      title: 'Overview',
      rows, accounts, categories, members,
      banks: accounts.filter(a => a.kind === 'bank'),
      credits: accounts.filter(a => a.kind === 'credit'),
      totals: totals(db, req.user),
      filters: req.query,
      reviewCount: reviewCount(db, req.user),
      staleness: staleness(db, req.user),
    });
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
    res.render('rules', { title: 'Rules', rules, categories,
      accounts: visAccts, reviewCount: reviewCount(db, req.user) });
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

  app.get('/accounts', ownerOnly, (req, res) => {
    const accounts = db.prepare('SELECT * FROM accounts ORDER BY kind, COALESCE(display_name, name)').all();
    res.render('accounts', { title: 'Accounts', accounts, reviewCount: reviewCount(db, req.user) });
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

module.exports = { createApp };
