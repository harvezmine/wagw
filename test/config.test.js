import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWaVersion, validateConfig } from '../src/config/index.js';

const base = {
  nodeEnv: 'production',
  apiKey: 'a-very-long-api-key-123',
  defaultCountryCode: '62',
  queue: { sendIntervalMinMs: 2000, sendIntervalMaxMs: 6000 },
  webhook: { secret: '' },
  guard: { campaignHours: '08:00-20:00', campaignTimezone: 'Asia/Jakarta', newContactIntervalMinMs: 60000, newContactIntervalMaxMs: 180000 }
};

test('validateConfig accepts a production config with a strong API key', () => {
  assert.doesNotThrow(() => validateConfig(base));
});

test('validateConfig rejects production without a strong API key', () => {
  assert.throws(() => validateConfig({ ...base, apiKey: '' }), /API_KEY is required/);
  assert.throws(() => validateConfig({ ...base, apiKey: 'short' }), /API_KEY is required/);
});

test('validateConfig allows an empty API key outside production', () => {
  assert.doesNotThrow(() => validateConfig({ ...base, nodeEnv: 'development', apiKey: '' }));
});

test('validateConfig rejects a malformed default country code', () => {
  assert.throws(() => validateConfig({ ...base, defaultCountryCode: '+62' }), /DEFAULT_COUNTRY_CODE/);
  assert.throws(() => validateConfig({ ...base, defaultCountryCode: '0' }), /DEFAULT_COUNTRY_CODE/);
});

test('parseWaVersion parses a dotted version and rejects garbage', () => {
  assert.equal(parseWaVersion(''), null);
  assert.deepEqual(parseWaVersion('2.3000.1043857760'), [2, 3000, 1043857760]);
  assert.throws(() => parseWaVersion('2.3000'), /Invalid WA_VERSION/);
  assert.throws(() => parseWaVersion('2..3'), /Invalid WA_VERSION/);
});

test('validateConfig rejects an inverted send interval', () => {
  assert.throws(() => validateConfig({ ...base, queue: { sendIntervalMinMs: 5000, sendIntervalMaxMs: 1000 } }), /SEND_INTERVAL/);
});

test('validateConfig rejects a short webhook secret', () => {
  assert.throws(() => validateConfig({ ...base, webhook: { secret: 'short' } }), /WEBHOOK_SECRET/);
  assert.doesNotThrow(() => validateConfig({ ...base, webhook: { secret: 'a-long-enough-secret-1' } }));
});

test('validateConfig rejects malformed campaign hours, unknown time zones and an inverted new-contact interval', () => {
  assert.throws(() => validateConfig({ ...base, guard: { ...base.guard, campaignHours: '8-20' } }), /CAMPAIGN_HOURS/);
  assert.throws(() => validateConfig({ ...base, guard: { ...base.guard, campaignTimezone: 'Mars/Olympus' } }), /CAMPAIGN_TIMEZONE/);
  assert.throws(
    () => validateConfig({ ...base, guard: { ...base.guard, newContactIntervalMinMs: 5000, newContactIntervalMaxMs: 1000 } }),
    /NEW_CONTACT_INTERVAL/
  );
});
