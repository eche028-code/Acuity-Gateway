// Admin gate (spec #15/#17). Layers, in order: optional IP allow-list →
// password (constant-time compare) → signed httpOnly session cookie. Every
// access attempt (success or failure) is written to the audit log.
//
// The admin dashboard is first-party (not framed), so a cookie is appropriate
// here — unlike the cross-iframe portal, which uses Bearer tokens.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getState, setState } from '../db/index.js';
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

// A password set from the dashboard is stored hashed (scrypt) in system_state
// and OVERRIDES the .env ADMIN_PASSWORD, which is only a first-login bootstrap.
const PW_KEY = 'admin_password_hash';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(pw), salt, 32);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}
function verifyHash(provided, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const derived = crypto.scryptSync(String(provided ?? ''), Buffer.from(saltHex, 'hex'), expected.length);
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

export function setAdminPassword(newPassword) {
  setState(PW_KEY, hashPassword(newPassword));
}

export function checkPassword(provided) {
  const stored = getState(PW_KEY);
  if (stored) return verifyHash(provided, stored);
  // Bootstrap: until a password is set from the dashboard, accept the .env one.
  const expected = config.admin.password || '';
  if (!expected) return false; // fail closed if neither is configured
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
