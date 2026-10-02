const ACTIVE_CONVERSATION_MS = 24 * 3600 * 1000;

function normalizeKeyword(text) {
  return String(text ?? '')
    .trim()
    .replace(/[.!?,;:]+$/u, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/**
 * "STOP, berhenti" -> ['STOP', 'BERHENTI'].
 */
export function parseKeywordList(value) {
  return String(value ?? '')
    .split(',')
    .map(normalizeKeyword)
    .filter(Boolean);
}

/**
 * 'opted_out' / 'opted_in' when the whole message is one of the keywords (case and trailing punctuation
 * ignored), otherwise null. Keywords inside longer messages never count.
 */
export function matchConsentKeyword(text, { optOut = [], optIn = [] }) {
  const normalized = normalizeKeyword(text);
  if (!normalized) return null;
  if (optOut.includes(normalized)) return 'opted_out';
  if (optIn.includes(normalized)) return 'opted_in';
  return null;
}

/**
 * True when the recipient wrote to this number within the last 24 hours.
 */
export function isActiveConversation(contact, now = new Date()) {
  const last = contact?.lastInboundAt;
  return Boolean(last) && now.getTime() - new Date(last).getTime() < ACTIVE_CONVERSATION_MS;
}

/**
 * Why a message must not go to this recipient, or null when it may.
 * `contact` is `{ lastInboundAt, consent: { status, updatedAt } | null }`.
 * An opt-out stands until the person writes again afterwards; a reply inside an active conversation is
 * still allowed (e.g. confirming the opt-out).
 */
export function consentBlockReason({ category, isGroup, contact, requireConsent, now = new Date() }) {
  if (isGroup) return null;
  const consent = contact?.consent;
  const lastInbound = contact?.lastInboundAt ? new Date(contact.lastInboundAt) : null;
  if (consent?.status === 'opted_out') {
    const wroteAgain = lastInbound && lastInbound > new Date(consent.updatedAt);
    const activeReply = category === 'reply' && isActiveConversation(contact, now);
    if (!wroteAgain && !activeReply) return 'recipient opted out';
  }
  if (category === 'campaign' && requireConsent && !lastInbound && consent?.status !== 'opted_in') {
    return 'no consent: the recipient never wrote to this number and has not opted in';
  }
  return null;
}
