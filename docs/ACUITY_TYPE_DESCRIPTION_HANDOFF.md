# Acuity → Gateway: pass appointment-type Descriptions through

> **How to use this doc:** open a Claude Code session in the **Acuity gateway
> server** codebase (the on-site service the booking Gateway reaches over
> Tailscale at `:3002`) and paste this. It's a small, additive change. Captured
> **2026-06-24**.

---

## 1. What we want

The public booking portal can show each appointment type's **Description** as a
small ⓘ explainer (hover on desktop, tap on mobile). The booking Gateway and
portal already support this end-to-end — they read a `description` field off each
appointment type and render the badge when it's present.

The descriptions **are written in Acuity**. The only missing piece is that this
Acuity gateway server's `GET /appointment-types` response doesn't include them.

## 2. The diagnosis (confirmed 2026-06-24)

Querying this server's `GET /api/gateway/v1/appointment-types` returns 10 types,
and **every one** has only these keys:

```
["active", "durationMinutes", "id", "name"]
```

No `description` key on any type. So the portal correctly shows no ⓘ (it degrades
cleanly when the field is absent/blank). We need this server to add the field.

## 3. The change

In the handler that builds the `GET /appointment-types` response, include the
appointment type's Description from Acuity on each item:

```json
{
  "id": "16e5cbee-35a0-4bb2-afe8-c61ca19aed63",
  "name": "General Consultation",
  "description": "Comprehensive eye check…",   // <-- ADD THIS, from Acuity's Description field
  "durationMinutes": 30,
  "active": true
}
```

Notes:
- **Source:** Acuity's appointment-type object exposes the Description (in
  Acuity's own API it's the `description` property on an appointment type). Map it
  straight through.
- **Optional field:** if a type has no Description in Acuity, omit the key or send
  `null`/empty — the portal just shows no badge for that type. Don't fabricate a
  value.
- **Plain text:** the portal renders it as text (it's inserted via textContent,
  not HTML), so HTML tags won't render — send a plain string. Keep it concise
  (the popover caps at ~260px wide); very long text still works but wraps.
- This is purely **additive** — no existing consumer breaks by gaining a field.

## 4. The contract (already documented on the Gateway side)

From `docs/ACUITY_API_HANDOFF.md` §3.2 (`GET /appointment-types`):

> `description` is **optional** — pass through the appointment type's Description
> field from Acuity if it's set. The portal shows it as a hover/tap explainer on
> each option; omit it (or send empty/null) and the portal simply shows no
> explainer for that type.

## 5. How to verify

From a machine on the Tailnet (or the Acuity host itself), with the Gateway's
Acuity API key:

```
curl -s -H "Authorization: Bearer <ACUITY_API_KEY>" \
  https://acuity-server.tail20d30d.ts.net:3002/api/gateway/v1/appointment-types \
  | python3 -m json.tool
```

Success = each type that has a Description in Acuity now shows a non-empty
`"description"` field.

Then on the booking Gateway box, the new value appears after the next
availability refresh (or immediately with
`sudo systemctl restart acuity-gateway`). Check the public portal feed:

```
curl -s https://book.waeyecare.com.au/api/appointment-types | python3 -m json.tool
```

and load `https://book.waeyecare.com.au` — types with a description now show the
ⓘ badge (hover/tap to reveal the text). **No Gateway code change is needed** —
it already carries the field through.

## 6. Related docs
- `ACUITY_API_HANDOFF.md` — the base Gateway↔Acuity contract (§3.2 is the relevant one).
- `ACUITY_OUTBOUND_SMS_HANDOFF.md` — the SMS leg (same Tailscale link).
