// Inbound reply poller — the safety net beside the webhook.
//
// Cellcast v1 has no message id on polled replies and doesn't mark them read, so
// getResponses returns the full recent list every call. We dedup two ways:
//   • a deterministic synthetic provider_id (cc:<received_at>:<number>) → re-polls
//     of the same item are skipped (provider_id idempotency in recordInboundSms);
//   • a content+time check → a reply the WEBHOOK already stored isn't re-processed.
// Either path runs the same pipeline (correlate/intent/STOP-suppress/log/forward),
// so webhook and poll converge without double-acting. Processes oldest→newest so
// the backlog threads in order.
import { config } from '../config.js';
import { getResponses, normalizeAuNumber } from '../sms/cellcast.js';
import { smsEnabled } from './settings.js';
import { recordInboundSms, forwardInboundToAcuity, inboundAlreadySeen } from './sms.js';
import { recordAudit } from '../middleware/audit.js';
import { logger } from '../lib/logger.js';

let polling = false;

export async function pollInboundReplies(trigger = 'scheduled') {
  if (polling) return { skipped: 'in_progress' };
  if (!smsEnabled() || !config.cellcast.inboundPollMs) return { skipped: 'disabled' };
  polling = true;
  let processed = 0, skipped = 0, failed = 0;
  try {
    const res = await getResponses(1);
    if (!res.ok) {
      logger.warn({ error: res.error, status: res.status }, 'inbound poll: getResponses failed');
      return { error: res.error || 'getResponses failed' };
    }
    // getResponses returns newest-first; process oldest-first for sane thread order.
    const items = [...res.items].reverse();
    for (const it of items) {
      const from = it.from;
      const body = it.body ?? null;
      const receivedAt = it.received_at || new Date().toISOString();
      // Skip if the webhook (or an earlier poll) already captured this reply.
      if (inboundAlreadySeen(from, body, receivedAt)) { skipped++; continue; }
      const providerId = `cc:${receivedAt}:${normalizeAuNumber(from) || from}`;
      try {
        const r = recordInboundSms({ direction: 'inbound', recipient: from, status: 'received', providerId, body, receivedAt });
        if (r?.duplicate) { skipped++; continue; }
        await forwardInboundToAcuity({ from, body, providerId, intent: r.intent, bookingId: r.bookingId, receivedAt });
        processed++;
      } catch (err) {
        failed++;
        logger.warn({ from, err: err.message }, 'inbound poll: failed to process item');
      }
    }
    if (processed > 0 || failed > 0) {
      recordAudit({ event_type: 'sms', actor: 'system', success: failed === 0, detail: { kind: 'inbound_poll', trigger, fetched: res.items.length, processed, skipped, failed } });
      logger.info({ trigger, fetched: res.items.length, processed, skipped, failed }, 'inbound poll run');
    }
    return { fetched: res.items.length, processed, skipped, failed };
  } finally {
    polling = false;
  }
}
