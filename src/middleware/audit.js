// Audit trail helper (spec #17/#22). Every security-relevant or sync event is
// written here; the admin dashboard reads this table.
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';

const insert = db.prepare(
  `INSERT INTO audit_log (ts, event_type, actor, ip, success, detail)
   VALUES (@ts, @event_type, @actor, @ip, @success, @detail)`,
);

export function recordAudit({ event_type, actor = 'system', ip = null, success = true, detail = null }) {
  try {
    insert.run({
      ts: new Date().toISOString(),
      event_type,
      actor,
      ip,
      success: success ? 1 : 0,
      detail: detail == null ? null : JSON.stringify(detail),
    });
  } catch (err) {
    // Never let auditing failures break the request path.
    logger.error({ err }, 'failed to write audit log');
  }
}
