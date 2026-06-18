# Acuity SMS — remaining code tasks (hand-off)

> **For a Claude Code session in the Acuity codebase.** Bidirectional SMS via the
> Gateway is live; these are the remaining Acuity-side code tweaks. Endpoint
> contracts are in the companion docs (referenced below). Captured 2026-06-17.

## Where it stands
- **Outbound** (Acuity → Gateway → Cellcast → patient): the Acuity → Gateway call
  works. Sends now succeed (Gateway reverted to Cellcast's shared number while the
  clinic number is pending sender-approval).
- **Inbound** (patient → Cellcast → Gateway → Acuity): the Gateway receives and
  processes replies and **forwards them to Acuity** — but it's hitting a route-404,
  i.e. the receiving endpoint **doesn't exist in Acuity yet** (Task 1).
- Two UI issues reported by the user (Tasks 2 & 3).

---

## Task 1 — build the inbound receiver endpoint  ← unblocks replies reaching Acuity
Add **`POST /api/gateway/v1/sms/inbound`** (Bearer `<API_KEY>`, same auth as the
rest of the contract). The Gateway POSTs each patient reply here. Full spec +
payload shape in **`docs/ACUITY_INBOUND_SMS_HANDOFF.md`** — the short version:

```json
{ "from": "+61404104011", "message": "Yes that works",
  "receivedAt": "...", "providerId": "…|null", "intent": "confirm|cancel|stop|unknown",
  "appointmentId": "…|null", "patient": { "firstName": "…", "lastName": "…" } }
```
- Respond `200 {"ok":true}` fast (do heavy work async).
- **Dedupe on `providerId`** when present; some replies arrive via polling with an
  empty `providerId`, so also de-dupe defensively on `from`+`message`+`receivedAt`.
- **Link** to the appointment via `appointmentId` when set, else match by `from`
  number / patient name; if nothing matches, still file it against the patient —
  never drop it.
- **Don't auto-act on `intent`** (no auto-cancel). Surface it to staff. `STOP` is
  already handled by the Gateway (it suppresses that number) — just display it.

Verify: once live, the Gateway's `forward_inbound` audit entries flip from failure
to success and replies show up in Acuity.

---

## Task 2 — live-refresh the conversation view (inbound)
**Reported:** "I have to exit the patient and come back to see the SMS coming into
Acuity." The Gateway delivers replies fine; Acuity's patient/conversation view
just isn't refreshing.

**Fix (Acuity UI):** poll the patient's SMS conversation for new inbound on an
interval (~15–30s) while the panel is open, and/or refetch on window/tab focus, so
new replies appear without navigating away and back. (Append-only update; don't
blow away an in-progress draft.)

---

## Task 3 — show the staff's sent message in the conversation box (outbound)
**Reported:** "when I type a msg in Acuity's SMS panel, it does not appear in the
conversation box." This was partly because sends were failing (now fixed). But
make the UI robust:

**Fix (Acuity UI/logic):** when staff send via the Gateway
(`POST {gateway}/internal/sms/send`, see `docs/ACUITY_OUTBOUND_SMS_HANDOFF.md`):
- On `200 {"ok":true}` → append the outbound message to that patient's conversation
  thread/store immediately (optimistic add or refetch) so it shows in the box.
- On non-200 → show the error to staff and **don't** show it as sent (e.g. `409`
  suppressed = patient opted out; `502/503` = send failed). Today a failed send
  silently vanishes — surface it instead.

---

## Notes / non-goals
- Acuity never holds the Cellcast key and never calls Cellcast directly — outbound
  goes through the Gateway relay, inbound arrives from the Gateway.
- No opt-out logic needed in Acuity (`STOP` handled Gateway-side).
- Reply-to-**cancel** (auto-cancelling an appointment from a reply) still needs the
  cancel endpoint in `docs/ACUITY_SMS_HANDOFF.md` §3 — out of scope here; keep
  cancels staff-driven for now.

## Related docs
- `docs/ACUITY_SMS_HUB_HANDOFF.md` — **the right-rail "SMS" hub** (received-SMS inbox +
  click-through to the patient profile). Reads inbound/threads from the Gateway, so it
  makes Task 1 **optional** for the hub. Tasks 2 & 3 patterns apply there too.
- `docs/ACUITY_INBOUND_SMS_HANDOFF.md` — inbound endpoint contract (Task 1).
- `docs/ACUITY_OUTBOUND_SMS_HANDOFF.md` — Gateway send relay (Task 3).
- `docs/ACUITY_API_HANDOFF.md` — base Gateway↔Acuity contract.
