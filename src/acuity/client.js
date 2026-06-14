// Acuity API client — talks to the clinic's local Acuity instance over Tailscale
// via the Gateway API contract (docs/ACUITY_API_HANDOFF.md):
// base `${ACUITY_API_BASE}/api/gateway/v1`, `Authorization: Bearer <key>`.
//
// TLS: when ACUITY_TLS_INSECURE=true (self-signed cert on localhost / a raw
// Tailscale IP) we skip verification — but SCOPED to this client only via a
// dedicated undici dispatcher, so the rest of the process keeps normal TLS.
//
// It distinguishes "Acuity not ready / unreachable" (network error, timeout,
// 5xx, or 503 gateway_disabled — keep queuing) from real client errors (401/403
// auth, 409 slot clash, 422 validation).
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const BASE = `${config.acuity.apiBase.replace(/\/$/, '')}/api/gateway/v1`;
const TIMEOUT_MS = 8000;

// Self-signed cert on localhost / a raw Tailscale IP → skip TLS verification.
// NODE_TLS_REJECT_UNAUTHORIZED is process-wide, so this is gated to the explicit
// dev case (ACUITY_TLS_INSECURE); production uses the Tailscale hostname's real
// cert and leaves verification ON. We use Node's global fetch deliberately — its
// default dispatcher does happy-eyeballs, so `localhost` connects whether the
// server is on IPv4 or IPv6 (a custom undici Agent did not).
if (config.acuity.tlsInsecure) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  logger.warn('ACUITY_TLS_INSECURE=true — TLS certificate verification is DISABLED (dev only)');
}

export class AcuityError extends Error {
  constructor(message, { status = null, unreachable = false, body = null } = {}) {
    super(message);
    this.name = 'AcuityError';
    this.status = status;
    this.unreachable = unreachable;
    this.body = body;
  }
}

async function request(method, path, { query, body } = {}) {
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.acuity.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    logger.warn({ err: err.message, cause: err.cause?.code || err.cause?.message, path }, 'acuity request failed (unreachable)');
    throw new AcuityError(`Acuity unreachable: ${err.message}`, { unreachable: true });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    // 503 (gateway_disabled / not_configured) and other 5xx → "not ready":
    // treat as unreachable so the booking flow keeps queuing rather than
    // surfacing a false conflict. 4xx are genuine client errors.
    const unreachable = res.status === 503 || res.status >= 500;
    const message = (data && (data.message || data.error)) || `Acuity responded ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      logger.error({ status: res.status, path }, 'acuity auth/forbidden — check ACUITY_API_KEY / allowed client IP');
    }
    throw new AcuityError(message, { status: res.status, unreachable, body: data });
  }
  return data;
}

export const acuity = {
  /** GET /health — liveness probe (used by the connection health checker). */
  async ping() {
    await request('GET', '/health');
    return true;
  },

  /** GET /appointment-types → { appointmentTypes[], practitioners[] }. */
  listAppointmentTypes() {
    return request('GET', '/appointment-types');
  },

  /** GET /availability → { slots[], rangeCapDays }. Dates are YYYY-MM-DD. */
  getAvailability({ appointmentTypeId, from, to, practitionerId }) {
    return request('GET', '/availability', {
      query: { appointmentTypeId, from, to, practitionerId },
    });
  },

  /** POST /appointments → 201 new / 200 idempotent replay / 409 slot_unavailable. */
  createAppointment(payload) {
    return request('POST', '/appointments', { body: payload });
  },

  /** GET /changes → { cursor, changes[] }. Pass the cursor back verbatim. */
  getChanges({ since, limit } = {}) {
    return request('GET', '/changes', { query: { since, limit } });
  },

  /** GET /clients?search= → { matches[] }. */
  searchClients({ search }) {
    return request('GET', '/clients', { query: { search } });
  },
};
