// Booking portal — vanilla JS, no build step. Talks to the Gateway API on the
// same origin. The session token lives only in memory (not localStorage), and
// patient details are sent in POST bodies, never in the URL.
//
// Flow: 1 practitioner → 2 time (calendar) → 3 appointment type → 4 details.
// Availability is identical across the clinic's appointment types (one shared
// 30-min diary), so the calendar is driven by a representative type and the
// actual type is chosen afterwards; the booking re-verifies the slot live.
'use strict';

const state = {
  token: null,
  practitioners: [],
  practitionerId: '',
  practitionerName: '',
  types: [],
  defaultTypeId: null, // representative type for the availability grid
  typeId: null, typeName: '', duration: null,
  cal: null, // { year, month } (month is 0-based)
  daySet: new Map(), // date -> { morning, afternoon, evening }
  date: null, datetime: null,
  patientMode: null, // 'existing' | 'new'
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
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// ── Formatting — always render in the clinic's timezone (AWST), never the
// viewer's, so a patient on a differently-set device sees the real clinic time.
const TZ = 'Australia/Perth';
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function fmtDateLong(dateStr) {
  return new Date(`${dateStr}T00:00:00+08:00`)
    .toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
}

// ── Navigation ──────────────────────────────────────────────────────
const STEPS = ['practitioner', 'time', 'type', 'details', 'result'];
function showStep(name) {
  for (const s of STEPS) $(`#step-${s}`).hidden = s !== name;
}
function showError(msg) {
  const bar = $('#error-bar');
  bar.textContent = msg || '';
  bar.hidden = !msg;
}

// ── Step 1: practitioner ────────────────────────────────────────────
async function loadPractitioners() {
  let practitioners = [];
  try { ({ practitioners } = await api('/practitioners')); } catch { /* optional */ }
  state.practitioners = practitioners || [];
  const sel = $('#practitioner-select');
  sel.replaceChildren();
  // "Any" only when there's a genuine choice (2+ optometrists).
  if (state.practitioners.length > 1) {
    const any = el('option', null, 'Any optometrist'); any.value = ''; sel.append(any);
  }
  for (const p of state.practitioners) {
    const o = el('option', null, p.name); o.value = p.id; sel.append(o);
  }
  if (state.practitioners.length === 0) {
    const o = el('option', null, 'Any optometrist'); o.value = ''; sel.append(o);
  }
}

function onPractitionerNext() {
  const sel = $('#practitioner-select');
  state.practitionerId = sel.value;
  state.practitionerName = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : '';
  showStep('time');
  initCalendar();
}

// ── Step 2: calendar ────────────────────────────────────────────────
async function loadDays() {
  if (!state.defaultTypeId) { state.daySet = new Map(); return; }
  try {
    const { days } = await api(`/availability/calendar?appointmentTypeId=${state.defaultTypeId}&practitionerId=${encodeURIComponent(state.practitionerId)}`);
    state.daySet = new Map((days || []).map((d) => [d.date, d]));
  } catch { state.daySet = new Map(); }
}

async function initCalendar() {
  $('#time-panel').hidden = true;
  $('#time-list').replaceChildren();
  $('#cal-grid').replaceChildren(el('p', 'muted', 'Loading…'));
  await loadDays();
  // Start on the month of the earliest open day, else the current month.
  const first = [...state.daySet.keys()].sort()[0];
  const base = first ? new Date(`${first}T00:00:00+08:00`) : new Date();
  state.cal = { year: base.getFullYear(), month: base.getMonth() };
  renderCalendar();
  if (state.daySet.size === 0) {
    $('#time-panel').hidden = false;
    $('#time-panel-date').textContent = '';
    $('#time-list').replaceChildren(el('p', 'muted', 'No availability is open right now. Please check back soon.'));
  }
}

function renderCalendar() {
  const { year, month } = state.cal;
  $('#cal-month').textContent = `${MONTHS[month]} ${year}`;
  const grid = $('#cal-grid');
  grid.replaceChildren();
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let i = 0; i < firstDow; i++) grid.append(el('span', 'cal__cell cal__cell--empty'));
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const cell = el('button', 'cal__cell');
    cell.type = 'button';
    cell.append(el('span', 'cal__day', String(day)));
    const sum = state.daySet.get(date);
    if (sum) {
      const g = el('span', 'cal__glyphs');
      if (sum.morning) g.append(el('span', 'cal__g', '☀️'));
      if (sum.afternoon) g.append(el('span', 'cal__g', '🌇'));
      if (sum.evening) g.append(el('span', 'cal__g', '🌙'));
      cell.append(g);
      cell.classList.add('cal__cell--open');
      if (date === state.date) cell.classList.add('is-active');
      cell.addEventListener('click', () => selectDay(date, cell));
    } else {
      cell.classList.add('cal__cell--closed');
      cell.disabled = true;
    }
    grid.append(cell);
  }
}

function changeMonth(delta) {
  let m = state.cal.month + delta;
  let y = state.cal.year;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  state.cal = { year: y, month: m };
  renderCalendar();
}

async function selectDay(date, cell) {
  state.date = date;
  state.datetime = null;
  for (const c of $('#cal-grid').children) c.classList.remove('is-active');
  cell.classList.add('is-active');
  const panel = $('#time-panel');
  panel.hidden = false;
  $('#time-panel-date').textContent = fmtDateLong(date);
  const list = $('#time-list');
  list.replaceChildren(el('p', 'muted', 'Loading times…'));
  try {
    const { times } = await api(`/availability/times?appointmentTypeId=${state.defaultTypeId}&date=${date}&practitionerId=${encodeURIComponent(state.practitionerId)}`);
    list.replaceChildren();
    if (!times || times.length === 0) { list.append(el('p', 'muted', 'No open times on this day.')); return; }
    for (const t of times) {
      const tb = el('button', 'option option--time', fmtTime(t.time));
      tb.type = 'button';
      tb.addEventListener('click', () => selectTime(t.time, tb));
      list.append(tb);
    }
  } catch (err) {
    list.replaceChildren(el('p', 'muted', 'Could not load times.'));
    showError(err.message);
  }
}

function selectTime(datetime, btn) {
  state.datetime = datetime;
  for (const b of $('#time-list').children) if (b.classList) b.classList.remove('is-active');
  btn.classList.add('is-active');
  showError('');
  renderTypes();
  showStep('type');
}

// ── Step 3: appointment type ────────────────────────────────────────
function renderTypes() {
  $('#type-subtitle').textContent = `${fmtDateLong(state.date)} at ${fmtTime(state.datetime)}`;
  const list = $('#type-list');
  list.replaceChildren();
  for (const t of state.types) {
    const btn = el('button', 'option');
    btn.type = 'button';
    const head = el('span', 'option__head');
    head.append(el('span', 'option__name', t.name));
    if (t.description) {
      // Acuity's explainer for this type. Shown on hover (desktop) and on tap of
      // the ⓘ (mobile) — the icon's click toggles it without selecting the type.
      const info = el('span', 'option__info', 'i');
      info.setAttribute('aria-label', 'About this appointment type');
      info.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = btn.classList.contains('is-info-open');
        closeAllTypeInfo();
        if (!wasOpen) btn.classList.add('is-info-open');
      });
      head.append(info);
    }
    btn.append(head);
    if (t.duration) btn.append(el('span', 'option__meta', `${t.duration} min appointment`));
    if (t.description) btn.append(el('span', 'option__desc', t.description));
    if (t.id === state.typeId) btn.classList.add('is-active');
    btn.addEventListener('click', () => selectType(t));
    list.append(btn);
  }
}

function closeAllTypeInfo() {
  for (const o of document.querySelectorAll('.option.is-info-open')) o.classList.remove('is-info-open');
}

function selectType(t) {
  state.typeId = t.id;
  state.typeName = t.name;
  state.duration = t.duration;
  resetDetails();
  showStep('details');
}

// ── Step 4: details ─────────────────────────────────────────────────
function resetDetails() {
  $('#details-form').reset();
  $('#search-input').value = '';
  $('#search-results').replaceChildren();
  $('#new-patient-fields').hidden = true;
  $('#details-fields').disabled = true; // locked until search-pick or New patient
  $('#submit-btn').disabled = true;
  state.patientMode = null;
}

function enableDetails(mode) {
  state.patientMode = mode;
  $('#details-fields').disabled = false;
  $('#new-patient-fields').hidden = mode !== 'new';
  $('#submit-btn').disabled = false;
}

async function searchPatients() {
  const q = $('#search-input').value.trim();
  if (!q) { showError('Enter a mobile number or name to search.'); return; }
  showError('');
  const results = $('#search-results');
  results.replaceChildren(el('p', 'muted', 'Searching…'));
  try {
    const looksPhone = q.replace(/\D/g, '').length >= 6;
    const { reachable, matches } = await api('/patients/search', {
      method: 'POST',
      body: looksPhone ? { phone: q } : { name: q },
    });
    results.replaceChildren();
    if (!reachable) {
      results.append(el('p', 'muted', 'Patient lookup is offline right now — add yourself as a new patient.'));
      return;
    }
    if (!matches || matches.length === 0) {
      const note = el('p', 'muted', 'No match found. ');
      const link = el('button', 'link-inline', 'Add as a new patient →');
      link.type = 'button';
      link.addEventListener('click', startNewPatient);
      note.append(link);
      results.append(note);
      return;
    }
    for (const m of matches) {
      const contact = m.phone || m.email;
      const item = el('button', 'result-item', `${m.firstName} ${m.lastName}`.trim() + (contact ? ` · ${contact}` : ''));
      item.type = 'button';
      item.addEventListener('click', () => pickExisting(m));
      results.append(item);
    }
  } catch (err) {
    results.replaceChildren(el('p', 'muted', 'Search failed.'));
    showError(err.message);
  }
}

function pickExisting(m) {
  const f = $('#details-form');
  f.firstName.value = m.firstName || '';
  f.lastName.value = m.lastName || '';
  f.phone.value = m.phone || '';
  f.email.value = m.email || '';
  enableDetails('existing');
  $('#search-results').replaceChildren(
    el('p', 'muted', `Using the record for ${m.firstName} ${m.lastName}. Check the details below, then confirm.`),
  );
}

function startNewPatient() {
  resetDetails();
  enableDetails('new');
  $('#details-form').firstName.focus();
}

async function submitBooking(ev) {
  ev.preventDefault();
  showError('');
  if (!state.datetime || !state.typeId) { showError('Please pick a time and appointment type first.'); return; }
  const f = $('#details-form');
  if (!f.firstName.value.trim() || !f.lastName.value.trim()) {
    showError('First name and last name are required.');
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
        // The chosen optometrist ('' = any → Acuity assigns).
        calendarId: state.practitionerId,
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
        isNewPatient: state.patientMode === 'new',
      },
    });
    renderResult(result);
  } catch (err) {
    if (err.status === 409) {
      showError('That time was just taken. Please choose another.');
      showStep('time');
      await initCalendar();
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
  const when = `${fmtDateLong(state.date)} at ${fmtTime(state.datetime)}`;
  const who = state.practitionerName && state.practitioners.length > 1 ? ` with ${state.practitionerName}` : '';
  card.replaceChildren();
  if (result.state === 'confirmed') {
    card.className = 'result-card result-card--ok';
    card.append(el('h3', null, '✓ Appointment confirmed'));
    card.append(el('p', null, `${state.typeName}${who} — ${when}.`));
    card.append(el('p', null, 'A confirmation will be sent to you.'));
  } else {
    card.className = 'result-card result-card--queued';
    card.append(el('h3', null, '✓ Appointment received'));
    card.append(el('p', null, `${state.typeName}${who} — ${when}.`));
    card.append(el('p', null, 'Your booking is held and will be finalised shortly. We will be in touch to confirm.'));
  }
  showStep('result');
}

function restart() {
  state.typeId = null;
  state.date = null;
  state.datetime = null;
  state.patientMode = null;
  resetDetails();
  showError('');
  showStep('practitioner');
}

// ── Boot ────────────────────────────────────────────────────────────
async function init() {
  $('#practitioner-next').addEventListener('click', onPractitionerNext);
  $('#cal-prev').addEventListener('click', () => changeMonth(-1));
  $('#cal-next').addEventListener('click', () => changeMonth(1));
  $('#search-btn').addEventListener('click', searchPatients);
  $('#new-patient-btn').addEventListener('click', startNewPatient);
  $('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchPatients(); } });
  $('#details-form').addEventListener('submit', submitBooking);
  $('#restart-btn').addEventListener('click', restart);
  for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => showStep(b.dataset.back));

  try { const { token } = await api('/session', { method: 'POST' }); state.token = token; } catch { /* best-effort */ }

  try {
    const status = await api('/status');
    if (status.acuity === 'offline') {
      const banner = $('#mode-banner');
      banner.textContent = 'We are taking bookings now and will confirm your appointment shortly.';
      banner.hidden = false;
    }
  } catch { /* non-fatal */ }

  try {
    await loadPractitioners();
    const { appointmentTypes } = await api('/appointment-types');
    state.types = appointmentTypes || [];
    state.defaultTypeId = state.types[0] ? state.types[0].id : null;
    if (!state.defaultTypeId) showError('No appointment types are available right now. Please try again shortly.');
  } catch (err) {
    showError(`Could not load booking options: ${err.message}`);
  }
}

// ── Auto-resize: report our height to the embedding page ────────────
// A cross-origin parent can't read the iframe's content height, so we
// post it on every layout change and the embed snippet's listener grows
// the iframe to match (no inner scrollbar). No-op when not embedded.
function reportHeight() {
  if (window.parent === window) return; // not in an iframe
  const height = Math.ceil(document.documentElement.scrollHeight);
  window.parent.postMessage({ type: 'acuity-portal-resize', height }, '*');
}

if (window.parent !== window && 'ResizeObserver' in window) {
  // Fires once on observe, then on any body size change (step switches,
  // calendar/time-panel toggles, error bar, font reflow).
  new ResizeObserver(reportHeight).observe(document.body);
  window.addEventListener('load', reportHeight); // backstop for late layout
}

init();
