import { config } from '../config/index.js';
import { AppError } from '../utils/errors.js';
import { normalizePhoneNumber } from '../utils/phone.js';
import { createNumberChecker, createNumberCheckStore } from './numberCheck.js';
import { getConnectedSocket } from './sessionManager.js';

const checker = createNumberChecker({
  store: createNumberCheckStore(),
  ttlMs: config.validate.cacheTtlMs,
  minIntervalMs: config.validate.minIntervalMs
});

/**
 * Whether one personal JID is on WhatsApp (cached), for the send gate. Throws when it cannot tell.
 */
export async function isRegistered(sessionId, jid) {
  const phone = jid.split('@')[0];
  const [result] = await checker.check(sessionId, [phone], (jids) => getConnectedSocket(sessionId).onWhatsApp(...jids));
  return result.exists;
}

/**
 * Which numbers are registered on WhatsApp. Cached answers do not need a connected session.
 */
export async function validateNumbers(sessionId, numbers, { countryCode } = {}) {
  const list = Array.isArray(numbers) ? numbers : String(numbers ?? '').split(',');
  const entries = list.map((entry) => String(entry).trim()).filter(Boolean);
  if (!entries.length) throw new AppError(400, 'numbers is required.');
  if (entries.length > config.validate.maxNumbers) {
    throw new AppError(400, `At most ${config.validate.maxNumbers} numbers per request (VALIDATE_MAX_NUMBERS).`);
  }

  const invalid = [];
  const phones = new Set();
  for (const entry of entries) {
    try {
      phones.add(normalizePhoneNumber(entry, countryCode ?? config.defaultCountryCode));
    } catch {
      invalid.push(entry);
    }
  }

  const results = phones.size
    ? await checker.check(sessionId, [...phones], (jids) => getConnectedSocket(sessionId).onWhatsApp(...jids))
    : [];
  return {
    registered: results.filter((result) => result.exists).map((result) => result.number),
    notRegistered: results.filter((result) => !result.exists).map((result) => result.number),
    invalid,
    results
  };
}
