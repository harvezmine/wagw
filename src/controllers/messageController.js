import {
  sendTextMessage,
  sendImageMessage,
  sendAttachmentMessage,
  requestPairingCode,
  downloadMediaByMessageId
} from '../services/sessionManager.js';
import { query } from '../database/db.js';

export async function sendText(req, res) {
  try {
    const { sessionId, to, text, delayMs } = req.body;

    if (!sessionId || !to || !text) {
      return res.status(400).json({
        success: false,
        error: 'Required fields missing: sessionId, to, text are required.'
      });
    }

    const result = await sendTextMessage(sessionId, to, text, { delayMs });

    return res.status(200).json(result);
  } catch (error) {
    console.error('[MessageController] sendText error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function sendImage(req, res) {
  try {
    const { sessionId, to, caption, imageUrl, delayMs } = req.body;
    let imageInput = imageUrl;

    // Support multipart file upload as fallback
    if (req.file) {
      imageInput = req.file.buffer;
    }

    if (!sessionId || !to || !imageInput) {
      return res.status(400).json({
        success: false,
        error: 'Required fields missing: sessionId, to, and imageUrl (or file upload) are required.'
      });
    }

    const result = await sendImageMessage(sessionId, to, imageInput, caption || '', { delayMs });

    return res.status(200).json(result);
  } catch (error) {
    console.error('[MessageController] sendImage error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function sendAttachment(req, res) {
  try {
    const { sessionId, to, attachmentUrl, fileName, mimetype, caption, delayMs } = req.body;
    let docInput = attachmentUrl;
    let resolvedFileName = fileName;
    let resolvedMimetype = mimetype;

    if (req.file) {
      docInput = req.file.buffer;
      resolvedFileName = resolvedFileName || req.file.originalname;
      resolvedMimetype = resolvedMimetype || req.file.mimetype;
    }

    if (!sessionId || !to || !docInput) {
      return res.status(400).json({
        success: false,
        error: 'Required fields missing: sessionId, to, and attachmentUrl (or file upload) are required.'
      });
    }

    const result = await sendAttachmentMessage(
      sessionId,
      to,
      docInput,
      resolvedFileName || 'file',
      resolvedMimetype || 'application/octet-stream',
      caption || '',
      { delayMs }
    );

    return res.status(200).json(result);
  } catch (error) {
    console.error('[MessageController] sendAttachment error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function sendPairingCode(req, res) {
  try {
    const { sessionId, phoneNumber } = req.body;

    if (!sessionId || !phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'sessionId and phoneNumber are required.'
      });
    }

    const code = await requestPairingCode(sessionId, phoneNumber);

    return res.status(200).json({
      success: true,
      sessionId,
      phoneNumber,
      pairingCode: code,
      message: 'WhatsApp pairing code generated successfully.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function getMessages(req, res) {
  try {
    const { sessionId } = req.params;
    const { limit = 50, offset = 0, remoteJid, type } = req.query;

    let sql = `SELECT * FROM messages WHERE session_id = $1`;
    const params = [sessionId];

    if (remoteJid) {
      params.push(`%${remoteJid}%`);
      sql += ` AND remote_jid LIKE $${params.length}`;
    }

    if (type) {
      params.push(type);
      sql += ` AND message_type = $${params.length}`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const result = await query(sql, params);

    return res.status(200).json({
      success: true,
      sessionId,
      count: result.rows.length,
      messages: result.rows
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
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
    console.error('[MessageController] downloadMedia error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

