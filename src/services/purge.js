// Scheduled retention purge (spec #19–#22, APP 11).
//
// CANONICAL PII rule: purge a pending booking only when
//   synced == true  AND  appointment_date is older than the backstop window.
// Age ALONE never purges, and un-synced bookings (the outage-recovery queue)
// are exempt regardless of age. Also trims old sms_log rows. Every run logs
// what it purged to the audit trail.
import { db, getState, setState } from '../db/index.js';
import { config } from '../config.js';
import { recordAudit } from '../middleware/audit.js';
import { logger } from '../lib/logger.js';

// synced=1 AND date(appointment_date) < (today - backstopDays).
// Un-synced rows are never matched here → exempt.
const purgePii = db.prepare(
  `DELETE FROM pending_bookings WHERE synced = 1 AND date(appointment_date) < date('now', ?)`,
);
const purgeSms = db.prepare(`DELETE FROM sms_log WHERE created_at < ?`);

export function runPurge(trigger = 'scheduled') {
  const backstop = `-${config.retention.backstopDays} days`;
  const smsCutoff = new Date(Date.now() - config.retention.smsRetentionDays * 86400000).toISOString();

  const purgedPii = purgePii.run(backstop).changes || 0;
  const purgedSms = purgeSms.run(smsCutoff).changes || 0;

  setState('last_purge', new Date().toISOString());
  recordAudit({
    event_type: 'purge',
    actor: 'system',
    success: true,
    detail: { trigger, purgedPii, purgedSms, backstopDays: config.retention.backstopDays },
  });
  logger.info({ trigger, purgedPii, purgedSms }, 'retention purge completed');
  return { purgedPii, purgedSms };
}

// Called hourly. Runs at most once per day, at/after the configured hour.
export function runPurgeIfDue() {
  const now = new Date();
  if (now.getHours() < config.retention.purgeHour) return;
  const today = now.toISOString().slice(0, 10);
  const last = getState('last_purge');
  if (last && last.slice(0, 10) === today) return; // already purged today
  runPurge('scheduled');
}
