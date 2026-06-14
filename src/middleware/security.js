// Security perimeter (spec §7). Three concerns, all driven by CLINIC_ORIGIN:
//   • framing   — CSP frame-ancestors so ONLY the clinic site can iframe us
//                 (frame-ancestors is the modern replacement for X-Frame-Options,
//                 which can't scope to a third-party domain and is disabled here).
//   • CORS      — fetch/XHR to the API allowed only from the clinic origin.
//   • sessions  — short-lived Bearer tokens (not cookies — unreliable in a
//                 cross-site iframe) gate the sensitive endpoints.
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { verifyToken } from '../lib/token.js';

const origins = config.clinic.origins;

export function helmetMiddleware() {
  // In dev with no clinic origin set, allow framing from anywhere so you can
  // test embedding locally; in prod the configured origins are required.
  const frameAncestors = origins.length ? ["'self'", ...origins] : ["'self'", '*'];
  return helmet({
    // Override ONLY frame-ancestors; keep helmet's other vetted CSP defaults
    // (default-src 'self', object-src 'none', HSTS, nosniff, etc.).
    contentSecurityPolicy: {
      directives: { 'frame-ancestors': frameAncestors },
    },
    // Disable the legacy X-Frame-Options (helmet defaults it to SAMEORIGIN,
    // which would block the clinic's cross-origin iframe). frame-ancestors above
    // is the source of truth.
    xFrameOptions: false,
  });
}

export function corsMiddleware() {
  return cors({
    origin(origin, cb) {
      // Same-origin / curl / server-to-server requests have no Origin header.
      if (!origin) return cb(null, true);
      if (origins.length === 0) return cb(null, !config.isProd); // dev: allow all
      return cb(null, origins.includes(origin));
    },
    credentials: false, // Bearer tokens, not cookies
  });
}

export function globalRateLimit() {
  return rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
}

export function searchRateLimit() {
  // Patient lookup returns contact details — keep it tight to prevent enumeration.
  return rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
}

export function bookingRateLimit() {
  return rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: true, legacyHeaders: false });
}

// Gate for the sensitive endpoints: requires a valid, unexpired session token.
export function requireSession(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!verifyToken(token)) {
    return res.status(401).json({ error: 'session_required' });
  }
  next();
}
