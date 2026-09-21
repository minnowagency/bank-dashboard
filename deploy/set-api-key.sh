#!/usr/bin/env bash
# One-time: store the Anthropic API key used for AI categorization in .env.
# The key is read without echo and never passed on a command line.
set -euo pipefail
ENV_FILE=/opt/bank-dashboard/.env
read -rsp "Anthropic API key (hidden): " KEY; echo
case "$KEY" in
  sk-ant-*) ;;
  *) echo "That does not look like an Anthropic API key (expected it to start with sk-ant-)." >&2; exit 1 ;;
esac
umask 077
touch "$ENV_FILE"
grep -v '^ANTHROPIC_API_KEY=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
chown bankdash:bankdash "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Saved. Restart to pick it up:  systemctl restart bank-dashboard"
