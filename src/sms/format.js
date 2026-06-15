// Phone-number formatting — pure, dependency-free (no config/db imports) so it
// stays cheap to unit-test and safe to import from anywhere.

// AU mobiles → E.164 (+61…). Accepts 0412…, 61412…, +61412…, bare digits.
export function normalizeAuNumber(raw) {
  const cleaned = String(raw || '').replace(/[^\d+]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('+61')) return cleaned;
  if (cleaned.startsWith('61')) return `+${cleaned}`;
  if (cleaned.startsWith('0')) return `+61${cleaned.slice(1)}`;
  if (cleaned.startsWith('+')) return cleaned;
  return `+61${cleaned}`;
}
