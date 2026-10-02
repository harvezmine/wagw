import axios from 'axios';
import { query } from '../database/db.js';
import { config } from '../config/index.js';
import { createWebhookUrlResolver } from './webhookUrlResolver.js';
import { assertSafeUrl, safeRequestOptions } from '../utils/netGuard.js';

const webhookUrlResolver = createWebhookUrlResolver({ query, globalWebhookUrl: config.globalWebhookUrl });

/**
 * Drops the cached webhook URL of a session after it was changed.
 */
export function invalidateWebhookUrl(sessionId) {
  webhookUrlResolver.invalidate(sessionId);
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
        fileLength: message.imageMessage.fileLength,
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
        fileLength: message.videoMessage.fileLength,
        seconds: message.videoMessage.seconds,
        gifPlayback: message.videoMessage.gifPlayback
      };
      break;

    case 'audioMessage':
      normalizedType = message.audioMessage.ptt ? 'voice' : 'audio';
      media = {
        mimetype: message.audioMessage.mimetype,
        fileLength: message.audioMessage.fileLength,
        seconds: message.audioMessage.seconds,
        ptt: message.audioMessage.ptt
      };
      break;

    case 'documentMessage':
      normalizedType = 'document';
      content = message.documentMessage.caption || '';
      media = {
        fileName: message.documentMessage.fileName || 'attachment',
        mimetype: message.documentMessage.mimetype,
        fileLength: message.documentMessage.fileLength,
        pageCount: message.documentMessage.pageCount
      };
      break;

    case 'stickerMessage':
      normalizedType = 'sticker';
      media = {
        mimetype: message.stickerMessage.mimetype,
        fileLength: message.stickerMessage.fileLength,
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
 * Dispatches webhook event to the session's webhook URL (or the global one). Never throws.
 */
export async function sendWebhookEvent(sessionId, eventType, payload) {
  let targetUrl;
  try {
    targetUrl = await webhookUrlResolver.resolve(sessionId);
  } catch (err) {
    console.error(`[Webhook] Failed to resolve webhook URL for ${sessionId}:`, err.message);
    targetUrl = config.globalWebhookUrl || null;
  }

  if (!targetUrl) {
    return; // No webhook configured
  }

  const body = {
    event: eventType,
    sessionId,
    timestamp: new Date().toISOString(),
    data: payload
  };

  try {
    assertSafeUrl(targetUrl, { allowPrivate: config.allowPrivateUrls, label: 'Webhook URL' });
    const response = await axios.post(targetUrl, body, {
      timeout: 10000,
      maxRedirects: 0,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'WhatsApp-Gateway-Webhook/1.0'
      },
      ...safeRequestOptions({ allowPrivate: config.allowPrivateUrls })
    });

    await query(
      `INSERT INTO webhook_logs (session_id, message_id, event_type, webhook_url, payload, status_code, response_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sessionId,
        payload?.messageId || null,
        eventType,
        targetUrl,
        JSON.stringify(body),
        response.status,
        typeof response.data === 'object' ? JSON.stringify(response.data).slice(0, 1000) : String(response.data).slice(0, 1000)
      ]
    );
  } catch (error) {
    const statusCode = error.response ? error.response.status : null;
    const responseBody = error.response ? JSON.stringify(error.response.data).slice(0, 1000) : null;
    const errorMessage = error.message;

    console.warn(`[Webhook] Failed to deliver webhook to ${targetUrl}:`, errorMessage);

    try {
      await query(
        `INSERT INTO webhook_logs (session_id, message_id, event_type, webhook_url, payload, status_code, response_body, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          sessionId,
          payload?.messageId || null,
          eventType,
          targetUrl,
          JSON.stringify(body),
          statusCode,
          responseBody,
          errorMessage
        ]
      );
    } catch (logErr) {
      console.error('[Webhook] Failed to log webhook error:', logErr.message);
    }
  }
}
