// Booking flow — the resilience core (spec #6).
//
//   1. Reject if the slot is already taken locally (covers outage-queued books).
//   2. Live-verify against Acuity if reachable; reject if Acuity says taken.
//   3. Insert the pending booking (synced = 0) and hold the slot locally.
//   4. Push to Acuity:
//        • success            → mark synced/confirmed.
//        • Acuity unreachable → leave queued (the outage queue); confirm to the
//                               patient anyway — Gateway is now the source of truth.
//        • Acuity 4xx (taken) → undo the local hold and surface a conflict.
//   5. If Acuity was unreachable from the start, the booking goes straight into
//      the queue and the reconnect sync (services/sync.js) replays it later.
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { acuity, AcuityError } from '../acuity/client.js';
import { verifySlotLive, closeSlot, openSlot } from './availability.js';
import { setAcuityStatus } from './status.js';
import { recordAudit } from '../middleware/audit.js';
import { logger } from '../lib/logger.js';

const insertBooking = db.prepare(`
  INSERT INTO pending_bookings (
    id, appointment_type_id, calendar_id, appointment_datetime, appointment_date,
    first_name, last_name, phone, email, address, city, state, postcode, notes,
    is_new_patient, status, synced, sync_version, sync_attempts, created_at, updated_at
  ) VALUES (
    @id, @appointment_type_id, @calendar_id, @appointment_datetime, @appointment_date,
    @first_name, @last_name, @phone, @email, @address, @city, @state, @postcode, @notes,
    @is_new_patient, 'pending', 0, 0, 0, @now, @now
  )
`);

const slotTakenLocally = db.prepare(`
  SELECT 1 FROM pending_bookings
  WHERE appointment_type_id = ? AND appointment_datetime = ? AND status != 'cancelled'
  LIMIT 1
`);

const markSynced = db.prepare(`
  UPDATE pending_bookings
  SET acuity_appointment_id = @acuity_id, synced = 1, status = 'confirmed',
      synced_at = @now, sync_version = sync_version + 1, sync_error = NULL, updated_at = @now
  WHERE id = @id
`);

const markAttempt = db.prepare(`
  UPDATE pending_bookings
  SET sync_attempts = sync_attempts + 1, last_attempt_at = @now, sync_error = @err, updated_at = @now
  WHERE id = @id
`);

const deleteBooking = db.prepare(`DELETE FROM pending_bookings WHERE id = ?`);

function acuityPayload(b) {
  return {
    appointmentTypeID: b.appointment_type_id,
    datetime: b.appointment_datetime, // pass the exact slot string Acuity returned
    firstName: b.first_name,
    lastName: b.last_name,
    email: b.email,
    phone: b.phone,
    calendarID: b.calendar_id || undefined,
  };
}

export async function createBooking(input, ctx = {}) {
  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    appointment_type_id: input.appointmentTypeId,
    calendar_id: input.calendarId || 0,
    appointment_datetime: input.datetime,
    appointment_date: String(input.datetime).slice(0, 10),
    first_name: input.firstName,
    last_name: input.lastName,
    phone: input.phone || null,
    email: input.email || null,
    address: input.address || null,
    city: input.city || null,
    state: input.state || null,
    postcode: input.postcode || null,
    notes: input.notes || null,
    is_new_patient: input.isNewPatient ? 1 : 0,
    now,
  };

  // 1) local conflict (covers slots already held by outage-queued bookings)
  if (slotTakenLocally.get(record.appointment_type_id, record.appointment_datetime)) {
    return { ok: false, code: 'slot_taken', message: 'That time has just been taken. Please choose another.' };
  }

  // 2) live verify against Acuity when reachable
  const live = await verifySlotLive({
    appointmentTypeId: record.appointment_type_id,
    datetime: record.appointment_datetime,
    calendarId: record.calendar_id || undefined,
  });
  if (live.reachable && !live.open) {
    return { ok: false, code: 'slot_taken', message: 'That time is no longer available. Please choose another.' };
  }

  // 3) persist locally and hold the slot — Gateway now owns it
  insertBooking.run(record);
  closeSlot(record.appointment_type_id, record.appointment_datetime);

  // 4 / 5) push to Acuity (or queue if it's down)
  if (!live.reachable) {
    setAcuityStatus(false);
    markAttempt.run({ now: new Date().toISOString(), err: 'acuity offline at booking', id: record.id });
    recordAudit({ event_type: 'booking', actor: 'patient', ip: ctx.ip, success: true, detail: { id: record.id, state: 'queued', reason: 'acuity_offline' } });
    logger.info({ id: record.id }, 'booking queued - Acuity offline');
    return { ok: true, state: 'queued', bookingId: record.id };
  }

  try {
    const appt = await acuity.createAppointment(acuityPayload(record));
    markSynced.run({ acuity_id: appt.id, now: new Date().toISOString(), id: record.id });
    setAcuityStatus(true);
    recordAudit({ event_type: 'booking', actor: 'patient', ip: ctx.ip, success: true, detail: { id: record.id, acuity_id: appt.id, state: 'confirmed' } });
    return { ok: true, state: 'confirmed', bookingId: record.id, acuityId: appt.id };
  } catch (err) {
    if (err instanceof AcuityError && err.unreachable) {
      // Acuity went down between verify and push → keep it queued, still confirm.
      setAcuityStatus(false);
      markAttempt.run({ now: new Date().toISOString(), err: 'unreachable at push', id: record.id });
      recordAudit({ event_type: 'booking', actor: 'patient', ip: ctx.ip, success: true, detail: { id: record.id, state: 'queued', reason: 'acuity_unreachable' } });
      return { ok: true, state: 'queued', bookingId: record.id };
    }
    if (err instanceof AcuityError && err.status >= 400 && err.status < 500) {
      // Acuity actively rejected (slot taken in the final seconds) → undo hold.
      openSlot(record.appointment_type_id, record.appointment_datetime);
      deleteBooking.run(record.id);
      recordAudit({ event_type: 'booking', actor: 'patient', ip: ctx.ip, success: false, detail: { id: record.id, state: 'rejected', message: err.message } });
      return { ok: false, code: 'slot_taken', message: 'That time was just taken. Please choose another.' };
    }
    throw err;
  }
}
