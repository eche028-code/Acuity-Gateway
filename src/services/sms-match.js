// Correlate an inbound number to a booking (pure matching — no DB import, so it
// is unit-testable in isolation; the DB query that feeds it lives in sms.js).
//
// Rule (handoff §4): prefer the NEAREST UPCOMING un-cancelled appointment for
// that number; if none are upcoming, fall back to the most recently CREATED
// booking for that number; if the number matches nothing, return null (the reply
// is still logged and surfaced to staff uncorrelated).
import { normalizeAuNumber } from '../sms/cellcast.js';

/**
 * @param candidates rows of { id, phone, appointment_datetime, created_at }
 * @param number     the inbound sender, already E.164-normalized
 * @param nowIso     reference "now" (injected for deterministic tests)
 */
export function pickBooking(candidates, number, nowIso) {
  if (!number) return null;
  const now = Date.parse(nowIso);
  const matches = (candidates || []).filter((b) => normalizeAuNumber(b.phone) === number);
  if (matches.length === 0) return null;

  const upcoming = matches
    .filter((b) => Date.parse(b.appointment_datetime) >= now)
    .sort((a, b) => Date.parse(a.appointment_datetime) - Date.parse(b.appointment_datetime));
  if (upcoming.length) return upcoming[0];

  // Everything is in the past → the most recently created booking is the best
  // guess at what the patient is replying about.
  return [...matches].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}
