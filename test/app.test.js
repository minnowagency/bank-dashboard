const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, login } = require('./helpers');

test('unauthenticated requests redirect to /login; /health is open', async () => {
  const { app } = makeApp();
  assert.equal((await request(app).get('/health')).status, 200);
  const res = await request(app).get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('login sets HttpOnly SameSite=Lax cookie; bad login re-renders with error', async () => {
  const { app } = makeApp();
  const ok = await request(app).post('/login').type('form').send({ username: 'michael', password: 'ownerpass1' });
  assert.equal(ok.status, 302);
  const cookie = ok.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  const bad = await request(app).post('/login').type('form').send({ username: 'michael', password: 'nope' });
  assert.equal(bad.status, 401);
  assert.match(bad.text, /Invalid username or password/);
});

test('logout clears the session', async () => {
  const { app } = makeApp();
  const cookie = await login(app, 'michael', 'ownerpass1');
  await request(app).post('/logout').set('Cookie', cookie);
  const res = await request(app).get('/').set('Cookie', cookie);
  assert.equal(res.status, 302);
});
