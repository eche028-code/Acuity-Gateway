// Cellcast SMS client (spec #14).
//
// Targets the current-generation v1 API: POST {base}/api/v1/gateway with
// `Authorization: Bearer <key>` and a JSON body { message, contacts[], sender }.
// (Contracts verified in docs/INTEGRATION_NOTES.md.) If no API key is configured
// the client no-ops gracefully so booking still works without SMS.
import { config } from '../config.js';

// AU mobiles → E.164 (+61…). Accepts 0412…, 61412…, +61412…, bare digits.
export function normalizeAuNumber(raw) {
  const cleaned = String(raw || '').replace(/[^\d+]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('+61')) return cleaned;
  if (cleaned.startsWith('61')) return `+${cleaned}`;
  if (cleaned.startsWith('0')) return `+61${cleaned.slice(1)}`;
  if (cleaned.startsWith('+')) return cleaned;
  return `+61${cleaned}`;
}

export async function sendSms({ to, message }) {
  if (!config.cellcast.enabled) return { ok: false, skipped: true, reason: 'sms_disabled' };
  const number = normalizeAuNumber(to);
  if (!number) return { ok: false, skipped: true, reason: 'no_number' };

  const url = `${config.cellcast.apiBase}/api/v1/gateway`;
  const body = { message, contacts: [number] };
  if (config.cellcast.senderId) body.sender = config.cellcast.senderId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.cellcast.apiKey}`,
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
