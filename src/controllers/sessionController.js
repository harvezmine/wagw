import {
  initSession as initSessionService,
  getSessionStatus,
  getAllSessions,
  requestPairingCode as requestPairingCodeService,
  logoutSession,
  deleteSession as deleteSessionService
} from '../services/sessionManager.js';
import { query } from '../database/db.js';

export async function initSession(req, res) {
  try {
    const { sessionId, customName, webhookUrl } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId is required in request body.'
      });
    }

    const result = await initSessionService(sessionId, { customName, webhookUrl });

    // Allow quick delay for initial QR generation
    await new Promise((r) => setTimeout(r, 1000));
    const status = await getSessionStatus(sessionId);

    return res.status(200).json({
      success: true,
      message: 'Session initialization triggered.',
      session: status
    });
  } catch (error) {
    console.error('[SessionController] initSession error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export async function getQrCode(req, res) {
  try {
    const { sessionId } = req.params;
    const { format } = req.query; // 'html', 'image' or 'json'
    let status = await getSessionStatus(sessionId);

    // Auto-init if session doesn't exist, is disconnected, or not active
    if (!status.exists || status.status === 'disconnected' || status.status === 'not_found') {
      try {
        await initSessionService(sessionId, { customName: status.customName || '', webhookUrl: status.webhookUrl || null });
      } catch (initErr) {
        console.error(`[SessionController] Auto-init failed for session ${sessionId}:`, initErr);
      }
    }

    // Wait up to 3 seconds for QR code or connection ready
    let attempts = 0;
    while (attempts < 6) {
      status = await getSessionStatus(sessionId);
      if (status.status === 'connected' || status.qrCode) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
      attempts++;
    }

    if (format === 'html' || format === 'image') {
      if (status.status === 'connected') {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>WhatsApp Connected - ${sessionId}</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0b141a; color: #e9edef; }
              .card { background: #111b21; padding: 2.5rem 2rem; border-radius: 16px; box-shadow: 0 4px 25px rgba(0,0,0,0.6); text-align: center; max-width: 380px; width: 90%; }
              .icon { font-size: 3rem; margin-bottom: 0.8rem; color: #25d366; }
              h2 { margin: 0 0 10px; color: #e9edef; }
              p { font-size: 0.9rem; color: #8696a0; line-height: 1.5; margin-bottom: 20px; }
              .badge { background: #005c4b; color: #25d366; padding: 6px 14px; border-radius: 20px; font-size: 0.85rem; font-weight: bold; display: inline-block; margin-bottom: 15px; }
              .phone-box { background: #202c33; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 1.1rem; color: #25d366; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="icon">✓</div>
              <span class="badge">Session: ${sessionId}</span>
              <h2>WhatsApp Connected</h2>
              <p>Your WhatsApp device is successfully linked and active.</p>
              <div class="phone-box">${status.phoneNumber ? '+' + status.phoneNumber : 'Device Connected'}</div>
            </div>
          </body>
          </html>
        `);
      }

      if (!status.qrCode) {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Starting WhatsApp Session - ${sessionId}</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0b141a; color: #e9edef; }
              .card { background: #111b21; padding: 2.5rem 2rem; border-radius: 16px; box-shadow: 0 4px 25px rgba(0,0,0,0.6); text-align: center; max-width: 380px; width: 90%; }
              .spinner { width: 48px; height: 48px; border: 4px solid #202c33; border-top: 4px solid #25d366; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto; }
              @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
              h2 { margin: 0 0 10px; color: #25d366; }
              p { font-size: 0.9rem; color: #8696a0; line-height: 1.5; }
              .badge { background: #202c33; color: #8696a0; padding: 4px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: bold; }
            </style>
            <script>
              setTimeout(() => location.reload(), 2000);
            </script>
          </head>
          <body>
            <div class="card">
              <span class="badge">Session: ${sessionId}</span>
              <div class="spinner"></div>
              <h2>Initializing WhatsApp...</h2>
              <p>Starting connection and preparing QR code. This page will refresh automatically in 2 seconds.</p>
            </div>
          </body>
          </html>
        `);
      }

      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Scan WhatsApp QR - ${sessionId}</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0b141a; color: #e9edef; }
            .card { background: #111b21; padding: 2rem; border-radius: 16px; box-shadow: 0 4px 25px rgba(0,0,0,0.6); text-align: center; max-width: 380px; width: 90%; }
            h2 { margin-top: 0; color: #25d366; }
            img { width: 260px; height: 260px; border-radius: 8px; background: #fff; padding: 8px; margin: 15px 0; }
            p { font-size: 0.9rem; color: #8696a0; line-height: 1.4; }
            .badge { background: #005c4b; color: #25d366; padding: 4px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: bold; }
          </style>
          <script>
            setTimeout(() => location.reload(), 15000);
          </script>
        </head>
        <body>
          <div class="card">
            <span class="badge">Session: ${sessionId}</span>
            <h2>Scan WhatsApp QR</h2>
            <img src="${status.qrCode}" alt="WhatsApp QR Code" />
            <p>1. Open WhatsApp on your phone<br>2. Tap Menu / Settings &gt; Linked Devices<br>3. Tap Link a Device and point your camera here</p>
          </div>
        </body>
        </html>
      `);
    }

    if (status.status === 'connected') {
      return res.status(200).json({
        success: true,
        status: 'connected',
        phoneNumber: status.phoneNumber,
        message: 'Device is already connected. QR code is not needed.'
      });
    }

    if (!status.qrCode) {
      return res.status(200).json({
        success: true,
        status: status.status || 'connecting',
        message: 'Session is initializing. QR code is not ready yet. Try again in 2 seconds.',
        qrCode: null
      });
    }

    return res.status(200).json({
      success: true,
      sessionId,
      status: status.status,
      qrCode: status.qrCode
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function requestPairingCode(req, res) {
  try {
    const { sessionId } = req.params;
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber is required (e.g. 628123456789).'
      });
    }

    const code = await requestPairingCodeService(sessionId, phoneNumber);

    return res.status(200).json({
      success: true,
      sessionId,
      phoneNumber,
      pairingCode: code,
      instruction: 'Enter this 8-digit code in WhatsApp > Linked Devices > Link with phone number.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
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
    return res.status(500).json({ success: false, error: error.message });
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
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function updateWebhook(req, res) {
  try {
    const { sessionId } = req.params;
    const { webhookUrl } = req.body;

    await query(`UPDATE sessions SET webhook_url = $1, updated_at = NOW() WHERE id = $2`, [webhookUrl, sessionId]);

    return res.status(200).json({
      success: true,
      message: `Webhook updated for session ${sessionId}`,
      webhookUrl
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function logout(req, res) {
  try {
    const { sessionId } = req.params;
    const result = await logoutSession(sessionId);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function deleteSession(req, res) {
  try {
    const { sessionId } = req.params;
    const result = await deleteSessionService(sessionId);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
