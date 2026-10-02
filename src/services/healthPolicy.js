import { nextWindowStart, parseTimeWindow } from '../utils/timeWindow.js';

const percent = (part, whole) => Math.round((part / whole) * 100);

/**
 * Whether campaigns should pause, from recent outcomes:
 * - delivery rate of sent messages (WhatsApp silently dropping them is an early restriction sign);
 * - reply rate of new chats (few replies usually means many reports and blocks).
 * Samples below `minSample` never trigger a pause.
 */
export function evaluateHealth({ deliverySample, delivered, replySample, replied }, { minSample, minDeliveryRate, minReplyRate }) {
  if (deliverySample >= minSample && delivered / deliverySample < minDeliveryRate) {
    return { pause: true, reason: `low delivery rate (${percent(delivered, deliverySample)}% of ${deliverySample} recent messages)` };
  }
  if (replySample >= minSample && replied / replySample < minReplyRate) {
    return { pause: true, reason: `low reply rate (${percent(replied, replySample)}% of ${replySample} recent new chats)` };
  }
  return { pause: false, reason: null };
}

const iso = (value) => (value ? new Date(value).toISOString() : null);
const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) / 100 : null);

function activePause(until, reason, now) {
  if (!until || new Date(until) <= now) return null;
  return { until: iso(until), reason, byWhatsApp: String(reason || '').startsWith('whatsapp_') };
}

/**
 * The guard state of a session as reported by GET /api/sessions/:id/health.
 */
export function describeHealth({ guards, usage, metrics, settings, connectedAt, rules, now = new Date() }) {
  const coolDownEnds = guards.pairedAt ? new Date(new Date(guards.pairedAt).getTime() + rules.newSessionCooldownMs) : null;
  const warmUpEnds = connectedAt ? new Date(new Date(connectedAt).getTime() + rules.reconnectWarmupMs) : null;
  const dailyLimit = settings?.newContactDailyLimit ?? rules.newContactDailyLimit;
  const pauses = {
    newChats: activePause(guards.newChatsPausedUntil, guards.newChatsPauseReason, now),
    campaigns: activePause(guards.campaignsPausedUntil, guards.campaignsPauseReason, now)
  };
  const coolDownActive = Boolean(coolDownEnds && coolDownEnds > now);
  const remaining = Math.max(dailyLimit - usage.count, 0);
  return {
    pauses,
    coolDown: { pairedAt: iso(guards.pairedAt), endsAt: iso(coolDownEnds), active: coolDownActive },
    warmUp: { connectedAt: iso(connectedAt), endsAt: iso(warmUpEnds), active: Boolean(warmUpEnds && warmUpEnds > now) },
    newChats: { last24h: usage.count, dailyLimit, remaining, lastAt: iso(usage.latestAt) },
    whatsappQuota: guards.chatCap ?? null,
    campaignHours: {
      window: rules.campaignHours,
      timezone: rules.campaignTimezone,
      openNow: nextWindowStart(now, parseTimeWindow(rules.campaignHours), rules.campaignTimezone) === null
    },
    metrics: {
      deliverySample: metrics.deliverySample,
      delivered: metrics.delivered,
      deliveryRate: rate(metrics.delivered, metrics.deliverySample),
      replySample: metrics.replySample,
      replied: metrics.replied,
      replyRate: rate(metrics.replied, metrics.replySample)
    },
    canStartNewChats: !pauses.newChats && !coolDownActive && remaining > 0
  };
}
