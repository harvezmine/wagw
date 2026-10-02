import crypto from 'node:crypto';
import { config } from '../config/index.js';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Hashing first yields equal-length buffers, so timingSafeEqual never leaks the key length
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function signQr(sessionId, expiresAt, secret) {
  return crypto.createHmac('sha256', secret).update(`qr:${sessionId}:${expiresAt}`).digest('base64url');
}

function unauthorized(res) {
  return res.status(401).json({
    success: false,
    error: 'Unauthorized: missing or invalid x-api-key header.'
  });
}

/**
 * Signed, short-lived token that lets a browser open one session's QR page without the API key.
 */
export function createQrLinkToken(sessionId, { secret = config.apiKey, ttlSeconds = config.qrLinkTtlSeconds, now = Date.now } = {}) {
  const expiresAt = Math.floor(now() / 1000) + ttlSeconds;
  return {
    token: `${expiresAt}.${signQr(sessionId, expiresAt, secret)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString()
  };
}

export function verifyQrLinkToken(sessionId, token, { secret = config.apiKey, now = Date.now } = {}) {
  if (typeof token !== 'string') return false;
  const [expiresAtRaw, signature] = token.split('.');
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isInteger(expiresAt) || !signature || expiresAt < Math.floor(now() / 1000)) {
    return false;
  }
  return safeEqual(signature, signQr(sessionId, expiresAt, secret));
}

/**
 * API key auth via the `x-api-key` header only (query-string keys leak into logs and browser history).
 * Without a configured key (allowed outside production only, see validateConfig) requests pass through.
 */
export function createApiKeyAuth({ apiKey }) {
  return (req, res, next) => {
    if (!apiKey) return next();
    const provided = req.get('x-api-key');
    if (provided && safeEqual(provided, apiKey)) return next();
    return unauthorized(res);
  };
}

/**
 * Like createApiKeyAuth, but also accepts a signed QR link token (?token=) for the session in the URL.
 */
export function createQrPageAuth({ apiKey }) {
  const apiKeyAuth = createApiKeyAuth({ apiKey });
  return (req, res, next) => {
    if (apiKey && verifyQrLinkToken(req.params.sessionId, req.query.token, { secret: apiKey })) {
      return next();
    }
    return apiKeyAuth(req, res, next);
  };
}

export const apiKeyAuth = createApiKeyAuth({ apiKey: config.apiKey });
export const qrPageAuth = createQrPageAuth({ apiKey: config.apiKey });
