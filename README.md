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

> **Status:** MVP core — Express + SQLite, the booking/resilience engine, the
> patient portal, and a local **mock Acuity** so it runs with no live
> credentials. Admin dashboard, Cellcast SMS, the reconciliation UI, the nightly
> purge job, and full `setup.sh` (systemd + SSL) are scheduled follow-up passes.
> The database schema already supports all of them.

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
  outage queue and are exempt. *(Purge job lands in a later pass; the schema and
  indexes are in place.)*
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
  services/
    availability.js      cache + refresh + live verify
    patients.js          existing-patient lookup (PII passthrough, not stored)
    booking.js           booking flow + outage queue (resilience core)
    sync.js              queue replay, reconnect, reconciliation, webhooks
    status.js            Acuity online/offline state
  middleware/
    security.js          helmet/CSP, CORS, rate limits, session gate
    audit.js             audit-log writer
  routes/
    portal.js            public booking API
    webhooks.js          Acuity → Gateway webhook receiver (signature-verified)
  lib/
    token.js             signed short-lived session tokens
    logger.js            structured logging
public/                  the iframe booking portal (vanilla HTML/CSS/JS)
data/                    SQLite files live here (git-ignored)
setup.sh                 deterministic installer (MVP: deps + DB)
```

---

## Deployment (target)

One repo, many deployments — each Lightsail instance pulls the same versioned
code and is differentiated only by `.env`. Tag known-good releases (`v1.0`, …)
and stage rollouts. The deterministic `setup.sh` (not an agent) provisions an
instance; systemd service registration and SSL provisioning are the next pass.

## Regulatory

Handles Australian health information. The retention/purge design implements
APP 11 (destroy/de-identify when no longer needed). This is an engineering
README, not legal advice — confirm obligations before go-live.
