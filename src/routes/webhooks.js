// Inbound webhook receiver.
//
// NOTE: Acuity → Gateway no longer uses webhooks — the Gateway is reached over
// Tailscale and polls Acuity's `GET /changes` instead (see services/sync.js).
// This router now only handles Cellcast (inbound SMS replies + delivery receipts).
import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { recordInboundSms } from '../services/sms.js';
import { recordAudit } from '../middleware/audit.js';

export const webhooks = express.Router();

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
