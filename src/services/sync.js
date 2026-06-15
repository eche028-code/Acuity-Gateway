// Sync & resilience (spec #4–#7).
//
//   • processQueue() — replay outage-queued bookings to Acuity (idempotent).
//   • checkHealth()  — ping Acuity; on the offline→online edge, replay + reconcile.
//   • pollChanges()  — pull Acuity-side changes (front-desk bookings, reschedules,
//                      cancellations) via the /changes cursor and refresh the cache.
//
// Acuity is reached over Tailscale and does NOT push webhooks to us, so the
// Gateway→Acuity sync is poll-based. Reconciliation surfaces collisions for a
// human in /admin (spec #7) — never a silent overwrite.
import { db, getState, setState } from '../db/index.js';
import { acuity, AcuityError } from '../acuity/client.js';
import { setAcuityStatus, getAcuityStatus } from './status.js';
import { refreshAvailability, closeSlot, openSlot } from './availability.js';
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

// Build the Acuity create payload from a pending_bookings row. The Gateway's own
// booking id is the idempotencyKey so a replayed booking never duplicates.
export function acuityPayload(b) {
  return {
    idempotencyKey: b.id,
    appointmentTypeId: b.appointment_type_id,
    start: b.appointment_datetime,
    practitionerId: b.calendar_id || undefined,
    patient: {
      firstName: b.first_name,
      lastName: b.last_name,
      phone: b.phone || undefined,
      email: b.email || undefined,
      isNew: !!b.is_new_patient,
      address: b.address || undefined,
      suburb: b.city || undefined,
      state: b.state || undefined,
      postcode: b.postcode || undefined,
      notes: b.notes || undefined,
    },
  };
}

let processing = false;
export async function processQueue() {
  if (processing) return { skipped: true };
  processing = true;
  let pushed = 0;
  let conflicts = 0;
  let stillDown = false;
  try {
    for (const b of pendingQueue.all()) {
      const now = new Date().toISOString();
      try {
        const appt = await acuity.createAppointment(acuityPayload(b));
        markSynced.run({ acuity_id: appt.appointmentId, now, id: b.id });
        setAcuityStatus(true);
        pushed++;
        // Queued during the outage → it only got the "we'll confirm shortly"
        // SMS; now that it's synced, send the confirmation.
        sendBookingConfirmation(b, 'confirmed').catch(() => {});
      } catch (err) {
        if (err instanceof AcuityError && err.unreachable) {
          setAcuityStatus(false);
          stillDown = true;
          break;
        }
        if (err instanceof AcuityError && err.status === 409) {
          // Slot collision (a write landed in Acuity that we didn't know about)
          // → surface for a human (#7), don't overwrite.
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
      logger.info('Acuity reachable - replaying queue and reconciling');
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

// Poll Acuity for changes it made on its side (front-desk bookings, reschedules,
// cancellations) and keep the availability cache fresh. Skips our own echoes
// (source === 'gateway'). The cursor is opaque and never redelivers a row.
let polling = false;
export async function pollChanges() {
  if (polling) return;
  polling = true;
  try {
    const since = getState('changes_cursor') || '';
    let resp;
    try {
      resp = await acuity.getChanges({ since });
    } catch (err) {
      if (err instanceof AcuityError && err.unreachable) {
        setAcuityStatus(false);
        return;
      }
      throw err;
    }
    setAcuityStatus(true);
    const changes = (resp && resp.changes) || [];
    // Skip our own bookings echoing back — already reflected locally at booking.
    const external = changes.filter((c) => c.source !== 'gateway');

    // Apply each front-desk change straight to the cache so availability tracks
    // Acuity within a poll interval (~20s), not the periodic full refresh:
    //   created   → slot is now taken    → close it
    //   cancelled → slot is now free     → reopen it
    // An `updated` (reschedule) frees one slot and takes another but the record
    // only carries the new start, so it can't be applied precisely — fall back
    // to a full refresh to reconcile. Same for any change missing its slot.
    let needFullRefresh = false;
    let applied = 0;
    for (const c of external) {
      const type = String(c.type || '').toLowerCase();
      if (!c.appointmentTypeId || !c.start) {
        needFullRefresh = true;
      } else if (type === 'created') {
        closeSlot(c.appointmentTypeId, c.start);
        applied++;
      } else if (type === 'cancelled' || type === 'canceled') {
        openSlot(c.appointmentTypeId, c.start);
        applied++;
      } else {
        needFullRefresh = true; // updated / reschedule / unknown
      }
    }
    if (external.length > 0) {
      logger.info({ changes: external.length, applied, fullRefresh: needFullRefresh }, 'applied external Acuity changes');
    }
    if (needFullRefresh) await refreshAvailability();

    if (resp && resp.cursor) setState('changes_cursor', resp.cursor);
  } finally {
    polling = false;
  }
}

// ── Metrics ─────────────────────────────────────────────────────────
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
