import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { guardStore } from './guardStore.js';
import { sendWebhookEvent } from './webhookService.js';
import { evaluateHealth } from './healthPolicy.js';

const RESTRICTION_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 15000;
const CAP_WARNINGS = new Set(['FIRST_WARNING', 'SECOND_WARNING', 'CAPPED']);

const iso = (value) => (value ? new Date(value).toISOString() : null);

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Turns WhatsApp's restriction signals into pauses the send gate respects, and reports them by webhook.
 * Pause reasons start with their source (whatsapp_error_463, whatsapp_reachout_timelock,
 * whatsapp_chat_cap, health) so a later signal only lifts its own pause.
 */
export function createAntiBan({ store, emit, rules, now = Date.now, logger: log = null }) {
  const lastRestrictionCheck = new Map();

  async function pauseSession(sessionId, scope, until, reason) {
    const changed = await store.pause(sessionId, scope, until, reason);
    if (changed) {
      log?.warn({ sessionId, scope, until, reason }, 'Session paused');
      emit(sessionId, 'session.paused', { scope, until: iso(until), reason });
    }
    return changed;
  }

  return {
    pauseSession,

    /**
     * A message failed with 463: WhatsApp refused to open a chat. Looks up the reach-out timelock
     * (an active one arrives through connection.update); otherwise pauses new chats for a while.
     */
    async handleRestrictionAck(sessionId, sock) {
      const last = lastRestrictionCheck.get(sessionId);
      if (last !== undefined && now() - last < RESTRICTION_CHECK_INTERVAL_MS) return;
      lastRestrictionCheck.set(sessionId, now());

      let timelock = null;
      try {
        if (typeof sock?.fetchAccountReachoutTimelock === 'function') {
          timelock = await withTimeout(sock.fetchAccountReachoutTimelock(), LOOKUP_TIMEOUT_MS);
        }
      } catch (error) {
        log?.warn({ sessionId, err: error.message }, 'Could not fetch the reach-out timelock after error 463');
      }
      if (timelock?.isActive) return;

      const until = new Date(now() + rules.restrictionPauseMs);
      await pauseSession(sessionId, 'new_chats', until, 'whatsapp_error_463: WhatsApp refused to start a new chat');
      emit(sessionId, 'account.restriction', { source: 'error_463', isActive: timelock ? false : null, pausedUntil: until.toISOString() });
    },

    async applyReachoutTimelock(sessionId, timelock) {
      emit(sessionId, 'account.restriction', {
        source: 'reachout_timelock',
        isActive: Boolean(timelock.isActive),
        timeEnforcementEnds: iso(timelock.timeEnforcementEnds),
        enforcementType: timelock.enforcementType ?? null
      });
      if (timelock.isActive) {
        const ends = timelock.timeEnforcementEnds ? new Date(timelock.timeEnforcementEnds) : null;
        const until = ends && ends.getTime() > now() ? ends : new Date(now() + rules.restrictionPauseMs);
        await pauseSession(sessionId, 'new_chats', until, `whatsapp_reachout_timelock: ${timelock.enforcementType || 'DEFAULT'}`);
      } else if (await store.clearPause(sessionId, 'new_chats', { reasonPrefix: 'whatsapp_reachout_timelock' })) {
        log?.info({ sessionId }, 'Reach-out timelock lifted, new chats resumed');
      }
    },

    /** WhatsApp's new-chat quota: a warning or the cap pauses new chats until the cycle ends. */
    async applyChatCap(sessionId, info) {
      const cap = await store.setChatCap(sessionId, info);
      if (CAP_WARNINGS.has(cap.status)) {
        const cycleEnd = cap.cycleEnd ? new Date(cap.cycleEnd) : null;
        const until = cycleEnd && cycleEnd.getTime() > now() ? cycleEnd : new Date(now() + rules.restrictionPauseMs);
        await pauseSession(sessionId, 'new_chats', until, `whatsapp_chat_cap: ${cap.status} (${cap.used}/${cap.total})`);
      } else if (cap.status === 'NONE') {
        await store.clearPause(sessionId, 'new_chats', { reasonPrefix: 'whatsapp_chat_cap' });
      }
      emit(sessionId, 'account.restriction', { source: 'chat_cap', ...cap });
      return cap;
    },

    async recordBan(sessionId, ban) {
      await store.setBan(sessionId, { code: ban.code, expiresAt: ban.expiresAt });
      log?.error({ sessionId, ...ban }, 'WhatsApp banned the account; the session will not reconnect');
      emit(sessionId, 'account.banned', { permanent: ban.permanent, code: ban.code, reason: ban.reason, expiresAt: iso(ban.expiresAt) });
    },

    /** Stores an opt-in/opt-out for every JID of the person (phone and LID). */
    async recordConsent(sessionId, jids, status, source) {
      await store.setConsents(sessionId, jids.map((jid) => ({ jid, status })), source);
      emit(sessionId, 'contact.consent', { jid: jids[0], jids, status, source });
    }
  };
}

/**
 * Periodically, for every connected session:
 * - refreshes WhatsApp's new-chat quota (at most every `capPollMs`; WhatsApp also pushes changes);
 * - pauses campaigns for `healthPauseMs` when delivery or reply rates drop (like Meta pausing a
 *   low-quality template). Sends from before the last campaign pause ended are not judged again.
 */
export function createHealthMonitor({ getConnectedSessions, store, antiBan: reactions, rules, now = Date.now, logger: log = null }) {
  const lastCapPoll = new Map();
  let timer = null;
  let running = false;

  async function pollChatCap(sessionId, sock) {
    const last = lastCapPoll.get(sessionId);
    if (typeof sock.fetchNewChatMessageCap !== 'function' || (last !== undefined && now() - last < rules.capPollMs)) return;
    lastCapPoll.set(sessionId, now());
    try {
      const info = await withTimeout(sock.fetchNewChatMessageCap(), LOOKUP_TIMEOUT_MS);
      if (info) await reactions.applyChatCap(sessionId, info);
    } catch (error) {
      // WhatsApp answers this query with errors for many accounts; the pushed updates still arrive
      log?.debug({ sessionId, err: error.message }, 'Could not fetch the new-chat quota');
    }
  }

  async function checkSession({ sessionId, sock }) {
    await pollChatCap(sessionId, sock);
    const guards = (await store.getGuards(sessionId)) || {};
    const pausedUntil = guards.campaignsPausedUntil ? new Date(guards.campaignsPausedUntil) : null;
    if (pausedUntil && pausedUntil.getTime() > now()) return;
    const metrics = await store.healthMetrics(sessionId, new Date(now()), pausedUntil);
    const verdict = evaluateHealth(metrics, {
      minSample: rules.healthMinSample,
      minDeliveryRate: rules.healthMinDeliveryRate,
      minReplyRate: rules.healthMinReplyRate
    });
    if (verdict.pause) {
      await reactions.pauseSession(sessionId, 'campaigns', new Date(now() + rules.healthPauseMs), `health: ${verdict.reason}`);
    }
  }

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      for (const session of getConnectedSessions()) {
        try {
          await checkSession(session);
        } catch (error) {
          log?.error({ sessionId: session.sessionId, err: error }, 'Health check failed');
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(runOnce, rules.healthCheckIntervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    }
  };
}

export const antiBan = createAntiBan({
  store: guardStore,
  emit: sendWebhookEvent,
  rules: config.guard,
  logger: logger.child({ module: 'anti-ban' })
});
