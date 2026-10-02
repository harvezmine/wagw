import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeHealth, evaluateHealth } from '../src/services/healthPolicy.js';

const thresholds = { minSample: 20, minDeliveryRate: 0.6, minReplyRate: 0.05 };

test('small samples never pause', () => {
  assert.deepEqual(evaluateHealth({ deliverySample: 5, delivered: 0, replySample: 5, replied: 0 }, thresholds), { pause: false, reason: null });
});

test('a low delivery rate pauses campaigns', () => {
  const verdict = evaluateHealth({ deliverySample: 40, delivered: 10, replySample: 0, replied: 0 }, thresholds);
  assert.equal(verdict.pause, true);
  assert.match(verdict.reason, /low delivery rate \(25% of 40/);
});

test('a low reply rate on new chats pauses campaigns', () => {
  const verdict = evaluateHealth({ deliverySample: 40, delivered: 40, replySample: 50, replied: 1 }, thresholds);
  assert.equal(verdict.pause, true);
  assert.match(verdict.reason, /low reply rate \(2% of 50/);
  assert.equal(evaluateHealth({ deliverySample: 40, delivered: 40, replySample: 50, replied: 5 }, thresholds).pause, false);
});

test('describeHealth summarises pauses, cool-down, warm-up, budget, quota and rates', () => {
  const now = new Date('2026-10-03T05:00:00Z');
  const at = (hours) => new Date(now.getTime() + hours * 3600000);
  const report = describeHealth({
    guards: {
      pairedAt: at(-24),
      newChatsPausedUntil: at(2),
      newChatsPauseReason: 'whatsapp_reachout_timelock: DEFAULT',
      campaignsPausedUntil: at(-1),
      campaignsPauseReason: 'health: low reply rate',
      banCode: null,
      banExpiresAt: null,
      chatCap: { total: 150, used: 12, status: 'NONE' }
    },
    usage: { count: 5, oldestAt: at(-10), latestAt: at(-1) },
    metrics: { deliverySample: 40, delivered: 30, replySample: 0, replied: 0 },
    settings: { newContactDailyLimit: null },
    connectedAt: at(-0.01),
    rules: { newContactDailyLimit: 20, newSessionCooldownMs: 72 * 3600000, reconnectWarmupMs: 120000, campaignHours: '08:00-20:00', campaignTimezone: 'Asia/Jakarta' },
    now
  });
  assert.deepEqual(report.pauses, {
    newChats: { until: at(2).toISOString(), reason: 'whatsapp_reachout_timelock: DEFAULT', byWhatsApp: true },
    campaigns: null
  });
  assert.deepEqual(report.coolDown, { pairedAt: at(-24).toISOString(), endsAt: at(48).toISOString(), active: true });
  assert.equal(report.warmUp.active, true);
  assert.deepEqual(report.newChats, { last24h: 5, dailyLimit: 20, remaining: 15, lastAt: at(-1).toISOString() });
  assert.deepEqual(report.whatsappQuota, { total: 150, used: 12, status: 'NONE' });
  assert.deepEqual(report.campaignHours, { window: '08:00-20:00', timezone: 'Asia/Jakarta', openNow: true });
  assert.deepEqual(report.metrics, { deliverySample: 40, delivered: 30, deliveryRate: 0.75, replySample: 0, replied: 0, replyRate: null });
  assert.equal(report.canStartNewChats, false);
});
