import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookUrlResolver } from '../src/services/webhookUrlResolver.js';

function fakeQuery(urls) {
  const calls = [];
  const query = async (sql, [sessionId]) => {
    calls.push(sessionId);
    return { rows: sessionId in urls ? [{ webhook_url: urls[sessionId] }] : [] };
  };
  return { query, calls };
}

test('returns the session webhook URL and caches it', async () => {
  const { query, calls } = fakeQuery({ s1: 'https://hooks.example.com/s1' });
  const resolver = createWebhookUrlResolver({ query, globalWebhookUrl: 'https://global.example.com' });
  assert.equal(await resolver.resolve('s1'), 'https://hooks.example.com/s1');
  assert.equal(await resolver.resolve('s1'), 'https://hooks.example.com/s1');
  assert.deepEqual(calls, ['s1']);
});

test('falls back to the global webhook URL', async () => {
  const { query } = fakeQuery({ s1: null });
  const resolver = createWebhookUrlResolver({ query, globalWebhookUrl: 'https://global.example.com' });
  assert.equal(await resolver.resolve('s1'), 'https://global.example.com');
  assert.equal(await resolver.resolve('missing'), 'https://global.example.com');
});

test('invalidate makes a changed URL visible immediately', async () => {
  const urls = { s1: 'https://old.example.com' };
  const { query } = fakeQuery(urls);
  const resolver = createWebhookUrlResolver({ query });
  assert.equal(await resolver.resolve('s1'), 'https://old.example.com');
  urls.s1 = 'https://new.example.com';
  assert.equal(await resolver.resolve('s1'), 'https://old.example.com');
  resolver.invalidate('s1');
  assert.equal(await resolver.resolve('s1'), 'https://new.example.com');
});

test('cached entries expire after the TTL', async () => {
  let time = 0;
  const { query, calls } = fakeQuery({ s1: 'https://hooks.example.com' });
  const resolver = createWebhookUrlResolver({ query, ttlMs: 1000, now: () => time });
  await resolver.resolve('s1');
  time = 1000;
  await resolver.resolve('s1');
  assert.deepEqual(calls, ['s1', 's1']);
});
