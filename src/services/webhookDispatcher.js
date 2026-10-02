import axios from 'axios';
import { backoffDelay } from './reconnectPolicy.js';
import { signWebhook } from './webhookSigner.js';
import { assertSafeUrl, safeRequestOptions } from '../utils/netGuard.js';

// Answers that will not change on retry (bad URL, auth, gone) fail immediately
const isRetryableStatus = (status) => status >= 500 || status === 408 || status === 429;

/**
 * HTTP POST used for webhook deliveries: the raw JSON string is sent byte-for-byte (it is what the
 * signature covers), redirects are not followed and private addresses are blocked unless allowed.
 */
export function createWebhookPoster({ allowPrivate }) {
  return async (url, body, { headers, timeoutMs }) => {
    assertSafeUrl(url, { allowPrivate, label: 'Webhook URL' });
    const response = await axios.post(url, body, {
      headers,
      timeout: timeoutMs,
      maxRedirects: 0,
      validateStatus: () => true,
      transformRequest: [(data) => data],
      ...safeRequestOptions({ allowPrivate })
    });
    return { status: response.status };
  };
}

/**
 * Delivers outbox rows with retries (exponential backoff with jitter), at-least-once.
 * Receivers should dedupe on X-Webhook-Id; events of one session may arrive out of order.
 */
export function createWebhookDispatcher({
  outbox,
  resolveTarget,
  post,
  maxAttempts,
  retryBaseDelayMs,
  retryMaxDelayMs,
  timeoutMs,
  batchSize = 20,
  pollMs = 2000,
  leaseMs = 5 * 60 * 1000,
  retention = null,
  now = Date.now,
  random = Math.random,
  logger = null
}) {
  const inFlight = new Set();
  let timer = null;
  let running = false;
  let ticking = false;
  let lastPurge = 0;

  async function fail(row, { url, statusCode, error, retryable }) {
    if (retryable && row.attempts < maxAttempts) {
      const delayMs = backoffDelay(row.attempts - 1, { baseDelayMs: retryBaseDelayMs, maxDelayMs: retryMaxDelayMs, random });
      await outbox.markRetry(row.id, { url, statusCode, error, delayMs });
      return;
    }
    await outbox.markFailed(row.id, { url, statusCode, error });
    logger?.warn({ deliveryId: row.id, sessionId: row.session_id, event: row.event_type, statusCode, error }, 'Webhook delivery failed permanently');
  }

  async function deliver(row) {
    let url = null;
    try {
      const target = await resolveTarget(row.session_id);
      url = target.url;
      if (!url) {
        await outbox.markFailed(row.id, { url: null, statusCode: null, error: 'No webhook URL configured.' });
        return;
      }
      const body = JSON.stringify(row.payload);
      const timestamp = Math.floor(now() / 1000);
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'WhatsApp-Gateway-Webhook/2.0',
        'X-Webhook-Id': String(row.id),
        'X-Webhook-Event': row.event_type,
        'X-Webhook-Timestamp': String(timestamp),
        'X-Webhook-Attempt': String(row.attempts)
      };
      if (target.secret) {
        headers['X-Webhook-Signature'] = signWebhook(target.secret, timestamp, body);
      }

      const response = await post(url, body, { headers, timeoutMs });
      if (response.status >= 200 && response.status < 300) {
        await outbox.markDelivered(row.id, { url, statusCode: response.status });
        return;
      }
      await fail(row, {
        url,
        statusCode: response.status,
        error: `Receiver responded with HTTP ${response.status}`,
        retryable: isRetryableStatus(response.status)
      });
    } catch (error) {
      await fail(row, { url, statusCode: null, error: error.message, retryable: true }).catch((dbError) => {
        // The lease expires and the delivery is retried later
        logger?.error({ deliveryId: row.id, err: dbError }, 'Could not record webhook delivery failure');
      });
    }
  }

  async function tick() {
    if (!running || ticking) return;
    ticking = true;
    try {
      if (retention && now() - lastPurge >= 60 * 60 * 1000) {
        lastPurge = now();
        const purged = await outbox.purge(retention);
        if (purged) logger?.info({ purged }, 'Purged old webhook deliveries');
      }
      const capacity = batchSize - inFlight.size;
      if (capacity <= 0) return;
      for (const row of await outbox.claimDue(capacity, leaseMs)) {
        const work = deliver(row).finally(() => inFlight.delete(work));
        inFlight.add(work);
      }
    } catch (error) {
      logger?.error({ err: error }, 'Webhook dispatcher tick failed');
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      timer = setInterval(tick, pollMs);
      setImmediate(tick);
    },
    wake() {
      if (running) setImmediate(tick);
    },
    async stop() {
      running = false;
      clearInterval(timer);
      await Promise.allSettled([...inFlight]);
    }
  };
}
