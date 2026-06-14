// Availability: cache + periodic refresh, with a live re-check at booking time.
//
// Slots come from Acuity's `GET /availability` (one call per appointment type
// across the rolling window, ≤62 days per the contract's range cap). The portal
// renders from this cache (so it survives an Acuity outage); the booking flow
// re-checks the exact slot live against Acuity before committing.
import { db, getState, setState } from '../db/index.js';
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
  )
`);

const prunePast = db.prepare(`DELETE FROM availability_cache WHERE slot_date < @today`);

const _closeSlot = db.prepare(
  `UPDATE availability_cache SET is_available = 0 WHERE appointment_type_id = ? AND slot_datetime = ?`,
);
const _openSlot = db.prepare(
  `UPDATE availability_cache SET is_available = 1 WHERE appointment_type_id = ? AND slot_datetime = ?`,
);

const selectOpenDates = db.prepare(`
  SELECT DISTINCT slot_date FROM availability_cache
  WHERE appointment_type_id = ? AND is_available = 1 AND slot_date >= ? AND slot_date <= ?
  ORDER BY slot_date
`);
const selectOpenTimes = db.prepare(`
  SELECT slot_datetime, calendar_id, duration_minutes FROM availability_cache
  WHERE appointment_type_id = ? AND slot_date = ? AND is_available = 1
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
export function getOpenDates(appointmentTypeId, from, to) {
  return selectOpenDates.all(appointmentTypeId, from, to).map((r) => r.slot_date);
}
export function getOpenTimes(appointmentTypeId, date) {
  return selectOpenTimes.all(appointmentTypeId, date);
}

let refreshing = false;

export async function refreshAvailability() {
  if (refreshing) return { skipped: true };
  refreshing = true;
  const today = todayStr();
  const to = addDaysStr(Math.min(config.availability.windowDays, MAX_RANGE_DAYS));
  const ts = new Date().toISOString();
  try {
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
    setState('appointment_types', JSON.stringify(slimTypes));

    tentativeCloseFuture.run({ today });

    let count = 0;
    for (const type of slimTypes) {
      let avail;
      try {
        avail = await acuity.getAvailability({ appointmentTypeId: type.id, from: today, to });
      } catch (err) {
        if (err instanceof AcuityError && err.unreachable) {
          setAcuityStatus(false);
          return { refreshed: false, reason: 'unreachable', count };
        }
        continue; // transient error for this type — skip it
      }
      for (const slot of avail.slots || []) {
        upsertSlot.run({
          appointment_type_id: type.id,
          calendar_id: slot.practitionerId || '',
          slot_datetime: slot.start,
          slot_date: String(slot.start).slice(0, 10),
          duration_minutes: slot.durationMinutes ?? type.duration ?? null,
          ts,
        });
        count++;
      }
    }

    reapplyLocalHolds.run();
    prunePast.run({ today });
    setAcuityStatus(true);
    setState('last_availability_refresh', ts);
    logger.info({ slots: count }, 'availability refreshed');
    return { refreshed: true, count };
  } finally {
    refreshing = false;
  }
}

export async function verifySlotLive({ appointmentTypeId, datetime }) {
  try {
    const date = String(datetime).slice(0, 10);
    const avail = await acuity.getAvailability({ appointmentTypeId, from: date, to: date });
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
