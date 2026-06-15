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
// Currently open SMS conversation: { number, suppressed } or null. Kept across
// the 15s auto-refresh so an open thread isn't blown away under the staff.
let currentThread = null;

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
    card('SMS to action', m.smsActionsOpen, m.smsActionsOpen > 0 ? 'warn' : null, m.smsInbound24h ? `${m.smsInbound24h} in 24h` : ''),
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

// ── SMS messaging ───────────────────────────────────────────────────
const fullName = (a, b) => `${a || ''} ${b || ''}`.trim();
const intentBadge = (intent) => {
  const tone = intent === 'stop' ? 'err' : intent === 'cancel' ? 'warn' : intent === 'confirm' ? 'ok' : 'neutral';
  return el('span', `badge badge--${tone}`, intent || 'unknown');
};

function renderActions(actions) {
  $('#sms-actions-count').textContent = actions.length;
  $('#sms-actions-count').className = 'pill' + (actions.length ? ' is-alert' : '');
  const box = $('#sms-actions');
  if (actions.length === 0) {
    box.replaceChildren(el('div', 'empty', 'No replies waiting. (Inbound messages land here for staff.)'));
    return;
  }
  const list = el('div', 'sms__items');
  for (const a of actions) {
    const item = el('button', 'sms__item');
    item.type = 'button';
    const top = el('div', 'sms__item-top');
    top.append(el('span', 'mono', a.recipient || '—'), intentBadge(a.intent));
    item.append(top);
    item.append(el('div', 'sms__item-body', a.body || '(no text)'));
    const who = a.first_name || a.last_name ? `${fullName(a.first_name, a.last_name)} · ` : '';
    item.append(el('div', 'sms__item-sub', `${who}${ago(a.created_at)}`));
    const actRow = el('div', 'sms__item-actions');
    const open = el('button', 'btn btn--sm', 'Open');
    open.type = 'button';
    open.addEventListener('click', (e) => { e.stopPropagation(); openThread(a.recipient); });
    const done = el('button', 'btn btn--sm btn--ghost', 'Mark handled');
    done.type = 'button';
    done.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await api(`/sms/actions/${a.id}/handle`, { method: 'POST' }); loadAll(); } catch { /* */ }
    });
    actRow.append(open, done);
    item.append(actRow);
    item.addEventListener('click', () => openThread(a.recipient));
    list.append(item);
  }
  box.replaceChildren(list);
}

function renderThreads(threads) {
  const box = $('#sms-threads');
  if (threads.length === 0) {
    box.replaceChildren(el('div', 'empty', 'No conversations yet.'));
    return;
  }
  const list = el('div', 'sms__items');
  for (const t of threads) {
    const item = el('button', 'sms__item' + (currentThread && currentThread.number === t.recipient ? ' is-active' : ''));
    item.type = 'button';
    const top = el('div', 'sms__item-top');
    top.append(el('span', 'mono', t.recipient || '—'));
    if (t.open_actions > 0) top.append(el('span', 'pill is-alert', String(t.open_actions)));
    if (t.suppressed) top.append(el('span', 'badge badge--err', 'opted out'));
    item.append(top);
    const preview = (t.last_direction === 'inbound' ? '↩ ' : '→ ') + (t.last_body || '');
    item.append(el('div', 'sms__item-body', preview));
    item.append(el('div', 'sms__item-sub', ago(t.last_at)));
    item.addEventListener('click', () => openThread(t.recipient));
    list.append(item);
  }
  box.replaceChildren(list);
}

async function openThread(number) {
  try {
    const data = await api(`/sms/thread?number=${encodeURIComponent(number)}`);
    // suppression state comes from the threads list; default false if not found.
    const threads = await api('/sms/threads');
    const meta = threads.threads.find((t) => t.recipient === number);
    currentThread = { number, suppressed: !!(meta && meta.suppressed) };
    $('#sms-thread-title').textContent = number;
    const box = $('#sms-thread');
    if (data.messages.length === 0) {
      box.replaceChildren(el('div', 'empty', 'No messages.'));
    } else {
      const wrap = el('div', 'sms__bubbles');
      for (const msg of data.messages) {
        const b = el('div', `bubble bubble--${msg.direction === 'inbound' ? 'in' : 'out'}`);
        b.append(el('div', 'bubble__text', msg.body || '(no text)'));
        const meta2 = el('div', 'bubble__meta');
        meta2.textContent = `${fmt(msg.created_at)}${msg.status ? ` · ${msg.status}` : ''}`;
        b.append(meta2);
        wrap.append(b);
      }
      box.replaceChildren(wrap);
      box.scrollTop = box.scrollHeight;
    }
    // Compose + suppress controls
    $('#sms-send').hidden = false;
    const sup = $('#sms-suppress-btn');
    sup.hidden = false;
    sup.textContent = currentThread.suppressed ? 'Remove opt-out' : 'Opt out';
    $('#sms-send-msg').textContent = currentThread.suppressed ? 'Opted out — messages are blocked until you remove it.' : '';
    renderThreads(threads.threads); // refresh active highlight
  } catch (err) {
    if (err.status === 401 || err.status === 403) showLogin();
  }
}

// ── Data load ───────────────────────────────────────────────────────
async function loadAll() {
  try {
    const [m, recon, queue, audit, threads, actions] = await Promise.all([
      api('/metrics'),
      api('/reconciliation'),
      api('/queue'),
      api('/audit?limit=100'),
      api('/sms/threads'),
      api('/sms/actions'),
    ]);
    renderMetrics(m);
    renderReconciliation(recon.flags);
    renderQueue(queue.queue);
    renderAudit(audit.audit);
    renderActions(actions.actions);
    renderThreads(threads.threads);
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

// ── SMS compose + opt-out ───────────────────────────────────────────
$('#sms-send').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentThread) return;
  const msg = $('#sms-send-msg');
  const text = $('#sms-text').value.trim();
  if (!text) return;
  msg.textContent = 'Sending…';
  try {
    await api('/sms/send', { method: 'POST', body: { to: currentThread.number, message: text } });
    $('#sms-text').value = '';
    msg.textContent = 'Sent.';
    await openThread(currentThread.number);
  } catch (err) {
    msg.textContent = err.status === 409
      ? 'Blocked — this number has opted out (or SMS is disabled).'
      : err.status === 400 ? 'Message rejected (empty or too long).'
      : 'Send failed.';
  }
});

$('#sms-suppress-btn').addEventListener('click', async () => {
  if (!currentThread) return;
  const path = currentThread.suppressed ? '/sms/unsuppress' : '/sms/suppress';
  try {
    await api(path, { method: 'POST', body: { number: currentThread.number } });
    await openThread(currentThread.number);
    loadAll();
  } catch { /* */ }
});

// Decide initial view by probing a gated endpoint.
api('/metrics').then(showDash).catch(showLogin);
