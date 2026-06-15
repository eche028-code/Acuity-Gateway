// The retention purge trims old sms_log rows by age, but must KEEP unhandled
// inbound replies (action_status='open') so a patient message awaiting staff
// never vanishes silently at the cutoff.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const dbFile = join(tmpdir(), `gw-purge-test-${process.pid}-${Date.now()}.sqlite`);
process.env.NODE_ENV = 'test';
process.env.DB_PATH = dbFile;
process.env.SMS_RETENTION_DAYS = '30';

const { runPurge } = await import('../src/services/purge.js');
const { db } = await import('../src/db/index.js');

const OLD = new Date(Date.now() - 60 * 86400000).toISOString();   // beyond retention
const NEW = new Date().toISOString();                              // within retention
const insert = db.prepare(
  `INSERT INTO sms_log (direction, recipient, status, body, action_status, created_at)
   VALUES (@direction, @recipient, @status, @body, @action_status, @created_at)`,
);

before(() => {
  db.exec('DELETE FROM sms_log');
  insert.run({ direction: 'inbound', recipient: '+61400000001', status: 'received', body: 'old open', action_status: 'open', created_at: OLD });
  insert.run({ direction: 'inbound', recipient: '+61400000002', status: 'received', body: 'old handled', action_status: 'handled', created_at: OLD });
  insert.run({ direction: 'outbound', recipient: '+61400000003', status: 'sent', body: 'old confirmation', action_status: null, created_at: OLD });
  insert.run({ direction: 'inbound', recipient: '+61400000004', status: 'received', body: 'recent open', action_status: 'open', created_at: NEW });
});

after(() => {
  try { db.close(); } catch { /* */ }
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(dbFile + ext); } catch { /* */ } }
});

test('purge keeps unhandled inbound replies, trims old handled/outbound rows', () => {
  const result = runPurge('test');
  // Old handled inbound + old outbound are gone; the two are counted as purged.
  assert.equal(result.purgedSms, 2);

  const survivors = db.prepare(`SELECT body FROM sms_log ORDER BY created_at`).all().map((r) => r.body);
  assert.deepEqual(survivors.sort(), ['old open', 'recent open']);

  // The aged-but-open reply specifically survived.
  const oldOpen = db.prepare(
    `SELECT 1 FROM sms_log WHERE body='old open' AND action_status='open'`,
  ).get();
  assert.ok(oldOpen, 'aged open inbound reply must survive the purge');
});
