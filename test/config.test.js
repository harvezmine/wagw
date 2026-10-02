import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWaVersion, validateConfig } from '../src/config/index.js';

const base = { nodeEnv: 'production', apiKey: 'a-very-long-api-key-123', defaultCountryCode: '62' };

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
