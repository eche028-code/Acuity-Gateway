// Admin gate (spec #15/#17). Layers, in order: optional IP allow-list →
// password (constant-time compare) → signed httpOnly session cookie. Every
// access attempt (success or failure) is written to the audit log.
//
// The admin dashboard is first-party (not framed), so a cookie is appropriate
// here — unlike the cross-iframe portal, which uses Bearer tokens.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { issueAdminToken, verifyAdminToken } from '../lib/token.js';
import { recordAudit } from './audit.js';

const COOKIE = 'ag_admin';

export function parseCookies(req) {
  const header = req.get('cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setAdminCookie(res) {
  const maxAge = Math.floor(config.admin.sessionTtlMs / 1000);
  const attrs = [`${COOKIE}=${issueAdminToken()}`, 'Path=/admin', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (config.isProd) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearAdminCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; Max-Age=0`);
}

export function ipAllowed(req) {
  const allow = config.admin.ipAllowlist;
  return allow.length === 0 || allow.includes(req.ip);
}

export function checkPassword(provided) {
  const expected = config.admin.password || '';
  if (!expected) return false; // refuse if no admin password configured
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function requireAdmin(req, res, next) {
  if (!ipAllowed(req)) {
    recordAudit({ event_type: 'admin_access', actor: 'admin', ip: req.ip, success: false, detail: { reason: 'ip_not_allowed' } });
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!verifyAdminToken(parseCookies(req)[COOKIE])) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
