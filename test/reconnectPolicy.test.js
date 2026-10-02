import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, decideReconnect } from '../src/services/reconnectPolicy.js';

const opts = { attempt: 0, registered: true, baseDelayMs: 2000, maxDelayMs: 300000, random: () => 1 };

test('logged out sessions are cleared', () => {
  assert.deepEqual(decideReconnect({ ...opts, statusCode: 401 }), { action: 'logout', reason: 'logged_out' });
});

test('conflict, ban, device mismatch and rejected client version stop without reconnecting', () => {
  const reasons = { 440: 'connection_replaced', 403: 'forbidden', 411: 'multidevice_mismatch', 405: 'client_version_rejected' };
  for (const [code, reason] of Object.entries(reasons)) {
    assert.deepEqual(decideReconnect({ ...opts, statusCode: Number(code) }), { action: 'stop', reason });
  }
});

test('restart required reconnects immediately, even before pairing finished', () => {
  assert.deepEqual(decideReconnect({ ...opts, registered: false, statusCode: 515 }), { action: 'reconnect', reason: 'restart_required', delayMs: 0 });
});

test('unpaired sessions stop instead of regenerating QR codes forever', () => {
  assert.deepEqual(decideReconnect({ ...opts, registered: false, statusCode: 408 }), { action: 'stop', reason: 'pairing_timeout' });
});

test('paired sessions reconnect with exponential backoff', () => {
  assert.deepEqual(decideReconnect({ ...opts, statusCode: 428 }), { action: 'reconnect', reason: 'connection_lost', delayMs: 2000 });
  assert.equal(decideReconnect({ ...opts, attempt: 3, statusCode: 503 }).delayMs, 16000);
  assert.equal(decideReconnect({ ...opts, attempt: 3, statusCode: undefined }).delayMs, 16000);
});

test('backoff is capped and jittered between half and full ceiling', () => {
  const cfg = { baseDelayMs: 2000, maxDelayMs: 300000 };
  assert.equal(backoffDelay(50, { ...cfg, random: () => 1 }), 300000);
  assert.equal(backoffDelay(50, { ...cfg, random: () => 0 }), 150000);
  assert.equal(backoffDelay(0, { ...cfg, random: () => 0 }), 1000);
});
