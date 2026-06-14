// Signed, expiring tokens — used for two things:
//   • portal sessions (no role) gating the public booking endpoints, and
//   • admin sessions (role: 'admin') gating /admin.
//
// Why tokens and not cookies for the portal: it runs inside a cross-origin
// iframe where third-party cookies are widely blocked, so a Bearer token held
// in the iframe's memory is the reliable pattern (spec §7). The admin dashboard
// is first-party (not framed), so its token rides in an httpOnly cookie.
//
// Tokens carry no PII — just issue/expiry (and a role for admin).
import crypto from 'node:crypto';
import { config } from '../config.js';

// If no SESSION_SECRET is set, generate one per boot. For a single-instance
// Gateway that's fine: tokens simply become invalid across restarts.
const SECRET = config.session.secret || crypto.randomBytes(32).toString('hex');

function sign(payloadB64) {
  return crypto.createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
}

function signPayload(obj) {
  const payloadB64 = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

function readPayload(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Portal session tokens ───────────────────────────────────────────
export function issueToken() {
  return signPayload({ iat: Date.now(), exp: Date.now() + config.session.ttlMs });
}

export function verifyToken(token) {
  const payload = readPayload(token);
  return !!payload && !payload.role; // a plain portal session, not an admin token
}

// ── Admin session tokens ────────────────────────────────────────────
export function issueAdminToken() {
  return signPayload({ role: 'admin', iat: Date.now(), exp: Date.now() + config.admin.sessionTtlMs });
}

export function verifyAdminToken(token) {
  const payload = readPayload(token);
  return !!payload && payload.role === 'admin';
}
