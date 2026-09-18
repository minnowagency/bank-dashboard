# Deploying bank-dashboard to a fresh DigitalOcean droplet

## 1. Droplet
- Create: Ubuntu 24.04 LTS, Basic $6/mo, SSH key auth (no password), any region near you.
- Note the IP. Everywhere below, replace 203.0.113.7 with it.

## 2. Base hardening (as root)
```bash
apt-get update && apt-get -y upgrade
apt-get -y install ufw unattended-upgrades sqlite3 gpg rclone git
dpkg-reconfigure -f noninteractive unattended-upgrades
ufw default deny incoming
ufw allow OpenSSH
ufw allow 80/tcp     # ACME challenges
ufw allow 443/tcp
ufw --force enable
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh
```

## 3. Node 22 + app user
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get -y install nodejs
useradd --system --create-home --home-dir /opt/bank-dashboard --shell /usr/sbin/nologin bankdash
```

## 4. App
```bash
# from your Mac, in the repo root:
rsync -a --exclude node_modules --exclude data --exclude .env --exclude .superpowers ./ root@203.0.113.7:/opt/bank-dashboard/
# on the droplet:
cd /opt/bank-dashboard && npm ci --omit=dev
chown -R bankdash:bankdash /opt/bank-dashboard
```

## 5. Secrets + users (on the droplet, as root, in /opt/bank-dashboard)
```bash
sudo -u bankdash node bin/claim-token.js '<setup token from bridge.simplefin.org>'
sudo -u bankdash node bin/create-user.js michael owner
sudo -u bankdash node bin/create-user.js assistant member
chmod 600 .env && chown bankdash:bankdash .env
```
Generate the setup token at bridge.simplefin.org ("New token"). A token can be claimed only once.

## 6. systemd + Caddy
```bash
cp deploy/bank-dashboard.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now bank-dashboard
journalctl -u bank-dashboard -f   # watch the first sync complete
# Caddy (official repo):
apt-get -y install debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get -y install caddy
caddy version   # must be >= 2.10 for IP certificates; otherwise use the sslip.io fallback
sed "s/203.0.113.7/$(curl -s ifconfig.me)/" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy
```
Visit https://<droplet-ip>/ — expect a valid padlock. If Caddy logs show ACME failures for the IP
cert, switch /etc/caddy/Caddyfile to the sslip.io variant and reload.

## 7. Backups
```bash
mkdir -p /etc/bank-dashboard
openssl rand -base64 32 > /etc/bank-dashboard/backup.pass && chmod 600 /etc/bank-dashboard/backup.pass
# Save a copy of backup.pass somewhere safe OFF the droplet (password manager) —
# without it, backups are unrecoverable.
rclone config   # create remote named 'spaces' → DigitalOcean Spaces, with a Space named bank-dashboard-backups
cp deploy/backup.sh /usr/local/bin/bank-backup && chmod +x /usr/local/bin/bank-backup
( crontab -l 2>/dev/null; echo '17 3 * * * /usr/local/bin/bank-backup' ) | crontab -
/usr/local/bin/bank-backup   # run once, verify the object appears in Spaces
```

## 8. Link the rest of the connections
At bridge.simplefin.org, add the remaining nine Truist logins, the company Amex, and the
personal Amex. They appear on the dashboard after the next sync (or restart the service to
sync now: `systemctl restart bank-dashboard`). Then, as the owner, open /accounts and flip
each company account to "Company" visibility, set display names, and correct any wrong
bank/credit-card type guesses.

## 9. Build-time verifications (from the spec)
- [ ] Amex card payments pair as Transfers — check signs; if Amex reports payments with the
      same sign as Truist debits, transfer pairing won't fire: inspect two real rows in
      sqlite3 and note findings in docs/superpowers/specs/.
- [ ] Employee cards: check whether they arrived as separate accounts or as card_member
      values; if neither, transactions may embed the member name in the description —
      adjust `normalizeTxn` in src/simplefin.js accordingly.
- [ ] Break a connection's password at the bank (or wait for one to need re-auth) is NOT
      required — just confirm the staleness banner text renders when `sync_errors` is
      non-empty after any real connection hiccup.
