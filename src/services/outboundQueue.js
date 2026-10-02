import { db as defaultDb } from '../database/db.js';

// Columns returned to API clients (never the media bytes)
const PUBLIC_COLUMNS = `id, session_id, idempotency_key, target_jid, message_type, category, payload, status,
  scheduled_at, deferred_until, attempts, message_id, last_error, new_contact, created_at, updated_at, sent_at`;

// Due: scheduled time reached and not held back by the send guard
const DUE = `status = 'queued' AND scheduled_at <= NOW() AND (deferred_until IS NULL OR deferred_until <= NOW())`;

/**
 * Postgres-backed outbound message queue. Rows move queued -> processing -> sent
 * (-> delivered -> read -> played) or end as failed / cancelled / expired / skipped.
 */
export function createOutboundQueue(db = defaultDb) {
  return {
    async enqueue({
      sessionId,
      idempotencyKey = null,
      targetJid,
      messageType,
      category = 'transactional',
      payload,
      mediaData = null,
      scheduledAt = null
    }) {
      const inserted = await db.query(
        `INSERT INTO outbound_messages (session_id, idempotency_key, target_jid, message_type, payload, media_data, scheduled_at, category)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, COALESCE($7::timestamptz, NOW()), $8)
         ON CONFLICT (session_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING ${PUBLIC_COLUMNS}`,
        [sessionId, idempotencyKey, targetJid, messageType, JSON.stringify(payload), mediaData, scheduledAt, category]
      );
      if (inserted.rows[0]) {
        return { item: inserted.rows[0], created: true };
      }
      const existing = await db.query(
        `SELECT ${PUBLIC_COLUMNS} FROM outbound_messages WHERE session_id = $1 AND idempotency_key = $2`,
        [sessionId, idempotencyKey]
      );
      return { item: existing.rows[0], created: false };
    },

    /** Sessions that have at least one message due now. */
    async dueSessionIds() {
      const res = await db.query(
        `SELECT DISTINCT session_id FROM outbound_messages WHERE ${DUE}`
      );
      return res.rows.map((row) => row.session_id);
    },

    /** Atomically claims the next due message of a session; safe with concurrent workers. */
    async claimNext(sessionId) {
      const res = await db.query(
        `UPDATE outbound_messages SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
         WHERE id = (
           SELECT id FROM outbound_messages
           WHERE session_id = $1 AND ${DUE}
           ORDER BY scheduled_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, session_id, target_jid, message_type, category, payload, media_data, attempts`,
        [sessionId]
      );
      return res.rows[0] || null;
    },

    /** `newContact` marks a send that opened a chat with someone who never wrote to this number. */
    async markSent(id, messageId, { newContact = false } = {}) {
      await db.query(
        `UPDATE outbound_messages
         SET status = 'sent', message_id = $2, sent_at = NOW(), new_contact = $3, deferred_until = NULL,
             media_data = NULL, last_error = NULL, updated_at = NOW()
         WHERE id = $1`,
        [id, messageId, newContact]
      );
    },

    /** Hands a claimed message back until `until`; the claim does not count as an attempt. */
    async defer(id, until, reason) {
      await db.query(
        `UPDATE outbound_messages
         SET status = 'queued', attempts = GREATEST(attempts - 1, 0), deferred_until = $2, last_error = $3, updated_at = NOW()
         WHERE id = $1`,
        [id, until, reason]
      );
    },

    /** Final: the send guard decided this message must not go out. */
    async markSkipped(id, reason) {
      await db.query(
        `UPDATE outbound_messages SET status = 'skipped', last_error = $2, media_data = NULL, updated_at = NOW() WHERE id = $1`,
        [id, reason]
      );
    },

    async markFailed(id, error) {
      await db.query(
        `UPDATE outbound_messages SET status = 'failed', last_error = $2, media_data = NULL, updated_at = NOW() WHERE id = $1`,
        [id, error]
      );
    },

    async requeue(id, error, delayMs) {
      await db.query(
        `UPDATE outbound_messages
         SET status = 'queued', last_error = $2, scheduled_at = NOW() + ($3::double precision * INTERVAL '1 millisecond'), updated_at = NOW()
         WHERE id = $1`,
        [id, error, delayMs]
      );
    },

    async get(id) {
      const res = await db.query(`SELECT ${PUBLIC_COLUMNS} FROM outbound_messages WHERE id = $1`, [id]);
      return res.rows[0] || null;
    },

    /** `sessionIds` (array) restricts the listing to those sessions, e.g. for tenant API keys. */
    async list({ sessionId = null, sessionIds = null, status = null, limit = 50, offset = 0 } = {}) {
      const res = await db.query(
        `SELECT ${PUBLIC_COLUMNS} FROM outbound_messages
         WHERE ($1::text IS NULL OR session_id = $1) AND ($2::text IS NULL OR status = $2)
           AND ($5::text[] IS NULL OR session_id = ANY($5::text[]))
         ORDER BY id DESC LIMIT $3 OFFSET $4`,
        [sessionId, status, limit, offset, sessionIds]
      );
      return res.rows;
    },

    async cancel(id) {
      const res = await db.query(
        `UPDATE outbound_messages SET status = 'cancelled', media_data = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'queued' RETURNING ${PUBLIC_COLUMNS}`,
        [id]
      );
      return res.rows[0] || null;
    },

    async reschedule(id, scheduledAt) {
      const res = await db.query(
        `UPDATE outbound_messages SET scheduled_at = COALESCE($2::timestamptz, NOW()), deferred_until = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'queued' RETURNING ${PUBLIC_COLUMNS}`,
        [id, scheduledAt]
      );
      return res.rows[0] || null;
    },

    /** Applies a delivery receipt when the current status is one of `allowedPrevious`. */
    async applyAck(sessionId, messageId, status, allowedPrevious, error = null) {
      const res = await db.query(
        `UPDATE outbound_messages SET status = $3, last_error = COALESCE($5, last_error), updated_at = NOW()
         WHERE session_id = $1 AND message_id = $2 AND status = ANY($4::text[])
         RETURNING id`,
        [sessionId, messageId, status, allowedPrevious, error]
      );
      return res.rows[0] || null;
    },

    /** Messages left "processing" by a crash may or may not have been sent: fail them, never resend. */
    async recoverInterrupted() {
      const res = await db.query(
        `UPDATE outbound_messages
         SET status = 'failed', media_data = NULL, updated_at = NOW(),
             last_error = 'Interrupted by a restart while sending; not retried to avoid a duplicate.'
         WHERE status = 'processing'`
      );
      return res.rowCount;
    },

    async expireStale(maxAgeMs) {
      const res = await db.query(
        `UPDATE outbound_messages
         SET status = 'expired', media_data = NULL, updated_at = NOW(),
             last_error = CASE WHEN deferred_until IS NULL
               THEN 'Not sent before the queue expiry (session offline for too long).'
               ELSE 'Not sent before the queue expiry; held back: ' || COALESCE(last_error, 'send guard') END
         WHERE status = 'queued' AND scheduled_at < NOW() - ($1::double precision * INTERVAL '1 millisecond')
         RETURNING id, session_id, target_jid`,
        [maxAgeMs]
      );
      return res.rows;
    }
  };
}

export const outboundQueue = createOutboundQueue();
