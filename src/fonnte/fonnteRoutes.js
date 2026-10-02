import express from 'express';
import multer from 'multer';
import { apiKeyStore, ipAllowed } from '../services/apiKeys.js';
import { cancelQueuedMessage, getQueuedMessage, submitMessage } from '../services/messageService.js';
import { validateNumbers } from '../services/numberService.js';
import { getSessionStatus, isSessionConnected, listGroups } from '../services/sessionManager.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { normalizeTarget } from '../utils/phone.js';
import { assertSafeUrl } from '../utils/netGuard.js';
import { phoneFromJid } from '../utils/jid.js';
import { config } from '../config/index.js';
import { FonnteError, mapFonnteSend, parseFonnteData } from './fonnteParams.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.mediaMaxBytes } });
const router = express.Router();

/**
 * Fonnte answers every request with HTTP 200 and { status: false, reason } on errors.
 */
function fail(res, error) {
  if (error instanceof FonnteError) return res.json({ status: false, reason: error.message });
  if (error instanceof AppError) {
    if (error.status === 409) return res.json({ status: false, reason: 'device disconnected' });
    if (error.status < 500) return res.json({ status: false, reason: error.message });
  }
  logger.error({ err: error }, 'Fonnte adapter request failed');
  return res.json({ status: false, reason: 'server error' });
}

/**
 * Fonnte device tokens are tenant API keys bound to exactly one session. Several tokens separated by
 * commas rotate between their sessions.
 */
async function fonnteAuth(req, res, next) {
  try {
    const tokens = String(req.get('authorization') || '').split(',').map((token) => token.trim()).filter(Boolean);
    if (!tokens.length) throw new FonnteError('token invalid');
    const sessionIds = new Set();
    for (const token of tokens) {
      const key = await apiKeyStore.resolve(token);
      if (!key || key.session_ids?.length !== 1 || !ipAllowed(key.ip_allowlist, req.ip)) {
        throw new FonnteError('token invalid');
      }
      sessionIds.add(key.session_ids[0]);
    }
    req.fonnte = { sessionIds: [...sessionIds] };
    return next();
  } catch (error) {
    return fail(res, error);
  }
}

function pickSession(sessionIds, mustBeConnected) {
  const candidates = mustBeConnected ? sessionIds.filter(isSessionConnected) : sessionIds;
  if (!candidates.length) throw new FonnteError('device disconnected');
  return candidates[Math.floor(Math.random() * candidates.length)];
}

router.post('/send', upload.single('file'), fonnteAuth, async (req, res) => {
  try {
    const hasData = req.body.data !== undefined && req.body.data !== '';
    const requests = hasData ? parseFonnteData(req.body.data) : [req.body];
    const items = requests.flatMap((params) => mapFonnteSend(params, { file: hasData ? null : req.file }));

    // Validate everything first so a bad item does not leave half the request queued
    for (const item of items) {
      try {
        normalizeTarget(item.to, item.countryCode);
      } catch {
        throw new FonnteError('target invalid');
      }
      if (typeof item.media === 'string') {
        try {
          assertSafeUrl(item.media, { allowPrivate: config.allowPrivateUrls, label: 'url' });
        } catch {
          throw new FonnteError('url invalid');
        }
      }
    }

    const ids = [];
    const targets = [];
    for (const item of items) {
      const sessionId = pickSession(req.fonnte.sessionIds, item.connectOnly && !item.scheduleAt);
      const { item: queued } = await submitMessage({ sessionId, ...item, wait: false });
      ids.push(String(queued.id));
      targets.push(phoneFromJid(queued.target_jid));
    }
    const scheduled = items.some((item) => item.scheduleAt);
    return res.json({
      detail: scheduled ? 'success! message will be sent on scheduled time' : 'success! message in queue',
      id: ids,
      process: 'pending',
      requestid: Number(ids[0]),
      status: true,
      target: targets
    });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/validate', upload.none(), fonnteAuth, async (req, res) => {
  try {
    const numbers = String(req.body.target || '').split(',').map((entry) => entry.trim()).filter(Boolean);
    if (!numbers.length) throw new FonnteError('target required');
    const countryCode = req.body.countryCode === undefined || req.body.countryCode === '' ? '62' : String(req.body.countryCode);
    const result = await validateNumbers(req.fonnte.sessionIds[0], numbers, { countryCode });
    return res.json({ status: true, registered: result.registered, not_registered: [...result.notRegistered, ...result.invalid] });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/device', upload.none(), fonnteAuth, async (req, res) => {
  try {
    const status = await getSessionStatus(req.fonnte.sessionIds[0]);
    return res.json({
      status: true,
      device: status.phoneNumber || '',
      device_status: status.status === 'connected' ? 'connect' : 'disconnect',
      name: status.customName || status.sessionId,
      package: 'self-hosted',
      quota: 'unlimited'
    });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/get-whatsapp-group', upload.none(), fonnteAuth, async (req, res) => {
  try {
    const { groups } = await listGroups(req.fonnte.sessionIds[0]);
    if (!groups.length) return res.json({ status: false, detail: 'you have no whatsapp group yet' });
    return res.json({ status: true, data: groups.map((group) => ({ id: group.id, name: group.subject })) });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/fetch-group', upload.none(), fonnteAuth, async (req, res) => {
  try {
    await listGroups(req.fonnte.sessionIds[0], { refresh: true });
    return res.json({ status: true, detail: 'update whatsapp group list finished' });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/delete-message', upload.none(), fonnteAuth, async (req, res) => {
  try {
    const id = Number(req.body.id);
    if (!Number.isInteger(id) || id < 1) throw new FonnteError('invalid message id');
    const item = await getQueuedMessage(id).catch(() => null);
    if (!item || !req.fonnte.sessionIds.includes(item.session_id)) throw new FonnteError('invalid message id');
    if (item.status !== 'queued') throw new FonnteError(`cannot delete message with status ${item.status}`);
    await cancelQueuedMessage(id);
    return res.json({ status: true, detail: `message ${id} successfully deleted` });
  } catch (error) {
    return fail(res, error);
  }
});

export default router;
