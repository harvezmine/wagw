import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookConfigResolver } from '../src/services/webhookConfigResolver.js';

function fakeQuery(rows) {
  const calls = [];
  const query = async (sql, [sessionId]) => {
    calls.push(sessionId);
    return { rows: rows[sessionId] ? [rows[sessionId]] : [] };
  };
  return { query, calls };
}

const GLOBALS = { globalWebhookUrl: 'https://global.example.com', globalSecret: 'global-secret-123456' };

test('returns the session webhook settings and caches them', async () => {
  const { query, calls } = fakeQuery({
    s1: { webhook_url: 'https://hooks.example.com/s1', webhook_secret: 'session-secret-123456', webhook_events: ['message.received'] }
  });
  const resolver = createWebhookConfigResolver({ query, ...GLOBALS });
  assert.deepEqual(await resolver.resolve('s1'), {
    url: 'https://hooks.example.com/s1',
    secret: 'session-secret-123456',
    events: ['message.received']
  });
  await resolver.resolve('s1');
  assert.deepEqual(calls, ['s1']);
});

test('uses the global URL with the global secret when the session has no URL', async () => {
  const { query } = fakeQuery({ s1: { webhook_url: null, webhook_secret: 'session-secret-123456', webhook_events: null } });
  const resolver = createWebhookConfigResolver({ query, ...GLOBALS });
  const expected = { url: 'https://global.example.com', secret: 'global-secret-123456', events: null };
  assert.deepEqual(await resolver.resolve('s1'), expected);
  assert.deepEqual(await resolver.resolve('missing'), expected);
});

test('invalidate makes a changed configuration visible immediately', async () => {
  const rows = { s1: { webhook_url: 'https://old.example.com', webhook_secret: null, webhook_events: null } };
  const { query } = fakeQuery(rows);
  const resolver = createWebhookConfigResolver({ query });
  assert.equal((await resolver.resolve('s1')).url, 'https://old.example.com');
  rows.s1 = { ...rows.s1, webhook_url: 'https://new.example.com' };
  assert.equal((await resolver.resolve('s1')).url, 'https://old.example.com');
  resolver.invalidate('s1');
  assert.equal((await resolver.resolve('s1')).url, 'https://new.example.com');
});

test('cached entries expire after the TTL', async () => {
  let time = 0;
  const { query, calls } = fakeQuery({ s1: { webhook_url: 'https://hooks.example.com', webhook_secret: null, webhook_events: null } });
  const resolver = createWebhookConfigResolver({ query, ttlMs: 1000, now: () => time });
  await resolver.resolve('s1');
  time = 1000;
  await resolver.resolve('s1');
  assert.deepEqual(calls, ['s1', 's1']);
});
