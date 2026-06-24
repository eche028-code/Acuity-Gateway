// Admin dashboard routes (spec #15–#17). Mounted at /admin.
//
// The HTML shell and its assets are served unauthenticated (they carry no
// data); everything under /admin/api/* requires a valid admin session. Login
// attempts are audit-logged. The reconciliation report lives here too (#7):
// collisions are surfaced for a human to resolve — never auto-merged.
import express from 'express';
import crypto from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/index.js';
import {
  requireAdmin,
  checkPassword,
  setAdminPassword,
  ipAllowed,
  setAdminCookie,
  clearAdminCookie,
} from '../middleware/admin.js';
import { adminLoginRateLimit } from '../middleware/security.js';
import { recordAudit } from '../middleware/audit.js';
import { getMetrics } from '../services/metrics.js';
import { runPurge } from '../services/purge.js';
import { processQueue } from '../services/sync.js';
import { sendStaffSms, addSuppression, removeSuppression } from '../services/sms.js';
import { normalizeAuNumber } from '../sms/cellcast.js';
import {
  settingsStatus,
  setCellcastApiKey,
  setCellcastSenderId,
  setInboundApiKey,
  hiddenAppointmentTypeIds,
  setAppointmentTypeHidden,
  appointmentTypeDescriptions,
  setAppointmentTypeDescription,
} from '../services/settings.js';
import { getAppointmentTypes } from '../services/availability.js';

export const admin = express.Router();
const here = dirname(fileURLToPath(import.meta.url));
const adminDir = resolve(here, '../../admin');

// ── Auth ────────────────────────────────────────────────────────────
admin.post('/api/login', adminLoginRateLimit(), (req, res) => {
  if (!ipAllowed(req)) {
    recordAudit({ event_type: 'admin_login', actor: 'admin', ip: req.ip, success: false, detail: { reason: 'ip_not_allowed' } });
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!checkPassword((req.body || {}).password)) {
    recordAudit({ event_type: 'admin_login', actor: 'admin', ip: req.ip, success: false, detail: { reason: 'bad_password' } });
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  setAdminCookie(res);
  recordAudit({ event_type: 'admin_login', actor: 'admin', ip: req.ip, success: true });
  res.json({ ok: true });
});

admin.post('/api/logout', (req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

// Change the admin password (requires a valid session + the current password).
admin.post('/api/password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!checkPassword(currentPassword)) {
    recordAudit({ event_type: 'admin_password', actor: 'admin', ip: req.ip, success: false, detail: { reason: 'bad_current' } });
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'weak_password', message: 'New password must be at least 8 characters.' });
  }
  setAdminPassword(newPassword);
  recordAudit({ event_type: 'admin_password', actor: 'admin', ip: req.ip, success: true });
  res.json({ ok: true });
});

// ── Metrics & operations (all require an admin session) ─────────────
admin.get('/api/metrics', requireAdmin, (_req, res) => {
  res.json(getMetrics());
});

const selectQueue = db.prepare(`
  SELECT id, appointment_type_id, appointment_datetime, first_name, last_name, phone,
         sync_attempts, last_attempt_at, sync_error, created_at
  FROM pending_bookings
  WHERE synced=0 AND status!='cancelled'
  ORDER BY created_at ASC LIMIT 200
`);
admin.get('/api/queue', requireAdmin, (_req, res) => {
  res.json({ queue: selectQueue.all() });
});

const selectRecon = db.prepare(`
  SELECT * FROM reconciliation_flags
  ORDER BY (status='open') DESC, created_at DESC LIMIT 200
`);
const resolveRecon = db.prepare(
  `UPDATE reconciliation_flags SET status='resolved', resolved_at=@now, resolved_by='admin' WHERE id=@id AND status='open'`,
);
admin.get('/api/reconciliation', requireAdmin, (_req, res) => {
  res.json({ flags: selectRecon.all() });
});
admin.post('/api/reconciliation/:id/resolve', requireAdmin, (req, res) => {
  const result = resolveRecon.run({ id: Number(req.params.id), now: new Date().toISOString() });
  recordAudit({ event_type: 'reconcile', actor: 'admin', ip: req.ip, success: true, detail: { id: Number(req.params.id), resolved: result.changes } });
  res.json({ ok: true, resolved: result.changes });
});

const selectAudit = db.prepare(
  `SELECT id, ts, event_type, actor, ip, success, detail FROM audit_log ORDER BY id DESC LIMIT ?`,
);
admin.get('/api/audit', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ audit: selectAudit.all(limit) });
});

// ── SMS: conversations, action queue, staff replies, opt-outs ───────
// Thread list: one row per number, newest first, with a peek at the last message
// and the count of inbound replies still awaiting a human.
const selectThreads = db.prepare(`
  SELECT recipient,
         COUNT(*) AS total,
         MAX(created_at) AS last_at,
         SUM(CASE WHEN direction='inbound' AND action_status='open' THEN 1 ELSE 0 END) AS open_actions,
         (SELECT body FROM sms_log s2 WHERE s2.recipient = s1.recipient
            AND s2.direction IN ('inbound','outbound') ORDER BY created_at DESC, id DESC LIMIT 1) AS last_body,
         (SELECT direction FROM sms_log s2 WHERE s2.recipient = s1.recipient
            AND s2.direction IN ('inbound','outbound') ORDER BY created_at DESC, id DESC LIMIT 1) AS last_direction,
         EXISTS (SELECT 1 FROM sms_suppressions sup WHERE sup.number = s1.recipient) AS suppressed
  FROM sms_log s1
  WHERE recipient IS NOT NULL AND recipient != '' AND direction IN ('inbound','outbound')
  GROUP BY recipient
  ORDER BY last_at DESC
  LIMIT 200
`);
admin.get('/api/sms/threads', requireAdmin, (_req, res) => {
  res.json({ threads: selectThreads.all() });
});

const selectThread = db.prepare(`
  SELECT id, direction, status, body, intent, action_status, booking_id, created_at
  FROM sms_log
  WHERE recipient = ? AND direction IN ('inbound','outbound')
  ORDER BY created_at ASC, id ASC
  LIMIT 500
`);
admin.get('/api/sms/thread', requireAdmin, (req, res) => {
  const number = normalizeAuNumber(req.query.number);
  if (!number) return res.status(400).json({ error: 'bad_number' });
  res.json({ number, messages: selectThread.all(number) });
});

const selectActions = db.prepare(`
  SELECT s.id, s.recipient, s.body, s.intent, s.created_at, s.booking_id,
         b.first_name, b.last_name, b.appointment_datetime
  FROM sms_log s
  LEFT JOIN pending_bookings b ON b.id = s.booking_id
  WHERE s.direction='inbound' AND s.action_status='open'
  ORDER BY s.created_at DESC
  LIMIT 200
`);
admin.get('/api/sms/actions', requireAdmin, (_req, res) => {
  res.json({ actions: selectActions.all() });
});

const handleAction = db.prepare(
  `UPDATE sms_log SET action_status='handled', handled_at=@now, handled_by='admin'
   WHERE id=@id AND direction='inbound' AND action_status='open'`,
);
admin.post('/api/sms/actions/:id/handle', requireAdmin, (req, res) => {
  const result = handleAction.run({ id: Number(req.params.id), now: new Date().toISOString() });
  recordAudit({ event_type: 'sms', actor: 'admin', ip: req.ip, success: true, detail: { handled: result.changes, id: Number(req.params.id) } });
  res.json({ ok: true, handled: result.changes });
});

// Free-text staff → patient reply. Honours opt-out (suppressed → 409).
admin.post('/api/sms/send', requireAdmin, async (req, res, next) => {
  try {
    const { to, message, bookingId } = req.body || {};
    const number = normalizeAuNumber(to);
    const text = String(message || '').trim();
    if (!number) return res.status(400).json({ error: 'bad_number' });
    if (!text) return res.status(400).json({ error: 'empty_message' });
    if (text.length > 1000) return res.status(400).json({ error: 'too_long', message: 'Keep messages under 1000 characters.' });

    const result = await sendStaffSms({ to: number, message: text, bookingId: bookingId || null, ip: req.ip });
    if (result.ok) return res.json({ ok: true });
    if (result.reason === 'suppressed') return res.status(409).json({ error: 'suppressed', message: 'This number has opted out. Remove the opt-out first to message them.' });
    if (result.reason === 'sms_disabled') return res.status(409).json({ error: 'sms_disabled', message: 'SMS is not configured (no Cellcast key).' });
    return res.status(502).json({ error: 'send_failed', message: result.error || 'Cellcast send failed.' });
  } catch (err) {
    next(err);
  }
});

// Opt-out management (so staff can reverse an accidental STOP).
const selectSuppressions = db.prepare(
  `SELECT number, reason, created_at, created_by FROM sms_suppressions ORDER BY created_at DESC LIMIT 500`,
);
admin.get('/api/sms/suppressions', requireAdmin, (_req, res) => {
  res.json({ suppressions: selectSuppressions.all() });
});
admin.post('/api/sms/suppress', requireAdmin, (req, res) => {
  const number = normalizeAuNumber((req.body || {}).number);
  if (!number) return res.status(400).json({ error: 'bad_number' });
  addSuppression(number, { reason: 'manual', by: 'admin' });
  recordAudit({ event_type: 'sms', actor: 'admin', ip: req.ip, success: true, detail: { suppress: number } });
  res.json({ ok: true });
});
admin.post('/api/sms/unsuppress', requireAdmin, (req, res) => {
  const number = normalizeAuNumber((req.body || {}).number);
  if (!number) return res.status(400).json({ error: 'bad_number' });
  const removed = removeSuppression(number);
  recordAudit({ event_type: 'sms', actor: 'admin', ip: req.ip, success: true, detail: { unsuppress: number, removed } });
  res.json({ ok: true, removed });
});

// Manual ops triggers (handy for ops; both are also automatic).
admin.post('/api/purge', requireAdmin, (req, res) => {
  res.json(runPurge('manual'));
});
admin.post('/api/sync', requireAdmin, async (req, res, next) => {
  try {
    res.json(await processQueue());
  } catch (err) {
    next(err);
  }
});

// ── Integration settings (Cellcast key/sender + Acuity inbound key) ──
// Stored DB-side (overriding .env), so they can be set without a restart.
admin.get('/api/settings', requireAdmin, (_req, res) => {
  res.json(settingsStatus());
});

// Set/clear the Cellcast API key and/or sender id. Empty string clears the DB
// override (falls back to .env). Never echoes the stored secret back.
admin.post('/api/settings/cellcast', requireAdmin, (req, res) => {
  const { apiKey, senderId } = req.body || {};
  if (apiKey !== undefined) setCellcastApiKey(apiKey);
  if (senderId !== undefined) setCellcastSenderId(senderId);
  recordAudit({ event_type: 'settings', actor: 'admin', ip: req.ip, success: true, detail: { cellcastApiKey: apiKey !== undefined, cellcastSender: senderId !== undefined } });
  res.json({ ok: true, settings: settingsStatus() });
});

// Generate a fresh Acuity inbound key and return it ONCE (to copy into Acuity).
admin.post('/api/settings/inbound-key/generate', requireAdmin, (req, res) => {
  const key = crypto.randomBytes(24).toString('hex');
  setInboundApiKey(key);
  recordAudit({ event_type: 'settings', actor: 'admin', ip: req.ip, success: true, detail: { inboundKey: 'generated' } });
  res.json({ ok: true, key, settings: settingsStatus() });
});

// Send a one-off test SMS (verifies the Cellcast key end-to-end).
admin.post('/api/settings/test-sms', requireAdmin, async (req, res, next) => {
  try {
    const number = normalizeAuNumber((req.body || {}).to);
    if (!number) return res.status(400).json({ error: 'bad_number', message: 'Enter a valid AU mobile.' });
    const result = await sendStaffSms({ to: number, message: 'Gateway test SMS — your Cellcast integration is working. Please ignore.', ip: req.ip });
    if (result.ok) return res.json({ ok: true, providerId: result.providerId });
    if (result.reason === 'suppressed') return res.status(409).json({ error: 'suppressed', message: 'This number has opted out.' });
    if (result.reason === 'sms_disabled') return res.status(409).json({ error: 'sms_disabled', message: 'No Cellcast key configured.' });
    return res.status(502).json({ error: 'send_failed', message: result.error || 'Cellcast send failed.' });
  } catch (err) {
    next(err);
  }
});

// ── Booking portal: which appointment types are publicly bookable ───
// The admin can hide a type from the public booking page without changing
// anything in Acuity. Hidden types are filtered out of GET /appointment-types
// on the portal side; here the admin sees the full list with each type's flag.
admin.get('/api/appointment-types', requireAdmin, (_req, res) => {
  const hidden = new Set(hiddenAppointmentTypeIds());
  const descriptions = appointmentTypeDescriptions();
  const appointmentTypes = getAppointmentTypes().map((t) => ({
    id: t.id,
    name: t.name,
    duration: t.duration ?? null,
    // The editable value: admin-authored description wins, else Acuity's (if any).
    description: descriptions[String(t.id)] ?? t.description ?? null,
    hidden: hidden.has(String(t.id)),
  }));
  res.json({ appointmentTypes });
});

admin.post('/api/appointment-types/:id/visibility', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const hidden = !!(req.body || {}).hidden;
  setAppointmentTypeHidden(id, hidden);
  recordAudit({ event_type: 'settings', actor: 'admin', ip: req.ip, success: true, detail: { appointmentType: id, hidden } });
  res.json({ ok: true, hiddenAppointmentTypeIds: hiddenAppointmentTypeIds() });
});

// Set (or clear, when blank) an appointment type's description — shown on the
// public booking page as the ⓘ explainer. Capped at 1000 chars; the content is
// not logged (only whether one is now set).
admin.post('/api/appointment-types/:id/description', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const description = ((req.body || {}).description ?? '').toString();
  if (description.length > 1000) return res.status(400).json({ error: 'too_long' });
  setAppointmentTypeDescription(id, description);
  recordAudit({ event_type: 'settings', actor: 'admin', ip: req.ip, success: true, detail: { appointmentType: id, descriptionSet: !!description.trim() } });
  res.json({ ok: true });
});

// ── Static shell (unauthenticated; data comes from the gated APIs) ──
admin.get('/', (_req, res) => res.sendFile(resolve(adminDir, 'index.html')));
admin.use(express.static(adminDir, { index: false }));
