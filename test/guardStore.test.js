import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuardStore, normalizeChatCap } from '../src/services/guardStore.js';
import { createTestDatabase, dbSkip as skip } from './helpers/testDb.js';

let database;
let store;
const P1 = '62811000001@s.whatsapp.net';
const P2 = '62811000002@s.whatsapp.net';
const P3 = '62811000003@s.whatsapp.net';
const P4 = '62811000004@s.whatsapp.net';

before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  store = createGuardStore(database.db);
});

after(async () => {
  if (database) await database.drop();
});

beforeEach(async () => {
  if (!database) return;
  await database.pool.query('DELETE FROM sessions');
  await database.pool.query(`INSERT INTO sessions (id) VALUES ('s1'), ('s2')`);
});

async function inbound(sessionId, remoteJid, { alt = null, fromMe = false, sender = null, ago = '1 hour' } = {}) {
  await database.pool.query(
    `INSERT INTO messages (session_id, message_id, remote_jid, remote_jid_alt, sender_jid, from_me, created_at)
     VALUES ($1, md5(random()::text), $2, $3, $4, $5, NOW() - $6::interval)`,
    [sessionId, remoteJid, alt, sender, fromMe, ago]
  );
}

async function sent(sessionId, targetJid, { category = 'transactional', newContact = false, status = 'sent', ago = '1 hour', type = 'text' } = {}) {
  await database.pool.query(
    `INSERT INTO outbound_messages (session_id, target_jid, message_type, payload, status, category, new_contact, sent_at)
     VALUES ($1, $2, $6, '{}'::jsonb, $3::text, $4, $5, CASE WHEN $3::text IN ('queued', 'skipped') THEN NULL ELSE NOW() - $7::interval END)`,
    [sessionId, targetJid, status, category, newContact, type, ago]
  );
}

const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000);
const near = (actual, expected, toleranceMs = 60000) => Math.abs(new Date(actual) - expected) < toleranceMs;

test('normalizeChatCap reads seconds or milliseconds and keeps the WhatsApp status', () => {
  const now = new Date('2026-10-03T00:00:00Z');
  assert.deepEqual(
    normalizeChatCap(
      { total_quota: 150, used_quota: 20, capping_status: 'FIRST_WARNING', cycle_start_timestamp: '1790000000', cycle_end_timestamp: '1792592000000' },
      now
    ),
    {
      total: 150,
      used: 20,
      status: 'FIRST_WARNING',
      cycleStart: new Date(1790000000000).toISOString(),
      cycleEnd: new Date(1792592000000).toISOString(),
      updatedAt: now.toISOString()
    }
  );
  assert.deepEqual(normalizeChatCap({}, now), { total: null, used: null, status: null, cycleStart: null, cycleEnd: null, updatedAt: now.toISOString() });
});

test('pauses only ever extend, and clearing can be limited to a reason prefix', { skip }, async () => {
  const inOneHour = new Date(Date.now() + 3600000);
  assert.equal(await store.pause('s1', 'new_chats', inOneHour, 'whatsapp_reachout_timelock'), true);
  assert.equal(await store.pause('s1', 'new_chats', new Date(Date.now() + 60000), 'health'), false);
  let guards = await store.getGuards('s1');
  assert.equal(guards.newChatsPauseReason, 'whatsapp_reachout_timelock');
  assert.equal(guards.newChatsPausedUntil.getTime(), inOneHour.getTime());
  assert.equal(guards.campaignsPausedUntil, null);

  assert.equal(await store.clearPause('s1', 'new_chats', { reasonPrefix: 'whatsapp_chat_cap' }), false);
  assert.equal(await store.clearPause('s1', 'new_chats', { reasonPrefix: 'whatsapp_reachout' }), true);
  guards = await store.getGuards('s1');
  assert.equal(guards.newChatsPausedUntil, null);
  assert.equal(guards.newChatsPauseReason, null);

  assert.equal(await store.pause('s1', 'campaigns', inOneHour, 'health: low reply rate'), true);
  assert.equal(await store.clearPause('s1', 'campaigns'), true);
  await assert.rejects(store.pause('s1', 'everything', inOneHour, 'x'), /Unknown pause scope/);
  assert.equal(await store.getGuards('missing'), null);
});

test('pairing time, chat cap and ban details are stored on the session', { skip }, async () => {
  assert.equal(await store.markPairedIfUnknown('s1'), true);
  assert.equal(await store.markPairedIfUnknown('s1'), false);
  assert.ok(near((await store.getGuards('s1')).pairedAt, new Date()));
  await store.setPairedAt('s1', null);
  assert.equal((await store.getGuards('s1')).pairedAt, null);

  const cap = await store.setChatCap('s1', { total_quota: 150, used_quota: 150, capping_status: 'CAPPED' });
  assert.equal(cap.status, 'CAPPED');
  assert.deepEqual((await store.getGuards('s1')).chatCap, cap);

  const expiresAt = new Date(Date.now() + 86400000);
  await store.setBan('s1', { code: 101, expiresAt });
  let guards = await store.getGuards('s1');
  assert.equal(guards.banCode, 101);
  assert.equal(guards.banExpiresAt.getTime(), expiresAt.getTime());
  await store.clearBan('s1');
  guards = await store.getGuards('s1');
  assert.equal(guards.banCode, null);
  assert.equal(guards.banExpiresAt, null);
});

test('getContacts finds people who wrote 1:1 (by phone or LID JID) and their consent', { skip }, async () => {
  await inbound('s1', P1, { ago: '3 hours' });
  await inbound('s1', '111@lid', { alt: P2, ago: '2 hours' });
  await inbound('s1', P3, { fromMe: true });
  await inbound('s1', '120363000000000001@g.us', { sender: P4 });
  await inbound('s2', P4);
  await store.setConsents('s1', [{ jid: P3, status: 'opted_in' }], 'api');

  const contacts = await store.getContacts('s1', [P1, P2, P3, P4]);
  assert.ok(near(contacts.get(P1).lastInboundAt, hoursAgo(3)));
  assert.equal(contacts.get(P1).consent, null);
  assert.ok(near(contacts.get(P2).lastInboundAt, hoursAgo(2)));
  assert.equal(contacts.get(P3).lastInboundAt, null);
  assert.equal(contacts.get(P3).consent.status, 'opted_in');
  assert.ok(contacts.get(P3).consent.updatedAt instanceof Date);
  assert.deepEqual(contacts.get(P4), { lastInboundAt: null, consent: null });
});

test('usage, campaign history and conversations come from sent messages', { skip }, async () => {
  await sent('s1', P1, { newContact: true, ago: '2 hours' });
  await sent('s1', P2, { newContact: true, ago: '1 hour' });
  await sent('s1', P3, { newContact: true, ago: '30 hours' });
  await sent('s1', P4, { ago: '10 minutes' });
  const usage = await store.newContactUsage('s1', hoursAgo(24));
  assert.equal(usage.count, 2);
  assert.ok(near(usage.oldestAt, hoursAgo(2)));
  assert.ok(near(usage.latestAt, hoursAgo(1)));
  assert.deepEqual(await store.newContactUsage('s2', hoursAgo(24)), { count: 0, oldestAt: null, latestAt: null });

  await sent('s1', P4, { category: 'campaign', ago: '10 hours' });
  await sent('s1', P4, { category: 'campaign', ago: '5 hours' });
  await sent('s1', P4, { category: 'campaign', status: 'queued' });
  assert.ok(near(await store.lastCampaignTo('s1', P4), hoursAgo(5)));
  assert.equal(await store.lastCampaignTo('s1', P1), null);

  await inbound('s1', P1, { ago: '72 hours' });
  await inbound('s2', P1, { fromMe: true, ago: '24 hours' });
  await inbound('s2', '222@lid', { alt: P1, ago: '20 hours' });
  const conversations = await store.conversationsWith(['s1', 's2'], P1);
  assert.ok(near(conversations.get('s1'), hoursAgo(72)));
  assert.ok(near(conversations.get('s2'), hoursAgo(20)));
  assert.equal((await store.conversationsWith(['s1'], P4)).size, 0);
});

test('consents are upserted, listed and deleted per session', { skip }, async () => {
  assert.equal(await store.setConsents('s1', [{ jid: P1, status: 'opted_in' }, { jid: P2, status: 'opted_in' }], 'api'), 2);
  await store.setConsents('s1', [{ jid: P1, status: 'opted_out' }], 'keyword');
  const optedOut = await store.listConsents('s1', { status: 'opted_out' });
  assert.deepEqual(optedOut.map((row) => [row.jid, row.status, row.source]), [[P1, 'opted_out', 'keyword']]);
  assert.equal((await store.listConsents('s1')).length, 2);
  assert.equal((await store.listConsents('s2')).length, 0);
  assert.equal(await store.deleteConsent('s1', P2), true);
  assert.equal(await store.deleteConsent('s1', P2), false);
});

test('healthMetrics counts delivery of personal messages and replies to campaign new chats', { skip }, async () => {
  await sent('s1', P1, { status: 'delivered', ago: '5 hours' });
  await sent('s1', P2, { status: 'read', ago: '5 hours' });
  await sent('s1', P3, { status: 'sent', ago: '5 hours' });
  await sent('s1', P4, { status: 'sent', ago: '10 minutes' });
  await sent('s1', P4, { status: 'sent', ago: '30 hours' });
  await sent('s1', '120363000000000001@g.us', { status: 'sent', ago: '5 hours' });
  await sent('s1', P4, { status: 'sent', ago: '5 hours', type: 'reaction' });

  await sent('s1', P1, { category: 'campaign', newContact: true, status: 'delivered', ago: '48 hours' });
  await sent('s1', P2, { category: 'campaign', newContact: true, status: 'delivered', ago: '48 hours' });
  await sent('s1', P3, { category: 'campaign', newContact: true, status: 'delivered', ago: '1 hour' });
  await sent('s1', P4, { newContact: true, status: 'delivered', ago: '48 hours' });
  await inbound('s1', P1, { ago: '40 hours' });
  await inbound('s1', P2, { ago: '50 hours' });

  assert.deepEqual(await store.healthMetrics('s1'), { deliverySample: 3, delivered: 2, replySample: 2, replied: 1 });
});
