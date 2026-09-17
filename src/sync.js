const { detectTransfers } = require('./transfers');
const { applyRulesToUncategorized } = require('./rules');

const OVERLAP_SECONDS = 7 * 86400;

function guessKind(orgName, name) {
  return /american express|amex|card/i.test(`${orgName} ${name}`) ? 'credit' : 'bank';
}

async function runSync(db, { accessUrl, fetchAccountsFn, now = () => Math.floor(Date.now() / 1000) }) {
  const startedAt = now();
  const runId = db.prepare('INSERT INTO sync_runs (started_at) VALUES (?)').run(startedAt).lastInsertRowid;
  try {
    const last = db.prepare("SELECT value FROM settings WHERE key='last_sync_start'").get();
    const startDate = last ? Math.max(0, Number(last.value) - OVERLAP_SECONDS) : 0;
    const { errors, accounts } = await fetchAccountsFn(accessUrl, { startDate });

    const upsertAccount = db.prepare(`
      INSERT INTO accounts (id, name, org_name, kind, balance_cents, balance_date, last_synced_at, sync_error)
      VALUES (@id, @name, @orgName, @kind, @balanceCents, @balanceDate, @syncedAt, NULL)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        org_name = excluded.org_name,
        balance_cents = excluded.balance_cents,
        balance_date = excluded.balance_date,
        last_synced_at = excluded.last_synced_at,
        sync_error = NULL`);

    const upsertTxn = db.prepare(`
      INSERT INTO transactions (uid, sf_id, account_id, posted_at, amount_cents, description,
                                pending, card_member, first_seen_at)
      VALUES (@uid, @sfId, @accountId, @postedAt, @amountCents, @description,
              @pending, @cardMember, @firstSeen)
      ON CONFLICT(uid) DO UPDATE SET
        posted_at = excluded.posted_at,
        amount_cents = excluded.amount_cents,
        description = excluded.description,
        pending = excluded.pending,
        card_member = COALESCE(excluded.card_member, transactions.card_member)`);

    const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

    let newTransactions = 0;
    const before = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
    db.transaction(() => {
      for (const a of accounts) {
        upsertAccount.run({
          id: a.id, name: a.name, orgName: a.orgName,
          kind: guessKind(a.orgName, a.name),
          balanceCents: a.balanceCents, balanceDate: a.balanceDate, syncedAt: now(),
        });
        for (const t of a.transactions) {
          upsertTxn.run({
            uid: `${a.id}|${t.id}`, sfId: t.id, accountId: a.id,
            postedAt: t.postedAt, amountCents: t.amountCents, description: t.description,
            pending: t.pending, cardMember: t.cardMember, firstSeen: now(),
          });
        }
      }
      setSetting.run('last_sync_start', String(startedAt));
      setSetting.run('sync_errors', JSON.stringify(errors));
    })();
    newTransactions = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n - before;

    const transferPairs = detectTransfers(db);
    const ruleMatches = applyRulesToUncategorized(db);
    db.prepare('UPDATE sync_runs SET finished_at = ?, ok = 1 WHERE id = ?').run(now(), runId);
    return { ok: true, errors, newTransactions, transferPairs, ruleMatches };
  } catch (err) {
    db.prepare('UPDATE sync_runs SET finished_at = ?, ok = 0, error = ? WHERE id = ?')
      .run(now(), String((err && err.message) || err), runId);
    return { ok: false, errors: [String((err && err.message) || err)], newTransactions: 0 };
  }
}

module.exports = { runSync, OVERLAP_SECONDS, guessKind };
