# AI Deploy Instructions — Acuity Gateway on AWS Lightsail (Ubuntu)

> **You are a Claude Code agent running on the target Lightsail instance, inside the
> cloned `Acuity-Gateway` repo.** Your job: deploy this app as a production service.
> Work top to bottom. This is the **single-business (1:1) deployment** — one Acuity
> → one Gateway → one Cellcast account. If the user wants the **multi-business shared
> SMS hub**, STOP and confirm scope — that's a different (multi-tenant) setup not
> covered here.

## How to operate (rules — follow these)
- **Gather every input in Step 0 first**, then execute. Don't stall midway asking for
  a secret you could have collected up front.
- **Confirm before consequential or outward-facing actions:** opening firewall ports,
  running `certbot` (Let's Encrypt rate-limits failures), enabling/starting services,
  `git` writes, anything destructive. Show the exact command and get a yes.
- **Secrets:** ask the user for the ones you can't create; **generate** the app's own
  secrets yourself; write them **only to `.env`** (it is git-ignored — never commit it,
  never `git add` it). Show generated secrets to the user once so they can mirror them
  in Acuity/Cellcast, then don't echo them again.
- **This box holds patient PII.** Keep logging minimal; never print DB contents or
  `.env` values back.
- **Verify each phase** (commands given) before moving on. If something fails, diagnose
  and fix it — don't barrel ahead.
- Use `sudo` where needed; run the app as the normal login user (e.g. `ubuntu`), not root.

## Architecture (so you make the right calls)
- The Gateway is the **public** booking portal + `/admin` + SMS relay. **nginx**
  terminates HTTPS (Let's Encrypt) and reverse-proxies to the app on `127.0.0.1:3000`.
  In production the app trusts exactly **one** proxy hop (nginx) — don't add a second
  proxy in front without adjusting `trust proxy`.
- It reaches the clinic's **Acuity over Tailscale** (`ACUITY_API_BASE` = Acuity's
  Tailscale MagicDNS hostname). Tailscale is required for that link only; it is NOT
  used for public web traffic, and you do NOT use Tailscale Funnel here (that was a dev
  trick — prod uses the real domain).
- SMS in/out via **Cellcast** (REST API + a webhook to `/webhooks/cellcast`).
- Storage is **`node:sqlite`**, built into Node ≥ 24 — **no separate SQLite install, no
  native build, no compiler.** Installing Node is all that's needed.

---

## Step 0 — Collect from the user (ask, confirm, then proceed)
Ask for and record:
1. **Domain** for this clinic (e.g. `book.clinic.com.au`). Confirm its DNS **A record
   already points at this instance's static IP** — if not, the user must set it now, or
   `certbot` (Step 8) will fail.
2. **Acuity link:** the Acuity machine's **Tailscale hostname + port**
   (e.g. `https://acuity-pc.tailnet.ts.net:3002`) and the **Acuity API key**.
3. **Tailscale auth key** (reusable/ephemeral — Tailscale admin → Settings → Keys).
   Confirm **MagicDNS is enabled** on the tailnet (so the hostname resolves).
4. **Clinic origin** — the website that embeds the booking portal
   (e.g. `https://www.clinic.com.au`) — and the **clinic name**.
5. **Cellcast:** API key; sender number (or blank = shared number); confirm you'll set
   webhook Basic Auth.
6. **Lightsail firewall:** confirm the user has opened **TCP 80 and 443** in the
   Lightsail console (Networking tab) — you can't do that from the box.

You will **generate** these and show the user once (they configure the matching values
in Acuity/Cellcast): `ADMIN_PASSWORD`, `SESSION_SECRET`, `GATEWAY_INBOUND_API_KEY`,
`CELLCAST_WEBHOOK_PASS`.

---

## Step 1 — Preflight
```bash
. /etc/os-release && echo "$PRETTY_NAME"          # expect Ubuntu
whoami; sudo -n true 2>/dev/null && echo "sudo ok" || echo "need sudo (ask user)"
pwd; ls package.json && echo "in repo root" || echo "NOT in repo root"
node --version 2>/dev/null || echo "node not installed yet"
```
If you're not in the `Acuity-Gateway` repo root, `cd` to it (or, if the code isn't on
the box, ask the user for GitHub access and `git clone` it, then `cd` in).

## Step 2 — System packages + swap (1 GB RAM needs swap)
```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y nginx git curl

# 2 GB swap (skip if `swapon --show` already lists one)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## Step 3 — Node 24 (provides node:sqlite)
If `node --version` is below v24, install it:
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # confirm v24.x
```

## Step 4 — Tailscale (the Acuity link)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --authkey <TAILSCALE_AUTH_KEY> --hostname gateway-<clinic>
tailscale status
tailscale ping <acuity-machine-name>     # must succeed before the Gateway can sync
```
If `ping` fails, fix the tailnet (node approval / MagicDNS) before continuing.

## Step 5 — Install dependencies
```bash
npm ci --omit=dev
```

## Step 6 — Configure `.env`
```bash
cp -n .env.example .env
# generate the app secrets:
node -e "console.log('ADMIN_PASSWORD='+require('crypto').randomBytes(18).toString('hex'))"
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(24).toString('hex'))"
node -e "console.log('GATEWAY_INBOUND_API_KEY='+require('crypto').randomBytes(24).toString('hex'))"
node -e "console.log('CELLCAST_WEBHOOK_PASS='+require('crypto').randomBytes(15).toString('hex'))"
```
Edit `.env` and set at least these (the ones marked ⚠️ are **required in production —
the app refuses to boot without them**):
```ini
NODE_ENV=production                 # ⚠️ enables prod safety checks
PORT=3000
PUBLIC_BASE_URL=https://<domain>
DOMAIN=<domain>
LETSENCRYPT_EMAIL=<email>

ACUITY_API_KEY=<key>                # ⚠️
ACUITY_API_BASE=https://<acuity-host>.<tailnet>.ts.net:3002
ACUITY_TLS_INSECURE=false

CLINIC_ORIGIN=https://www.<clinic-site>   # ⚠️
CLINIC_NAME=<Clinic Name>

ADMIN_PASSWORD=<generated>          # ⚠️
SESSION_SECRET=<generated>
GATEWAY_INBOUND_API_KEY=<generated>

CELLCAST_API_KEY=<key>              # blank = SMS off (booking still works)
CELLCAST_SENDER_ID=<number or blank>
CELLCAST_WEBHOOK_USER=cellcast
CELLCAST_WEBHOOK_PASS=<generated>
```
Then tell the user the four generated secrets (they'll need `GATEWAY_INBOUND_API_KEY`
and `CELLCAST_WEBHOOK_PASS` for Acuity/Cellcast). Do **not** `git add .env`.

## Step 7 — Run as a systemd service (heap-capped for 1 GB RAM)
```bash
sudo tee /etc/systemd/system/acuity-gateway.service >/dev/null <<'EOF'
[Unit]
Description=Acuity Gateway
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/Acuity-Gateway
ExecStart=/usr/bin/node --max-old-space-size=512 src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
# adjust User= / WorkingDirectory= if not ubuntu / different path
sudo systemctl daemon-reload
sudo systemctl enable --now acuity-gateway
sleep 2 && curl -s http://127.0.0.1:3000/healthz    # expect {"ok":true}
sudo systemctl status acuity-gateway --no-pager
```
The SQLite schema auto-creates on first boot (no separate DB step). If the service
crash-loops, `sudo journalctl -u acuity-gateway -n 50 --no-pager` — a missing required
`.env` var is the usual cause.

## Step 8 — nginx reverse proxy + HTTPS  (CONFIRM before running certbot)
```bash
sudo tee /etc/nginx/sites-available/acuity-gateway >/dev/null <<'EOF'
server {
    listen 80;
    server_name <domain>;
    client_max_body_size 256k;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
# replace <domain>, then:
sudo ln -sf /etc/nginx/sites-available/acuity-gateway /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# HTTPS — confirm with the user first (DNS must resolve to this box):
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <domain> -m <email> --agree-tos -n --redirect
```

## Step 9 — Verify end-to-end
```bash
curl -s https://<domain>/healthz          # {"ok":true}
```
Ask the user to open `https://<domain>` (booking portal) and `https://<domain>/admin`
(log in with `ADMIN_PASSWORD`; in **Integrations** they can confirm SMS + send a test).

## Step 10 — Report + remind the user of OFF-box tasks
Summarise what you did, then list what only they can finish:
- **Cellcast dashboard:** set Receiver **and** Status webhook URLs to
  `https://<domain>/webhooks/cellcast`; Webhook Logins = `cellcast` /
  `CELLCAST_WEBHOOK_PASS`; register the sender number if using one.
- **Acuity:** point its outbound SMS at `https://<domain>/internal/sms/send` with the
  `GATEWAY_INBOUND_API_KEY`; build/confirm `POST /api/gateway/v1/sms/inbound`
  (see `docs/ACUITY_INBOUND_SMS_HANDOFF.md`).
- Confirm DNS + Tailscale node approval are done.

---

## Updating later
```bash
cd /home/ubuntu/Acuity-Gateway && git pull && npm ci --omit=dev && sudo systemctl restart acuity-gateway
```

## Backups
The DB (`data/gateway.sqlite`) holds bookings + SMS log. Back it up:
```bash
mkdir -p ~/backups && cp data/gateway.sqlite ~/backups/gateway-$(date +%F).sqlite
```
…or take periodic Lightsail snapshots.

## Reference docs in this repo
- `docs/INTEGRATION_NOTES.md` — Cellcast + Acuity API contracts.
- `docs/ACUITY_*_HANDOFF.md` — the Acuity-side endpoints and SMS contracts.
