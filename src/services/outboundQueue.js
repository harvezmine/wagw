import { db as defaultDb } from '../database/db.js';

// Columns returned to API clients (never the media bytes)
const PUBLIC_COLUMNS = `id, session_id, idempotency_key, target_jid, message_type, payload, status,
  scheduled_at, attempts, message_id, last_error, created_at, updated_at, sent_at`;

/**
 * Postgres-backed outbound message queue. Rows move queued -> processing -> sent
 * (-> delivered -> read -> played) or end as failed / cancelled / expired.
 */
export function createOutboundQueue(db = defaultDb) {
  return {
    async enqueue({ sessionId, idempotencyKey = null, targetJid, messageType, payload, mediaData = null, scheduledAt = null }) {
      const inserted = await db.query(
        `INSERT INTO outbound_messages (session_id, idempotency_key, target_jid, message_type, payload, media_data, scheduled_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, COALESCE($7::timestamptz, NOW()))
         ON CONFLICT (session_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING ${PUBLIC_COLUMNS}`,
        [sessionId, idempotencyKey, targetJid, messageType, JSON.stringify(payload), mediaData, scheduledAt]
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
        `SELECT DISTINCT session_id FROM outbound_messages WHERE status = 'queued' AND scheduled_at <= NOW()`
      );
      return res.rows.map((row) => row.session_id);
    },

    /** Atomically claims the next due message of a session; safe with concurrent workers. */
    async claimNext(sessionId) {
      const res = await db.query(
        `UPDATE outbound_messages SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
         WHERE id = (
           SELECT id FROM outbound_messages
           WHERE session_id = $1 AND status = 'queued' AND scheduled_at <= NOW()
           ORDER BY scheduled_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, session_id, target_jid, message_type, payload, media_data, attempts`,
        [sessionId]
      );
      return res.rows[0] || null;
    },

    async markSent(id, messageId) {
      await db.query(
        `UPDATE outbound_messages
         SET status = 'sent', message_id = $2, sent_at = NOW(), media_data = NULL, last_error = NULL, updated_at = NOW()
         WHERE id = $1`,
        [id, messageId]
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

    async list({ sessionId = null, status = null, limit = 50, offset = 0 } = {}) {
      const res = await db.query(
        `SELECT ${PUBLIC_COLUMNS} FROM outbound_messages
         WHERE ($1::text IS NULL OR session_id = $1) AND ($2::text IS NULL OR status = $2)
         ORDER BY id DESC LIMIT $3 OFFSET $4`,
        [sessionId, status, limit, offset]
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
        `UPDATE outbound_messages SET scheduled_at = COALESCE($2::timestamptz, NOW()), updated_at = NOW()
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
             last_error = 'Not sent before the queue expiry (session offline for too long).'
         WHERE status = 'queued' AND scheduled_at < NOW() - ($1::double precision * INTERVAL '1 millisecond')
         RETURNING id, session_id, target_jid`,
        [maxAgeMs]
      );
      return res.rows;
    }
  };
}

export const outboundQueue = createOutboundQueue();
