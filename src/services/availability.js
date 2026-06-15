// Availability: cache + periodic refresh, with a live re-check at booking time.
//
// Slots come from Acuity's `GET /availability` (one call per appointment type
// across the rolling window, ≤62 days per the contract's range cap). The portal
// renders from this cache (so it survives an Acuity outage); the booking flow
// re-checks the exact slot live against Acuity before committing.
import { db, getState, setState, transaction } from '../db/index.js';
import { config } from '../config.js';
import { acuity, AcuityError } from '../acuity/client.js';
import { setAcuityStatus } from './status.js';
import { logger } from '../lib/logger.js';

const MAX_RANGE_DAYS = 62; // Acuity's availability range cap

const upsertSlot = db.prepare(`
  INSERT INTO availability_cache
    (appointment_type_id, calendar_id, slot_datetime, slot_date, duration_minutes, is_available, source, last_refreshed_at)
  VALUES
    (@appointment_type_id, @calendar_id, @slot_datetime, @slot_date, @duration_minutes, 1, 'acuity', @ts)
  ON CONFLICT(appointment_type_id, calendar_id, slot_datetime) DO UPDATE SET
    is_available = 1,
    duration_minutes = excluded.duration_minutes,
    last_refreshed_at = excluded.last_refreshed_at
`);

const tentativeCloseFuture = db.prepare(
  `UPDATE availability_cache SET is_available = 0 WHERE source = 'acuity' AND slot_date >= @today`,
);

const reapplyLocalHolds = db.prepare(`
  UPDATE availability_cache SET is_available = 0
  WHERE EXISTS (
    SELECT 1 FROM pending_bookings pb
    WHERE pb.appointment_type_id = availability_cache.appointment_type_id
      AND pb.appointment_datetime = availability_cache.slot_datetime
      AND pb.status != 'cancelled'
      -- a practitioner-specific hold only closes that practitioner's slot; an
      -- "any" hold (no calendar_id) closes the slot for everyone (we don't yet
      -- know who Acuity assigned, so stay safe until the next refresh reconciles).
      AND (pb.calendar_id = availability_cache.calendar_id OR pb.calendar_id = '' OR pb.calendar_id IS NULL)
  )
`);

const prunePast = db.prepare(`DELETE FROM availability_cache WHERE slot_date < @today`);

const _closeSlot = db.prepare(
  `UPDATE availability_cache SET is_available = 0 WHERE appointment_type_id = ? AND slot_datetime = ?`,
);
const _openSlot = db.prepare(
  `UPDATE availability_cache SET is_available = 1 WHERE appointment_type_id = ? AND slot_datetime = ?`,
);

// "...Any" variants collapse a slot offered by multiple practitioners into one;
// "...P" variants filter to a single practitioner (calendar_id).
const selectOpenDates = db.prepare(`
  SELECT DISTINCT slot_date FROM availability_cache
  WHERE appointment_type_id = ? AND is_available = 1 AND slot_date >= ? AND slot_date <= ?
  ORDER BY slot_date
`);
const selectOpenDatesP = db.prepare(`
  SELECT DISTINCT slot_date FROM availability_cache
  WHERE appointment_type_id = ? AND is_available = 1 AND slot_date >= ? AND slot_date <= ? AND calendar_id = ?
  ORDER BY slot_date
`);
const selectOpenTimesAny = db.prepare(`
  SELECT slot_datetime, MIN(calendar_id) AS calendar_id, duration_minutes FROM availability_cache
  WHERE appointment_type_id = ? AND slot_date = ? AND is_available = 1
  GROUP BY slot_datetime
  ORDER BY slot_datetime
`);
const selectOpenTimesP = db.prepare(`
  SELECT slot_datetime, calendar_id, duration_minutes FROM availability_cache
  WHERE appointment_type_id = ? AND slot_date = ? AND is_available = 1 AND calendar_id = ?
  ORDER BY slot_datetime
`);

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function addDaysStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function closeSlot(appointmentTypeId, datetime) {
  _closeSlot.run(appointmentTypeId, datetime);
}
export function openSlot(appointmentTypeId, datetime) {
  _openSlot.run(appointmentTypeId, datetime);
}

export function getAppointmentTypes() {
  const raw = getState('appointment_types');
  return raw ? JSON.parse(raw) : [];
}
export function getOpenDates(appointmentTypeId, from, to, practitionerId = '') {
  const rows = practitionerId
    ? selectOpenDatesP.all(appointmentTypeId, from, to, practitionerId)
    : selectOpenDates.all(appointmentTypeId, from, to);
  return rows.map((r) => r.slot_date);
}
export function getOpenTimes(appointmentTypeId, date, practitionerId = '') {
  return practitionerId
    ? selectOpenTimesP.all(appointmentTypeId, date, practitionerId)
    : selectOpenTimesAny.all(appointmentTypeId, date);
}

const selectDayRange = db.prepare(`
  SELECT slot_datetime FROM availability_cache
  WHERE appointment_type_id = ? AND is_available = 1 AND slot_date >= ? AND slot_date <= ?
`);
const selectDayRangeP = db.prepare(`
  SELECT slot_datetime FROM availability_cache
  WHERE appointment_type_id = ? AND is_available = 1 AND slot_date >= ? AND slot_date <= ? AND calendar_id = ?
`);
// Per-day availability summary for the calendar: which parts of the day are open.
// morning < 12:00, afternoon 12:00–17:59, evening ≥ 18:00 (clinic-local AWST hour).
export function getDaySummaries(appointmentTypeId, from, to, practitionerId = '') {
  const rows = practitionerId
    ? selectDayRangeP.all(appointmentTypeId, from, to, practitionerId)
    : selectDayRange.all(appointmentTypeId, from, to);
  const byDate = new Map();
  for (const r of rows) {
    const date = r.slot_datetime.slice(0, 10);
    const hour = Number(r.slot_datetime.slice(11, 13));
    let s = byDate.get(date);
    if (!s) { s = { date, morning: false, afternoon: false, evening: false }; byDate.set(date, s); }
    if (hour < 12) s.morning = true;
    else if (hour < 18) s.afternoon = true;
    else s.evening = true;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function getPractitioners() {
  const raw = getState('practitioners');
  return raw ? JSON.parse(raw) : [];
}

let refreshing = false;

export async function refreshAvailability() {
  if (refreshing) return { skipped: true };
  refreshing = true;
  const today = todayStr();
  const to = addDaysStr(Math.min(config.availability.windowDays, MAX_RANGE_DAYS));
  const ts = new Date().toISOString();
  try {
    // ── Network phase: pull the full truth from Acuity BEFORE touching the DB,
    // so a mid-pull outage leaves the existing cache intact (never half-wiped).
    let typesResp;
    try {
      typesResp = await acuity.listAppointmentTypes();
    } catch (err) {
      if (err instanceof AcuityError && err.unreachable) {
        setAcuityStatus(false);
        logger.warn('availability refresh skipped — Acuity not reachable (serving cache)');
        return { refreshed: false, reason: 'unreachable' };
      }
      throw err;
    }

    const types = (typesResp && typesResp.appointmentTypes) || [];
    const slimTypes = types
      .filter((t) => t.active !== false)
      .map((t) => ({ id: t.id, name: t.name, duration: t.durationMinutes ?? t.duration ?? null }));
    const practitioners = ((typesResp && typesResp.practitioners) || []).map((p) => ({ id: p.id, name: p.name }));

    // Pull each practitioner's diary separately so the cache is segmented by
    // practitioner (calendar_id); with no known practitioners, pull the combined
    // view. types × practitioners calls, but each is a small Tailscale round-trip.
    const targets = practitioners.length ? practitioners.map((p) => p.id) : [''];
    const slots = [];
    for (const type of slimTypes) {
      for (const pid of targets) {
        let avail;
        try {
          avail = await acuity.getAvailability({ appointmentTypeId: type.id, practitionerId: pid || undefined, from: today, to });
        } catch (err) {
          if (err instanceof AcuityError && err.unreachable) {
            setAcuityStatus(false);
            logger.warn('availability refresh aborted — Acuity went unreachable mid-pull (cache unchanged)');
            return { refreshed: false, reason: 'unreachable' };
          }
          continue; // transient error for this slice — keep the others
        }
        for (const slot of avail.slots || []) {
          slots.push({
            appointment_type_id: type.id,
            calendar_id: slot.practitionerId || pid || '',
            slot_datetime: slot.start,
            slot_date: String(slot.start).slice(0, 10),
            duration_minutes: slot.durationMinutes ?? type.duration ?? null,
            ts,
          });
        }
      }
    }

    // ── DB phase: swap the cache to the new truth atomically. The block is free
    // of awaits and wrapped in a transaction, so a portal read never catches the
    // brief "everything closed" window between the tentative close and re-open.
    transaction(() => {
      setState('appointment_types', JSON.stringify(slimTypes));
      setState('practitioners', JSON.stringify(practitioners));
      tentativeCloseFuture.run({ today });
      for (const s of slots) upsertSlot.run(s);
      reapplyLocalHolds.run();
      prunePast.run({ today });
    });

    setAcuityStatus(true);
    setState('last_availability_refresh', ts);
    logger.info({ slots: slots.length }, 'availability refreshed');
    return { refreshed: true, count: slots.length };
  } finally {
    refreshing = false;
  }
}

export async function verifySlotLive({ appointmentTypeId, datetime, practitionerId }) {
  try {
    const date = String(datetime).slice(0, 10);
    const avail = await acuity.getAvailability({ appointmentTypeId, practitionerId: practitionerId || undefined, from: date, to: date });
    setAcuityStatus(true);
    const open = (avail.slots || []).some((s) => s.start === datetime);
    return { reachable: true, open };
  } catch (err) {
    if (err instanceof AcuityError && err.unreachable) {
      setAcuityStatus(false);
      return { reachable: false, open: false };
    }
    throw err;
  }
}
