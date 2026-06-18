// SMS orchestration + logging.
//
// Every outbound message — booking confirmation, day-before reminder, or a
// free-text staff reply — funnels through ONE chokepoint (`dispatchSms`) so the
// opt-out suppression check can never be bypassed. Inbound replies are
// correlated to a booking, intent-classified, deduped, and surfaced to staff
// (handoff: "surface everything" — the Gateway never auto-cancels). SMS is
// best-effort: a send failure never blocks a booking. Every message (in + out)
// is written to sms_log; bodies are PII, trimmed by the retention purge.
import { db, transaction } from '../db/index.js';
import { config } from '../config.js';
import { sendSms, normalizeAuNumber } from '../sms/cellcast.js';
import { recordAudit } from '../middleware/audit.js';
import { logger } from '../lib/logger.js';
import { parseIntent } from './sms-intent.js';
import { pickBooking } from './sms-match.js';
import { smsEnabled } from './settings.js';
import { acuity, AcuityError } from '../acuity/client.js';

const insertSms = db.prepare(`
  INSERT INTO sms_log (direction, recipient, status, provider_id, booking_id, body,
                       intent, action_status, error, created_at)
  VALUES (@direction, @recipient, @status, @provider_id, @booking_id, @body,
          @intent, @action_status, @error, @created_at)
`);

function logSms(row) {
  return insertSms.run({
    direction: row.direction,
    recipient: row.recipient || null,
    status: row.status || null,
    provider_id: row.provider_id || null,
    booking_id: row.booking_id || null,
    body: row.body || null,
    intent: row.intent || null,
    action_status: row.action_status || null,
    error: row.error || null,
    created_at: row.created_at || new Date().toISOString(),
  });
}

export function formatWhen(iso) {
  try {
    return new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

// ── Opt-out / suppression (compliance) ──────────────────────────────
const isSuppressedStmt = db.prepare('SELECT 1 FROM sms_suppressions WHERE number = ? LIMIT 1');
const addSuppressionStmt = db.prepare(
  `INSERT OR IGNORE INTO sms_suppressions (number, reason, created_at, created_by)
   VALUES (@number, @reason, @created_at, @created_by)`,
);
const removeSuppressionStmt = db.prepare('DELETE FROM sms_suppressions WHERE number = ?');

export function isSuppressed(number) {
  const n = normalizeAuNumber(number);
  return n ? !!isSuppressedStmt.get(n) : false;
}

export function addSuppression(number, { reason = 'manual', by = 'admin' } = {}) {
  const n = normalizeAuNumber(number);
  if (!n) return false;
  addSuppressionStmt.run({ number: n, reason, created_at: new Date().toISOString(), created_by: by });
  return true;
}

export function removeSuppression(number) {
  const n = normalizeAuNumber(number);
  if (!n) return false;
  return removeSuppressionStmt.run(n).changes > 0;
}

// ── Outbound chokepoint ─────────────────────────────────────────────
// The ONLY function that calls the Cellcast client. Enforces enabled + opt-out,
// then logs the outcome. `kind` ∈ confirmation | reminder | staff. Returns the
// raw sendSms result ({ ok } | { skipped, reason } | { error }).
export async function dispatchSms({ to, message, kind = 'staff', bookingId = null }) {
  if (!smsEnabled()) {
    logSms({ direction: 'outbound', recipient: to, status: 'skipped', booking_id: bookingId, body: message, error: 'sms_disabled' });
    return { ok: false, skipped: true, reason: 'sms_disabled' };
  }
  if (isSuppressed(to)) {
    logSms({ direction: 'outbound', recipient: normalizeAuNumber(to), status: 'skipped', booking_id: bookingId, body: message, error: 'suppressed' });
    recordAudit({ event_type: 'sms', actor: 'system', success: true, detail: { kind, reason: 'suppressed', booking: bookingId } });
    return { ok: false, skipped: true, reason: 'suppressed' };
  }

  const result = await sendSms({ to, message });
  if (result.ok) {
    logSms({ direction: 'outbound', recipient: result.number, status: 'sent', provider_id: result.providerId, booking_id: bookingId, body: message });
  } else if (result.skipped) {
    logSms({ direction: 'outbound', recipient: to, status: 'skipped', booking_id: bookingId, body: message, error: result.reason });
  } else {
    logSms({ direction: 'outbound', recipient: result.number || to, status: 'failed', booking_id: bookingId, body: message, error: result.error });
    recordAudit({ event_type: 'sms', actor: 'system', success: false, detail: { kind, booking: bookingId, error: result.error } });
    logger.warn({ kind, booking: bookingId, error: result.error }, 'sms send failed');
  }
  return result;
}

// `booking` is the pending_bookings record (snake_case). `state` is
// 'confirmed' | 'queued'. Fire-and-forget from the booking flow.
export async function sendBookingConfirmation(booking, state) {
  if (!booking.phone) return;
  const when = formatWhen(booking.appointment_datetime);
  const msg =
    state === 'confirmed'
      ? `${config.clinic.name}: your appointment on ${when} is confirmed.`
      : `${config.clinic.name}: we've received your appointment request for ${when} and will confirm shortly.`;
  await dispatchSms({ to: booking.phone, message: msg, kind: 'confirmation', bookingId: booking.id });
}

// Free-text staff → patient message, sent from /admin. Audited (a human acted).
export async function sendStaffSms({ to, message, bookingId = null, ip = null }) {
  const result = await dispatchSms({ to, message, kind: 'staff', bookingId });
  recordAudit({
    event_type: 'sms',
    actor: 'admin',
    ip,
    success: !!result.ok,
    detail: { kind: 'staff', to: normalizeAuNumber(to), reason: result.reason || null, error: result.error || null },
  });
  return result;
}

// ── Inbound routing ─────────────────────────────────────────────────
const findInboundDupe = db.prepare(
  `SELECT id FROM sms_log WHERE direction = 'inbound' AND provider_id = ? LIMIT 1`,
);
// Candidate bookings for number→booking correlation (matched in JS by pickBooking).
const recentWithPhone = db.prepare(`
  SELECT id, phone, appointment_datetime, created_at
  FROM pending_bookings
  WHERE phone IS NOT NULL AND status != 'cancelled'
  ORDER BY created_at DESC
  LIMIT 200
`);
// Best-effort DLR → update the matching outbound row so the thread shows delivery.
const updateDlrStatus = db.prepare(
  `UPDATE sms_log SET status = @status WHERE direction = 'outbound' AND provider_id = @pid`,
);
// Content-based dedup for the poll path: getResponses items carry NO message id,
// so a reply is "already seen" if a matching inbound row exists near its receive
// time (catches a reply the webhook already stored). Tight window avoids falsely
// merging two identical replies sent minutes apart.
const inboundContentDupe = db.prepare(
  `SELECT id FROM sms_log WHERE direction = 'inbound' AND recipient = @recipient
     AND body IS @body AND created_at BETWEEN @from AND @to LIMIT 1`,
);
export function inboundAlreadySeen(recipient, body, receivedAtIso) {
  const n = normalizeAuNumber(recipient) || recipient || null;
  const t = Date.parse(receivedAtIso || '') || Date.now();
  return !!inboundContentDupe.get({
    recipient: n,
    body: body ?? null,
    from: new Date(t - 90_000).toISOString(),
    to: new Date(t + 150_000).toISOString(),
  });
}

function correlate(number, nowIso) {
  if (!number) return null;
  return pickBooking(recentWithPhone.all(), number, nowIso);
}

// Booking details used to enrich a reply forwarded to Acuity.
const bookingForForward = db.prepare(
  `SELECT acuity_appointment_id, first_name, last_name FROM pending_bookings WHERE id = ?`,
);

// Best-effort: forward a patient's inbound reply INTO Acuity so staff see it in
// their own system (Gateway → Acuity, POST /sms/inbound). Never throws — the reply
// is already logged and surfaced in /admin; a forward failure is audited only.
export async function forwardInboundToAcuity({ from, body, providerId, intent, bookingId = null, receivedAt = null }) {
  if (!config.acuity.forwardInboundSms) return;
  let appointmentId = null;
  let patient = null;
  if (bookingId) {
    const b = bookingForForward.get(bookingId);
    if (b) {
      appointmentId = b.acuity_appointment_id || null;
      patient = { firstName: b.first_name || null, lastName: b.last_name || null };
    }
  }
  try {
    await acuity.forwardInboundSms({
      from: normalizeAuNumber(from) || from,
      message: body || null,
      receivedAt: receivedAt || new Date().toISOString(),
      providerId: providerId || null,
      intent: intent || 'unknown',
      appointmentId,
      patient,
    });
  } catch (err) {
    const unreachable = err instanceof AcuityError && err.unreachable;
    recordAudit({ event_type: 'sms', actor: 'system', success: false, detail: { kind: 'forward_inbound', provider_id: providerId, unreachable: !!unreachable, error: err.message } });
    logger.warn({ providerId, err: err.message }, 'forward inbound SMS to Acuity failed');
  }
}

// Record an inbound reply (MO) or delivery receipt (DLR) from the webhook.
// Synchronous (no awaits) so the dedupe-check + insert can't interleave.
export function recordInboundSms({ direction, recipient, status, providerId, body, receivedAt = null }) {
  // Delivery receipts: log, and reflect terminal delivery state on the outbound row.
  if (direction !== 'inbound') {
    if (providerId && status) {
      const s = String(status).toLowerCase();
      const mapped = s.includes('deliver') && !s.includes('undeliver') ? 'delivered'
        : (s.includes('fail') || s.includes('undeliver') || s.includes('reject')) ? 'failed'
        : null;
      if (mapped) updateDlrStatus.run({ status: mapped, pid: providerId });
    }
    logSms({ direction, recipient, status, provider_id: providerId, body });
    return { logged: true };
  }

  // Idempotency: Cellcast may retry the webhook — process a message id only once.
  if (providerId && findInboundDupe.get(providerId)) {
    return { duplicate: true };
  }

  const number = normalizeAuNumber(recipient);
  const intent = parseIntent(body);
  const nowIso = new Date().toISOString();
  const booking = correlate(number, receivedAt || nowIso);

  return transaction(() => {
    // STOP → auto-suppress immediately (compliance; the daily reminder job is an
    // automated outbound path, so we cannot wait for staff). Reversible from /admin.
    if (intent === 'stop' && number) {
      addSuppression(number, { reason: 'stop_reply', by: 'patient' });
    }
    logSms({
      direction: 'inbound',
      recipient: number || recipient,
      status: status || 'received',
      provider_id: providerId,
      booking_id: booking ? booking.id : null,
      body,
      intent,
      action_status: 'open', // surface every reply for staff (never auto-act on bookings)
      created_at: receivedAt || nowIso, // poll backfill keeps true receive time + thread order
    });
    return { logged: true, intent, bookingId: booking ? booking.id : null, suppressed: intent === 'stop' };
  });
}

// ── Hub read API ────────────────────────────────────────────────────
// The same inbound-SMS data the /admin "Messages" hub renders, exposed as plain
// functions so it can ALSO be served over the Bearer-gated /internal API to the
// clinic's Acuity instance (its right-rail "SMS" hub pulls from here, then deep-
// links each message into the matching patient profile). Single source of truth:
// every inbound reply (webhook + poll backfill + history) lives in sms_log.

// Recent inbound replies, newest first. Joins the best-effort booking match so a
// portal/queued patient shows a name; front-desk numbers come through unnamed and
// Acuity resolves them to a client by phone. `@since`/`@unhandledOnly` are optional
// filters (poll-for-new / "needs attention" badge); both off → the full feed.
const selectInboundFeed = db.prepare(`
  SELECT s.id, s.recipient AS number, s.body, s.intent, s.action_status, s.created_at,
         s.booking_id, b.first_name, b.last_name, b.appointment_datetime
  FROM sms_log s
  LEFT JOIN pending_bookings b ON b.id = s.booking_id
  WHERE s.direction='inbound'
    AND (@unhandledOnly = 0 OR s.action_status='open')
    AND (@since IS NULL OR s.created_at > @since)
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT @limit
`);
const countUnhandledInbound = db.prepare(
  `SELECT COUNT(*) AS n FROM sms_log WHERE direction='inbound' AND action_status='open'`,
);

export function unhandledInboundCount() {
  return countUnhandledInbound.get().n;
}

export function listInboundFeed({ since = null, unhandledOnly = false, limit = 50 } = {}) {
  const rows = selectInboundFeed.all({
    since: since || null,
    unhandledOnly: unhandledOnly ? 1 : 0,
    limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
  });
  return rows.map((r) => ({
    id: r.id,
    from: r.number, // normalized E.164 — Acuity matches this to a patient/profile
    body: r.body,
    intent: r.intent,
    receivedAt: r.created_at,
    handled: r.action_status !== 'open',
    bookingId: r.booking_id || null,
    patient:
      r.first_name || r.last_name
        ? { firstName: r.first_name || null, lastName: r.last_name || null }
        : null,
    appointmentAt: r.appointment_datetime || null,
  }));
}

// Full conversation (in + out) for one number, oldest first — what the patient
// profile shows. Returns null for an unparseable number.
const selectThreadByNumber = db.prepare(`
  SELECT id, direction, status, body, intent, created_at
  FROM sms_log
  WHERE recipient = ? AND direction IN ('inbound','outbound')
  ORDER BY created_at ASC, id ASC
  LIMIT 500
`);

export function getThread(number) {
  const n = normalizeAuNumber(number);
  if (!n) return null;
  const messages = selectThreadByNumber.all(n).map((m) => ({
    id: m.id,
    direction: m.direction,
    body: m.body,
    intent: m.intent,
    status: m.status,
    createdAt: m.created_at,
  }));
  return { number: n, messages };
}

// Clear the "needs attention" flag — e.g. when staff open the patient/conversation
// from the hub. By id (one reply) or by number (all open replies for that patient).
const handleInboundById = db.prepare(
  `UPDATE sms_log SET action_status='handled', handled_at=@now, handled_by=@by
     WHERE id=@id AND direction='inbound' AND action_status='open'`,
);
const handleInboundByNumber = db.prepare(
  `UPDATE sms_log SET action_status='handled', handled_at=@now, handled_by=@by
     WHERE recipient=@number AND direction='inbound' AND action_status='open'`,
);

export function markInboundHandled({ id = null, number = null, by = 'acuity' } = {}) {
  const now = new Date().toISOString();
  if (id !== null && id !== undefined && id !== '') {
    return handleInboundById.run({ id: Number(id), now, by }).changes;
  }
  const n = normalizeAuNumber(number);
  if (!n) return 0;
  return handleInboundByNumber.run({ number: n, now, by }).changes;
}
