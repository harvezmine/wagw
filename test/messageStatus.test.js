import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackToStatus, allowedPreviousStatuses, describeAckError } from '../src/services/messageStatus.js';

test('maps Baileys ack values to delivery statuses', () => {
  assert.equal(ackToStatus(0), 'failed');
  assert.equal(ackToStatus(1), null);
  assert.equal(ackToStatus(2), 'sent');
  assert.equal(ackToStatus(3), 'delivered');
  assert.equal(ackToStatus(4), 'read');
  assert.equal(ackToStatus(5), 'played');
  assert.equal(ackToStatus(undefined), null);
});

test('only allows forward transitions', () => {
  assert.deepEqual(allowedPreviousStatuses('sent'), []);
  assert.deepEqual(allowedPreviousStatuses('delivered'), ['sent']);
  assert.deepEqual(allowedPreviousStatuses('read'), ['sent', 'delivered']);
  assert.deepEqual(allowedPreviousStatuses('played'), ['sent', 'delivered', 'read']);
  assert.deepEqual(allowedPreviousStatuses('failed'), ['sent', 'delivered']);
});

test('explains known WhatsApp rejection codes', () => {
  assert.match(describeAckError('463'), /463.*restricted/);
  assert.equal(describeAckError('999'), 'WhatsApp error 999');
  assert.equal(describeAckError('475'), 'WhatsApp error 475');
  assert.equal(describeAckError(undefined), 'WhatsApp rejected the message');
});
