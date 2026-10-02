import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSessionId, parseIdempotencyKey, parseOptionalBool, parseOptionalInt, parseScheduleAt } from '../src/utils/validation.js';

test('assertSessionId accepts letters, digits, dot, underscore and dash', () => {
  assert.equal(assertSessionId('sales-01'), 'sales-01');
  assert.equal(assertSessionId('device_1.main'), 'device_1.main');
});

test('assertSessionId rejects HTML, spaces, empty and overly long ids', () => {
  for (const value of ['<script>alert(1)</script>', 'has space', '', 'a'.repeat(65), undefined]) {
    assert.throws(() => assertSessionId(value), { status: 400 });
  }
});

test('parseOptionalInt returns the default for missing values', () => {
  assert.equal(parseOptionalInt(undefined, { name: 'limit', min: 1, max: 200, defaultValue: 50 }), 50);
  assert.equal(parseOptionalInt('', { name: 'limit', min: 1, max: 200, defaultValue: 50 }), 50);
});

test('parseOptionalInt parses numeric strings within range', () => {
  assert.equal(parseOptionalInt('2000', { name: 'delayMs', min: 0, max: 15000 }), 2000);
  assert.equal(parseOptionalInt(0, { name: 'delayMs', min: 0, max: 15000 }), 0);
});

test('parseOptionalInt rejects out-of-range and non-integer values', () => {
  for (const value of ['abc', '1.5', -1, 15001]) {
    assert.throws(() => parseOptionalInt(value, { name: 'delayMs', min: 0, max: 15000 }), { status: 400 });
  }
});

test('parseOptionalBool accepts booleans and their string forms', () => {
  const opts = { name: 'async', defaultValue: false };
  assert.equal(parseOptionalBool(undefined, opts), false);
  assert.equal(parseOptionalBool('true', opts), true);
  assert.equal(parseOptionalBool(true, opts), true);
  assert.equal(parseOptionalBool('0', opts), false);
  assert.throws(() => parseOptionalBool('yes', opts), { status: 400 });
});

test('parseScheduleAt accepts ISO dates and unix seconds; past times mean now', () => {
  const now = () => Date.parse('2026-10-02T00:00:00Z');
  assert.equal(parseScheduleAt(undefined, { now }), null);
  assert.equal(parseScheduleAt('2026-10-03T08:00:00+07:00', { now }).toISOString(), '2026-10-03T01:00:00.000Z');
  assert.equal(parseScheduleAt(String(now() / 1000 + 3600), { now }).getTime(), now() + 3600000);
  assert.equal(parseScheduleAt('2020-01-01T00:00:00Z', { now }), null);
});

test('parseScheduleAt rejects garbage and dates more than a year ahead', () => {
  const now = () => Date.parse('2026-10-02T00:00:00Z');
  assert.throws(() => parseScheduleAt('tomorrow', { now }), { status: 400 });
  assert.throws(() => parseScheduleAt('2030-01-01T00:00:00Z', { now }), { status: 400 });
});

test('parseIdempotencyKey accepts short visible keys', () => {
  assert.equal(parseIdempotencyKey(undefined), null);
  assert.equal(parseIdempotencyKey('order-123'), 'order-123');
  assert.throws(() => parseIdempotencyKey('has space'), { status: 400 });
  assert.throws(() => parseIdempotencyKey('x'.repeat(201)), { status: 400 });
});
