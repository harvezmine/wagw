import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSendGate } from '../src/services/sendGate.js';
import { parseTimeWindow } from '../src/utils/timeWindow.js';

const NOW = Date.parse('2026-10-03T05:00:00Z'); // 12:00 in Jakarta
const HOUR = 3600000;
const at = (offsetMs) => new Date(NOW + offsetMs);
const STRANGER = '62811000001@s.whatsapp.net';
const KNOWN = '62811000002@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

const rules = {
  newContactDailyLimit: 20,
  newContactIntervalMinMs: 60000,
  newContactIntervalMaxMs: 180000,
  newSessionCooldownMs: 72 * HOUR,
  reconnectWarmupMs: 120000,
  campaignWindow: parseTimeWindow('08:00-20:00'),
  campaignTimezone: 'Asia/Jakarta',
  campaignRecipientCooldownMs: 72 * HOUR,
  campaignRequireConsent: true,
  validateNewContacts: true
};

function setup({ guards = {}, contacts = {}, usage = {}, lastCampaign = null, state = {}, registered = true, now = NOW } = {}) {
  const store = {
    async getGuards() {
      return { pairedAt: at(-30 * 24 * HOUR), newChatsPausedUntil: null, newChatsPauseReason: null, campaignsPausedUntil: null, campaignsPauseReason: null, chatCap: null, ...guards };
    },
    async getContacts(sessionId, jids) {
      const known = { [KNOWN]: { lastInboundAt: at(-48 * HOUR), consent: null }, ...contacts };
      return new Map(jids.map((jid) => [jid, known[jid] ?? { lastInboundAt: null, consent: null }]));
    },
    async newContactUsage() {
      return { count: 0, oldestAt: null, latestAt: null, ...usage };
    },
    async lastCampaignTo() {
      return lastCampaign;
    }
  };
  const lookups = [];
  const gate = createSendGate({
    store,
    getSessionState: () => ({ settings: {}, connectedAt: at(-HOUR), ...state }),
    checkRegistered: async (sessionId, jid) => {
      lookups.push(jid);
      return registered;
    },
    rules,
    now: () => now,
    random: () => 0.5
  });
  return { gate, lookups };
}

const item = (overrides = {}) => ({ id: 1, session_id: 's1', target_jid: STRANGER, message_type: 'text', category: 'transactional', ...overrides });

test('0: reactions, edits and deletes always go through', async () => {
  const { gate } = setup({ guards: { newChatsPausedUntil: at(HOUR) }, contacts: { [STRANGER]: { lastInboundAt: null, consent: { status: 'opted_out', updatedAt: at(-HOUR) } } } });
  for (const type of ['reaction', 'edit', 'delete']) {
    assert.deepEqual(await gate.evaluate(item({ message_type: type })), { action: 'send', newContact: false });
  }
});

test('1: opted-out recipients are skipped', async () => {
  const { gate } = setup({ contacts: { [STRANGER]: { lastInboundAt: null, consent: { status: 'opted_out', updatedAt: at(-HOUR) } } } });
  assert.deepEqual(await gate.evaluate(item()), { action: 'skip', reason: 'recipient opted out' });
});

test('2: campaigns to people without consent are skipped unless the session turns the requirement off', async () => {
  const strict = setup();
  const decision = await strict.gate.evaluate(item({ category: 'campaign' }));
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /no consent/);
  const relaxed = setup({ state: { settings: { campaignConsentRequired: false } } });
  assert.deepEqual(await relaxed.gate.evaluate(item({ category: 'campaign' })), { action: 'send', newContact: true });
});

test('3: paused campaigns wait until the pause ends', async () => {
  const { gate } = setup({ guards: { campaignsPausedUntil: at(5 * HOUR), campaignsPauseReason: 'health: low reply rate' } });
  const decision = await gate.evaluate(item({ category: 'campaign', target_jid: KNOWN }));
  assert.equal(decision.action, 'defer');
  assert.equal(decision.until.getTime(), NOW + 5 * HOUR);
  assert.match(decision.reason, /campaigns paused: health: low reply rate/);
});

test('4: campaigns outside campaign hours wait for the next opening', async () => {
  const { gate } = setup({ now: Date.parse('2026-10-03T14:00:00Z') }); // 21:00 in Jakarta
  const decision = await gate.evaluate(item({ category: 'campaign', target_jid: KNOWN }));
  assert.equal(decision.action, 'defer');
  assert.equal(decision.until.toISOString(), '2026-10-04T01:00:00.000Z');
  assert.match(decision.reason, /outside campaign hours/);
  assert.equal((await gate.evaluate(item({ target_jid: KNOWN }))).action, 'send');
});

test('5: a recipient gets at most one campaign message per cool-down', async () => {
  const { gate } = setup({ lastCampaign: at(-10 * HOUR) });
  const decision = await gate.evaluate(item({ category: 'campaign', target_jid: KNOWN }));
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /already received a campaign message/);
});

test('6: known contacts and groups are not new chats and skip the new-chat limits', async () => {
  const { gate } = setup({ guards: { newChatsPausedUntil: at(HOUR), pairedAt: at(-HOUR) }, usage: { count: 99 } });
  assert.deepEqual(await gate.evaluate(item({ target_jid: KNOWN })), { action: 'send', newContact: false });
  assert.deepEqual(await gate.evaluate(item({ target_jid: GROUP })), { action: 'send', newContact: false });
});

test('7: new chats wait while WhatsApp restricts the number', async () => {
  const { gate } = setup({ guards: { newChatsPausedUntil: at(3 * HOUR), newChatsPauseReason: 'whatsapp_reachout_timelock' } });
  const decision = await gate.evaluate(item());
  assert.equal(decision.action, 'defer');
  assert.equal(decision.until.getTime(), NOW + 3 * HOUR);
  assert.match(decision.reason, /new chats paused: whatsapp_reachout_timelock/);
});

test('8: newly paired numbers only reply during the cool-down', async () => {
  const { gate } = setup({ guards: { pairedAt: at(-HOUR) } });
  const decision = await gate.evaluate(item());
  assert.equal(decision.action, 'defer');
  assert.equal(decision.until.getTime(), NOW + 71 * HOUR);
  assert.match(decision.reason, /cool-down/);
});

test('9: new chats wait for the warm-up after connecting', async () => {
  const { gate } = setup({ state: { connectedAt: at(-30000) } });
  const decision = await gate.evaluate(item());
  assert.equal(decision.action, 'defer');
  assert.equal(decision.until.getTime(), NOW + 90000);
});

test('10: an exhausted WhatsApp quota defers until the cycle ends; a finished cycle does not', async () => {
  const cycleEnd = at(10 * 24 * HOUR).toISOString();
  const capped = setup({ guards: { chatCap: { total: 150, used: 150, cycleEnd } } });
  const decision = await capped.gate.evaluate(item());
  assert.equal(decision.action, 'defer');
  assert.equal(decision.until.toISOString(), cycleEnd);
  const reset = setup({ guards: { chatCap: { total: 150, used: 150, cycleEnd: at(-HOUR).toISOString() } } });
  assert.equal((await reset.gate.evaluate(item())).action, 'send');
});

test('11: the rolling daily budget defers until the oldest new chat leaves the window', async () => {
  const full = setup({ usage: { count: 20, oldestAt: at(-20 * HOUR), latestAt: at(-HOUR) } });
  const decision = await full.gate.evaluate(item());
  assert.equal(decision.action, 'defer');
  assert.equal(decision.until.getTime(), NOW + 4 * HOUR);
  assert.match(decision.reason, /daily new-chat limit \(20\)/);

  const raised = setup({ usage: { count: 20, oldestAt: at(-20 * HOUR), latestAt: at(-HOUR) }, state: { settings: { newContactDailyLimit: 25 } } });
  assert.equal((await raised.gate.evaluate(item())).action, 'send');

  const disabled = setup({ state: { settings: { newContactDailyLimit: 0 } } });
  const skipped = await disabled.gate.evaluate(item());
  assert.equal(skipped.action, 'skip');
  assert.match(skipped.reason, /new chats are disabled/);
});

test('12: new chats are spaced out, also across restarts', async () => {
  const afterRestart = setup({ usage: { count: 1, oldestAt: at(-30000), latestAt: at(-30000) } });
  const decision = await afterRestart.gate.evaluate(item());
  assert.equal(decision.action, 'defer');
  assert.equal(decision.until.getTime(), NOW + 30000);

  const { gate } = setup();
  const first = await gate.evaluate(item());
  assert.deepEqual(first, { action: 'send', newContact: true });
  gate.recordSent(item(), first);
  const next = await gate.evaluate(item({ id: 2, target_jid: '62811000009@s.whatsapp.net' }));
  assert.equal(next.action, 'defer');
  assert.equal(next.until.getTime(), NOW + 120000);
  assert.match(next.reason, /spacing between new chats/);
  gate.recordSent(item({ target_jid: KNOWN }), { action: 'send', newContact: false });
  assert.equal((await gate.evaluate(item({ target_jid: KNOWN }))).action, 'send');
});

test('13: numbers that are not on WhatsApp are skipped; unknown results and LIDs are sent', async () => {
  const missing = setup({ registered: false });
  assert.deepEqual(await missing.gate.evaluate(item()), { action: 'skip', reason: 'number is not on WhatsApp' });
  const unknown = setup({ registered: null });
  assert.deepEqual(await unknown.gate.evaluate(item()), { action: 'send', newContact: true });
  const lid = setup({ registered: false });
  assert.deepEqual(await lid.gate.evaluate(item({ target_jid: '123456789@lid' })), { action: 'send', newContact: true });
  assert.deepEqual(lid.lookups, []);
});

test('14: everything else is sent as a new chat', async () => {
  const { gate, lookups } = setup();
  assert.deepEqual(await gate.evaluate(item()), { action: 'send', newContact: true });
  assert.deepEqual(lookups, [STRANGER]);
});
