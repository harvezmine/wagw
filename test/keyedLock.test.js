import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedLock } from '../src/utils/keyedLock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('runs tasks for the same key one at a time, in order', async () => {
  const lock = createKeyedLock();
  const events = [];
  const task = (name, ms) => lock.run('s1', async () => {
    events.push(`start:${name}`);
    await sleep(ms);
    events.push(`end:${name}`);
    return name;
  });
  assert.deepEqual(await Promise.all([task('a', 30), task('b', 0)]), ['a', 'b']);
  assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('runs different keys in parallel', async () => {
  const lock = createKeyedLock();
  const events = [];
  await Promise.all([
    lock.run('s1', async () => { events.push('start:s1'); await sleep(30); events.push('end:s1'); }),
    lock.run('s2', async () => { events.push('start:s2'); events.push('end:s2'); })
  ]);
  assert.deepEqual(events, ['start:s1', 'start:s2', 'end:s2', 'end:s1']);
});

test('a failing task does not block the next one', async () => {
  const lock = createKeyedLock();
  await assert.rejects(lock.run('s1', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await lock.run('s1', async () => 'ok'), 'ok');
});
