import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBooking } from '../src/services/sms-match.js';

const NOW = '2026-06-15T00:00:00.000Z';

test('pickBooking: nearest upcoming appointment wins', () => {
  const rows = [
    { id: 'far', phone: '0412345678', appointment_datetime: '2026-07-01T09:00:00+10:00', created_at: '2026-06-01T00:00:00Z' },
    { id: 'near', phone: '+61412345678', appointment_datetime: '2026-06-16T09:00:00+10:00', created_at: '2026-06-02T00:00:00Z' },
  ];
  assert.equal(pickBooking(rows, '+61412345678', NOW).id, 'near');
});

test('pickBooking: number normalization matches 04.. against +61..', () => {
  const rows = [{ id: 'a', phone: '0412 345 678', appointment_datetime: '2026-06-20T09:00:00+10:00', created_at: '2026-06-01T00:00:00Z' }];
  assert.equal(pickBooking(rows, '+61412345678', NOW)?.id, 'a');
});

test('pickBooking: no upcoming → most recently created', () => {
  const rows = [
    { id: 'old', phone: '0412345678', appointment_datetime: '2026-05-01T09:00:00+10:00', created_at: '2026-04-01T00:00:00Z' },
    { id: 'recent', phone: '0412345678', appointment_datetime: '2026-06-10T09:00:00+10:00', created_at: '2026-06-05T00:00:00Z' },
  ];
  assert.equal(pickBooking(rows, '+61412345678', NOW).id, 'recent');
});

test('pickBooking: no match → null', () => {
  const rows = [{ id: 'x', phone: '0499999999', appointment_datetime: '2026-06-20T09:00:00+10:00', created_at: '2026-06-01T00:00:00Z' }];
  assert.equal(pickBooking(rows, '+61412345678', NOW), null);
});

test('pickBooking: empty inputs → null', () => {
  assert.equal(pickBooking([], '+61412345678', NOW), null);
  assert.equal(pickBooking(null, '+61412345678', NOW), null);
  assert.equal(pickBooking([{ id: 'a', phone: '0412345678', appointment_datetime: NOW, created_at: NOW }], null, NOW), null);
});
