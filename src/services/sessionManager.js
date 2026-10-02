import makeWASocket, {
  Browsers,
  delay,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  proto,
  toNumber
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { query } from '../database/db.js';
import { clearAuthState, usePostgresAuthState } from '../database/postgresAuthState.js';
import { WEBHOOK_EVENTS, WEBHOOK_FORMATS, extractMessageData, invalidateWebhookConfig, sendWebhookEvent } from './webhookService.js';
import { backoffDelay, decideReconnect } from './reconnectPolicy.js';
import { config } from '../config/index.js';
import { AppError } from '../utils/errors.js';
import { normalizePhoneNumber } from '../utils/phone.js';
import { describeMessageAddress, phoneFromJid } from '../utils/jid.js';
import { createKeyedLock } from '../utils/keyedLock.js';
import { createTtlCache } from '../utils/ttlCache.js';
import { assertSafeUrl, fetchRemoteFile } from '../utils/netGuard.js';
import { logger } from '../utils/logger.js';
import { outboundQueue } from './outboundQueue.js';
import { ackToStatus, allowedPreviousStatuses, describeAckError } from './messageStatus.js';
import { MEDIA_TYPES, buildMessageContent, historyText, presenceFor } from './messageContent.js';
import { normalizeSettings } from './sessionSettings.js';

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

// Application events, and Baileys internals (quiet by default, BAILEYS_LOG_LEVEL)
const log = logger.child({ module: 'session' });
const baileysLogger = logger.child({ module: 'baileys' }, { level: config.baileysLogLevel });

function getSessionCache(caches, sessionId, ttlMs) {
  if (!caches.has(sessionId)) {
    caches.set(sessionId, createTtlCache({ ttlMs }));
  }
  return caches.get(sessionId);
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
 * Anti-ban simulation: shows typing (or recording) for a natural duration before sending. Actions
 * such as reactions and deletions are sent without presence.
 */
async function sendWithHumanSimulation(sock, jid, messageContent, { delayMs = null, presence = 'composing', options = {} } = {}) {
  if (!presence) {
    return sock.sendMessage(jid, messageContent, options);
  }
  try {
    // 1. Presence update - Typing / Recording
    await sock.sendPresenceUpdate(presence, jid);

    // 2. Calculate natural delay (an explicit delayMs, including 0, wins)
    let delayTime = delayMs;
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
    return await sock.sendMessage(jid, messageContent, options);
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
    log.error({ sessionId, messageId: key.id, err: error }, 'getMessage lookup failed');
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
      log.error({ sessionId, err: error }, 'Reconnect attempt failed');
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

  log.info({ sessionId, phone }, 'Connected');
  // The cached webhook settings carry the phone number used in Fonnte-style payloads
  invalidateWebhookConfig(sessionId);

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

  log.warn(
    { sessionId, statusCode, action: decision.action, reason: decision.reason, retryInMs: decision.delayMs },
    'Connection closed'
  );

  // Act before touching the database so a DB outage cannot block the reconnect
  if (decision.action === 'reconnect') {
    sessionData.reconnectAttempts += 1;
    scheduleReconnect(sessionData, decision.delayMs);
  } else {
    sessionData.stopped = true;
    activeSessions.delete(sessionId);
    if (decision.action === 'logout') {
      log.info({ sessionId }, 'Logged out, clearing session auth keys');
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

  // Chats may be addressed by LID (Baileys v7); the phone-number JID is kept alongside
  const { remoteJid, remoteJidAlt, senderJid, senderJidAlt, senderPhone, isGroup } = describeMessageAddress(msg.key);
  if (isGroup && sessionData.settings.ignoreGroups) return;
  const fromMe = Boolean(msg.key.fromMe);
  const messageId = msg.key.id;
  const pushName = msg.pushName || '';

  // Extract and normalize message type and content
  const parsed = extractMessageData(msg);

  // Auto mark as read if configured and not from me
  if (!fromMe && (sessionData.settings.readMessages ?? config.antiBan.autoReadMessages)) {
    try {
      await sock.readMessages([msg.key]);
    } catch (_) {}
  }

  // Store message in PostgreSQL
  await query(
    `INSERT INTO messages (session_id, message_id, remote_jid, sender_jid, from_me, push_name, message_type, content, raw_payload, status, remote_jid_alt, sender_jid_alt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
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
      fromMe ? 'sent' : 'received',
      remoteJidAlt,
      senderJidAlt
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
    remoteJidAlt,
    senderJid,
    senderJidAlt,
    senderPhone,
    fromMe,
    pushName,
    isGroup,
    messageType: parsed.messageType,
    rawType: parsed.rawType,
    content: parsed.content,
    media: parsed.media,
    contextInfo: parsed.contextInfo,
    timestamp: msg.messageTimestamp ? new Date(toNumber(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString()
  });
}

/**
 * Applies a delivery receipt for one of our messages (forward-only) and emits `message.status`.
 */
async function handleAck(sessionData, key, update) {
  const status = ackToStatus(update.status);
  const allowedPrevious = status ? allowedPreviousStatuses(status) : [];
  if (!allowedPrevious.length) return;

  const { sessionId } = sessionData;
  const error = status === 'failed' ? describeAckError(update.messageStubParameters?.[0]) : null;
  const [historyRes, queueItem] = await Promise.all([
    query(
      `UPDATE messages SET status = $3, updated_at = NOW()
       WHERE session_id = $1 AND message_id = $2 AND status = ANY($4::text[])`,
      [sessionId, key.id, status, allowedPrevious]
    ),
    outboundQueue.applyAck(sessionId, key.id, status, allowedPrevious, error)
  ]);
  if (!historyRes.rowCount && !queueItem) return;

  if (error) {
    log.warn({ sessionId, messageId: key.id, error }, 'WhatsApp rejected a sent message');
  }
  sendWebhookEvent(sessionId, 'message.status', {
    messageId: key.id,
    queueId: queueItem ? Number(queueItem.id) : null,
    remoteJid: key.remoteJid,
    status,
    error,
    timestamp: new Date().toISOString()
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
  const sessionRow = await query(
    `INSERT INTO sessions (id, custom_name, webhook_url, status, disconnect_reason, updated_at)
     VALUES ($1, $2, $3, 'connecting', NULL, NOW())
     ON CONFLICT (id) DO UPDATE
     SET custom_name = COALESCE(EXCLUDED.custom_name, sessions.custom_name),
         webhook_url = COALESCE(EXCLUDED.webhook_url, sessions.webhook_url),
         status = 'connecting',
         disconnect_reason = NULL,
         updated_at = NOW()
     RETURNING settings`,
    [sessionId, customName || null, webhookUrl || null]
  );
  if (webhookUrl) {
    invalidateWebhookConfig(sessionId);
  }

  const { state, saveCreds } = await usePostgresAuthState(sessionId);
  const groupCache = getSessionCache(groupMetadataCaches, sessionId, 5 * 60 * 1000);

  const sock = makeWASocket({
    // Use the WA Web version bundled with Baileys; WA_VERSION overrides it if WhatsApp rejects it (405)
    ...(config.waVersion ? { version: config.waVersion } : {}),
    logger: baileysLogger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
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
    settings: normalizeSettings(sessionRow.rows[0]?.settings),
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
        log.error({ sessionId, event, err: error }, 'Error handling Baileys event');
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
  on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    // Baileys v7 reports reach-out restrictions (the cause of error 463) through connection updates
    if (update.reachoutTimeLock) {
      sendWebhookEvent(sessionId, 'account.restriction', update.reachoutTimeLock);
    }
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
        log.error({ sessionId, messageId: msg.key?.id, err }, 'Error processing incoming message');
      }
    }
  });

  // Delivery receipts for messages we sent (server ack, delivered, read, played, error)
  on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (!key?.fromMe || update?.status === undefined || update?.status === null) continue;
      try {
        await handleAck(sessionData, key, update);
      } catch (err) {
        log.error({ sessionId, messageId: key.id, err }, 'Failed to apply message status update');
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

  // Incoming calls: report them, and optionally reject and answer with a message
  on('call', async (calls) => {
    for (const call of calls) {
      if (call.status !== 'offer') continue;
      sendWebhookEvent(sessionId, 'call.received', {
        callId: call.id,
        from: call.from,
        callerPhone: call.callerPn ? phoneFromJid(call.callerPn) : null,
        isVideo: Boolean(call.isVideo),
        isGroup: Boolean(call.isGroup)
      });
      const { rejectCalls, rejectCallMessage } = sessionData.settings;
      if (!rejectCalls) continue;
      await sock.rejectCall(call.id, call.from);
      if (rejectCallMessage) {
        await outboundQueue.enqueue({
          sessionId,
          targetJid: call.from,
          messageType: 'text',
          payload: { text: rejectCallMessage }
        });
      }
    }
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

export function getConnectedSocket(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session || session.stopped || session.status !== 'connected') {
    throw new AppError(409, `Session "${sessionId}" is not connected.`);
  }
  return session.sock;
}

export function isSessionConnected(sessionId) {
  const session = activeSessions.get(sessionId);
  return Boolean(session && !session.stopped && session.status === 'connected');
}

export function getConnectedSessionIds() {
  return [...activeSessions.values()]
    .filter((session) => !session.stopped && session.status === 'connected')
    .map((session) => session.sessionId);
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
    log.error({ sessionId: session.sessionId, messageId: result.key.id, err: error }, 'Failed to store sent message');
  }
}

// Bulk sends reuse one media URL for many recipients: keep small downloads for a few minutes
const remoteMediaCache = createTtlCache({ ttlMs: 10 * 60 * 1000, maxEntries: 10 });
const CACHEABLE_MEDIA_BYTES = 10 * 1024 * 1024;

async function loadQueuedMedia(item) {
  if (item.media_data) {
    return { buffer: item.media_data, contentType: item.payload.mimetype || null };
  }
  const cached = remoteMediaCache.get(item.payload.url);
  if (cached) return cached;
  const media = await fetchRemoteFile(item.payload.url, { allowPrivate: config.allowPrivateUrls, maxBytes: config.mediaMaxBytes });
  if (media.buffer.length <= CACHEABLE_MEDIA_BYTES) remoteMediaCache.set(item.payload.url, media);
  return media;
}

async function loadQuotedMessage(sessionId, messageId) {
  const res = await query(`SELECT raw_payload FROM messages WHERE session_id = $1 AND message_id = $2`, [sessionId, messageId]);
  const raw = res.rows[0]?.raw_payload;
  return raw ? proto.WebMessageInfo.fromObject(raw) : undefined;
}

/**
 * Sends one claimed queue item (called by the queue runner) and returns the WhatsApp message id.
 * Throws AppError 503 when the session is not connected (retryable) and 4xx for bad input.
 */
export async function deliverQueuedMessage(item) {
  const session = activeSessions.get(item.session_id);
  if (!session || session.stopped || session.status !== 'connected') {
    throw new AppError(503, `Session "${item.session_id}" is not connected.`);
  }
  const type = item.message_type;
  const { payload } = item;
  const media = MEDIA_TYPES.includes(type) ? await loadQueuedMedia(item) : null;
  const content = buildMessageContent(type, payload, { media, key: payload.key || null });
  const quoted = payload.replyTo ? await loadQuotedMessage(item.session_id, payload.replyTo) : undefined;

  const result = await sendWithHumanSimulation(session.sock, item.target_jid, content, {
    delayMs: payload.delayMs,
    presence: presenceFor(type),
    options: quoted ? { quoted } : {}
  });
  await saveOutgoingMessage(session, item.target_jid, result, {
    messageType: type,
    content: historyText(type, payload),
    mediaUrl: payload.url || null
  });
  return result.key.id;
}

/**
 * Closes every socket without logging out (graceful shutdown). Stored statuses are kept, so the
 * sessions are restored on the next start.
 */
export function shutdownSessions() {
  for (const session of activeSessions.values()) teardownSocket(session);
  activeSessions.clear();
}

// Group list per session: fetching every group is a heavy call, so it is cached and refreshed sparingly
const groupLists = new Map();

function summarizeGroup(metadata) {
  return {
    id: metadata.id,
    subject: metadata.subject || '',
    size: metadata.size ?? metadata.participants?.length ?? 0,
    owner: metadata.owner ?? null,
    createdAt: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : null,
    announce: Boolean(metadata.announce),
    restrict: Boolean(metadata.restrict)
  };
}

/**
 * Groups the account belongs to, from cache (GROUPS_CACHE_MINUTES). `refresh` refetches at most once
 * per minute. A cached list is served even while the session is offline.
 */
export async function listGroups(sessionId, { refresh = false } = {}) {
  const cached = groupLists.get(sessionId);
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  const usable = age < config.groups.cacheTtlMs && !(refresh && age >= config.groups.refreshMinIntervalMs);
  if (cached && (usable || !isSessionConnected(sessionId))) {
    return { groups: cached.groups, fetchedAt: new Date(cached.fetchedAt).toISOString() };
  }

  const sock = getConnectedSocket(sessionId);
  const all = await sock.groupFetchAllParticipating();
  const metadataCache = getSessionCache(groupMetadataCaches, sessionId, 5 * 60 * 1000);
  const groups = Object.values(all)
    .map((metadata) => {
      metadataCache.set(metadata.id, metadata);
      return summarizeGroup(metadata);
    })
    .sort((a, b) => a.subject.localeCompare(b.subject));
  const fetchedAt = Date.now();
  groupLists.set(sessionId, { fetchedAt, groups });
  return { groups, fetchedAt: new Date(fetchedAt).toISOString() };
}

export async function getGroup(sessionId, groupJid) {
  if (!/^\d+(-\d+)?@g\.us$/.test(groupJid)) {
    throw new AppError(400, 'groupId must be a group JID such as 120363012345678901@g.us.');
  }
  const sock = getConnectedSocket(sessionId);
  const metadataCache = getSessionCache(groupMetadataCaches, sessionId, 5 * 60 * 1000);
  let metadata = metadataCache.get(groupJid);
  if (!metadata) {
    try {
      metadata = await sock.groupMetadata(groupJid);
    } catch (error) {
      throw new AppError(404, `Group "${groupJid}" not found or the account is not a member (${error.message}).`);
    }
    metadataCache.set(groupJid, metadata);
  }
  return {
    ...summarizeGroup(metadata),
    description: metadata.desc ?? null,
    participants: (metadata.participants || []).map((participant) => ({
      id: participant.id,
      phoneNumber: participant.phoneNumber ?? null,
      admin: participant.admin ?? null
    }))
  };
}

export async function getSessionSettings(sessionId) {
  const res = await query('SELECT settings FROM sessions WHERE id = $1', [sessionId]);
  if (!res.rowCount) throw new AppError(404, `Session "${sessionId}" not found.`);
  return normalizeSettings(res.rows[0].settings);
}

export async function updateSessionSettings(sessionId, update) {
  const res = await query(
    `UPDATE sessions SET settings = settings || $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING settings`,
    [sessionId, JSON.stringify(update)]
  );
  if (!res.rowCount) throw new AppError(404, `Session "${sessionId}" not found.`);
  const settings = normalizeSettings(res.rows[0].settings);
  const session = activeSessions.get(sessionId);
  if (session) session.settings = settings;
  return settings;
}

/**
 * Current WhatsApp restrictions of the account (Baileys v7): new-chat message cap and reach-out timelock.
 */
export async function getSessionLimits(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session || session.stopped || session.status !== 'connected') {
    throw new AppError(409, `Session "${sessionId}" is not connected.`);
  }
  const { sock } = session;
  if (typeof sock.fetchNewChatMessageCap !== 'function' || typeof sock.fetchAccountReachoutTimelock !== 'function') {
    throw new AppError(501, 'Account limits require Baileys v7.');
  }
  const [newChatMessageCap, reachoutTimelock] = await Promise.allSettled([
    sock.fetchNewChatMessageCap(),
    sock.fetchAccountReachoutTimelock()
  ]);
  const unwrap = (result) => (result.status === 'fulfilled' ? result.value : { error: result.reason?.message || 'Request failed' });
  return { newChatMessageCap: unwrap(newChatMessageCap), reachoutTimelock: unwrap(reachoutTimelock) };
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
    webhookSecretSet: Boolean(row.webhook_secret),
    webhookEvents: row.webhook_events,
    webhookFormat: row.webhook_format,
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
 * Updates the webhook settings of a session. Absent fields stay unchanged; null or "" clears a value.
 */
export async function setSessionWebhookConfig(sessionId, { webhookUrl, webhookSecret, events, format }) {
  const assignments = [];
  const params = [sessionId];
  const assign = (column, value) => {
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  };

  if (webhookUrl !== undefined) {
    const url = webhookUrl ? String(webhookUrl).trim() : null;
    if (url) assertSafeUrl(url, { allowPrivate: config.allowPrivateUrls, label: 'webhookUrl' });
    assign('webhook_url', url);
  }
  if (webhookSecret !== undefined) {
    const secret = webhookSecret ? String(webhookSecret) : null;
    if (secret && secret.length < 16) {
      throw new AppError(400, 'webhookSecret must be at least 16 characters long.');
    }
    assign('webhook_secret', secret);
  }
  if (events !== undefined) {
    if (events !== null && (!Array.isArray(events) || events.some((event) => !WEBHOOK_EVENTS.includes(event)))) {
      throw new AppError(400, `events must be null (all events) or an array of: ${WEBHOOK_EVENTS.join(', ')}.`);
    }
    assign('webhook_events', events);
  }
  if (format !== undefined) {
    if (!WEBHOOK_FORMATS.includes(format)) {
      throw new AppError(400, `format must be one of: ${WEBHOOK_FORMATS.join(', ')}.`);
    }
    assign('webhook_format', format);
  }

  const res = await query(
    `UPDATE sessions SET ${[...assignments, 'updated_at = NOW()'].join(', ')} WHERE id = $1
     RETURNING webhook_url, webhook_secret IS NOT NULL AS webhook_secret_set, webhook_events, webhook_format`,
    params
  );
  if (res.rowCount === 0) {
    throw new AppError(404, `Session "${sessionId}" not found.`);
  }
  invalidateWebhookConfig(sessionId);
  const row = res.rows[0];
  return { webhookUrl: row.webhook_url, webhookSecretSet: row.webhook_secret_set, events: row.webhook_events, format: row.webhook_format };
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
    groupLists.delete(sessionId);
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
  invalidateWebhookConfig(sessionId);
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

    log.info({ count: sessionIds.length }, 'Restoring paired sessions');

    (async () => {
      for (const [index, sessionId] of sessionIds.entries()) {
        if (index > 0) await delay(config.restoreStaggerMs);
        log.info({ sessionId }, 'Restoring session');
        try {
          await initSession(sessionId);
        } catch (err) {
          log.error({ sessionId, err }, 'Failed to restore session');
        }
      }
    })();
  } catch (error) {
    log.error({ err: error }, 'Error restoring sessions from database');
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
        logger: baileysLogger,
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
    log.error({ sessionId, messageId, err: error }, 'Error downloading media');
    throw new Error(`Failed to decrypt and download media: ${error.message}`);
  }
}
