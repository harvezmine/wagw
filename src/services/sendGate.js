import { consentBlockReason } from './consent.js';
import { nextWindowStart } from '../utils/timeWindow.js';

const DAY_MS = 24 * 3600 * 1000;

// Act on a message in an existing chat: they never open a chat
const IN_CHAT_TYPES = new Set(['reaction', 'edit', 'delete']);

const isPersonal = (jid) => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
const send = (newContact) => ({ action: 'send', newContact });
const skip = (reason) => ({ action: 'skip', reason });
const defer = (until, reason) => ({ action: 'defer', until: new Date(until), reason });
const formatTime = (date) => new Date(date).toISOString();

/**
 * Decides, right before a queued message is sent, whether it goes out now (`send`), waits (`defer`) or
 * never goes out (`skip`). Rules run in order (see README, "Anti-Ban Guard"); the first match wins.
 *
 * - `store`: guardStore-like (getGuards, getContacts, newContactUsage, lastCampaignTo)
 * - `getSessionState(sessionId)`: `{ settings, connectedAt }` of the running session
 * - `checkRegistered(sessionId, jid)`: true / false / null (unknown); optional
 */
export function createSendGate({ store, getSessionState, checkRegistered = null, rules, now = Date.now, random = Math.random }) {
  // Earliest time the next new chat may open, per session (DB send times cover restarts)
  const nextNewContactAt = new Map();

  const interval = () =>
    Math.round(rules.newContactIntervalMinMs + random() * (rules.newContactIntervalMaxMs - rules.newContactIntervalMinMs));

  async function campaignRules(item, guards, current) {
    if (guards.campaignsPausedUntil && guards.campaignsPausedUntil > current) {
      return defer(guards.campaignsPausedUntil, `campaigns paused: ${guards.campaignsPauseReason || 'paused'}`);
    }
    const opening = nextWindowStart(new Date(current), rules.campaignWindow, rules.campaignTimezone);
    if (opening) {
      return defer(opening, `outside campaign hours, waiting until ${formatTime(opening)}`);
    }
    const last = await store.lastCampaignTo(item.session_id, item.target_jid);
    if (last && current - new Date(last) < rules.campaignRecipientCooldownMs) {
      const hours = Math.round(rules.campaignRecipientCooldownMs / 3600000);
      return skip(`recipient already received a campaign message in the last ${hours} hours`);
    }
    return null;
  }

  async function newChatRules(item, guards, state, current) {
    const sessionId = item.session_id;
    if (guards.newChatsPausedUntil && guards.newChatsPausedUntil > current) {
      return defer(guards.newChatsPausedUntil, `new chats paused: ${guards.newChatsPauseReason || 'paused'}`);
    }
    if (guards.pairedAt) {
      const coolDownEnds = new Date(guards.pairedAt).getTime() + rules.newSessionCooldownMs;
      if (coolDownEnds > current) {
        return defer(coolDownEnds, `new number cool-down: only replies and known contacts until ${formatTime(coolDownEnds)}`);
      }
    }
    if (state?.connectedAt) {
      const warmUpEnds = new Date(state.connectedAt).getTime() + rules.reconnectWarmupMs;
      if (warmUpEnds > current) return defer(warmUpEnds, 'connection warm-up after (re)connecting');
    }
    const cap = guards.chatCap;
    if (cap?.total !== null && cap?.total !== undefined && cap.used >= cap.total && cap.cycleEnd && new Date(cap.cycleEnd) > current) {
      return defer(cap.cycleEnd, `WhatsApp new-chat quota used up (${cap.used}/${cap.total}) until ${formatTime(cap.cycleEnd)}`);
    }

    const limit = state?.settings?.newContactDailyLimit ?? rules.newContactDailyLimit;
    if (limit === 0) {
      return skip('new chats are disabled for this session (newContactDailyLimit is 0)');
    }
    const usage = await store.newContactUsage(sessionId, new Date(current - DAY_MS));
    if (usage.count >= limit) {
      const slotFrees = usage.oldestAt ? new Date(usage.oldestAt).getTime() + DAY_MS : current + DAY_MS;
      return defer(Math.max(slotFrees, current + 60000), `daily new-chat limit (${limit}) reached`);
    }
    const lastSentAt = usage.latestAt ? new Date(usage.latestAt).getTime() : 0;
    const earliest = Math.max(nextNewContactAt.get(sessionId) ?? 0, lastSentAt + rules.newContactIntervalMinMs);
    if (earliest > current) {
      return defer(earliest, 'spacing between new chats');
    }

    if (rules.validateNewContacts && checkRegistered && item.target_jid.endsWith('@s.whatsapp.net')) {
      if ((await checkRegistered(sessionId, item.target_jid)) === false) return skip('number is not on WhatsApp');
    }
    return null;
  }

  return {
    /** @returns {Promise<{action:'send',newContact:boolean}|{action:'defer',until:Date,reason:string}|{action:'skip',reason:string}>} */
    async evaluate(item) {
      if (IN_CHAT_TYPES.has(item.message_type)) return send(false);
      const current = now();
      const sessionId = item.session_id;
      const personal = isPersonal(item.target_jid);
      const state = getSessionState(sessionId);
      const category = item.category || 'transactional';

      const contact = personal ? (await store.getContacts(sessionId, [item.target_jid])).get(item.target_jid) : null;
      const blocked = consentBlockReason({
        category,
        isGroup: !personal,
        contact,
        requireConsent: state?.settings?.campaignConsentRequired ?? rules.campaignRequireConsent,
        now: new Date(current)
      });
      if (blocked) return skip(blocked);

      const guards = (await store.getGuards(sessionId)) || {};
      if (category === 'campaign') {
        const decision = await campaignRules(item, guards, current);
        if (decision) return decision;
      }
      if (!personal || contact?.lastInboundAt) return send(false);

      return (await newChatRules(item, guards, state, current)) || send(true);
    },

    /** Starts the gap before the session's next new chat. */
    recordSent(item, decision) {
      if (decision?.newContact) nextNewContactAt.set(item.session_id, now() + interval());
    }
  };
}
