import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookOutbox } from '../src/services/webhookOutbox.js';
import { createTestDatabase, dbSkip as skip } from './helpers/testDb.js';

let database;
let outbox;

before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  outbox = createWebhookOutbox(database.db);
  await database.pool.query(`INSERT INTO sessions (id) VALUES ('s1'), ('s2')`);
});

after(async () => {
  if (database) await database.drop();
});

beforeEach(async () => {
  if (database) await database.pool.query('DELETE FROM webhook_deliveries');
});

const event = (sessionId = 's1') => ({ sessionId, eventType: 'message.received', payload: { event: 'message.received', data: { n: 1 } } });

test('claimDue leases due deliveries so they are not handed out twice', { skip }, async () => {
  await outbox.enqueue(event());
  await outbox.enqueue(event());
  const claimed = await outbox.claimDue(10, 60000);
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map((row) => row.attempts), [1, 1]);
  assert.deepEqual(claimed[0].payload, event().payload);
  assert.deepEqual(await outbox.claimDue(10, 60000), []);
});

test('markRetry reschedules; markDelivered and markFailed finalize', { skip }, async () => {
  const first = await outbox.enqueue(event());
  const second = await outbox.enqueue(event());
  await outbox.claimDue(10, 60000);
  await outbox.markRetry(first, { url: 'https://h.example.com', statusCode: 500, error: 'HTTP 500', delayMs: 0 });
  const retried = await outbox.claimDue(10, 60000);
  assert.deepEqual(retried.map((row) => [row.id, row.attempts]), [[first, 2]]);

  await outbox.markDelivered(first, { url: 'https://h.example.com', statusCode: 200 });
  await outbox.markFailed(second, { url: 'https://h.example.com', statusCode: 404, error: 'HTTP 404' });
  const rows = await outbox.list({ sessionId: 's1' });
  assert.deepEqual(rows.map((row) => [row.id, row.status, row.last_status_code]), [[second, 'failed', 404], [first, 'delivered', 200]]);
});

test('retry re-queues a failed delivery of the same session only', { skip }, async () => {
  const id = await outbox.enqueue(event());
  await outbox.claimDue(10, 60000);
  await outbox.markFailed(id, { url: null, statusCode: null, error: 'boom' });
  assert.equal(await outbox.retry(id, 's2'), null);
  assert.ok(await outbox.retry(id, 's1'));
  const [row] = await outbox.list({ sessionId: 's1', status: 'pending' });
  assert.equal(row.attempts, 0);
});

test('purge removes old delivered and failed deliveries', { skip }, async () => {
  const oldDelivered = await outbox.enqueue(event());
  const oldFailed = await outbox.enqueue(event());
  const recent = await outbox.enqueue(event());
  await database.pool.query(`UPDATE webhook_deliveries SET status = 'delivered', created_at = NOW() - INTERVAL '8 days' WHERE id = $1`, [oldDelivered]);
  await database.pool.query(`UPDATE webhook_deliveries SET status = 'failed', created_at = NOW() - INTERVAL '31 days' WHERE id = $1`, [oldFailed]);
  assert.equal(await outbox.purge({ deliveredDays: 7, failedDays: 30 }), 2);
  assert.deepEqual((await outbox.list({ sessionId: 's1' })).map((row) => row.id), [recent]);
});
