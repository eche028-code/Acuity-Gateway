// Admin dashboard routes (spec #15–#17). Mounted at /admin.
//
// The HTML shell and its assets are served unauthenticated (they carry no
// data); everything under /admin/api/* requires a valid admin session. Login
// attempts are audit-logged. The reconciliation report lives here too (#7):
// collisions are surfaced for a human to resolve — never auto-merged.
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/index.js';
import {
  requireAdmin,
  checkPassword,
  ipAllowed,
  setAdminCookie,
  clearAdminCookie,
} from '../middleware/admin.js';
import { adminLoginRateLimit } from '../middleware/security.js';
import { recordAudit } from '../middleware/audit.js';
import { getMetrics } from '../services/metrics.js';
import { runPurge } from '../services/purge.js';
import { processQueue } from '../services/sync.js';

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

// ── Static shell (unauthenticated; data comes from the gated APIs) ──
admin.get('/', (_req, res) => res.sendFile(resolve(adminDir, 'index.html')));
admin.use(express.static(adminDir, { index: false }));
