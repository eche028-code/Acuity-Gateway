// Integration test for the inbound-routing core: points the gateway at a throwaway
// SQLite file (set BEFORE importing, so config/db pick it up), then exercises
// suppression, webhook idempotency, and number→booking correlation against a real DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const dbFile = join(tmpdir(), `gw-sms-test-${process.pid}-${Date.now()}.sqlite`);
process.env.NODE_ENV = 'test';
process.env.DB_PATH = dbFile;
process.env.CELLCAST_API_KEY = ''; // SMS disabled — no real network sends

// Dynamic import AFTER env is set (static imports would evaluate config/db first).
const sms = await import('../src/services/sms.js');
const { db } = await import('../src/db/index.js');

const insertBooking = db.prepare(`
  INSERT INTO pending_bookings (id, appointment_type_id, appointment_datetime, appointment_date,
                                phone, status, synced, created_at, updated_at)
  VALUES (@id, 'apt', @dt, @date, @phone, 'confirmed', 1, @now, @now)
`);

before(() => {
  db.exec('DELETE FROM sms_log');
  db.exec('DELETE FROM sms_suppressions');
  db.exec('DELETE FROM pending_bookings');
});

after(() => {
  try { db.close(); } catch { /* */ }
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(dbFile + ext); } catch { /* */ } }
});

test('suppression add / check / remove round-trips on E.164', () => {
  assert.equal(sms.isSuppressed('0412000111'), false);
  sms.addSuppression('0412 000 111', { reason: 'manual', by: 'admin' });
  assert.equal(sms.isSuppressed('+61412000111'), true); // normalized match
  assert.equal(sms.removeSuppression('0412000111'), true);
  assert.equal(sms.isSuppressed('0412000111'), false);
});

test('inbound STOP auto-suppresses and is surfaced to staff', () => {
  const r = sms.recordInboundSms({ direction: 'inbound', recipient: '0412222333', status: 'received', providerId: 'msg-stop-1', body: 'STOP' });
  assert.equal(r.intent, 'stop');
  assert.equal(r.suppressed, true);
  assert.equal(sms.isSuppressed('0412222333'), true);
  const row = db.prepare(`SELECT direction, action_status, intent FROM sms_log WHERE provider_id='msg-stop-1'`).get();
  assert.equal(row.direction, 'inbound');
  assert.equal(row.action_status, 'open'); // still queued for a human
  assert.equal(row.intent, 'stop');
});

test('inbound webhook is idempotent on provider id', () => {
  const first = sms.recordInboundSms({ direction: 'inbound', recipient: '0412444555', status: 'received', providerId: 'dup-1', body: 'hello' });
  const second = sms.recordInboundSms({ direction: 'inbound', recipient: '0412444555', status: 'received', providerId: 'dup-1', body: 'hello' });
  assert.equal(first.logged, true);
  assert.equal(second.duplicate, true);
  const n = db.prepare(`SELECT COUNT(*) c FROM sms_log WHERE provider_id='dup-1'`).get().c;
  assert.equal(n, 1);
});

test('inbound correlates to the patient booking by number', () => {
  insertBooking.run({ id: 'bk-1', dt: '2030-01-01T09:00:00+10:00', date: '2030-01-01', phone: '0412777888', now: new Date().toISOString() });
  const r = sms.recordInboundSms({ direction: 'inbound', recipient: '+61412777888', status: 'received', providerId: 'corr-1', body: 'see you then' });
  assert.equal(r.bookingId, 'bk-1');
  const row = db.prepare(`SELECT booking_id FROM sms_log WHERE provider_id='corr-1'`).get();
  assert.equal(row.booking_id, 'bk-1');
});

test('dispatchSms is a no-op (skipped) when SMS is disabled, still logged with body', async () => {
  const r = await sms.dispatchSms({ to: '0412999000', message: 'hi there', kind: 'staff' });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'sms_disabled');
  const row = db.prepare(`SELECT status, body FROM sms_log WHERE direction='outbound' ORDER BY id DESC LIMIT 1`).get();
  assert.equal(row.status, 'skipped');
  assert.equal(row.body, 'hi there');
});
