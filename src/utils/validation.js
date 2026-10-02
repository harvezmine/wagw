import { AppError, sendError } from './errors.js';

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function assertSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new AppError(400, 'Invalid sessionId: use 1-64 characters of letters, digits, ".", "_" or "-".');
  }
  return value;
}

/**
 * Parses an optional integer request field. Returns `defaultValue` when the field is absent.
 */
export function parseOptionalInt(value, { name, min, max, defaultValue = undefined }) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError(400, `${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

/**
 * Express `router.param` handler that rejects malformed :sessionId values before any handler runs.
 */
export function validateSessionIdParam(req, res, next, value) {
  try {
    assertSessionId(value);
    next();
  } catch (error) {
    sendError(res, error, 'Validation');
  }
}
