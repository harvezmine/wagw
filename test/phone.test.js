import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneNumber, normalizeTarget } from '../src/utils/phone.js';

test('replaces the leading 0 of a local number with the country code', () => {
  assert.equal(normalizePhoneNumber('08123456789', '62'), '628123456789');
  assert.equal(normalizePhoneNumber('0812-3456-789', '62'), '628123456789');
  assert.equal(normalizePhoneNumber('(0812) 3456 789', '62'), '628123456789');
});

test('keeps numbers that already carry a country code', () => {
  assert.equal(normalizePhoneNumber('628123456789', '62'), '628123456789');
  assert.equal(normalizePhoneNumber('+60 12-345 6789', '62'), '60123456789');
});

test('countryCode 0 disables local-number conversion', () => {
  assert.equal(normalizePhoneNumber('60123456789', '0'), '60123456789');
  assert.throws(() => normalizePhoneNumber('08123456789', '0'), { status: 400 });
});

test('rejects letters, too-short numbers and invalid country codes', () => {
  assert.throws(() => normalizePhoneNumber('abc123', '62'), { status: 400 });
  assert.throws(() => normalizePhoneNumber('0812', '62'), { status: 400 });
  assert.throws(() => normalizePhoneNumber('08123456789', '+62'), { status: 400 });
});

test('normalizeTarget turns numbers into personal JIDs', () => {
  assert.equal(normalizeTarget('08123456789', '62'), '628123456789@s.whatsapp.net');
});

test('normalizeTarget passes through valid JIDs', () => {
  assert.equal(normalizeTarget('120363023456789012@g.us', '62'), '120363023456789012@g.us');
  assert.equal(normalizeTarget('628123456789@s.whatsapp.net', '62'), '628123456789@s.whatsapp.net');
  assert.equal(normalizeTarget('123456789012345@lid', '62'), '123456789012345@lid');
});

test('normalizeTarget rejects malformed JIDs and empty targets', () => {
  for (const value of ['abc@s.whatsapp.net', 'foo@example.com', '', '<script>@g.us']) {
    assert.throws(() => normalizeTarget(value, '62'), { status: 400 });
  }
});
