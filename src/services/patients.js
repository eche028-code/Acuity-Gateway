// Existing-patient lookup (spec #8/#10). Patients search by phone (or name);
// Gateway queries Acuity's client table and returns ONLY the minimal fields
// needed to auto-fill the form. We do NOT cache patient PII on the edge — this
// is a pure passthrough, which keeps the breach blast radius small (spec §7).
import { acuity, AcuityError } from '../acuity/client.js';
import { setAcuityStatus } from './status.js';

export async function searchPatients({ phone, name }) {
  // Phone is preferred (Acuity has a phone index). Require a reasonably
  // specific query so this can't be used to enumerate the whole client list.
  const search = (phone || name || '').toString().trim();
  const digits = search.replace(/\D/g, '');
  if (digits.length < 6 && search.length < 3) {
    return { reachable: true, matches: [] };
  }

  try {
    const clients = await acuity.searchClients({ search });
    setAcuityStatus(true);
    const matches = (Array.isArray(clients) ? clients : []).map((c) => ({
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      phone: c.phone || '',
      email: c.email || '',
    }));
    return { reachable: true, matches };
  } catch (err) {
    if (err instanceof AcuityError && err.unreachable) {
      // During an outage we can't reach the client table — the patient simply
      // fills the form manually. Booking still proceeds into the local queue.
      setAcuityStatus(false);
      return { reachable: false, matches: [] };
    }
    throw err;
  }
}
