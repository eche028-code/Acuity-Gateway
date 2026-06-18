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

// ── Hub read API (feeds Acuity's right-rail "SMS" hub over /internal) ──
// These tests clear sms_log first (the file-level `before` clears once, so rows
// otherwise accumulate across tests) to assert exact feed contents.

test('hub feed lists inbound newest-first, with unhandledOnly + since filters', () => {
  db.exec('DELETE FROM sms_log');
  sms.recordInboundSms({ direction: 'inbound', recipient: '0412000001', status: 'received', providerId: 'feed-1', body: 'first', receivedAt: '2030-01-01T09:00:00.000Z' });
  sms.recordInboundSms({ direction: 'inbound', recipient: '0412000002', status: 'received', providerId: 'feed-2', body: 'second', receivedAt: '2030-01-01T10:00:00.000Z' });

  const all = sms.listInboundFeed();
  assert.equal(all.length, 2);
  assert.equal(all[0].body, 'second');          // newest first
  assert.equal(all[0].from, '+61412000002');    // normalized E.164 for patient match
  assert.equal(all[0].handled, false);

  // Handle the older one → it drops out of the unhandled view + badge count.
  const firstId = db.prepare(`SELECT id FROM sms_log WHERE provider_id='feed-1'`).get().id;
  assert.equal(sms.markInboundHandled({ id: firstId }), 1);
  assert.equal(sms.unhandledInboundCount(), 1);

  const open = sms.listInboundFeed({ unhandledOnly: true });
  assert.equal(open.length, 1);
  assert.equal(open[0].body, 'second');

  const since = sms.listInboundFeed({ since: '2030-01-01T09:30:00.000Z' });
  assert.equal(since.length, 1);
  assert.equal(since[0].body, 'second');
});

test('getThread returns the full conversation (in + out) oldest-first; bad number → null', async () => {
  db.exec('DELETE FROM sms_log');
  // Inbound dated in the past so it sorts before the outbound (logged at "now").
  sms.recordInboundSms({ direction: 'inbound', recipient: '0412777888', status: 'received', providerId: 'thr-1', body: 'inbound one', receivedAt: '2020-02-01T09:00:00.000Z' });
  // Outbound logs the recipient as given (skipped, SMS disabled) — pass E.164 so it
  // shares the normalized number the inbound row stored.
  await sms.dispatchSms({ to: '+61412777888', message: 'reply out', kind: 'staff' });

  const thread = sms.getThread('0412777888');
  assert.ok(thread);
  assert.equal(thread.number, '+61412777888');
  assert.equal(thread.messages.length, 2);
  assert.equal(thread.messages[0].direction, 'inbound');
  assert.equal(thread.messages[0].body, 'inbound one');
  assert.equal(thread.messages[1].direction, 'outbound');
  assert.equal(thread.messages[1].body, 'reply out');

  assert.equal(sms.getThread('not-a-number'), null);
});

test('markInboundHandled by number clears all open replies for that patient', () => {
  db.exec('DELETE FROM sms_log');
  sms.recordInboundSms({ direction: 'inbound', recipient: '0412555666', status: 'received', providerId: 'mh-1', body: 'one', receivedAt: '2020-03-01T09:00:00.000Z' });
  sms.recordInboundSms({ direction: 'inbound', recipient: '0412555666', status: 'received', providerId: 'mh-2', body: 'two', receivedAt: '2020-03-01T09:05:00.000Z' });
  assert.equal(sms.unhandledInboundCount(), 2);

  assert.equal(sms.markInboundHandled({ number: '0412 555 666' }), 2); // normalized match
  assert.equal(sms.unhandledInboundCount(), 0);
});
