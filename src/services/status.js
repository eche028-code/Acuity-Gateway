// Tracks whether Acuity is currently reachable. Persisted in system_state so
// the admin dashboard and the portal can show the current mode, and so the
// reconnect logic can detect the offline→online transition.
import { getState, setState } from '../db/index.js';

export function setAcuityStatus(online) {
  setState('acuity_status', online ? 'online' : 'offline');
  setState(online ? 'last_acuity_online' : 'last_acuity_offline', new Date().toISOString());
}

export function getAcuityStatus() {
  return getState('acuity_status') || 'unknown';
}
