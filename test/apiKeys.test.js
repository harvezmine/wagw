import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiKeyStore, generateApiKey, hashApiKey, ipAllowed, parseIpAllowlist } from '../src/services/apiKeys.js';
import { createTestDatabase, dbSkip as skip } from './helpers/testDb.js';

test('generated keys have a recognisable format and a SHA-256 hash', () => {
  const { key, prefix, hash } = generateApiKey();
  assert.match(key, /^wagw_[0-9a-f]{10}_[A-Za-z0-9_-]{43}$/);
  assert.equal(key.split('_')[1], prefix);
  assert.equal(hash, hashApiKey(key));
});

test('IP allowlists accept addresses and CIDR ranges', () => {
  assert.equal(parseIpAllowlist(null), null);
  assert.equal(parseIpAllowlist([]), null);
  assert.deepEqual(parseIpAllowlist(['10.0.0.0/8', ' 203.0.113.7 ']), ['10.0.0.0/8', '203.0.113.7']);
  assert.throws(() => parseIpAllowlist(['10.0.0.0/33']), { status: 400 });
  assert.throws(() => parseIpAllowlist(['example.com']), { status: 400 });

  const allowlist = ['10.0.0.0/8', '203.0.113.7'];
  assert.equal(ipAllowed(allowlist, '10.1.2.3'), true);
  assert.equal(ipAllowed(allowlist, '::ffff:10.1.2.3'), true);
  assert.equal(ipAllowed(allowlist, '203.0.113.8'), false);
  assert.equal(ipAllowed(null, '1.2.3.4'), true);
});

let database;
let store;

before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  store = createApiKeyStore(database.db);
});

after(async () => {
  if (database) await database.drop();
});

test('created keys resolve until revoked; wrong secrets never resolve', { skip }, async () => {
  const created = await store.create({ name: 'tenant-a', sessionIds: ['s1'], ipAllowlist: null });
  assert.match(created.key, /^wagw_/);
  assert.deepEqual(created.sessionIds, ['s1']);

  const resolved = await store.resolve(created.key);
  assert.equal(Number(resolved.id), created.id);
  assert.equal(await store.resolve(created.key.slice(0, -1) + (created.key.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(await store.resolve('not-a-key'), null);

  const listed = await store.list();
  assert.equal('key_hash' in listed[0], false);
  assert.equal(listed[0].prefix, `wagw_${created.key.split('_')[1]}`);

  assert.ok(await store.revoke(created.id));
  assert.equal(await store.resolve(created.key), null);
  assert.equal(await store.revoke(created.id), null);
});
