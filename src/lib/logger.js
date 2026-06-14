// Structured logging. JSON lines to stdout — on Lightsail these are captured
// by systemd/journald; locally they are readable enough as-is.
import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: process.env.LOG_LEVEL || (config.isProd ? 'info' : 'debug'),
  base: undefined, // drop pid/hostname noise
});
