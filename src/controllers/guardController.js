import { config } from '../config/index.js';
import { guardStore } from '../services/guardStore.js';
import { describeHealth } from '../services/healthPolicy.js';
import { getSessionSettings, getSessionState, getSessionStatus } from '../services/sessionManager.js';
import { AppError, sendError } from '../utils/errors.js';
import { normalizeTarget } from '../utils/phone.js';
import { parseOptionalInt } from '../utils/validation.js';

const DAY_MS = 24 * 3600 * 1000;
const PAUSE_SCOPES = ['new_chats', 'campaigns'];
const CONSENT_STATUSES = ['opted_in', 'opted_out'];
const MAX_CONSENTS_PER_REQUEST = 1000;

async function healthOf(sessionId) {
  const guards = await guardStore.getGuards(sessionId);
  if (!guards) throw new AppError(404, `Session "${sessionId}" not found.`);
  const now = new Date();
  // Same window as the health monitor: sends before the last campaign pause ended are not judged again
  const pauseEnded = guards.campaignsPausedUntil && guards.campaignsPausedUntil <= now ? guards.campaignsPausedUntil : null;
  const [usage, metrics, settings, status] = await Promise.all([
    guardStore.newContactUsage(sessionId, new Date(now.getTime() - DAY_MS)),
    guardStore.healthMetrics(sessionId, now, pauseEnded),
    getSessionSettings(sessionId),
    getSessionStatus(sessionId)
  ]);
  const report = describeHealth({
    guards,
    usage,
    metrics,
    settings,
    connectedAt: getSessionState(sessionId)?.connectedAt ?? null,
    rules: config.guard,
    now
  });
  return { sessionId, status: status.status, ban: status.ban, ...report };
}

/**
 * GET /api/sessions/:sessionId/health
 */
export async function getHealth(req, res) {
  try {
    return res.status(200).json({ success: true, ...(await healthOf(req.params.sessionId)) });
  } catch (error) {
    return sendError(res, error, 'GuardController');
  }
}

/**
 * POST /api/sessions/:sessionId/health/resume { scope: new_chats | campaigns }
 * Lifts a pause set by the gateway (health monitor). Pauses WhatsApp itself imposed stay until they end.
 */
export async function resumeHealth(req, res) {
  try {
    const { sessionId } = req.params;
    const scope = req.body?.scope;
    if (!PAUSE_SCOPES.includes(scope)) {
      throw new AppError(400, `scope must be one of: ${PAUSE_SCOPES.join(', ')}.`);
    }
    const guards = await guardStore.getGuards(sessionId);
    if (!guards) throw new AppError(404, `Session "${sessionId}" not found.`);
    const [until, reason] =
      scope === 'new_chats' ? [guards.newChatsPausedUntil, guards.newChatsPauseReason] : [guards.campaignsPausedUntil, guards.campaignsPauseReason];
    if (!until || until <= new Date()) {
      return res.status(200).json({ success: true, resumed: false, message: `${scope} is not paused.`, ...(await healthOf(sessionId)) });
    }
    if (String(reason || '').startsWith('whatsapp_')) {
      throw new AppError(
        409,
        `${scope} is paused by WhatsApp (${reason}) until ${until.toISOString()}. It cannot be lifted early: sending anyway is what leads to bans.`
      );
    }
    await guardStore.endPause(sessionId, scope);
    return res.status(200).json({ success: true, resumed: true, ...(await healthOf(sessionId)) });
  } catch (error) {
    return sendError(res, error, 'GuardController');
  }
}

/**
 * GET /api/sessions/:sessionId/consents?status=opted_out&limit=100&offset=0
 */
export async function listConsents(req, res) {
  try {
    const { sessionId } = req.params;
    const status = req.query.status || null;
    if (status && !CONSENT_STATUSES.includes(status)) {
      throw new AppError(400, `status must be one of: ${CONSENT_STATUSES.join(', ')}.`);
    }
    const limit = parseOptionalInt(req.query.limit, { name: 'limit', min: 1, max: 1000, defaultValue: 100 });
    const offset = parseOptionalInt(req.query.offset, { name: 'offset', min: 0, max: Number.MAX_SAFE_INTEGER, defaultValue: 0 });
    if (!(await guardStore.getGuards(sessionId))) throw new AppError(404, `Session "${sessionId}" not found.`);
    const rows = await guardStore.listConsents(sessionId, { status, limit, offset });
    const consents = rows.map((row) => ({ jid: row.jid, status: row.status, source: row.source, updatedAt: row.updated_at }));
    return res.status(200).json({ success: true, count: consents.length, consents });
  } catch (error) {
    return sendError(res, error, 'GuardController');
  }
}

/**
 * PUT /api/sessions/:sessionId/consents { numbers: [...] | "a,b", status: opted_in | opted_out, countryCode? }
 * Imports opt-ins (e.g. from a sign-up form) or records opt-outs from other channels.
 */
export async function putConsents(req, res) {
  try {
    const { sessionId } = req.params;
    const { numbers, status, countryCode } = req.body || {};
    if (!CONSENT_STATUSES.includes(status)) {
      throw new AppError(400, `status must be one of: ${CONSENT_STATUSES.join(', ')}.`);
    }
    const list = (Array.isArray(numbers) ? numbers : String(numbers ?? '').split(','))
      .map((entry) => String(entry).trim())
      .filter(Boolean);
    if (!list.length) throw new AppError(400, 'numbers is required.');
    if (list.length > MAX_CONSENTS_PER_REQUEST) {
      throw new AppError(400, `At most ${MAX_CONSENTS_PER_REQUEST} numbers per request.`);
    }
    if (!(await guardStore.getGuards(sessionId))) throw new AppError(404, `Session "${sessionId}" not found.`);

    const code = countryCode === undefined || countryCode === '' ? config.defaultCountryCode : String(countryCode);
    const jids = new Set();
    const invalid = [];
    for (const entry of list) {
      try {
        const jid = normalizeTarget(entry, code);
        if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) jids.add(jid);
        else invalid.push(entry);
      } catch {
        invalid.push(entry);
      }
    }
    const updated = await guardStore.setConsents(sessionId, [...jids].map((jid) => ({ jid, status })), 'api');
    return res.status(200).json({ success: true, status, updated, invalid });
  } catch (error) {
    return sendError(res, error, 'GuardController');
  }
}

/**
 * DELETE /api/sessions/:sessionId/consents/:number — forgets the record (the person is treated as never asked).
 */
export async function deleteConsent(req, res) {
  try {
    const { sessionId, number } = req.params;
    const jid = normalizeTarget(number, req.query.countryCode || config.defaultCountryCode);
    if (!(await guardStore.deleteConsent(sessionId, jid))) {
      throw new AppError(404, `No consent record for ${jid}.`);
    }
    return res.status(200).json({ success: true, jid, deleted: true });
  } catch (error) {
    return sendError(res, error, 'GuardController');
  }
}
