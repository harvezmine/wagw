import crypto from 'node:crypto';
import net from 'node:net';
import { db as defaultDb } from '../database/db.js';
import { createTtlCache } from '../utils/ttlCache.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const KEY_PATTERN = /^wagw_([0-9a-f]{10})_[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60 * 1000;

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * A new tenant key: "wagw_<10 hex prefix>_<256-bit secret>". Only the hash is stored; the prefix
 * makes lookups cheap and identifies the key in listings.
 */
export function generateApiKey() {
  const prefix = crypto.randomBytes(5).toString('hex');
  const key = `wagw_${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: hashApiKey(key) };
}

/**
 * Validates an IP allowlist of addresses and CIDR ranges; null or empty means any IP.
 */
export function parseIpAllowlist(list) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list) || list.length > 50) {
    throw new AppError(400, 'ipAllowlist must be null or an array of up to 50 IP addresses / CIDR ranges.');
  }
  if (!list.length) return null;
  return list.map((entry) => {
    const [address, prefix] = String(entry).trim().split('/');
    const family = net.isIP(address);
    const maxPrefix = family === 6 ? 128 : 32;
    if (!family || (prefix !== undefined && !(/^\d+$/.test(prefix) && Number(prefix) <= maxPrefix))) {
      throw new AppError(400, `Invalid IP address or CIDR range "${entry}".`);
    }
    return prefix === undefined ? address : `${address}/${prefix}`;
  });
}

export function ipAllowed(allowlist, ip) {
  if (!allowlist?.length) return true;
  const family = net.isIP(ip || '');
  if (!family) return false;
  const blockList = new net.BlockList();
  for (const entry of allowlist) {
    const [address, prefix] = entry.split('/');
    const type = net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) blockList.addAddress(address, type);
    else blockList.addSubnet(address, Number(prefix), type);
  }
  return blockList.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

function formatKey(row) {
  return {
    id: Number(row.id),
    name: row.name,
    prefix: `wagw_${row.key_prefix}`,
    sessionIds: row.session_ids,
    ipAllowlist: row.ip_allowlist,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at
  };
}

export function createApiKeyStore(db = defaultDb, { cacheTtlMs = 60 * 1000, now = Date.now } = {}) {
  const cache = createTtlCache({ ttlMs: cacheTtlMs, now });
  const lastTouched = new Map();

  function touch(id) {
    if (now() - (lastTouched.get(id) ?? 0) < TOUCH_INTERVAL_MS) return;
    lastTouched.set(id, now());
    db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [id])
      .catch((error) => logger.warn({ err: error, keyId: id }, 'Could not record API key usage'));
  }

  return {
    /** Returns the plaintext key once; it cannot be recovered later. */
    async create({ name, sessionIds = null, ipAllowlist = null }) {
      const { key, prefix, hash } = generateApiKey();
      const res = await db.query(
        `INSERT INTO api_keys (name, key_prefix, key_hash, session_ids, ip_allowlist)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, prefix, hash, sessionIds, ipAllowlist]
      );
      return { key, ...formatKey(res.rows[0]) };
    },

    async list() {
      const res = await db.query('SELECT * FROM api_keys ORDER BY id');
      return res.rows.map(formatKey);
    },

    async revoke(id) {
      const res = await db.query(
        'UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING *',
        [id]
      );
      const row = res.rows[0];
      if (!row) return null;
      cache.del(row.key_prefix);
      return formatKey(row);
    },

    /** The active key row matching a presented key, or null. */
    async resolve(presented) {
      const match = KEY_PATTERN.exec(String(presented || ''));
      if (!match) return null;
      const prefix = match[1];
      let row = cache.get(prefix);
      if (row === undefined) {
        const res = await db.query('SELECT * FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL', [prefix]);
        row = res.rows[0] || null;
        cache.set(prefix, row);
      }
      if (!row || !crypto.timingSafeEqual(Buffer.from(hashApiKey(presented)), Buffer.from(row.key_hash))) {
        return null;
      }
      touch(row.id);
      return row;
    }
  };
}

export const apiKeyStore = createApiKeyStore();
