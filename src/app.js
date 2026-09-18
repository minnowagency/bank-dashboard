const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { verifyLogin, createSession, getSessionUser, deleteSession, SESSION_TTL_SECONDS } = require('./auth');
const { createRule } = require('./rules');

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
    const t = db.prepare(`SELECT t.*, a.visibility FROM transactions t
      JOIN accounts a ON a.id = t.account_id WHERE t.uid = ?`).get(uid);
    if (!t) return null;
    if (user.role !== 'owner' && t.visibility !== 'company') return null;
    return t;
  }
  const back = (req, res) => res.redirect(req.get('referer') || '/');

  app.post('/txns/:uid/category', (req, res) => {
    const t = visibleTxn(db, req.user, req.params.uid);
    if (!t) return res.status(404).send('Not found');
    const cid = req.body.category_id ? Number(req.body.category_id) : null;
    if (cid === null) {
      db.prepare(`UPDATE transactions SET category_id=NULL, category_source=NULL,
                  categorized_by=NULL, rule_id=NULL WHERE uid=?`).run(t.uid);
    } else {
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
    if (!pattern || !categoryId) return res.status(400).send('Pattern and category required');
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
}

module.exports = { createApp };
