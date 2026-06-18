# Acuity SMS hub (right-rail) — build hand-off

> **How to use this doc:** open a Claude Code session in the **Acuity** codebase
> and paste this (or point it at this file). It specifies a new **SMS hub** in the
> Acuity appointment-booking UI that surfaces patient SMS replies and routes staff
> into the patient profile to handle them. The data comes from the **Gateway** over
> the same Bearer-gated `/internal` API Acuity already uses to *send* SMS — Acuity
> needs **no** Cellcast key and **no** new SMS store of its own. Same conventions as
> `ACUITY_OUTBOUND_SMS_HANDOFF.md`. Captured **2026-06-18**.

---

## 1. What to build (the request)

> "We can send and receive SMS again — we need a hub to display received SMS
> messages. Under **To-Dos** in the right rail, add an **SMS** icon. Clicking a new
> SMS takes us directly to the **patient profile** so we can see/handle the full
> conversation history."

So, two pieces:

1. **The hub** — an **SMS** entry in the appointment-booking **right rail, directly
   under "To-Dos"**, with an unread badge. Opening it lists recent inbound patient
   replies (sender, preview, time, intent), newest first.
2. **Click-through** — clicking a message opens that **patient's profile** and shows
   the **full conversation** (inbound + the clinic's sent messages), where staff
   reply. Opening it clears the unread badge for that patient.

The Gateway is the **single source of truth** for SMS: every inbound reply (webhook
+ poll backfill + history) and every sent message already lives there. The hub and
the patient-profile conversation both **read from the Gateway** — so the hub shows
complete history immediately, with nothing to migrate and no local mirror to keep in
sync. (Building the inbound *receiver* from `ACUITY_INBOUND_SMS_HANDOFF.md` Task 1 is
**no longer required for the hub**; it's optional if you separately want a local copy.)

---

## 2. The Gateway endpoints to call (now live)

Same channel as outbound (`ACUITY_OUTBOUND_SMS_HANDOFF.md` §2):

- **Base URL:** the Gateway host.
  - Dev / same machine: `http://localhost:3000`
  - Prod: over **Tailscale** — `http://<gateway-tailscale-host>:3000` (not the public
    booking domain).
- **Auth:** `Authorization: Bearer <GATEWAY_INBOUND_API_KEY>` on every request — the
  **same key** Acuity already uses for `/internal/sms/send`. Store it in Acuity config,
  never hard-coded.
- **Format:** JSON in/out. Verify reachability first with `GET /internal/ping`.

All four endpoints below are `/internal/*` (Bearer-gated; `401` on bad key, `503`
when the Gateway has no key set).

### `GET /internal/sms/inbound` — the hub feed
Recent inbound replies, newest first. Drives the list **and** the badge.

Query params (all optional):
- `unhandledOnly=1` — only replies still needing a human (what the **badge** counts).
- `since=<ISO8601>` — only replies newer than this (incremental polling).
- `limit=<1..200>` — default `50`.

```
200 {
  "unhandledCount": 3,                 // total inbound still "open" — use for the badge
  "messages": [
    {
      "id": 482,                       // sms_log row id — pass to /internal/sms/handled
      "from": "+61404104011",          // normalized E.164 — match this to a patient/client
      "body": "Yes that works",        // reply text (PII)
      "intent": "confirm",             // confirm | cancel | stop | unknown
      "receivedAt": "2026-06-18T09:30:00.000Z",
      "handled": false,                // false = still "needs attention"
      "bookingId": "b1c2…|null",       // Gateway pending_bookings id, if it correlated one
      "patient": { "firstName": "Jane", "lastName": "Doe" } | null,  // best-effort; portal/queued bookings only
      "appointmentAt": "2026-06-20T09:00:00+08:00" | null
    }
  ]
}
```
> `patient`/`appointmentAt` are **best-effort** — the Gateway only knows them for
> portal/queued bookings. For a front-desk patient they're `null`; resolve the patient
> yourself from `from` (see §3). Always show the message even when unmatched.

### `GET /internal/sms/thread?number=<AU mobile>` — one patient's conversation
Full thread (inbound + outbound), **oldest first** — what the patient profile renders.
`number` may be any AU format; the Gateway normalizes it.

```
200 {
  "number": "+61404104011",
  "messages": [
    { "id": 480, "direction": "inbound",  "body": "…", "intent": "unknown", "status": "received", "createdAt": "…" },
    { "id": 481, "direction": "outbound", "body": "…", "intent": null,      "status": "sent",     "createdAt": "…" }
  ]
}
400 { "error": "bad_number" }          // unparseable number
```

### `POST /internal/sms/handled` — clear the "needs attention" flag
Call when staff open the conversation, so the badge decrements.
```
Request: { "id": 482 }                 // one reply
     or  { "number": "0404104011" }    // ALL open replies for that patient (recommended on profile open)

200 { "ok": true, "handled": 1 }       // how many rows were flipped open → handled
400 { "error": "missing_target" }      // neither id nor number provided
```
> Idempotent: handling an already-handled reply returns `handled: 0`, not an error.

### `POST /internal/sms/send` — staff reply (unchanged, see `ACUITY_OUTBOUND_SMS_HANDOFF.md`)
```
Request: { "to": "0404104011", "message": "…", "bookingId": "optional" }
200 { "ok": true, "providerId": "…", "to": "+61404104011" }
409 { "error": "suppressed" }          // patient replied STOP — don't retry; tell staff
502 { "error": "send_failed" }   503 { "error": "sms_disabled" | "not_configured" }
```

---

## 3. UI behaviour to implement (Acuity side)

**Right-rail entry**
- Add **SMS** directly under **To-Dos** (icon + label), with a small **badge** =
  `unhandledCount` from `GET /internal/sms/inbound?unhandledOnly=1` (or read it off the
  full feed response — every feed response includes `unhandledCount`).
- **Live-refresh the badge/list** while the booking screen is open: poll every
  **15–30s** and refetch on window/tab focus (same pattern as
  `ACUITY_SMS_TASKS_HANDOFF.md` Task 2). Use `since=<lastSeen>` to fetch only new ones.

**Hub panel (on click of the SMS entry)**
- List recent replies from `GET /internal/sms/inbound` — show sender (patient name if
  you can resolve it, else the number), a body preview, relative time, and an **intent
  chip** (confirm / cancel / **stop** / unknown). Sort newest first; visually flag
  rows where `handled === false`.

**Click a message → patient profile**
- Resolve `from` (E.164) to an Acuity patient/client (you already do this for the SMS
  panel; normalize digits — strip `+61`/leading `0` as needed). Navigate to that
  **patient's profile**.
  - **No match?** Still let staff open the message (show the raw number + body) so a
    reply is never lost; offer "find/create patient" from there.
- On profile open, call `POST /internal/sms/handled { number }` to clear that patient's
  unread count, and refresh the badge.

**Patient-profile conversation**
- Render the thread from `GET /internal/sms/thread?number=…` (inbound + outbound,
  oldest first). This is the **full history** — don't rely on a local store.
- Staff reply via `POST /internal/sms/send`. On `200`, optimistically append the
  outbound message (or refetch the thread) so it appears immediately
  (`ACUITY_SMS_TASKS_HANDOFF.md` Task 3). On non-200, surface the error and **don't**
  show it as sent (esp. `409 suppressed` → "patient opted out").

---

## 4. Things NOT to do (handled Gateway-side)

- **Don't hold the Cellcast key** or call Cellcast directly — inbound arrives at the
  Gateway; outbound goes through `/internal/sms/send`.
- **Don't auto-act on `intent`** (no auto-cancel/confirm). The hub *surfaces* replies
  for a human; that's the whole model.
- **Don't implement opt-out** — a `STOP` reply is already suppressed Gateway-side. Just
  display it (intent `stop`) so staff see why future sends are blocked.
- **Don't build a parallel inbound store** just for the hub — read the Gateway thread.

---

## 5. Security / PII

- Bearer key on every `/internal` call; reach the Gateway only over **Tailscale** in
  prod (not the public domain). The key can send SMS on the clinic's account — treat
  it as a secret, keep it in config.
- `from` + `body` are patient health PII. Minimal logging; rely on the Gateway's
  retention purge for SMS history (don't copy bodies into long-lived Acuity logs).

---

## 6. How to verify

1. `GET /internal/ping` from the Acuity host returns `200 {ok:true}` (reachability + key).
2. Send yourself a reply to the clinic number → it appears in
   `GET /internal/sms/inbound` and the right-rail **SMS** badge increments within the
   poll interval.
3. Click it → land on the patient profile, see the full thread from
   `GET /internal/sms/thread`, and the badge decrements (handled).
4. Reply from the profile → `200`, the message shows in the conversation, and the
   patient receives it.

Quick manual check (from the Acuity host):
```
curl -H "Authorization: Bearer <GATEWAY_INBOUND_API_KEY>" \
  "http://<gateway-host>:3000/internal/sms/inbound?unhandledOnly=1"

curl -H "Authorization: Bearer <GATEWAY_INBOUND_API_KEY>" \
  "http://<gateway-host>:3000/internal/sms/thread?number=0404104011"
```

> **Gateway must be restarted** after pulling the code that adds these routes
> (`/internal/sms/inbound`, `/internal/sms/thread`, `/internal/sms/handled`).

---

## 7. Related docs
- `ACUITY_OUTBOUND_SMS_HANDOFF.md` — the `/internal` channel + `POST /internal/sms/send`.
- `ACUITY_SMS_TASKS_HANDOFF.md` — Tasks 2 & 3 (live-refresh + show sent message); the
  same patterns apply to the hub. Task 1 (inbound receiver) is now **optional** for the hub.
- `ACUITY_INBOUND_SMS_HANDOFF.md` — the (optional) Acuity-local inbound receiver.
- `ACUITY_API_HANDOFF.md` — base Gateway↔Acuity contract.
