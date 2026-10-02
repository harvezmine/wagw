import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from '../src/utils/ttlCache.js';

test('returns stored values until they expire', () => {
  let time = 0;
  const cache = createTtlCache({ ttlMs: 100, now: () => time });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  time = 99;
  assert.equal(cache.get('a'), 1);
  time = 100;
  assert.equal(cache.get('a'), undefined);
});

test('del and flushAll remove entries', () => {
  const cache = createTtlCache({ ttlMs: 1000 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.del('a');
  assert.equal(cache.get('a'), undefined);
  cache.flushAll();
  assert.equal(cache.get('b'), undefined);
});

test('evicts the oldest entries beyond maxEntries', () => {
  const cache = createTtlCache({ ttlMs: 1000, maxEntries: 2, now: () => 0 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});
