// Public booking API consumed by the iframe portal.
//
// Non-PII reads (appointment types, availability) are open. The two sensitive
// actions — patient lookup and booking — require a session token and are
// rate-limited. Patient data is sent in the request BODY, never the URL/query
// (spec §7: never put PII in query strings).
import express from 'express';
import { issueToken } from '../lib/token.js';
import { requireSession, searchRateLimit, bookingRateLimit } from '../middleware/security.js';
import {
  getAppointmentTypes,
  getOpenDates,
  getOpenTimes,
} from '../services/availability.js';
import { searchPatients } from '../services/patients.js';
import { createBooking } from '../services/booking.js';
import { getAcuityStatus } from '../services/status.js';
import { queueDepth } from '../services/sync.js';

export const portal = express.Router();

// ── Session: mint a short-lived token (no PII) ──────────────────────
portal.post('/session', (_req, res) => {
  res.json({ token: issueToken() });
});

// ── Public, non-PII reads ───────────────────────────────────────────
portal.get('/appointment-types', (_req, res) => {
  res.json({ appointmentTypes: getAppointmentTypes() });
});

portal.get('/availability/dates', (req, res) => {
  const appointmentTypeId = Number(req.query.appointmentTypeId);
  if (!appointmentTypeId) return res.status(400).json({ error: 'appointmentTypeId is required' });
  const today = new Date();
  const from = req.query.from || today.toISOString().slice(0, 10);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + 180);
  const to = req.query.to || horizon.toISOString().slice(0, 10);
  res.json({ dates: getOpenDates(appointmentTypeId, from, to) });
});

portal.get('/availability/times', (req, res) => {
  const appointmentTypeId = Number(req.query.appointmentTypeId);
  const date = req.query.date;
  if (!appointmentTypeId || !date) {
    return res.status(400).json({ error: 'appointmentTypeId and date are required' });
  }
  const times = getOpenTimes(appointmentTypeId, date).map((r) => ({
    time: r.slot_datetime,
    duration: r.duration_minutes,
  }));
  res.json({ times });
});

// Lightweight public status so the portal can show "live" vs "offline booking".
portal.get('/status', (_req, res) => {
  res.json({ acuity: getAcuityStatus(), queueDepth: queueDepth() });
});

// ── Sensitive actions (session + rate limit; PII in body only) ──────
portal.post('/patients/search', requireSession, searchRateLimit(), async (req, res, next) => {
  try {
    const { phone, name } = req.body || {};
    const result = await searchPatients({ phone, name });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

portal.post('/bookings', requireSession, bookingRateLimit(), async (req, res, next) => {
  try {
    const b = req.body || {};
    // Validation. email is required for non-admin Acuity bookings (confirmed
    // against the Acuity API), alongside a name and a slot.
    const errors = [];
    if (!Number(b.appointmentTypeId)) errors.push('appointmentTypeId');
    if (!b.datetime) errors.push('datetime');
    if (!b.firstName) errors.push('firstName');
    if (!b.lastName) errors.push('lastName');
    if (!b.email) errors.push('email');
    if (errors.length) {
      return res.status(400).json({ error: 'missing_fields', fields: errors });
    }

    const result = await createBooking(
      {
        appointmentTypeId: Number(b.appointmentTypeId),
        calendarId: b.calendarId ? Number(b.calendarId) : 0,
        datetime: b.datetime,
        firstName: b.firstName,
        lastName: b.lastName,
        email: b.email,
        phone: b.phone,
        address: b.address,
        city: b.city,
        state: b.state,
        postcode: b.postcode,
        notes: b.notes,
        isNewPatient: !!b.isNewPatient,
      },
      { ip: req.ip },
    );

    if (!result.ok) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
