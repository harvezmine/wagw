import crypto from 'node:crypto';

/**
 * Signature sent as `X-Webhook-Signature`: HMAC-SHA256 over "<timestamp>.<raw body>". Receivers should
 * recompute it from the raw body and reject old timestamps (replay protection).
 */
export function signWebhook(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyWebhookSignature(secret, timestamp, body, signature) {
  if (typeof signature !== 'string') return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const provided = Buffer.from(signature);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}
