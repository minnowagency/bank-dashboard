#!/usr/bin/env bash
# One-time: store the Plaid credentials (and generate the app secret that
# encrypts access tokens at rest) in .env. Secrets are read without echo.
set -euo pipefail
ENV_FILE=/opt/bank-dashboard/.env
read -rp "Plaid client ID: " CLIENT_ID
read -rsp "Plaid secret (hidden): " SECRET; echo
read -rp "Plaid environment [production]: " ENV_NAME; ENV_NAME=${ENV_NAME:-production}
[ -n "$CLIENT_ID" ] && [ -n "$SECRET" ] || { echo "Both values are required." >&2; exit 1; }
umask 077
touch "$ENV_FILE"
APP_SECRET=$(grep '^APP_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)
[ -n "$APP_SECRET" ] || APP_SECRET=$(openssl rand -hex 32)
grep -vE '^(PLAID_CLIENT_ID|PLAID_SECRET|PLAID_ENV|APP_SECRET)=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
{
  printf 'PLAID_CLIENT_ID=%s\n' "$CLIENT_ID"
  printf 'PLAID_SECRET=%s\n' "$SECRET"
  printf 'PLAID_ENV=%s\n' "$ENV_NAME"
  printf 'APP_SECRET=%s\n' "$APP_SECRET"
} >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
chown bankdash:bankdash "$ENV_FILE"; chmod 600 "$ENV_FILE"
echo "Saved. APP_SECRET encrypts bank access tokens — back it up with the backup passphrase."
echo "Restart to pick it up:  systemctl restart bank-dashboard"
