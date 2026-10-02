import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  delay
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { query } from '../database/db.js';
import { usePostgresAuthState } from '../database/postgresAuthState.js';
import { extractMessageData, sendWebhookEvent } from './webhookService.js';
import { config } from '../config/index.js';

// Map of active in-memory session sockets
const activeSessions = new Map();

// Pino logger for Baileys (silent/error level to keep terminal clean)
const logger = pino({ level: 'error' });

/**
 * Format raw phone number into standard WhatsApp JID
 */
export function formatToJid(target) {
  if (!target) return '';
  let cleaned = String(target).replace(/[^0-9@.\-_a-zA-Z]/g, '');

  if (cleaned.endsWith('@s.whatsapp.net') || cleaned.endsWith('@g.us') || cleaned.endsWith('@broadcast')) {
    return cleaned;
  }

  // Remove leading + or 0 if international prefix is desired, or convert standard
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1);
  }
  return `${cleaned}@s.whatsapp.net`;
}

/**
 * Anti-ban simulation: sends typing indicator for a natural duration before sending actual message
 */
async function sendWithHumanSimulation(sock, jid, messageContent, customDelayMs = null) {
  try {
    // 1. Presence update - Typing / Recording
    const isAudio = messageContent.audio || messageContent.voice;
    await sock.sendPresenceUpdate(isAudio ? 'recording' : 'composing', jid);

    // 2. Calculate natural delay
    let delayTime = customDelayMs;
    if (!delayTime) {
      const textLen = (messageContent.text || messageContent.caption || '').length;
      const baseDelay = config.antiBan.minTypingDelayMs;
      const variableDelay = Math.min(textLen * 35, config.antiBan.maxTypingDelayMs - baseDelay);
      const randomJitter = Math.floor(Math.random() * 400);
      delayTime = baseDelay + Math.max(0, variableDelay) + randomJitter;
    }

    await delay(delayTime);

    // 3. Pause typing indicator
    await sock.sendPresenceUpdate('paused', jid);

    // 4. Send the actual payload
    const result = await sock.sendMessage(jid, messageContent);
    return result;
  } catch (error) {
    try {
      await sock.sendPresenceUpdate('paused', jid);
    } catch (_) {}
    throw error;
  }
}

/**
 * Creates or retrieves a WhatsApp Session Socket
 */
export async function initSession(sessionId, options = {}) {
  const { customName = '', webhookUrl = null, autoReconnect = true } = options;

  // If session is already connected, return existing instance
  if (activeSessions.has(sessionId)) {
    const existing = activeSessions.get(sessionId);
    if (existing.status === 'connected') {
      return {
        sessionId,
        status: existing.status,
        phoneNumber: existing.phoneNumber,
        qrCode: null,
        message: 'Session already active and connected'
      };
    }
  }

  // Initialize DB record for session
  await query(
    `INSERT INTO sessions (id, custom_name, webhook_url, status, updated_at)
     VALUES ($1, $2, $3, 'connecting', NOW())
     ON CONFLICT (id) DO UPDATE
     SET custom_name = COALESCE(EXCLUDED.custom_name, sessions.custom_name),
         webhook_url = COALESCE(EXCLUDED.webhook_url, sessions.webhook_url),
         status = 'connecting',
         updated_at = NOW()`,
    [sessionId, customName, webhookUrl]
  );

  const { version, isLatest } = await fetchLatestBaileysVersion();
  const { state, saveCreds, clearState } = await usePostgresAuthState(sessionId);

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    generateHighQualityLinkPreview: true,
    browser: ['WhatsApp Gateway', 'Chrome', '120.0.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: true
  });

  const sessionData = {
    sessionId,
    sock,
    status: 'connecting',
    qrCode: null,
    qrRaw: null,
    pairingCode: null,
    phoneNumber: state.creds.me?.id?.split(':')[0] || null,
    customName,
    webhookUrl,
    saveCreds,
    clearState
  };

  activeSessions.set(sessionId, sessionData);

  // Credentials updated listener
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    if (sock.user && sock.user.id) {
      const phone = sock.user.id.split(':')[0].split('@')[0];
      sessionData.phoneNumber = phone;
      await query(
        `UPDATE sessions SET phone_number = $1, updated_at = NOW() WHERE id = $2`,
        [phone, sessionId]
      );
    }
  });

  // Connection update listener
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrBase64 = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
        sessionData.qrCode = qrBase64;
        sessionData.qrRaw = qr;
        sessionData.status = 'qr_ready';

        await query(
          `UPDATE sessions SET qr_code = $1, status = 'qr_ready', updated_at = NOW() WHERE id = $2`,
          [qrBase64, sessionId]
        );

        sendWebhookEvent(sessionId, 'connection.update', {
          status: 'qr_ready',
          qrRaw: qr,
          qrCode: qrBase64
        });
      } catch (err) {
        console.error(`[Session ${sessionId}] Failed to generate QR code:`, err.message);
      }
    }

    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
      sessionData.status = 'connected';
      sessionData.qrCode = null;
      sessionData.qrRaw = null;
      sessionData.phoneNumber = phone;

      await query(
        `UPDATE sessions SET status = 'connected', qr_code = NULL, phone_number = $1, updated_at = NOW() WHERE id = $2`,
        [phone, sessionId]
      );

      console.log(`[Session ${sessionId}] Connected successfully! Phone: ${phone}`);

      sendWebhookEvent(sessionId, 'connection.update', {
        status: 'connected',
        phoneNumber: phone,
        user: sock.user
      });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && autoReconnect;

      sessionData.status = 'disconnected';
      sessionData.qrCode = null;

      await query(
        `UPDATE sessions SET status = 'disconnected', qr_code = NULL, updated_at = NOW() WHERE id = $1`,
        [sessionId]
      );

      console.warn(`[Session ${sessionId}] Connection closed (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

      sendWebhookEvent(sessionId, 'connection.update', {
        status: 'disconnected',
        statusCode,
        reason: lastDisconnect?.error?.message || 'Connection closed'
      });

      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`[Session ${sessionId}] Logged out. Clearing session auth keys.`);
        await clearState();
        activeSessions.delete(sessionId);
      } else if (shouldReconnect) {
        console.log(`[Session ${sessionId}] Reconnecting in 3 seconds...`);
        setTimeout(() => {
          initSession(sessionId, { customName, webhookUrl, autoReconnect });
        }, 3000);
      }
    }
  });

  // Incoming messages listener
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

        const remoteJid = msg.key.remoteJid;
        const fromMe = Boolean(msg.key.fromMe);
        const messageId = msg.key.id;
        const pushName = msg.pushName || '';
        const senderJid = msg.key.participant || remoteJid;

        // Extract and normalize message type and content
        const parsed = extractMessageData(msg);

        // Auto mark as read if configured and not from me
        if (!fromMe && config.antiBan.autoReadMessages) {
          try {
            await sock.readMessages([msg.key]);
          } catch (_) {}
        }

        // Store message in PostgreSQL
        await query(
          `INSERT INTO messages (session_id, message_id, remote_jid, sender_jid, from_me, push_name, message_type, content, raw_payload, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           ON CONFLICT (session_id, message_id) DO UPDATE
           SET status = EXCLUDED.status, updated_at = NOW()`,
          [
            sessionId,
            messageId,
            remoteJid,
            senderJid,
            fromMe,
            pushName,
            parsed.messageType,
            parsed.content,
            JSON.stringify(msg),
            fromMe ? 'sent' : 'received'
          ]
        );

        // Add direct download endpoint URL if message has media
        if (parsed.media) {
          parsed.media.downloadUrl = `/api/messages/${sessionId}/download/${messageId}`;
        }

        // Trigger Webhook Event with rich structured payload
        const webhookPayload = {
          messageId,
          remoteJid,
          senderJid,
          fromMe,
          pushName,
          isGroup: remoteJid.endsWith('@g.us'),
          messageType: parsed.messageType,
          rawType: parsed.rawType,
          content: parsed.content,
          media: parsed.media,
          contextInfo: parsed.contextInfo,
          timestamp: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : new Date().toISOString()
        };

        sendWebhookEvent(sessionId, 'message.received', webhookPayload, webhookUrl);
      } catch (err) {
        console.error(`[Session ${sessionId}] Error processing message:`, err);
      }
    }
  });

  return {
    sessionId,
    status: sessionData.status,
    phoneNumber: sessionData.phoneNumber
  };
}

/**
 * Requests an 8-digit WhatsApp pairing code (pair without scanning QR)
 */
export async function requestPairingCode(sessionId, phoneNumber) {
  let session = activeSessions.get(sessionId);
  if (!session || session.status === 'disconnected') {
    await initSession(sessionId);
    session = activeSessions.get(sessionId);
  }

  if (session.status === 'connected') {
    throw new Error('Device is already connected.');
  }

  // Clean phone number (numeric only, standard country code e.g. 628123456789)
  const cleanPhone = String(phoneNumber).replace(/[^0-9]/g, '');
  if (!cleanPhone) {
    throw new Error('Invalid phone number provided for pairing code.');
  }

  const code = await session.sock.requestPairingCode(cleanPhone);
  session.pairingCode = code;
  return code;
}

/**
 * Send WhatsApp Text Message with simulated anti-ban typing presence
 */
export async function sendTextMessage(sessionId, to, text, options = {}) {
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== 'connected') {
    throw new Error(`Session "${sessionId}" is not connected.`);
  }

  const jid = formatToJid(to);
  const result = await sendWithHumanSimulation(
    session.sock,
    jid,
    { text },
    options.delayMs
  );

  // Save to PostgreSQL
  if (result?.key?.id) {
    await query(
      `INSERT INTO messages (session_id, message_id, remote_jid, sender_jid, from_me, message_type, content, status, raw_payload)
       VALUES ($1, $2, $3, $4, true, 'text', $5, 'sent', $6::jsonb)
       ON CONFLICT (session_id, message_id) DO NOTHING`,
      [sessionId, result.key.id, jid, session.sock.user?.id || '', text, JSON.stringify(result)]
    );
  }

  return {
    success: true,
    messageId: result.key.id,
    remoteJid: jid,
    status: 'sent'
  };
}

/**
 * Send WhatsApp Image Message with simulated anti-ban typing presence
 */
export async function sendImageMessage(sessionId, to, imageInput, caption = '', options = {}) {
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== 'connected') {
    throw new Error(`Session "${sessionId}" is not connected.`);
  }

  const jid = formatToJid(to);
  let imagePayload;

  if (Buffer.isBuffer(imageInput)) {
    imagePayload = { image: imageInput, caption };
  } else if (typeof imageInput === 'string' && (imageInput.startsWith('http://') || imageInput.startsWith('https://'))) {
    imagePayload = { image: { url: imageInput }, caption };
  } else if (typeof imageInput === 'string' && imageInput.startsWith('data:image')) {
    const base64Data = imageInput.split(',')[1];
    imagePayload = { image: Buffer.from(base64Data, 'base64'), caption };
  } else {
    throw new Error('Invalid image input: expected URL, Base64 data URL, or Buffer.');
  }

  const result = await sendWithHumanSimulation(
    session.sock,
    jid,
    imagePayload,
    options.delayMs
  );

  if (result?.key?.id) {
    await query(
      `INSERT INTO messages (session_id, message_id, remote_jid, sender_jid, from_me, message_type, content, media_url, status, raw_payload)
       VALUES ($1, $2, $3, $4, true, 'image', $5, $6, 'sent', $7::jsonb)
       ON CONFLICT (session_id, message_id) DO NOTHING`,
      [
        sessionId,
        result.key.id,
        jid,
        session.sock.user?.id || '',
        caption,
        typeof imageInput === 'string' ? imageInput : null,
        JSON.stringify(result)
      ]
    );
  }

  return {
    success: true,
    messageId: result.key.id,
    remoteJid: jid,
    status: 'sent'
  };
}

/**
 * Send WhatsApp Attachment / Document with simulated anti-ban typing presence
 */
export async function sendAttachmentMessage(sessionId, to, docInput, fileName = 'file', mimetype = 'application/octet-stream', caption = '', options = {}) {
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== 'connected') {
    throw new Error(`Session "${sessionId}" is not connected.`);
  }

  const jid = formatToJid(to);
  let docPayload;

  if (Buffer.isBuffer(docInput)) {
    docPayload = { document: docInput, fileName, mimetype, caption };
  } else if (typeof docInput === 'string' && (docInput.startsWith('http://') || docInput.startsWith('https://'))) {
    docPayload = { document: { url: docInput }, fileName, mimetype, caption };
  } else if (typeof docInput === 'string' && docInput.startsWith('data:')) {
    const base64Data = docInput.split(',')[1];
    docPayload = { document: Buffer.from(base64Data, 'base64'), fileName, mimetype, caption };
  } else {
    throw new Error('Invalid attachment input: expected URL, Base64 data, or Buffer.');
  }

  const result = await sendWithHumanSimulation(
    session.sock,
    jid,
    docPayload,
    options.delayMs
  );

  if (result?.key?.id) {
    await query(
      `INSERT INTO messages (session_id, message_id, remote_jid, sender_jid, from_me, message_type, content, media_url, status, raw_payload)
       VALUES ($1, $2, $3, $4, true, 'document', $5, $6, 'sent', $7::jsonb)
       ON CONFLICT (session_id, message_id) DO NOTHING`,
      [
        sessionId,
        result.key.id,
        jid,
        session.sock.user?.id || '',
        caption || fileName,
        typeof docInput === 'string' ? docInput : null,
        JSON.stringify(result)
      ]
    );
  }

  return {
    success: true,
    messageId: result.key.id,
    remoteJid: jid,
    fileName,
    status: 'sent'
  };
}

/**
 * Retrieves session status and QR details
 */
export async function getSessionStatus(sessionId) {
  const memorySession = activeSessions.get(sessionId);
  const dbRes = await query(`SELECT * FROM sessions WHERE id = $1`, [sessionId]);

  if (dbRes.rows.length === 0) {
    return { exists: false, status: 'not_found' };
  }

  const row = dbRes.rows[0];
  return {
    exists: true,
    sessionId: row.id,
    customName: row.custom_name,
    status: memorySession ? memorySession.status : row.status,
    phoneNumber: memorySession ? memorySession.phoneNumber : row.phone_number,
    qrCode: memorySession ? memorySession.qrCode : row.qr_code,
    pairingCode: memorySession ? memorySession.pairingCode : null,
    webhookUrl: row.webhook_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Returns all saved sessions
 */
export async function getAllSessions() {
  const res = await query(`SELECT id, phone_number, status, webhook_url, custom_name, created_at, updated_at FROM sessions ORDER BY created_at ASC`);
  return res.rows.map((row) => {
    const mem = activeSessions.get(row.id);
    return {
      ...row,
      status: mem ? mem.status : row.status,
      phoneNumber: mem ? mem.phoneNumber : row.phone_number
    };
  });
}

/**
 * Logs out and clears a session
 */
export async function logoutSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session && session.sock) {
    try {
      await session.sock.logout();
    } catch (_) {}
  }
  const { clearState } = await usePostgresAuthState(sessionId);
  await clearState();
  await query(`UPDATE sessions SET status = 'disconnected', qr_code = NULL, phone_number = NULL, updated_at = NOW() WHERE id = $1`, [sessionId]);
  activeSessions.delete(sessionId);
  return { success: true, message: `Session ${sessionId} logged out.` };
}

/**
 * Deletes a session completely from DB
 */
export async function deleteSession(sessionId) {
  await logoutSession(sessionId).catch(() => {});
  await query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  return { success: true, message: `Session ${sessionId} deleted.` };
}

/**
 * Auto-restore active sessions on system startup
 */
export async function restoreSessions() {
  try {
    const res = await query(`SELECT id, custom_name, webhook_url, status FROM sessions WHERE status IN ('connected', 'connecting', 'qr_ready')`);
    console.log(`[Restore] Found ${res.rows.length} existing sessions to restore.`);
    for (const row of res.rows) {
      console.log(`[Restore] Restoring session: ${row.id}`);
      initSession(row.id, {
        customName: row.custom_name,
        webhookUrl: row.webhook_url,
        autoReconnect: true
      }).catch((err) => {
        console.error(`[Restore] Failed to restore session ${row.id}:`, err.message);
      });
    }
  } catch (error) {
    console.error('[Restore] Error restoring sessions from database:', error.message);
  }
}

/**
 * Decrypts and downloads binary media (image, video, document, audio, etc.) by messageId
 */
export async function downloadMediaByMessageId(sessionId, messageId) {
  const dbRes = await query(
    `SELECT raw_payload, message_type FROM messages WHERE session_id = $1 AND message_id = $2`,
    [sessionId, messageId]
  );

  if (dbRes.rows.length === 0 || !dbRes.rows[0].raw_payload) {
    throw new Error(`Message "${messageId}" not found in session "${sessionId}" or has no raw payload.`);
  }

  const raw = dbRes.rows[0].raw_payload;
  const session = activeSessions.get(sessionId);

  try {
    const buffer = await downloadMediaMessage(
      raw,
      'buffer',
      {},
      {
        logger,
        reuploadRequest: session?.sock?.updateMediaMessage
      }
    );

    // Extract filename and mimetype if available
    let message = raw.message;
    if (message.ephemeralMessage) message = message.ephemeralMessage.message;
    if (message.viewOnceMessage) message = message.viewOnceMessage.message;
    if (message.viewOnceMessageV2) message = message.viewOnceMessageV2.message;
    if (message.documentWithCaptionMessage) message = message.documentWithCaptionMessage.message;

    const msgType = Object.keys(message)[0];
    const mediaObj = message[msgType];

    const mimetype = mediaObj?.mimetype || 'application/octet-stream';
    const fileName = mediaObj?.fileName || `media_${messageId}.${mimetype.split('/')[1]?.split(';')[0] || 'bin'}`;

    return {
      buffer,
      mimetype,
      fileName,
      fileLength: buffer.length
    };
  } catch (error) {
    console.error(`[DownloadMedia] Error downloading media for message ${messageId}:`, error);
    throw new Error(`Failed to decrypt and download media: ${error.message}`);
  }
}

