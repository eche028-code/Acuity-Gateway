# Acuity → Gateway outbound SMS — build hand-off

> **How to use this doc:** open a Claude Code session in the **Acuity** codebase
> and paste this (or point it at this file). It explains how Acuity should send a
> patient SMS by calling the Gateway, and why the current attempt failed. Captured
> **2026-06-15**.

---

## 1. What went wrong (diagnosis)

Symptom: staff sent an SMS from inside Acuity → the message **disappeared**, the
patient got **nothing**, and **Cellcast never received it**.

Cause: **it is not the Cellcast API key, and not really an Acuity bug — the path
didn't exist.** The intended design is `Acuity → Gateway → Cellcast → patient`,
but the Gateway had **no endpoint for Acuity to call**, so Acuity's request hit
nothing (most likely a 404 that the Acuity UI swallowed — hence the message just
vanishing). Nothing was ever dispatched.

Two things to internalise:
- **Acuity does NOT talk to Cellcast and must NOT hold the Cellcast key.** The
  Gateway owns the Cellcast integration (key, sender, opt-out suppression,
  logging). Acuity's job is only to call the Gateway.
- The Gateway → Cellcast leg is **already verified working** (a test SMS was
  delivered). The only missing piece was the Acuity → Gateway leg, which now
  exists (see §2).

---

## 2. The endpoint to call (now live on the Gateway)

The Gateway now exposes an internal, server-to-server API:

- **Base URL:** the Gateway host.
  - Dev / same machine: `http://localhost:3000`
  - Prod: reach the Gateway over **Tailscale** — `http://<gateway-tailscale-host>:3000`
    (the same mesh Acuity already exposes its own API on). Do **not** use the
    public booking domain for this.
- **Auth:** `Authorization: Bearer <GATEWAY_INBOUND_API_KEY>` on every request.
- **Format:** JSON in/out.

### `GET /internal/ping` — connectivity + auth check
Use this FIRST to prove Acuity can reach the Gateway and the key is right.
```
200 { "ok": true, "smsEnabled": true, "sender": null }
401 { "error": "unauthorized" }        // missing/wrong key
503 { "error": "not_configured" }      // Gateway has no GATEWAY_INBOUND_API_KEY set
```

### `POST /internal/sms/send` — send a patient SMS
```
Request body:
{
  "to": "0404104011",         // patient mobile, any AU format — Gateway normalizes to +61
  "message": "Your text...",  // <= 1000 chars
  "bookingId": "optional"     // optional Gateway pending_bookings id to link the message
}

200 { "ok": true, "providerId": "6a2f...", "to": "+61404104011" }   // sent to Cellcast
400 { "error": "bad_number" | "empty_message" | "too_long" }
401 { "error": "unauthorized" }
409 { "error": "suppressed" }      // patient opted out (replied STOP) — do not retry
502 { "error": "send_failed" }     // Cellcast rejected/unreachable; message has detail
503 { "error": "sms_disabled" | "not_configured" }
```

---

## 3. The shared key

Set the SAME secret on both sides:
- **Gateway:** already set in its `.env` as `GATEWAY_INBOUND_API_KEY`.
- **Acuity:** store this value in Acuity's config (NOT hard-coded) and send it as
  the Bearer token.

```
GATEWAY_INBOUND_API_KEY=5eb422c5ba4b082bbe13a437e7ab1d6b13b7c71c297b7e2e
```

Treat it as a secret (it can send SMS on the clinic's account). It was shared via
this doc, so **rotate it** once both sides are wired: regenerate on the Gateway
(`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`),
update both `.env`s, restart.

---

## 4. What to build / fix on the Acuity side

1. **Point the "send SMS" action at the Gateway.** `POST {gatewayBase}/internal/sms/send`
   with the Bearer header and `{ to, message }`. Remove any direct-to-Cellcast
   call and any Cellcast key from Acuity — that's the Gateway's job.
2. **Stop swallowing the result.** The "message disappeared" means the UI cleared
   without checking the response. Only show *sent* on `200 { ok: true }`; on
   non-200, surface the error (esp. `409 suppressed` → tell staff the patient
   opted out; `502/503` → Gateway/Cellcast problem).
3. **Verify reachability first** with `GET /internal/ping`. If that fails, it's a
   network/Tailscale or key problem, not a send problem.
4. **Config, not code:** the Gateway base URL and the Bearer key belong in Acuity's
   settings/env (like its other secrets), never committed.

### Quick manual test (from the Acuity host)
```
curl -H "Authorization: Bearer 5eb422c5ba4b082bbe13a437e7ab1d6b13b7c71c297b7e2e" \
  http://<gateway-host>:3000/internal/ping

curl -X POST http://<gateway-host>:3000/internal/sms/send \
  -H "Authorization: Bearer 5eb422c5ba4b082bbe13a437e7ab1d6b13b7c71c297b7e2e" \
  -H "Content-Type: application/json" \
  -d '{"to":"0404104011","message":"Test from Acuity via Gateway."}'
```
A `200 {"ok":true,"providerId":...}` means it reached Cellcast.

---

## 5. Notes / current state

- **Sender number:** the Gateway is currently sending from Cellcast's **shared
  number** because the clinic number `0439343382` isn't yet registered as a sender
  in Cellcast (it returned *"sender id is not registered"*). Outbound works from
  the shared number; to send from the clinic's own number (and to enable patient
  **replies** later), register it in Cellcast and uncomment `CELLCAST_SENDER_ID`
  on the Gateway. This is a Gateway/Cellcast config item — Acuity needs no change.
- **Security (prod):** `/internal/*` is Bearer-gated and disabled when unkeyed,
  but it currently shares the Gateway's port. In production, restrict `/internal`
  to the Tailscale interface (nginx allow/deny or firewall) so it isn't reachable
  from the public booking domain.
- **Reach + restart:** after pulling the Gateway code (commit on `main`), the
  Gateway process must be **restarted** to serve `/internal`. Acuity must be able
  to reach the Gateway host on its port over Tailscale.

---

## 6. Related docs
- `ACUITY_API_HANDOFF.md` — the base Gateway↔Acuity contract (Gateway → Acuity).
- `ACUITY_SMS_HANDOFF.md` — what the Gateway needs FROM Acuity for inbound SMS
  (front-desk reminders + reply-to-cancel).
- `SMS_BIDIRECTIONAL_HANDOFF.md` / `INTEGRATION_NOTES.md` — SMS + Cellcast details.
