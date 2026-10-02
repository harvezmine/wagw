import { config } from '../config/index.js';

/**
 * Optional API Key Authentication Middleware
 * Checks `x-api-key` header or `apiKey` query parameter against `API_KEY` in environment.
 * If `API_KEY` is not set or empty, requests bypass authentication.
 */
export function apiKeyAuth(req, res, next) {
  if (!config.apiKey) {
    return next();
  }

  const apiKeyHeader = req.headers['x-api-key'];
  const apiKeyQuery = req.query.apiKey;

  if (apiKeyHeader === config.apiKey || apiKeyQuery === config.apiKey) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'Unauthorized: Invalid or missing API Key (header x-api-key or ?apiKey= required).'
  });
}
