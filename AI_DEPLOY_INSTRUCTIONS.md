# AI Deploy Instructions — Acuity Gateway on AWS Lightsail (Ubuntu)

> **You are a Claude Code agent on the target Lightsail instance, inside the cloned
> `Acuity-Gateway` repo.** Deploy this app as a production service.
>
> **The installer is `./setup.sh`** — it deterministically does swap, Node 24, deps,
> DB init, a hardened systemd service, journald capping, and nginx + Let's Encrypt.
> **Don't reinvent those steps.** Your job is to (a) collect the config, (b) do the
> two things `setup.sh` does NOT — **install/connect Tailscale** and **write `.env`**,
> then (c) run `./setup.sh`, and (d) verify + hand back the off-box to-dos.
>
> This is the **single-business (1:1) deployment**. If the user wants the multi-business
> shared-SMS hub, STOP and confirm scope — that's a different, multi-tenant build.

## How to operate (rules)
- **Collect every input in Step 0 first**, then run — don't stall midway for a secret.
- **Confirm before consequential actions:** running `./setup.sh` (it installs packages,
  starts a service, and runs `certbot` against Let's Encrypt — which rate-limits
  failures), and anything destructive. Show the command, get a yes.
- **Secrets:** ask for the ones you can't create; **generate** the app's own; write them
  **only to `.env`** (git-ignored — never `git add`/commit it). Show generated secrets to
  the user once (they mirror them in Acuity/Cellcast), then stop echoing them.
- **This box holds patient PII.** Minimal logging; never print DB or `.env` contents.
- **Verify each phase** before moving on. On failure, diagnose and fix — `setup.sh` is
  idempotent, so it's safe to re-run after correcting a problem.
- Use `sudo` as needed; the app runs as the normal login user (e.g. `ubuntu`), not root.

## Architecture (so you make the right calls)
- Public **booking portal + `/admin` + SMS relay**. nginx terminates HTTPS and proxies
  to the app on `127.0.0.1:3000` (the app trusts exactly one proxy hop — don't add a
  second proxy in front without adjusting `trust proxy`).
- Reaches the clinic's **Acuity over Tailscale** (`ACUITY_API_BASE` = Acuity's MagicDNS
  hostname). **`setup.sh` does NOT set up Tailscale — you do (Step 2).** Tailscale is for
  the Acuity link only; do NOT use Tailscale Funnel here (that was a dev trick — prod
  uses the real domain).
- SMS in/out via **Cellcast** (REST + a webhook to `/webhooks/cellcast`).
- Storage is **`node:sqlite`** (built into Node ≥ 24 — no separate SQLite install).

---

## Step 0 — Collect from the user (ask, then proceed)
1. **Domain** (e.g. `book.clinic.com.au`). Confirm its DNS **A record already points at
   this instance's static IP** — `setup.sh`'s SSL step fails otherwise (it'll tell you to
   re-run once DNS is right).
2. **Acuity link:** the Acuity machine's **Tailscale hostname + port**
   (e.g. `https://acuity-pc.tailnet.ts.net:3002`) and the **Acuity API key**.
3. **Tailscale auth key** (reusable/ephemeral, from Tailscale admin → Keys). Confirm
   **MagicDNS is enabled** so the hostname resolves.
4. **Clinic origin** (site embedding the portal, e.g. `https://www.clinic.com.au`) +
   **clinic name**.
5. **Cellcast:** API key; sender number (or blank = shared); confirm webhook Basic Auth.
6. **LETSENCRYPT_EMAIL** for the cert.
7. Confirm the **Lightsail console firewall** has **TCP 80 + 443** open (Networking tab —
   off-box, the user's job).

You will **generate** and show once (they configure matching values in Acuity/Cellcast):
`ADMIN_PASSWORD`, `SESSION_SECRET`, `GATEWAY_INBOUND_API_KEY`, `CELLCAST_WEBHOOK_PASS`.

## Step 1 — Preflight
```bash
. /etc/os-release && echo "$PRETTY_NAME"            # expect Ubuntu
whoami; sudo -n true 2>/dev/null && echo "sudo ok" || echo "ask user for sudo"
pwd; ls setup.sh package.json && echo "in repo root" || echo "cd to the repo root"
```
If the repo isn't on the box, ask the user for GitHub access, `git clone` it, and `cd` in.

## Step 2 — Tailscale (the Acuity link — `setup.sh` does NOT do this)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --authkey <TAILSCALE_AUTH_KEY> --hostname gateway-<clinic>
tailscale status
tailscale ping <acuity-machine-name>      # must succeed before the Gateway can reach Acuity
```
If `ping` fails, resolve it (node approval / MagicDNS) before continuing.

## Step 3 — Write `.env`
```bash
cp -n .env.example .env
node -e "console.log('ADMIN_PASSWORD='+require('crypto').randomBytes(18).toString('hex'))"
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(24).toString('hex'))"
node -e "console.log('GATEWAY_INBOUND_API_KEY='+require('crypto').randomBytes(24).toString('hex'))"
node -e "console.log('CELLCAST_WEBHOOK_PASS='+require('crypto').randomBytes(15).toString('hex'))"
```
Edit `.env` and set (⚠️ = **required — the service won't boot in production without it**;
the systemd unit `setup.sh` installs sets `NODE_ENV=production`):
```ini
PUBLIC_BASE_URL=https://<domain>
DOMAIN=<domain>                     # setup.sh uses this to configure nginx + SSL
LETSENCRYPT_EMAIL=<email>           # setup.sh uses this for certbot

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
Tell the user the four generated secrets (they'll need `GATEWAY_INBOUND_API_KEY` and
`CELLCAST_WEBHOOK_PASS`). Don't commit `.env`.

## Step 4 — Run the installer (confirm first)
```bash
./setup.sh
```
This does everything else: 2 GB swap, Node 24 (if needed), `npm ci --omit=dev`, DB init,
the systemd service (`acuity-gateway`, heap-capped + memory-limited for the 1 GB tier),
journald cap, and — because `DOMAIN` is set — nginx + Let's Encrypt SSL. It's idempotent;
if SSL fails (DNS not resolving yet), fix DNS and re-run. Read its final summary.

## Step 5 — Verify
```bash
sudo systemctl status acuity-gateway --no-pager
curl -s http://127.0.0.1:3000/healthz       # {"ok":true}
curl -s https://<domain>/healthz            # {"ok":true} once SSL is up
```
If it crash-loops: `sudo journalctl -u acuity-gateway -n 50 --no-pager` — a missing ⚠️
`.env` var is the usual cause. Then ask the user to open `https://<domain>` (portal) and
`https://<domain>/admin` (log in; **Integrations** confirms SMS + sends a test).

## Step 6 — Report + remind the user of OFF-box tasks
- **Cellcast dashboard:** Receiver **and** Status webhook → `https://<domain>/webhooks/cellcast`;
  Webhook Logins = `cellcast` / `CELLCAST_WEBHOOK_PASS`; register the sender number if using one.
- **Acuity:** point outbound SMS at `https://<domain>/internal/sms/send` with
  `GATEWAY_INBOUND_API_KEY`; build/confirm `POST /api/gateway/v1/sms/inbound`
  (`docs/ACUITY_INBOUND_SMS_HANDOFF.md`).
- Confirm DNS A-record + Lightsail firewall (80/443) + Tailscale node approval are done.

---

## Updating later
```bash
cd <repo> && git pull && ./setup.sh        # idempotent: re-applies deps/service/nginx
```

## Backups
The DB (`data/gateway.sqlite`) holds bookings + SMS log:
```bash
mkdir -p ~/backups && cp data/gateway.sqlite ~/backups/gateway-$(date +%F).sqlite
```
…or take periodic Lightsail snapshots.

## Reference
- `README.md` → "Deployment to AWS Lightsail" (the human version of this).
- `setup.sh` → the installer you're running. `deploy/` → the nginx + systemd templates.
- `docs/INTEGRATION_NOTES.md`, `docs/ACUITY_*_HANDOFF.md` → API + SMS contracts.
