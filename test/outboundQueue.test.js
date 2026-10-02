import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutboundQueue } from '../src/services/outboundQueue.js';
import { createTestDatabase, dbSkip as skip } from './helpers/testDb.js';

let database;
let queue;

before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  queue = createOutboundQueue(database.db);
  await database.pool.query(`INSERT INTO sessions (id) VALUES ('s1'), ('s2')`);
});

after(async () => {
  if (database) await database.drop();
});

beforeEach(async () => {
  if (database) await database.pool.query('DELETE FROM outbound_messages');
});

const text = (overrides = {}) => ({
  sessionId: 's1',
  targetJid: '628123456789@s.whatsapp.net',
  messageType: 'text',
  payload: { text: 'hi' },
  ...overrides
});

test('enqueue is idempotent per session and key and never returns media bytes', { skip }, async () => {
  const first = await queue.enqueue(text({ idempotencyKey: 'order-1', mediaData: Buffer.from('img') }));
  assert.equal(first.created, true);
  assert.equal(first.item.status, 'queued');
  assert.equal('media_data' in first.item, false);

  const again = await queue.enqueue(text({ idempotencyKey: 'order-1', payload: { text: 'other' } }));
  assert.equal(again.created, false);
  assert.equal(again.item.id, first.item.id);

  assert.equal((await queue.enqueue(text({ sessionId: 's2', idempotencyKey: 'order-1' }))).created, true);
});

test('claimNext hands out due messages in order and skips scheduled ones', { skip }, async () => {
  const later = await queue.enqueue(text({ scheduledAt: new Date(Date.now() + 3600000) }));
  const a = await queue.enqueue(text({ payload: { text: 'a' }, mediaData: Buffer.from('bytes') }));
  const b = await queue.enqueue(text({ payload: { text: 'b' } }));
  assert.deepEqual(await queue.dueSessionIds(), ['s1']);

  const first = await queue.claimNext('s1');
  assert.equal(first.id, a.item.id);
  assert.equal(first.attempts, 1);
  assert.deepEqual(first.media_data, Buffer.from('bytes'));
  assert.equal((await queue.claimNext('s1')).id, b.item.id);
  assert.equal(await queue.claimNext('s1'), null);
  assert.equal((await queue.get(later.item.id)).status, 'queued');
});

test('concurrent claims never return the same message twice', { skip }, async () => {
  await queue.enqueue(text());
  const claims = await Promise.all([queue.claimNext('s1'), queue.claimNext('s1'), queue.claimNext('s1')]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test('requeue and markSent update the row', { skip }, async () => {
  const { item } = await queue.enqueue(text());
  const claimed = await queue.claimNext('s1');
  await queue.requeue(claimed.id, 'Connection Closed', 0);
  let row = await queue.get(item.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.last_error, 'Connection Closed');

  await queue.claimNext('s1');
  await queue.markSent(item.id, 'WAMSG1');
  row = await queue.get(item.id);
  assert.equal(row.status, 'sent');
  assert.equal(row.message_id, 'WAMSG1');
  assert.equal(row.attempts, 2);
  assert.ok(row.sent_at);
});

test('cancel and reschedule only change queued messages', { skip }, async () => {
  const { item } = await queue.enqueue(text());
  const when = new Date(Date.now() + 60000);
  assert.equal((await queue.reschedule(item.id, when)).scheduled_at.getTime(), when.getTime());
  assert.equal((await queue.cancel(item.id)).status, 'cancelled');
  assert.equal(await queue.cancel(item.id), null);
  assert.equal(await queue.reschedule(item.id, null), null);
});

test('applyAck only moves the status forward', { skip }, async () => {
  const { item } = await queue.enqueue(text());
  await queue.claimNext('s1');
  await queue.markSent(item.id, 'WAMSG2');
  assert.ok(await queue.applyAck('s1', 'WAMSG2', 'read', ['sent', 'delivered']));
  assert.equal(await queue.applyAck('s1', 'WAMSG2', 'delivered', ['sent']), null);
  assert.equal((await queue.get(item.id)).status, 'read');
});

test('recoverInterrupted fails in-flight rows; expireStale expires old queued rows', { skip }, async () => {
  const stuck = await queue.enqueue(text());
  await queue.claimNext('s1');
  const old = await queue.enqueue(text({ scheduledAt: new Date(Date.now() + 60000) }));
  await database.pool.query(`UPDATE outbound_messages SET scheduled_at = NOW() - INTERVAL '2 days' WHERE id = $1`, [old.item.id]);

  assert.equal(await queue.recoverInterrupted(), 1);
  assert.equal((await queue.get(stuck.item.id)).status, 'failed');

  const expired = await queue.expireStale(24 * 60 * 60 * 1000);
  assert.deepEqual(expired.map((row) => row.id), [old.item.id]);
  assert.equal((await queue.get(old.item.id)).status, 'expired');
});
