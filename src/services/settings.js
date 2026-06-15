// Runtime-configurable integration settings.
//
// Stored in the DB (system_state, `cfg:` prefix) and OVERRIDE the .env defaults,
// so an admin can set the Cellcast key/sender and the Acuity inbound key from
// /admin without editing files or restarting — changes take effect on the next
// request. A blank value clears the DB override and falls back to .env.
//
// NOTE: these secrets then live in the sqlite DB (which already holds PII) — keep
// the DB file protected. The .env values remain the fallback / bootstrap.
import { db, getState, setState } from '../db/index.js';
import { config } from '../config.js';

const KEY = {
  cellcastApiKey: 'cfg:cellcast_api_key',
  cellcastSenderId: 'cfg:cellcast_sender_id',
  inboundApiKey: 'cfg:gateway_inbound_api_key',
};

const delState = db.prepare('DELETE FROM system_state WHERE key = ?');

function dbVal(k) {
  const v = getState(k);
  return v === null || v === '' ? null : v;
}
function setOrClear(k, v) {
  const val = v === null || v === undefined ? '' : String(v).trim();
  if (val === '') delState.run(k);
  else setState(k, val);
}

// ── Resolved values (DB override, else .env) ────────────────────────
export function cellcastApiKey() { return dbVal(KEY.cellcastApiKey) ?? (config.cellcast.apiKey || null); }
export function cellcastSenderId() { return dbVal(KEY.cellcastSenderId) ?? (config.cellcast.senderId || null); }
export function cellcastApiBase() { return config.cellcast.apiBase; } // base stays .env-driven
export function smsEnabled() { return !!cellcastApiKey(); }
export function inboundApiKey() { return dbVal(KEY.inboundApiKey) ?? (config.gateway.inboundApiKey || null); }

// ── Setters (admin) ─────────────────────────────────────────────────
export function setCellcastApiKey(v) { setOrClear(KEY.cellcastApiKey, v); }
export function setCellcastSenderId(v) { setOrClear(KEY.cellcastSenderId, v); }
export function setInboundApiKey(v) { setOrClear(KEY.inboundApiKey, v); }

// ── Masked status for the admin UI (never returns full secrets) ─────
function source(dbKey, envVal) {
  if (dbVal(dbKey)) return 'db';
  if (envVal) return 'env';
  return 'none';
}
const last4 = (s) => (s ? String(s).slice(-4) : null);

export function settingsStatus() {
  const ck = cellcastApiKey();
  const ik = inboundApiKey();
  return {
    cellcast: {
      configured: !!ck,
      source: source(KEY.cellcastApiKey, config.cellcast.apiKey),
      last4: last4(ck),
      sender: cellcastSenderId(),
      senderSource: source(KEY.cellcastSenderId, config.cellcast.senderId),
      apiBase: cellcastApiBase(),
      smsEnabled: smsEnabled(),
    },
    inbound: {
      configured: !!ik,
      source: source(KEY.inboundApiKey, config.gateway.inboundApiKey),
      last4: last4(ik),
    },
  };
}
