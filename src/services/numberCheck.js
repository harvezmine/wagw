import { db as defaultDb } from '../database/db.js';
import { createKeyedLock } from '../utils/keyedLock.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Postgres cache of WhatsApp registration lookups (shared by all sessions).
 */
export function createNumberCheckStore(db = defaultDb) {
  return {
    async read(phones, ttlMs) {
      const res = await db.query(
        `SELECT phone, exists_on_whatsapp, jid FROM number_checks
         WHERE phone = ANY($1::text[]) AND checked_at > NOW() - ($2::double precision * INTERVAL '1 millisecond')`,
        [phones, ttlMs]
      );
      return new Map(res.rows.map((row) => [row.phone, { exists: row.exists_on_whatsapp, jid: row.jid }]));
    },
    async write(results) {
      if (!results.length) return;
      await db.query(
        `INSERT INTO number_checks (phone, exists_on_whatsapp, jid, checked_at)
         SELECT phone, found, jid, NOW() FROM unnest($1::text[], $2::boolean[], $3::text[]) AS t(phone, found, jid)
         ON CONFLICT (phone) DO UPDATE
         SET exists_on_whatsapp = EXCLUDED.exists_on_whatsapp, jid = EXCLUDED.jid, checked_at = NOW()`,
        [results.map((result) => result.phone), results.map((result) => result.exists), results.map((result) => result.jid)]
      );
    }
  };
}

/**
 * Checks whether phone numbers are on WhatsApp. Results are cached for `ttlMs`; uncached numbers are
 * looked up in batches, one session at a time and at most once per `minIntervalMs`, because bulk
 * contact discovery is itself a ban signal.
 */
export function createNumberChecker({ store, ttlMs, minIntervalMs, batchSize = 50, now = Date.now, sleep = defaultSleep }) {
  const locks = createKeyedLock();
  const lastLookupAt = new Map();

  return {
    /**
     * @param lookup async (jids) => [{ jid, exists }], e.g. the session's sock.onWhatsApp
     */
    async check(sessionId, phones, lookup) {
      const cached = await store.read(phones, ttlMs);
      const missing = phones.filter((phone) => !cached.has(phone));
      const fresh = new Map();

      if (missing.length) {
        await locks.run(sessionId, async () => {
          for (let index = 0; index < missing.length; index += batchSize) {
            const waitMs = (lastLookupAt.get(sessionId) ?? -Infinity) + minIntervalMs - now();
            if (waitMs > 0) await sleep(waitMs);
            const chunk = missing.slice(index, index + batchSize);
            const found = (await lookup(chunk.map((phone) => `${phone}@s.whatsapp.net`))) || [];
            lastLookupAt.set(sessionId, now());
            const registered = new Map(
              found.filter((entry) => entry.exists).map((entry) => [entry.jid.split('@')[0].split(':')[0], entry.jid])
            );
            for (const phone of chunk) {
              fresh.set(phone, { exists: registered.has(phone), jid: registered.get(phone) || null });
            }
          }
        });
        await store.write([...fresh].map(([phone, result]) => ({ phone, ...result })));
      }

      return phones.map((phone) => ({ number: phone, ...(cached.get(phone) || fresh.get(phone)), cached: cached.has(phone) }));
    }
  };
}
