// Inbound SMS intent classification (pure — no I/O, unit-tested).
//
// Deliberately CONSERVATIVE: only a clear, near-exact keyword maps to an intent.
// Anything else is `unknown` and surfaced to staff (spec #7 — never auto-act on
// an ambiguous message). The Gateway never auto-cancels regardless of intent
// (there is no Acuity cancel endpoint yet); intent only labels the queue item.

// Compliance opt-out keywords (carrier-standard). A STOP also auto-suppresses.
const STOP = new Set(['stop', 'stopall', 'unsubscribe', 'optout', 'opt-out', 'quit', 'cancelsms', 'end']);
const CONFIRM = new Set(['yes', 'y', 'confirm', 'confirmed', 'ok', 'okay', 'yep', 'yeah', 'c', 'accept']);
const CANCEL = new Set(['no', 'n', 'cancel', 'cancelled', 'canceled', 'reschedule', 'rebook']);

// Normalize to a comparable token: lowercase, strip punctuation, collapse spaces.
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classify an inbound message body.
 * @returns {'stop'|'confirm'|'cancel'|'unknown'}
 */
export function parseIntent(text) {
  const norm = normalize(text);
  if (!norm) return 'unknown';
  const first = norm.split(' ')[0];

  // STOP wins over everything else (compliance), whether it's the whole message
  // or just the leading word (e.g. "stop texting me").
  if (STOP.has(first) || STOP.has(norm)) return 'stop';
  // "opt out" as two words.
  if (/^opt\s?out\b/.test(norm)) return 'stop';

  // Exact one-word replies are the only auto-classified confirm/cancel — a longer
  // free-text message ("yes but can we move it earlier?") stays unknown for staff.
  if (CONFIRM.has(norm)) return 'confirm';
  if (CANCEL.has(norm)) return 'cancel';

  return 'unknown';
}
