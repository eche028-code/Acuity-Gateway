# Cellcast dashboard — setup tasks (hand-off for Claude in Chrome)

> **For the browser agent that can see the Cellcast dashboard** (logged into the
> clinic's Cellcast account). These are configuration changes in the Cellcast web
> UI — no code. Confirm each with the user before saving. Captured 2026-06-17.

## Context (what's already working)
SMS runs through the "Acuity Gateway": outbound (Acuity → Gateway → Cellcast →
patient) and inbound (patient → Cellcast → Gateway → Acuity) are both wired. The
active API key is the v1 **"Gateway testing"** key (the older "Newman" key is
inactive — leave it). Don't touch the API key.

## Task 1 — CRITICAL: approve the clinic number as an outbound SENDER
**Symptom:** every send from the number `0439343382` fails with Cellcast error
**"Your sender id is not registered."** The number is enabled for *replies
(inbound)*, but that is **separate** from being approved as a *sender* (the
outbound "from" number). Until it's approved, outbound only works from the shared
number.

**Do this:**
1. Open **"Sender ID's"** in the left sidebar.
2. Check whether `0439343382` (try formats `0439343382` and `61439343382`) is
   listed as an approved/registered **sender / dedicated number for outbound**.
3. If there's an "Add Sender ID" / "Register" / "Request" option, start it for
   `0439343382` and note what it requires (e.g. ABN/business verification, or a
   support request) — some numeric sender registrations need Cellcast approval and
   aren't instant.
4. Confirm the number is provisioned for **two-way (send + receive)**, not
   inbound-only.

**Report back to the user:** is `0439343382` registerable as a sender directly in
the dashboard, already pending, or does it need a Cellcast **support request**?
If you can complete the registration in-UI, do so (with the user's OK). This is
the one blocker stopping the clinic from texting patients from their own number.
*(Until it's approved, the Gateway is intentionally sending from the shared
number, which still supports replies — so two-way works meanwhile.)*

## Task 2 — secure the inbound webhook (Basic Auth)
The Receiver webhook is currently reachable with **no authentication**. The
Gateway is now configured to require HTTP Basic Auth, so set the matching
credentials here.

1. Go to **API Keys → Webhook Logins** (Username / Password fields).
2. Enter exactly:
   - **Username:** `cellcast`
   - **Password:** `6a5c13a600bc5a889bbaaf2f3333cc`
3. Save. (Treat the password as a secret. If you change it, it must also change in
   the Gateway's `.env` `CELLCAST_WEBHOOK_PASS` — tell the user.)

## Task 3 — verify the Receiver webhook URL
Confirm the **Receiver** webhook URL is exactly:
```
https://desktop-17egjmb.tail20d30d.ts.net/webhooks/cellcast
```
(That's the Gateway's current Tailscale Funnel URL — dev/test. It will change when
the clinic moves to the Lightsail production domain.)

## Task 4 — OPTIONAL: delivery-report (Status) webhook
The **Status webhook** is empty, so the Gateway gets no delivered/failed reports.
To enable them, set the Status URL to the **same** endpoint (the Gateway already
handles delivery reports):
```
https://desktop-17egjmb.tail20d30d.ts.net/webhooks/cellcast
```

## Do NOT change
- The active API key (the v1 "Gateway testing" key).
- The Opt-Out webhook is fine to leave empty — the Gateway already detects `STOP`
  replies and suppresses that number itself.

## How to verify when done
Ask the user to send a test from Acuity. With Task 1 done, the patient SMS should
arrive **from `0439343382`**; a reply should route back and appear in Acuity. With
Task 1 not yet done, sends still go out from the shared number (also fine for
two-way).
