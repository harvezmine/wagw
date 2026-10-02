import { requestPairingCode, downloadMediaByMessageId } from '../services/sessionManager.js';
import { formatQueueItem, submitMessage } from '../services/messageService.js';
import { query } from '../database/db.js';
import { config } from '../config/index.js';
import { AppError, sendError } from '../utils/errors.js';
import {
  assertSessionId,
  parseIdempotencyKey,
  parseOptionalBool,
  parseOptionalInt,
  parseScheduleAt
} from '../utils/validation.js';

function parseQueueOptions(req) {
  const { body } = req;
  return {
    delayMs: parseOptionalInt(body.delayMs, { name: 'delayMs', min: 0, max: config.antiBan.maxRequestDelayMs }),
    countryCode: body.countryCode === undefined || body.countryCode === '' ? undefined : String(body.countryCode),
    scheduleAt: parseScheduleAt(body.scheduleAt),
    idempotencyKey: parseIdempotencyKey(body.idempotencyKey ?? req.get('idempotency-key')),
    connectOnly: parseOptionalBool(body.connectOnly, { name: 'connectOnly', defaultValue: true }),
    wait: !parseOptionalBool(body.async, { name: 'async', defaultValue: false })
  };
}

/**
 * 200 when the message was sent within SEND_WAIT_TIMEOUT_MS; 202 while it is queued or scheduled;
 * the failure status (4xx for bad input, 502 otherwise) when sending failed.
 */
function respondToSubmission(res, { item, result, duplicate }, extra = {}) {
  const queued = formatQueueItem(item);
  if (duplicate) {
    return res.status(200).json({ success: true, duplicate: true, ...queued });
  }
  if (result?.status === 'sent') {
    return res.status(200).json({ success: true, messageId: result.messageId, remoteJid: queued.to, status: 'sent', queueId: queued.queueId, ...extra });
  }
  if (result?.status === 'failed') {
    const status = result.httpStatus >= 400 && result.httpStatus < 500 ? result.httpStatus : 502;
    return res.status(status).json({ success: false, status: 'failed', error: result.error, queueId: queued.queueId });
  }
  return res.status(202).json({
    success: true,
    status: result?.status ?? queued.status,
    queueId: queued.queueId,
    remoteJid: queued.to,
    scheduledAt: queued.scheduledAt,
    message: 'Message accepted. Track it with GET /api/queue/:queueId or the message.status webhook.'
  });
}

export async function sendText(req, res) {
  try {
    const { sessionId, to, text } = req.body;

    if (!sessionId || !to || !text) {
      throw new AppError(400, 'Required fields missing: sessionId, to, text are required.');
    }
    assertSessionId(sessionId);

    const submission = await submitMessage({ sessionId, to, type: 'text', content: { text }, ...parseQueueOptions(req) });
    return respondToSubmission(res, submission);
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}

export async function sendImage(req, res) {
  try {
    const { sessionId, to, caption, imageUrl } = req.body;
    // Support multipart file upload as fallback
    const imageInput = req.file ? req.file.buffer : imageUrl;

    if (!sessionId || !to || !imageInput) {
      throw new AppError(400, 'Required fields missing: sessionId, to, and imageUrl (or file upload) are required.');
    }
    assertSessionId(sessionId);

    const submission = await submitMessage({
      sessionId,
      to,
      type: 'image',
      content: { caption: caption || '' },
      media: { input: imageInput },
      ...parseQueueOptions(req)
    });
    return respondToSubmission(res, submission);
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}

export async function sendAttachment(req, res) {
  try {
    const { sessionId, to, attachmentUrl, fileName, mimetype, caption } = req.body;
    const docInput = req.file ? req.file.buffer : attachmentUrl;

    if (!sessionId || !to || !docInput) {
      throw new AppError(400, 'Required fields missing: sessionId, to, and attachmentUrl (or file upload) are required.');
    }
    assertSessionId(sessionId);

    const resolvedFileName = fileName || req.file?.originalname || 'file';
    const resolvedMimetype = mimetype || req.file?.mimetype || null;
    const submission = await submitMessage({
      sessionId,
      to,
      type: 'document',
      content: { fileName: resolvedFileName, caption: caption || '', ...(resolvedMimetype ? { mimetype: resolvedMimetype } : {}) },
      media: { input: docInput },
      ...parseQueueOptions(req)
    });
    return respondToSubmission(res, submission, { fileName: resolvedFileName });
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}

export async function sendPairingCode(req, res) {
  try {
    const { sessionId, phoneNumber, countryCode } = req.body;

    if (!sessionId || !phoneNumber) {
      throw new AppError(400, 'sessionId and phoneNumber are required.');
    }
    assertSessionId(sessionId);

    const { code, phoneNumber: normalizedPhone } = await requestPairingCode(sessionId, phoneNumber, { countryCode });

    return res.status(200).json({
      success: true,
      sessionId,
      phoneNumber: normalizedPhone,
      pairingCode: code,
      message: 'WhatsApp pairing code generated successfully.'
    });
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}

export async function getMessages(req, res) {
  try {
    const { sessionId } = req.params;
    const { remoteJid, type } = req.query;
    const limit = parseOptionalInt(req.query.limit, { name: 'limit', min: 1, max: 200, defaultValue: 50 });
    const offset = parseOptionalInt(req.query.offset, { name: 'offset', min: 0, max: Number.MAX_SAFE_INTEGER, defaultValue: 0 });

    let sql = `SELECT * FROM messages WHERE session_id = $1`;
    const params = [sessionId];

    if (remoteJid) {
      params.push(`%${remoteJid}%`);
      sql += ` AND (remote_jid LIKE $${params.length} OR remote_jid_alt LIKE $${params.length})`;
    }

    if (type) {
      params.push(type);
      sql += ` AND message_type = $${params.length}`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    return res.status(200).json({
      success: true,
      sessionId,
      count: result.rows.length,
      messages: result.rows
    });
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}

export async function downloadMedia(req, res) {
  try {
    const { sessionId, messageId } = req.params;
    const { format, base64 } = req.query;

    const media = await downloadMediaByMessageId(sessionId, messageId);

    if (base64 === 'true' || format === 'json' || format === 'base64') {
      return res.status(200).json({
        success: true,
        sessionId,
        messageId,
        fileName: media.fileName,
        mimetype: media.mimetype,
        fileLength: media.fileLength,
        base64: `data:${media.mimetype};base64,${media.buffer.toString('base64')}`
      });
    }

    res.setHeader('Content-Type', media.mimetype);
    res.setHeader('Content-Length', media.fileLength);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(media.fileName)}"`);
    return res.send(media.buffer);
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}
