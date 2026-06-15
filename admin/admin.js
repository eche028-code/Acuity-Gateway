// Admin dashboard logic — vanilla JS, CSP-safe (no inline handlers).
'use strict';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
let timer = null;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/admin/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function fmt(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}
function ago(ts) {
  if (!ts) return '—';
  const mins = Math.round((Date.now() - Date.parse(ts)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// ── Views ───────────────────────────────────────────────────────────
function showLogin() {
  if (timer) { clearInterval(timer); timer = null; }
  $('#dash-view').hidden = true;
  $('#login-view').hidden = false;
  $('#password').focus();
}
function showDash() {
  $('#login-view').hidden = true;
  $('#dash-view').hidden = false;
  loadAll();
  if (!timer) timer = setInterval(loadAll, 15000);
}

// ── Rendering ───────────────────────────────────────────────────────
function card(label, value, tone, sub) {
  const c = el('div', 'card' + (tone ? ` is-${tone}` : ''));
  c.append(el('div', 'card__label', label));
  const v = el('div', 'card__value');
  v.append(document.createTextNode(String(value)));
  if (sub) { const s = el('small'); s.textContent = ` ${sub}`; v.append(s); }
  c.append(v);
  return c;
}

function renderMetrics(m) {
  const box = $('#metrics');
  box.replaceChildren(
    card('Acuity', m.acuity, m.acuity === 'online' ? 'ok' : 'err'),
    card('Queue depth', m.queueDepth, m.queueDepth > 0 ? 'warn' : null, m.queueDepth ? `oldest ${m.oldestQueuedAgeMins}m` : ''),
    card('Failed syncs', m.failedSyncs, m.failedSyncs > 0 ? 'err' : 'ok'),
    card('Open reconciliations', m.openReconciliations, m.openReconciliations > 0 ? 'err' : 'ok'),
    card('SMS failures', m.smsFailures, m.smsFailures > 0 ? 'warn' : null),
    card('Errors (24h)', m.errorsLast24h, m.errorsLast24h > 0 ? 'warn' : null),
    card('Open slots', m.openSlots, null),
    card('Synced bookings', m.totalSynced, null),
  );
  $('#updated').textContent = `Acuity last online ${ago(m.lastAcuityOnline)} · refresh ${ago(m.lastAvailabilityRefresh)} · purge ${ago(m.lastPurge)}`;
}

function renderReconciliation(flags) {
  const open = flags.filter((f) => f.status === 'open');
  const countPill = $('#recon-count');
  countPill.textContent = open.length;
  countPill.className = 'pill' + (open.length ? ' is-alert' : '');
  const box = $('#reconciliation');
  if (flags.length === 0) {
    box.replaceChildren(el('div', 'empty', 'No reconciliation flags. (Expected — they only fire on the rare last-second collision.)'));
    return;
  }
  const table = el('table');
  const head = el('tr');
  for (const h of ['When', 'Kind', 'Slot', 'Detail', 'Status', '']) head.append(el('th', null, h));
  table.append(head);
  for (const f of flags) {
    const tr = el('tr');
    tr.append(el('td', null, fmt(f.created_at)));
    tr.append(el('td', null, f.kind));
    tr.append(el('td', 'mono', f.slot_datetime || '—'));
    tr.append(el('td', null, f.detail || '—'));
    const st = el('td');
    st.append(el('span', `badge badge--${f.status === 'open' ? 'err' : 'ok'}`, f.status));
    tr.append(st);
    const act = el('td');
    if (f.status === 'open') {
      const b = el('button', 'btn btn--sm', 'Resolve');
      b.type = 'button';
      b.addEventListener('click', () => resolveFlag(f.id));
      act.append(b);
    }
    tr.append(act);
    table.append(tr);
  }
  box.replaceChildren(table);
}

function renderQueue(queue) {
  $('#queue-count').textContent = queue.length;
  const box = $('#queue');
  if (queue.length === 0) {
    box.replaceChildren(el('div', 'empty', 'Queue is empty — all bookings are synced to Acuity.'));
    return;
  }
  const table = el('table');
  const head = el('tr');
  for (const h of ['Created', 'Appointment', 'Patient', 'Attempts', 'Last error']) head.append(el('th', null, h));
  table.append(head);
  for (const b of queue) {
    const tr = el('tr');
    tr.append(el('td', null, ago(b.created_at)));
    tr.append(el('td', 'mono', b.appointment_datetime));
    tr.append(el('td', null, `${b.first_name || ''} ${b.last_name || ''}`.trim() || '—'));
    tr.append(el('td', null, String(b.sync_attempts)));
    tr.append(el('td', null, b.sync_error || '—'));
    table.append(tr);
  }
  box.replaceChildren(table);
}

function renderAudit(rows) {
  const box = $('#audit');
  if (rows.length === 0) { box.replaceChildren(el('div', 'empty', 'No activity yet.')); return; }
  const table = el('table');
  const head = el('tr');
  for (const h of ['When', 'Event', 'Actor', 'IP', 'OK', 'Detail']) head.append(el('th', null, h));
  table.append(head);
  for (const r of rows.slice(0, 60)) {
    const tr = el('tr');
    tr.append(el('td', null, fmt(r.ts)));
    tr.append(el('td', null, r.event_type));
    tr.append(el('td', null, r.actor || '—'));
    tr.append(el('td', 'mono', r.ip || '—'));
    const ok = el('td');
    ok.append(el('span', `badge badge--${r.success ? 'ok' : 'err'}`, r.success ? 'ok' : 'fail'));
    tr.append(ok);
    tr.append(el('td', 'mono', r.detail || '—'));
    table.append(tr);
  }
  box.replaceChildren(table);
}

// ── Data load ───────────────────────────────────────────────────────
async function loadAll() {
  try {
    const [m, recon, queue, audit] = await Promise.all([
      api('/metrics'),
      api('/reconciliation'),
      api('/queue'),
      api('/audit?limit=100'),
    ]);
    renderMetrics(m);
    renderReconciliation(recon.flags);
    renderQueue(queue.queue);
    renderAudit(audit.audit);
  } catch (err) {
    if (err.status === 401 || err.status === 403) showLogin();
  }
}

async function resolveFlag(id) {
  try { await api(`/reconciliation/${id}/resolve`, { method: 'POST' }); loadAll(); } catch { /* ignore */ }
}

// ── Boot ────────────────────────────────────────────────────────────
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').hidden = true;
  try {
    await api('/login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    showDash();
  } catch (err) {
    const box = $('#login-error');
    box.textContent = err.status === 403 ? 'This IP is not allowed.' : 'Incorrect password.';
    box.hidden = false;
  }
});
$('#logout-btn').addEventListener('click', async () => { try { await api('/logout', { method: 'POST' }); } catch { /* */ } showLogin(); });
$('#sync-btn').addEventListener('click', async () => { try { await api('/sync', { method: 'POST' }); loadAll(); } catch { /* */ } });
$('#purge-btn').addEventListener('click', async () => {
  if (!confirm('Run the retention purge now? This removes synced, past-appointment PII per policy.')) return;
  try { await api('/purge', { method: 'POST' }); loadAll(); } catch { /* */ }
});

// ── Change password ─────────────────────────────────────────────────
$('#pw-btn').addEventListener('click', () => {
  const p = $('#pw-panel');
  p.hidden = !p.hidden;
  if (!p.hidden) $('#pw-current').focus();
});
$('#pw-cancel').addEventListener('click', () => {
  $('#pw-form').reset();
  $('#pw-msg').hidden = true;
  $('#pw-panel').hidden = true;
});
$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#pw-msg');
  const show = (text, ok) => { msg.textContent = text; msg.className = ok ? 'ok-text' : 'error'; msg.hidden = false; };
  const nw = $('#pw-new').value;
  if (nw.length < 8) return show('New password must be at least 8 characters.', false);
  if (nw !== $('#pw-confirm').value) return show('New passwords do not match.', false);
  try {
    await api('/password', { method: 'POST', body: { currentPassword: $('#pw-current').value, newPassword: nw } });
    $('#pw-form').reset();
    show('Password updated — use it the next time you sign in.', true);
  } catch (err) {
    show(err.status === 401 ? 'Current password is incorrect.'
      : err.status === 400 ? 'New password is too weak (min 8 characters).'
      : 'Could not update password.', false);
  }
});

// Decide initial view by probing a gated endpoint.
api('/metrics').then(showDash).catch(showLogin);
