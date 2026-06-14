# Acuity Gateway

A lightweight booking app that sits between the public internet and a clinic's
local **Acuity** instance. It does two jobs at once:

- a **patient-facing booking portal** (embeddable as an iframe on the clinic's
  own domain), and
- a **security gateway**, so patients never connect to Acuity directly.

Acuity is the **system of record**. Gateway is the **edge** — it validates,
rate-limits, and brokers all external traffic, and it keeps the clinic taking
bookings even when Acuity is offline.

```
Internet  →  Lightsail (Gateway)  →  authenticated channel  →  Local Acuity  →  booking logic
                   │
             SQLite (availability cache + outage queue)
                   │
             /admin dashboard (later pass)
```

> **Status:** Feature-complete for v1 — Express + `node:sqlite`, the
> booking/resilience engine, the patient portal, a password-gated **admin
> dashboard** (metrics + reconciliation report), **Cellcast SMS** (confirmation
> send + inbound/DLR webhook), the nightly **retention purge job**, and a
> deterministic **`setup.sh`** that provisions a Lightsail box end to end
> (swap, Node, systemd service, nginx + SSL). A local **mock Acuity** lets the
> whole thing run with no live credentials.

---

## Quick start (local, Windows or Linux)

Requires Node (see [`.nvmrc`](.nvmrc) — Node 24).

```bash
npm install
cp .env.example .env        # defaults already point at the local mock

# Terminal 1 — start the mock Acuity (the "system of record" stand-in)
npm run mock

# Terminal 2 — start the Gateway
npm start
```

Open <http://localhost:3000> for the booking portal.

**Try the resilience model:** stop the mock (Ctrl-C in terminal 1) to simulate an
**Acuity outage**. The portal keeps taking bookings (they show as *received*),
queued locally. Restart the mock — within ~30s Gateway detects the reconnect,
replays the queue to Acuity, and reconciles.

The mock seeds two existing patients for the lookup flow: phone `0412345678`
(Jane Doe) and `0498765432` (John Smith).

---

## How it works

- **Two separate stores** (spec #21). `availability_cache` holds non-PII open
  slots (grows freely). `pending_bookings` holds patient PII with **minimal
  residency** — purged once `synced == true AND the appointment date has passed`
  (with a 1-week backstop). Age alone never purges; un-synced bookings are the
  outage queue and are exempt. The nightly purge job (`src/services/purge.js`)
  enforces this and logs what it removed to the audit trail.
- **Availability** is served from the cache (resilient) and refreshed on a timer
  and on webhooks, with a **live re-check against Acuity at booking time** to
  avoid double-booking.
- **Booking** (`src/services/booking.js`): verify → hold the slot locally →
  push to Acuity. If Acuity is unreachable, the booking is **queued** and still
  confirmed to the patient — Gateway becomes the source of truth for the outage.
- **Reconnect** (`src/services/sync.js`): a health check detects Acuity coming
  back, replays the queue, and **flags any collision** in `reconciliation_flags`
  for a human — never a silent overwrite (spec #7).
- **Security** (`src/middleware/security.js`): CSP `frame-ancestors` locked to
  the clinic origin, CORS locked to the same, short-lived **Bearer tokens**
  (not cookies) for the sensitive endpoints, PII only ever in request bodies.
- **Admin** (`/admin`, `src/routes/admin.js`): password gate (+ optional IP
  allow-list) with httpOnly session cookie and audit-logged access. Shows live
  metrics — Acuity health, queue depth, sync lag, failed bookings, SMS failures,
  error counts — plus the **reconciliation report** (resolve collisions by hand)
  and the outage queue. Manual "replay queue" / "run purge" triggers included.
- **SMS** (`src/sms/cellcast.js`, `src/services/sms.js`): sends a Cellcast
  confirmation on booking (best-effort, never blocks), with an inbound webhook
  (`/webhooks/cellcast`) for replies + delivery receipts. No-ops cleanly when no
  Cellcast key is configured.

See [`docs/INTEGRATION_NOTES.md`](docs/INTEGRATION_NOTES.md) for the verified
Acuity / Cellcast / security contracts behind the implementation.

---

## Configuration

Everything clinic-specific lives in `.env` (spec #23/#24) — see
[`.env.example`](.env.example). Secrets are git-ignored and never committed; the
same codebase is deployed to every clinic and differentiated only by config.

Key vars: `ACUITY_USER_ID` / `ACUITY_API_KEY` / `ACUITY_API_BASE`,
`CLINIC_ORIGIN` (drives CORS + iframe framing), `ADMIN_PASSWORD`,
`CELLCAST_*`, `DB_PATH`.

---

## Project structure

```
src/
  server.js              Express entry — middleware, routes, startup jobs
  config.js              .env loader (fail-fast in production)
  db/
    schema.sql           the two-store schema + sync/audit/reconciliation tables
    index.js             SQLite connection (WAL) + migration
  acuity/
    client.js            Acuity REST client (outage-aware)
    mock-server.js       local stand-in for Acuity (npm run mock)
  sms/
    cellcast.js          Cellcast SMS client (v1 gateway) + AU number normalise
  services/
    availability.js      cache + refresh + live verify
    patients.js          existing-patient lookup (PII passthrough, not stored)
    booking.js           booking flow + outage queue (resilience core)
    sync.js              queue replay, reconnect, reconciliation, webhooks
    sms.js               SMS orchestration + sms_log
    purge.js             nightly retention purge (APP 11)
    metrics.js           admin dashboard metrics
    status.js            Acuity online/offline state
  middleware/
    security.js          helmet/CSP, CORS, rate limits, session gate
    admin.js             admin IP allow-list + password + cookie session
    audit.js             audit-log writer
  routes/
    portal.js            public booking API
    admin.js             /admin dashboard + gated metrics/ops APIs
    webhooks.js          Acuity + Cellcast webhook receivers (verified)
  lib/
    token.js             signed short-lived session / admin tokens
    logger.js            structured logging
public/                  the iframe booking portal (vanilla HTML/CSS/JS)
admin/                   the admin dashboard (vanilla HTML/CSS/JS)
deploy/                  systemd unit + nginx site (reference)
data/                    SQLite files live here (git-ignored)
setup.sh                 deterministic installer (swap, Node, service, SSL)
```

---

## Deployment to AWS Lightsail

One repo, many deployments — each instance pulls the same versioned code and is
differentiated only by `.env`. Tag known-good releases (`v1.0`, …) and stage
rollouts. The deterministic [`setup.sh`](setup.sh) (not an agent) provisions a
fresh box end to end:

```bash
git clone https://github.com/eche028-code/Acuity-Gateway.git
cd Acuity-Gateway
cp .env.example .env     # fill in config, including DOMAIN + LETSENCRYPT_EMAIL
./setup.sh               # swap, Node, deps, DB, systemd service, nginx + SSL
```

**Sized for the smallest Lightsail tier (1 GB RAM / 40 GB disk):** `setup.sh`
creates a 2 GB swapfile (so `npm install` doesn't OOM), the systemd unit caps
Node's heap (`--max-old-space-size=256`) with `MemoryHigh=700M` / `MemoryMax=850M`
(reclaim into swap before any hard kill), and journald is capped at 500 MB.
nginx terminates TLS and proxies to the Node port; the app trusts exactly one
proxy hop. Manage it with `systemctl status acuity-gateway`
and `journalctl -u acuity-gateway -f`.

> **Claude Code's role is the mechanic, not the installer** (spec §5): `setup.sh`
> is the deploy path; keep Claude Code around (or just SSH in) for debugging and
> patching an instance in place.

## Regulatory

Handles Australian health information. The retention/purge design implements
APP 11 (destroy/de-identify when no longer needed). This is an engineering
README, not legal advice — confirm obligations before go-live.
