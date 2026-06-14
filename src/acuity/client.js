// Acuity Scheduling API client.
//
// Acuity is the system of record. This client talks to the REST API documented
// at developers.acuityscheduling.com. The SAME client points at the local mock
// (ACUITY_API_BASE=http://localhost:4000) during development and at the live
// API (https://acuityscheduling.com) in production — only the base URL changes.
//
// Crucially, it distinguishes "Acuity said no" (a real 4xx client error) from
// "Acuity is unreachable" (network error, timeout, or 5xx). The latter sets
// `unreachable = true`, which is the signal the booking flow uses to fall back
// to the local outage queue (spec #6).
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const TIMEOUT_MS = 8000;

export class AcuityError extends Error {
  constructor(message, { status = null, unreachable = false, body = null } = {}) {
    super(message);
    this.name = 'AcuityError';
    this.status = status;
    this.unreachable = unreachable;
    this.body = body;
  }
}

function authHeader() {
  const { userId, apiKey } = config.acuity;
  const token = Buffer.from(`${userId}:${apiKey}`).toString('base64');
  return `Basic ${token}`;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text || null;
  }
}

async function request(method, path, { query, body } = {}) {
  const url = new URL(`${config.acuity.apiBase}/api/v1${path}`);
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
        Authorization: authHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure or timeout → Acuity is unreachable → trigger outage path.
    logger.warn({ err: err.message, path }, 'acuity request failed (unreachable)');
    throw new AcuityError(`Acuity unreachable: ${err.message}`, { unreachable: true });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  const data = safeJson(text);

  if (!res.ok) {
    // 5xx is treated as unreachable (so we queue rather than reject the patient);
    // 4xx is a genuine client error (e.g. slot already taken) and is surfaced.
    const unreachable = res.status >= 500;
    const message = (data && data.message) || `Acuity responded ${res.status}`;
    throw new AcuityError(message, { status: res.status, unreachable, body: data });
  }

  return data;
}

export const acuity = {
  /** Cheap connectivity probe used by the health checker. */
  async ping() {
    await request('GET', '/appointment-types');
    return true;
  },

  listAppointmentTypes() {
    return request('GET', '/appointment-types');
  },

  /** Open dates in a month, e.g. month = "2026-06". */
  getAvailabilityDates({ month, appointmentTypeID, calendarID }) {
    return request('GET', '/availability/dates', {
      query: { month, appointmentTypeID, calendarID },
    });
  },

  /** Open times on a date, e.g. date = "2026-06-20". */
  getAvailabilityTimes({ date, appointmentTypeID, calendarID }) {
    return request('GET', '/availability/times', {
      query: { date, appointmentTypeID, calendarID },
    });
  },

  /** Existing-patient lookup. `search` matches name/phone/email in Acuity. */
  searchClients({ search }) {
    return request('GET', '/clients', { query: { search } });
  },

  /** Create (book) an appointment. Returns the Acuity appointment record. */
  createAppointment(payload) {
    return request('POST', '/appointments', { body: payload });
  },

  getAppointment(id) {
    return request('GET', `/appointments/${id}`);
  },

  cancelAppointment(id) {
    return request('PUT', `/appointments/${id}/cancel`, { body: {} });
  },

  /** Register a webhook subscription (Acuity → Gateway). */
  subscribeWebhook({ target, event }) {
    return request('POST', '/webhooks', { body: { target, event } });
  },
};
