#!/usr/bin/env bash
# Nightly encrypted SQLite backup to DigitalOcean Spaces via rclone.
# Requires: sqlite3, gpg, rclone with a 'bankbackup' remote (written by
# backup-setup.sh), and a passphrase in /etc/bank-dashboard/backup.pass
# (root:root, mode 600).
set -euo pipefail
DB=/opt/bank-dashboard/data/bank.sqlite3
STAMP=$(date +%Y%m%d-%H%M%S)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
sqlite3 "$DB" ".backup '$TMP/bank-$STAMP.sqlite3'"
gpg --batch --symmetric --cipher-algo AES256 \
    --passphrase-file /etc/bank-dashboard/backup.pass \
    -o "$TMP/bank-$STAMP.sqlite3.gpg" "$TMP/bank-$STAMP.sqlite3"
rclone copy "$TMP/bank-$STAMP.sqlite3.gpg" bankbackup:
# keep 60 days of backups
rclone delete --min-age 60d bankbackup: || true
echo "$(date -Is) ok bank-$STAMP.sqlite3.gpg"
