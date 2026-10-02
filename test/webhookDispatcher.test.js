import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWebhookDispatcher, createWebhookPoster } from '../src/services/webhookDispatcher.js';
import { verifyWebhookSignature } from '../src/services/webhookSigner.js';

const SECRET = 'dispatcher-secret-0123456789';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await sleep(5);
  }
}

async function startReceiver(t, statuses) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ headers: req.headers, body });
      res.statusCode = statuses[Math.min(requests.length - 1, statuses.length - 1)];
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}/hook`, requests };
}

function createFakeOutbox(rows) {
  const state = rows.map((row) => ({ status: 'pending', attempts: 0, dueAt: 0, ...row }));
  const find = (id) => state.find((row) => row.id === id);
  return {
    find,
    async claimDue(limit, leaseMs) {
      const due = state.filter((row) => row.status === 'pending' && row.dueAt <= Date.now()).slice(0, limit);
      for (const row of due) {
        row.attempts += 1;
        row.dueAt = Date.now() + leaseMs;
      }
      return due.map((row) => ({ ...row }));
    },
    async markDelivered(id, info) { Object.assign(find(id), { status: 'delivered', ...info }); },
    async markRetry(id, info) { Object.assign(find(id), info, { dueAt: Date.now() + info.delayMs }); },
    async markFailed(id, info) { Object.assign(find(id), { status: 'failed', ...info }); },
    async purge() { return 0; }
  };
}

const delivery = (id) => ({
  id,
  session_id: 's1',
  event_type: 'message.received',
  payload: { event: 'message.received', sessionId: 's1', data: { id } }
});

function createDispatcher(outbox, url, overrides = {}) {
  return createWebhookDispatcher({
    outbox,
    resolveTarget: async () => ({ url, secret: SECRET, events: null }),
    post: createWebhookPoster({ allowPrivate: true }),
    maxAttempts: 3,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 10,
    timeoutMs: 2000,
    pollMs: 5,
    ...overrides
  });
}

test('delivers events with a verifiable signature and delivery headers', async (t) => {
  const receiver = await startReceiver(t, [200]);
  const outbox = createFakeOutbox([delivery(1)]);
  const dispatcher = createDispatcher(outbox, receiver.url);
  dispatcher.start();
  await waitUntil(() => outbox.find(1).status === 'delivered');
  await dispatcher.stop();

  const [request] = receiver.requests;
  assert.deepEqual(JSON.parse(request.body), delivery(1).payload);
  assert.equal(request.headers['x-webhook-id'], '1');
  assert.equal(request.headers['x-webhook-event'], 'message.received');
  assert.equal(request.headers['x-webhook-attempt'], '1');
  assert.equal(
    verifyWebhookSignature(SECRET, request.headers['x-webhook-timestamp'], request.body, request.headers['x-webhook-signature']),
    true
  );
});

test('retries server errors until delivered', async (t) => {
  const receiver = await startReceiver(t, [500, 503, 200]);
  const outbox = createFakeOutbox([delivery(1)]);
  const dispatcher = createDispatcher(outbox, receiver.url);
  dispatcher.start();
  await waitUntil(() => outbox.find(1).status === 'delivered');
  await dispatcher.stop();
  assert.equal(receiver.requests.length, 3);
  assert.equal(outbox.find(1).attempts, 3);
});

test('does not retry client errors other than 408 and 429', async (t) => {
  const receiver = await startReceiver(t, [404]);
  const outbox = createFakeOutbox([delivery(1)]);
  const dispatcher = createDispatcher(outbox, receiver.url);
  dispatcher.start();
  await waitUntil(() => outbox.find(1).status === 'failed');
  await dispatcher.stop();
  assert.equal(receiver.requests.length, 1);
  assert.equal(outbox.find(1).statusCode, 404);
});

test('gives up after maxAttempts when the receiver is unreachable', async () => {
  const outbox = createFakeOutbox([delivery(1)]);
  const dispatcher = createDispatcher(outbox, 'http://127.0.0.1:9/hook');
  dispatcher.start();
  await waitUntil(() => outbox.find(1).status === 'failed');
  await dispatcher.stop();
  assert.equal(outbox.find(1).attempts, 3);
});

test('fails deliveries when no webhook URL is configured anymore', async () => {
  const outbox = createFakeOutbox([delivery(1)]);
  const dispatcher = createDispatcher(outbox, null);
  dispatcher.start();
  await waitUntil(() => outbox.find(1).status === 'failed');
  await dispatcher.stop();
  assert.match(outbox.find(1).error, /No webhook URL/);
});
