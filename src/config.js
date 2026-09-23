const fs = require('fs');

function parseEnvFile(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

function loadConfig({ envFile = '.env' } = {}) {
  const fileEnv = parseEnvFile(envFile);
  const get = (k, d) => (process.env[k] !== undefined ? process.env[k] : (fileEnv[k] !== undefined ? fileEnv[k] : d));
  return {
    dbPath: get('DB_PATH', 'data/bank.sqlite3'),
    port: Number(get('PORT', 3000)),
    host: get('HOST', '127.0.0.1'),
    accessUrl: get('SIMPLEFIN_ACCESS_URL', ''),
    anthropicApiKey: get('ANTHROPIC_API_KEY', ''),
    plaidClientId: get('PLAID_CLIENT_ID', ''),
    plaidSecret: get('PLAID_SECRET', ''),
    plaidEnv: get('PLAID_ENV', 'production'),
    appSecret: get('APP_SECRET', ''),
    cookieSecure: get('NODE_ENV', '') === 'production',
  };
}

module.exports = { loadConfig };
