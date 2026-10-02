import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAntiBan } from '../src/services/antiBan.js';

const NOW = Date.parse('2026-10-03T05:00:00Z');
const HOUR = 3600000;

function setup({ now = () => NOW } = {}) {
  const pauses = new Map();
  const calls = [];
  const events = [];
  const store = {
    async pause(sessionId, scope, until, reason) {
      calls.push(['pause', scope, until.toISOString(), reason]);
      const current = pauses.get(scope);
      if (current && current.until >= until) return false;
      pauses.set(scope, { until, reason });
      return true;
    },
    async clearPause(sessionId, scope, { reasonPrefix = null } = {}) {
      calls.push(['clearPause', scope, reasonPrefix]);
      const current = pauses.get(scope);
      if (!current || (reasonPrefix && !current.reason.startsWith(reasonPrefix))) return false;
      pauses.delete(scope);
      return true;
    },
    async setChatCap(sessionId, info) {
      return { total: info.total_quota, used: info.used_quota, status: info.capping_status, cycleStart: null, cycleEnd: info.cycle_end ?? null, updatedAt: 'now' };
    },
    async setBan(sessionId, ban) {
      calls.push(['setBan', ban]);
    },
    async setConsents(sessionId, entries, source) {
      calls.push(['setConsents', entries, source]);
      return entries.length;
    }
  };
  const antiBan = createAntiBan({
    store,
    emit: (sessionId, event, payload) => events.push([event, payload]),
    rules: { restrictionPauseMs: 24 * HOUR },
    now
  });
  return { antiBan, pauses, calls, events };
}

test('pauses emit session.paused only when they are new or longer', async () => {
  const { antiBan, events } = setup();
  assert.equal(await antiBan.pauseSession('s1', 'new_chats', new Date(NOW + HOUR), 'whatsapp_error_463'), true);
  assert.equal(await antiBan.pauseSession('s1', 'new_chats', new Date(NOW + 60000), 'other'), false);
  assert.deepEqual(events, [['session.paused', { scope: 'new_chats', until: new Date(NOW + HOUR).toISOString(), reason: 'whatsapp_error_463' }]]);
});

test('error 463 pauses new chats when WhatsApp reports no active timelock, at most once per 10 minutes', async () => {
  let clock = NOW;
  const { antiBan, pauses, events } = setup({ now: () => clock });
  let fetches = 0;
  const sock = { fetchAccountReachoutTimelock: async () => (fetches++, { isActive: false }) };
  await antiBan.handleRestrictionAck('s1', sock);
  await antiBan.handleRestrictionAck('s1', sock);
  assert.equal(fetches, 1);
  assert.equal(pauses.get('new_chats').until.getTime(), NOW + 24 * HOUR);
  assert.match(pauses.get('new_chats').reason, /^whatsapp_error_463/);
  assert.deepEqual(events.find(([event]) => event === 'account.restriction'), [
    'account.restriction',
    { source: 'error_463', isActive: false, pausedUntil: new Date(NOW + 24 * HOUR).toISOString() }
  ]);
  clock += 11 * 60000;
  await antiBan.handleRestrictionAck('s1', sock);
  assert.equal(fetches, 2);
});

test('error 463 leaves an active timelock to the connection.update handler; failed lookups still pause', async () => {
  const active = setup();
  await active.antiBan.handleRestrictionAck('s1', { fetchAccountReachoutTimelock: async () => ({ isActive: true }) });
  assert.equal(active.pauses.size, 0);

  const failing = setup();
  await failing.antiBan.handleRestrictionAck('s1', {
    fetchAccountReachoutTimelock: async () => {
      throw new Error('mex 500');
    }
  });
  assert.equal(failing.pauses.get('new_chats').until.getTime(), NOW + 24 * HOUR);
  assert.equal(failing.events.find(([event]) => event === 'account.restriction')[1].isActive, null);
});

test('reach-out timelocks pause new chats until enforcement ends and are lifted when inactive', async () => {
  const { antiBan, pauses, events } = setup();
  const ends = new Date(NOW + 5 * HOUR);
  await antiBan.applyReachoutTimelock('s1', { isActive: true, timeEnforcementEnds: ends, enforcementType: 'BIZ_COMMERCE_VIOLATION_ALCOHOL' });
  assert.equal(pauses.get('new_chats').until.getTime(), ends.getTime());
  assert.equal(pauses.get('new_chats').reason, 'whatsapp_reachout_timelock: BIZ_COMMERCE_VIOLATION_ALCOHOL');
  assert.deepEqual(events[0], [
    'account.restriction',
    { source: 'reachout_timelock', isActive: true, timeEnforcementEnds: ends.toISOString(), enforcementType: 'BIZ_COMMERCE_VIOLATION_ALCOHOL' }
  ]);

  await antiBan.applyReachoutTimelock('s1', { isActive: false, enforcementType: 'DEFAULT' });
  assert.equal(pauses.size, 0);

  await antiBan.applyReachoutTimelock('s1', { isActive: true });
  assert.equal(pauses.get('new_chats').until.getTime(), NOW + 24 * HOUR);
});

test('WhatsApp chat-cap warnings pause new chats until the cycle ends; NONE lifts that pause', async () => {
  const { antiBan, pauses, events } = setup();
  const cycleEnd = new Date(NOW + 10 * 24 * HOUR).toISOString();
  await antiBan.applyChatCap('s1', { total_quota: 150, used_quota: 120, capping_status: 'FIRST_WARNING', cycle_end: cycleEnd });
  assert.equal(pauses.get('new_chats').until.toISOString(), cycleEnd);
  assert.equal(pauses.get('new_chats').reason, 'whatsapp_chat_cap: FIRST_WARNING (120/150)');
  assert.equal(events.at(-1)[0], 'account.restriction');
  assert.equal(events.at(-1)[1].source, 'chat_cap');

  await antiBan.applyChatCap('s1', { total_quota: 150, used_quota: 0, capping_status: 'NONE' });
  assert.equal(pauses.size, 0);
});

test('bans and consents are stored and reported', async () => {
  const { antiBan, calls, events } = setup();
  const expiresAt = new Date(NOW + HOUR);
  await antiBan.recordBan('s1', { permanent: false, code: 101, reason: 'too many', expiresAt });
  assert.deepEqual(calls.at(-1), ['setBan', { code: 101, expiresAt }]);
  assert.deepEqual(events.at(-1), ['account.banned', { permanent: false, code: 101, reason: 'too many', expiresAt: expiresAt.toISOString() }]);

  await antiBan.recordConsent('s1', ['62811@s.whatsapp.net', '111@lid'], 'opted_out', 'keyword');
  assert.deepEqual(calls.at(-1), [
    'setConsents',
    [{ jid: '62811@s.whatsapp.net', status: 'opted_out' }, { jid: '111@lid', status: 'opted_out' }],
    'keyword'
  ]);
  assert.deepEqual(events.at(-1), ['contact.consent', { jid: '62811@s.whatsapp.net', jids: ['62811@s.whatsapp.net', '111@lid'], status: 'opted_out', source: 'keyword' }]);
});
