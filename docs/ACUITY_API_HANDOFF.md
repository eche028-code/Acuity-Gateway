# Acuity ↔ Gateway Sync API — build hand-off

> **How to use this doc:** open a Claude Code session in the **Acuity** codebase
> and paste this (or point it at this file). It specifies an HTTP API to add to
> Acuity that an external booking app ("Acuity Gateway") will call. It is
> deliberately **stack-agnostic** — implement each endpoint against Acuity's own
> data model. You can build it incrementally: start with the config + auth
> scaffolding (§6) and `GET /health`, then the read endpoints, then create, then
> changes. **Do not skip §3.4 idempotency/conflict behaviour or §7 security.**

---

## 1. Context — why this exists

- **Acuity** is the clinic's local scheduling system and the **system of record**.
- **Gateway** is a separate, public, internet-facing patient booking portal
  (hosted on AWS Lightsail). Patients book through the Gateway; they never touch
  Acuity directly. The Gateway is the security perimeter.
- The Gateway calls **into** Acuity over a private **Tailscale** mesh. Acuity is
  not otherwise exposed to the network. **This API is that interface.**
- The Gateway keeps a local availability cache and an **outage queue**: if it
  can't reach Acuity, patients still book into the Gateway, and it **replays**
  those bookings to Acuity once it's reachable again. Two consequences you MUST
  honour (details in §3.4):
  1. **Create is idempotent** — a replayed booking must never create a duplicate.
  2. **Create rejects double-bookings** — so the Gateway can detect conflicts.

This is **Australian patient health information** — treat all of it as sensitive
(see §7).

---

## 2. Conventions

- **Base path:** `/api/gateway/v1`
- **Auth:** every request carries `Authorization: Bearer <API_KEY>` (see §6).
  Missing/invalid → `401 {"error":"unauthorized"}`.
- **Format:** JSON in and out (`Content-Type: application/json`).
- **Datetimes:** ISO 8601 **with timezone offset**, in the clinic's timezone —
  **AWST, `+08:00`, no daylight saving** (Western Australia). Example:
  `2026-06-20T09:00:00+08:00`. *(If the clinic is ever in another zone, make the
  offset configurable — but always send an explicit offset.)*
- **IDs:** strings (e.g. `"12345"`) — don't assume integers.
- **Errors:** `{ "error": "<machine_code>", "message": "<human text>" }` with an
  appropriate HTTP status.

---

## 3. Endpoints

### 3.1 `GET /health`
Cheap liveness probe (the Gateway pings this to detect up/down).
```
200 { "ok": true, "time": "2026-06-20T09:00:00+08:00" }
```

### 3.2 `GET /appointment-types`
The bookable services, for the portal.
```
200 {
  "appointmentTypes": [
    {
      "id": "1",
      "name": "Initial Eye Exam",
      "durationMinutes": 30,
      "active": true,
      "practitionerIds": ["1", "2"]      // who offers this type (optional)
    }
  ],
  "practitioners": [                       // optional; include if Acuity has them
    { "id": "1", "name": "Dr Smith" }
  ]
}
```

### 3.3 `GET /availability`
Open slots the Gateway can render and cache.
**Query:** `appointmentTypeId` (required), `from`=`YYYY-MM-DD` (required),
`to`=`YYYY-MM-DD` (required), `practitionerId` (optional).
```
200 {
  "slots": [
    {
      "start": "2026-06-20T09:00:00+08:00",   // CANONICAL slot identifier
      "durationMinutes": 30,
      "appointmentTypeId": "1",
      "practitionerId": "1"
    }
  ]
}
```
- Return **only open** slots within the clinic's bookable window.
- `start` is the slot's identity. The Gateway passes it back **verbatim** when
  booking — so accept exactly what you emit here.

### 3.4 `POST /appointments`  ← the important one
Create a booking. **Must be idempotent and must reject double-books.**

**Request body:**
```
{
  "idempotencyKey": "b1c2...-uuid",          // REQUIRED — see below
  "appointmentTypeId": "1",
  "practitionerId": "1",                      // optional if the type implies one
  "start": "2026-06-20T09:00:00+08:00",       // a value returned by /availability
  "patient": {
    "firstName": "Jane",
    "lastName": "Doe",
    "phone": "0412345678",
    "email": "jane@example.com",
    "isNew": false,                           // true => new patient, create record
    "dateOfBirth": "1990-01-01",              // optional
    "address": "1 Main St", "suburb": "Newman",
    "state": "WA", "postcode": "6753",
    "notes": "optional"
  }
}
```

**Behaviour:**
- **Idempotency (required):** persist `idempotencyKey` against the created
  appointment. If a request arrives with a key you've **already** created an
  appointment for, return `200` with that **same** appointment — do NOT create a
  second one. (The Gateway replays queued bookings after an outage; without this
  you'd get duplicates.)
- **Double-book rejection (required):** if the slot is no longer available,
  return `409 {"error":"slot_unavailable"}`. The Gateway relies on this to detect
  conflicts and surface them for staff.
- **Patient matching:** match an existing patient (e.g. by phone) or create a new
  one when `isNew` is true / there's no match — per Acuity's own rules.

**Responses:**
```
201 {                                          // newly created
  "appointmentId": "12345",
  "status": "booked",
  "start": "2026-06-20T09:00:00+08:00",
  "idempotencyKey": "b1c2...-uuid"
}

200 { ...same shape... }                        // idempotent replay (already existed)

409 { "error": "slot_unavailable", "message": "That time is no longer available." }
422 { "error": "validation", "fields": ["start"] }
```

### 3.5 `GET /changes`
Incremental feed of appointment changes made **in Acuity** (front-desk bookings,
reschedules, cancellations). This is how the Gateway stays in sync and reconciles
— it polls this every ~15–30s.

**Query:** `since`=`<cursor>` (omit/empty on first call), `limit` (default 200).
```
200 {
  "cursor": "1718870400000-12345",   // opaque; pass back as `since` next time
  "changes": [
    {
      "type": "created",              // created | updated | cancelled
      "appointmentId": "12345",
      "appointmentTypeId": "1",
      "practitionerId": "1",
      "start": "2026-06-20T09:00:00+08:00",
      "durationMinutes": 30,
      "source": "frontdesk",          // frontdesk | gateway | other
      "idempotencyKey": "b1c2...",    // present if it originated from the Gateway
      "updatedAt": "2026-06-20T08:55:00+08:00"
    }
  ]
}
```
- **Cursor:** opaque, monotonic (e.g. `updatedAt`-millis + id, or a sequence
  number). `since` empty → return the **current** cursor and an **empty**
  `changes` list ("start watching from now"). `since=<cursor>` → all changes with
  sequence greater than that cursor, plus the new cursor.
- **`source`** lets the Gateway recognise its own bookings echoing back (skip
  them) vs. front-desk changes it must react to. **`idempotencyKey`** (when the
  change came from a Gateway booking) lets it correlate exactly.

### 3.6 `GET /clients`
Patient lookup for the booking form autofill.
**Query:** `search` = phone number or name.
```
200 {
  "matches": [
    { "patientId": "999", "firstName": "Jane", "lastName": "Doe",
      "phone": "0412345678", "email": "jane@example.com" }
  ]
}
```
- Return **minimal** fields only. Match by phone (normalise digits — strip
  spaces/`+61`/leading `0`) and by name. Don't log the raw search term.

### 3.7 (Later) cancel / reschedule
`PUT /appointments/{id}/cancel` and `PUT /appointments/{id}/reschedule` — not
needed for the first cut; note them as planned.

---

## 4. Config section to add to Acuity (your original ask)

A settings section storing:
- **`gatewayApiKey`** — a long random secret (≥32 bytes). The API requires it on
  every request. Provide a "generate" + "rotate" affordance and show it once.
- **`apiListenAddress`** — the bind address. **Default to the machine's Tailscale
  IP (`100.x.x.x`)**, *not* `0.0.0.0`. Plus **`apiListenPort`** (e.g. `8088`).
- **`allowedClientIp`** *(optional, recommended)* — the Gateway's Tailscale IP;
  reject requests from any other source.
- **`apiEnabled`** — an on/off toggle.

Implementation shape depends on Acuity's stack (see §8): if Acuity already runs
an HTTP server, add these as routes under `/api/gateway/v1`; if not, run a small
companion HTTP service that shares Acuity's database. Either way it must bind only
to the Tailscale interface.

---

## 5. Why idempotency & conflict rejection matter (don't optimise these away)

The Gateway is built to keep taking bookings while Acuity is offline, then replay
them. So:
- The same booking may be **POSTed more than once** (a success whose response was
  lost, then a retry). The `idempotencyKey` is what makes the retry safe.
- The Gateway must be able to tell "**Acuity refused because the slot's gone**"
  (→ `409`) apart from "Acuity is unreachable" (network error). Always return a
  clean `409` for an unavailable slot rather than a 500 or a silent success.

---

## 6. Auth (precise)

- Read `Authorization: Bearer <token>`. Compare `<token>` to `gatewayApiKey` with
  a **constant-time** comparison. Mismatch/missing → `401`.
- If `allowedClientIp` is set, also verify the request's source IP matches it.
- Apply this to **every** `/api/gateway/v1/*` route, including `/health`.

---

## 7. Security requirements (this is patient health data)

- **Bind only to the Tailscale interface** (or localhost behind a reverse proxy
  that is itself Tailscale-only). **Never** `0.0.0.0` / the public internet / the
  open clinic LAN.
- Lock it further with a **Tailscale ACL** so only the Gateway node can reach the
  port, and (optionally) the `allowedClientIp` check above.
- Constant-time API-key check; support key rotation.
- Expose **only** the endpoints in §3 — least privilege, no admin surface.
- **Never** log full patient PII or the API key. Keep request logs minimal.
- Emit all datetimes with the explicit `+08:00` offset.

---

## 8. What to determine from the Acuity codebase first

Before implementing, have Claude Code establish (from Acuity's own code):
1. **Language/framework + how Acuity serves HTTP** (can it host these routes, or
   do we add a small companion service?).
2. **The database** and the tables/models for: appointments, appointment types /
   services, practitioners/calendars, patients, and how **availability** is
   computed (working hours, durations, existing bookings).
3. **How timezones are handled** internally (so slots round-trip correctly).
4. Whether a **patient phone index** exists (for `/clients` search).
5. Where to **persist `idempotencyKey`** and the **changes cursor/sequence**
   (a new column/table is fine).

---

## 9. Suggested build order

1. Config section (§6) + auth middleware + `GET /health`.
2. `GET /appointment-types` and `GET /availability` (read-only — easy to verify).
3. `POST /appointments` **with idempotency + 409 on unavailable** (§3.4).
4. `GET /changes` (cursor feed).
5. `GET /clients` search.
6. Later: cancel / reschedule.

---

## 10. The other side

The Gateway team (me) will build the Gateway's client to **exactly this
contract** (replacing its current cloud-Acuity client) and point it at
`http://<acuity-tailscale-ip>:<port>/api/gateway/v1` with the API key. If you
need to deviate from any shape here, tell me the change and I'll match it — the
two sides must agree.
