// SQLite connection + migration.
//
// Uses Node's BUILT-IN `node:sqlite` (DatabaseSync) — file-based, synchronous,
// and with ZERO native dependencies, so the identical code installs and runs on
// Windows (dev) and Linux/Ubuntu (Lightsail prod) with no compiler/build step.
// (node:sqlite is marked experimental and prints one warning at startup; if you
// prefer better-sqlite3, pin Node 20 LTS so its prebuilt binaries are used.)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const here = dirname(fileURLToPath(import.meta.url));

// DB_PATH is relative by default so Windows and Linux behave identically.
const dbPath = resolve(process.cwd(), config.dbPath);
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

// WAL = better concurrency for a server workload; busy_timeout avoids
// "database is locked" under brief contention.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA foreign_keys = ON;');

// Allow binding named parameters (@name) from plain objects without the prefix,
// matching the prepared-statement style used across the services.
const _prepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const stmt = _prepare(sql);
  if (typeof stmt.setAllowBareNamedParameters === 'function') {
    stmt.setAllowBareNamedParameters(true);
  }
  return stmt;
};

// Apply the (idempotent) schema. This MUST run before any module-level prepared
// statement is compiled — node:sqlite (like better-sqlite3) validates SQL against
// the live schema at prepare time, so the tables have to exist first. Running it
// here, at connection open, guarantees that for every importer.
const schemaSql = readFileSync(resolve(here, 'schema.sql'), 'utf8');
db.exec(schemaSql);
ensureColumns();
ensureIndexes();
logger.info({ dbPath }, 'database ready');

// Add columns/indexes that were introduced after a database was first created.
// SQLite has no `ADD COLUMN IF NOT EXISTS`, and `CREATE TABLE IF NOT EXISTS`
// never alters an existing table — so new columns on existing tables are applied
// here, guarded by table_info so every run is idempotent. Fresh databases already
// have these columns from schema.sql, so this is a no-op for them.
function ensureColumns() {
  const columns = (table) =>
    new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  const add = (table, col, ddl) => {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    logger.info({ table, col }, 'schema migration: added column');
  };

  const sms = columns('sms_log');
  if (!sms.has('body')) add('sms_log', 'body', 'body TEXT');
  if (!sms.has('intent')) add('sms_log', 'intent', 'intent TEXT');
  if (!sms.has('action_status')) add('sms_log', 'action_status', 'action_status TEXT');
  if (!sms.has('handled_at')) add('sms_log', 'handled_at', 'handled_at TEXT');
  if (!sms.has('handled_by')) add('sms_log', 'handled_by', 'handled_by TEXT');

  const pending = columns('pending_bookings');
  if (!pending.has('reminder_sent_at')) add('pending_bookings', 'reminder_sent_at', 'reminder_sent_at TEXT');
}

// Indexes that reference columns added by ensureColumns(). Must run AFTER it, so
// the column is guaranteed to exist on upgraded databases. CREATE INDEX IF NOT
// EXISTS is idempotent.
function ensureIndexes() {
  db.exec('CREATE INDEX IF NOT EXISTS idx_sms_action ON sms_log (action_status)');
}

// Kept for init.js / setup.sh; idempotent (CREATE ... IF NOT EXISTS + guarded ALTERs).
export function migrate() {
  db.exec(schemaSql);
  ensureColumns();
  ensureIndexes();
}

// ── Small helpers for system_state (k/v) ────────────────────────────
const _getState = db.prepare('SELECT value FROM system_state WHERE key = ?');
const _setState = db.prepare(
  `INSERT INTO system_state (key, value, updated_at) VALUES (@key, @value, @updated_at)
   ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updated_at`,
);

export function getState(key) {
  const row = _getState.get(key);
  return row ? row.value : null;
}

export function setState(key, value) {
  _setState.run({ key, value: String(value), updated_at: new Date().toISOString() });
}

// Run synchronous DB mutations atomically. node:sqlite is synchronous and uses a
// single connection, so `fn` MUST contain no awaits — keep all network I/O
// outside. On any throw the whole batch rolls back, so readers never observe a
// partially-applied state.
export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
