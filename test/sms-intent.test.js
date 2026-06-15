import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent } from '../src/services/sms-intent.js';

test('parseIntent: STOP / opt-out keywords', () => {
  for (const s of ['STOP', 'stop', ' Stop ', 'STOPALL', 'unsubscribe', 'Opt Out', 'optout', 'QUIT', 'stop texting me']) {
    assert.equal(parseIntent(s), 'stop', `expected stop for "${s}"`);
  }
});

test('parseIntent: confirm only on a clear one-word reply', () => {
  for (const s of ['YES', 'y', 'Confirm', 'ok', 'Yep', 'C']) {
    assert.equal(parseIntent(s), 'confirm', `expected confirm for "${s}"`);
  }
});

test('parseIntent: cancel keywords', () => {
  for (const s of ['NO', 'cancel', 'Reschedule', 'rebook']) {
    assert.equal(parseIntent(s), 'cancel', `expected cancel for "${s}"`);
  }
});

test('parseIntent: ambiguous free text stays unknown (never auto-acted)', () => {
  for (const s of ['', null, undefined, 'yes but can we move it earlier?', 'who is this', 'cancel my 3pm please', 'thanks!']) {
    assert.equal(parseIntent(s), 'unknown', `expected unknown for "${s}"`);
  }
});

test('parseIntent: STOP wins even when other words follow', () => {
  assert.equal(parseIntent('STOP all messages'), 'stop');
});
