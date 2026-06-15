import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAuNumber } from '../src/sms/cellcast.js';

test('normalizeAuNumber: AU mobile forms → E.164', () => {
  assert.equal(normalizeAuNumber('0412345678'), '+61412345678');
  assert.equal(normalizeAuNumber('0412 345 678'), '+61412345678');
  assert.equal(normalizeAuNumber('61412345678'), '+61412345678');
  assert.equal(normalizeAuNumber('+61412345678'), '+61412345678');
  assert.equal(normalizeAuNumber('+61 412 345 678'), '+61412345678');
  assert.equal(normalizeAuNumber('(04) 1234 5678'), '+61412345678');
});

test('normalizeAuNumber: empty / junk → null', () => {
  assert.equal(normalizeAuNumber(''), null);
  assert.equal(normalizeAuNumber(null), null);
  assert.equal(normalizeAuNumber(undefined), null);
  assert.equal(normalizeAuNumber('abc'), null);
});

test('normalizeAuNumber: bare local digits get +61', () => {
  assert.equal(normalizeAuNumber('412345678'), '+61412345678');
});
