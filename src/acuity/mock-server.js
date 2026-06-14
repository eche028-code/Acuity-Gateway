// Local mock of the Acuity Scheduling API.
//
// Runs on its own port (default 4000) and mimics the subset of the Acuity REST
// API that Gateway uses, so the whole system is runnable and testable on
// Windows with no live Acuity account. Point the Gateway at it with
// ACUITY_API_BASE=http://localhost:4000.
//
// It also fires webhooks back to any subscriber (Gateway) on booking changes,
// so you can exercise the real-time sync path end to end. Stop this process to
// simulate an Acuity OUTAGE and watch Gateway keep taking bookings.
import express from 'express';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 4000);
const WINDOW_DAYS = Number(process.env.AVAILABILITY_WINDOW_DAYS || 60);
// Real Acuity signs webhooks with the account API KEY (an optional override
// secret can take precedence). Empty in dev => unsigned (Gateway then skips
// verification, since it has nothing to verify against).
const WEBHOOK_SECRET = process.env.ACUITY_WEBHOOK_SECRET || process.env.ACUITY_API_KEY || '';

// ── Seed data ───────────────────────────────────────────────────────
const appointmentTypes = [
  { id: 1, name: 'Initial Consultation', duration: 30, calendarIDs: [1] },
  { id: 2, name: 'Follow-up Appointment', duration: 15, calendarIDs: [1] },
  { id: 3, name: 'Telehealth Consult', duration: 20, calendarIDs: [1] },
];

// A couple of existing patients so phone/name lookup can be demonstrated.
const clients = [
  { firstName: 'Jane', lastName: 'Doe', phone: '0412345678', email: 'jane.doe@example.com' },
  { firstName: 'John', lastName: 'Smith', phone: '0498765432', email: 'john.smith@example.com' },
];

const appointments = new Map(); // id -> appointment
const bookedSlots = new Set(); // `${appointmentTypeID}|${datetime}`
const webhookSubs = []; // { target, event }
let nextId = 1001;

// ── Slot generation ─────────────────────────────────────────────────
function pad(n) {
  return String(n).padStart(2, '0');
}

function toOffsetISO(d) {
  const off = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${oh}${om}`
  );
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Business-hours slots (09:00–16:30, every 30 min) for a given weekday date.
function slotsForDate(dateStr, appointmentTypeID) {
  const [y, m, day] = dateStr.split('-').map(Number);
  const base = new Date(y, m - 1, day);
  const dow = base.getDay();
  if (dow === 0 || dow === 6) return []; // weekend — clinic closed

  const now = new Date();
  const out = [];
  for (let h = 9; h <= 16; h++) {
    for (const min of [0, 30]) {
      if (h === 16 && min === 30) continue; // last slot 16:00
      const slot = new Date(y, m - 1, day, h, min, 0, 0);
      if (slot <= now) continue; // no past slots
      const iso = toOffsetISO(slot);
      if (bookedSlots.has(`${appointmentTypeID}|${iso}`)) continue;
      out.push(iso);
    }
  }
  return out;
}

function* daysInMonth(month) {
  // month = "YYYY-MM"
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  for (let d = 1; d <= last; d++) yield `${y}-${pad(m)}-${pad(d)}`;
}

function withinWindow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + WINDOW_DAYS);
  return date >= today && date <= horizon;
}

// ── Webhook firing (mirrors Acuity: urlencoded body + HMAC signature) ─
// Acuity's ASYMMETRY: you SUBSCRIBE with dot-notation events
// (appointment.scheduled) but the delivered payload's `action` is the SHORT
// form (scheduled). `shortAction` here is that short form.
async function fireWebhook(shortAction, appt) {
  const subs = webhookSubs.filter(
    (s) => s.event === `appointment.${shortAction}` || s.event === 'appointment.changed',
  );
  if (subs.length === 0) return;
  const body = new URLSearchParams({
    action: shortAction,
    id: String(appt.id),
    calendarID: String(appt.calendarID || ''),
    appointmentTypeID: String(appt.appointmentTypeID || ''),
  }).toString();
  const signature = WEBHOOK_SECRET
    ? crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64')
    : '';
  for (const sub of subs) {
    try {
      await fetch(sub.target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Acuity-Signature': signature,
        },
        body,
      });
    } catch {
      // best-effort — Gateway may be down; not the mock's problem
    }
  }
}

// ── Server ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/api/v1/appointment-types', (_req, res) => {
  res.json(appointmentTypes);
});

app.get('/api/v1/availability/dates', (req, res) => {
  const { month, appointmentTypeID } = req.query;
  if (!month) return res.status(400).json({ message: 'month is required' });
  const typeId = Number(appointmentTypeID) || appointmentTypes[0].id;
  const dates = [];
  for (const dateStr of daysInMonth(month)) {
    if (!withinWindow(dateStr)) continue;
    if (slotsForDate(dateStr, typeId).length > 0) dates.push({ date: dateStr });
  }
  res.json(dates);
});

app.get('/api/v1/availability/times', (req, res) => {
  const { date, appointmentTypeID } = req.query;
  if (!date) return res.status(400).json({ message: 'date is required' });
  const typeId = Number(appointmentTypeID) || appointmentTypes[0].id;
  const times = slotsForDate(date, typeId).map((iso) => ({ time: iso, slotsAvailable: 1 }));
  res.json(times);
});

app.get('/api/v1/clients', (req, res) => {
  const search = (req.query.search || '').toString().trim().toLowerCase();
  if (!search) return res.json(clients);
  const digits = search.replace(/\D/g, '');
  const matches = clients.filter((c) => {
    const name = `${c.firstName} ${c.lastName}`.toLowerCase();
    const phone = (c.phone || '').replace(/\D/g, '');
    return (
      name.includes(search) ||
      (digits.length >= 6 && phone.includes(digits)) ||
      (c.email || '').toLowerCase().includes(search)
    );
  });
  res.json(matches);
});

app.post('/api/v1/appointments', async (req, res) => {
  const { appointmentTypeID, datetime, firstName, lastName, email, phone, calendarID } = req.body || {};
  if (!appointmentTypeID || !datetime) {
    return res.status(400).json({ message: 'appointmentTypeID and datetime are required' });
  }
  const dateStr = String(datetime).slice(0, 10);
  const available = slotsForDate(dateStr, Number(appointmentTypeID)).includes(datetime);
  if (!available) {
    // Slot already taken / invalid → 4xx so Gateway treats it as a real
    // conflict (this is the reconciliation collision case).
    return res.status(400).json({ message: 'This time is not available.' });
  }
  const appt = {
    id: nextId++,
    appointmentTypeID: Number(appointmentTypeID),
    calendarID: Number(calendarID) || 1,
    datetime,
    firstName: firstName || '',
    lastName: lastName || '',
    email: email || '',
    phone: phone || '',
    canceled: false,
  };
  appointments.set(appt.id, appt);
  bookedSlots.add(`${appt.appointmentTypeID}|${datetime}`);
  res.status(200).json(appt);
  fireWebhook('scheduled', appt);
});

app.get('/api/v1/appointments/:id', (req, res) => {
  const appt = appointments.get(Number(req.params.id));
  if (!appt) return res.status(404).json({ message: 'Not found' });
  res.json(appt);
});

app.put('/api/v1/appointments/:id/cancel', async (req, res) => {
  const appt = appointments.get(Number(req.params.id));
  if (!appt) return res.status(404).json({ message: 'Not found' });
  appt.canceled = true;
  bookedSlots.delete(`${appt.appointmentTypeID}|${appt.datetime}`);
  res.json(appt);
  fireWebhook('canceled', appt);
});

app.post('/api/v1/webhooks', (req, res) => {
  const { target, event } = req.body || {};
  if (!target || !event) return res.status(400).json({ message: 'target and event are required' });
  webhookSubs.push({ target, event });
  res.status(200).json({ id: webhookSubs.length, target, event, status: 'active' });
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'mock-acuity' }));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-acuity] listening on http://localhost:${PORT} (${WINDOW_DAYS}-day window)`);
  // eslint-disable-next-line no-console
  console.log('[mock-acuity] stop this process to simulate an Acuity outage.');
});
