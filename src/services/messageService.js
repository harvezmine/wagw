import { config } from '../config/index.js';
import { query } from '../database/db.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';
import { normalizeTarget } from '../utils/phone.js';
import { assertSafeUrl } from '../utils/netGuard.js';
import { outboundQueue } from './outboundQueue.js';
import { createQueueRunner } from './queueRunner.js';
import { parseTargets, renderTemplate } from './bulkTargets.js';
import { KEY_TYPES } from './messageContent.js';
import { sendWebhookEvent } from './webhookService.js';
import { createSendGate } from './sendGate.js';
import { guardStore } from './guardStore.js';
import { consentBlockReason } from './consent.js';
import { isRegistered } from './numberService.js';
import { parseTimeWindow } from '../utils/timeWindow.js';
import {
  deliverQueuedMessage,
  getConnectedSessionIds,
  getSessionSettings,
  getSessionState,
  isSessionConnected
} from './sessionManager.js';

const log = logger.child({ module: 'queue' });

export const sendGate = createSendGate({
  store: guardStore,
  getSessionState,
  // Unknown (lookup failed) never blocks a send
  checkRegistered: (sessionId, jid) =>
    isRegistered(sessionId, jid).catch((error) => {
      log.warn({ sessionId, err: error.message }, 'Number lookup for a new chat failed');
      return null;
    }),
  rules: {
    ...config.guard,
    // Parsed on use: validateConfig reports a malformed CAMPAIGN_HOURS at startup
    get campaignWindow() {
      return parseTimeWindow(config.guard.campaignHours);
    }
  }
});

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
  gate: sendGate,
  // sent / failed / expired / skipped; delivered and read follow from WhatsApp receipts
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
  logger: log
});

export function formatQueueItem(row) {
  return {
    queueId: Number(row.id),
    sessionId: row.session_id,
    to: row.target_jid,
    type: row.message_type,
    category: row.category,
    content: row.payload,
    status: row.status,
    scheduledAt: row.scheduled_at,
    deferredUntil: row.deferred_until ?? null,
    newContact: row.new_contact ?? null,
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

async function assertSessionExists(sessionId) {
  const res = await query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]);
  if (!res.rowCount) throw new AppError(404, `Session "${sessionId}" not found.`);
}

function assertCanQueue(sessionId, { connectOnly, scheduleAt }) {
  if (connectOnly && !scheduleAt && !isSessionConnected(sessionId)) {
    throw new AppError(409, `Session "${sessionId}" is not connected. Send with connectOnly=false to queue the message until it connects.`);
  }
}

/**
 * WhatsApp key of an earlier message of the session (target of reaction/edit/delete or replyTo).
 */
export async function resolveMessageKey(sessionId, messageId) {
  const res = await query(
    `SELECT remote_jid, from_me, sender_jid FROM messages WHERE session_id = $1 AND message_id = $2`,
    [sessionId, messageId]
  );
  const row = res.rows[0];
  if (!row) throw new AppError(404, `Message "${messageId}" not found in session "${sessionId}".`);
  const inGroup = row.remote_jid.endsWith('@g.us');
  return {
    remoteJid: row.remote_jid,
    fromMe: row.from_me,
    id: messageId,
    ...(inGroup && !row.from_me ? { participant: row.sender_jid } : {})
  };
}

/**
 * Shared preparation of a submission: mentions, reply, message key, media and typing delay.
 */
async function prepareSubmission({ sessionId, countryCode, type, payload, media, replyTo, mentions, delayMs }) {
  const code = countryCode ?? config.defaultCountryCode;
  const prepared = { payload: { ...payload }, mediaData: null, targetJid: null };
  if (delayMs !== undefined) prepared.payload.delayMs = delayMs;
  if (mentions?.length) prepared.payload.mentions = mentions.map((mention) => normalizeTarget(mention, code));
  if (replyTo) {
    await resolveMessageKey(sessionId, replyTo);
    prepared.payload.replyTo = replyTo;
  }
  if (KEY_TYPES.includes(type)) {
    const key = await resolveMessageKey(sessionId, payload.messageId);
    if (type === 'edit' && !key.fromMe) {
      throw new AppError(400, 'Only messages sent by this session can be edited.');
    }
    prepared.payload.key = key;
    prepared.targetJid = key.remoteJid;
  }
  if (media) {
    const preparedMedia = prepareMedia(media, type);
    if (preparedMedia.mediaData && preparedMedia.mediaData.length > config.mediaMaxBytes) {
      throw new AppError(413, `Media is larger than MEDIA_MAX_BYTES (${config.mediaMaxBytes} bytes).`);
    }
    prepared.mediaData = preparedMedia.mediaData;
    if (preparedMedia.url) prepared.payload.url = preparedMedia.url;
    if (!prepared.payload.mimetype && preparedMedia.contentType) prepared.payload.mimetype = preparedMedia.contentType;
  }
  return prepared;
}

const isPersonalJid = (jid) => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');

/**
 * Consent problems known before queueing (opt-outs, campaigns without consent): target JID -> reason.
 * The send gate checks again right before sending.
 */
async function consentBlocks(sessionId, targetJids, category) {
  const personal = targetJids.filter(isPersonalJid);
  if (!personal.length) return new Map();
  const [contacts, settings] = await Promise.all([guardStore.getContacts(sessionId, personal), getSessionSettings(sessionId)]);
  const requireConsent = settings.campaignConsentRequired ?? config.guard.campaignRequireConsent;
  const blocked = new Map();
  for (const jid of personal) {
    const reason = consentBlockReason({ category, isGroup: false, contact: contacts.get(jid), requireConsent });
    if (reason) blocked.set(jid, reason);
  }
  return blocked;
}

/**
 * Validates and queues one outgoing message. With `wait` (and a connected session), resolves once it
 * was sent or failed, or after SEND_WAIT_TIMEOUT_MS while it is still queued.
 */
export async function submitMessage({
  sessionId,
  to,
  countryCode,
  type,
  payload,
  media = null,
  replyTo = null,
  mentions = null,
  delayMs,
  scheduleAt = null,
  idempotencyKey = null,
  connectOnly = true,
  wait = true,
  category = 'transactional'
}) {
  const isKeyType = KEY_TYPES.includes(type);
  const targetJid = isKeyType ? null : normalizeTarget(to, countryCode ?? config.defaultCountryCode);
  await assertSessionExists(sessionId);
  assertCanQueue(sessionId, { connectOnly, scheduleAt });
  if (!isKeyType) {
    const reason = (await consentBlocks(sessionId, [targetJid], category)).get(targetJid);
    if (reason) throw new AppError(409, `Not sent: ${reason}.`, 'not_sent');
  }
  const prepared = await prepareSubmission({ sessionId, countryCode, type, payload, media, replyTo, mentions, delayMs });

  const { item, created } = await outboundQueue.enqueue({
    sessionId,
    idempotencyKey,
    targetJid: prepared.targetJid ?? targetJid,
    messageType: type,
    category,
    payload: prepared.payload,
    mediaData: prepared.mediaData,
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

/**
 * Queues one message per target. Text, captions and poll names are rendered per target from
 * {name}/{varN}. Invalid and duplicate targets are reported individually; nothing waits for delivery.
 */
export async function submitBatch({
  sessionId,
  to,
  countryCode,
  type,
  payload,
  media = null,
  mentions = null,
  delayMs,
  scheduleAt = null,
  idempotencyKey = null,
  connectOnly = true,
  category = 'campaign'
}) {
  if (KEY_TYPES.includes(type)) {
    throw new AppError(400, `${type} messages target one existing message and cannot be sent in bulk.`);
  }
  if (media && !(typeof media === 'string' && /^https?:\/\//i.test(media))) {
    throw new AppError(400, 'Bulk media must be given as media.url (uploads and base64 are only supported for a single target).');
  }
  const targets = parseTargets(to);
  if (!targets.length) throw new AppError(400, 'At least one target is required.');
  if (targets.length > config.bulk.maxTargets) {
    throw new AppError(400, `At most ${config.bulk.maxTargets} targets per request (BULK_MAX_TARGETS).`);
  }
  await assertSessionExists(sessionId);
  assertCanQueue(sessionId, { connectOnly, scheduleAt });
  const shared = await prepareSubmission({ sessionId, countryCode, type, payload, media, mentions, delayMs });

  const code = countryCode ?? config.defaultCountryCode;
  const jids = new Map();
  for (const target of targets) {
    try {
      jids.set(target, normalizeTarget(target.number, code));
    } catch (error) {
      jids.set(target, error);
    }
  }
  const blocked = await consentBlocks(sessionId, [...new Set([...jids.values()].filter((jid) => typeof jid === 'string'))], category);

  const seen = new Set();
  const results = [];
  for (const target of targets) {
    const targetJid = jids.get(target);
    if (targetJid instanceof Error) {
      results.push({ to: target.number, status: 'invalid', error: targetJid.message });
      continue;
    }
    if (seen.has(targetJid)) {
      results.push({ to: targetJid, status: 'skipped', error: 'Duplicate target in this request.' });
      continue;
    }
    seen.add(targetJid);
    if (blocked.has(targetJid)) {
      results.push({ to: targetJid, status: 'skipped', error: `Not sent: ${blocked.get(targetJid)}.` });
      continue;
    }

    const personalized = { ...shared.payload };
    for (const field of ['text', 'caption']) {
      if (personalized[field]) personalized[field] = renderTemplate(personalized[field], target);
    }
    if (type === 'poll') personalized.name = renderTemplate(personalized.name, target);

    const { item, created } = await outboundQueue.enqueue({
      sessionId,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:${targetJid}` : null,
      targetJid,
      messageType: type,
      category,
      payload: personalized,
      mediaData: null,
      scheduledAt: scheduleAt
    });
    results.push({ to: targetJid, status: created ? 'queued' : 'duplicate', queueId: Number(item.id) });
  }
  queueRunner.wake();
  return results;
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
