// Day-before SMS reminders (outbound expansion beyond the booking confirmation).
//
// Once per day (at/after SMS_REMINDER_HOUR) we remind every synced, confirmed
// booking whose appointment is TOMORROW and that hasn't been reminded yet. Each
// send goes through dispatchSms, so opt-out suppression and the enabled flag are
// honoured. `reminder_sent_at` is stamped on EVERY attempt (ok or fail) so the
// job is idempotent and never double-sends — for a clinic reminder a rare missed
// send is safer than a duplicate. Sends are sequential, which keeps us well under
// Cellcast's ~15 calls/s limit at clinic volume.
import { db, getState, setState } from '../db/index.js';
import { config } from '../config.js';
import { dispatchSms, formatWhen } from './sms.js';
import { recordAudit } from '../middleware/audit.js';
import { logger } from '../lib/logger.js';

const dueReminders = db.prepare(`
  SELECT id, first_name, last_name, phone, appointment_datetime
  FROM pending_bookings
  WHERE synced = 1 AND status = 'confirmed'
    AND phone IS NOT NULL AND phone != ''
    AND reminder_sent_at IS NULL
    AND appointment_date = ?
  ORDER BY appointment_datetime ASC
`);
const markReminded = db.prepare(
  `UPDATE pending_bookings SET reminder_sent_at = @now, updated_at = @now WHERE id = @id`,
);

// Local YYYY-MM-DD, `days` from today (matches appointment_date's local-day basis).
function localDate(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function runReminders(trigger = 'scheduled') {
  if (!config.cellcast.enabled || !config.reminders.enabled) {
    return { skipped: 'disabled', due: 0, sent: 0 };
  }
  const target = localDate(1); // tomorrow
  const due = dueReminders.all(target);
  let sent = 0, failed = 0, suppressed = 0;

  for (const b of due) {
    const when = formatWhen(b.appointment_datetime);
    const msg = `${config.clinic.name}: reminder — your appointment is on ${when}. Reply STOP to opt out.`;
    const r = await dispatchSms({ to: b.phone, message: msg, kind: 'reminder', bookingId: b.id });
    markReminded.run({ now: new Date().toISOString(), id: b.id });
    if (r.ok) sent++;
    else if (r.skipped) suppressed++;
    else failed++;
  }

  setState('last_reminders', new Date().toISOString());
  recordAudit({ event_type: 'sms', actor: 'system', success: true, detail: { kind: 'reminders', trigger, target, due: due.length, sent, failed, suppressed } });
  logger.info({ trigger, target, due: due.length, sent, failed, suppressed }, 'reminders run');
  return { due: due.length, sent, failed, suppressed };
}

// Called hourly. Runs at most once per day, at/after the configured hour.
export function runRemindersIfDue() {
  if (!config.cellcast.enabled || !config.reminders.enabled) return;
  const now = new Date();
  if (now.getHours() < config.reminders.hour) return;
  const today = now.toISOString().slice(0, 10);
  const last = getState('last_reminders');
  if (last && last.slice(0, 10) === today) return; // already run today
  runReminders('scheduled').catch((err) => logger.warn({ err: err.message }, 'reminders job failed'));
}
