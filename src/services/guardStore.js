import { db as defaultDb } from '../database/db.js';

const PAUSE_COLUMNS = {
  new_chats: ['new_chats_paused_until', 'new_chats_pause_reason'],
  campaigns: ['campaigns_paused_until', 'campaigns_pause_reason']
};

// Message types that act on an existing message and never get delivery receipts of their own
const NON_DELIVERABLE_TYPES = ['reaction', 'edit', 'delete'];

function pauseColumns(scope) {
  const columns = PAUSE_COLUMNS[scope];
  if (!columns) throw new Error(`Unknown pause scope "${scope}"`);
  return columns;
}

function parseCapTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  const date = Number.isFinite(number) ? new Date(number < 1e12 ? number * 1000 : number) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * WhatsApp's new-chat quota (message-capping.update / fetchNewChatMessageCap) in the shape we store.
 * The cycle timestamps arrive as strings of seconds or milliseconds.
 */
export function normalizeChatCap(info = {}, now = new Date()) {
  const toNumber = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);
  return {
    total: toNumber(info.total_quota),
    used: toNumber(info.used_quota),
    status: info.capping_status || null,
    cycleStart: parseCapTimestamp(info.cycle_start_timestamp),
    cycleEnd: parseCapTimestamp(info.cycle_end_timestamp),
    updatedAt: now.toISOString()
  };
}

/**
 * Database access for the anti-ban guard: session guard state, contact history, consents and health metrics.
 */
export function createGuardStore(db = defaultDb) {
  return {
    async getGuards(sessionId) {
      const res = await db.query(
        `SELECT paired_at, new_chats_paused_until, new_chats_pause_reason, campaigns_paused_until, campaigns_pause_reason,
                ban_code, ban_expires_at, chat_cap
         FROM sessions WHERE id = $1`,
        [sessionId]
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        pairedAt: row.paired_at,
        newChatsPausedUntil: row.new_chats_paused_until,
        newChatsPauseReason: row.new_chats_pause_reason,
        campaignsPausedUntil: row.campaigns_paused_until,
        campaignsPauseReason: row.campaigns_pause_reason,
        banCode: row.ban_code,
        banExpiresAt: row.ban_expires_at,
        chatCap: row.chat_cap
      };
    },

    async setPairedAt(sessionId, pairedAt) {
      await db.query('UPDATE sessions SET paired_at = $2 WHERE id = $1', [sessionId, pairedAt]);
    },

    /** Starts the cool-down for sessions whose pairing time we never saw (e.g. paired during a crash). */
    async markPairedIfUnknown(sessionId) {
      const res = await db.query('UPDATE sessions SET paired_at = NOW() WHERE id = $1 AND paired_at IS NULL', [sessionId]);
      return res.rowCount > 0;
    },

    /**
     * Pauses new chats or campaigns until `until`. An existing longer pause is kept.
     * @returns {Promise<boolean>} true when the pause is new or longer than before
     */
    async pause(sessionId, scope, until, reason) {
      const [untilColumn, reasonColumn] = pauseColumns(scope);
      const res = await db.query(
        `UPDATE sessions SET ${untilColumn} = $2, ${reasonColumn} = $3
         WHERE id = $1 AND (${untilColumn} IS NULL OR ${untilColumn} < $2)`,
        [sessionId, until, String(reason).slice(0, 200)]
      );
      return res.rowCount > 0;
    },

    /** Lifts a pause; with `reasonPrefix` only when the pause was set for that reason. */
    async clearPause(sessionId, scope, { reasonPrefix = null } = {}) {
      const [untilColumn, reasonColumn] = pauseColumns(scope);
      const res = await db.query(
        `UPDATE sessions SET ${untilColumn} = NULL, ${reasonColumn} = NULL
         WHERE id = $1 AND ${untilColumn} IS NOT NULL
           AND ($2::text IS NULL OR left(${reasonColumn}, length($2::text)) = $2::text)`,
        [sessionId, reasonPrefix]
      );
      return res.rowCount > 0;
    },

    async setChatCap(sessionId, info) {
      const cap = normalizeChatCap(info);
      await db.query('UPDATE sessions SET chat_cap = $2::jsonb WHERE id = $1', [sessionId, JSON.stringify(cap)]);
      return cap;
    },

    async setBan(sessionId, { code = null, expiresAt = null }) {
      await db.query('UPDATE sessions SET ban_code = $2, ban_expires_at = $3 WHERE id = $1', [sessionId, code, expiresAt]);
    },

    async clearBan(sessionId) {
      await db.query(
        'UPDATE sessions SET ban_code = NULL, ban_expires_at = NULL WHERE id = $1 AND (ban_code IS NOT NULL OR ban_expires_at IS NOT NULL)',
        [sessionId]
      );
    },

    /**
     * For each JID: when the person last wrote to this session 1:1 (matched on the phone or LID JID) and
     * their consent record. Group messages never make someone a known contact.
     * @returns {Promise<Map<string, { lastInboundAt: Date | null, consent: { status, updatedAt } | null }>>}
     */
    async getContacts(sessionId, jids) {
      const res = await db.query(
        `SELECT j.jid,
                GREATEST(
                  (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = $1 AND m.from_me = false AND m.remote_jid = j.jid),
                  (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = $1 AND m.from_me = false AND m.remote_jid_alt = j.jid)
                ) AS last_inbound_at,
                c.status AS consent_status, c.updated_at AS consent_updated_at
         FROM unnest($2::text[]) AS j(jid)
         LEFT JOIN contact_consents c ON c.session_id = $1 AND c.jid = j.jid`,
        [sessionId, [...new Set(jids)]]
      );
      return new Map(
        res.rows.map((row) => [
          row.jid,
          {
            lastInboundAt: row.last_inbound_at,
            consent: row.consent_status ? { status: row.consent_status, updatedAt: row.consent_updated_at } : null
          }
        ])
      );
    },

    /** New chats opened since `since`: how many, and the oldest and latest send time. */
    async newContactUsage(sessionId, since) {
      const res = await db.query(
        `SELECT COUNT(*)::int AS count, MIN(sent_at) AS oldest_at, MAX(sent_at) AS latest_at
         FROM outbound_messages WHERE session_id = $1 AND new_contact AND sent_at >= $2`,
        [sessionId, since]
      );
      const row = res.rows[0];
      return { count: row.count, oldestAt: row.oldest_at, latestAt: row.latest_at };
    },

    /** When this session last sent a campaign message to `jid`, or null. */
    async lastCampaignTo(sessionId, jid) {
      const res = await db.query(
        `SELECT MAX(sent_at) AS last_at FROM outbound_messages
         WHERE session_id = $1 AND target_jid = $2 AND category = 'campaign' AND sent_at IS NOT NULL`,
        [sessionId, jid]
      );
      return res.rows[0].last_at;
    },

    /** Latest message (either direction) between each of `sessionIds` and `jid`. */
    async conversationsWith(sessionIds, jid) {
      const res = await db.query(
        `SELECT session_id, MAX(created_at) AS last_at FROM messages
         WHERE session_id = ANY($1::text[]) AND (remote_jid = $2 OR remote_jid_alt = $2)
         GROUP BY session_id`,
        [sessionIds, jid]
      );
      return new Map(res.rows.map((row) => [row.session_id, row.last_at]));
    },

    /** Upserts `[{ jid, status }]` (status opted_in / opted_out); source is api or keyword. */
    async setConsents(sessionId, entries, source) {
      if (entries.length === 0) return 0;
      const res = await db.query(
        `INSERT INTO contact_consents (session_id, jid, status, source)
         SELECT $1, e.jid, e.status, $4 FROM unnest($2::text[], $3::text[]) AS e(jid, status)
         ON CONFLICT (session_id, jid) DO UPDATE
         SET status = EXCLUDED.status, source = EXCLUDED.source, updated_at = NOW()`,
        [sessionId, entries.map((entry) => entry.jid), entries.map((entry) => entry.status), source]
      );
      return res.rowCount;
    },

    async listConsents(sessionId, { status = null, limit = 100, offset = 0 } = {}) {
      const res = await db.query(
        `SELECT jid, status, source, updated_at FROM contact_consents
         WHERE session_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY updated_at DESC, jid LIMIT $3 OFFSET $4`,
        [sessionId, status, limit, offset]
      );
      return res.rows;
    },

    async deleteConsent(sessionId, jid) {
      const res = await db.query('DELETE FROM contact_consents WHERE session_id = $1 AND jid = $2', [sessionId, jid]);
      return res.rowCount > 0;
    },

    /**
     * Recent outcomes for the health monitor:
     * - delivery: 1:1 messages sent 2-24 hours ago and how many reached the phone;
     * - replies: campaign messages that opened a new chat 1-7 days ago and how many got an answer.
     */
    async healthMetrics(sessionId, now = new Date()) {
      const res = await db.query(
        `SELECT
           (SELECT COUNT(*)::int FROM outbound_messages o
            WHERE o.session_id = $1 AND o.sent_at BETWEEN $2::timestamptz - INTERVAL '24 hours' AND $2::timestamptz - INTERVAL '2 hours'
              AND (o.target_jid LIKE '%@s.whatsapp.net' OR o.target_jid LIKE '%@lid')
              AND o.message_type <> ALL($3::text[])) AS delivery_sample,
           (SELECT COUNT(*)::int FROM outbound_messages o
            WHERE o.session_id = $1 AND o.sent_at BETWEEN $2::timestamptz - INTERVAL '24 hours' AND $2::timestamptz - INTERVAL '2 hours'
              AND (o.target_jid LIKE '%@s.whatsapp.net' OR o.target_jid LIKE '%@lid')
              AND o.message_type <> ALL($3::text[])
              AND o.status IN ('delivered', 'read', 'played')) AS delivered,
           (SELECT COUNT(*)::int FROM outbound_messages o
            WHERE o.session_id = $1 AND o.new_contact AND o.category = 'campaign'
              AND o.sent_at BETWEEN $2::timestamptz - INTERVAL '7 days' AND $2::timestamptz - INTERVAL '24 hours') AS reply_sample,
           (SELECT COUNT(*)::int FROM outbound_messages o
            WHERE o.session_id = $1 AND o.new_contact AND o.category = 'campaign'
              AND o.sent_at BETWEEN $2::timestamptz - INTERVAL '7 days' AND $2::timestamptz - INTERVAL '24 hours'
              AND EXISTS (
                SELECT 1 FROM messages m
                WHERE m.session_id = $1 AND m.from_me = false AND m.created_at > o.sent_at
                  AND (m.remote_jid = o.target_jid OR m.remote_jid_alt = o.target_jid)
              )) AS replied`,
        [sessionId, now, NON_DELIVERABLE_TYPES]
      );
      const row = res.rows[0];
      return { deliverySample: row.delivery_sample, delivered: row.delivered, replySample: row.reply_sample, replied: row.replied };
    }
  };
}

export const guardStore = createGuardStore();
