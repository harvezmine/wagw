import { db as defaultDb } from '../database/db.js';

/**
 * Postgres outbox for webhook events. Rows move pending -> delivered, or pending -> failed after
 * the last attempt (retryable through the API).
 */
export function createWebhookOutbox(db = defaultDb) {
  return {
    async enqueue({ sessionId, eventType, payload }) {
      const res = await db.query(
        `INSERT INTO webhook_deliveries (session_id, event_type, payload) VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [sessionId, eventType, JSON.stringify(payload)]
      );
      return res.rows[0].id;
    },

    /** Claims due deliveries and leases them for `leaseMs`, so a crash mid-delivery only delays a retry. */
    async claimDue(limit, leaseMs) {
      const res = await db.query(
        `UPDATE webhook_deliveries
         SET attempts = attempts + 1, next_attempt_at = NOW() + ($2::double precision * INTERVAL '1 millisecond')
         WHERE id IN (
           SELECT id FROM webhook_deliveries
           WHERE status = 'pending' AND next_attempt_at <= NOW()
           ORDER BY next_attempt_at, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, session_id, event_type, payload, attempts`,
        [limit, leaseMs]
      );
      return res.rows.sort((a, b) => Number(a.id) - Number(b.id));
    },

    async markDelivered(id, { url, statusCode }) {
      await db.query(
        `UPDATE webhook_deliveries
         SET status = 'delivered', delivered_at = NOW(), last_url = $2, last_status_code = $3, last_error = NULL
         WHERE id = $1`,
        [id, url, statusCode]
      );
    },

    async markRetry(id, { url, statusCode, error, delayMs }) {
      await db.query(
        `UPDATE webhook_deliveries
         SET next_attempt_at = NOW() + ($5::double precision * INTERVAL '1 millisecond'),
             last_url = $2, last_status_code = $3, last_error = $4
         WHERE id = $1`,
        [id, url, statusCode, error, delayMs]
      );
    },

    async markFailed(id, { url, statusCode, error }) {
      await db.query(
        `UPDATE webhook_deliveries SET status = 'failed', last_url = $2, last_status_code = $3, last_error = $4 WHERE id = $1`,
        [id, url, statusCode, error]
      );
    },

    async list({ sessionId, status = null, limit = 50, offset = 0 }) {
      const res = await db.query(
        `SELECT id, event_type, status, attempts, next_attempt_at, last_url, last_status_code, last_error,
                created_at, delivered_at, payload
         FROM webhook_deliveries
         WHERE session_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY id DESC LIMIT $3 OFFSET $4`,
        [sessionId, status, limit, offset]
      );
      return res.rows;
    },

    async retry(id, sessionId) {
      const res = await db.query(
        `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL
         WHERE id = $1 AND session_id = $2 AND status = 'failed' RETURNING id`,
        [id, sessionId]
      );
      return res.rows[0] || null;
    },

    /** Retention: drops old delivered/failed deliveries and old rows of the legacy webhook_logs table. */
    async purge({ deliveredDays, failedDays }) {
      const res = await db.query(
        `DELETE FROM webhook_deliveries
         WHERE (status = 'delivered' AND created_at < NOW() - ($1::int * INTERVAL '1 day'))
            OR (status = 'failed' AND created_at < NOW() - ($2::int * INTERVAL '1 day'))`,
        [deliveredDays, failedDays]
      );
      await db.query(`DELETE FROM webhook_logs WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`, [failedDays]);
      return res.rowCount;
    }
  };
}

export const webhookOutbox = createWebhookOutbox();
