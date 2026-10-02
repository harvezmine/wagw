import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNumberChecker } from '../src/services/numberCheck.js';

function createFakeStore() {
  const rows = new Map();
  return {
    rows,
    async read(phones) {
      return new Map(phones.filter((phone) => rows.has(phone)).map((phone) => [phone, rows.get(phone)]));
    },
    async write(results) {
      for (const { phone, exists, jid } of results) rows.set(phone, { exists, jid });
    }
  };
}

function createClock() {
  let time = 0;
  const sleeps = [];
  return {
    now: () => time,
    sleep: async (ms) => { sleeps.push(ms); time += ms; },
    sleeps
  };
}

test('looks up unknown numbers once and serves them from the cache afterwards', async () => {
  const store = createFakeStore();
  const clock = createClock();
  const lookups = [];
  const lookup = async (jids) => {
    lookups.push(jids);
    return [{ jid: '62811@s.whatsapp.net', exists: true }];
  };
  const checker = createNumberChecker({ store, ttlMs: 1000, minIntervalMs: 3000, now: clock.now, sleep: clock.sleep });

  assert.deepEqual(await checker.check('s1', ['62811', '62822'], lookup), [
    { number: '62811', exists: true, jid: '62811@s.whatsapp.net', cached: false },
    { number: '62822', exists: false, jid: null, cached: false }
  ]);
  assert.deepEqual(lookups, [['62811@s.whatsapp.net', '62822@s.whatsapp.net']]);

  const again = await checker.check('s1', ['62811'], lookup);
  assert.deepEqual(again, [{ number: '62811', exists: true, jid: '62811@s.whatsapp.net', cached: true }]);
  assert.equal(lookups.length, 1);
});

test('throttles lookups per session and splits them into batches', async () => {
  const clock = createClock();
  const lookups = [];
  const checker = createNumberChecker({
    store: createFakeStore(),
    ttlMs: 1000,
    minIntervalMs: 3000,
    batchSize: 2,
    now: clock.now,
    sleep: clock.sleep
  });
  await checker.check('s1', ['1', '2', '3'], async (jids) => { lookups.push(jids.length); return []; });
  assert.deepEqual(lookups, [2, 1]);
  assert.deepEqual(clock.sleeps, [3000]);
});
