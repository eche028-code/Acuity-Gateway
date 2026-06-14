// Central configuration loader.
// Everything clinic-specific comes from .env (spec #24); nothing is hardcoded.
// In production we fail fast on missing required vars; in development we are
// lenient (so you can boot against the mock Acuity with an empty .env).
import dotenv from 'dotenv';

dotenv.config();

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

export const config = {
  env,
  isProd,
  port: int('PORT', 3000),
  publicBaseUrl: optional('PUBLIC_BASE_URL', `http://localhost:${int('PORT', 3000)}`),

  acuity: {
    userId: need('ACUITY_USER_ID'),
    apiKey: need('ACUITY_API_KEY'),
    apiBase: optional('ACUITY_API_BASE', 'http://localhost:4000'),
    webhookSecret: optional('ACUITY_WEBHOOK_SECRET', ''),
  },

  clinic: {
    // Origins permitted to embed the portal (CORS + CSP frame-ancestors).
    origins: list('CLINIC_ORIGIN'),
    name: optional('CLINIC_NAME', 'Clinic'),
  },

  admin: {
    password: need('ADMIN_PASSWORD'),
    ipAllowlist: list('ADMIN_IP_ALLOWLIST'),
  },

  cellcast: {
    apiKey: optional('CELLCAST_API_KEY', ''),
    apiBase: optional('CELLCAST_API_BASE', 'https://cellcast.com.au/api/v3'),
    senderId: optional('CELLCAST_SENDER_ID', ''),
  },

  // Short-lived portal session tokens (token-based, not cookies — spec §7).
  session: {
    secret: optional('SESSION_SECRET', ''), // empty => random per-boot secret
    ttlMs: int('SESSION_TTL_MS', 30 * 60 * 1000),
  },

  dbPath: optional('DB_PATH', './data/gateway.sqlite'),

  availability: {
    windowDays: int('AVAILABILITY_WINDOW_DAYS', 60),
    refreshMs: int('AVAILABILITY_REFRESH_MS', 5 * 60 * 1000),
  },

  retention: {
    backstopDays: int('PII_BACKSTOP_DAYS', 7),
  },
};
