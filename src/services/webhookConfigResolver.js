import { createTtlCache } from '../utils/ttlCache.js';

/**
 * Resolves where and how a session's webhook events are delivered (URL, signing secret, event filter)
 * behind a short cache, so changes made through the API apply without restarting the session.
 * The session secret only signs requests to the session URL; the global URL uses the global secret.
 */
export function createWebhookConfigResolver({ query, globalWebhookUrl = '', globalSecret = '', ttlMs = 30000, now = Date.now }) {
  const cache = createTtlCache({ ttlMs, now });
  return {
    async resolve(sessionId) {
      let entry = cache.get(sessionId);
      if (!entry) {
        const res = await query('SELECT webhook_url, webhook_secret, webhook_events FROM sessions WHERE id = $1', [sessionId]);
        const row = res.rows[0];
        entry = { url: row?.webhook_url || null, secret: row?.webhook_secret || null, events: row?.webhook_events || null };
        cache.set(sessionId, entry);
      }
      return {
        url: entry.url || globalWebhookUrl || null,
        secret: (entry.url ? entry.secret : null) || globalSecret || null,
        events: entry.events
      };
    },
    invalidate(sessionId) {
      cache.del(sessionId);
    }
  };
}
