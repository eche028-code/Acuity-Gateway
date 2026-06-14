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
import { recordAudit } from '../middleware/audit.js';

export const webhooks = express.Router();

// Secret Acuity signs with is the API key (an explicit override wins).
const signingSecret = config.acuity.webhookSecret || config.acuity.apiKey;

function validSignature(rawBody, header) {
  if (!signingSecret) return true; // dev with no creds: nothing to verify against
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
