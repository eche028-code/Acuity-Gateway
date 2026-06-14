#!/usr/bin/env bash
#
# Acuity Gateway — deterministic installer (spec §5).
# Turns a fresh Lightsail/Ubuntu instance into a working Gateway. Re-runnable.
#
#   git clone <repo-url> && cd Acuity-Gateway
#   cp .env.example .env      # then fill in this clinic's config
#   ./setup.sh
#
# NOTE: this is the MVP installer (dependencies + database). Service
# registration (systemd) and SSL provisioning are stubbed below and land in a
# later pass — see the "TODO (later pass)" section.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Acuity Gateway setup"

# 1. Node — expect the version pinned in .nvmrc (same major as dev).
if ! command -v node >/dev/null 2>&1; then
  echo "!! Node.js is not installed. Install Node $(cat .nvmrc 2>/dev/null || echo 20+) first, then re-run." >&2
  exit 1
fi
echo "    node $(node --version)"

# 2. Dependencies — reproducible install when a lockfile is present.
echo "==> Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

# 3. Config check.
if [ ! -f .env ]; then
  echo "!! No .env found. Copy .env.example to .env and fill it in, then re-run." >&2
  echo "   cp .env.example .env" >&2
  exit 1
fi

# 4. Database — idempotent schema creation.
echo "==> Initialising SQLite database"
npm run init-db

echo ""
echo "==> Base install complete."
echo "    Start (foreground):  npm start"
echo "    Mock Acuity (dev):   npm run mock"
echo ""

# ── TODO (later pass) ────────────────────────────────────────────────
# - Register a systemd service so Gateway survives reboot:
#     install acuity-gateway.service, `systemctl enable --now acuity-gateway`
# - Provision/renew SSL (Lightsail certificate or certbot + Nginx reverse proxy)
#     so the iframe loads over HTTPS.
# - Configure Nginx to terminate TLS and proxy to PORT, set `trust proxy` hops.
