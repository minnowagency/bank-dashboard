const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');

test('loadConfig defaults, .env parsing, and process.env overlay', () => {
  const envFile = path.join(os.tmpdir(), `bd-env-${process.pid}`);
  fs.writeFileSync(envFile, '# comment\nSIMPLEFIN_ACCESS_URL=https://u:p@x.example/simplefin\nPORT=4000\n');
  const c = loadConfig({ envFile });
  assert.equal(c.accessUrl, 'https://u:p@x.example/simplefin');
  assert.equal(c.port, 4000);
  assert.equal(c.dbPath, 'data/bank.sqlite3');
  assert.equal(c.host, '127.0.0.1');
  const old = process.env.PORT;
  process.env.PORT = '5000';
  try { assert.equal(loadConfig({ envFile }).port, 5000); }
  finally { if (old === undefined) delete process.env.PORT; else process.env.PORT = old; }
  fs.rmSync(envFile);
});

test('loadConfig tolerates a missing .env file', () => {
  const c = loadConfig({ envFile: '/nonexistent/.env' });
  assert.equal(c.port, 3000);
});
