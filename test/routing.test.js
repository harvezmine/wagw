import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickStickySession } from '../src/services/routing.js';

test('prefers the number with the most recent conversation', () => {
  const conversations = new Map([['s1', new Date('2026-10-01')], ['s3', new Date('2026-10-02')]]);
  assert.equal(pickStickySession(['s1', 's2', 's3'], '62811@s.whatsapp.net', conversations), 's3');
});

test('without history the choice is stable for a recipient and independent of input order', () => {
  const first = pickStickySession(['s1', 's2', 's3'], '62811@s.whatsapp.net');
  for (let i = 0; i < 5; i += 1) {
    assert.equal(pickStickySession(['s3', 's1', 's2'], '62811@s.whatsapp.net'), first);
  }
  assert.equal(pickStickySession([], '62811@s.whatsapp.net'), null);
});
