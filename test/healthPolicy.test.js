import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth } from '../src/services/healthPolicy.js';

const thresholds = { minSample: 20, minDeliveryRate: 0.6, minReplyRate: 0.05 };

test('small samples never pause', () => {
  assert.deepEqual(evaluateHealth({ deliverySample: 5, delivered: 0, replySample: 5, replied: 0 }, thresholds), { pause: false, reason: null });
});

test('a low delivery rate pauses campaigns', () => {
  const verdict = evaluateHealth({ deliverySample: 40, delivered: 10, replySample: 0, replied: 0 }, thresholds);
  assert.equal(verdict.pause, true);
  assert.match(verdict.reason, /low delivery rate \(25% of 40/);
});

test('a low reply rate on new chats pauses campaigns', () => {
  const verdict = evaluateHealth({ deliverySample: 40, delivered: 40, replySample: 50, replied: 1 }, thresholds);
  assert.equal(verdict.pause, true);
  assert.match(verdict.reason, /low reply rate \(2% of 50/);
  assert.equal(evaluateHealth({ deliverySample: 40, delivered: 40, replySample: 50, replied: 5 }, thresholds).pause, false);
});
