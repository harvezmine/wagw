/**
 * Minimal TTL cache implementing Baileys' CacheStore interface (get/set/del/flushAll).
 * Expired entries are dropped lazily; the oldest entries are evicted beyond `maxEntries`.
 */
export function createTtlCache({ ttlMs, maxEntries = 10000, now = Date.now }) {
  const entries = new Map();

  const sweepExpired = () => {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key);
    }
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      if (entries.size > maxEntries) {
        sweepExpired();
        while (entries.size > maxEntries) {
          entries.delete(entries.keys().next().value);
        }
      }
    },
    del(key) {
      entries.delete(key);
    },
    flushAll() {
      entries.clear();
    }
  };
}
