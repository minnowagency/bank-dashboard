#!/usr/bin/env bash
# Encrypted database snapshot before a deploy or data repair.
# Usage (root): bank-predeploy-backup <label>
# Writes /root/predeploy/bank-pre-<label>-<timestamp>.sqlite3.gpg with the same
# passphrase as the nightly backups; never leaves a plaintext copy behind.
# Restore: gpg --batch --passphrase-file /etc/bank-dashboard/backup.pass -d FILE > bank.sqlite3
set -euo pipefail
LABEL=${1:?usage: bank-predeploy-backup <label>}
DB=/opt/bank-dashboard/data/bank.sqlite3
OUT=/root/predeploy
umask 077
mkdir -p "$OUT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
NAME="bank-pre-$LABEL-$(date +%Y%m%d-%H%M%S).sqlite3"
sqlite3 "$DB" ".backup '$TMP/$NAME'"
gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file /etc/bank-dashboard/backup.pass \
    -o "$OUT/$NAME.gpg" "$TMP/$NAME"
find "$OUT" -name 'bank-pre-*.gpg' -mtime +30 -delete
echo "$OUT/$NAME.gpg"
