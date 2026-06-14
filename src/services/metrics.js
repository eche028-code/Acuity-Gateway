// Aggregated metrics for the admin dashboard (spec #16): sync lag, failed
// bookings, Acuity connection health, SMS failures, queue depth, error counts.
import { db, getState } from '../db/index.js';
import { getAcuityStatus } from './status.js';

const cQueue = db.prepare(`SELECT COUNT(*) n FROM pending_bookings WHERE synced=0 AND status!='cancelled'`);
const cOldest = db.prepare(`SELECT MIN(created_at) m FROM pending_bookings WHERE synced=0 AND status!='cancelled'`);
const cPending = db.prepare(`SELECT COUNT(*) n FROM pending_bookings`);
const cSynced = db.prepare(`SELECT COUNT(*) n FROM pending_bookings WHERE synced=1`);
// Genuine sync failures only — a booking merely queued during an outage is
// healthy (it carries an 'offline'/'unreachable' note), not a failure. Count
// only rows with a real rejection recorded (e.g. a reconciliation collision).
const cFailedSync = db.prepare(
  `SELECT COUNT(*) n FROM pending_bookings
   WHERE synced=0 AND status!='cancelled'
     AND sync_error IS NOT NULL
     AND sync_error NOT LIKE '%offline%'
     AND sync_error NOT LIKE '%unreachable%'`,
);
const cRecon = db.prepare(`SELECT COUNT(*) n FROM reconciliation_flags WHERE status='open'`);
const cSmsFailed = db.prepare(`SELECT COUNT(*) n FROM sms_log WHERE status='failed'`);
const cErrors = db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE success=0 AND ts >= ?`);
const cSlots = db.prepare(`SELECT COUNT(*) n FROM availability_cache WHERE is_available=1`);

export function getMetrics() {
  const oldest = cOldest.get().m;
  const oldestQueuedAgeMins = oldest ? Math.round((Date.now() - Date.parse(oldest)) / 60000) : 0;
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  return {
    now: new Date().toISOString(),
    acuity: getAcuityStatus(),
    lastAcuityOnline: getState('last_acuity_online'),
    lastAcuityOffline: getState('last_acuity_offline'),
    lastAvailabilityRefresh: getState('last_availability_refresh'),
    lastPurge: getState('last_purge'),
    openSlots: cSlots.get().n,
    queueDepth: cQueue.get().n,
    oldestQueuedAgeMins,
    failedSyncs: cFailedSync.get().n,
    openReconciliations: cRecon.get().n,
    totalPending: cPending.get().n,
    totalSynced: cSynced.get().n,
    smsFailures: cSmsFailed.get().n,
    errorsLast24h: cErrors.get(since24h).n,
  };
}
