# Hand-off — Phase: bi-directional SMS routing through the Gateway

> Open this in a **fresh Claude Code session** in the Acuity Gateway repo to build
> the next SMS phase. The Gateway already **sends** booking confirmations and
> **receives** replies/receipts (logged only). This phase makes it a real two-way
> SMS router: inbound messages become *actionable* and outbound grows beyond the
> single confirmation. Captured from a code read on **2026-06-15**.

---

## 1. Where SMS is today

**Disabled** — there is no `CELLCAST_API_KEY` in `.env`, so
`config.cellcast.enabled === false`. Outbound sends no-op (logged `skipped` /
`sms_disabled`); bookings work fine without SMS. The Cellcast host
(`https://api.cellcast.com`) is reachable (`HTTP 200`).

**Outbound — built, currently disabled:**
- `src/services/booking.js` fire-and-forgets `sendBookingConfirmation(booking, state)`
  → `src/services/sms.js` → `src/sms/cellcast.js` `sendSms({to, message})`.
- `POST {CELLCAST_API_BASE}/api/v1/gateway`, `Authorization: Bearer <key>`,
  body `{ message, contacts:[+61…], sender? }`. Numbers → E.164 via
  `normalizeAuNumber`. 8s timeout. `providerId` parsed from
  `data.data.queueResponse[0].MessageId`.
- **Best-effort** — an SMS failure never blocks a booking. Every send is written
  to `sms_log` (`sent|failed|skipped`); failures are audited and counted in the
  admin **"SMS failures"** metric.

**Inbound — received, but LOG-ONLY:**
- `src/routes/webhooks.js` → `POST /webhooks/cellcast` (mounted at `/webhooks` in
  `src/server.js`). Cellcast's Receive/Status URLs are set in the **Cellcast
  dashboard** (not via API) and must point at `{PUBLIC_BASE_URL}/webhooks/cellcast`.
- Distinguished by a `type` field: `receive` → `sms_log` direction `inbound`
  (patient reply / MO); `send` → `dlr` (delivery report). Optional HTTP Basic auth
  (`CELLCAST_WEBHOOK_USER/PASS`, constant-time compare); **no HMAC**. Always `200`.
- `recordInboundSms()` only **logs** — it does **not** correlate the message to a
  patient/booking and takes **no action**.

**Store:** `sms_log` (`src/db/schema.sql`): `direction` (`outbound|inbound|dlr`),
`recipient`, `status`, `provider_id`, `booking_id` (link column exists but is
unused for inbound), `error`, `created_at`. Trimmed by the nightly purge
(`SMS_RETENTION_DAYS`, `src/services/purge.js`).

---

## 2. Goal of this phase

Turn the inbound side from passive logging into **routing + action**, and widen
outbound past the single confirmation message:

1. **Correlate inbound → patient/booking.** Map the sender's number to the most
   recent matching `pending_bookings` row (and/or an Acuity client) and store
   `booking_id` on the inbound `sms_log` row.
2. **Parse + act on replies.** Recognise intent (e.g. `YES`/`CONFIRM`,
   `STOP`/`CANCEL`, free text) and decide per intent:
   - confirm → acknowledge;
   - cancel → cancel the appointment **(needs an Acuity cancel endpoint — see §4)**
     and free the slot;
   - anything ambiguous → route to staff in `/admin`, never auto-act.
3. **Outbound beyond confirmation.** Reminders (e.g. day-before), reschedule/cancel
   notices, and optionally free-text staff→patient messages from `/admin`.
4. **Conversations in `/admin`.** A per-patient SMS thread view + an action queue
   for replies that need a human.
5. **Inbound idempotency.** Cellcast may retry a webhook — dedupe on the message
   id (`_id` → `provider_id`) so a reply isn't processed twice.
6. **Opt-out (`STOP`) suppression.** A `STOP` reply must suppress future SMS to
   that number (compliance). Add a suppression list and check it before every send.

---

## 3. Hard constraints (don't skip)

- **Two-way needs a NUMERIC sender.** An alphanumeric `CELLCAST_SENDER_ID` (≤11
  chars) is **one-way — patients cannot reply.** Replies only work with a *number*
  sender (or Cellcast's shared number). Without this the whole inbound phase is
  moot — confirm the clinic's Cellcast plan provides a reply-capable number first.
- **Inbound webhook needs a PUBLIC URL.** Cellcast can't reach `localhost`. Inbound
  is only testable once deployed to Lightsail with a public HTTPS `PUBLIC_BASE_URL`
  (dashboard Receive/Status URLs set), or via a temporary tunnel
  (`tailscale funnel` / ngrok) in dev.
- **API generation.** Code targets **current-gen v1** (`/api/v1/gateway`, Bearer).
  Legacy v3 (`cellcast.com.au/api/v3`, `APPKEY`) has a completely different shape —
  confirm the key is v1. Details: `docs/INTEGRATION_NOTES.md` §Cellcast SMS API.
- **No HMAC** on webhooks — only optional HTTP Basic. Set `CELLCAST_WEBHOOK_USER/PASS`
  and matching dashboard creds in production.
- **Rate limit** ~15 calls/s → `429 OVER_LIMIT`. Queue/throttle bulk sends (reminders).
- **Segments:** GSM 160/153 chars, Unicode 70 — keep messages short.
- **ACMA:** from **1 Jul 2026**, AU alphanumeric sender IDs must be ACMA-registered
  (another reason to use a number sender).
- **PII / APP-11:** message bodies + recipient numbers are patient health PII. Keep
  retention aligned with the existing purge job; don't store bodies longer than needed.

---

## 4. Blockers / decisions to resolve first

- **Reply-to-cancel needs an Acuity cancel endpoint.** The Gateway's Acuity client
  has no cancel/reschedule (listed as "later" in `docs/ACUITY_API_HANDOFF.md`). To
  action a cancellation from a reply, add a cancel endpoint on the **Acuity** side
  first, then wire the Gateway client. Until then, route cancels to staff.
- **Auto-act vs human-in-the-loop.** Decide which intents the system acts on
  automatically vs surfaces in `/admin`. The project's "never a silent overwrite"
  rule (spec #7) argues for surfacing anything ambiguous.
- **Number↔booking matching is fuzzy** (a number may have several bookings, or
  none). Define the matching rule (e.g. nearest upcoming appointment) and the
  fallback when there's no match.

---

## 5. Config (env)

```
CELLCAST_API_KEY=          # current-gen v1 key → enables SMS
CELLCAST_API_BASE=https://api.cellcast.com
CELLCAST_SENDER_ID=        # a NUMBER (for replies) — NOT an alpha ID
CELLCAST_WEBHOOK_USER=     # HTTP Basic on the inbound webhook
CELLCAST_WEBHOOK_PASS=
PUBLIC_BASE_URL=           # public HTTPS base; Cellcast posts to {this}/webhooks/cellcast
```

---

## 6. File map (where to work)

- `src/sms/cellcast.js` — Cellcast v1 client (`sendSms`, `normalizeAuNumber`).
- `src/services/sms.js` — orchestration + `sms_log` writes (`sendBookingConfirmation`,
  `recordInboundSms`). Add routing/intent + suppression checks here.
- `src/routes/webhooks.js` — `POST /webhooks/cellcast` receiver. Add correlation,
  idempotency, and intent dispatch here.
- `src/db/schema.sql` — `sms_log`; add a suppression/opt-out table and (optionally)
  a conversation/thread table.
- `src/routes/admin.js` + `admin/` — thread view + reply action queue.
- `src/services/metrics.js` — add inbound/conversation metrics.
- `docs/INTEGRATION_NOTES.md` §Cellcast — verified API contract.

---

## 7. How to verify

- **Outbound:** set a real v1 key + a number sender, book through the portal with a
  real mobile → expect a confirmation SMS and a `sent` row in `sms_log` (visible in
  `/admin`).
- **Inbound:** deploy (or tunnel) so the webhook is publicly reachable, set the
  dashboard Receive/Status URLs, then reply to a message → expect an `inbound` row
  correlated to the booking and the chosen action (or a staff item in `/admin`).
- No automated tests exist yet — add unit tests for intent parsing and
  number→booking correlation at minimum.

---

## 8. Related docs

- `docs/INTEGRATION_NOTES.md` — verified Cellcast (v1 vs v3) + sender/webhook rules.
- `docs/ACUITY_API_HANDOFF.md` — Acuity contract (needs a cancel endpoint for
  reply-to-cancel).
- `HANDOFF.md` — overall project state.
