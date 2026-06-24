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
  getVisibleAppointmentTypes,
  getOpenDates,
  getOpenTimes,
  getDaySummaries,
  getPractitioners,
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
  res.json({ appointmentTypes: getVisibleAppointmentTypes() });
});

portal.get('/practitioners', (_req, res) => {
  res.json({ practitioners: getPractitioners() });
});

portal.get('/availability/dates', (req, res) => {
  const appointmentTypeId = (req.query.appointmentTypeId || '').toString();
  if (!appointmentTypeId) return res.status(400).json({ error: 'appointmentTypeId is required' });
  const today = new Date();
  const from = req.query.from || today.toISOString().slice(0, 10);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + 180);
  const to = req.query.to || horizon.toISOString().slice(0, 10);
  res.json({ dates: getOpenDates(appointmentTypeId, from, to, (req.query.practitionerId || '').toString()) });
});

portal.get('/availability/times', (req, res) => {
  const appointmentTypeId = (req.query.appointmentTypeId || '').toString();
  const date = req.query.date;
  if (!appointmentTypeId || !date) {
    return res.status(400).json({ error: 'appointmentTypeId and date are required' });
  }
  const times = getOpenTimes(appointmentTypeId, date, (req.query.practitionerId || '').toString()).map((r) => ({
    time: r.slot_datetime,
    duration: r.duration_minutes,
  }));
  res.json({ times });
});

// Per-day availability summary (morning/afternoon/evening flags) for the calendar.
portal.get('/availability/calendar', (req, res) => {
  const appointmentTypeId = (req.query.appointmentTypeId || '').toString();
  if (!appointmentTypeId) return res.status(400).json({ error: 'appointmentTypeId is required' });
  const today = new Date();
  const from = req.query.from || today.toISOString().slice(0, 10);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + 180);
  const to = req.query.to || horizon.toISOString().slice(0, 10);
  res.json({ days: getDaySummaries(appointmentTypeId, from, to, (req.query.practitionerId || '').toString()) });
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
    // Validation. A name and a slot are required; email is optional (the clinic
    // accepts phone-only / existing-patient bookings).
    const errors = [];
    if (!b.appointmentTypeId) errors.push('appointmentTypeId');
    if (!b.datetime) errors.push('datetime');
    if (!b.firstName) errors.push('firstName');
    if (!b.lastName) errors.push('lastName');
    if (errors.length) {
      return res.status(400).json({ error: 'missing_fields', fields: errors });
    }

    const result = await createBooking(
      {
        appointmentTypeId: String(b.appointmentTypeId),
        calendarId: b.calendarId ? String(b.calendarId) : '',
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
