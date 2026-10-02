import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiKeyAuth, createQrLinkToken, createQrPageAuth, verifyQrLinkToken } from '../src/middlewares/auth.js';

const API_KEY = 'test-api-key-0123456789';

function runMiddleware(middleware, { headers = {}, query = {}, params = {} } = {}) {
  const req = { query, params, get: (name) => headers[name.toLowerCase()] };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { nextCalled, res };
}

test('accepts the API key from the x-api-key header', () => {
  assert.equal(runMiddleware(createApiKeyAuth({ apiKey: API_KEY }), { headers: { 'x-api-key': API_KEY } }).nextCalled, true);
});

test('rejects a wrong key and no longer accepts ?apiKey= in the query string', () => {
  const auth = createApiKeyAuth({ apiKey: API_KEY });
  assert.equal(runMiddleware(auth, { headers: { 'x-api-key': 'wrong' } }).res.statusCode, 401);
  const viaQuery = runMiddleware(auth, { query: { apiKey: API_KEY } });
  assert.equal(viaQuery.nextCalled, false);
  assert.equal(viaQuery.res.statusCode, 401);
});

test('passes everything through when no API key is configured', () => {
  assert.equal(runMiddleware(createApiKeyAuth({ apiKey: '' })).nextCalled, true);
});

test('QR link tokens are bound to one session and expire', () => {
  const now = () => 1_000_000_000_000;
  const { token } = createQrLinkToken('sales-01', { secret: API_KEY, ttlSeconds: 600, now });
  assert.equal(verifyQrLinkToken('sales-01', token, { secret: API_KEY, now }), true);
  assert.equal(verifyQrLinkToken('other', token, { secret: API_KEY, now }), false);
  assert.equal(verifyQrLinkToken('sales-01', token, { secret: 'different-secret', now }), false);
  assert.equal(verifyQrLinkToken('sales-01', token, { secret: API_KEY, now: () => now() + 601_000 }), false);
  assert.equal(verifyQrLinkToken('sales-01', 'garbage', { secret: API_KEY, now }), false);
});

test('QR page auth accepts either the header or a valid signed token', () => {
  const auth = createQrPageAuth({ apiKey: API_KEY });
  const { token } = createQrLinkToken('sales-01', { secret: API_KEY });
  assert.equal(runMiddleware(auth, { params: { sessionId: 'sales-01' }, query: { token } }).nextCalled, true);
  assert.equal(runMiddleware(auth, { params: { sessionId: 'sales-01' }, headers: { 'x-api-key': API_KEY } }).nextCalled, true);
  assert.equal(runMiddleware(auth, { params: { sessionId: 'other' }, query: { token } }).res.statusCode, 401);
});
