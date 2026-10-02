import { apiKeyStore, parseIpAllowlist } from '../services/apiKeys.js';
import { AppError, sendError } from '../utils/errors.js';
import { assertSessionId, parseOptionalInt } from '../utils/validation.js';

function parseSessionIds(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 100) {
    throw new AppError(400, 'sessionIds must be null (every session) or an array of up to 100 session ids.');
  }
  return [...new Set(value.map((sessionId) => assertSessionId(sessionId)))];
}

export async function createKey(req, res) {
  try {
    const { name } = req.body;
    if (typeof name !== 'string' || !name.trim() || name.length > 100) {
      throw new AppError(400, 'name is required (at most 100 characters).');
    }
    const created = await apiKeyStore.create({
      name: name.trim(),
      sessionIds: parseSessionIds(req.body.sessionIds),
      ipAllowlist: parseIpAllowlist(req.body.ipAllowlist)
    });
    const { key, ...apiKey } = created;
    return res.status(201).json({ success: true, key, apiKey, message: 'Store this key now: it is not shown again.' });
  } catch (error) {
    return sendError(res, error, 'KeysController');
  }
}

export async function listKeys(req, res) {
  try {
    const keys = await apiKeyStore.list();
    return res.status(200).json({ success: true, count: keys.length, keys });
  } catch (error) {
    return sendError(res, error, 'KeysController');
  }
}

export async function revokeKey(req, res) {
  try {
    const keyId = parseOptionalInt(req.params.keyId, { name: 'keyId', min: 1, max: Number.MAX_SAFE_INTEGER });
    const revoked = await apiKeyStore.revoke(keyId);
    if (!revoked) throw new AppError(404, `Active API key ${keyId} not found.`);
    return res.status(200).json({ success: true, apiKey: revoked });
  } catch (error) {
    return sendError(res, error, 'KeysController');
  }
}
