import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueueRunner } from '../src/services/queueRunner.js';
import { AppError } from '../src/utils/errors.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await sleep(5);
  }
}

function createFakeQueue(items) {
  const rows = items.map((item) => ({ status: 'queued', attempts: 0, dueAt: 0, target_jid: '62811@s.whatsapp.net', ...item }));
  const find = (id) => rows.find((row) => row.id === id);
  const isDue = (row) => row.status === 'queued' && row.dueAt <= Date.now();
  return {
    rows,
    find,
    async dueSessionIds() {
      return [...new Set(rows.filter(isDue).map((row) => row.session_id))];
    },
    async claimNext(sessionId) {
      const row = rows.find((candidate) => candidate.session_id === sessionId && isDue(candidate));
      if (!row) return null;
      row.status = 'processing';
      row.attempts += 1;
      return { ...row };
    },
    async markSent(id, messageId, meta = {}) { Object.assign(find(id), { status: 'sent', messageId, meta }); },
    async defer(id, until, reason) {
      const row = find(id);
      Object.assign(row, { status: 'queued', attempts: row.attempts - 1, dueAt: until.getTime(), reason });
    },
    async markSkipped(id, reason) { Object.assign(find(id), { status: 'skipped', reason }); },
    async markFailed(id, error) { Object.assign(find(id), { status: 'failed', error }); },
    async requeue(id, error, delayMs) { Object.assign(find(id), { status: 'queued', error, dueAt: Date.now() + delayMs }); },
    async expireStale() { return []; }
  };
}

function createRunner(queue, overrides = {}) {
  return createQueueRunner({
    queue,
    getReadySessionIds: () => ['s1', 's2'],
    sendItem: async (item) => `MSG-${item.id}`,
    sendIntervalMinMs: 0,
    sendIntervalMaxMs: 0,
    pollMs: 5,
    retryDelayMs: 5,
    maxAttempts: 3,
    ...overrides
  });
}

test('sends one message per session at a time with a gap between sends', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }, { id: 2, session_id: 's1' }]);
  const sends = [];
  const runner = createRunner(queue, {
    sendIntervalMinMs: 60,
    sendIntervalMaxMs: 60,
    sendItem: async (item) => {
      sends.push({ id: item.id, at: Date.now() });
      await sleep(10);
      return `MSG-${item.id}`;
    }
  });
  runner.start();
  await waitUntil(() => queue.find(2).status === 'sent');
  await runner.stop();
  assert.deepEqual(sends.map((send) => send.id), [1, 2]);
  assert.ok(sends[1].at - sends[0].at >= 60, `gap was ${sends[1].at - sends[0].at}ms`);
});

test('different sessions are processed in parallel', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }, { id: 2, session_id: 's2' }]);
  const started = [];
  const runner = createRunner(queue, {
    sendItem: async () => {
      started.push(Date.now());
      await sleep(50);
      return 'MSG';
    }
  });
  runner.start();
  await waitUntil(() => queue.rows.every((row) => row.status === 'sent'));
  await runner.stop();
  assert.ok(Math.abs(started[0] - started[1]) < 40);
});

test('skips sessions that are not connected', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }]);
  const runner = createRunner(queue, { getReadySessionIds: () => [] });
  runner.start();
  await sleep(50);
  await runner.stop();
  assert.equal(queue.find(1).status, 'queued');
});

test('retries transient errors and reports the final result', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }]);
  const results = [];
  let calls = 0;
  const runner = createRunner(queue, {
    sendItem: async () => {
      calls += 1;
      if (calls === 1) throw new Error('Connection Closed');
      return 'MSG-OK';
    },
    onResult: (result) => results.push(result)
  });
  runner.start();
  const done = await runner.waitFor(1, 2000);
  await runner.stop();
  assert.deepEqual(done, { id: 1, status: 'sent', messageId: 'MSG-OK' });
  assert.equal(queue.find(1).attempts, 2);
  assert.deepEqual(results, [{ id: 1, sessionId: 's1', to: '62811@s.whatsapp.net', status: 'sent', messageId: 'MSG-OK' }]);
});

test('bad input fails immediately; repeated transient errors fail after maxAttempts', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }, { id: 2, session_id: 's2' }]);
  const runner = createRunner(queue, {
    sendItem: async (item) => {
      if (item.id === 1) throw new AppError(400, 'Failed to download media URL');
      throw new Error('Connection Closed');
    }
  });
  runner.start();
  const [bad, flaky] = await Promise.all([runner.waitFor(1, 2000), runner.waitFor(2, 2000)]);
  await runner.stop();
  assert.equal(bad.status, 'failed');
  assert.equal(bad.httpStatus, 400);
  assert.equal(queue.find(1).attempts, 1);
  assert.equal(flaky.status, 'failed');
  assert.equal(queue.find(2).attempts, 3);
});

test('waitFor returns null when nothing finishes in time', async () => {
  const runner = createRunner(createFakeQueue([]));
  assert.equal(await runner.waitFor(99, 20), null);
});

test('stop waits for the message being sent', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }]);
  const runner = createRunner(queue, {
    sendItem: async () => {
      await sleep(50);
      return 'MSG';
    }
  });
  runner.start();
  await waitUntil(() => queue.find(1).status === 'processing');
  await runner.stop();
  assert.equal(queue.find(1).status, 'sent');
});

function createFakeGate(decide) {
  const recorded = [];
  return {
    recorded,
    async evaluate(item) {
      return decide(item);
    },
    recordSent(item, decision) {
      recorded.push([item.id, decision.newContact]);
    }
  };
}

test('deferred messages go back to the queue without using an attempt and do not hold up the next one', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }, { id: 2, session_id: 's1' }]);
  const gate = createFakeGate((item) =>
    item.id === 1 ? { action: 'defer', until: new Date(Date.now() + 60000), reason: 'daily new-chat limit' } : { action: 'send', newContact: false }
  );
  const runner = createRunner(queue, { gate });
  const waiting = runner.waitFor(1, 1000);
  runner.start();
  await waitUntil(() => queue.find(2).status === 'sent');
  await runner.stop();
  assert.equal(queue.find(1).status, 'queued');
  assert.equal(queue.find(1).attempts, 0);
  assert.equal(queue.find(1).reason, 'daily new-chat limit');
  const result = await waiting;
  assert.equal(result.status, 'queued');
  assert.equal(result.reason, 'daily new-chat limit');
  assert.ok(result.deferredUntil instanceof Date);
});

test('skipped messages end with status skipped and a reason', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }]);
  const results = [];
  const runner = createRunner(queue, {
    gate: createFakeGate(() => ({ action: 'skip', reason: 'recipient opted out' })),
    sendItem: async () => assert.fail('must not send'),
    onResult: (result) => results.push(result)
  });
  runner.start();
  await waitUntil(() => results.length === 1);
  await runner.stop();
  assert.equal(queue.find(1).status, 'skipped');
  assert.deepEqual(results[0], { id: 1, sessionId: 's1', to: '62811@s.whatsapp.net', status: 'skipped', error: 'recipient opted out' });
});

test('sends record whether they opened a new chat', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }]);
  const gate = createFakeGate(() => ({ action: 'send', newContact: true }));
  const runner = createRunner(queue, { gate });
  runner.start();
  await waitUntil(() => queue.find(1).status === 'sent');
  await runner.stop();
  assert.deepEqual(queue.find(1).meta, { newContact: true });
  assert.deepEqual(gate.recorded, [[1, true]]);
});

test('a failing gate defers instead of sending unchecked', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }]);
  const runner = createRunner(queue, {
    gate: createFakeGate(() => {
      throw new Error('database down');
    }),
    sendItem: async () => assert.fail('must not send')
  });
  runner.start();
  await waitUntil(() => queue.find(1).reason !== undefined);
  await runner.stop();
  assert.equal(queue.find(1).status, 'queued');
  assert.match(queue.find(1).reason, /send guard unavailable: database down/);
});
