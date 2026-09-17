const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, SEED_CATEGORIES } = require('../src/db');

test('openDb creates schema and seeds categories', () => {
  const db = openDb(':memory:');
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  for (const t of ['users','sessions','accounts','transactions','categories','rules','sync_runs','settings']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const cats = db.prepare('SELECT name FROM categories ORDER BY id').all().map(r => r.name);
  assert.deepEqual(cats, SEED_CATEGORIES);
});

test('openDb is idempotent on an existing file', () => {
  const path = require('path').join(require('os').tmpdir(), `bd-test-${process.pid}.sqlite3`);
  require('fs').rmSync(path, { force: true });
  openDb(path).close();
  const db = openDb(path); // second open must not error or duplicate seeds
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM categories').get().n, SEED_CATEGORIES.length);
  db.close();
  require('fs').rmSync(path, { force: true });
});
