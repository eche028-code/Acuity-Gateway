// Lightweight signed session tokens for the booking portal.
//
// Why tokens and not cookies: the portal runs inside a cross-origin iframe on
// the clinic's site. Third-party cookies are widely blocked, so a cookie-based
// session is unreliable there (spec §7). Instead the portal fetches a short-
// lived signed token and sends it as `Authorization: Bearer <token>`.
//
// The token carries no PII — it only proves "this is a live portal session",
// which lets us rate-limit and gate the sensitive endpoints (patient search,
// booking) without ever putting patient data in a URL or cookie.
import crypto from 'node:crypto';
import { config } from '../config.js';

// If no SESSION_SECRET is configured, generate one per boot. That is fine for
// a single-instance Gateway: tokens simply become invalid across restarts.
const SECRET = config.session.secret || crypto.randomBytes(32).toString('hex');

function sign(payloadB64) {
  return crypto.createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
}

export function issueToken() {
  const payload = { iat: Date.now(), exp: Date.now() + config.session.ttlMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payloadB64, sig] = token.split('.');
  const expected = sign(payloadB64);
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}
