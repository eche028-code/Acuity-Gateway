# Acuity ← Gateway inbound SMS (build hand-off)

> **How to use this doc:** open a Claude Code session in the **Acuity** codebase
> and paste this (or point it at this file). It specifies ONE endpoint to add to
> Acuity so patient SMS replies show up in Acuity. Same conventions as
> `ACUITY_API_HANDOFF.md` (§2). Captured **2026-06-15**.

---

## 1. Context — the full inbound path

Patients reply to the clinic's SMS. The flow is now:

```
patient SMS → Cellcast → (webhook) → Gateway → (this endpoint) → Acuity
```

- Cellcast pushes each reply to the Gateway's webhook (live via Tailscale Funnel).
- The Gateway processes it: normalises the number, classifies intent
  (confirm/cancel/stop/unknown), auto-suppresses on STOP (opt-out), correlates it
  to a booking, logs it, and surfaces it in the Gateway `/admin`.
- The Gateway then **forwards** the reply to Acuity by calling the endpoint below
  (best-effort, fire-and-forget). **You need to add this endpoint** for replies to
  land in Acuity.

The Gateway sends only when `FORWARD_INBOUND_SMS_TO_ACUITY=true` (its default).

---

## 2. Endpoint to add

### `POST /api/gateway/v1/sms/inbound`
Same auth as the rest of the contract: `Authorization: Bearer <API_KEY>`, JSON.

**Request body (sent by the Gateway):**
```json
{
  "from": "+61404104011",                 // patient mobile, E.164
  "message": "Yes that works",            // the reply text (PII)
  "receivedAt": "2026-06-15T09:30:00+08:00",
  "providerId": "6a2f...",                // Cellcast message id — DEDUPE ON THIS
  "intent": "confirm",                    // confirm | cancel | stop | unknown
  "appointmentId": "12345",               // Acuity appointment id if known, else null
  "patient": { "firstName": "Jane", "lastName": "Doe" }  // best-effort, may be null
}
```

**Behaviour expected of Acuity:**
- **Be idempotent on `providerId`.** The Gateway already dedupes webhook retries,
  but store `providerId` and ignore a repeat so a re-delivery can't double-post.
- **Link the reply** to the appointment when `appointmentId` is present; otherwise
  match by `from` (normalise digits) / `patient` name, or just file it against the
  patient. If nothing matches, still record it for staff — never drop it.
- **Respond fast** with `200`. Do the heavy work async; the Gateway doesn't block
  on you and treats any error as best-effort (it's already logged Gateway-side).

**Responses:**
```
200 { "ok": true }
401 { "error": "unauthorized" }
```

---

## 3. Things NOT to do (already handled by the Gateway)

- **Don't act on `intent` automatically** (e.g. don't auto-cancel on `"cancel"`).
  The Gateway's rule is "surface to staff, never auto-act on a booking." Show the
  reply + intent to staff and let a human decide. (Auto-cancel would also need the
  cancel endpoint from `ACUITY_SMS_HANDOFF.md` §3 anyway.)
- **Don't try to suppress/opt-out on `"stop"`** — the Gateway already added that
  number to its suppression list and will block future sends. Just display it.
- **Don't reply to Cellcast** — outbound goes back through the Gateway
  (`POST /internal/sms/send`, see `ACUITY_OUTBOUND_SMS_HANDOFF.md`).

---

## 4. Security / PII (same as base contract §7)

- Bearer-key check (constant-time) on this route; Tailscale-only binding.
- `message` + `from` are patient health PII — minimal logging, your normal
  retention. Don't log the full body.

---

## 5. How it's verified (Gateway side)

Once this endpoint exists, a real patient reply will: arrive at the Gateway
webhook → appear in Gateway `/admin` → POST to this endpoint → show up in Acuity.
If the endpoint is missing/erroring, the Gateway logs a `forward_inbound` audit
failure but still keeps the reply in `/admin` (nothing is lost).

---

## 6. Related docs
- `ACUITY_API_HANDOFF.md` — base Gateway↔Acuity contract.
- `ACUITY_OUTBOUND_SMS_HANDOFF.md` — Acuity → Gateway send (`/internal/sms/send`).
- `ACUITY_SMS_HANDOFF.md` — front-desk reminder coverage + cancel/reschedule.
