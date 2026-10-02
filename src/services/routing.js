import { createHash } from 'node:crypto';

/**
 * Picks which of several numbers sends to `jid`:
 * - the number with the most recent conversation with the recipient (`conversations`: sessionId -> Date);
 * - otherwise a stable hash of the recipient, so repeated sends keep using the same number.
 */
export function pickStickySession(candidates, jid, conversations = new Map()) {
  if (candidates.length === 0) return null;
  let best = null;
  for (const sessionId of candidates) {
    const last = conversations.get(sessionId);
    if (last && (!best || last > conversations.get(best))) best = sessionId;
  }
  if (best) return best;
  const sorted = [...candidates].sort();
  const hash = createHash('sha256').update(String(jid)).digest().readUInt32BE(0);
  return sorted[hash % sorted.length];
}
