// Cellcast SMS client (spec #14).
//
// Targets the current-generation v1 API: POST {base}/api/v1/gateway with
// `Authorization: Bearer <key>` and a JSON body { message, contacts[], sender }.
// (Contracts verified in docs/INTEGRATION_NOTES.md.) If no API key is configured
// the client no-ops gracefully so booking still works without SMS.
import { smsEnabled, cellcastApiKey, cellcastSenderId, cellcastApiBase } from '../services/settings.js';
import { normalizeAuNumber } from './format.js';

// Re-exported for back-compat: callers import normalizeAuNumber from here or from
// ./format.js (the pure module). New pure consumers should import ./format.js.
export { normalizeAuNumber };

export async function sendSms({ to, message }) {
  if (!smsEnabled()) return { ok: false, skipped: true, reason: 'sms_disabled' };
  const number = normalizeAuNumber(to);
  if (!number) return { ok: false, skipped: true, reason: 'no_number' };

  const url = `${cellcastApiBase()}/api/v1/gateway`;
  const body = { message, contacts: [number] };
  const sender = cellcastSenderId();
  if (sender) body.sender = sender;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cellcastApiKey()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    // v1 signals failure via HTTP status or a top-level status:false.
    if (!res.ok || (data && data.status === false)) {
      return { ok: false, status: res.status, error: (data && data.msg) || (data && data.message) || `HTTP ${res.status}`, number };
    }
    const providerId = data?.data?.queueResponse?.[0]?.MessageId || null;
    return { ok: true, providerId, number };
  } catch (err) {
    return { ok: false, error: err.message, unreachable: true, number };
  } finally {
    clearTimeout(timer);
  }
}
