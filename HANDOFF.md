# Acuity Gateway — session hand-off

## What this app is

**Acuity Gateway** is a Node/Express + SQLite app that sits between the public
internet and a clinic's **Acuity** scheduling system. It does two jobs at once:

1. **Patient booking portal** — embeddable as an iframe on the clinic's website.
   Patients browse availability and book here; they never touch Acuity directly.
2. **Security gateway / resilient edge** — it validates, rate-limits, and brokers
   all external traffic, and it keeps taking bookings even when Acuity is offline
   (serves cached availability, queues bookings locally, reconciles on reconnect).

Acuity is the **system of record**; the Gateway is the internet-facing **edge**
(deployed on AWS Lightsail).

> **Real-world context (important):** "Acuity" here is **not** cloud Acuity
> Scheduling (Squarespace). It's a **self-hosted, web-based optometry system the
> clinic runs on-site** (Newman Allied Health & Optometry Clinic, WA). The user
> extended that system (via a separate Claude Code session) with a purpose-built
> HTTP API for this integration. The Gateway reaches it over **Tailscale**.

## Architecture

```
Patients → iframe portal → Gateway (Express, on Lightsail)
                             │   ├── SQLite: availability cache + outage queue + audit
                             │   └── /admin dashboard (password-gated)
                             ↓  over Tailscale, Bearer auth
                          Acuity local API  (:3002/api/gateway/v1)   ← system of record
```

- **Gateway → Acuity is pull/poll** (the Gateway calls Acuity; Acuity does **not**
  push webhooks). Availability is cached and refreshed; `/changes` is polled on a
  cursor to pick up front-desk bookings/cancellations.
- **Resilience:** if Acuity is unreachable, bookings queue locally (the Gateway
  becomes the source of truth) and replay on reconnect; slot collisions surface in
  `/admin` for a human — never a silent overwrite.

## The Acuity API contract (what the Gateway talks to)

- Base `https://<host>:3002/api/gateway/v1`, header `Authorization: Bearer <key>`.
- Endpoints: `GET /health`, `GET /appointment-types`, `GET /availability?appointmentTypeId&from&to`,
  `POST /appointments` (idempotent via `idempotencyKey`; `409` on slot clash),
  `GET /changes?since=<cursor>`, `GET /clients?search=`.
- `503 {error:"gateway_disabled"|"not_configured"}` = "not ready" → Gateway keeps queuing.
- IDs are **UUID strings**; timezone **AWST (+08:00, no DST)**; **self-signed** cert
  on a raw IP/localhost (a real cert is available on the Tailscale hostname).
- Full spec: **`docs/ACUITY_API_HANDOFF.md`**. It's implemented + merged on the Acuity side.

## Current status

**✅ Done & verified**
- Entire Gateway feature set: booking portal, two-store SQLite schema, outage
  queue + reconnect/reconciliation, admin dashboard (auth, live metrics,
  reconciliation report, queue, audit log), Cellcast SMS plumbing, nightly APP-11
  purge job, security perimeter (CSP/CORS, rate limits, Bearer/cookie sessions),
  Lightsail deploy assets (`setup.sh` + systemd unit + nginx site).
- **Live Acuity integration — read paths proven.** Against the real Acuity API,
  every read endpoint returned correct real data whenever Acuity was up: `/health`,
  the 3 real appointment types (**Contact Lens Fit / Follow Up / Standard Eye
  Test**), real availability (62-day cap), `/clients` search, `/changes` cursor.
  Bearer auth and AWST timestamps confirmed.

**🟡 Built but not yet verified end-to-end**
- No sustained green run of the full Gateway (Acuity keeps dropping — see blocker).
- **Booking write-path** (`POST /appointments` + idempotency + `409` conflict) is
  coded but **not yet tested against real Acuity** (it creates a real appointment).
  This is the most important untested path.
- The ongoing `/changes` poll loop hasn't been exercised against a real change.

**⛔ THE BLOCKER (external to the Gateway)**
- The **Acuity server does not stay running** — it comes up, serves correctly for
  seconds to ~2 minutes, then exits and stays down (it has no supervisor). Every
  Gateway failure has been `ECONNREFUSED` (Acuity not listening) — never a Gateway
  bug. Fix guidance for the Acuity side: **`docs/ACUITY_STAYING_UP.md`** (run it
  under a supervisor + find why it exits) and **`docs/ACUITY_CONCURRENCY_FIX.md`**
  (an earlier concurrency-crash hardening, already done on the Acuity side).

**⬜ Not done yet (Gateway side)**
- Production cert: switch from self-signed + `ACUITY_TLS_INSECURE=true` to
  `tailscale serve` on the `*.ts.net` hostname (real cert) and set the flag false.
- Deploy the integrated build to Lightsail (never deployed; `setup.sh` exists).
- Test SMS against a real Cellcast key (currently no-ops cleanly); no automated
  test suite exists; admin MFA is optional/unbuilt.

## Commit state

The full live-integration rebuild is **committed on `main`** as **`bfc5e23`**
(retarget to the clinic's self-hosted Acuity Gateway API), on top of `81f5035`;
a follow-up commit removed the unused `undici` dependency. Neither is pushed yet
(`main` is **ahead of `origin/main`**) — push once there's one clean end-to-end
verification, especially of the booking write-path (`POST /appointments`).

## How to run (dev, on this machine)

- `.env` (git-ignored) currently holds:
  `ACUITY_API_BASE=https://100.70.1.17:3002` (Acuity's Tailscale IP on this PC),
  `ACUITY_API_KEY=<bearer key>`, `ACUITY_TLS_INSECURE=true`.
  ⚠️ The key was pasted into chat during testing — **rotate it** in Acuity → System
  Admin → Gateway.
- `npm install`, then `npm start`. Portal at <http://localhost:3000>, admin at
  `/admin` (set `ADMIN_PASSWORD` in `.env`).
- Acuity must be listening at `100.70.1.17:3002` (or `localhost:3002`). Health check:
  `GET /api/gateway/v1/health` returns `{"ok":true,...}` when healthy.
- **`npm run mock` (`src/acuity/mock-server.js`) is now OBSOLETE** — it speaks the
  old cloud-Acuity contract. Ignore or delete it.

## Key decisions & gotchas

- **`node:sqlite`** (Node built-in), not better-sqlite3 — this Windows box can't
  compile native addons (no VS C++ toolset; spaces in the path). Needs **Node ≥24**.
- Acuity **IDs are stored as TEXT** (UUIDs) — schema changed from INTEGER.
- **TLS-skip is process-wide** via `NODE_TLS_REJECT_UNAUTHORIZED=0` (gated behind
  `ACUITY_TLS_INSECURE`, dev/self-signed only). A scoped custom dispatcher did
  **not** connect to `localhost` reliably (IPv4/IPv6), so the client uses Node's
  global fetch. The `undici` dep briefly added for this has been removed.
- **Lightsail target = 1 GB RAM / 40 GB disk** — `setup.sh` adds swap, caps the
  Node heap, caps journald.
- The Gateway is **backend-agnostic** except `src/acuity/client.js` and the sync
  model — that's the only Acuity-specific layer, by design.

## Doc map

- `README.md` — overview, structure, deploy.
- `docs/ACUITY_API_HANDOFF.md` — the API contract the Acuity side implements.
- `docs/ACUITY_CONCURRENCY_FIX.md` — concurrency crash hardening (Acuity side; done).
- `docs/ACUITY_STAYING_UP.md` — keep the Acuity server running (current blocker).
- `docs/INTEGRATION_NOTES.md` — verified Acuity / Cellcast / security API research.
