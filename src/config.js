// Central configuration loader.
// Everything clinic-specific comes from .env (spec #24); nothing is hardcoded.
// In production we fail fast on missing required vars; in development we are
// lenient (so you can boot against the mock Acuity with an empty .env).
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env from the project root regardless of the process working directory,
// so a systemd service (whose cwd may differ) still picks up the config.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

function optional(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

// Required in production, optional (empty default) in development.
function need(name) {
  return isProd ? required(name) : optional(name, '');
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${name} must be a number, got "${v}".`);
  }
  return n;
}

function list(name, fallback = []) {
  const v = process.env[name];
  if (!v) return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

export const config = {
  env,
  isProd,
  port: int('PORT', 3000),
  publicBaseUrl: optional('PUBLIC_BASE_URL', `http://localhost:${int('PORT', 3000)}`),

  acuity: {
    // Bearer key for the local Acuity Gateway API (Acuity → System Admin → Gateway).
    apiKey: need('ACUITY_API_KEY'),
    // Host root of the Acuity API; the client appends /api/gateway/v1.
    apiBase: optional('ACUITY_API_BASE', 'https://localhost:3002'),
    // Skip TLS verification — only for a self-signed cert (localhost / raw Tailscale IP).
    tlsInsecure: bool('ACUITY_TLS_INSECURE', false),
  },

  clinic: {
    // Origins permitted to embed the portal (CORS + CSP frame-ancestors).
    origins: list('CLINIC_ORIGIN'),
    name: optional('CLINIC_NAME', 'Clinic'),
  },

  admin: {
    password: need('ADMIN_PASSWORD'),
    ipAllowlist: list('ADMIN_IP_ALLOWLIST'),
    sessionTtlMs: int('ADMIN_SESSION_TTL_MS', 8 * 60 * 60 * 1000),
  },

  cellcast: {
    apiKey: optional('CELLCAST_API_KEY', ''),
    // Default to the current-generation v1 base (Bearer auth, POST /api/v1/gateway).
    apiBase: optional('CELLCAST_API_BASE', 'https://api.cellcast.com'),
    senderId: optional('CELLCAST_SENDER_ID', ''),
    // Optional HTTP Basic Auth on the inbound webhook (set in the Cellcast dashboard).
    webhookUser: optional('CELLCAST_WEBHOOK_USER', ''),
    webhookPass: optional('CELLCAST_WEBHOOK_PASS', ''),
    // Send a confirmation SMS on booking when a key is configured.
    get enabled() {
      return !!this.apiKey;
    },
  },

  // Day-before SMS reminders (outbound). Only fire when Cellcast is enabled.
  reminders: {
    enabled: bool('SMS_REMINDER_ENABLED', true),
    // Daily reminder job runs once per day at/after this local hour (0-23).
    hour: int('SMS_REMINDER_HOUR', 10),
  },

  // Short-lived portal session tokens (token-based, not cookies — spec §7).
  session: {
    secret: optional('SESSION_SECRET', ''), // empty => random per-boot secret
    ttlMs: int('SESSION_TTL_MS', 30 * 60 * 1000),
  },

  dbPath: optional('DB_PATH', './data/gateway.sqlite'),

  availability: {
    windowDays: int('AVAILABILITY_WINDOW_DAYS', 60),
    refreshMs: int('AVAILABILITY_REFRESH_MS', 60 * 1000),
  },

  retention: {
    backstopDays: int('PII_BACKSTOP_DAYS', 7),
    // Nightly purge runs once per day at/after this local hour (0-23).
    purgeHour: int('PURGE_HOUR', 3),
    // SMS log rows older than this are trimmed by the purge job.
    smsRetentionDays: int('SMS_RETENTION_DAYS', 30),
  },
};

// In production CLINIC_ORIGIN must be set — it drives both CORS and the iframe
// framing allow-list. Without it we'd otherwise fall back to permissive framing
// (clickjacking risk), so fail fast at startup instead.
if (config.isProd && config.clinic.origins.length === 0) {
  throw new Error('CLINIC_ORIGIN is required in production (drives CORS + iframe framing).');
}
