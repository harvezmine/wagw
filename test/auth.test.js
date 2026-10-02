import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canAccessSession,
  createAuthenticate,
  createQrLinkToken,
  createQrPageAuth,
  verifyQrLinkToken
} from '../src/middlewares/auth.js';

const API_KEY = 'test-api-key-0123456789';
const TENANT_KEY = 'wagw_0123456789_' + 'a'.repeat(43);

const keyStore = {
  async resolve(key) {
    if (key === TENANT_KEY) return { id: '7', session_ids: ['s1'], ip_allowlist: ['10.0.0.0/8'] };
    return null;
  }
};

async function runMiddleware(middleware, { headers = {}, query = {}, params = {}, ip = '10.0.0.5' } = {}) {
  const req = { query, params, ip, get: (name) => headers[name.toLowerCase()] };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; resolve({ nextCalled: false, req, res: this }); return this; }
    };
    middleware(req, res, () => resolve({ nextCalled: true, req, res }));
  });
}

test('the master key authenticates as admin', async () => {
  const { nextCalled, req } = await runMiddleware(createAuthenticate({ apiKey: API_KEY, keyStore }), { headers: { 'x-api-key': API_KEY } });
  assert.equal(nextCalled, true);
  assert.equal(req.auth.isAdmin, true);
});

test('tenant keys are limited to their sessions and allowed IPs', async () => {
  const authenticate = createAuthenticate({ apiKey: API_KEY, keyStore });
  const ok = await runMiddleware(authenticate, { headers: { 'x-api-key': TENANT_KEY } });
  assert.deepEqual(ok.req.auth, { isAdmin: false, keyId: 7, sessionIds: ['s1'] });
  assert.equal(canAccessSession(ok.req.auth, 's1'), true);
  assert.equal(canAccessSession(ok.req.auth, 's2'), false);

  const wrongIp = await runMiddleware(authenticate, { headers: { 'x-api-key': TENANT_KEY }, ip: '203.0.113.9' });
  assert.equal(wrongIp.res.statusCode, 403);
});

test('missing, wrong or query-string keys are rejected', async () => {
  const authenticate = createAuthenticate({ apiKey: API_KEY, keyStore });
  assert.equal((await runMiddleware(authenticate)).res.statusCode, 401);
  assert.equal((await runMiddleware(authenticate, { headers: { 'x-api-key': 'wrong' } })).res.statusCode, 401);
  assert.equal((await runMiddleware(authenticate, { query: { apiKey: API_KEY } })).res.statusCode, 401);
});

test('without a configured API key every caller is admin (development)', async () => {
  const { req } = await runMiddleware(createAuthenticate({ apiKey: '', keyStore }));
  assert.equal(req.auth.isAdmin, true);
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

test('a QR link grants access to that one session only', async () => {
  const qrPageAuth = createQrPageAuth({ apiKey: API_KEY, keyStore });
  const { token } = createQrLinkToken('sales-01', { secret: API_KEY });
  const { nextCalled, req } = await runMiddleware(qrPageAuth, { params: { sessionId: 'sales-01' }, query: { token } });
  assert.equal(nextCalled, true);
  assert.equal(canAccessSession(req.auth, 'sales-01'), true);
  assert.equal(canAccessSession(req.auth, 'other'), false);
  assert.equal((await runMiddleware(qrPageAuth, { params: { sessionId: 'other' }, query: { token } })).res.statusCode, 401);
});
