// AI categorization of transactions no rule matched.
//
// PRIVACY CONTRACT — this module is the ONLY place an Anthropic API request is
// built. Exactly the fields in ALLOWED_TXN_KEYS leave the server: a per-batch
// reference number, the date, the amount, the masked description, and a
// cardholder label ("cardholder A"). Account names, ids, balances, real card
// member names, credentials and user records never appear in a request.
// test/ai-categorize.test.js fails the build if that changes.

const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const MODEL = 'claude-opus-5';
const BATCH_SIZE = 25;
const MAX_EXAMPLES = 40;
const TZ = 'America/New_York';

const ALLOWED_TXN_KEYS = ['ref', 'date', 'amount', 'text', 'cardholder'];

const ResultsSchema = z.object({
  results: z.array(z.object({
    ref: z.number(),
    category: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    reason: z.string(),
  })),
});

const SYSTEM = `You categorize business bank and credit card transactions for a small manufacturing company.

You receive a list of transactions. For each one, pick exactly one category from the provided list and report your confidence.

- Use "high" only when the merchant or description makes the category clear.
- Use "medium" or "low" when you are guessing; those are reviewed by a person, so guessing quietly is worse than admitting doubt.
- A positive amount is money coming in; a negative amount is money going out. An inbound amount is rarely an expense category.
- "cardholder A/B/..." labels identify which employee card was used; the same cardholder's spending is often consistent.
- Prefer the categories the company already used for similar transactions in the provided examples over your own intuition.
- Never invent a category name. Use one from the list exactly as written.
- reason: at most 12 words, naming the evidence you used.`;

// Mask runs of 5+ digits (account and card numbers) but keep short numbers,
// which are often part of a merchant name ("UPS 1234 STORE").
function maskDigits(text) {
  return String(text).replace(/\d{5,}/g, '####');
}

// Stable pseudonyms so the model can learn per-cardholder patterns without
// receiving anyone's name.
function cardholderLabels(txns) {
  const names = [...new Set(txns.map(t => t.card_member).filter(Boolean))].sort();
  const labels = new Map();
  names.forEach((name, i) => {
    labels.set(name, `cardholder ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`);
  });
  return labels;
}

function ymd(epochSeconds) {
  // en-CA gives YYYY-MM-DD; the timezone keeps late-evening transactions on
  // the day the business would call them.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(epochSeconds * 1000));
}

function dollars(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function toPayloadItem(txn, ref, labels) {
  const item = {
    ref,
    date: ymd(txn.posted_at),
    amount: dollars(txn.amount_cents),
    text: maskDigits(txn.description),
  };
  const label = txn.card_member ? labels.get(txn.card_member) : null;
  if (label) item.cardholder = label;
  return item;
}

function categoryNames(db) {
  return db.prepare('SELECT name FROM categories ORDER BY name').all().map(r => r.name);
}

// The company's own past decisions, as guidance. Descriptions are masked the
// same way; no account or person is named.
function examples(db) {
  return db.prepare(`SELECT t.description, t.amount_cents, c.name AS category
    FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE t.category_source = 'manual'
    ORDER BY t.posted_at DESC LIMIT ?`).all(MAX_EXAMPLES)
    .map(r => ({ text: maskDigits(r.description), amount: dollars(r.amount_cents), category: r.category }));
}

// Builds the exact request object handed to the SDK. Nothing else may.
function buildRequest(db, txns) {
  const labels = cardholderLabels(txns);
  const items = txns.map((t, i) => toPayloadItem(t, i + 1, labels));
  const guidance = examples(db);

  const userContent = JSON.stringify({
    categories: categoryNames(db),
    past_decisions: guidance,
    transactions: items,
  });

  const request = {
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    output_config: { effort: 'low', format: zodOutputFormat(ResultsSchema) },
    messages: [{ role: 'user', content: userContent }],
  };
  // Non-enumerable so it can't be serialized into a request by accident; the
  // privacy test reads it to assert the exact key set.
  Object.defineProperty(request, '_items', { value: items, enumerable: false });
  return request;
}

function uncategorized(db) {
  return db.prepare(`SELECT t.uid, t.posted_at, t.amount_cents, t.description, t.card_member
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.category_id IS NULL AND t.suggested_category_id IS NULL AND a.hidden = 0
    ORDER BY t.posted_at DESC`).all();
}

async function categorizeUncategorized(db, { client, batchSize = BATCH_SIZE, log = () => {} } = {}) {
  const pending = uncategorized(db);
  const out = { applied: 0, suggested: 0, failed: 0, batches: 0, inputTokens: 0, outputTokens: 0 };
  if (pending.length === 0 || !client) return out;

  const catId = new Map(db.prepare('SELECT id, name FROM categories').all().map(r => [r.name.toLowerCase(), r.id]));
  const apply = db.prepare(`UPDATE transactions
    SET category_id = ?, category_source = 'ai', ai_confidence = ?, ai_reason = ?
    WHERE uid = ? AND category_id IS NULL`);
  const suggest = db.prepare(`UPDATE transactions
    SET suggested_category_id = ?, ai_confidence = ?, ai_reason = ?
    WHERE uid = ? AND category_id IS NULL`);

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    out.batches++;
    let parsed;
    try {
      const response = await client.messages.parse(buildRequest(db, batch));
      out.inputTokens += (response.usage && response.usage.input_tokens) || 0;
      out.outputTokens += (response.usage && response.usage.output_tokens) || 0;
      parsed = response.parsed_output;
      if (!parsed) throw new Error('response did not match the expected schema');
    } catch (err) {
      out.failed += batch.length;
      log(`[ai] batch failed: ${String((err && err.message) || err)}`);
      continue;
    }

    for (const r of parsed.results || []) {
      const txn = batch[r.ref - 1];
      const categoryId = catId.get(String(r.category || '').toLowerCase());
      if (!txn || !categoryId) continue; // unknown ref or invented category
      const reason = String(r.reason || '').slice(0, 200);
      if (r.confidence === 'high') {
        if (apply.run(categoryId, r.confidence, reason, txn.uid).changes) out.applied++;
      } else if (suggest.run(categoryId, r.confidence, reason, txn.uid).changes) {
        out.suggested++;
      }
    }
  }
  return out;
}

module.exports = {
  ALLOWED_TXN_KEYS, MODEL, maskDigits, cardholderLabels, buildRequest, categorizeUncategorized,
};
