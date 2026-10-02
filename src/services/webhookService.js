import { toNumber } from '@whiskeysockets/baileys';
import { query } from '../database/db.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { createWebhookConfigResolver } from './webhookConfigResolver.js';
import { webhookOutbox } from './webhookOutbox.js';
import { createWebhookDispatcher, createWebhookPoster } from './webhookDispatcher.js';
import { toFonnteWebhook } from '../fonnte/fonnteWebhook.js';

export const WEBHOOK_FORMATS = ['default', 'fonnte'];
export const WEBHOOK_EVENTS = ['connection.update', 'message.received', 'message.status', 'account.restriction', 'call.received'];

const log = logger.child({ module: 'webhook' });

const webhookConfigResolver = createWebhookConfigResolver({
  query,
  globalWebhookUrl: config.globalWebhookUrl,
  globalSecret: config.webhook.secret
});

export const webhookDispatcher = createWebhookDispatcher({
  outbox: webhookOutbox,
  resolveTarget: (sessionId) => webhookConfigResolver.resolve(sessionId),
  post: createWebhookPoster({ allowPrivate: config.allowPrivateUrls }),
  maxAttempts: config.webhook.maxAttempts,
  retryBaseDelayMs: config.webhook.retryBaseDelayMs,
  retryMaxDelayMs: config.webhook.retryMaxDelayMs,
  timeoutMs: config.webhook.timeoutMs,
  retention: { deliveredDays: config.webhook.retentionDays, failedDays: config.webhook.failedRetentionDays },
  logger: log
});

/**
 * Drops the cached webhook settings of a session after they changed.
 */
export function invalidateWebhookConfig(sessionId) {
  webhookConfigResolver.invalidate(sessionId);
}

/**
 * Parses a Baileys WAMessage into a standardized format with message type classification
 */
export function extractMessageData(msg) {
  if (!msg.message) {
    return {
      messageType: 'unknown',
      content: '',
      media: null,
      isViewOnce: false
    };
  }

  let message = msg.message;

  // Handle ephemeral or view once wrappers
  if (message.ephemeralMessage) {
    message = message.ephemeralMessage.message;
  }
  if (message.viewOnceMessage) {
    message = message.viewOnceMessage.message;
  }
  if (message.viewOnceMessageV2) {
    message = message.viewOnceMessageV2.message;
  }
  if (message.documentWithCaptionMessage) {
    message = message.documentWithCaptionMessage.message;
  }

  const messageType = Object.keys(message)[0];
  let normalizedType = 'unknown';
  let content = '';
  let media = null;

  switch (messageType) {
    case 'conversation':
      normalizedType = 'text';
      content = message.conversation;
      break;

    case 'extendedTextMessage':
      normalizedType = 'text';
      content = message.extendedTextMessage.text || '';
      break;

    case 'imageMessage':
      normalizedType = 'image';
      content = message.imageMessage.caption || '';
      media = {
        mimetype: message.imageMessage.mimetype,
        fileLength: toNumber(message.imageMessage.fileLength),
        url: message.imageMessage.url,
        height: message.imageMessage.height,
        width: message.imageMessage.width
      };
      break;

    case 'videoMessage':
      normalizedType = 'video';
      content = message.videoMessage.caption || '';
      media = {
        mimetype: message.videoMessage.mimetype,
        fileLength: toNumber(message.videoMessage.fileLength),
        seconds: toNumber(message.videoMessage.seconds),
        gifPlayback: message.videoMessage.gifPlayback
      };
      break;

    case 'audioMessage':
      normalizedType = message.audioMessage.ptt ? 'voice' : 'audio';
      media = {
        mimetype: message.audioMessage.mimetype,
        fileLength: toNumber(message.audioMessage.fileLength),
        seconds: toNumber(message.audioMessage.seconds),
        ptt: message.audioMessage.ptt
      };
      break;

    case 'documentMessage':
      normalizedType = 'document';
      content = message.documentMessage.caption || '';
      media = {
        fileName: message.documentMessage.fileName || 'attachment',
        mimetype: message.documentMessage.mimetype,
        fileLength: toNumber(message.documentMessage.fileLength),
        pageCount: toNumber(message.documentMessage.pageCount)
      };
      break;

    case 'stickerMessage':
      normalizedType = 'sticker';
      media = {
        mimetype: message.stickerMessage.mimetype,
        fileLength: toNumber(message.stickerMessage.fileLength),
        isAnimated: message.stickerMessage.isAnimated
      };
      break;

    case 'locationMessage':
    case 'liveLocationMessage':
      normalizedType = 'location';
      const loc = message[messageType];
      content = loc.name || loc.address || '';
      media = {
        degreesLatitude: loc.degreesLatitude,
        degreesLongitude: loc.degreesLongitude
      };
      break;

    case 'contactMessage':
      normalizedType = 'contact';
      content = message.contactMessage.displayName || '';
      media = {
        vcard: message.contactMessage.vcard
      };
      break;

    case 'contactsArrayMessage':
      normalizedType = 'contacts';
      media = {
        contacts: message.contactsArrayMessage.contacts
      };
      break;

    case 'reactionMessage':
      normalizedType = 'reaction';
      content = message.reactionMessage.text || '';
      break;

    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      normalizedType = 'poll';
      const poll = message[messageType];
      content = poll.name || '';
      media = {
        options: poll.options?.map((o) => o.optionName) || []
      };
      break;

    case 'protocolMessage':
      normalizedType = 'protocol';
      break;

    default:
      normalizedType = messageType || 'unknown';
      content = JSON.stringify(message);
      break;
  }

  return {
    rawType: messageType,
    messageType: normalizedType,
    content,
    media,
    contextInfo: message[messageType]?.contextInfo || null
  };
}

/**
 * Stores a webhook event in the outbox; the dispatcher delivers it with retries. Never throws.
 */
export async function sendWebhookEvent(sessionId, eventType, payload) {
  try {
    const target = await webhookConfigResolver.resolve(sessionId);
    if (!target.url || (target.events && !target.events.includes(eventType))) {
      return;
    }
    const body = target.format === 'fonnte'
      ? toFonnteWebhook(eventType, payload, { device: target.phone })
      : { event: eventType, sessionId, timestamp: new Date().toISOString(), data: payload };
    if (!body) return;
    await webhookOutbox.enqueue({ sessionId, eventType, payload: body });
    webhookDispatcher.wake();
  } catch (error) {
    log.error({ sessionId, event: eventType, err: error }, 'Failed to queue webhook event');
  }
}
