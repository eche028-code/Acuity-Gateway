// Acuity's per-type Description is carried through to the portal so it can be
// shown as a hover/tap explainer. slimAppointmentType is the mapping applied to
// each Acuity type before it's cached; a missing/blank description becomes null.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const dbFile = join(tmpdir(), `gw-desc-test-${process.pid}-${Date.now()}.sqlite`);
process.env.NODE_ENV = 'test';
process.env.DB_PATH = dbFile;

const { db, setState } = await import('../src/db/index.js');
const { slimAppointmentType, getVisibleAppointmentTypes } = await import('../src/services/availability.js');

after(() => {
  try { db.close(); } catch { /* */ }
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(dbFile + ext); } catch { /* */ } }
});

test('slimAppointmentType carries a non-empty description (trimmed)', () => {
  const t = slimAppointmentType({ id: '1', name: 'Exam', durationMinutes: 30, description: '  See us first.  ' });
  assert.deepEqual(t, { id: '1', name: 'Exam', duration: 30, description: 'See us first.' });
});

test('slimAppointmentType nulls a missing, blank, or non-string description', () => {
  assert.equal(slimAppointmentType({ id: '1', name: 'A', durationMinutes: 30 }).description, null);
  assert.equal(slimAppointmentType({ id: '2', name: 'B', durationMinutes: 30, description: '   ' }).description, null);
  assert.equal(slimAppointmentType({ id: '3', name: 'C', durationMinutes: 30, description: 42 }).description, null);
});

test('slimAppointmentType prefers durationMinutes, falls back to duration, else null', () => {
  assert.equal(slimAppointmentType({ id: '1', name: 'A', durationMinutes: 30, duration: 99 }).duration, 30);
  assert.equal(slimAppointmentType({ id: '2', name: 'B', duration: 15 }).duration, 15);
  assert.equal(slimAppointmentType({ id: '3', name: 'C' }).duration, null);
});

test('the portal read path preserves the description from cache', () => {
  setState('appointment_types', JSON.stringify([
    { id: '1', name: 'Initial Eye Exam', duration: 30, description: 'Comprehensive first visit.' },
    { id: '2', name: 'Follow-up', duration: 15, description: null },
  ]));
  const types = getVisibleAppointmentTypes();
  assert.equal(types.find((t) => t.id === '1').description, 'Comprehensive first visit.');
  assert.equal(types.find((t) => t.id === '2').description, null);
});
