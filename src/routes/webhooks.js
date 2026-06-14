// Acuity → Gateway webhook receiver (spec #5).
//
// Acuity POSTs application/x-www-form-urlencoded (action, id, calendarID,
// appointmentTypeID) and signs it with `x-acuity-signature`: base64 HMAC-SHA256
// of the RAW body using the API key as the shared secret. We must verify over
// the exact raw bytes — re-serialising the parsed body would change them and
// break the signature — so this route parses the raw body itself.
import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { handleAcuityWebhook } from '../services/sync.js';
import { recordInboundSms } from '../services/sms.js';
import { recordAudit } from '../middleware/audit.js';

export const webhooks = express.Router();

// Secret Acuity signs with is the API key (an explicit override wins).
const signingSecret = config.acuity.webhookSecret || config.acuity.apiKey;

function validSignature(rawBody, header) {
  // No secret configured: accept in dev (nothing to verify against), but fail
  // CLOSED in production so a blank ACUITY_WEBHOOK_SECRET/API key can't turn
  // this into an unauthenticated side-effecting endpoint.
  if (!signingSecret) return !config.isProd;
  if (!header) return false;
  const expected = crypto.createHmac('sha256', signingSecret).update(rawBody).digest('base64');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

webhooks.post('/acuity', express.raw({ type: '*/*', limit: '16kb' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

  if (!validSignature(raw, req.get('x-acuity-signature'))) {
    recordAudit({ event_type: 'webhook', actor: 'acuity', success: false, detail: { reason: 'bad_signature' } });
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const params = new URLSearchParams(raw);
  const payload = {
    action: params.get('action'),
    id: params.get('id'),
    appointmentTypeID: params.get('appointmentTypeID'),
    calendarID: params.get('calendarID'),
  };

  // Acknowledge fast; process asynchronously (Acuity expects a quick 200).
  res.status(200).json({ received: true });
  handleAcuityWebhook(payload).catch(() => {});
});

// ── Cellcast → Gateway: inbound replies (MO) + delivery receipts (DLR) ─
// Cellcast posts JSON; webhooks are optionally protected with HTTP Basic Auth
// configured in the Cellcast dashboard (there is no HMAC scheme).
function validCellcastAuth(req) {
  if (!config.cellcast.webhookUser) return true; // not configured → accept
  const provided = req.get('authorization') || '';
  const expected =
    'Basic ' + Buffer.from(`${config.cellcast.webhookUser}:${config.cellcast.webhookPass}`).toString('base64');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

webhooks.post('/cellcast', express.json({ limit: '16kb' }), (req, res) => {
  if (!validCellcastAuth(req)) {
    recordAudit({ event_type: 'webhook', actor: 'cellcast', success: false, detail: { reason: 'bad_auth' } });
    return res.status(401).json({ error: 'unauthorized' });
  }
  const p = req.body || {};
  // 'receive' = inbound reply (MO); 'send' = delivery receipt (DLR).
  const direction = p.type === 'receive' ? 'inbound' : 'dlr';
  recordInboundSms({
    direction,
    recipient: p.sender || p.receiver || null,
    status: p.status || (p.type === 'receive' ? 'received' : null),
    providerId: p._id || null,
  });
  recordAudit({ event_type: 'sms', actor: 'cellcast', success: p.status !== 'failed', detail: { type: p.type, status: p.status, id: p._id } });
  res.status(200).json({ received: true });
});
