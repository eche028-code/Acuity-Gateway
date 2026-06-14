# Integration notes (verified contracts)

Verified against official docs during the build. Capture point for the Acuity
client, the upcoming Cellcast SMS pass, and the security middleware. Treat items
marked *unconfirmed* with care and re-check against your live account.

---

## Acuity Scheduling API

- **Base URL:** `https://acuityscheduling.com/api/v1` (the client prefixes
  `ACUITY_API_BASE` with `/api/v1`; point `ACUITY_API_BASE` at the mock during dev).
- **Auth:** HTTP Basic — username = numeric **User ID**, password = **API key**,
  server-side only (CORS/browser calls are unsupported). `401` on auth failure.
- **Booking flow:** `GET /appointment-types` → `GET /availability/dates?month=&appointmentTypeID=`
  → `GET /availability/times?date=&appointmentTypeID=` → `POST /appointments`.
  Pass the **exact** `time` string returned by `/availability/times` as the
  booking `datetime` (parsed by PHP `strtotime` in the calendar timezone).
- **Create booking required fields:** `datetime`, `appointmentTypeID`,
  `firstName`, `lastName`, `email` (email is "optional for admins" only).
  `phone` may be required per account settings. Without `admin=true`, Acuity
  validates availability and **rejects double-bookings** — this is exactly how we
  detect reconciliation collisions, so we do *not* use `admin=true`.
- **Client lookup:** `GET /clients?search=` filters by first name, last name, or
  phone number (single free-text param; matching semantics undocumented —
  normalise phone and verify the returned number). For appointment lookups by
  phone, `GET /appointments?phone=` is more reliable.
- **Reschedule / cancel** are dedicated sub-endpoints: `PUT /appointments/:id/reschedule`,
  `PUT /appointments/:id/cancel`. The generic `PUT /appointments/:id` only edits
  whitelisted contact fields.
- **Webhooks:**
  - Subscribe via `POST /webhooks` with `{ event, target }` (or the dashboard).
    Events use **dot-notation**: `appointment.scheduled`, `appointment.rescheduled`,
    `appointment.canceled`, `appointment.changed`, `order.completed`.
  - **Asymmetry (easy to get wrong):** the *delivered* payload's `action` field
    uses **short forms** — `scheduled`, `rescheduled`, `canceled`, `changed`
    (only `order.completed` keeps dot-notation). The mock mirrors this.
  - Payload is `application/x-www-form-urlencoded` with `action`, `id`,
    `calendarID`, `appointmentTypeID` — **ids only, not the full object** → re-fetch
    `GET /appointments/:id` if you need details.
  - **Signature:** `x-acuity-signature` = base64 HMAC-SHA256 of the **raw body**
    using the **API key** as the secret. Verify over raw bytes (we parse the raw
    body in `routes/webhooks.js`).
  - Limits: max **25** webhooks/account; target must be reachable on 443/80.
- **Rate limit:** 10 req/s, 20 concurrent per IP → `429`. Refresh loops are
  sequential; add throttling/backoff if the window or type count grows large.

Sources: developers.acuityscheduling.com (quick-start, post/get-appointments,
availability-dates/times, clients, put reschedule/cancel, webhooks).

---

## Cellcast SMS API (for the later SMS pass — not yet wired)

- **Two generations — confirm which your key is for:**
  - **Current (recommended):** base `https://api.cellcast.com`, single endpoint
    `POST /api/v1/gateway` for both single and bulk (multiple numbers in
    `contacts[]`), auth header `Authorization: Bearer {API_KEY}`.
  - **Legacy v3:** base `https://cellcast.com.au/api/v3` (`/send-sms`,
    `/bulk-send-sms`, `/get-responses`, `/inbound-read`), auth header `APPKEY`.
  - Response shapes differ completely — do not mix parsers. (`.env` default
    `CELLCAST_API_BASE` is currently the v3 base; switch to the v1 base if your
    key is current-generation.)
- **Send body (v1):** `message`, `contacts[]` (max 1000; accepts `+61…`/`61…`/`0…`),
  optional `sender` (alphanumeric ≤11 chars **one-way, no replies**, or numeric
  ≤16 digits), `scheduleAt`, `delay` (ms). Normalise AU mobiles to E.164 (`+61…`).
- **Receive / delivery receipts:** configured as **dashboard webhooks** (Receive
  URL + Status URL) — *cannot* be set via API. Payloads are JSON distinguished by
  a `type` field: `receive` (inbound reply) vs `send` (delivery report). Optional
  HTTP Basic Auth on the webhook; **no HMAC** scheme. Always return `200`.
- **Gotchas:** 15 calls/s → `429 OVER_LIMIT`; GSM 160/153 segments, Unicode 70;
  two-way (confirm/cancel replies) needs a **number** sender, not an alpha ID;
  from **1 Jul 2026** alphanumeric sender IDs to AU mobiles must be ACMA-registered
  or show as "Unverified".

Sources: developer.cellcast.com, cellcast.com.au/api/documentation, acma.gov.au.

---

## Edge / iframe security

- **Framing:** allow only the clinic via CSP `frame-ancestors 'self' https://clinic…`
  (include the scheme). `frame-ancestors` replaces `X-Frame-Options` (whose
  `ALLOW-FROM` is dead and `SAMEORIGIN` would block the clinic). helmet's default
  CSP sets `frame-ancestors 'self'` **and** `X-Frame-Options: SAMEORIGIN`, so we
  override the directive and set `xFrameOptions: false`.
- **CORS:** allow only the clinic origin, never `*` with credentials; `Vary: Origin`.
  Separate concern from framing — both are needed.
- **Auth:** cookies are unreliable in cross-site iframes (Safari ITP / Firefox TCP
  block third-party cookies). Use a **short-lived Bearer token** held in iframe
  memory; if handed to the parent, use `postMessage(token, '<clinic origin>')`
  with an explicit `targetOrigin` (never `*`) and verify `event.origin`.
- **trust proxy:** set a **specific hop count** behind Nginx/Lightsail, never blanket
  `true` (a spoofed `X-Forwarded-For` would otherwise defeat per-IP rate limits).
- **SQLite driver:** we use Node's built-in **`node:sqlite`** (`DatabaseSync`) —
  zero native dependencies, so no compiler is needed on Windows or Linux. (We hit
  `better-sqlite3`'s wall: no prebuilt binary for Node 24 on Windows → source
  compile needing the VS C++ toolset, which also rejects paths with spaces.)
  `node:sqlite` is unflagged from Node 24 (hence `.nvmrc` = 24) and prints one
  experimental warning at startup. WAL + `busy_timeout` are set in `db/index.js`.
  To switch back to better-sqlite3 later, pin Node 20 LTS for its prebuilt binaries.

Sources: MDN (CSP frame-ancestors, X-Frame-Options, postMessage, X-Forwarded-For),
OWASP Clickjacking cheat sheet, helmet docs, express-rate-limit docs, better-sqlite3 docs.
