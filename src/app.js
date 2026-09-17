const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { verifyLogin, createSession, getSessionUser, deleteSession, SESSION_TTL_SECONDS } = require('./auth');

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

function registerRoutes(app, db) {
  // Later tasks append route registrations here.
}

module.exports = { createApp };
