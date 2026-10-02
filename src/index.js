import express from 'express';
import cors from 'cors';
import { config, validateConfig } from './config/index.js';
import { initDatabase, pool } from './database/db.js';
import { restoreSessions, shutdownSessions } from './services/sessionManager.js';
import apiRoutes from './routes/index.js';
import fonnteRoutes from './fonnte/fonnteRoutes.js';
import { logger } from './utils/logger.js';
import { outboundQueue } from './services/outboundQueue.js';
import { queueRunner } from './services/messageService.js';
import { webhookDispatcher } from './services/webhookService.js';

const app = express();
let server = null;

// Needed behind a reverse proxy so req.ip (used by API key IP allowlists) is the client address
app.set('trust proxy', config.trustProxy);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    // Path only: query strings may carry signed QR link tokens
    const path = req.originalUrl.split('?')[0];
    logger.info({ method: req.method, path, status: res.statusCode, durationMs: Date.now() - start }, 'HTTP request');
  });
  next();
});

// Mount API Routes
app.use('/api', apiRoutes);
// Fonnte-compatible endpoints (drop-in for clients built for api.fonnte.com)
app.use('/fonnte', fonnteRoutes);

// Landing / Documentation Page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>WhatsApp Web Gateway API</title>
      <style>
        :root {
          --bg: #0b141a;
          --card: #111b21;
          --card-border: #202c33;
          --primary: #00a884;
          --primary-hover: #02906f;
          --text: #e9edef;
          --text-muted: #8696a0;
          --accent: #53bdeb;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          background: var(--bg);
          color: var(--text);
          margin: 0;
          padding: 2rem 1rem;
        }
        .container {
          max-width: 900px;
          margin: 0 auto;
        }
        .header {
          text-align: center;
          margin-bottom: 2rem;
        }
        .header h1 {
          color: var(--primary);
          font-size: 2.2rem;
          margin-bottom: 0.5rem;
        }
        .header p {
          color: var(--text-muted);
          font-size: 1.1rem;
        }
        .card {
          background: var(--card);
          border: 1px solid var(--card-border);
          border-radius: 12px;
          padding: 1.5rem;
          margin-bottom: 1.5rem;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        .card h2 {
          color: var(--primary);
          font-size: 1.3rem;
          margin-top: 0;
          margin-bottom: 1rem;
          border-bottom: 1px solid var(--card-border);
          padding-bottom: 0.5rem;
        }
        .endpoint {
          margin-bottom: 1rem;
          padding: 0.75rem;
          background: #182229;
          border-radius: 8px;
        }
        .badge-method {
          display: inline-block;
          font-weight: bold;
          font-size: 0.8rem;
          padding: 0.2rem 0.5rem;
          border-radius: 4px;
          margin-right: 0.5rem;
        }
        .badge-post { background: #005c4b; color: #25d366; }
        .badge-get { background: #1a446c; color: #53bdeb; }
        .badge-put { background: #684f10; color: #ffd279; }
        .badge-delete { background: #5c1a1a; color: #ff7676; }
        .path { font-family: monospace; font-weight: 600; }
        .desc { font-size: 0.85rem; color: var(--text-muted); margin-top: 0.3rem; }
        code { background: #222e35; padding: 2px 6px; border-radius: 4px; font-size: 0.85rem; color: #53bdeb; }
        pre { background: #222e35; padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; }
        .features-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 1rem;
          margin-bottom: 1.5rem;
        }
        .feature-box {
          background: var(--card);
          border: 1px solid var(--card-border);
          border-radius: 8px;
          padding: 1rem;
        }
        .feature-box strong { color: var(--primary); display: block; margin-bottom: 0.3rem; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🟢 WhatsApp Gateway API</h1>
          <p>Multi-Device • Baileys Engine • PostgreSQL Persistence • Anti-Ban Simulation • Webhooks</p>
        </div>

        <div class="features-grid">
          <div class="feature-box">
            <strong>🚀 Multi-Device</strong>
            Manage multiple WhatsApp numbers concurrently with individual sessions.
          </div>
          <div class="feature-box">
            <strong>🛡️ Anti-Ban Humanizer</strong>
            Simulates natural typing & recording presence delays before sending messages.
          </div>
          <div class="feature-box">
            <strong>🔔 Dynamic Webhooks</strong>
            Categorizes incoming messages (text, image, doc, audio, etc.) and routes to webhook.
          </div>
          <div class="feature-box">
            <strong>💾 PostgreSQL Storage</strong>
            Persistent auth credentials, sessions, and message history survive restarts.
          </div>
        </div>

        <div class="card">
          <h2>📱 Session Management Endpoints</h2>
          <div class="endpoint">
            <span class="badge-method badge-post">POST</span>
            <span class="path">/api/sessions/init</span>
            <div class="desc">Initialize new device session (Body: <code>{"sessionId": "device-1", "customName": "Sales WA", "webhookUrl": "https://..."}</code>)</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-get">GET</span>
            <span class="path">/api/sessions/:sessionId/qr?format=html</span>
            <div class="desc">Get QR Code for scanning (format: json, html, or image). Browsers open the signed <code>qrPage.url</code> returned by init or qr-link.</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-post">POST</span>
            <span class="path">/api/sessions/:sessionId/qr-link</span>
            <div class="desc">Create a short-lived signed link to the QR page that works without the API key header</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-post">POST</span>
            <span class="path">/api/sessions/:sessionId/pairing-code</span>
            <div class="desc">Generate 8-digit pairing code (Body: <code>{"phoneNumber": "08123456789"}</code>, optional <code>countryCode</code>)</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-get">GET</span>
            <span class="path">/api/sessions/:sessionId/status</span>
            <div class="desc">Check device connection status (connecting, qr_ready, connected, reconnecting, disconnected) and disconnectReason</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-get">GET</span>
            <span class="path">/api/sessions</span>
            <div class="desc">List all registered sessions</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-put">PUT</span>
            <span class="path">/api/sessions/:sessionId/webhook</span>
            <div class="desc">Update webhook URL for a session</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-post">POST</span>
            <span class="path">/api/sessions/:sessionId/logout</span>
            <div class="desc">Logout and unpair device session</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-delete">DELETE</span>
            <span class="path">/api/sessions/:sessionId</span>
            <div class="desc">Delete session record from database</div>
          </div>
        </div>

        <div class="card">
          <h2>🔔 Webhook & Limits</h2>
          <div class="endpoint">
            <span class="badge-method badge-put">PUT</span>
            <span class="path">/api/sessions/:sessionId/webhook</span>
            <div class="desc">Set <code>webhookUrl</code>, <code>webhookSecret</code> (HMAC) and <code>events</code> filter</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-get">GET</span>
            <span class="path">/api/sessions/:sessionId/webhook-deliveries</span>
            <div class="desc">Webhook delivery history (status, attempts, last error); retry with POST .../:deliveryId/retry</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-get">GET</span>
            <span class="path">/api/sessions/:sessionId/limits</span>
            <div class="desc">WhatsApp new-chat message cap and reach-out timelock for the account</div>
          </div>
        </div>

        <div class="card">
          <h2>📬 Queue Endpoints</h2>
          <div class="endpoint">
            <span class="badge-method badge-get">GET</span>
            <span class="path">/api/queue?sessionId=&amp;status=</span>
            <div class="desc">List queued/sent messages; GET /api/queue/:queueId for one message</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-put">PATCH</span>
            <span class="path">/api/queue/:queueId</span>
            <div class="desc">Reschedule a queued message (Body: <code>{"scheduleAt": "2026-10-03T08:00:00+07:00"}</code>)</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-delete">DELETE</span>
            <span class="path">/api/queue/:queueId</span>
            <div class="desc">Cancel a queued message</div>
          </div>
        </div>

        <div class="card">
          <h2>💬 Message Endpoints</h2>
          <div class="endpoint">
            <span class="badge-method badge-post">POST</span>
            <span class="path">/api/messages/send-text</span>
            <div class="desc">Queue a text message (Body: <code>{"sessionId": "device-1", "to": "08123456789", "text": "Hello!"}</code>; optional <code>async</code>, <code>scheduleAt</code>, <code>idempotencyKey</code>, <code>connectOnly</code>). 200 when sent, 202 while queued.</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-post">POST</span>
            <span class="path">/api/messages/send-image</span>
            <div class="desc">Send image (URL or multipart file) (Body: <code>{"sessionId": "device-1", "to": "628...", "imageUrl": "https://...", "caption": "Promo"}</code>)</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-post">POST</span>
            <span class="path">/api/messages/send-attachment</span>
            <div class="desc">Send document/PDF/file (Body: <code>{"sessionId": "device-1", "to": "628...", "attachmentUrl": "https://...", "fileName": "invoice.pdf"}</code>)</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-post">POST</span>
            <span class="path">/api/messages/send-pairing-code</span>
            <div class="desc">Pairing code alias endpoint (Body: <code>{"sessionId": "device-1", "phoneNumber": "628..."}</code>)</div>
          </div>
          <div class="endpoint">
            <span class="badge-method badge-get">GET</span>
            <span class="path">/api/messages/:sessionId</span>
            <div class="desc">Query stored message history from PostgreSQL (query params: limit, offset, remoteJid, type)</div>
          </div>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Error handling middleware (body-parser sets status 400 for malformed JSON and 413 for oversized bodies)
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    logger.error({ err }, 'Unhandled request error');
  }
  res.status(status).json({
    success: false,
    error: err.message || 'Internal Server Error'
  });
});

// Last line of defence: log stray promise rejections instead of letting Node kill every session
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

// Start Server
async function startServer() {
  try {
    validateConfig();
    if (!config.apiKey) {
      logger.warn('API_KEY is not set: the API is unauthenticated. Only acceptable for local development.');
    }

    logger.info('Connecting to PostgreSQL');
    await initDatabase();

    const interrupted = await outboundQueue.recoverInterrupted();
    if (interrupted) {
      logger.warn({ count: interrupted }, 'Marked messages interrupted by the previous shutdown as failed');
    }

    logger.info('Restoring previously active WhatsApp sessions');
    await restoreSessions();
    queueRunner.start();
    webhookDispatcher.start();

    server = app.listen(config.port, config.host, () => {
      logger.info({ url: `http://${config.host}:${config.port}`, docs: `http://localhost:${config.port}/` }, 'WhatsApp Web Gateway is running');
    });
  } catch (error) {
    logger.fatal({ err: error }, `Fatal startup error: ${error.message}`);
    process.exit(1);
  }
}

let shuttingDown = false;

/**
 * SIGTERM/SIGINT: stop accepting requests, finish the message being sent, close WhatsApp sockets
 * without logging out (they are restored on the next start), flush webhooks, close the DB pool.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down gracefully');
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    server?.close();
    await queueRunner.stop();
    shutdownSessions();
    await webhookDispatcher.stop();
    server?.closeAllConnections();
    await pool.end();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startServer();
