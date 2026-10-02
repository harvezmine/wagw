import {
  initSession as initSessionService,
  getSessionStatus,
  getAllSessions,
  isSessionRunning,
  requestPairingCode as requestPairingCodeService,
  logoutSession,
  deleteSession as deleteSessionService,
  setSessionWebhookUrl
} from '../services/sessionManager.js';
import { createQrLinkToken } from '../middlewares/auth.js';
import { config } from '../config/index.js';
import { AppError, sendError } from '../utils/errors.js';
import { assertSessionId } from '../utils/validation.js';
import { renderConnectedPage, renderInitializingPage, renderMessagePage, renderQrPage } from '../views/sessionPages.js';

/**
 * Browser link to the QR page. With an API key configured it carries a signed token that only
 * works for this session and expires after QR_LINK_TTL_SECONDS.
 */
function buildQrPageLink(sessionId) {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/qr?format=html`;
  if (!config.apiKey) {
    return { url: path, expiresAt: null };
  }
  const { token, expiresAt } = createQrLinkToken(sessionId);
  return { url: `${path}&token=${encodeURIComponent(token)}`, expiresAt };
}

export async function initSession(req, res) {
  try {
    const { sessionId, customName, webhookUrl } = req.body;
    assertSessionId(sessionId);

    await initSessionService(sessionId, { customName, webhookUrl });

    // Allow quick delay for initial QR generation
    await new Promise((r) => setTimeout(r, 1000));
    const status = await getSessionStatus(sessionId);

    return res.status(200).json({
      success: true,
      message: 'Session initialization triggered.',
      session: status,
      qrPage: buildQrPageLink(sessionId)
    });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function createQrLink(req, res) {
  try {
    const { sessionId } = req.params;
    const status = await getSessionStatus(sessionId);
    if (!status.exists) {
      throw new AppError(404, `Session "${sessionId}" not found.`);
    }
    return res.status(200).json({ success: true, sessionId, qrPage: buildQrPageLink(sessionId) });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function getQrCode(req, res) {
  try {
    const { sessionId } = req.params;
    const wantsHtml = req.query.format === 'html' || req.query.format === 'image';
    let status = await getSessionStatus(sessionId);

    if (!status.exists) {
      const error = `Session "${sessionId}" not found. Create it first with POST /api/sessions/init.`;
      return wantsHtml
        ? res.status(404).send(renderMessagePage(sessionId, { title: 'Session not found', message: error }))
        : res.status(404).json({ success: false, error });
    }

    // Reading the QR never starts a session. A running one gets up to 3 seconds to produce a QR.
    if (!isSessionRunning(sessionId)) {
      const error = status.status === 'reconnecting'
        ? 'Session is reconnecting. Try again shortly.'
        : 'Session is not running. Start it with POST /api/sessions/init.';
      return wantsHtml
        ? res.status(409).send(renderMessagePage(sessionId, { title: 'Session not running', message: error, refreshMs: 5000 }))
        : res.status(409).json({ success: false, status: status.status, disconnectReason: status.disconnectReason, error });
    }

    for (let attempt = 0; attempt < 6 && status.status !== 'connected' && !status.qrCode; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      status = await getSessionStatus(sessionId);
    }

    if (status.status === 'connected') {
      return wantsHtml
        ? res.send(renderConnectedPage(sessionId, status.phoneNumber))
        : res.status(200).json({
          success: true,
          status: 'connected',
          phoneNumber: status.phoneNumber,
          message: 'Device is already connected. QR code is not needed.'
        });
    }

    if (!status.qrCode) {
      return wantsHtml
        ? res.send(renderInitializingPage(sessionId))
        : res.status(200).json({
          success: true,
          status: status.status || 'connecting',
          message: 'Session is initializing. QR code is not ready yet. Try again in 2 seconds.',
          qrCode: null
        });
    }

    return wantsHtml
      ? res.send(renderQrPage(sessionId, status.qrCode))
      : res.status(200).json({ success: true, sessionId, status: status.status, qrCode: status.qrCode });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function requestPairingCode(req, res) {
  try {
    const { sessionId } = req.params;
    const { phoneNumber, countryCode } = req.body;

    if (!phoneNumber) {
      throw new AppError(400, 'phoneNumber is required (e.g. 08123456789 or 628123456789).');
    }

    const { code, phoneNumber: normalizedPhone } = await requestPairingCodeService(sessionId, phoneNumber, { countryCode });

    return res.status(200).json({
      success: true,
      sessionId,
      phoneNumber: normalizedPhone,
      pairingCode: code,
      instruction: 'Enter this 8-digit code in WhatsApp > Linked Devices > Link with phone number.'
    });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function getStatus(req, res) {
  try {
    const { sessionId } = req.params;
    const status = await getSessionStatus(sessionId);
    return res.status(status.exists ? 200 : 404).json({
      success: status.exists,
      session: status
    });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function listSessions(req, res) {
  try {
    const sessions = await getAllSessions();
    return res.status(200).json({
      success: true,
      count: sessions.length,
      sessions
    });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function updateWebhook(req, res) {
  try {
    const { sessionId } = req.params;
    const webhookUrl = await setSessionWebhookUrl(sessionId, req.body.webhookUrl);

    return res.status(200).json({
      success: true,
      message: `Webhook updated for session ${sessionId}`,
      webhookUrl
    });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function logout(req, res) {
  try {
    const { sessionId } = req.params;
    const result = await logoutSession(sessionId);
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function deleteSession(req, res) {
  try {
    const { sessionId } = req.params;
    const result = await deleteSessionService(sessionId);
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}
