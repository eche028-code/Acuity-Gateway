// SMS orchestration + logging. Sends booking confirmations and records every
// send/inbound/DLR in sms_log (for the admin SMS-failure metric and ops). SMS
// is best-effort — a failure never blocks a booking.
import { db } from '../db/index.js';
import { config } from '../config.js';
import { sendSms } from '../sms/cellcast.js';
import { recordAudit } from '../middleware/audit.js';
import { logger } from '../lib/logger.js';

const insertSms = db.prepare(`
  INSERT INTO sms_log (direction, recipient, status, provider_id, booking_id, error, created_at)
  VALUES (@direction, @recipient, @status, @provider_id, @booking_id, @error, @created_at)
`);

function logSms(row) {
  insertSms.run({
    direction: row.direction,
    recipient: row.recipient || null,
    status: row.status,
    provider_id: row.provider_id || null,
    booking_id: row.booking_id || null,
    error: row.error || null,
    created_at: new Date().toISOString(),
  });
}

function formatWhen(iso) {
  try {
    return new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

// `booking` is the pending_bookings record (snake_case). `state` is
// 'confirmed' | 'queued'. Fire-and-forget from the booking flow.
export async function sendBookingConfirmation(booking, state) {
  if (!booking.phone) return;
  if (!config.cellcast.enabled) {
    logSms({ direction: 'outbound', recipient: booking.phone, status: 'skipped', booking_id: booking.id, error: 'sms_disabled' });
    return;
  }
  const when = formatWhen(booking.appointment_datetime);
  const msg =
    state === 'confirmed'
      ? `${config.clinic.name}: your appointment on ${when} is confirmed.`
      : `${config.clinic.name}: we've received your appointment request for ${when} and will confirm shortly.`;

  const result = await sendSms({ to: booking.phone, message: msg });
  if (result.ok) {
    logSms({ direction: 'outbound', recipient: result.number, status: 'sent', provider_id: result.providerId, booking_id: booking.id });
  } else if (result.skipped) {
    logSms({ direction: 'outbound', recipient: booking.phone, status: 'skipped', booking_id: booking.id, error: result.reason });
  } else {
    logSms({ direction: 'outbound', recipient: result.number || booking.phone, status: 'failed', booking_id: booking.id, error: result.error });
    recordAudit({ event_type: 'sms', actor: 'system', success: false, detail: { booking: booking.id, error: result.error } });
    logger.warn({ booking: booking.id, error: result.error }, 'sms send failed');
  }
}

// Record an inbound reply (MO) or delivery receipt (DLR) from the webhook.
export function recordInboundSms({ direction, recipient, status, providerId, error }) {
  logSms({ direction, recipient, status, provider_id: providerId, error });
}
