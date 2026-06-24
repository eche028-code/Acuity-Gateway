// The admin can hide appointment types from the public booking page. Hidden ids
// are stored in settings; the portal's "visible types" view filters them out
// while the admin still sees the full list. Default = nothing hidden.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const dbFile = join(tmpdir(), `gw-types-test-${process.pid}-${Date.now()}.sqlite`);
process.env.NODE_ENV = 'test';
process.env.DB_PATH = dbFile;

const { db, setState } = await import('../src/db/index.js');
const { getAppointmentTypes, getVisibleAppointmentTypes } = await import('../src/services/availability.js');
const { hiddenAppointmentTypeIds, setAppointmentTypeHidden } = await import('../src/services/settings.js');

const HIDDEN_KEY = 'cfg:hidden_appointment_type_ids';
const clearHidden = () => db.prepare(`DELETE FROM system_state WHERE key = ?`).run(HIDDEN_KEY);

const TYPES = [
  { id: '1', name: 'Initial Eye Exam', duration: 30 },
  { id: '2', name: 'Follow-up', duration: 15 },
  { id: '3', name: 'Telehealth', duration: 20 },
];

before(() => {
  setState('appointment_types', JSON.stringify(TYPES));
  clearHidden();
});

after(() => {
  try { db.close(); } catch { /* */ }
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(dbFile + ext); } catch { /* */ } }
});

test('default: nothing hidden, all types visible', () => {
  assert.deepEqual(hiddenAppointmentTypeIds(), []);
  assert.equal(getVisibleAppointmentTypes().length, 3);
});

test('hiding a type drops it from the portal view but not the admin list', () => {
  setAppointmentTypeHidden('2', true);
  assert.deepEqual(hiddenAppointmentTypeIds(), ['2']);
  assert.deepEqual(getVisibleAppointmentTypes().map((t) => t.id), ['1', '3']);
  assert.equal(getAppointmentTypes().length, 3, 'admin still sees every type');
});

test('un-hiding restores it; toggling is idempotent', () => {
  clearHidden();
  setAppointmentTypeHidden('3', true);
  setAppointmentTypeHidden('3', true); // double-hide is a no-op
  assert.deepEqual(hiddenAppointmentTypeIds(), ['3']);
  setAppointmentTypeHidden('3', false);
  assert.deepEqual(hiddenAppointmentTypeIds(), []);
  assert.equal(getVisibleAppointmentTypes().length, 3);
});

test('filter is robust to number/string id mismatch between Acuity and the stored set', () => {
  // Acuity may report ids as numbers; the hidden set stores strings.
  setState('appointment_types', JSON.stringify([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]));
  clearHidden();
  setAppointmentTypeHidden(1, true); // numeric id in, string id stored
  assert.deepEqual(hiddenAppointmentTypeIds(), ['1']);
  assert.deepEqual(getVisibleAppointmentTypes().map((t) => t.id), [2]);
});
