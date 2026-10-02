import { AppError } from '../utils/errors.js';

export const DEFAULT_SETTINGS = Object.freeze({
  readMessages: null, // null = follow AUTO_READ_MESSAGES
  rejectCalls: false,
  rejectCallMessage: null,
  ignoreGroups: false,
  newContactDailyLimit: null, // null = NEW_CONTACT_DAILY_LIMIT
  campaignConsentRequired: null, // null = CAMPAIGN_REQUIRE_CONSENT
  optOutReply: null // sent once when someone opts out with a keyword
});

export function normalizeSettings(stored) {
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

/**
 * Validates a settings update and returns only the provided fields.
 */
export function parseSettingsUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'Settings must be a JSON object.');
  }
  const update = {};
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case 'readMessages':
        if (value !== null && typeof value !== 'boolean') {
          throw new AppError(400, 'readMessages must be true, false or null (follow AUTO_READ_MESSAGES).');
        }
        break;
      case 'rejectCalls':
      case 'ignoreGroups':
        if (typeof value !== 'boolean') throw new AppError(400, `${key} must be true or false.`);
        break;
      case 'rejectCallMessage':
      case 'optOutReply':
        if (value !== null && (typeof value !== 'string' || value.length > 1000)) {
          throw new AppError(400, `${key} must be null or a string of at most 1000 characters.`);
        }
        break;
      case 'newContactDailyLimit':
        if (value !== null && !(Number.isInteger(value) && value >= 0 && value <= 1000)) {
          throw new AppError(400, 'newContactDailyLimit must be null (follow NEW_CONTACT_DAILY_LIMIT) or a whole number from 0 to 1000.');
        }
        break;
      case 'campaignConsentRequired':
        if (value !== null && typeof value !== 'boolean') {
          throw new AppError(400, 'campaignConsentRequired must be true, false or null (follow CAMPAIGN_REQUIRE_CONSENT).');
        }
        break;
      default:
        throw new AppError(400, `Unknown setting "${key}". Allowed: ${Object.keys(DEFAULT_SETTINGS).join(', ')}.`);
    }
    update[key] = value === '' ? null : value;
  }
  return update;
}
