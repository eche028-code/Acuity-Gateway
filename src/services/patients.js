// Existing-patient lookup (spec #8/#10). Patients search by phone (or name);
// Gateway queries Acuity's `GET /clients?search=` and returns ONLY the minimal
// fields needed to auto-fill the form. We do NOT cache patient PII on the edge —
// pure passthrough, which keeps the breach blast radius small (spec §7).
import { acuity, AcuityError } from '../acuity/client.js';
import { setAcuityStatus } from './status.js';

export async function searchPatients({ phone, name }) {
  const search = (phone || name || '').toString().trim();
  const digits = search.replace(/\D/g, '');
  // Require a reasonably specific query so this can't enumerate the client list.
  if (digits.length < 6 && search.length < 3) {
    return { reachable: true, matches: [] };
  }

  try {
    const resp = await acuity.searchClients({ search });
    setAcuityStatus(true);
    const matches = ((resp && resp.matches) || []).map((c) => ({
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      phone: c.phone || '',
      email: c.email || '',
    }));
    return { reachable: true, matches };
  } catch (err) {
    if (err instanceof AcuityError && err.unreachable) {
      setAcuityStatus(false);
      return { reachable: false, matches: [] };
    }
    throw err;
  }
}
