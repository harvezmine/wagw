import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import { createDb } from '../src/database/db.js';
import { clearAuthState, usePostgresAuthState } from '../src/database/postgresAuthState.js';

// Integration tests need a disposable PostgreSQL, e.g.:
//   docker run -d --name wagw-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:56999:5432 postgres:16-alpine
//   DB_TEST=1 DB_HOST=127.0.0.1 DB_PORT=56999 DB_USER=postgres DB_PASSWORD=test DB_NAME=postgres npm test
const skip = process.env.DB_TEST === '1' ? false : 'set DB_TEST=1 and DB_* env vars to run against PostgreSQL';
const SESSION = 'test-auth-state';
let pool;
let db;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });
  await pool.query(fs.readFileSync(new URL('../src/database/schema.sql', import.meta.url), 'utf8'));
  db = createDb(pool);
  await clearAuthState(SESSION, db);
});

after(async () => {
  if (!pool) return;
  await clearAuthState(SESSION, db);
  await pool.end();
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
