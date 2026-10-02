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

const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

export function parseOptionalBool(value, { name, defaultValue }) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  throw new AppError(400, `${name} must be true or false.`);
}

/**
 * Parses scheduleAt (ISO-8601 string or unix timestamp in seconds). Past times mean "send now" (null).
 */
export function parseScheduleAt(value, { now = Date.now } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const date = /^\d+$/.test(String(value)) ? new Date(Number(value) * 1000) : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, 'scheduleAt must be an ISO-8601 date or a unix timestamp in seconds.');
  }
  if (date.getTime() - now() > MAX_SCHEDULE_AHEAD_MS) {
    throw new AppError(400, 'scheduleAt cannot be more than 365 days ahead.');
  }
  return date.getTime() <= now() ? null : date;
}

export function parseIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return null;
  const key = String(value);
  if (key.length > 200 || !/^[\x21-\x7E]+$/.test(key)) {
    throw new AppError(400, 'idempotencyKey must be 1-200 visible ASCII characters.');
  }
  return key;
}

// transactional: default for single sends; campaign: default for bulk; reply: answer in an active conversation
export const MESSAGE_CATEGORIES = ['transactional', 'campaign', 'reply'];

/**
 * Message category, or undefined when not given (the caller picks the default).
 */
export function parseCategory(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!MESSAGE_CATEGORIES.includes(value)) {
    throw new AppError(400, `category must be one of: ${MESSAGE_CATEGORIES.join(', ')}.`);
  }
  return value;
}
