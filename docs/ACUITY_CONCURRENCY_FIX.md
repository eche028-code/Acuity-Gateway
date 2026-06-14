# Acuity Gateway API — concurrency crash (fix hand-off)

> Give this to a Claude Code session in the **Acuity** codebase. The Gateway API
> added per `docs/ACUITY_API_HANDOFF.md` works correctly for single requests but
> **crashes the whole Acuity server when it receives concurrent requests.**

## Symptom (measured from the Gateway side)

- **Sequential requests — even rapid, all endpoints, all appointment types — are
  100% fine.** `/health`, `/appointment-types`, `/availability` (each of the 3
  types), `/changes`, `/clients` all return `200` and the server stays up.
- **Concurrent requests crash the process.** Firing 5 requests in parallel
  (`/appointment-types` + 3× `/availability` + `/changes` via `Promise.all`):
  the first returns `200`, the other four get **`ECONNRESET`** (connection killed
  mid-response), and every request afterward is **`ECONNREFUSED`** — i.e. the
  Acuity server process has **exited**.

Because the Gateway API "reuses Acuity's main HTTPS server on :3002", that crash
takes **all of Acuity** down, not just the API.

This is not optional to fix: the Gateway issues **overlapping** requests in normal
operation — a ~20s `/changes` poll, a ~30s `/health` check, a periodic
`/availability` refresh across all types, plus on-demand `/clients` search and
booking `/availability`+`POST /appointments`. They *will* coincide.

## What to fix

1. **A handler error must never crash the process.** Wrap every Gateway-API route
   so a thrown error returns `500 {error,message}` instead of propagating out of
   the process. (In Express: an async wrapper / error middleware; in raw http:
   try/catch around each handler.) As a safety net while debugging, add
   `process.on('uncaughtException', e => log(e))` and
   `process.on('unhandledRejection', e => log(e))` so the trace is captured
   instead of silently killing the server.

2. **Find the race / shared state.** `ECONNRESET` under parallel load almost always
   means the handlers share something non-reentrant. Usual suspects:
   - **A single shared database connection/cursor/statement** reused across
     requests. Fix: a connection **pool**, or one connection per request. (If
     Acuity uses PostgreSQL, use a `pg` Pool; don't share one client across
     concurrent queries — a single `pg` client cannot run queries in parallel and
     will throw.)
   - **Shared mutable module-level state** mutated during a request.
   - A library object that isn't safe to use from overlapping async calls.

3. **Verify.** After the fix, the server must survive many parallel requests to
   `/availability`, `/changes`, `/appointment-types`, and `/clients` without
   dropping. (The Gateway side can re-run its concurrent-burst test to confirm.)

## The stack trace

When it crashed, the Acuity server's console/log should show an **uncaught
exception with a stack trace** — that names the exact file/line. Fix from that
first; everything above is the likely shape of it.
