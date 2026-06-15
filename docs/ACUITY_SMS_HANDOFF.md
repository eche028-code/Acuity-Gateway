# Acuity ↔ Gateway — SMS-phase additions (build hand-off)

> **How to use this doc:** open a Claude Code session in the **Acuity** codebase
> and paste this (or point it at this file). It extends the base contract in
> `ACUITY_API_HANDOFF.md` with the two things the Gateway's **bi-directional SMS**
> phase needs from Acuity. It is stack-agnostic — implement against Acuity's own
> data model, same conventions as the base contract (§2 there). Captured from a
> Gateway-side code read on **2026-06-15**.
>
> **Neither item blocks the Gateway.** The SMS layer is already built and works
> today for **portal-booked** appointments. These additions widen SMS to cover
> **front-desk** appointments (Ask A) and enable **reply-to-cancel** (Ask B).

---

## 1. Context — what the Gateway can and can't do today

The Gateway now:
- sends booking confirmations and **day-before reminders**;
- receives inbound SMS replies, classifies intent (`confirm`/`cancel`/`stop`/
  `unknown`), auto-suppresses on `STOP` (opt-out compliance), dedupes retries, and
  surfaces every reply in a `/admin` action queue + per-patient thread;
- **never auto-acts on a booking** — cancels/ambiguous replies go to staff.

**The limitation:** the Gateway only knows about appointments in its **own** store
(`pending_bookings`) — i.e. portal bookings plus replayed outage-queue bookings.
The `GET /changes` feed it polls (base contract §3.5) carries only **slot identity**
(`appointmentTypeId` + `start`), no patient contact details, and the Gateway applies
those changes to its **availability cache only** — it does not record the
appointment or the patient.

Consequences for SMS:
- **Reminders** fire only for portal-booked appointments — a patient booked at the
  **front desk gets no reminder.**
- **Inbound correlation**: a reply from a front-desk patient won't match a booking,
  so it's logged + surfaced to staff **uncorrelated** (still actionable, just
  without an attached appointment).

Asks A and B below close those gaps. **If portal-only SMS is acceptable for v1, no
Acuity change is needed** — skip to §5.

---

## 2. Ask A — let the Gateway see upcoming appointments + patient phone

This is what unlocks reminders (and reply-correlation) for **all** appointments.
Pick whichever fits Acuity best; the Gateway will match the shape you finalize.

### A1 (preferred) — `GET /api/gateway/v1/appointments`
A read of upcoming appointments, including the patient's phone. Pull-based, so PII
is fetched on demand (lower residency than streaming) and it doubles as the
**cold-start backfill** that A2 alone can't provide (see the note below).

**Query:** `from`=`YYYY-MM-DD` (required), `to`=`YYYY-MM-DD` (required),
`practitionerId` (optional).
```
200 {
  "appointments": [
    {
      "appointmentId": "12345",
      "appointmentTypeId": "1",
      "practitionerId": "1",
      "start": "2026-06-20T09:00:00+08:00",
      "durationMinutes": 30,
      "status": "booked",                 // booked | cancelled
      "source": "frontdesk",              // frontdesk | gateway | other
      "idempotencyKey": "b1c2...",        // present if it originated from the Gateway
      "patient": {
        "firstName": "Jane",
        "lastName": "Doe",
        "phone": "0412345678"             // any AU format — the Gateway normalizes
      }
    }
  ]
}
```
- Return **booked** (non-cancelled) appointments whose `start` falls in `[from,to]`.
- Phone is the only contact field the Gateway needs for SMS; name is for the staff
  thread display. **No email/address/DOB** — least privilege.

### A2 (alternative) — enrich the `/changes` feed
Add a `patient` block to each `created`/`updated`/`cancelled` entry in the existing
`GET /changes` (base §3.5):
```
"patient": { "firstName": "Jane", "lastName": "Doe", "phone": "0412345678" }
```
- Real-time, but it **streams patient PII continuously** over the feed and requires
  the Gateway to mirror every appointment locally.
- **Cold-start gap:** `/changes` starts watching "from now" (empty `since` returns
  the current cursor + empty list), so appointments that **already exist** when the
  feature turns on never appear. A2 therefore needs a one-time backfill anyway —
  which is exactly A1. **Prefer A1**; do A2 on top only if you want sub-minute
  correlation of brand-new front-desk bookings.

### Already available — number → patient
`GET /clients?search=<phone>` (base §3.6) already maps a number to a patient. If you
don't do A1/A2, the Gateway can still use this to attach a **patient name** to an
inbound reply — but it cannot drive **reminders** (which need to know upcoming
appointments ahead of time). Reminders specifically require A1 (or A2 + backfill).

---

## 3. Ask B — cancel / reschedule (the §3.7 "later" endpoints)

Needed to **action** a cancellation/reschedule from an SMS reply. Until these exist
the Gateway routes cancel replies to the staff queue and a human cancels in Acuity.

### `PUT /api/gateway/v1/appointments/{id}/cancel`
```
Request (body optional):
{ "reason": "patient_sms", "idempotencyKey": "uuid" }

200 { "appointmentId": "12345", "status": "cancelled", "start": "2026-06-20T09:00:00+08:00" }
404 { "error": "not_found" }
```
- **Idempotent:** cancelling an already-cancelled appointment returns `200` with
  `status:"cancelled"` (not an error) — the Gateway may retry.
- The cancellation **must also surface in `/changes` as a `cancelled` entry** so the
  Gateway reopens the freed slot in its availability cache (it already handles this).

### `PUT /api/gateway/v1/appointments/{id}/reschedule`
```
Request:
{ "start": "2026-06-21T10:00:00+08:00", "practitionerId": "1", "idempotencyKey": "uuid" }

200 { "appointmentId": "12345", "status": "booked", "start": "2026-06-21T10:00:00+08:00" }
409 { "error": "slot_unavailable", "message": "That time is no longer available." }
404 { "error": "not_found" }
```
- Reject to `409` if the new slot is taken (same rule as create, base §3.4).
- Must surface in `/changes` (frees the old slot, takes the new one).

---

## 4. Decisions to resolve first

- **PII / APP 11.** Asks A/B mean patient phone numbers leave Acuity for the
  Gateway. Confirm that's acceptable. A1 (pull-based) minimizes residency vs A2
  (continuous stream). The Gateway already treats SMS bodies + numbers as health
  PII and purges them on a retention window.
- **Scope.** Do reminders + correlation need to cover front-desk appointments, or
  is **portal-only acceptable for v1?** If portal-only → do nothing here.
- **Cancel policy.** Who may cancel via the Gateway, and is there a notice-window
  cutoff (e.g. no cancel <2h before)? The Gateway can enforce a window too — tell
  me the rule. Note: the Gateway itself **never auto-cancels** without an explicit
  product decision; cancel replies surface to staff until you say otherwise.

---

## 5. Security / PII (unchanged from the base contract §7)

- Bind only to the **Tailscale** interface; constant-time Bearer check on every
  route incl. these new ones; optional `allowedClientIp`.
- Return **minimal** fields (phone + name only); **never log** full PII or the key.
- All datetimes carry the explicit **`+08:00`** (AWST) offset.

---

## 6. How this gets verified (Gateway side)

- **Reminders:** once A1 lands, the Gateway queries tomorrow's appointments each
  morning and texts a reminder to any with a phone (respecting opt-out + idempotent
  per appointment).
- **Correlation:** an inbound reply from a front-desk patient resolves to their
  upcoming appointment in `/admin`.
- **Reply-to-cancel:** with Ask B live, a confirmed cancel intent can cancel in
  Acuity and the freed slot reopens via `/changes`.

I'll build the Gateway client to **exactly** whatever shapes you finalize — if you
need to deviate from anything here, tell me and I'll match it. The two sides must
agree.

---

## 7. Related docs

- `ACUITY_API_HANDOFF.md` — the base Acuity↔Gateway contract (this extends §3.5/§3.7).
- `SMS_BIDIRECTIONAL_HANDOFF.md` — the Gateway-side SMS phase this supports.
- `INTEGRATION_NOTES.md` — Cellcast + sender/webhook rules.
