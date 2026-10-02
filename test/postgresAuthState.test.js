import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { usePostgresAuthState } from '../src/database/postgresAuthState.js';
import { createTestDatabase, dbSkip as skip } from './helpers/testDb.js';

const SESSION = 'test-auth-state';
let database;
let db;

before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  db = database.db;
});

after(async () => {
  if (database) await database.drop();
});

test('read failures are thrown instead of silently generating new creds', async () => {
  const brokenDb = {
    query: async () => { throw new Error('connection refused'); },
    withTransaction: async () => {}
  };
  await assert.rejects(usePostgresAuthState(SESSION, brokenDb), /connection refused/);
});

test('creates fresh creds and persists them with saveCreds', { skip }, async () => {
  const first = await usePostgresAuthState(SESSION, db);
  assert.equal(first.state.creds.registered, false);
  await first.saveCreds();
  const second = await usePostgresAuthState(SESSION, db);
  assert.ok(Buffer.isBuffer(second.state.creds.noiseKey.public));
  assert.deepEqual(second.state.creds.noiseKey.public, first.state.creds.noiseKey.public);
});

test('keys.set writes and deletes in one batch and keys.get revives Buffers', { skip }, async () => {
  const { state } = await usePostgresAuthState(SESSION, db);
  await state.keys.set({
    'pre-key': {
      1: { public: Buffer.from([1, 2]), private: Buffer.from([3, 4]) },
      2: { public: Buffer.from([5]), private: Buffer.from([6]) }
    },
    session: { 'abc.0': Buffer.from('session-data') }
  });
  let keys = await state.keys.get('pre-key', ['1', '2', '3']);
  assert.deepEqual(Object.keys(keys).sort(), ['1', '2']);
  assert.deepEqual(keys['1'].public, Buffer.from([1, 2]));

  await state.keys.set({ 'pre-key': { 1: null } });
  keys = await state.keys.get('pre-key', ['1', '2']);
  assert.deepEqual(Object.keys(keys), ['2']);

  const sessions = await state.keys.get('session', ['abc.0']);
  assert.equal(sessions['abc.0'].toString(), 'session-data');
});

test('write failures are thrown instead of swallowed', { skip }, async () => {
  const failingDb = { query: db.query, withTransaction: async () => { throw new Error('db down'); } };
  const { state } = await usePostgresAuthState(SESSION, failingDb);
  await assert.rejects(
    state.keys.set({ 'pre-key': { 9: { public: Buffer.from([9]), private: Buffer.from([9]) } } }),
    /db down/
  );
});
