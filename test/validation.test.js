import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSessionId, parseOptionalInt } from '../src/utils/validation.js';

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
