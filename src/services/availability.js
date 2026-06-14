// Availability: cache + periodic refresh, with a live re-check at booking time.
//
// Strategy (the parked open item, decided): the portal renders slots from the
// local SQLite cache (so it keeps working during an Acuity outage), the cache
// is refreshed on a timer and on webhooks, and the booking flow does a LIVE
// availability check against Acuity at the moment of booking to avoid double-
// booking. Best of both: resilient to render, authoritative to commit.
import { db, getState, setState } from '../db/index.js';
import { config } from '../config.js';
import { acuity, AcuityError } from '../acuity/client.js';
import { setAcuityStatus } from './status.js';
import { logger } from '../lib/logger.js';

// ── Prepared statements ─────────────────────────────────────────────
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

// Before a refresh, tentatively mark all future Acuity slots unavailable; the
// upsert re-opens the ones Acuity still returns. Slots that vanished (booked
// elsewhere) thus correctly flip to unavailable.
const tentativeCloseFuture = db.prepare(
  `UPDATE availability_cache SET is_available = 0 WHERE source = 'acuity' AND slot_date >= @today`,
);

// Re-close any slot held by a local active booking (e.g. an outage-queued
// booking Acuity doesn't know about yet), so a refresh can't re-open it.
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

// ── Helpers ─────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Distinct YYYY-MM strings spanning [today, today + windowDays].
function monthsInWindow() {
  const months = new Set();
  const start = new Date();
  for (let i = 0; i <= config.availability.windowDays; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return [...months];
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

// ── Refresh ─────────────────────────────────────────────────────────
let refreshing = false;

export async function refreshAvailability() {
  if (refreshing) return { skipped: true };
  refreshing = true;
  const today = todayStr();
  const ts = new Date().toISOString();
  try {
    let types;
    try {
      types = await acuity.listAppointmentTypes();
    } catch (err) {
      if (err instanceof AcuityError && err.unreachable) {
        setAcuityStatus(false);
        logger.warn('availability refresh skipped — Acuity unreachable (serving cache)');
        return { refreshed: false, reason: 'unreachable' };
      }
      throw err;
    }

    // Cache appointment types (non-PII) for the portal.
    const slimTypes = (Array.isArray(types) ? types : []).map((t) => ({
      id: t.id,
      name: t.name,
      duration: t.duration,
      calendarID: (t.calendarIDs && t.calendarIDs[0]) || null,
    }));
    setState('appointment_types', JSON.stringify(slimTypes));

    let count = 0;
    tentativeCloseFuture.run({ today });

    for (const type of slimTypes) {
      const calendarId = type.calendarID || 0;
      for (const month of monthsInWindow()) {
        let dates;
        try {
          dates = await acuity.getAvailabilityDates({
            month,
            appointmentTypeID: type.id,
            calendarID: type.calendarID || undefined,
          });
        } catch (err) {
          if (err instanceof AcuityError && err.unreachable) {
            setAcuityStatus(false);
            return { refreshed: false, reason: 'unreachable', count };
          }
          continue; // skip this month on a transient error
        }
        for (const d of dates || []) {
          let times;
          try {
            times = await acuity.getAvailabilityTimes({
              date: d.date,
              appointmentTypeID: type.id,
              calendarID: type.calendarID || undefined,
            });
          } catch (err) {
            if (err instanceof AcuityError && err.unreachable) {
              setAcuityStatus(false);
              return { refreshed: false, reason: 'unreachable', count };
            }
            continue;
          }
          for (const t of times || []) {
            upsertSlot.run({
              appointment_type_id: type.id,
              calendar_id: calendarId,
              slot_datetime: t.time,
              slot_date: t.time.slice(0, 10),
              duration_minutes: type.duration || null,
              ts,
            });
            count++;
          }
        }
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

// ── Live verify (called at booking time) ────────────────────────────
export async function verifySlotLive({ appointmentTypeId, datetime, calendarId }) {
  try {
    const times = await acuity.getAvailabilityTimes({
      date: String(datetime).slice(0, 10),
      appointmentTypeID: appointmentTypeId,
      calendarID: calendarId || undefined,
    });
    setAcuityStatus(true);
    const open = (times || []).some((t) => t.time === datetime);
    return { reachable: true, open };
  } catch (err) {
    if (err instanceof AcuityError && err.unreachable) {
      setAcuityStatus(false);
      return { reachable: false, open: false };
    }
    throw err;
  }
}
