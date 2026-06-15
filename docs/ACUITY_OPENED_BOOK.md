# Acuity API fix — `/availability` must respect the OPENED appointment book

> Paste this into the **Acuity** codebase Claude session. It refines the behaviour
> of `/api/gateway/v1/availability` (and `/changes`) from
> `ACUITY_API_HANDOFF.md` §3.3 / §3.5. Auth, idempotency, the conflict rule, and
> timestamps are unchanged — this is only about **which dates** may be offered.

## The bug (observed against the live API, 2026-06-15)

`GET /availability` returns the practitioner's **recurring availability template
projected across the entire requested window**, with no regard for whether the
clinic has **opened the appointment book** for those dates.

Concretely, the API currently returns every **Monday & Tuesday, 09:00–17:30
(18 × 30-min slots)** straight out to the 62-day cap — identical week after week:

```
2026-06-15·16   06-22·23   06-29·30   07-06·07   07-13·14
07-20·21   07-27·28   08-03·04   08-10·11      (all 18 slots each)
```

The Gateway is the public patient booking portal and faithfully displays exactly
what this endpoint returns. Result: **patients can book into dates the front desk
has not opened yet** (e.g. August, when only the next few weeks are open). This is
the reported symptom — "the unopened appointment book is still displayed."

## Required behaviour

`GET /availability` must return slots **only for dates whose appointment book is
OPEN for booking** — the same dates/times a staff member could actually book in
the Acuity UI. A slot produced by the recurring template but falling on an
**unopened** date must **not** be returned.

- Intersect the recurring availability with the clinic's "book opened" state
  (whatever flag / table / rolling horizon Acuity uses to release dates for
  booking).
- Continue to honour the requested `from`/`to`, but **never return dates beyond
  the opened boundary**, even when `to` is further out.
- `GET /changes` should likewise not emit changes for unopened dates — and,
  ideally, **emit a change when a date/period is opened or closed** so the Gateway
  re-pulls promptly (e.g. `type: "opened" | "closed"`, or any change row that
  touches the affected date).

## Acceptance check

With the book opened through, say, **2026-07-13**:

- `GET /availability?appointmentTypeId=…&from=2026-06-15&to=2026-08-31` returns
  slots only up to **2026-07-13**; nothing on 07-20 or later.
- Opening a new week in the Acuity UI makes that week's slots appear in
  `/availability` (and show up in `/changes` if implemented).

## Gateway side (already correct — no change needed there)

The Gateway mirrors whatever this endpoint returns; verified on 2026-06-15 that its
cache matches `/availability` exactly (same 18 dates, zero divergence). As an
interim guard it caps its own booking horizon via `AVAILABILITY_WINDOW_DAYS`, but
that is a blunt fixed window — the true boundary is the opened-book state that only
Acuity knows, so this endpoint is where it must be enforced.
