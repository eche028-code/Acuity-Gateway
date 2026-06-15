# Acuity connection — Tailscale transport (valid TLS)

How the Gateway reaches the clinic's self-hosted Acuity Gateway API. This is the
only network-specific config; the rest of the Gateway is transport-agnostic
(`src/acuity/client.js` just `fetch`es `${ACUITY_API_BASE}/api/gateway/v1`).

## Current setup

- **Base URL:** `https://desktop-17egjmb.tail20d30d.ts.net:3002`
  (the client appends `/api/gateway/v1`).
- **Transport:** the Tailscale tailnet. Today the Gateway runs on the **same PC**
  as Acuity, so traffic hairpins PC → Tailscale → PC. That's expected for testing
  and is byte-for-byte identical to the eventual Lightsail path — no code differs.
- **TLS:** verification **ON** (`ACUITY_TLS_INSECURE=false`). Acuity serves a real
  Tailscale-issued Let's Encrypt cert for the MagicDNS name. Connect by the
  **hostname, never the `100.x` tailnet IP** — the cert is valid for the name only.
- **Auth:** `Authorization: Bearer <ACUITY_API_KEY>` on every request. Rotate the
  key in Acuity → System Admin → Gateway → Generate new key.

### `.env` (git-ignored)

```
ACUITY_API_BASE=https://desktop-17egjmb.tail20d30d.ts.net:3002
ACUITY_API_KEY=<bearer key>
ACUITY_TLS_INSECURE=false
```

## Smoke test

Run once Acuity is listening (no `-k` — the cert is valid):

```
curl https://desktop-17egjmb.tail20d30d.ts.net:3002/api/gateway/v1/health \
  -H "Authorization: Bearer <ACUITY_API_KEY>"
# → {"ok":true,"time":"...+08:00"}
```

Failure modes:

- `curl: (6) Could not resolve host` → this machine isn't on the tailnet, or
  MagicDNS is off.
- `curl: (7) Couldn't connect ... port 3002` → Acuity isn't running (the standing
  blocker — see `ACUITY_STAYING_UP.md`). The Gateway treats this as "not ready" and
  keeps queuing; it is **not** a Gateway bug.
- `401 {"error":"unauthorized"}` → missing/invalid `ACUITY_API_KEY`.
- `503 {"error":"gateway_disabled"}` → API toggled off in Acuity; treat as "not
  ready" (keep the outage queue, don't surface as a booking conflict).

## Server side (Acuity machine — done)

Already configured on the Acuity host: Tailscale HTTPS/MagicDNS enabled and a real
cert issued for the node name, with Acuity serving it on `:3002` (verified with
`curl` and no `-k`). Nothing to do on the Gateway repo for this.

## When the Gateway moves to AWS Lightsail

The base URL and Bearer key stay **identical**. Only the host running the Gateway
changes:

1. Install Tailscale on the Lightsail box and `tailscale up` to join this tailnet.
2. Leave `ACUITY_API_BASE` / `ACUITY_API_KEY` / `ACUITY_TLS_INSECURE=false`
   unchanged.
3. Add a Tailscale ACL so **only** the Lightsail node may reach Acuity's `:3002`
   (defence-in-depth on top of the Bearer key).

Nothing in the Gateway code changes.
