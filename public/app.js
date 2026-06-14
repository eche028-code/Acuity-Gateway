// Booking portal — vanilla JS, no build step. Talks to the Gateway API on the
// same origin. The session token lives only in memory (not localStorage), and
// patient details are sent in POST bodies, never in the URL.
'use strict';

const state = {
  token: null,
  types: [],
  typeId: null,
  typeName: '',
  date: null,
  datetime: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ── API ─────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// ── Formatting ──────────────────────────────────────────────────────
function fmtDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ── Navigation ──────────────────────────────────────────────────────
function showStep(name) {
  for (const s of ['service', 'slot', 'identity', 'result']) {
    $(`#step-${s}`).hidden = s !== name;
  }
}
function showError(msg) {
  const bar = $('#error-bar');
  bar.textContent = msg;
  bar.hidden = !msg;
}

// ── Step 1: services ────────────────────────────────────────────────
async function loadServices() {
  const { appointmentTypes } = await api('/appointment-types');
  state.types = appointmentTypes || [];
  const list = $('#service-list');
  list.replaceChildren();
  if (state.types.length === 0) {
    list.append(el('p', 'muted', 'No services are available right now. Please try again shortly.'));
    return;
  }
  for (const t of state.types) {
    const btn = el('button', 'option');
    btn.type = 'button';
    btn.setAttribute('role', 'listitem');
    btn.append(el('span', 'option__name', t.name));
    if (t.duration) btn.append(el('span', 'option__meta', ` · ${t.duration} min`));
    btn.addEventListener('click', () => selectService(t));
    list.append(btn);
  }
}

async function selectService(t) {
  state.typeId = t.id;
  state.typeName = t.name;
  state.date = null;
  state.datetime = null;
  $('#slot-subtitle').textContent = t.name;
  $('#time-list').replaceChildren(el('p', 'muted', 'Select a date first.'));
  showStep('slot');
  await loadDates();
}

// ── Step 2: dates & times ───────────────────────────────────────────
async function loadDates() {
  const list = $('#date-list');
  list.replaceChildren(el('p', 'muted', 'Loading dates…'));
  try {
    const { dates } = await api(`/availability/dates?appointmentTypeId=${state.typeId}`);
    list.replaceChildren();
    if (!dates || dates.length === 0) {
      list.append(el('p', 'muted', 'No open dates in the booking window.'));
      return;
    }
    for (const d of dates) {
      const btn = el('button', 'option', fmtDate(d));
      btn.type = 'button';
      btn.addEventListener('click', () => selectDate(d, btn));
      list.append(btn);
    }
  } catch (err) {
    list.replaceChildren(el('p', 'muted', 'Could not load dates.'));
    showError(err.message);
  }
}

async function selectDate(date, btn) {
  state.date = date;
  state.datetime = null;
  for (const b of $('#date-list').children) b.classList.remove('is-active');
  btn.classList.add('is-active');
  const list = $('#time-list');
  list.replaceChildren(el('p', 'muted', 'Loading times…'));
  try {
    const { times } = await api(`/availability/times?appointmentTypeId=${state.typeId}&date=${date}`);
    list.replaceChildren();
    if (!times || times.length === 0) {
      list.append(el('p', 'muted', 'No open times on this day.'));
      return;
    }
    for (const t of times) {
      const tb = el('button', 'option', fmtTime(t.time));
      tb.type = 'button';
      tb.addEventListener('click', () => selectTime(t.time));
      list.append(tb);
    }
  } catch (err) {
    list.replaceChildren(el('p', 'muted', 'Could not load times.'));
    showError(err.message);
  }
}

function selectTime(datetime) {
  state.datetime = datetime;
  showError('');
  showStep('identity');
}

// ── Step 3: identity & details ──────────────────────────────────────
function switchTab(which) {
  const isNew = which === 'new';
  $('#tab-existing').classList.toggle('is-active', !isNew);
  $('#tab-new').classList.toggle('is-active', isNew);
  $('#pane-existing').hidden = isNew;
  $('#pane-new').hidden = !isNew;
  $('#new-patient-fields').hidden = !isNew;
  $('#details-form').dataset.new = isNew ? '1' : '';
}

async function searchPatients() {
  const q = $('#search-input').value.trim();
  if (!q) return;
  const results = $('#search-results');
  results.replaceChildren(el('p', 'muted', 'Searching…'));
  try {
    const looksPhone = /\d{3,}/.test(q);
    const { reachable, matches } = await api('/patients/search', {
      method: 'POST',
      body: looksPhone ? { phone: q } : { name: q },
    });
    results.replaceChildren();
    if (!reachable) {
      results.append(el('p', 'muted', 'Patient lookup is offline right now — please enter your details below.'));
      return;
    }
    if (!matches || matches.length === 0) {
      results.append(el('p', 'muted', 'No match found. Enter your details below or try the New patient tab.'));
      return;
    }
    for (const m of matches) {
      const item = el('button', 'result-item', `${m.firstName} ${m.lastName} · ${m.phone || m.email}`);
      item.type = 'button';
      item.addEventListener('click', () => fillForm(m));
      results.append(item);
    }
  } catch (err) {
    results.replaceChildren(el('p', 'muted', 'Search failed.'));
    showError(err.message);
  }
}

function fillForm(m) {
  const f = $('#details-form');
  f.firstName.value = m.firstName || '';
  f.lastName.value = m.lastName || '';
  f.email.value = m.email || '';
  f.phone.value = m.phone || '';
}

async function submitBooking(ev) {
  ev.preventDefault();
  showError('');
  const f = $('#details-form');
  if (!state.datetime) {
    showError('Please pick a time first.');
    return;
  }
  if (!f.firstName.value || !f.lastName.value || !f.email.value) {
    showError('First name, last name and email are required.');
    return;
  }
  const btn = $('#submit-btn');
  btn.disabled = true;
  btn.textContent = 'Booking…';
  try {
    const result = await api('/bookings', {
      method: 'POST',
      body: {
        appointmentTypeId: state.typeId,
        datetime: state.datetime,
        firstName: f.firstName.value.trim(),
        lastName: f.lastName.value.trim(),
        email: f.email.value.trim(),
        phone: f.phone.value.trim(),
        address: f.address.value.trim(),
        city: f.city.value.trim(),
        state: f.state.value.trim(),
        postcode: f.postcode.value.trim(),
        notes: f.notes.value.trim(),
        isNewPatient: f.dataset.new === '1',
      },
    });
    renderResult(result);
  } catch (err) {
    if (err.status === 409) {
      showError('That time was just taken. Please choose another.');
      showStep('slot');
      await loadDates();
    } else {
      showError(err.data && err.data.fields ? `Please complete: ${err.data.fields.join(', ')}` : err.message);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Review & confirm';
  }
}

function renderResult(result) {
  const card = $('#result-card');
  const when = `${fmtDate(state.date)} at ${fmtTime(state.datetime)}`;
  card.replaceChildren();
  if (result.state === 'confirmed') {
    card.className = 'result-card result-card--ok';
    card.append(el('h3', null, '✓ Appointment confirmed'));
    card.append(el('p', null, `${state.typeName} — ${when}.`));
    card.append(el('p', null, 'A confirmation will be sent to your email.'));
  } else {
    card.className = 'result-card result-card--queued';
    card.append(el('h3', null, '✓ Appointment received'));
    card.append(el('p', null, `${state.typeName} — ${when}.`));
    card.append(el('p', null, 'Your booking is held and will be finalised shortly. We will be in touch to confirm.'));
  }
  showStep('result');
}

function restart() {
  state.typeId = null;
  state.date = null;
  state.datetime = null;
  $('#details-form').reset();
  $('#search-results').replaceChildren();
  $('#search-input').value = '';
  showError('');
  showStep('service');
}

// ── Boot ────────────────────────────────────────────────────────────
async function init() {
  // Wire static controls.
  $('#tab-existing').addEventListener('click', () => switchTab('existing'));
  $('#tab-new').addEventListener('click', () => switchTab('new'));
  $('#search-btn').addEventListener('click', searchPatients);
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchPatients(); }
  });
  $('#details-form').addEventListener('submit', submitBooking);
  $('#restart-btn').addEventListener('click', restart);
  for (const b of document.querySelectorAll('[data-back]')) {
    b.addEventListener('click', () => showStep(b.dataset.back));
  }

  try {
    const { token } = await api('/session', { method: 'POST' });
    state.token = token;
  } catch {
    /* session is best-effort; reads still work */
  }

  try {
    const status = await api('/status');
    if (status.acuity === 'offline') {
      const banner = $('#mode-banner');
      banner.textContent = 'We are taking bookings now and will confirm your appointment shortly.';
      banner.hidden = false;
    }
  } catch {
    /* non-fatal */
  }

  try {
    await loadServices();
  } catch (err) {
    showError(`Could not load services: ${err.message}`);
  }
}

init();
