#!/usr/bin/env bash
# One-time: write the rclone config for DigitalOcean Spaces backups.
# Prompts for the Space's region + name and an access key; the secret is read
# without echo and never passed on a command line.
set -euo pipefail
read -rp "Space region (e.g. nyc3): " REGION
read -rp "Space name: " BUCKET
read -rp "Access key ID: " KEY
read -rsp "Secret key (hidden): " SECRET; echo
umask 077
mkdir -p /root/.config/rclone
cat > /root/.config/rclone/rclone.conf <<EOF
[spaces]
type = s3
provider = DigitalOcean
access_key_id = $KEY
secret_access_key = $SECRET
endpoint = $REGION.digitaloceanspaces.com
acl = private
no_check_bucket = true

[bankbackup]
type = alias
remote = spaces:$BUCKET/bank-dashboard
EOF
echo "Saved. Testing access to $BUCKET..."
rclone lsf bankbackup: >/dev/null && echo "Access OK." || { echo "Access FAILED — check the region, Space name, and key." >&2; exit 1; }
