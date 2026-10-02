import makeWASocket, {
  Browsers,
  delay,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  proto
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { query } from '../database/db.js';
import { clearAuthState, usePostgresAuthState } from '../database/postgresAuthState.js';
import { extractMessageData, invalidateWebhookUrl, sendWebhookEvent } from './webhookService.js';
import { backoffDelay, decideReconnect } from './reconnectPolicy.js';
import { config } from '../config/index.js';
import { AppError } from '../utils/errors.js';
import { normalizePhoneNumber, normalizeTarget } from '../utils/phone.js';
import { createKeyedLock } from '../utils/keyedLock.js';
import { createTtlCache } from '../utils/ttlCache.js';
import { assertSafeUrl, fetchRemoteFile } from '../utils/netGuard.js';

// Map of active in-memory sessions (at most one socket per session)
const activeSessions = new Map();

// Start, restart and logout of one session run one at a time, so a session never owns two sockets
const sessionLocks = createKeyedLock();

// Per-session caches that outlive individual sockets. Baileys requires msgRetryCounterCache to live
// outside the socket to avoid decrypt/encrypt retry loops across restarts.
const msgRetryCaches = new Map();
const groupMetadataCaches = new Map();

const RUNNING_STATUSES = new Set(['connecting', 'qr_ready', 'connected']);
const PAIRING_READY_TIMEOUT_MS = 20000;

// Pino logger for Baileys (silent/error level to keep terminal clean)
const logger = pino({ level: 'error' });

function getSessionCache(caches, sessionId, ttlMs) {
  if (!caches.has(sessionId)) {
    caches.set(sessionId, createTtlCache({ ttlMs }));
  }
  return caches.get(sessionId);
}

function phoneFromJid(jid) {
  return jid ? jid.split('@')[0].split(':')[0] : null;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AppError(504, message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeSession(sessionData, message) {
  return {
    sessionId: sessionData.sessionId,
    status: sessionData.status,
    phoneNumber: sessionData.phoneNumber,
    message
  };
}

/**
 * Anti-ban simulation: sends typing indicator for a natural duration before sending actual message
 */
async function sendWithHumanSimulation(sock, jid, messageContent, customDelayMs = null) {
  try {
    // 1. Presence update - Typing / Recording
    const isAudio = messageContent.audio || messageContent.voice;
    await sock.sendPresenceUpdate(isAudio ? 'recording' : 'composing', jid);

    // 2. Calculate natural delay (an explicit delayMs, including 0, wins)
    let delayTime = customDelayMs;
    if (delayTime === null || delayTime === undefined) {
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
    return await sock.sendMessage(jid, messageContent);
  } catch (error) {
    try {
      await sock.sendPresenceUpdate('paused', jid);
    } catch (_) {}
    throw error;
  }
}

/**
 * Message lookup for Baileys retry requests and poll decryption (the `getMessage` socket option).
 */
async function loadStoredMessage(sessionId, key) {
  try {
    const res = await query(
      `SELECT raw_payload -> 'message' AS message FROM messages WHERE session_id = $1 AND message_id = $2`,
      [sessionId, key.id]
    );
    const message = res.rows[0]?.message;
    return message ? proto.Message.fromObject(message) : undefined;
  } catch (error) {
    console.error(`[Session ${sessionId}] getMessage lookup failed for ${key.id}:`, error.message);
    return undefined;
  }
}

/**
 * Closes a socket without triggering reconnect logic: its handlers ignore events once `stopped`.
 */
function teardownSocket(sessionData) {
  sessionData.stopped = true;
  clearTimeout(sessionData.reconnectTimer);
  sessionData.reconnectTimer = null;
  try {
    sessionData.sock.end(undefined);
  } catch (_) {}
}

function scheduleReconnect(sessionData, delayMs) {
  const { sessionId } = sessionData;
  sessionData.reconnectTimer = setTimeout(async () => {
    try {
      await initSession(sessionId, { isReconnect: true });
    } catch (error) {
      console.error(`[Session ${sessionId}] Reconnect attempt failed:`, error.message);
      // No new socket took over: keep retrying with backoff
      if (activeSessions.get(sessionId) === sessionData) {
        sessionData.reconnectAttempts += 1;
        scheduleReconnect(sessionData, backoffDelay(sessionData.reconnectAttempts, config.reconnect));
      }
    }
  }, delayMs);
}

async function handleQr(sessionData, qr) {
  const { sessionId } = sessionData;
  const qrCode = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
  Object.assign(sessionData, { qrCode, qrRaw: qr, status: 'qr_ready' });
  sessionData.resolveQrReady();

  await query(
    `UPDATE sessions SET qr_code = $1, status = 'qr_ready', updated_at = NOW() WHERE id = $2`,
    [qrCode, sessionId]
  );

  sendWebhookEvent(sessionId, 'connection.update', {
    status: 'qr_ready',
    qrRaw: qr,
    qrCode
  });
}

async function handleOpen(sessionData) {
  const { sessionId, sock } = sessionData;
  const phone = phoneFromJid(sock.user?.id);
  Object.assign(sessionData, {
    status: 'connected',
    qrCode: null,
    qrRaw: null,
    pairingCode: null,
    phoneNumber: phone,
    reconnectAttempts: 0
  });

  await query(
    `UPDATE sessions SET status = 'connected', qr_code = NULL, disconnect_reason = NULL, phone_number = $1, updated_at = NOW() WHERE id = $2`,
    [phone, sessionId]
  );

  console.log(`[Session ${sessionId}] Connected successfully! Phone: ${phone}`);

  sendWebhookEvent(sessionId, 'connection.update', {
    status: 'connected',
    phoneNumber: phone,
    user: sock.user
  });
}

async function handleClose(sessionData, lastDisconnect) {
  const { sessionId } = sessionData;
  const statusCode = lastDisconnect?.error?.output?.statusCode;
  const decision = decideReconnect({
    statusCode,
    attempt: sessionData.reconnectAttempts,
    registered: sessionData.isRegistered(),
    ...config.reconnect
  });
  const status = decision.action === 'reconnect' ? 'reconnecting' : 'disconnected';
  Object.assign(sessionData, { status, qrCode: null, qrRaw: null });

  console.warn(
    `[Session ${sessionId}] Connection closed (code: ${statusCode}) -> ${decision.action} (${decision.reason})` +
      (decision.action === 'reconnect' ? ` in ${decision.delayMs}ms` : '')
  );

  // Act before touching the database so a DB outage cannot block the reconnect
  if (decision.action === 'reconnect') {
    sessionData.reconnectAttempts += 1;
    scheduleReconnect(sessionData, decision.delayMs);
  } else {
    sessionData.stopped = true;
    activeSessions.delete(sessionId);
    if (decision.action === 'logout') {
      console.log(`[Session ${sessionId}] Logged out. Clearing session auth keys.`);
      await clearAuthState(sessionId);
    }
  }

  await query(
    `UPDATE sessions SET status = $1, disconnect_reason = $2, qr_code = NULL, updated_at = NOW() WHERE id = $3`,
    [status, decision.reason, sessionId]
  );

  sendWebhookEvent(sessionId, 'connection.update', {
    status,
    statusCode,
    reason: lastDisconnect?.error?.message || 'Connection closed',
    disconnectReason: decision.reason,
    retryInMs: decision.delayMs ?? null
  });
}

async function handleIncomingMessage(sessionData, msg) {
  const { sessionId, sock } = sessionData;
  if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

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
  sendWebhookEvent(sessionId, 'message.received', {
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
  });
}

/**
 * Creates or retrieves a WhatsApp Session Socket. Safe to call repeatedly: a session that already
 * has a running socket keeps it instead of opening a second one.
 */
export function initSession(sessionId, options = {}) {
  return sessionLocks.run(sessionId, () => startSession(sessionId, options));
}

async function startSession(sessionId, { customName = null, webhookUrl = null, isReconnect = false } = {}) {
  const existing = activeSessions.get(sessionId);
  if (existing && !existing.stopped && RUNNING_STATUSES.has(existing.status)) {
    return describeSession(existing, 'Session is already running.');
  }
  if (webhookUrl) {
    assertSafeUrl(webhookUrl, { allowPrivate: config.allowPrivateUrls, label: 'webhookUrl' });
  }

  const reconnectAttempts = isReconnect && existing ? existing.reconnectAttempts : 0;
  if (existing) {
    teardownSocket(existing);
  }

  // Initialize DB record for session (NULL keeps the stored name/webhook)
  await query(
    `INSERT INTO sessions (id, custom_name, webhook_url, status, disconnect_reason, updated_at)
     VALUES ($1, $2, $3, 'connecting', NULL, NOW())
     ON CONFLICT (id) DO UPDATE
     SET custom_name = COALESCE(EXCLUDED.custom_name, sessions.custom_name),
         webhook_url = COALESCE(EXCLUDED.webhook_url, sessions.webhook_url),
         status = 'connecting',
         disconnect_reason = NULL,
         updated_at = NOW()`,
    [sessionId, customName || null, webhookUrl || null]
  );
  if (webhookUrl) {
    invalidateWebhookUrl(sessionId);
  }

  const { state, saveCreds } = await usePostgresAuthState(sessionId);
  const groupCache = getSessionCache(groupMetadataCaches, sessionId, 5 * 60 * 1000);

  const sock = makeWASocket({
    // Use the WA Web version bundled with Baileys; WA_VERSION overrides it if WhatsApp rejects it (405)
    ...(config.waVersion ? { version: config.waVersion } : {}),
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    // A realistic browser is required for pairing codes and does not advertise automation
    browser: Browsers.macOS('Google Chrome'),
    // Keeps the phone receiving notifications
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    msgRetryCounterCache: getSessionCache(msgRetryCaches, sessionId, 60 * 60 * 1000),
    getMessage: (key) => loadStoredMessage(sessionId, key),
    // Without this every group send refetches participants (rate limits, potential bans)
    cachedGroupMetadata: async (jid) => {
      let metadata = groupCache.get(jid);
      if (!metadata) {
        metadata = await sock.groupMetadata(jid);
        groupCache.set(jid, metadata);
      }
      return metadata;
    }
  });

  let resolveQrReady;
  const sessionData = {
    sessionId,
    sock,
    status: 'connecting',
    qrCode: null,
    qrRaw: null,
    pairingCode: null,
    phoneNumber: phoneFromJid(state.creds.me?.id),
    reconnectAttempts,
    reconnectTimer: null,
    stopped: false,
    // Resolves on the first QR event, i.e. once the socket can accept a pairing-code request
    qrReady: new Promise((resolve) => {
      resolveQrReady = resolve;
    }),
    resolveQrReady: () => resolveQrReady(),
    isRegistered: () => Boolean(state.creds.account)
  };

  activeSessions.set(sessionId, sessionData);

  // Each handler is wrapped: an async error here would otherwise be an unhandled rejection that
  // kills the process and every session with it. Events from replaced sockets are ignored.
  const on = (event, handler) => {
    sock.ev.on(event, async (payload) => {
      if (sessionData.stopped || activeSessions.get(sessionId) !== sessionData) return;
      try {
        await handler(payload);
      } catch (error) {
        console.error(`[Session ${sessionId}] Error handling ${event}:`, error);
      }
    });
  };

  // Credentials updated listener
  on('creds.update', async () => {
    await saveCreds();
    const phone = phoneFromJid(sock.user?.id);
    if (phone && phone !== sessionData.phoneNumber) {
      sessionData.phoneNumber = phone;
      await query(`UPDATE sessions SET phone_number = $1, updated_at = NOW() WHERE id = $2`, [phone, sessionId]);
    }
  });

  // Connection update listener
  on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) await handleQr(sessionData, qr);
    if (connection === 'open') await handleOpen(sessionData);
    if (connection === 'close') await handleClose(sessionData, lastDisconnect);
  });

  // Incoming messages listener
  on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleIncomingMessage(sessionData, msg);
      } catch (err) {
        console.error(`[Session ${sessionId}] Error processing message:`, err);
      }
    }
  });

  // Group changes invalidate cached metadata; it is refetched lazily on the next group send
  on('groups.update', async (updates) => {
    for (const update of updates) groupCache.del(update.id);
  });
  on('group-participants.update', async ({ id }) => {
    groupCache.del(id);
  });

  return describeSession(sessionData, 'Session initialization triggered.');
}

/**
 * True when the session has a live socket (connecting, waiting for QR scan, or connected).
 */
export function isSessionRunning(sessionId) {
  const session = activeSessions.get(sessionId);
  return Boolean(session && !session.stopped && RUNNING_STATUSES.has(session.status));
}

/**
 * Requests an 8-digit WhatsApp pairing code (pair without scanning QR)
 */
export async function requestPairingCode(sessionId, phoneNumber, { countryCode } = {}) {
  const phone = normalizePhoneNumber(phoneNumber, countryCode ?? config.defaultCountryCode);

  let session = activeSessions.get(sessionId);
  if (!isSessionRunning(sessionId)) {
    await initSession(sessionId);
    session = activeSessions.get(sessionId);
  }
  if (!session) {
    throw new AppError(503, `Session "${sessionId}" failed to start.`);
  }
  if (session.status === 'connected' || session.isRegistered()) {
    throw new AppError(409, 'Device is already paired. Logout first to pair another number.');
  }

  // The socket accepts pairing requests only after the WhatsApp handshake (signalled by the first QR)
  await withTimeout(session.qrReady, PAIRING_READY_TIMEOUT_MS, 'Timed out waiting for WhatsApp to accept a pairing request.');

  const code = await session.sock.requestPairingCode(phone);
  session.pairingCode = code;
  return { code, phoneNumber: phone };
}

function getConnectedSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session || session.stopped || session.status !== 'connected') {
    throw new AppError(409, `Session "${sessionId}" is not connected.`);
  }
  return session;
}

/**
 * Turns a URL, base64 data URL or Buffer into a Buffer. Remote URLs are downloaded here (SSRF guard,
 * size cap, timeout) instead of letting Baileys fetch arbitrary URLs.
 */
async function resolveMediaInput(input, label) {
  if (Buffer.isBuffer(input)) {
    return { buffer: input, contentType: null, sourceUrl: null };
  }
  if (typeof input === 'string' && /^https?:\/\//i.test(input)) {
    const { buffer, contentType } = await fetchRemoteFile(input, {
      allowPrivate: config.allowPrivateUrls,
      maxBytes: config.mediaMaxBytes
    });
    return { buffer, contentType, sourceUrl: input };
  }
  if (typeof input === 'string' && input.startsWith('data:')) {
    const commaIndex = input.indexOf(',');
    const meta = commaIndex === -1 ? '' : input.slice(5, commaIndex);
    if (!meta.endsWith(';base64')) {
      throw new AppError(400, `Invalid ${label}: data URLs must be base64 encoded.`);
    }
    return {
      buffer: Buffer.from(input.slice(commaIndex + 1), 'base64'),
      contentType: meta.slice(0, -';base64'.length) || null,
      sourceUrl: null
    };
  }
  throw new AppError(400, `Invalid ${label}: expected an http(s) URL, a base64 data URL, or a file upload.`);
}

async function saveOutgoingMessage(session, jid, result, { messageType, content, mediaUrl = null }) {
  if (!result?.key?.id) return;
  try {
    await query(
      `INSERT INTO messages (session_id, message_id, remote_jid, sender_jid, from_me, message_type, content, media_url, status, raw_payload)
       VALUES ($1, $2, $3, $4, true, $5, $6, $7, 'sent', $8::jsonb)
       ON CONFLICT (session_id, message_id) DO NOTHING`,
      [session.sessionId, result.key.id, jid, session.sock.user?.id || '', messageType, content, mediaUrl, JSON.stringify(result)]
    );
  } catch (error) {
    // Already sent: report success rather than inviting the client to retry and send a duplicate
    console.error(`[Session ${session.sessionId}] Failed to store sent message ${result.key.id}:`, error.message);
  }
}

/**
 * Send WhatsApp Text Message with simulated anti-ban typing presence
 */
export async function sendTextMessage(sessionId, to, text, options = {}) {
  const jid = normalizeTarget(to, options.countryCode ?? config.defaultCountryCode);
  const session = getConnectedSession(sessionId);

  const result = await sendWithHumanSimulation(session.sock, jid, { text }, options.delayMs);
  await saveOutgoingMessage(session, jid, result, { messageType: 'text', content: text });

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
  const jid = normalizeTarget(to, options.countryCode ?? config.defaultCountryCode);
  const session = getConnectedSession(sessionId);
  const media = await resolveMediaInput(imageInput, 'image');

  const result = await sendWithHumanSimulation(session.sock, jid, { image: media.buffer, caption }, options.delayMs);
  await saveOutgoingMessage(session, jid, result, { messageType: 'image', content: caption, mediaUrl: media.sourceUrl });

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
export async function sendAttachmentMessage(sessionId, to, docInput, fileName = 'file', mimetype = null, caption = '', options = {}) {
  const jid = normalizeTarget(to, options.countryCode ?? config.defaultCountryCode);
  const session = getConnectedSession(sessionId);
  const media = await resolveMediaInput(docInput, 'attachment');
  const resolvedMimetype = mimetype || media.contentType || 'application/octet-stream';

  const result = await sendWithHumanSimulation(
    session.sock,
    jid,
    { document: media.buffer, fileName, mimetype: resolvedMimetype, caption },
    options.delayMs
  );
  await saveOutgoingMessage(session, jid, result, {
    messageType: 'document',
    content: caption || fileName,
    mediaUrl: media.sourceUrl
  });

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
    disconnectReason: row.disconnect_reason,
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
  const res = await query(
    `SELECT id, phone_number, status, disconnect_reason, webhook_url, custom_name, created_at, updated_at FROM sessions ORDER BY created_at ASC`
  );
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
 * Updates (or clears, with an empty value) the webhook URL of a session. Takes effect immediately.
 */
export async function setSessionWebhookUrl(sessionId, webhookUrl) {
  const url = webhookUrl ? String(webhookUrl).trim() : null;
  if (url) {
    assertSafeUrl(url, { allowPrivate: config.allowPrivateUrls, label: 'webhookUrl' });
  }
  const res = await query(`UPDATE sessions SET webhook_url = $1, updated_at = NOW() WHERE id = $2`, [url, sessionId]);
  if (res.rowCount === 0) {
    throw new AppError(404, `Session "${sessionId}" not found.`);
  }
  invalidateWebhookUrl(sessionId);
  return url;
}

/**
 * Logs out and clears a session
 */
export function logoutSession(sessionId) {
  return sessionLocks.run(sessionId, async () => {
    const session = activeSessions.get(sessionId);
    if (session) {
      // Mark first so the close event triggered by logout() is not treated as a disconnect
      session.stopped = true;
      clearTimeout(session.reconnectTimer);
      try {
        await session.sock.logout();
      } catch (_) {}
      teardownSocket(session);
      activeSessions.delete(sessionId);
    }
    await clearAuthState(sessionId);
    msgRetryCaches.delete(sessionId);
    groupMetadataCaches.delete(sessionId);
    await query(
      `UPDATE sessions SET status = 'disconnected', disconnect_reason = 'logged_out', qr_code = NULL, phone_number = NULL, updated_at = NOW() WHERE id = $1`,
      [sessionId]
    );
    return { success: true, message: `Session ${sessionId} logged out.` };
  });
}

/**
 * Deletes a session completely from DB
 */
export async function deleteSession(sessionId) {
  await logoutSession(sessionId);
  await query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  invalidateWebhookUrl(sessionId);
  return { success: true, message: `Session ${sessionId} deleted.` };
}

/**
 * Auto-restore paired sessions on system startup, one at a time to avoid a connection burst
 */
export async function restoreSessions() {
  try {
    const res = await query(
      `SELECT s.id FROM sessions s
       WHERE s.status IN ('connected', 'connecting', 'reconnecting')
         AND EXISTS (
           SELECT 1 FROM baileys_auth_store a
           WHERE a.session_id = s.id AND a.data_type = 'creds' AND a.data_id = 'creds' AND a.value ? 'account'
         )
       ORDER BY s.created_at ASC`
    );
    const sessionIds = res.rows.map((row) => row.id);

    // Statuses left over from the previous process are stale; unpaired sessions wait for an explicit /init
    await query(
      `UPDATE sessions
       SET status = 'disconnected', qr_code = NULL, disconnect_reason = COALESCE(disconnect_reason, 'not_restored'), updated_at = NOW()
       WHERE status <> 'disconnected' AND NOT (id = ANY($1::text[]))`,
      [sessionIds]
    );

    console.log(`[Restore] Found ${sessionIds.length} paired session(s) to restore.`);

    (async () => {
      for (const [index, sessionId] of sessionIds.entries()) {
        if (index > 0) await delay(config.restoreStaggerMs);
        console.log(`[Restore] Restoring session: ${sessionId}`);
        try {
          await initSession(sessionId);
        } catch (err) {
          console.error(`[Restore] Failed to restore session ${sessionId}:`, err.message);
        }
      }
    })();
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
    throw new AppError(404, `Message "${messageId}" not found in session "${sessionId}" or has no raw payload.`);
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
