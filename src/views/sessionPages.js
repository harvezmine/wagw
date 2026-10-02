import { escapeHtml } from '../utils/html.js';

const BASE_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0b141a; color: #e9edef; }
  .card { background: #111b21; padding: 2.5rem 2rem; border-radius: 16px; box-shadow: 0 4px 25px rgba(0,0,0,0.6); text-align: center; max-width: 380px; width: 90%; }
  h2 { margin: 0 0 10px; color: #25d366; }
  p { font-size: 0.9rem; color: #8696a0; line-height: 1.5; }
  .badge { background: #005c4b; color: #25d366; padding: 4px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: bold; display: inline-block; margin-bottom: 15px; }
  .icon { font-size: 3rem; margin-bottom: 0.8rem; color: #25d366; }
  .phone-box { background: #202c33; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 1.1rem; color: #25d366; }
  .spinner { width: 48px; height: 48px; border: 4px solid #202c33; border-top: 4px solid #25d366; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto; }
  @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  img { width: 260px; height: 260px; border-radius: 8px; background: #fff; padding: 8px; margin: 15px 0; }
`;

function renderPage({ title, body, refreshMs = null }) {
  const refresh = refreshMs ? `<script>setTimeout(() => location.reload(), ${Number(refreshMs)});</script>` : '';
  return `<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${BASE_STYLE}</style>
  ${refresh}
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`;
}

const badge = (sessionId) => `<span class="badge">Session: ${escapeHtml(sessionId)}</span>`;

export function renderConnectedPage(sessionId, phoneNumber) {
  return renderPage({
    title: `WhatsApp Connected - ${sessionId}`,
    body: `<div class="icon">✓</div>${badge(sessionId)}
      <h2>WhatsApp Connected</h2>
      <p>Your WhatsApp device is successfully linked and active.</p>
      <div class="phone-box">${phoneNumber ? `+${escapeHtml(phoneNumber)}` : 'Device Connected'}</div>`
  });
}

export function renderInitializingPage(sessionId) {
  return renderPage({
    title: `Starting WhatsApp Session - ${sessionId}`,
    refreshMs: 2000,
    body: `${badge(sessionId)}<div class="spinner"></div>
      <h2>Initializing WhatsApp...</h2>
      <p>Starting connection and preparing QR code. This page will refresh automatically in 2 seconds.</p>`
  });
}

export function renderQrPage(sessionId, qrCode) {
  return renderPage({
    title: `Scan WhatsApp QR - ${sessionId}`,
    refreshMs: 15000,
    body: `${badge(sessionId)}
      <h2>Scan WhatsApp QR</h2>
      <img src="${escapeHtml(qrCode)}" alt="WhatsApp QR Code" />
      <p>1. Open WhatsApp on your phone<br>2. Tap Menu / Settings &gt; Linked Devices<br>3. Tap Link a Device and point your camera here</p>`
  });
}

export function renderMessagePage(sessionId, { title, message, refreshMs = null }) {
  return renderPage({
    title: `${title} - ${sessionId}`,
    refreshMs,
    body: `${badge(sessionId)}<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>`
  });
}
