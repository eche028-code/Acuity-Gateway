// Internal server-to-server API for the clinic's Acuity instance (Acuity →
// Gateway). The Gateway owns the Cellcast integration, so Acuity never holds the
// Cellcast key — it calls here and the Gateway relays the SMS (reusing the same
// suppression-checked dispatchSms chokepoint as confirmations/reminders).
//
// SECURITY: sending SMS costs money and can be abused, so this is privileged.
//   • Protected by a shared Bearer key (GATEWAY_INBOUND_API_KEY), constant-time
//     compared. DISABLED (503) when the key is unset — never an open relay.
//   • In production this path should ALSO be reachable only over the Tailscale
//     interface (nginx allow/deny or a firewall rule), not the public domain.
import express from 'express';
import crypto from 'node:crypto';
import { dispatchSms } from '../services/sms.js';
import { normalizeAuNumber } from '../sms/cellcast.js';
import { inboundApiKey, smsEnabled, cellcastSenderId } from '../services/settings.js';
import { recordAudit } from '../middleware/audit.js';

export const internal = express.Router();

function authorized(req) {
  const key = inboundApiKey();
  if (!key) return false;
  const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(provided);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Gate every internal route: 503 if the feature isn't configured, 401 if the
// caller's Bearer key is missing/wrong.
internal.use(express.json({ limit: '16kb' }), (req, res, next) => {
  if (!inboundApiKey()) {
    return res.status(503).json({ error: 'not_configured', message: 'No inbound API key is set on the Gateway (set it in /admin or GATEWAY_INBOUND_API_KEY).' });
  }
  if (!authorized(req)) {
    recordAudit({ event_type: 'sms', actor: 'acuity', ip: req.ip, success: false, detail: { route: req.path, reason: 'bad_auth' } });
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// Connectivity + auth probe (lets the Acuity side confirm reachability and key
// before wiring the send button).
internal.get('/ping', (_req, res) => {
  res.json({ ok: true, smsEnabled: smsEnabled(), sender: cellcastSenderId() });
});

// Send an SMS to a patient on Acuity's behalf.
// Body: { to: "<AU mobile>", message: "<text>", bookingId?: "<id>" }
internal.post('/sms/send', async (req, res, next) => {
  try {
    const { to, message, bookingId } = req.body || {};
    const number = normalizeAuNumber(to);
    const text = String(message || '').trim();
    if (!number) return res.status(400).json({ error: 'bad_number', message: 'Provide a valid AU mobile in `to`.' });
    if (!text) return res.status(400).json({ error: 'empty_message' });
    if (text.length > 1000) return res.status(400).json({ error: 'too_long', message: 'Keep messages under 1000 characters.' });

    const result = await dispatchSms({ to: number, message: text, kind: 'acuity', bookingId: bookingId || null });
    recordAudit({ event_type: 'sms', actor: 'acuity', ip: req.ip, success: !!result.ok, detail: { kind: 'acuity', to: number, reason: result.reason || null, error: result.error || null } });

    if (result.ok) return res.json({ ok: true, providerId: result.providerId, to: number });
    if (result.reason === 'suppressed') return res.status(409).json({ error: 'suppressed', message: 'This number has opted out of SMS.' });
    if (result.reason === 'sms_disabled') return res.status(503).json({ error: 'sms_disabled', message: 'SMS is not configured on the Gateway (no Cellcast key).' });
    return res.status(502).json({ error: 'send_failed', message: result.error || 'Cellcast send failed.' });
  } catch (err) {
    next(err);
  }
});
