import { config } from '../config/index.js';
import { query } from '../database/db.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';
import { normalizeTarget } from '../utils/phone.js';
import { assertSafeUrl } from '../utils/netGuard.js';
import { outboundQueue } from './outboundQueue.js';
import { createQueueRunner } from './queueRunner.js';
import { sendWebhookEvent } from './webhookService.js';
import { deliverQueuedMessage, getConnectedSessionIds, isSessionConnected } from './sessionManager.js';

export const queueRunner = createQueueRunner({
  queue: outboundQueue,
  getReadySessionIds: getConnectedSessionIds,
  sendItem: deliverQueuedMessage,
  sendIntervalMinMs: config.queue.sendIntervalMinMs,
  sendIntervalMaxMs: config.queue.sendIntervalMaxMs,
  pollMs: config.queue.pollMs,
  maxAttempts: config.queue.maxAttempts,
  retryDelayMs: config.queue.retryDelayMs,
  maxAgeMs: config.queue.maxAgeMs,
  // sent / failed / expired; delivered and read follow from WhatsApp receipts
  onResult: ({ id, sessionId, to, status, messageId = null, error = null }) => {
    sendWebhookEvent(sessionId, 'message.status', {
      messageId,
      queueId: Number(id),
      remoteJid: to,
      status,
      error,
      timestamp: new Date().toISOString()
    });
  },
  logger: logger.child({ module: 'queue' })
});

export function formatQueueItem(row) {
  return {
    queueId: Number(row.id),
    sessionId: row.session_id,
    to: row.target_jid,
    type: row.message_type,
    content: row.payload,
    status: row.status,
    scheduledAt: row.scheduled_at,
    attempts: row.attempts,
    messageId: row.message_id,
    error: row.last_error,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    sentAt: row.sent_at
  };
}

/**
 * Remote URLs are stored and downloaded at send time; uploads and base64 data URLs are stored as bytes.
 */
function prepareMedia(input, label) {
  if (Buffer.isBuffer(input)) {
    return { mediaData: input, url: null, contentType: null };
  }
  if (typeof input === 'string' && /^https?:\/\//i.test(input)) {
    assertSafeUrl(input, { allowPrivate: config.allowPrivateUrls, label: `${label} URL` });
    return { mediaData: null, url: input, contentType: null };
  }
  if (typeof input === 'string' && input.startsWith('data:')) {
    const commaIndex = input.indexOf(',');
    const meta = commaIndex === -1 ? '' : input.slice(5, commaIndex);
    if (!meta.endsWith(';base64')) {
      throw new AppError(400, `Invalid ${label}: data URLs must be base64 encoded.`);
    }
    return {
      mediaData: Buffer.from(input.slice(commaIndex + 1), 'base64'),
      url: null,
      contentType: meta.slice(0, -';base64'.length) || null
    };
  }
  throw new AppError(400, `Invalid ${label}: expected an http(s) URL, a base64 data URL, or a file upload.`);
}

/**
 * Validates and queues an outgoing message. With `wait` (and a connected session), resolves once it
 * was sent or failed, or after SEND_WAIT_TIMEOUT_MS while it is still queued.
 */
export async function submitMessage({
  sessionId,
  to,
  countryCode,
  type,
  content,
  media = null,
  delayMs,
  scheduleAt = null,
  idempotencyKey = null,
  connectOnly = true,
  wait = true
}) {
  const targetJid = normalizeTarget(to, countryCode ?? config.defaultCountryCode);
  const sessionRes = await query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]);
  if (!sessionRes.rowCount) {
    throw new AppError(404, `Session "${sessionId}" not found.`);
  }
  if (connectOnly && !scheduleAt && !isSessionConnected(sessionId)) {
    throw new AppError(409, `Session "${sessionId}" is not connected. Send with connectOnly=false to queue the message until it connects.`);
  }

  const payload = { ...content, ...(delayMs !== undefined ? { delayMs } : {}) };
  let mediaData = null;
  if (media) {
    const prepared = prepareMedia(media.input, type);
    if (prepared.mediaData && prepared.mediaData.length > config.mediaMaxBytes) {
      throw new AppError(413, `Media is larger than MEDIA_MAX_BYTES (${config.mediaMaxBytes} bytes).`);
    }
    mediaData = prepared.mediaData;
    if (prepared.url) payload.url = prepared.url;
    if (!payload.mimetype && prepared.contentType) payload.mimetype = prepared.contentType;
  }

  const { item, created } = await outboundQueue.enqueue({
    sessionId,
    idempotencyKey,
    targetJid,
    messageType: type,
    payload,
    mediaData,
    scheduledAt: scheduleAt
  });
  if (!created) {
    return { item, result: null, duplicate: true };
  }

  // Waiting only makes sense when the message can go out now
  const sendable = !scheduleAt && isSessionConnected(sessionId);
  const pending = wait && sendable ? queueRunner.waitFor(item.id, config.queue.sendWaitTimeoutMs) : null;
  queueRunner.wake();
  return { item, result: pending ? await pending : null, duplicate: false };
}

export async function getQueuedMessage(id) {
  const item = await outboundQueue.get(id);
  if (!item) throw new AppError(404, `Queued message ${id} not found.`);
  return item;
}

export function listQueuedMessages(filters) {
  return outboundQueue.list(filters);
}

export async function cancelQueuedMessage(id) {
  const item = await outboundQueue.cancel(id);
  if (!item) {
    const existing = await getQueuedMessage(id);
    throw new AppError(409, `Only queued messages can be cancelled (current status: ${existing.status}).`);
  }
  queueRunner.notify(id, { status: 'cancelled' });
  return item;
}

export async function rescheduleQueuedMessage(id, scheduleAt) {
  const item = await outboundQueue.reschedule(id, scheduleAt);
  if (!item) {
    const existing = await getQueuedMessage(id);
    throw new AppError(409, `Only queued messages can be rescheduled (current status: ${existing.status}).`);
  }
  queueRunner.wake();
  return item;
}
