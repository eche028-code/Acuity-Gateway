// Acuity Gateway — Express entry point.
//
// Boot order: migrate DB → wire security/middleware → mount webhook receiver
// (before the JSON parser, so it can read the raw body) → mount API → serve the
// static portal → start listening → kick off the initial sync and the periodic
// refresh / health-check jobs.
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { migrate } from './db/index.js';
import {
  helmetMiddleware,
  corsMiddleware,
  globalRateLimit,
} from './middleware/security.js';
import { portal } from './routes/portal.js';
import { admin } from './routes/admin.js';
import { webhooks } from './routes/webhooks.js';
import { refreshAvailability } from './services/availability.js';
import { checkHealth, pollChanges } from './services/sync.js';
import { runPurgeIfDue } from './services/purge.js';
import { runRemindersIfDue } from './services/reminders.js';

migrate();

const app = express();
const here = dirname(fileURLToPath(import.meta.url));

// Behind Nginx / the Lightsail edge in production. Use a SPECIFIC hop count,
// never blanket `true` (a spoofed X-Forwarded-For could otherwise evade the
// per-IP rate limiter). No proxy in local dev.
app.set('trust proxy', config.isProd ? 1 : false);
app.disable('x-powered-by');

app.use(pinoHttp({ logger }));
app.use(helmetMiddleware());
app.use(corsMiddleware());
app.use(globalRateLimit());

// Webhook receiver mounted here with its own JSON parser (it accepts only small
// Cellcast callbacks); kept separate from the main API body parser below.
app.use('/webhooks', webhooks);

app.use(express.json({ limit: '100kb' }));

// Booking API.
app.use('/api', portal);

// Admin dashboard (password-gated inside the router).
app.use('/admin', admin);

// Static booking portal (the iframe target).
app.use(express.static(resolve(here, '../public')));

// Container/infra health probe.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Central error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(config.port, async () => {
  logger.info(
    { port: config.port, env: config.env, acuityBase: config.acuity.apiBase },
    'Acuity Gateway listening',
  );

  // Initial sync — non-fatal if Acuity is down (we serve the cache).
  try {
    await refreshAvailability();
  } catch (err) {
    logger.warn({ err: err.message }, 'initial availability refresh failed');
  }
  // Seed the changes cursor (empty `since` → "watch from now").
  try {
    await pollChanges();
  } catch (err) {
    logger.warn({ err: err.message }, 'initial changes poll failed');
  }

  if (config.isProd && config.cellcast.enabled && !config.cellcast.webhookUser) {
    logger.warn('Cellcast SMS enabled but inbound webhook is unauthenticated — set CELLCAST_WEBHOOK_USER/PASS');
  }

  // Periodic jobs.
  setInterval(() => {
    refreshAvailability().catch((err) => logger.warn({ err: err.message }, 'refresh job failed'));
  }, config.availability.refreshMs);

  setInterval(() => {
    checkHealth().catch((err) => logger.warn({ err: err.message }, 'health job failed'));
  }, 30_000);

  // Poll Acuity for front-desk changes (it doesn't push webhooks to us).
  setInterval(() => {
    pollChanges().catch((err) => logger.warn({ err: err.message }, 'changes poll failed'));
  }, 20_000);

  // Nightly retention purge (runs at most once/day at/after PURGE_HOUR). Check
  // shortly after boot too, in case the box was down when it was due.
  setTimeout(() => runPurgeIfDue(), 60_000);
  setInterval(() => {
    try {
      runPurgeIfDue();
    } catch (err) {
      logger.warn({ err: err.message }, 'purge job failed');
    }
  }, 60 * 60 * 1000);

  // Day-before SMS reminders (at most once/day at/after SMS_REMINDER_HOUR).
  setTimeout(() => runRemindersIfDue(), 90_000);
  setInterval(() => {
    try {
      runRemindersIfDue();
    } catch (err) {
      logger.warn({ err: err.message }, 'reminders job failed');
    }
  }, 60 * 60 * 1000);
});

// Graceful shutdown.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logger.info({ sig }, 'shutting down');
    server.close(() => process.exit(0));
  });
}
