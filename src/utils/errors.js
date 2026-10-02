import { logger } from './logger.js';

/**
 * Error with an HTTP status code. Anything else that reaches a controller is treated as a 500.
 * `code` optionally tells errors with the same status apart (e.g. not_sent).
 */
export class AppError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export function sendError(res, error, context) {
  const status = error instanceof AppError ? error.status : 500;
  if (status >= 500) {
    logger.error({ err: error, context }, 'Request failed');
  }
  return res.status(status).json({ success: false, error: error.message });
}
