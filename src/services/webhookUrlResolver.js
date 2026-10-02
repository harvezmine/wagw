import { createTtlCache } from '../utils/ttlCache.js';

/**
 * Resolves a session's webhook URL (falling back to the global one) behind a short cache, so URL
 * changes made through the API take effect without restarting the session.
 */
export function createWebhookUrlResolver({ query, globalWebhookUrl = '', ttlMs = 30000, now = Date.now }) {
  const cache = createTtlCache({ ttlMs, now });
  return {
    async resolve(sessionId) {
      let entry = cache.get(sessionId);
      if (!entry) {
        const res = await query('SELECT webhook_url FROM sessions WHERE id = $1', [sessionId]);
        entry = { url: res.rows[0]?.webhook_url || null };
        cache.set(sessionId, entry);
      }
      return entry.url || globalWebhookUrl || null;
    },
    invalidate(sessionId) {
      cache.del(sessionId);
    }
  };
}
