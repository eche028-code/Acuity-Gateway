// Sync & resilience (spec #4–#7).
//
//   • processQueue()  — replay outage-queued bookings up to Acuity.
//   • checkHealth()   — ping Acuity; on the offline→online edge, replay the
//                       queue and reconcile (this is the reconnect pass).
//   • handleAcuityWebhook() — react to Acuity-side changes pushed to Gateway.
//   • registerWebhook()     — subscribe Gateway's callback with Acuity.
//
// Reconciliation surfaces collisions for a HUMAN in /admin (spec #7); it never
// silently overwrites either side.
import { db } from '../db/index.js';
import { config } from '../config.js';
import { acuity, AcuityError } from '../acuity/client.js';
import { setAcuityStatus, getAcuityStatus } from './status.js';
import { refreshAvailability, openSlot } from './availability.js';
import { sendBookingConfirmation } from './sms.js';
import { recordAudit } from '../middleware/audit.js';
import { logger } from '../lib/logger.js';

const pendingQueue = db.prepare(`
  SELECT * FROM pending_bookings
  WHERE synced = 0 AND status != 'cancelled'
  ORDER BY created_at ASC
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

const flagReconciliation = db.prepare(`
  INSERT INTO reconciliation_flags (kind, pending_booking_id, slot_datetime, detail, status, created_at)
  VALUES (@kind, @pending_booking_id, @slot_datetime, @detail, 'open', @created_at)
`);

let processing = false;

export async function processQueue() {
  if (processing) return { skipped: true };
  processing = true;
  let pushed = 0;
  let conflicts = 0;
  let stillDown = false;
  try {
    const rows = pendingQueue.all();
    for (const b of rows) {
      const now = new Date().toISOString();
      try {
        const appt = await acuity.createAppointment({
          appointmentTypeID: b.appointment_type_id,
          datetime: b.appointment_datetime,
          firstName: b.first_name,
          lastName: b.last_name,
          email: b.email,
          phone: b.phone,
          calendarID: b.calendar_id || undefined,
        });
        markSynced.run({ acuity_id: appt.id, now, id: b.id });
        setAcuityStatus(true);
        pushed++;
        // A booking made during the outage only got the "we'll confirm shortly"
        // SMS — now that it's actually synced, send the confirmation.
        sendBookingConfirmation(b, 'confirmed').catch(() => {});
      } catch (err) {
        if (err instanceof AcuityError && err.unreachable) {
          // Acuity dropped again mid-replay — stop, keep the rest queued.
          setAcuityStatus(false);
          stillDown = true;
          break;
        }
        if (err instanceof AcuityError && err.status >= 400 && err.status < 500) {
          // Slot collision: Acuity already has something here (the rare
          // last-second write before a crash). Surface it for a human (#7).
          markAttempt.run({ now, err: `reconcile: ${err.message}`, id: b.id });
          flagReconciliation.run({
            kind: 'collision',
            pending_booking_id: b.id,
            slot_datetime: b.appointment_datetime,
            detail: JSON.stringify({ message: err.message }),
            created_at: now,
          });
          conflicts++;
          recordAudit({ event_type: 'sync', actor: 'system', success: false, detail: { booking: b.id, kind: 'collision', message: err.message } });
        } else {
          markAttempt.run({ now, err: String(err.message || err), id: b.id });
        }
      }
    }
    if (pushed > 0 || conflicts > 0) {
      recordAudit({ event_type: 'sync', actor: 'system', success: true, detail: { pushed, conflicts } });
      logger.info({ pushed, conflicts }, 'queue replayed to Acuity');
    }
    return { pushed, conflicts, stillDown };
  } finally {
    processing = false;
  }
}

export async function checkHealth() {
  const was = getAcuityStatus();
  try {
    await acuity.ping();
    setAcuityStatus(true);
    if (was !== 'online') {
      logger.info('Acuity reconnected - replaying queue and reconciling');
      const result = await processQueue();
      await refreshAvailability();
      recordAudit({ event_type: 'sync', actor: 'system', success: true, detail: { event: 'reconnect', ...result } });
    }
    return true;
  } catch {
    setAcuityStatus(false);
    return false;
  }
}

// Acuity → Gateway. Webhook payloads carry only ids, so we re-sync rather than
// trust the (absent) body. A full availability refresh is the simplest correct
// reaction — it reflects new bookings, reschedules, and cancellations alike.
export async function handleAcuityWebhook({ action, id, appointmentTypeID }) {
  recordAudit({ event_type: 'webhook', actor: 'acuity', success: true, detail: { action, id } });
  try {
    await refreshAvailability();
  } catch (err) {
    logger.warn({ err: err.message }, 'webhook-triggered refresh failed');
  }
  return true;
}

export async function registerWebhook() {
  const target = `${config.publicBaseUrl}/webhooks/acuity`;
  const events = ['appointment.scheduled', 'appointment.rescheduled', 'appointment.canceled'];
  for (const event of events) {
    try {
      await acuity.subscribeWebhook({ target, event });
    } catch (err) {
      if (err instanceof AcuityError && err.unreachable) return false; // try again later
      logger.warn({ err: err.message, event }, 'webhook subscription failed');
    }
  }
  logger.info({ target }, 'webhooks registered with Acuity');
  return true;
}

// ── Metrics (for the public status endpoint and the future /admin) ──
const countUnsynced = db.prepare(
  `SELECT COUNT(*) AS n FROM pending_bookings WHERE synced = 0 AND status != 'cancelled'`,
);
const countOpenFlags = db.prepare(`SELECT COUNT(*) AS n FROM reconciliation_flags WHERE status = 'open'`);

export function queueDepth() {
  return countUnsynced.get().n;
}
export function openReconciliationCount() {
  return countOpenFlags.get().n;
}
