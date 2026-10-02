import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { AppError, sendError } from '../utils/errors.js';
import { apiKeyStore, ipAllowed } from '../services/apiKeys.js';

const ADMIN_AUTH = Object.freeze({ isAdmin: true, keyId: null, sessionIds: null });

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
 * Signed, short-lived token that lets a browser open one session's QR page without an API key.
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
 * Identifies the caller from the x-api-key header (query-string keys leak into logs and are ignored):
 * - the master API_KEY: admin, every session and key management
 * - a tenant key (wagw_…): only its sessions, optionally only from allowed IPs
 * Without API_KEY (development only, see validateConfig) every caller is admin.
 */
async function resolveAuth(req, { apiKey, keyStore }) {
  if (!apiKey) return ADMIN_AUTH;
  const provided = req.get('x-api-key');
  if (!provided) return null;
  if (safeEqual(provided, apiKey)) return ADMIN_AUTH;
  const key = await keyStore.resolve(provided);
  if (!key) return null;
  if (key.ip_allowlist && !ipAllowed(key.ip_allowlist, req.ip)) {
    throw new AppError(403, 'This API key is not allowed from your IP address.');
  }
  return { isAdmin: false, keyId: Number(key.id), sessionIds: key.session_ids };
}

export function createAuthenticate({ apiKey, keyStore }) {
  return async (req, res, next) => {
    try {
      const auth = await resolveAuth(req, { apiKey, keyStore });
      if (!auth) return unauthorized(res);
      req.auth = auth;
      return next();
    } catch (error) {
      return sendError(res, error, 'Auth');
    }
  };
}

/**
 * The QR page also accepts a signed ?token= link, which grants access to that one session.
 */
export function createQrPageAuth({ apiKey, keyStore }) {
  const authenticate = createAuthenticate({ apiKey, keyStore });
  return (req, res, next) => {
    if (apiKey && verifyQrLinkToken(req.params.sessionId, req.query.token, { secret: apiKey })) {
      req.auth = { isAdmin: false, keyId: null, sessionIds: [req.params.sessionId] };
      return next();
    }
    return authenticate(req, res, next);
  };
}

export function canAccessSession(auth, sessionId) {
  return Boolean(auth && (auth.isAdmin || auth.sessionIds === null || auth.sessionIds.includes(sessionId)));
}

export function assertSessionAccess(req, sessionId) {
  if (!canAccessSession(req.auth, sessionId)) {
    throw new AppError(403, `This API key has no access to session "${sessionId}".`);
  }
}

/** Sessions the caller may see, or null for all. */
export function allowedSessionIds(req) {
  return req.auth?.isAdmin ? null : req.auth?.sessionIds ?? null;
}

export function requireSessionAccess(req, res, next) {
  try {
    assertSessionAccess(req, req.params.sessionId);
    return next();
  } catch (error) {
    return sendError(res, error, 'Auth');
  }
}

export function requireAdmin(req, res, next) {
  if (req.auth?.isAdmin) return next();
  return sendError(res, new AppError(403, 'This endpoint requires the master API key.'), 'Auth');
}

export const authenticate = createAuthenticate({ apiKey: config.apiKey, keyStore: apiKeyStore });
export const qrPageAuth = createQrPageAuth({ apiKey: config.apiKey, keyStore: apiKeyStore });
