#!/usr/bin/env bash
#
# Acuity Gateway — deterministic installer (spec §5).
# Turns a fresh AWS Lightsail (Ubuntu) instance into a working Gateway:
# swap, Node, dependencies, database, a systemd service, and nginx + SSL.
# Re-runnable (idempotent). Tuned for the smallest Lightsail tier (1 GB RAM /
# 40 GB disk): it creates swap, caps the Node heap, and caps the journal size.
#
#   git clone <repo-url> && cd Acuity-Gateway
#   cp .env.example .env          # fill in this clinic's config (incl. DOMAIN)
#   ./setup.sh
#
# Steps that need root use sudo. The HTTP app install runs even without a DOMAIN;
# nginx + SSL are only configured when DOMAIN is set in .env.
set -euo pipefail
cd "$(dirname "$0")"
APP_DIR="$(pwd)"
APP_USER="${SUDO_USER:-$USER}"
NODE_MAJOR=24
SSL_FAILED=0

say() { printf '\n==> %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── 0. Read deploy config from .env (DOMAIN, LETSENCRYPT_EMAIL) ──────
if [ ! -f .env ]; then
  echo "!! No .env found. Run: cp .env.example .env  then fill it in and re-run." >&2
  exit 1
fi
DOMAIN="$(grep -E '^DOMAIN=' .env | head -n1 | cut -d= -f2- | tr -d '"' | xargs || true)"
LE_EMAIL="$(grep -E '^LETSENCRYPT_EMAIL=' .env | head -n1 | cut -d= -f2- | tr -d '"' | xargs || true)"

# ── 1. Swap (1 GB box OOMs during npm install without it) ───────────
if ! sudo swapon --show | grep -q '/swapfile'; then
  say "Creating 2 GB swapfile"
  sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
else
  say "Swap already configured"
fi

# ── 2. Node.js (pinned major, via NodeSource) ───────────────────────
# Read the current major defensively: a broken `node -p` must not abort set -e.
NODE_CUR=0
if have node; then
  NODE_CUR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  NODE_CUR=${NODE_CUR//[!0-9]/}
fi
if [ "${NODE_CUR:-0}" -lt "$NODE_MAJOR" ]; then
  say "Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
say "node $(node --version)"

# ── 3. App dependencies (production only) ───────────────────────────
say "Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

# ── 4. Database (idempotent schema) ─────────────────────────────────
say "Initialising SQLite database"
npm run init-db

# ── 5. systemd service (generated with real paths) ──────────────────
say "Installing systemd service"
NODE_BIN="$(command -v node)"
sudo tee /etc/systemd/system/acuity-gateway.service >/dev/null <<UNIT
[Unit]
Description=Acuity Gateway
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} --max-old-space-size=256 src/server.js
Restart=always
RestartSec=3
MemoryHigh=700M
MemoryMax=850M
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now acuity-gateway
sudo systemctl restart acuity-gateway

# ── 6. Cap journald disk use (40 GB box; logs go to the journal) ────
say "Capping journald size"
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' | sudo tee /etc/systemd/journald.conf.d/acuity-gateway.conf >/dev/null
sudo systemctl restart systemd-journald || true

# ── 7. nginx + SSL (only if DOMAIN is set) ──────────────────────────
if [ -n "$DOMAIN" ]; then
  say "Configuring nginx for ${DOMAIN}"
  have nginx || sudo apt-get install -y nginx
  sed "s/__DOMAIN__/${DOMAIN}/g" deploy/nginx.conf | sudo tee /etc/nginx/sites-available/acuity-gateway >/dev/null
  sudo ln -sf /etc/nginx/sites-available/acuity-gateway /etc/nginx/sites-enabled/acuity-gateway
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl reload nginx

  say "Provisioning SSL via Let's Encrypt"
  have certbot || sudo apt-get install -y certbot python3-certbot-nginx
  if sudo certbot certificates 2>/dev/null | grep -q "${DOMAIN}"; then
    echo "    Certificate for ${DOMAIN} already present — skipping issuance (renewals are automatic)."
  elif [ -n "$LE_EMAIL" ]; then
    if sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect; then
      echo "    SSL provisioned for ${DOMAIN}."
    else
      SSL_FAILED=1
      echo "!! certbot FAILED — check that ${DOMAIN} resolves to this instance and ports 80/443 are open, then re-run."
    fi
  else
    SSL_FAILED=1
    echo "!! LETSENCRYPT_EMAIL not set in .env — skipping automatic SSL. Run certbot manually."
  fi
else
  say "DOMAIN not set in .env — skipping nginx + SSL (app is running on PORT directly)."
fi

# Reclaim the apt cache — the 40 GB disk shouldn't accumulate it across re-runs.
sudo apt-get clean || true

# ── Done ────────────────────────────────────────────────────────────
say "Setup complete."
echo "    Service:  sudo systemctl status acuity-gateway"
echo "    Logs:     journalctl -u acuity-gateway -f"
if [ -n "$DOMAIN" ]; then echo "    URL:      https://${DOMAIN}  (portal)   https://${DOMAIN}/admin  (admin)"; fi
if [ "${SSL_FAILED}" = "1" ]; then
  echo ""
  echo "!! TLS was NOT provisioned — the site is HTTP only until certbot succeeds. Re-run ./setup.sh after fixing DNS/email."
fi
