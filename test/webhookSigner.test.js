import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signWebhook, verifyWebhookSignature } from '../src/services/webhookSigner.js';

const SECRET = 'secret-0123456789abcdef';

test('signs "<timestamp>.<body>" with HMAC-SHA256', () => {
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update('1790899200.{"a":1}').digest('hex');
  assert.equal(signWebhook(SECRET, 1790899200, '{"a":1}'), expected);
});

test('verifyWebhookSignature rejects tampered bodies, timestamps and missing signatures', () => {
  const signature = signWebhook(SECRET, 1790899200, '{"a":1}');
  assert.equal(verifyWebhookSignature(SECRET, '1790899200', '{"a":1}', signature), true);
  assert.equal(verifyWebhookSignature(SECRET, 1790899200, '{"a":2}', signature), false);
  assert.equal(verifyWebhookSignature(SECRET, 1790899201, '{"a":1}', signature), false);
  assert.equal(verifyWebhookSignature(SECRET, 1790899200, '{"a":1}', undefined), false);
});
